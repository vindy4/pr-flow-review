import type { Analysis, CallEdge, ChangedFile, Symbol, View } from './types';
import { belongsToFile, isTopLevel } from './fileSelection';
import { callExpression, relationLabel } from './calls';

export type SymbolRelationship = {
  id: string; source: string; target: string; relation: CallEdge['relation'];
  status: CallEdge['status']; inBase: boolean; inHead: boolean; label: string;
  // These are the actual source edges, in order. A folded edge is a path,
  // never a replacement claim that the owner invokes the final target directly.
  via: Symbol[]; evidenceEdges: CallEdge[];
};
type ProjectionOptions = {
  file: ChangedFile | null; focusId: string | null; view: View; includeHelpers: boolean;
  expanded?: Set<string>; revealedOwners?: Set<string>;
};
type SnapshotSide = 'base' | 'head';

function parentSymbol(node: Symbol, nodes: Symbol[]) {
  return nodes.filter(parent => parent.id !== node.id && parent.path === node.path
    && node.qualname.startsWith(parent.qualname + '.'))
    .sort((a, b) => b.qualname.length - a.qualname.length)[0];
}

function helperLabel(node: Symbol, parent: Symbol | undefined, side: SnapshotSide, callback: boolean) {
  const code = node[side]?.code;
  const parentCode = parent?.[side]?.code;
  if (code && parentCode) {
    const offset = parentCode.indexOf(code);
    // Repeated identical expressions have no column data in the analysis; do
    // not invent a contextual name when more than one source site could match.
    if (offset >= 0 && parentCode.indexOf(code, offset + code.length) < 0) {
      const prefix = parentCode.slice(0, offset);
      const jsx = prefix.match(/\b(on[A-Z]\w*)\s*=\s*\{?\s*$/);
      const property = prefix.match(/\b([A-Za-z_$][\w$]*)\s*:\s*$/);
      const argument = prefix.match(/(?:\.([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*))\s*\(\s*$/);
      const context = jsx?.[1] || property?.[1] || (argument?.[1] ? `.${argument[1]}` : argument?.[2]);
      if (context) return `${context} callback`;
    }
  }
  return node.kind === 'callback' ? 'local callback' : callback ? `${node.name} callback` : `${node.name} helper`;
}

/** Collapse lexical helpers before selecting a neighborhood, preserving the
 * complete, snapshot-consistent callback/call path to every external target. */
export function projectSymbolGraph(analysis: Analysis, options: ProjectionOptions) {
  const { file, focusId, view, includeHelpers } = options;
  const expanded = options.expanded || new Set<string>();
  const revealed = options.revealedOwners || new Set<string>();
  const available = analysis.nodes.filter(node => view === 'overlay' || !!node[view]);
  const byId = new Map(available.map(node => [node.id, node]));
  const rawEdges = analysis.edges.filter(edge => byId.has(edge.source) && byId.has(edge.target)
    && (view === 'overlay' || (view === 'base' ? edge.inBase : edge.inHead)));
  const parents = new Map(available.map(node => [node.id, parentSymbol(node, available)]));
  function ancestors(node: Symbol): Symbol[] {
    const result: Symbol[] = [];
    let parent = parents.get(node.id);
    while (parent) { result.push(parent); parent = parents.get(parent.id); }
    return result;
  }
  const hidden = new Set(available.filter(node => !includeHelpers && node.id !== focusId && !isTopLevel(node)
    && parents.get(node.id) && !ancestors(node).some(parent => revealed.has(parent.id))).map(node => node.id));
  const kept = available.filter(node => !hidden.has(node.id));
  const folded = new Map<string, Symbol[]>();
  for (const node of available) {
    if (!hidden.has(node.id)) continue;
    const owner = ancestors(node).find(parent => !hidden.has(parent.id));
    if (owner) folded.set(owner.id, [...(folded.get(owner.id) || []), node]);
  }
  const callbackIds = new Set(rawEdges.filter(edge => edge.relation === 'callback').map(edge => edge.target));
  const labelSide: SnapshotSide = view === 'base' ? 'base' : 'head';
  const labels = new Map(available.map(node => [node.id, isTopLevel(node) ? node.name
    : helperLabel(node, parents.get(node.id), node[labelSide] ? labelSide : 'base', callbackIds.has(node.id))]));
  const allRelationships = new Map<string, SymbolRelationship>();

  // Walk each snapshot separately: an overlay must not splice a removed
  // registration together with a newly added callback invocation.
  for (const side of (view === 'overlay' ? ['base', 'head'] : [view]) as SnapshotSide[]) {
    const outgoing = new Map<string, CallEdge[]>();
    for (const edge of rawEdges) {
      if (!(side === 'base' ? edge.inBase : edge.inHead) || !byId.get(edge.source)?.[side] || !byId.get(edge.target)?.[side]) continue;
      outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge]);
    }
    for (const start of kept) {
      if (!start[side]) continue;
      const queue = (outgoing.get(start.id) || []).map(edge => ({ edge, path: [] as CallEdge[], via: [] as Symbol[] }));
      // A shortest source path is sufficient to explain each hidden scope;
      // visiting it once also keeps recursive helpers and repeated calls finite.
      const visited = new Set<string>();
      for (let index = 0; index < queue.length; index++) {
        const { edge, path, via } = queue[index];
        const target = byId.get(edge.target)!;
        const evidenceEdges = [...path, edge];
        if (hidden.has(target.id)) {
          if (visited.has(target.id)) continue;
          visited.add(target.id);
          for (const next of outgoing.get(target.id) || []) queue.push({ edge: next, path: evidenceEdges, via: [...via, target] });
          continue;
        }
        if (via.length && target.id === start.id) continue;
        const routeNodes = [start, ...via, target];
        const inBase = routeNodes.every(node => !!node.base) && evidenceEdges.every(item => item.inBase);
        const inHead = routeNodes.every(node => !!node.head) && evidenceEdges.every(item => item.inHead);
        const id = via.length ? `folded:${evidenceEdges.map(item => item.id).join('>')}` : edge.id;
        const expression = callExpression(edge, side, byId.get(edge.source));
        const provenance = via.map(node => helperLabel(node, parents.get(node.id), side, callbackIds.has(node.id))).join(' → ');
        allRelationships.set(id, { id, source: start.id, target: target.id, relation: edge.relation,
          inBase, inHead, status: inBase && inHead ? 'unchanged' : inHead ? 'added' : 'removed',
          label: via.length ? `via ${provenance} · ${relationLabel(edge).toLowerCase()} ${expression}`
            : edge.relation && edge.relation !== 'call' ? `${relationLabel(edge)}: ${expression}` : expression,
          via, evidenceEdges });
      }
    }
  }
  const relationships = [...allRelationships.values()];
  const roots = new Set(file ? kept.filter(node => belongsToFile(node, file, view)).map(node => node.id)
    : focusId && byId.has(focusId) ? [focusId] : []);
  const expandIds = new Set(roots.size ? [...roots, ...expanded] : []);
  // Revealing a callback should expose its source edges without making the
  // external dependency disappear merely because it now has an extra hop.
  for (const node of kept) {
    if (ancestors(node).some(parent => expandIds.has(parent.id))) expandIds.add(node.id);
  }
  const visible = new Set(roots);
  for (const edge of relationships) {
    if (expandIds.has(edge.source) || expandIds.has(edge.target)) { visible.add(edge.source); visible.add(edge.target); }
  }
  const neighbors = new Map<string, number>();
  for (const id of visible) {
    neighbors.set(id, new Set(relationships.filter(edge => edge.source === id || edge.target === id)
      .flatMap(edge => [edge.source, edge.target]).filter(other => other !== id && !visible.has(other))).size);
  }
  return { nodes: kept.filter(node => visible.has(node.id)), edges: relationships.filter(edge => visible.has(edge.source) && visible.has(edge.target)),
    roots, folded, labels, neighbors };
}
