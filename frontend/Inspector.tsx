import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, Code2, Copy, ExternalLink, FileCode2, GitCompareArrows, Link2 } from 'lucide-react';
import type { Analysis, CallEdge, ChangedFile, Symbol, View } from './types';
import { isSourceFile } from './types';
import { callExpression, callSide, relationLabel } from './calls';
import { CommentLine } from './ReviewDrafts';
import { fileMethods, isTopLevel } from './fileSelection';
import { diffRows, sourceRows, type ReaderSearch, type TextMatch } from './readerModel';

export type InspectorTab = 'diff' | 'source' | 'connections';

export function snapshotUrl(analysis: Analysis, path: string, side: 'base' | 'head', line?: number) {
  if (analysis.meta.mode !== 'github' || !analysis.meta.repository) return null;
  const sha = side === 'base' ? analysis.meta.baseSha : analysis.meta.headSha;
  return `https://github.com/${analysis.meta.repository}/blob/${encodeURIComponent(sha)}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`;
}

export function SnapshotLink({ analysis, path, side, line, children }: { analysis: Analysis; path: string; side: 'base' | 'head'; line?: number; children?: React.ReactNode }) {
  const url = snapshotUrl(analysis, path, side, line);
  return url ? <a className="snapshot-link" href={url} target="_blank" rel="noreferrer">{children || 'Open snapshot'}<ExternalLink size={12} /></a> : <span className="local-source-label">Local Git snapshot</span>;
}

function HighlightedLine({line, matches = [], activeId}: {line: string; matches?: TextMatch[]; activeId?: string}) {
  const keywords = /^(import|from|export|default|const|let|var|return|function|async|await|if|else|throw|new|class|interface|type|extends|try|catch|finally|true|false|null|undefined|def|self|None|True|False)$/;
  const pieces = line.split(/(\/\/.*$|#[^'"`]*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:import|from|export|default|const|let|var|return|function|async|await|if|else|throw|new|class|interface|type|extends|try|catch|finally|true|false|null|undefined|def|self|None|True|False)\b|\b\d+(?:\.\d+)?\b)/g);
  let offset = 0;
  const tokens = pieces.map(text => {
    const token = {text, start: offset, end: offset + text.length,
      className: /^(\/\/|#)/.test(text) ? 'syntax-comment' : /^["'`]/.test(text) ? 'syntax-string' : /^\d/.test(text) ? 'syntax-number' : keywords.test(text) ? 'syntax-keyword' : undefined};
    offset = token.end; return token;
  });
  const paint = (start: number, end: number) => tokens.filter(token => token.end > start && token.start < end).map(token =>
    <span key={token.start} className={token.className}>{token.text.slice(Math.max(start, token.start) - token.start, Math.min(end, token.end) - token.start)}</span>);
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) content.push(<span key={`text-${cursor}`}>{paint(cursor, match.start)}</span>);
    content.push(<mark key={match.id} data-match-id={match.id} className={`search-match ${match.id === activeId ? 'active-search-match' : ''}`}>{paint(match.start, match.end)}</mark>);
    cursor = match.end;
  }
  if (cursor < line.length) content.push(<span key={`text-${cursor}`}>{paint(cursor, line.length)}</span>);
  return <>{content.length ? content : ' '}</>;
}

export function CodeView({ code, startLine = 1, highlightLine, review, search }: { code: string; startLine?: number; highlightLine?: number; review?: {path:string;side:'base'|'head'}; search?: ReaderSearch }) {
  return <div className="code-view source-code-view" role="region" aria-label="Source code">{sourceRows(code, startLine, review?.side).map(row => {
    const line = row.baseLine ?? row.headLine!;
    const matches = search?.byRow.get(row.id);
    const active = matches?.some(match => match.id === search?.activeId);
    return <div data-row-id={row.id} data-source-line={line} data-side={review?.side} className={`code-line ${highlightLine === line || active ? 'highlight' : ''}`} key={row.id}>
      {review && <CommentLine path={review.path} side={review.side} line={line} text={row.text}/>}
      <span className="line-number">{line}</span><code><HighlightedLine line={row.text} matches={matches} activeId={search?.activeId}/></code>
    </div>;
  })}</div>;
}

export function DiffView({ diff, baseStart, headStart, basePath, headPath, search, label = 'Method diff' }: { diff: string; baseStart: number; headStart: number; basePath:string; headPath:string; search?: ReaderSearch; label?: string }) {
  return <div className="code-view diff-view" role="region" aria-label={label}>{diffRows(diff, baseStart, headStart).map(row => {
    if (row.kind === 'hunk') return <div className="diff-hunk" key={row.id}>{row.text}</div>;
    if (row.kind === 'notice') return <div className="diff-notice" key={row.id}>{row.text}</div>;
    const side = row.kind === 'deletion' ? 'base' : 'head';
    const line = side === 'base' ? row.baseLine : row.headLine;
    const matches = search?.byRow.get(row.id);
    const active = matches?.some(match => match.id === search?.activeId);
    return <div data-row-id={row.id} data-source-line={line} data-base-line={row.baseLine} data-head-line={row.headLine} data-side={side} className={`code-line ${row.kind} ${active ? 'highlight' : ''}`} key={row.id}>
      {line !== undefined && <CommentLine path={side === 'base' ? basePath : headPath} side={side} line={line} text={row.text}/>}
      <span className="line-number old-line-number">{row.baseLine ?? ''}</span><span className="line-number new-line-number">{row.headLine ?? ''}</span>
      <span className="diff-marker" aria-hidden="true">{row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ''}</span>
      <code><HighlightedLine line={row.text} matches={matches} activeId={search?.activeId}/></code>
    </div>;
  })}</div>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="icon-button" title="Copy source" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}

function CallEvidence({ edge, analysis, view, onSelect }: { edge: CallEdge; analysis: Analysis; view: View; onSelect: (id: string) => void }) {
  const source = analysis.nodes.find(node => node.id === edge.source);
  const target = analysis.nodes.find(node => node.id === edge.target);
  // Select an existing version and its matching line. Removed calls always use base evidence.
  const preferredSide = callSide(edge, view);
  const side = preferredSide === 'head' && source?.head && edge.headLine != null ? 'head' : source?.base && edge.baseLine != null ? 'base' : 'head';
  const version = side === 'base' ? source?.base : source?.head;
  const path = (side === 'base' ? source?.basePath || edge.basePath : source?.headPath || edge.headPath) || source?.path || edge.evidence.path;
  const line = (side === 'base' ? edge.baseLine : edge.headLine) ?? edge.evidence.line ?? edge.line;
  const sourceLines = version?.code.replace(/\n$/, '').split('\n') || [];
  const offset = version ? Math.max(0, line - version.startLine - 3) : 0;
  const snippet = sourceLines.slice(offset, Math.min(sourceLines.length, offset + 7)).join('\n');
  return <section className="evidence-card">
    <div className="section-kicker"><Link2 size={13} /> {relationLabel(edge).toUpperCase()} EVIDENCE <span className={`status-pill ${edge.status}`}>{edge.status}</span></div>
    <div className="call-direction"><button onClick={() => onSelect(edge.source)}>{source?.qualname || edge.source}</button><ArrowRight size={15} /><button onClick={() => onSelect(edge.target)}>{target?.qualname || edge.target}</button></div>
    <div className="call-expression" title={`Call expression from the ${side === 'base' ? 'before' : 'after'} snapshot`}>{callExpression(edge, side, source)}</div>
    <div className="evidence-provenance"><span>{side === 'base' ? 'Before' : 'After'} · line {line}</span><SnapshotLink analysis={analysis} path={path} side={side} line={line} /></div>
    {snippet && version ? <CodeView code={snippet} startLine={version.startLine + offset} highlightLine={line} review={{path,side}} /> : <p className="inline-empty">Source text is unavailable for this call site.</p>}
    <p className="evidence-path" title={path}>{path}</p>
    <p className="evidence-caption">{edge.relation === 'render' ? 'A JSX component reference. Rendering depends on React and runtime conditions.' : edge.relation === 'callback' ? 'A function reference passed or defined as a callback. This does not prove when or whether it executes.' : 'A callable binding resolved from source. This relationship does not establish runtime execution.'}</p>
  </section>;
}

export default function Inspector({ analysis, selected, file, edge, tab, onTab, view, onSelect, onEdgeSelect, onFocus }: {
  analysis: Analysis | null; selected: Symbol | null; file: ChangedFile | null; edge: CallEdge | null; tab: InspectorTab; onTab: (tab: InspectorTab) => void; view: View;
  onSelect: (id: string) => void; onEdgeSelect: (edge: CallEdge) => void; onFocus: (id: string) => void;
}) {
  const [sourceSide, setSourceSide] = useState<'base' | 'head'>('head');
  const [unresolvedOpen, setUnresolvedOpen] = useState(true);
  useEffect(() => { if (view !== 'overlay') setSourceSide(view); }, [view]);
  const incoming = analysis?.edges.filter(item => item.target === selected?.id && (view === 'overlay' || (view === 'base' ? item.inBase : item.inHead))) || [];
  const outgoing = analysis?.edges.filter(item => item.source === selected?.id && (view === 'overlay' || (view === 'base' ? item.inBase : item.inHead))) || [];
  const side = sourceSide === 'head' && selected?.head ? 'head' : selected?.base ? 'base' : 'head';
  const version = selected ? side === 'head' ? selected.head : selected.base : null;
  const methodsInFile = analysis && file ? fileMethods(analysis.nodes, file).filter(isTopLevel) : [];
  const connectionGroup = (items: CallEdge[], direction: 'in' | 'out') => <div className="connection-group"><h4>{direction === 'in' ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}{direction === 'in' ? 'Incoming relationships' : 'Outgoing relationships'}<span>{items.length}</span></h4>{items.length ? items.map(item => {
    const other = analysis?.nodes.find(node => node.id === (direction === 'in' ? item.source : item.target));
    return <button className={`connection-item ${edge?.id === item.id ? 'selected' : ''}`} key={item.id} onClick={() => onEdgeSelect(item)}><span className={`status-dot ${item.status}`} /><span><strong>{other?.qualname || (direction === 'in' ? item.source : item.target)}</strong><small>{relationLabel(item)}</small><code>{callExpression(item, callSide(item, view), analysis?.nodes.find(node => node.id === item.source))}</code></span><ChevronRight size={13} /></button>;
  }) : <p className="inline-empty">No {direction === 'in' ? 'callers' : 'callees'} resolved in this snapshot and scope.</p>}</div>;
  return <aside className="inspector-panel" aria-label="Evidence inspector">
    <div className="panel-heading"><div><h2><Code2 size={16} /> Inspector</h2><span className="heading-sub">Evidence, down to the line</span></div>{selected && <button className="icon-button" title="Focus this method in graph" onClick={() => onFocus(selected.id)}><GitCompareArrows size={16} /></button>}</div>
    {analysis && file ? <div className="file-inspector"><div className="section-kicker"><FileCode2 size={14} /> CHANGED FILE</div><h3>{file.path.split('/').pop()}</h3><p className="file-full-path">{file.path}</p><span className={`status-pill ${file.status}`}>{file.status}</span>{methodsInFile.length > 0 && <section className="file-method-list" aria-label="Methods in this file"><h4>Methods in this file <span>{methodsInFile.length}</span></h4><p>Select one to read its change and follow its relationships.</p>{methodsInFile.map(method => <button className="file-method-link" key={method.id} onClick={() => onSelect(method.id)}><span className={`status-dot ${method.status}`}/><span><strong>{method.qualname}</strong><small>{method.status === 'unchanged' ? 'unchanged context' : method.status.replace('_', ' + ')}</small></span><ChevronRight size={13}/></button>)}</section>}<div className="file-context-note"><FileCode2 size={25} /><h4>{file.changedMethods ? `${file.changedMethods} changed methods` : file.indexed === false && isSourceFile(file.path) ? 'Outside indexed scope' : 'File-level changes'}</h4><p>{file.changedMethods ? 'The graph shows this file’s methods and their immediate callers and callees. Select a method here, in the inventory, or in the graph to inspect its change.' : file.indexed === false && isSourceFile(file.path) ? 'This source file was excluded by scope, test settings, or analysis limits. Its methods were not analyzed. Expand the scope or include tests to inspect its relationships.' : file.indexed === false ? 'This changed file is not a supported source file and is not represented by the method graph.' : 'This indexed file changed without a changed function, hook, component, or method. Changes may include class declarations, dataclasses, constants, or imports.'}</p><p>Inspect the pinned file snapshots for the complete change. File-level edits may affect otherwise unchanged methods.</p></div><div className="file-snapshot-links">{file.status !== 'added' && <SnapshotLink analysis={analysis} path={file.previousPath || file.path} side="base">Before snapshot</SnapshotLink>}{!['removed', 'deleted'].includes(file.status) && <SnapshotLink analysis={analysis} path={file.path} side="head">After snapshot</SnapshotLink>}</div></div> : selected && analysis ? <>
      <div className="inspector-method"><div className="method-title-row"><span className={`status-pill ${selected.status}`}>{selected.status}</span><span>{selected.language ? `${selected.language} · ` : ''}{selected.kind}</span></div><h3 title={selected.qualname}>{selected.qualname}</h3>{selected.basePath && selected.headPath && selected.basePath !== selected.headPath && <p className="moved-method-path">Moved from {selected.basePath}</p>}<div className="inspector-path" title={selected.path}><FileCode2 size={12} /><span>{selected.path}</span></div></div>
      <div className="inspector-tabs" role="tablist">{(['diff', 'source', 'connections'] as InspectorTab[]).map(value => <button role="tab" aria-selected={tab === value} key={value} onClick={() => onTab(value)} className={tab === value ? 'active' : ''}>{value === 'diff' ? 'Method diff' : value === 'source' ? 'Source' : 'Connections'}{value === 'connections' && <span>{incoming.length + outgoing.length}</span>}</button>)}</div>
      <div className="inspector-content">
        {tab === 'diff' && <><div className="code-toolbar"><span>Before <ArrowRight size={11} /> After</span><SnapshotLink analysis={analysis} path={(selected.head ? selected.headPath : selected.basePath) || selected.path} side={selected.head ? 'head' : 'base'} line={(selected.head || selected.base)?.startLine} /></div>{selected.diff ? <DiffView diff={selected.diff} baseStart={selected.base?.startLine || 0} headStart={selected.head?.startLine || 0} basePath={selected.basePath || selected.path} headPath={selected.headPath || selected.path} /> : <div className="no-method-diff"><Check size={21} /><strong>No textual method changes</strong><p>This method provides context for the change. Imports, globals, and class declarations elsewhere in its file may still affect behavior.</p><SnapshotLink analysis={analysis} path={(selected.head ? selected.headPath : selected.basePath) || selected.path} side={selected.head ? 'head' : 'base'}>Inspect full file snapshot</SnapshotLink></div>}</>}
        {tab === 'source' && <><div className="code-toolbar"><div className="segmented source-switch"><button className={side === 'base' ? 'active' : ''} disabled={!selected.base} onClick={() => setSourceSide('base')}>Before</button><button className={side === 'head' ? 'active' : ''} disabled={!selected.head} onClick={() => setSourceSide('head')}>After</button></div><div className="source-actions"><SnapshotLink analysis={analysis} path={(side === 'base' ? selected.basePath : selected.headPath) || selected.path} side={side} line={version?.startLine} />{version && <CopyButton text={version.code} />}</div></div>{version ? <CodeView code={version.code} startLine={version.startLine} review={{path:(side === 'base' ? selected.basePath : selected.headPath) || selected.path,side}} /> : <p className="inline-empty">Method is absent in this snapshot.</p>}</>}
        {tab === 'connections' && <>{edge && <CallEvidence edge={edge} analysis={analysis} view={view} onSelect={onSelect} />}{connectionGroup(incoming, 'in')}{connectionGroup(outgoing, 'out')}<div className="unresolved-section"><button className="unresolved-heading" onClick={() => setUnresolvedOpen(value => !value)}><AlertCircle size={14} /><strong>Unresolved calls</strong><span>{selected.unresolvedCalls.length}</span>{unresolvedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>{unresolvedOpen && (selected.unresolvedCalls.length ? <><p className="unresolved-explanation">Visible for review; no relationship is guessed for dynamic dispatch.</p>{selected.unresolvedCalls.map((call, index) => <div className="unresolved-call" key={index}><code>{call.expression}</code><span>Line {call.line} · {selected.head ? 'After' : 'Before'}</span><p>{call.reason}</p><SnapshotLink analysis={analysis} path={(selected.head ? selected.headPath : selected.basePath) || selected.path} side={selected.head ? 'head' : 'base'} line={call.line}>View call site</SnapshotLink></div>)}</> : <p className="inline-empty">No unresolved calls reported in this method.</p>)}</div></>}
      </div>
    </> : <div className="inspector-empty"><div><Code2 size={26} strokeWidth={1.4} /></div><h3>Every connection has context</h3><p>Select a method to inspect its source and diff. Select a graph edge to see the exact call site.</p><span><span className="keyboard-key">↖</span> Start with a changed file</span></div>}
  </aside>;
}
