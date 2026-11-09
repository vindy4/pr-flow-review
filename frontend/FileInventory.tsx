import { CheckCircle2, ChevronDown, ChevronRight, FileCode2 } from 'lucide-react';
import type { Analysis, ChangedFile } from './types';
import { fileMethods, isTopLevel } from './fileSelection';
import { isSourceFile } from './types';

export default function FileInventory({ analysis, search, expanded, selectedFile, selectedId, showHelpers, onHelpers,
  onToggle, onFile, onMethod, reviewed = new Set<string>(), groupBy = 'layer' }: {
  analysis: Analysis; search: string; expanded: Set<string>; selectedFile: ChangedFile | null;
  selectedId: string | null; showHelpers: boolean; onHelpers: (show: boolean) => void;
  onToggle: (path: string) => void; onFile: (file: ChangedFile) => void; onMethod: (id: string) => void;
  reviewed?: Set<string>; groupBy?: 'folder'|'layer';
}) {
  const needle = search.trim().toLowerCase();
  const groups = analysis.files.map(file => {
    const methods = fileMethods(analysis.nodes, file);
    const pathMatches = file.path.toLowerCase().includes(needle) || file.previousPath?.toLowerCase().includes(needle);
    const layer=analysis.architecture?.nodes.find(node=>node.path===file.path);
    const layerId=(layer?.head||layer?.base)?.layer;
    const layerIndex=analysis.architecture?.layers.findIndex(item=>item.id===layerId) ?? -1;
    const groupOrder=layerIndex<0?Number.MAX_SAFE_INTEGER:layerIndex;
    const group=groupBy==='layer'?(analysis.architecture?.layers[layerIndex]?.label||'Other files'):file.path.split('/').slice(0,-1).join('/')||'Repository root';
    return { file, group, groupOrder, methods: methods.filter(method => (showHelpers || (!!needle && !pathMatches && method.qualname.toLowerCase().includes(needle)) || isTopLevel(method) || method.id === selectedId)
      && (!needle || pathMatches || method.qualname.toLowerCase().includes(needle))) };
  }).filter(group => !needle || group.file.path.toLowerCase().includes(needle) || group.file.previousPath?.toLowerCase().includes(needle) || group.methods.length)
    .sort((a,b)=>(groupBy==='layer'?a.groupOrder-b.groupOrder:a.group.localeCompare(b.group))||a.file.path.localeCompare(b.file.path));

  return <>
    <label className="helpers-toggle method-helpers-toggle"><input type="checkbox" checked={showHelpers} onChange={e => onHelpers(e.target.checked)}/>Show callbacks and nested helpers</label>
    {!groups.length && <p className="inline-empty">No matching files or methods.</p>}
    {groups.map(({ file, methods, group }, index) => {
      const open = expanded.has(file.path) || !!needle;
      const containsSelection = methods.some(method => method.id === selectedId);
      return <div className={`file-tree-group ${containsSelection ? 'contains-selection' : ''}`} key={file.path}>
        {(index===0||groups[index-1].group!==group)&&<div className="file-group-label">{group}</div>}
        <div className="file-tree-row">
          <button className="file-tree-toggle icon-button" aria-label={`${open ? 'Collapse' : 'Expand'} methods in ${file.path}`} aria-expanded={open} disabled={!methods.length} onClick={() => onToggle(file.path)}>{open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</button>
          <button className={`changed-file-item ${selectedFile?.path === file.path ? 'selected' : ''}`} aria-current={selectedFile?.path === file.path ? 'true' : undefined} onClick={() => onFile(file)}>
            {reviewed.has(file.path)?<CheckCircle2 size={15} className="file-reviewed" aria-label="Reviewed"/>:<FileCode2 size={15}/>}<span><strong title={file.path}>{file.path.split('/').pop()}</strong><small title={file.path}>{file.path.split('/').slice(0, -1).join('/') || 'repository root'}</small>
            <em>{file.changedMethods ? `${file.changedMethods} changed methods` : file.indexed === false && isSourceFile(file.path) ? 'Outside indexed scope' : 'File-level changes'}</em>
            {file.previousPath && <small title={file.previousPath}>from {file.previousPath.split('/').pop()}</small>}</span><span className={`file-status ${file.status}`}>{file.status.slice(0, 1).toUpperCase()}</span>
          </button>
        </div>
        {open && methods.length > 0 && <div className="file-tree-methods">{methods.map(method => <button className={`inventory-method ${selectedId === method.id ? 'selected' : ''}`} key={method.id} onClick={() => onMethod(method.id)}>
          <span className={`status-dot ${method.status}`}/><span className="inventory-method-label"><strong title={method.qualname}>{method.name}</strong><span>{method.status === 'unchanged' ? 'unchanged context' : method.status.replace('_', ' + ')}</span></span><span className="method-line">{(method.head || method.base)?.startLine}</span><ChevronRight size={12}/>
        </button>)}</div>}
      </div>;
    })}
  </>;
}
