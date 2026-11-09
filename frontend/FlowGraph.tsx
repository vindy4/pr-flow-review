import { useEffect, useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { ArrowDownLeft, ArrowUpRight, Expand, Focus, GitBranch, Maximize2, Plus, RotateCcw } from 'lucide-react';
import { isSourceFile, type Analysis, type CallEdge, type ChangedFile, type Status, type Symbol, type View } from './types';
import { methodFile } from './fileSelection';
import { projectSymbolGraph } from './graphProjection';

type MethodData = Record<string, unknown> & { method: Symbol; label: string; isFocus: boolean; focusLabel: string; neighbors: number;
  helpers: Symbol[]; helperSummary: string; onReveal: (id: string) => void; onExpand: (id: string) => void };
type MethodNode = Node<MethodData, 'method'>;
const WIDTH = 250;
const HEIGHT = 94;
const colors: Record<Status, string> = { added: 'var(--added)', modified: 'var(--modified)', removed: 'var(--removed)', unchanged: 'var(--graph-line)', moved: 'var(--moved)', moved_modified: 'var(--moved-modified)' };

function MethodCard({ data, selected }: NodeProps<MethodNode>) {
  return <div className={`method-node ${data.helpers.length ? 'has-helpers' : ''} ${selected ? 'selected' : ''} ${data.isFocus ? 'is-focus' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <div className="node-top"><span className={`status-dot ${data.method.status}`} /><span className="node-type" title={data.method.className || data.method.kind}>{data.method.className || data.method.kind}</span>{data.isFocus && <span className="node-focus">{data.focusLabel}</span>}<span className={`node-status ${data.method.status}`}>{data.method.status}</span></div>
    <div className="node-name" title={data.method.qualname}>{data.label}</div>
    <div className="node-bottom"><span title={data.method.path}>{data.method.path.split('/').slice(-2).join('/')}</span><button disabled={!data.neighbors} className="node-expand nodrag nopan" title={data.neighbors ? `Expand neighbors of ${data.method.qualname}` : 'All immediate neighbors are visible'} onClick={event => { event.stopPropagation(); data.onExpand(data.method.id); }}><Plus size={12} /> {data.neighbors}</button></div>
    {data.helpers.length > 0 && <button className="node-helpers text-button nodrag nopan" aria-label={`Show ${data.helperSummary} in ${data.method.qualname}`} onClick={event => { event.stopPropagation(); data.onReveal(data.method.id); }}><Plus size={11} /> {data.helperSummary}</button>}
    <Handle type="source" position={Position.Right} />
  </div>;
}
const nodeTypes = { method: MethodCard };

export default function FlowGraph({ analysis, file, includeHelpers, onFile, focusId, selectedId, selectedEdgeId, view, onNodeSelect, onEdgeSelect, onFocus }: {
  file: ChangedFile | null; includeHelpers: boolean; onFile: (file: ChangedFile) => void;
  analysis: Analysis | null; focusId: string | null; selectedId: string | null; selectedEdgeId: string | null; view: View;
  onNodeSelect: (id: string) => void; onEdgeSelect: (edge: CallEdge) => void; onFocus: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [instance, setInstance] = useState<ReactFlowInstance<MethodNode> | null>(null);
  const [miniMap, setMiniMap] = useState(true);
  useEffect(() => { setExpanded(new Set()); setRevealed(new Set()); }, [focusId, file?.path, analysis, view, includeHelpers]);
  const focusNode = analysis?.nodes.find(node => node.id === focusId);
  const projection = useMemo(() => analysis ? projectSymbolGraph(analysis, { file, focusId, view, includeHelpers,
    expanded, revealedOwners: revealed }) : null, [analysis, file, focusId, view, includeHelpers, expanded, revealed]);
  const graph = useMemo(() => {
    if (!projection || (!focusId && !file)) return { nodes: [] as MethodNode[], edges: [] as Edge[] };
    const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    layout.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 95, marginx: 35, marginy: 35 });
    projection.nodes.forEach(node => layout.setNode(node.id, { width: WIDTH, height: HEIGHT + (projection.folded.get(node.id)?.length ? 25 : 0) }));
    projection.edges.forEach(edge => layout.setEdge(edge.source, edge.target));
    dagre.layout(layout);
    const callbackIds = new Set(analysis?.edges.filter(edge => edge.relation === 'callback').map(edge => edge.target));
    const nodes: MethodNode[] = projection.nodes.map(method => {
      const { id } = method;
      const point = layout.node(id);
      const helpers = projection.folded.get(id) || [];
      const callbacks = helpers.filter(helper => helper.kind === 'callback' || callbackIds.has(helper.id)).length;
      const helperSummary = callbacks === helpers.length ? `${callbacks} local callbacks` : callbacks ? `${callbacks} callbacks · ${helpers.length - callbacks} helpers` : `${helpers.length} local helpers`;
      const height = HEIGHT + (helpers.length ? 25 : 0);
      return { id, type: 'method', position: { x: point.x - WIDTH / 2, y: point.y - height / 2 }, width: WIDTH, height, selected: selectedId === id && !selectedEdgeId,
        data: { method, label: projection.labels.get(id) || method.name, isFocus: projection.roots.has(id), focusLabel: file ? 'IN FILE' : 'FOCUS',
          neighbors: projection.neighbors.get(id) || 0, helpers, helperSummary, onReveal: nodeId => setRevealed(previous => new Set([...previous, nodeId])),
          onExpand: nodeId => setExpanded(previous => new Set([...previous, nodeId])) } };
    });
    const edges: Edge[] = projection.edges.map(edge => {
      const selected = edge.evidenceEdges.some(item => item.id === selectedEdgeId);
      return { id: edge.id, source: edge.source, target: edge.target, type: 'smoothstep', selected, ariaLabel: edge.label,
      markerEnd: { type: MarkerType.ArrowClosed, color: selected ? 'var(--accent)' : colors[edge.status], width: 15, height: 15 },
      label: edge.label.length > 65 ? `${edge.label.slice(0, 62)}…` : edge.label,
      labelStyle: { fontSize: 10, fill: 'var(--text-muted)', fontFamily: 'var(--mono)' }, labelBgStyle: { fill: 'var(--canvas)', fillOpacity: 0.94 }, labelBgPadding: [6, 4] as [number, number],
      style: { stroke: selected ? 'var(--accent)' : colors[edge.status], strokeWidth: selected ? 2.5 : 1.5, strokeDasharray: edge.status === 'removed' ? '5 4' : edge.via.length || edge.relation === 'callback' ? '2 4' : edge.relation === 'render' ? '7 3' : undefined },
    }; });
    return { nodes, edges };
  }, [analysis, projection, focusId, file, selectedId, selectedEdgeId]);
  // Selection updates evidence without moving the canvas. Only the visible neighborhood changes trigger fitting.
  const structureKey = `${file?.path || focusId}|${view}|${graph.nodes.map(node => node.id).sort().join('|')}`;
  useEffect(() => {
    if (instance && graph.nodes.length) {
      const timer = window.setTimeout(() => instance.fitView({ padding: 0.2, duration: 350, maxZoom: 1 }), 80);
      return () => window.clearTimeout(timer);
    }
  }, [instance, structureKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedNode = analysis?.nodes.find(node => node.id === selectedId);
  const parentFile = analysis && focusNode ? methodFile(analysis.files, focusNode, view) : null;
  const fileAbsent = file && ((view === 'base' && file.status === 'added') || (view === 'head' && ['removed', 'deleted'].includes(file.status)));
  const fileEmptyTitle = fileAbsent ? `File absent ${view === 'base' ? 'before' : 'after'} this change`
    : file?.indexed === false ? isSourceFile(file.path) ? 'File outside indexed scope' : 'This is not a supported source file'
    : 'No analyzed methods in this file';
  const foldedCount = graph.nodes.reduce((sum, node) => sum + node.data.helpers.length, 0);
  const unresolvedCount = graph.nodes.reduce((sum, node) => sum + node.data.method.unresolvedCalls.length
    + node.data.helpers.reduce((count, helper) => count + helper.unresolvedCalls.length, 0), 0);
  return <section className="graph-panel" aria-label="Source call graph">
    <div className="panel-heading graph-heading"><div><h2><GitBranch size={16} /> Relationship graph</h2><span className="heading-sub">{file ? 'Methods in this file, with callers and callees' : 'Explore the relationships around this method'}</span></div><span className="quiet-badge">SOURCE LEVEL</span></div>
    <div className="graph-toolbar"><div className="graph-tools"><button className="icon-button" title="Focus selected method" disabled={!selectedNode || selectedNode.id === focusId} onClick={() => selectedId && onFocus(selectedId)}><Focus size={16} /></button><button className="icon-button" title="Reset to one-hop neighborhood" disabled={!analysis} onClick={() => { setExpanded(new Set()); setRevealed(new Set()); }}><RotateCcw size={15} /></button><button className="icon-button" title="Fit graph to view" disabled={!graph.nodes.length} onClick={() => instance?.fitView({ padding: 0.2, duration: 350, maxZoom: 1 })}><Maximize2 size={15} /></button></div></div>
    <div className="graph-context"><span className="focus-label"><span className="teal-dot" />{file ? <><span className="muted">File</span><strong title={file.path}>{file.path.split('/').pop()}</strong></> : focusNode ? <><span className="muted">Method</span><strong title={focusNode.qualname}>{focusNode.qualname}</strong></> : 'Choose a file to explore'}</span><span className="depth-label">{expanded.size ? 'Expanded' : 'Depth 1'}</span></div>
    {!file && parentFile && <button className="graph-file-back text-button" aria-label="Back to file relationships" title={parentFile.path} onClick={() => onFile(parentFile)}>← Back to {parentFile.path.split('/').pop()} relationships</button>}
    <div className="graph-canvas">
      {analysis && graph.nodes.length > 0 ? <ReactFlow<MethodNode> nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} onInit={setInstance} onNodeClick={(_, node) => onNodeSelect(node.id)} onEdgeClick={(_, edge) => {
        const relationship = projection?.edges.find(item => item.id === edge.id);
        const call = relationship?.evidenceEdges.at(-1);
        if (relationship?.via.length) setRevealed(previous => new Set([...previous, ...[...(projection?.folded || [])]
          .filter(([, helpers]) => helpers.some(helper => relationship.via.some(via => via.id === helper.id))).map(([owner]) => owner)]));
        if (call) onEdgeSelect(call);
      }} fitView minZoom={0.08} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} elementsSelectable proOptions={{ hideAttribution: true }}>
        <Background color="var(--graph-dot)" gap={22} size={1} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} />
        {miniMap && <MiniMap nodeColor={node => colors[(node.data as MethodData).method.status]} nodeStrokeWidth={0} maskColor="var(--minimap-mask)" pannable zoomable />}
      </ReactFlow> : <div className="graph-empty"><div className="empty-graph-icon"><GitBranch size={31} strokeWidth={1.5} /></div><h3>{!analysis ? 'A clearer view of the change' : file ? fileEmptyTitle : focusNode ? `Method absent ${view === 'base' ? 'before' : 'after'} this change` : 'No methods in this comparison'}</h3><p>{!analysis ? 'Analyze a pull request to follow callers, inspect callees, and find the evidence behind every connection.' : fileAbsent || focusNode ? 'Open Full file to read the available source, or choose another file or method from the inventory.' : file?.indexed === false ? 'Review the pinned file snapshots in the inspector. Supported source files may need a broader scope or test-file inclusion.' : 'This file has no analyzed functions in this snapshot. Imports, constants and other file-level edits are available in its pinned snapshots.'}</p>{!analysis && <div className="empty-flow"><span><ArrowDownLeft size={13} /> Callers</span><i /><span className="empty-flow-focus">Changed method</span><i /><span>Callees <ArrowUpRight size={13} /></span></div>}</div>}
      {analysis && graph.nodes.length > 0 && <button className={`minimap-toggle ${miniMap ? 'active' : ''}`} onClick={() => setMiniMap(value => !value)} title="Toggle minimap"><Expand size={13} /> Map</button>}
    </div>
    <div className="graph-footer"><div className="graph-legend"><span><i className="added" />Added</span><span><i className="modified" />Modified</span><span><i className="removed" />Removed</span></div><span>{analysis ? `${graph.nodes.length} methods · ${graph.edges.length} relationships` : 'Static calls · no runtime execution'}</span></div>
    {analysis && <div className="graph-note"><span>{unresolvedCount ? `${unresolvedCount} unresolved calls reported for these methods` : 'Only resolved source relationships shown'}{foldedCount > 0 && ` · ${foldedCount} local callbacks/helpers folded`}</span><span>{foldedCount ? '“via” preserves local scope; click to reveal the source path' : 'Click a relationship for evidence'}</span></div>}
  </section>;
}
