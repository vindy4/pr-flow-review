import type { Architecture, ArchitectureEdge, ArchitectureFile, FileVersion, View } from './types';

export const fileVersion = (file: ArchitectureFile, view: View): FileVersion | null => view === 'base' ? file.base : view === 'head' ? file.head : file.head || file.base;
export const edgeEvidence = (edge: ArchitectureEdge, view: View) => view === 'base' ? edge.baseEvidence : view === 'head' ? edge.headEvidence : [...edge.headEvidence, ...edge.baseEvidence];
export const relationName = (relation: string) => ({ renders: 'renders', runs_query: 'runs query', mutates: 'registers mutation', reads_store: 'reads store', updates_store: 'updates store', calls_store_action: 'calls store action', calls_service: 'calls service', calls_api: 'calls API', delegates: 'delegates to',
  checks_permission: 'checks permission', calls_data_access: 'calls data access', calls_job: 'calls job', calls_integration: 'calls integration', calls_report: 'calls report', calls_operation: 'calls operation',
  calls: 'calls', imports: 'imports' }[relation] || relation);
export const statusName = (status: string) => status === 'moved_modified' ? 'moved + modified' : status;

// A rendered connection can contain several source relationships. Keep its
// original representative ID for selection and every fact for inspection.
export type ConnectionBundle = ArchitectureEdge & { relations?: string[]; memberIds?: string[] };
export const connectionRelations = (edge: ConnectionBundle) => edge.relations || [edge.relation];
export const connectionLabel = (edge: ConnectionBundle) => connectionRelations(edge).map(relationName).join(' · ');
export function connectionDescription(edge: ConnectionBundle, fileId: string) {
  if (edge.source === fileId) return connectionLabel(edge);
  const incoming: Record<string, string> = { renders: 'rendered by', runs_query: 'queried by', mutates: 'mutation registered by',
    reads_store: 'read by', updates_store: 'updated by', calls_store_action: 'action called by', calls_service: 'called by',
    calls_api: 'called by', checks_permission: 'checked by', calls_data_access: 'called by', calls_job: 'called by',
    calls_integration: 'called by', calls_report: 'called by', calls_operation: 'called by',
    delegates: 'delegated by', calls: 'called by', imports: 'imported by' };
  return connectionRelations(edge).map(relation => incoming[relation] || `${relationName(relation)} from`).join(' · ');
}

export function bundleConnections(edges: ArchitectureEdge[]): ConnectionBundle[] {
  const priority = ['runs_query', 'mutates', 'updates_store', 'calls_store_action', 'reads_store', 'renders', 'delegates', 'calls_api',
    'checks_permission', 'calls_service', 'calls_data_access', 'calls_job', 'calls_integration', 'calls_report', 'calls_operation', 'calls', 'imports'];
  const pairs = new Map<string, ArchitectureEdge[]>();
  for (const edge of edges) {
    const key = `${edge.source}|${edge.target}`;
    pairs.set(key, [...(pairs.get(key) || []), edge]);
  }
  return [...pairs.values()].map(members => {
    const ordered = [...members].sort((a, b) => priority.indexOf(a.relation) - priority.indexOf(b.relation));
    const uniqueEvidence = (side: 'baseEvidence' | 'headEvidence') => [...new Map(ordered.flatMap(edge => edge[side]).map(ev => [JSON.stringify(ev), ev])).values()];
    return { ...ordered[0], relations: [...new Set(ordered.flatMap(edge => connectionRelations(edge)))],
      memberIds: ordered.flatMap(edge => (edge as ConnectionBundle).memberIds || [edge.id]),
      inBase: ordered.some(edge => edge.inBase), inHead: ordered.some(edge => edge.inHead),
      status: ordered.every(edge => edge.status === 'added') ? 'added' : ordered.every(edge => edge.status === 'removed') ? 'removed' : 'unchanged',
      baseEvidence: uniqueEvidence('baseEvidence'), headEvidence: uniqueEvidence('headEvidence') };
  });
}

function availableGraph(architecture: Architecture, view: View, imports: boolean) {
  const files = architecture.nodes.filter(node => fileVersion(node, view));
  const ids = new Set(files.map(file => file.id));
  const edges = architecture.edges.filter(edge => (view === 'overlay' || (view === 'base' ? edge.inBase : edge.inHead))
    && ids.has(edge.source) && ids.has(edge.target) && (imports || edge.relation !== 'imports'));
  return { files, edges };
}

/** Selected file and its immediate callers/dependencies, including unchanged files. */
export function fileGraph(architecture: Architecture, fileId: string, view: View, imports: boolean): { files: ArchitectureFile[]; edges: ArchitectureEdge[] } {
  const available = availableGraph(architecture, view, imports);
  if (!available.files.some(file => file.id === fileId)) return { files: [], edges: [] };
  const edges = available.edges.filter(edge => edge.source === fileId || edge.target === fileId);
  const visible = new Set([fileId, ...edges.flatMap(edge => [edge.source, edge.target])]);
  return { files: available.files.filter(file => visible.has(file.id)), edges: bundleConnections(edges) };
}

// Follow semantic dependencies from one feature. At a facade, follow only the
// operation referenced by the incoming call, rather than every exported method.
export function featureGraph(architecture: Architecture, featureId: string, view: View, imports: boolean) {
  const { files: available, edges } = availableGraph(architecture, view, imports);
  const files = new Map(available.map(n => [n.id, n]));
  const visible = new Set<string>();
  const included = new Set<string>();
  if (featureId === 'all') {
    available.filter(n => n.status !== 'unchanged').forEach(n => visible.add(n.id));
    edges.forEach(e => { if (visible.has(e.source) && visible.has(e.target)) included.add(e.id); });
  } else if (files.has(featureId)) {
    const queue: { id: string; targets: string[] }[] = [{id: featureId, targets: []}];
    const visited = new Set<string>();
    while (queue.length) {
      const {id, targets} = queue.shift()!;
      const key = `${id}|${[...targets].sort().join(',')}`;
      if (visited.has(key)) continue;
      visited.add(key); visible.add(id);
      for (const edge of edges.filter(e => e.source === id)) {
        const target = files.get(edge.target)!;
        const version = fileVersion(target, view)!;
        if (!imports && (version.layer === 'supporting' || (['ui', 'other'].includes(version.layer) && target.status === 'unchanged'))) continue;
        const evidence = edgeEvidence(edge, view);
        if (edge.relation === 'delegates' && targets.length && !evidence.some(e => e.targetSymbolId && targets.includes(e.targetSymbolId))) continue;
        included.add(edge.id);
        queue.push({ id: edge.target, targets: evidence.flatMap(e => e.targetSymbolId ? [e.targetSymbolId] : []) });
      }
    }
  }
  const selectedEdges = edges.filter(e => included.has(e.id));
  return { files: available.filter(n => visible.has(n.id)), edges: bundleConnections(selectedEdges) };
}
