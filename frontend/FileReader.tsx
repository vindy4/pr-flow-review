import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Copy, FileCode2, LoaderCircle, Search } from 'lucide-react';
import { CodeView, DiffView, SnapshotLink } from './Inspector';
import { diffRows, findTextMatches, sourceRows, type ReaderSearch, type TextMatch } from './readerModel';
import type { Analysis, ChangedFile, FileSource, View } from './types';

export type ReaderMode = 'diff'|'source'|'relationships';
export type SourceJump = {line:number;serial:number};
const modeNames:Record<ReaderMode,string>={diff:'Diff',source:'Full file',relationships:'Relationships'};

export default function FileReader({analysis,file,source,loading,error,onRetry,mode,onMode,view,onView,jump,relationships,
  modes=['diff','source','relationships'],idPrefix='reader',headingActions,scrollPositions}: {
  analysis:Analysis;file:ChangedFile;source:FileSource|null;loading:boolean;error:string;onRetry:()=>void;
  mode:ReaderMode;onMode:(mode:ReaderMode)=>void;view:View;onView:(view:View)=>void;jump:SourceJump|null;relationships:ReactNode;
  modes?:ReaderMode[];idPrefix?:string;headingActions?:ReactNode;scrollPositions?:Map<string,{top:number;left:number}>;
}) {
  const scroll=useRef<HTMLDivElement>(null);
  const positions=useRef(new Map<string,{top:number;left:number}>());
  const positionMap=scrollPositions||positions.current;
  const contentId=idPrefix==='reader'?'file-reader-content':`${idPrefix}-content`;
  const [queryState,setQueryState]=useState({key:'',value:''});
  const [selection,setSelection]=useState({key:'',query:'',index:0,revision:0});
  const [copyStatus,setCopyStatus]=useState('');
  const [wrap,setWrap]=useState(true);
  const activeSide=view==='base'?'base':'head';
  const version=source?.[activeSide]||null;
  const positionKey=`${file.path}:${mode}:${view}`;
  const searchKey=`${file.path}:${mode}:${mode==='source'?activeSide:'both'}`;
  const query=queryState.key===searchKey?queryState.value:'';
  const rows=useMemo(()=>!source?[]:mode==='diff'?diffRows(source.diff):mode==='source'&&version?sourceRows(version.code,1,activeSide):[],[source,mode,version,activeSide]);
  const matches=useMemo(()=>findTextMatches(rows,query),[rows,query]);
  const index=matches.length?(selection.key===searchKey&&selection.query===query?selection.index%matches.length:0):0;
  const activeMatch=matches[index];
  const search:ReaderSearch=useMemo(()=>{
    const byRow=new Map<string,TextMatch[]>();
    for(const match of matches)byRow.set(match.rowId,[...(byRow.get(match.rowId)||[]),match]);
    return {byRow,activeId:activeMatch?.id};
  },[matches,activeMatch?.id]);
  const searchResult=query.trim()?(matches.length?`${index+1} of ${matches.length}`:'No matches'):'';
  const lastJump=useRef('');
  useEffect(()=>{setQueryState({key:searchKey,value:''});setCopyStatus('');},[searchKey]);
  useLayoutEffect(()=>{if(jump?.serial)setQueryState({key:searchKey,value:''});},[jump?.serial]);

  useLayoutEffect(()=>{
    const element=scroll.current;
    if(!element||loading)return;
    const position=positionMap.get(positionKey);
    element.scrollTop=position?.top||0;element.scrollLeft=position?.left||0;
  },[positionKey,loading]);
  useLayoutEffect(()=>{
    const element=scroll.current;
    if(!element||loading||mode!=='source'||!jump?.line||query.trim())return;
    const key=`${file.path}:${jump.serial}:${jump.line}`;
    if(lastJump.current===key)return;
    const line=element.querySelector<HTMLElement>(`[data-source-line="${jump.line}"]`);
    if(line){element.scrollTop=Math.max(0,element.scrollTop+line.getBoundingClientRect().top-element.getBoundingClientRect().top-60);lastJump.current=key;}
  },[file.path,mode,loading,jump?.line,jump?.serial,query]);
  useLayoutEffect(()=>{
    const element=scroll.current;
    const target=element?.querySelector<HTMLElement>('.active-search-match');
    if(!element||!target||loading)return;
    const bounds=element.getBoundingClientRect(),match=target.getBoundingClientRect();
    element.scrollTop=Math.max(0,element.scrollTop+match.top-bounds.top-Math.max(24,(element.clientHeight-Math.min(match.height,element.clientHeight))/3));
    if(match.left<bounds.left+116)element.scrollLeft=Math.max(0,element.scrollLeft+match.left-bounds.left-132);
    else if(match.right>bounds.right-16)element.scrollLeft+=match.right-bounds.right+16;
    // The reader can extend below the browser window, especially on narrow screens.
    target.scrollIntoView({block:'nearest',inline:'nearest'});
  },[activeMatch?.id,query,searchKey,loading,wrap,selection.revision]);

  function findNext(direction=1) {
    if(!matches.length)return;
    setSelection(previous=>({key:searchKey,query,index:(index+direction+matches.length)%matches.length,revision:previous.revision+1}));
  }
  function nextChange(direction:number) {
    const element=scroll.current;if(!element)return;
    const hunks=[...element.querySelectorAll<HTMLElement>('.diff-hunk')];
    if(!hunks.length)return;
    const current=element.scrollTop;
    const offsets=hunks.map(h=>element.scrollTop+h.getBoundingClientRect().top-element.getBoundingClientRect().top);
    const next=direction>0?offsets.find(offset=>offset>current+20):[...offsets].reverse().find(offset=>offset<current-20);
    element.scrollTop=next??(direction>0?offsets[0]:offsets.at(-1)!);
  }
  return <section className="file-reader" aria-label="File reader">
    <div className="file-reader-heading"><div><h2><FileCode2 size={17}/>{file.path.split('/').pop()}</h2><p>{file.path}</p></div><span className={`status-pill ${file.status}`}>{file.status.replace('_',' + ')}</span>{headingActions&&<div className="file-reader-heading-actions">{headingActions}</div>}</div>
    {file.previousPath&&<p className="reader-rename">Moved from {file.previousPath}</p>}
    <div className="review-reader-tabs" role="tablist" aria-label="File view">{modes.map(value=><button key={value} id={`${idPrefix}-tab-${value}`} role="tab" aria-selected={mode===value} aria-controls={contentId} className={mode===value?'active':''} onClick={()=>onMode(value)} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const next=modes[(modes.indexOf(value)+(event.key==='ArrowRight'?1:modes.length-1))%modes.length];onMode(next);document.getElementById(`${idPrefix}-tab-${next}`)?.focus();}}}>{modeNames[value]}</button>)}</div>
    <div id={contentId} className="reader-content" role="tabpanel" aria-labelledby={`${idPrefix}-tab-${mode}`}>
      {mode==='relationships'?relationships:<>
        <div className="file-reader-toolbar">{mode==='source'?<div className="segmented source-switch"><button className={activeSide==='base'?'active':''} onClick={()=>onView('base')}>Before</button><button className={activeSide==='head'?'active':''} onClick={()=>onView('head')}>After</button></div>:<><span>Changes</span><div><button className="icon-button" aria-label="Previous change" onClick={()=>nextChange(-1)}><ArrowUp size={14}/></button><button className="icon-button" aria-label="Next change" onClick={()=>nextChange(1)}><ArrowDown size={14}/></button></div></>}
          <div className="source-actions"><label className="reader-wrap-control"><input type="checkbox" aria-label="Wrap long lines" checked={wrap} onChange={event=>setWrap(event.target.checked)}/>Wrap lines</label><SnapshotLink analysis={analysis} path={version?.path||(activeSide==='base'?file.previousPath||file.path:file.path)} side={activeSide}/>{mode==='source'&&version&&<button className="icon-button" aria-label="Copy full file" onClick={()=>void navigator.clipboard.writeText(version.code).then(()=>setCopyStatus('Copied')).catch(()=>setCopyStatus('Copy unavailable'))}><Copy size={14}/></button>}<span role="status">{copyStatus}</span></div>
        </div>
        <form className="file-find" onSubmit={e=>{e.preventDefault();findNext();}}><Search size={13}/><input aria-label="Find in file" placeholder={mode==='diff'?'Find in diff…':'Find in file…'} value={query} onChange={e=>setQueryState({key:searchKey,value:e.target.value})} onKeyDown={event=>{if(event.key==='Enter'&&event.shiftKey){event.preventDefault();findNext(-1);}else if(event.key==='Escape'){event.preventDefault();setQueryState({key:searchKey,value:''});}}}/><span role="status" aria-live="polite">{searchResult}</span><button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={()=>findNext(-1)}><ArrowUp size={13}/></button><button type="submit" disabled={!matches.length} title="Next match (Enter)">Find next<ArrowDown size={13}/></button></form>
        <div ref={scroll} className={`file-code-scroll ${wrap?'wrap-lines':''}`} onScroll={e=>positionMap.set(positionKey,{top:e.currentTarget.scrollTop,left:e.currentTarget.scrollLeft})}>
          {loading?<div className="reader-empty" role="status"><LoaderCircle size={21} className="spin"/>Loading complete file…</div>:error?<div className="reader-empty" role="alert"><p>{error}</p><button className="secondary-button" onClick={onRetry}>Retry file</button><SnapshotLink analysis={analysis} path={file.path} side={activeSide}/></div>:source?mode==='diff'?(source.diff?<DiffView diff={source.diff} baseStart={1} headStart={1} basePath={source.base?.path||file.previousPath||file.path} headPath={source.head?.path||file.path} search={search} label="File diff"/>:<div className="reader-empty"><strong>No textual changes in this file.</strong><p>This file provides context for the PR.</p><button className="secondary-button" onClick={()=>onMode('source')}>Read full file</button></div>):version?<CodeView code={version.code} startLine={1} highlightLine={query.trim()?undefined:jump?.line} review={{path:version.path,side:activeSide}} search={search}/>:<div className="reader-empty"><strong>File absent {activeSide==='base'?'before':'after'} this change.</strong><button className="secondary-button" onClick={()=>onView(activeSide==='base'?'head':'base')}>Read {activeSide==='base'?'After':'Before'} file</button></div>:null}
        </div>
      </>}
    </div>
  </section>;
}
