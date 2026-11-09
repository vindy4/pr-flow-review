import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, FileCode2, Search, X } from 'lucide-react';
import ArchitectureMap from './ArchitectureMap';
import FlowGraph from './FlowGraph';
import FileInventory from './FileInventory';
import FileReader, { type ReaderMode, type SourceJump } from './FileReader';
import PanelWorkspace from './PanelWorkspace';
import { ReviewDraftsButton } from './ReviewDrafts';
import { featureGraph, fileGraph } from './architecture';
import { methodFile } from './fileSelection';
import { callSide } from './calls';
import { createReviewProgress, reviewIdentity } from './review-progress';
import useFileSource from './useFileSource';
import type { Analysis, ArchitectureEdge, ChangedFile, View } from './types';

type CodeMode='diff'|'source';
type Visit={path:string;mode:ReaderMode;view:View;readerMode?:CodeMode};
function stored<T>(key:string,fallback:T):T {try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}}
export { reviewIdentity } from './review-progress';
function resolveFile(analysis:Analysis,path:string):ChangedFile|null {
  const changed=analysis.files.find(file=>file.path===path||file.previousPath===path);if(changed)return changed;
  const node=analysis.architecture?.nodes.find(file=>file.path===path||file.base?.path===path);
  if(node)return {path:node.path,previousPath:node.base?.path!==node.path?node.base?.path:undefined,status:node.status,changedMethods:0,indexed:(node.head||node.base)?.indexed};
  const symbol=analysis.nodes.find(node=>node.path===path||node.basePath===path);
  return symbol?methodFile(analysis.files,symbol):null;
}

export default function ReviewWorkspace({analysis,busy}: {analysis:Analysis;busy:boolean}) {
  const identity=reviewIdentity(analysis);
  const sessionKey=`flowreview:session:${identity}`;
  const first=analysis.files[0]||analysis.nodes[0]&&methodFile(analysis.files,analysis.nodes[0]);
  const saved=useRef(stored<Partial<Visit>>(sessionKey,{}));
  const initial=resolveFile(analysis,saved.current.path||'')||first;
  const [file,setFile]=useState<ChangedFile|null>(initial||null);
  const [mode,setMode]=useState<ReaderMode>(['diff','source','relationships'].includes(saved.current.mode||'')?saved.current.mode!:'diff');
  const [readerMode,setReaderMode]=useState<CodeMode>(saved.current.readerMode==='source'?'source':'diff');
  const [drawerOpen,setDrawerOpen]=useState(true);
  const workspace=useRef<HTMLDivElement>(null);
  const scrollPositions=useRef(new Map<string,{top:number;left:number}>());
  const [view,setView]=useState<View>(saved.current.view==='base'?'base':initial&&['removed','deleted'].includes(initial.status)?'base':'head');
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [jump,setJump]=useState<SourceJump|null>(null);
  const serial=useRef(0);
  const [edge,setEdge]=useState<ArchitectureEdge|null>(null);
  const [search,setSearch]=useState('');
  const [groupBy,setGroupBy]=useState<'folder'|'layer'>('layer');
  const [showHelpers,setShowHelpers]=useState(false);
  const [expanded,setExpanded]=useState<Set<string>>(new Set(initial?[initial.path]:[]));
  const [progress]=useState(()=>createReviewProgress(analysis));
  const [reviewed,setReviewed]=useState<Set<string>>(()=>progress.reviewed);
  const [storageError,setStorageError]=useState('');
  const [progressError,setProgressError]=useState('');
  useEffect(()=>{
    let active=true;const controller=new AbortController();
    setStorageError(progress.storageError);
    progress.refresh(async body=>{
      const response=await fetch('/api/reviews/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
      const value=await response.json();if(!response.ok)throw new Error(value.error||'Could not check viewed files.');return value;
    }).then(next=>{
      if(!active)return;
      if(next)setReviewed(next);else setProgressError('The pull request changed again. Analyze its latest commits to carry forward viewed files.');
      setStorageError(progress.storageError);
    }).catch(()=>{if(active)setProgressError('Viewed-file progress from earlier commits could not be checked. Refresh this comparison to try again.');});
    return()=>{active=false;progress.cancelRefresh();controller.abort();};
  },[progress]);
  const [history,setHistory]=useState<{entries:Visit[];index:number}>({entries:initial?[{path:initial.path,mode,view,readerMode}]:[],index:0});
  const [imports,setImports]=useState(false);
  const [graphScope,setGraphScope]=useState<'file'|'all'>('file');
  const [graphDetail,setGraphDetail]=useState<'files'|'functions'>('files');
  const source=useFileSource(analysis,file?.path||'');
  const architecture=analysis.architecture;
  const architectureFile=architecture?.nodes.find(node=>node.path===file?.path||node.base?.path===file?.path);
  const graph=useMemo(()=>architecture?(graphScope==='all'?featureGraph(architecture,'all','head',imports):fileGraph(architecture,architectureFile?.id||'','head',imports)):{files:[],edges:[]},[architecture,architectureFile?.id,graphScope,imports]);
  function persist(nextFile:ChangedFile|null,nextMode=mode,nextView=view,nextReaderMode=readerMode) {
    try{localStorage.setItem(sessionKey,JSON.stringify({path:nextFile?.path,mode:nextMode,view:nextView,readerMode:nextReaderMode}));}catch{setStorageError('Browser storage is unavailable. Review progress is kept for this session.');}
  }
  function changeMode(next:ReaderMode) {
    setMode(next);setJump(null);
    if(next==='relationships'){setReaderMode('diff');setDrawerOpen(true);persist(file,next,view,'diff');}
    else persist(file,next);
  }
  function changeReaderMode(next:ReaderMode) {
    if(next==='relationships')return;
    setReaderMode(next);setJump(null);persist(file,mode,view,next);
  }
  function closeDrawer() {
    setDrawerOpen(false);
    requestAnimationFrame(()=>workspace.current?.querySelector<HTMLButtonElement>('button[title="Show reader"]')?.focus());
  }
  function changeView(next:View) {setView(next);setJump(null);persist(file,mode,next);}
  function openFile(path:string) {
    const next=resolveFile(analysis,path);if(!next)return;
    setEdge(null);setSelectedId(null);setJump(null);setGraphScope('file');
    const nextReaderMode=mode==='relationships'?'diff':readerMode;
    if(mode==='relationships'){setReaderMode('diff');setDrawerOpen(true);}
    if(next.path===file?.path){persist(next,mode,view,nextReaderMode);return;}
    const nextView=['removed','deleted'].includes(next.status)?'base':next.status==='added'?'head':view;
    setHistory(previous=>{const entries=previous.entries.slice(0,previous.index+1);if(file)entries[previous.index]={path:file.path,mode,view,readerMode};entries.push({path:next.path,mode,view:nextView,readerMode:nextReaderMode});return {entries,index:entries.length-1};});
    setFile(next);setView(nextView);setExpanded(previous=>new Set([...previous,next.path]));persist(next,mode,nextView,nextReaderMode);
  }
  function visit(direction:number) {
    const index=history.index+direction;const item=history.entries[index];if(!item)return;
    const next=resolveFile(analysis,item.path);if(!next)return;
    setHistory(previous=>{const entries=[...previous.entries];if(file)entries[previous.index]={path:file.path,mode,view,readerMode};return {entries,index};});
    const nextReaderMode=item.readerMode||'diff';
    setFile(next);setMode(item.mode);setReaderMode(nextReaderMode);setDrawerOpen(true);setView(item.view);setSelectedId(null);setEdge(null);setJump(null);setGraphScope('file');persist(next,item.mode,item.view,nextReaderMode);
  }
  function jumpToLine(line:number,side:'base'|'head',path?:string) {
    const next=path?resolveFile(analysis,path)||file:file;
    if(next)openFile(next.path);
    const nextMode=mode==='relationships'?'relationships':'source';
    setMode(nextMode);setReaderMode('source');setDrawerOpen(true);setView(side);setJump({line,serial:++serial.current});persist(next,nextMode,side,'source');
  }
  function selectSymbol(id:string,snapshot:View=view) {
    const symbol=analysis.nodes.find(node=>node.id===id);if(!symbol)return;
    const next=methodFile(analysis.files,symbol,snapshot);if(next.path!==file?.path)openFile(next.path);
    const side=snapshot==='base'&&symbol.base?'base':symbol.head?'head':'base';
    const nextMode=mode==='relationships'?'relationships':'source';
    setSelectedId(id);setEdge(null);setMode(nextMode);setReaderMode('source');setDrawerOpen(true);setView(side);setJump({line:symbol[side]!.startLine,serial:++serial.current});
    setExpanded(previous=>new Set([...previous,next.path]));persist(next,nextMode,side,'source');
  }
  const reviewedCount=analysis.files.filter(file=>reviewed.has(file.path)).length;
  function markReviewed() {
    if(!file)return;setReviewed(progress.toggle(file.path));setStorageError(progress.storageError);
  }
  function nextUnreviewed() {
    const index=analysis.files.findIndex(item=>item.path===file?.path);
    const order=[...analysis.files.slice(index+1),...analysis.files.slice(0,index+1)];
    const next=order.find(item=>!reviewed.has(item.path));if(next)openFile(next.path);
  }
  const relationships=<div className="reader-relationships"><div className="relationship-controls"><label>Graph detail <select aria-label="Graph detail" value={graphDetail} onChange={e=>{setGraphDetail(e.target.value as 'files'|'functions');setGraphScope('file');}}><option value="files">Files</option><option value="functions">Functions and callbacks</option></select></label>{graphDetail==='files'&&<><label>Map scope <select aria-label="Relationship scope" value={graphScope} onChange={e=>setGraphScope(e.target.value as 'file'|'all')}><option value="file">Current file and connections</option><option value="all">All changed files</option></select></label><label><input type="checkbox" checked={imports} onChange={e=>setImports(e.target.checked)}/>Import context</label></>}</div>{architecture&&graphDetail==='files'?<ArchitectureMap files={graph.files} edges={graph.edges} layers={architecture.layers} root={graphScope==='all'?'all':architectureFile?.id||''} view="head" selectedId={architectureFile?.id||null} selectedEdgeId={edge?.id||null} onFile={item=>openFile(item.path)} onEdge={setEdge}/>:<FlowGraph analysis={analysis} file={file} includeHelpers={showHelpers} onFile={item=>openFile(item.path)} focusId={selectedId} selectedId={selectedId} selectedEdgeId={null} view="head" onNodeSelect={id=>selectSymbol(id,'head')} onEdgeSelect={item=>{const symbol=analysis.nodes.find(node=>node.id===item.source);const side=callSide(item,'head');jumpToLine((side==='base'?item.baseLine:item.headLine)||item.line,side,symbol?.path);}} onFocus={id=>selectSymbol(id,'head')}/>}</div>;
  return <div ref={workspace} className={`review-workspace ${busy?'is-analyzing':''}`} onKeyDown={event=>{
    if(event.key==='Escape'&&!event.defaultPrevented&&mode==='relationships'&&drawerOpen&&!(event.target as HTMLElement).closest('input,textarea,select')){event.preventDefault();closeDrawer();}
  }}>
    <details className="pr-review-overview"><summary>PR overview · {analysis.files.length} changed files</summary><div><p>{analysis.meta.title}</p><p>{analysis.files.filter(f=>f.status==='added').length} added · {analysis.files.filter(f=>['removed','deleted'].includes(f.status)).length} removed · {analysis.files.filter(f=>/\.(test|spec)\.|\/tests?\/|\/__tests__\//.test(f.path)).length} changed test files</p><p>Read a file’s change, follow its dependencies, then return to your place. Relationships reflect source references within the analyzed scope.</p></div></details>
    <div className="review-subject"><div className="review-navigation"><button className="icon-button" aria-label="Previous file" disabled={history.index===0} onClick={()=>visit(-1)}><ArrowLeft size={16}/></button><button className="icon-button" aria-label="Next visited file" disabled={history.index>=history.entries.length-1} onClick={()=>visit(1)}><ArrowRight size={16}/></button></div><div className="review-subject-file"><small>Reviewing file</small><strong>{file?.path.split('/').pop()||'No changed files'}</strong></div><span className="review-progress">{reviewedCount} / {analysis.files.length} reviewed</span>{file&&analysis.files.some(item=>item.path===file.path)&&<button className={`secondary-button ${reviewed.has(file.path)?'reviewed':''}`} onClick={markReviewed}><CheckCircle2 size={14}/>{reviewed.has(file.path)?'Mark unreviewed':'Mark reviewed'}</button>}<button className="secondary-button" disabled={reviewedCount===analysis.files.length} onClick={nextUnreviewed}>Next unreviewed file<ArrowRight size={13}/></button><ReviewDraftsButton/></div>
    {storageError&&<p className="review-storage-status" role="status">{storageError}</p>}
    {progressError&&<p className="review-storage-status" role="status">{progressError}</p>}
    <PanelWorkspace readingTarget={mode==='relationships'?'right':'center'} className={`file-review-workspace ${mode==='relationships'?'relationships-workspace':''}`}
      storageKey="flowreview:review-panel-widths:v2" rightLabel="reader" rightDefaultWidth={600} rightMinWidth={360}
      rightOpen={drawerOpen} onRightOpenChange={setDrawerOpen}
      left={<aside className="inventory-panel" aria-label="Changed files"><div className="panel-heading"><div><h2><FileCode2 size={16}/>Changed files</h2><span className="heading-sub">Choose a file to read its change</span></div><span className="count-badge">{analysis.files.length}</span></div><div className="inventory-search"><Search size={14}/><input aria-label="Search methods or files" placeholder="Find a file or method…" value={search} onChange={e=>setSearch(e.target.value)}/></div><label className="file-group-control">Group by<select aria-label="Group files by" value={groupBy} onChange={e=>setGroupBy(e.target.value as 'folder'|'layer')}><option value="folder">Folder</option><option value="layer">Layer</option></select></label><div className="inventory-content"><FileInventory analysis={analysis} search={search} expanded={expanded} selectedFile={file} selectedId={selectedId} showHelpers={showHelpers} onHelpers={setShowHelpers} onToggle={path=>setExpanded(previous=>{const next=new Set(previous);if(next.has(path))next.delete(path);else next.add(path);return next;})} onFile={item=>openFile(item.path)} onMethod={selectSymbol} reviewed={reviewed} groupBy={groupBy}/></div><div className="inventory-footer">{reviewedCount} of {analysis.files.length} files reviewed</div></aside>}
      center={file?<FileReader analysis={analysis} file={file} source={source.source} loading={source.loading} error={source.error} onRetry={source.retry} mode={mode} onMode={changeMode} view={view} onView={changeView} jump={jump} relationships={relationships} scrollPositions={scrollPositions.current}/>:<div className="reader-empty">No changed files in this comparison.</div>}
      right={mode==='relationships'&&file?<aside className="review-code-drawer" aria-label="Code drawer">
        <FileReader analysis={analysis} file={file} source={source.source} loading={source.loading} error={source.error} onRetry={source.retry}
          mode={readerMode} onMode={changeReaderMode} modes={['diff','source']} idPrefix="drawer-reader"
          view={view} onView={changeView} jump={jump} relationships={null} scrollPositions={scrollPositions.current}
          headingActions={<button className="icon-button" aria-label="Close code drawer" title="Close code drawer" onClick={closeDrawer}><X size={16}/></button>}/>
      </aside>:undefined}/>
  </div>;
}
