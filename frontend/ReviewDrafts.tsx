import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, LoaderCircle, MessageSquare, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import type { Analysis } from './types';
import { collectDraftOrigins, parsePendingSubmission, prepareDraftSubmission, reconcilePendingOrigins, resolveDraftRefresh, storageValue, submittedDraftTombstones,
 type DraftOrigin, type DraftRefresh, type PendingSubmission, type PendingWrites, type ReviewAnchor as Anchor,
 type ReviewDraft as Draft, type ReviewFile } from './reviewDraftStorage';

type ReviewContext={files:ReviewFile[]};
type Session={drafts:Draft[];olderCount:number;context:ReviewContext|null;contextError:string;loading:boolean;retryContext:()=>void;open:(anchor:Anchor)=>void;showQueue:()=>void;github:boolean};
const ReviewContext=createContext<Session|null>(null);
const identity=(analysis:Analysis|null)=>analysis?`${analysis.meta.repository}:${analysis.meta.number}:${analysis.meta.baseSha}:${analysis.meta.headSha}`:'none';
function savedValue(key:string){try{return localStorage.getItem(key)||'';}catch{return '';}}
function storedOrigins(prefix:string,key:string):DraftOrigin[]{try{return collectDraftOrigins(localStorage,prefix,key);}catch{return [];}}
class ReviewRequestError extends Error {
 constructor(message:string,readonly definiteRejection=false){super(message);}
}
async function post<T>(path:string,body:unknown,signal?:AbortSignal):Promise<T>{
 const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
 let data;try{data=await response.json();}catch{throw new ReviewRequestError('The local review API did not return a response. Your drafts are preserved.');}
 if(!response.ok)throw new ReviewRequestError(data.error||`Review request failed (${response.status}). Your drafts are preserved.`,data.ambiguous===false);
 return data as T;
}
function Modal({label,children,onClose,blocked=false}:{label:string;children:ReactNode;onClose:()=>void;blocked?:boolean}){
 const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();},[]);
 return <dialog className="review-dialog" aria-label={label} ref={ref} onCancel={e=>{e.preventDefault();if(!blocked)onClose();}}>{children}</dialog>;
}
export function ReviewProvider({analysis,children}:{analysis:Analysis|null;children:ReactNode}){
 return <ReviewSession key={identity(analysis)} analysis={analysis}>{children}</ReviewSession>;
}
function ReviewSession({analysis,children}:{analysis:Analysis|null;children:ReactNode}) {
 const key=`flowreview:drafts:${identity(analysis)}`;
 const prefix=analysis?`flowreview:drafts:${analysis.meta.repository}:${analysis.meta.number}:`:'flowreview:drafts:none:';
 const submissionKey=prefix+'pending-submit';
 const github=analysis?.meta.mode==='github'&&!!analysis.meta.prUrl;
 const [origins,setOrigins]=useState<DraftOrigin[]>(()=>storedOrigins(prefix,key));const originsRef=useRef(origins);
 const pending=useRef<PendingWrites>(new Map());
 const [context,setContext]=useState<ReviewContext|null>(null);const [loading,setLoading]=useState(false);const [contextError,setContextError]=useState('');const [retry,setRetry]=useState(0);const [storageError,setStorageError]=useState('');
 const [editor,setEditor]=useState<{anchor:Anchor;body:string;origin?:DraftOrigin;returnToQueue?:boolean}|null>(null);
 const [queue,setQueue]=useState(false);const [summary,setSummary]=useState(()=>savedValue(key+':summary'));
 const [busy,setBusy]=useState(false);const busyRef=useRef(false);const [error,setError]=useState('');const [success,setSuccess]=useState<string|null>(null);
 const [validation,setValidation]=useState<DraftRefresh|null>(null);const [refreshing,setRefreshing]=useState(false);const [refreshError,setRefreshError]=useState('');const refreshGeneration=useRef(0);
 const [hasRecovery,setHasRecovery]=useState(()=>!!savedValue(submissionKey));
 const drafts=origins.filter(origin=>origin.key===key).map(origin=>origin.draft);
 const olderCount=origins.length-drafts.length;
 const snapshots={prUrl:analysis?.meta.prUrl,baseSha:analysis?.meta.baseSha,headSha:analysis?.meta.headSha};
 const signature=origins.map(origin=>origin.id).sort().join('\n');
 const checked=new Map(validation?.comments.map(comment=>[comment.origin.id,comment])||[]);
 const readyCount=origins.filter(origin=>checked.get(origin.id)?.status==='ready').length;
 const attentionCount=origins.filter(origin=>checked.get(origin.id)?.status==='needs_attention').length;
 let batchCount=0,batchError='';
 if(validation)try{batchCount=prepareDraftSubmission(validation,origins,analysis?.meta.prUrl||'',summary).origins.length;}catch(reason){batchError=reason instanceof Error?reason.message:'The review request is too large.';}
 function refreshDrafts(){
  try{const latest=collectDraftOrigins(localStorage,prefix,key,pending.current);originsRef.current=latest;setOrigins(latest);setHasRecovery(!!storageValue(localStorage,submissionKey,pending.current));return latest;}
  catch{setStorageError('Browser storage is unavailable. Keep this tab open or copy your drafts before leaving.');const latest=reconcilePendingOrigins(originsRef.current,prefix,key,pending.current);originsRef.current=latest;setOrigins(latest);return latest;}
 }
 function writeRecord(name:string,value:string|null):boolean {
  pending.current.set(name,value);
  try{if(value===null)localStorage.removeItem(name);else localStorage.setItem(name,value);pending.current.delete(name);if(!pending.current.size)setStorageError('');return true;}
  catch{setStorageError('Browser storage is unavailable. Keep this tab open or copy your drafts before leaving.');return false;}
 }
 function writeSummary(value:string){setSummary(value);writeRecord(key+':summary',value);}
 function currentSummary(){try{return storageValue(localStorage,key+':summary',pending.current)??'';}catch{return summary;}}
 useEffect(()=>{
  function reconcile(event:StorageEvent){if(event.key!==null&&!event.key.startsWith(prefix))return;refreshDrafts();try{setSummary(storageValue(localStorage,key+':summary',pending.current)??'');}catch{/* Keep the current summary when storage is unavailable. */}}
  window.addEventListener('storage',reconcile);return()=>window.removeEventListener('storage',reconcile);
 },[key,prefix]);
 useEffect(()=>{
  if(!github)return;const controller=new AbortController();setContext(null);setContextError('');setLoading(true);
  post<ReviewContext>('/api/reviews/context',snapshots,controller.signal).then(result=>{if(!controller.signal.aborted)setContext(result);}).catch(reason=>{if(!controller.signal.aborted)setContextError(reason.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[github,analysis,retry]);
 async function refreshLatest(items:DraftOrigin[],signal?:AbortSignal){
  const generation=++refreshGeneration.current;setRefreshing(true);setRefreshError('');
  try{
   const response=await post<unknown>('/api/reviews/refresh',{...snapshots,comments:items.map(origin=>({id:origin.id,path:origin.draft.path,side:origin.draft.side,line:origin.draft.line,baseSha:origin.baseSha,headSha:origin.headSha}))},signal);
   const result=resolveDraftRefresh(response,items);
   if(generation===refreshGeneration.current&&!signal?.aborted)setValidation(result);
   return result;
  }catch(reason){
   if(generation===refreshGeneration.current&&!signal?.aborted){setValidation(null);setRefreshError(reason instanceof Error?reason.message:'Could not check the latest commits. Your drafts are preserved.');}
   throw reason;
  }finally{if(generation===refreshGeneration.current&&!signal?.aborted)setRefreshing(false);}
 }
 useEffect(()=>{
  if(!queue||!github||busy)return;
  const controller=new AbortController();void refreshLatest(originsRef.current,controller.signal).catch(()=>{});
  return()=>{controller.abort();++refreshGeneration.current;};
 },[queue,signature,github,busy]);
 function showQueue(){refreshDrafts();setError('');setQueue(true);}
 function open(anchor:Anchor){
  const existing=refreshDrafts().find(origin=>origin.key===key&&origin.draft.path===anchor.path&&origin.draft.side===anchor.side&&origin.draft.line===anchor.line);
  setEditor({anchor,body:existing?.draft.body||'',origin:existing});
 }
 function save(){
  if(!editor||!editor.body.trim())return;
  const draft:Draft={...editor.anchor,id:crypto.randomUUID(),body:editor.body,...(editor.origin?{replaces:editor.origin.draft.id}:{})};
  writeRecord((editor.origin?.key||key)+':comment:'+draft.id,JSON.stringify(draft));refreshDrafts();
  setQueue(!!editor.returnToQueue);setEditor(null);setSuccess(null);
 }
 function remove(origin:DraftOrigin){writeRecord(origin.key+':deleted:'+origin.draft.id,'1');refreshDrafts();}
 function recovery(){
  const raw=storageValue(localStorage,submissionKey,pending.current);const saved=parsePendingSubmission(raw,prefix);
  if(raw&&!saved)throw new Error('Saved review recovery details are unreadable. Check the PR on GitHub before submitting again. Your drafts are preserved.');
  return saved;
 }
 function forgetSubmission(attempt:PendingSubmission){
  if(recovery()?.id===attempt.id)writeRecord(submissionKey,null);
  refreshDrafts();
 }
 function finishSubmission(attempt:PendingSubmission,url:string){
  let persisted=true;
  for(const [name,value] of submittedDraftTombstones(attempt.origins))if(!writeRecord(name,value))persisted=false;
  const remaining=refreshDrafts();
  // Keep summaries for attention drafts and concurrent edits; clear only the
  // unchanged summary of a completely submitted queue.
  if(!remaining.length){
   try{if(storageValue(localStorage,attempt.summaryKey,pending.current)===attempt.summary){if(!writeRecord(attempt.summaryKey,''))persisted=false;if(attempt.summaryKey===key+':summary')setSummary('');}}
   catch{persisted=false;}
  }
  if(persisted)forgetSubmission(attempt);
  setSuccess(url);
 }
 async function sendReview(){
  let attempt:PendingSubmission|null=null;
  try{
   attempt=recovery();
   if(!attempt){
    const refreshed=await refreshLatest(refreshDrafts());
    // A different tab may have replaced or deleted a version while GitHub was
    // being read. Only still-active versions from this check can be sent.
    const submittedSummary=currentSummary();
    const batch=prepareDraftSubmission(refreshed,refreshDrafts(),analysis!.meta.prUrl!,submittedSummary);
    if(!batch.origins.length){setError('No comments are ready to submit. Review the comments that need attention.');return;}
    attempt={id:crypto.randomUUID(),payload:batch.payload,origins:batch.origins,summaryKey:key+':summary',summary:submittedSummary};
    // Persist before the write request, so a lost response or reload can replay
    // the exact backend receipt instead of publishing a new batch on new SHAs.
   }
   if(!writeRecord(submissionKey,JSON.stringify(attempt)))throw new Error('Browser storage could not save review recovery details. Your drafts are preserved; restore browser storage before submitting.');
   setHasRecovery(true);
   const result=await post<{url:string}>('/api/reviews/submit',attempt.payload);
   finishSubmission(attempt,result.url);
  }catch(reason){
   if(attempt&&reason instanceof ReviewRequestError&&reason.definiteRejection)forgetSubmission(attempt);
   setError(reason instanceof Error?reason.message:'Review submission failed. Your drafts are preserved.');
  }
 }
 async function submit(){
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');
  try{
   // Web Locks serialize explicit submission/recovery across tabs for this PR.
   if(navigator.locks)await navigator.locks.request(submissionKey,sendReview);else await sendReview();
  }finally{busyRef.current=false;setBusy(false);}
 }
 const contextWarning=/new commits|comparison base changed|reanalyze/i.test(contextError)?'The displayed snapshot is no longer current. Open Review drafts to check saved comments against the latest commits. Reanalyze to add new comments.':contextError;
 const olderSummaries=[...new Set(origins.filter(origin=>origin.key!==key).map(origin=>origin.key))].map(originKey=>({key:originKey,text:savedValue(originKey+':summary')})).filter(item=>item.text);
 return <ReviewContext.Provider value={{drafts,olderCount,context,contextError:contextWarning,loading,retryContext:()=>setRetry(value=>value+1),open,showQueue,github}}>{children}
  {editor&&<Modal label="Draft comment" onClose={()=>setEditor(null)}><div className="review-dialog-heading"><div><h2>Draft comment</h2><p>{editor.anchor.side==='head'?'After':'Before'} · line {editor.anchor.line}</p></div><button className="icon-button" title="Close comment" onClick={()=>setEditor(null)}><X size={17}/></button></div><div className="comment-anchor"><code>{editor.anchor.path}</code><pre>{editor.anchor.code}</pre></div><label className="comment-label">Comment text<textarea autoFocus aria-label="Comment text" value={editor.body} maxLength={10000} onChange={e=>setEditor({...editor,body:e.target.value})} placeholder="Leave a question or suggestion. Markdown is supported." rows={6}/></label><p className="draft-privacy">Saved locally until you submit your review to GitHub.</p><div className="review-dialog-actions"><button className="secondary-button" onClick={()=>setEditor(null)}>Cancel</button><button className="primary-button" disabled={!editor.body.trim()} onClick={save}><MessageSquare size={14}/>Save draft</button></div></Modal>}
  {queue&&<Modal label="Review drafts" onClose={()=>setQueue(false)} blocked={busy}>
   <div className="review-dialog-heading"><div><h2>Review drafts</h2><p>{analysis?.meta.repository} · PR #{analysis?.meta.number}{validation&&` · latest snapshot ${validation.headSha.slice(0,7)}`}</p></div><button className="icon-button" disabled={busy} title="Close review drafts" onClick={()=>setQueue(false)}><X size={17}/></button></div>
   {storageError&&<p className="review-error" role="alert">{storageError}</p>}
   {success&&<p className="review-success" role="status">Review submitted. <a href={success} target="_blank" rel="noreferrer">View on GitHub <ExternalLink size={12}/></a></p>}
   {hasRecovery&&<p className="draft-privacy">A previous submission needs confirmation. Submit again to recover its saved result before sending new comments.</p>}
   {refreshing?<p className="draft-privacy" role="status"><LoaderCircle className="spin" size={13}/> Checking drafts against latest commits…</p>:validation&&origins.length>0&&<p className="draft-privacy">{readyCount} ready · {attentionCount} {attentionCount===1?'needs':'need'} attention. Unchanged files carry forward automatically.</p>}
   {refreshError&&<p className="review-error" role="alert">{refreshError}</p>}
   <div className="draft-list">{origins.length?origins.map(origin=>{
    const draft=origin.draft;const result=checked.get(origin.id);const ready=result?.status==='ready';
    return <article className="draft-item" data-origin-id={origin.id} data-status={result?.status||'unchecked'} key={origin.id}>
     <div className="draft-item-heading"><span><code>{ready?result.path:draft.path}</code><small>{draft.side==='head'?'After':'Before'} · line {ready?result.line:draft.line} · saved on {origin.headSha.slice(0,7)}</small></span><button className="icon-button" title="Edit draft" disabled={busy} onClick={()=>{setQueue(false);setEditor({anchor:draft,body:draft.body,origin,returnToQueue:true});}}><Pencil size={14}/></button><button className="icon-button" title="Delete draft" disabled={busy} onClick={()=>remove(origin)}><Trash2 size={14}/></button></div>
     <p className={ready?'draft-status-ready':'draft-status-attention'}><strong>{result?(ready?'Ready':'Needs attention'):refreshing?'Checking…':'Not checked'}</strong>{result?.reason&&` · ${result.reason}`}</p><pre className="draft-code">{draft.code}</pre><p>{draft.body}</p>
    </article>;
   }):<p className="inline-empty">No draft comments. Use + beside a line in the inspector.</p>}</div>
   {olderSummaries.length>0&&<details className="older-drafts"><summary>Summaries from earlier snapshots</summary>{olderSummaries.map(item=><div key={item.key}><h3>Snapshot {item.key.split(':').at(-1)!.slice(0,7)}</h3><p>{item.text}</p></div>)}</details>}
   {(origins.length>0||hasRecovery)&&<><label className="comment-label">Review summary <small>optional</small><textarea aria-label="Review summary" value={summary} disabled={busy} maxLength={10000} onChange={e=>writeSummary(e.target.value)} rows={3}/></label><p className="draft-privacy">Submit sends ready comments to GitHub as one review. Comments that need attention stay saved locally. GitHub repository write access is required.</p></>}
   {batchError&&<p className="review-error" role="alert">{batchError}</p>}
   {!batchError&&batchCount>0&&batchCount<readyCount&&<p className="draft-privacy">This review sends {batchCount} of {readyCount} ready comments. The rest stay saved for another explicit submission.</p>}
   {error&&<p className="review-error" role="alert">{error}</p>}
   <div className="review-dialog-actions"><button className="secondary-button" disabled={busy} onClick={()=>setQueue(false)}>Keep reading</button><button className="secondary-button" disabled={busy||refreshing||!github} onClick={()=>void refreshLatest(refreshDrafts()).catch(()=>{})}>Refresh drafts</button><button className="primary-button" disabled={busy||(!hasRecovery&&refreshing)||(!origins.length&&!hasRecovery)||!github||(!hasRecovery&&(!validation||batchCount===0||!!batchError))} onClick={()=>void submit()}>{busy?<LoaderCircle className="spin" size={14}/>:<Send size={14}/>} {busy?(refreshing?'Checking latest…':hasRecovery?'Confirming review…':'Submitting…'):hasRecovery?'Confirm previous submission':batchCount<readyCount?`Submit ${batchCount} ready ${batchCount===1?'comment':'comments'}`:attentionCount?'Submit ready comments':'Submit review'}</button></div>
  </Modal>}
 </ReviewContext.Provider>;
}
export function ReviewDraftsButton(){const session=useContext(ReviewContext);if(!session)return null;return <div className="review-drafts-toolbar"><button className="review-drafts-button" disabled={!session.github} title={session.github?'Preview your draft review':'Draft GitHub comments are available for GitHub PRs'} onClick={session.showQueue}><MessageSquare size={14}/>Review drafts ({session.drafts.length+session.olderCount})</button>{session.loading?<small><LoaderCircle className="spin" size={11}/>Loading review lines…</small>:session.contextError&&<small className="review-context-error" title={session.contextError}>{session.contextError} <button className="secondary-button" onClick={session.retryContext}>Retry review lines</button></small>}</div>;}
export function CommentLine({path,side,line,text}:{path:string;side:'base'|'head';line:number;text:string}){const session=useContext(ReviewContext);if(!session?.github)return null;const file=session.context?.files.find(f=>(side==='base'?f.previousPath||f.path:f.path)===path);const eligible=file?.[side==='base'?'baseLines':'headLines'].includes(line)||false;const draft=session.drafts.find(d=>d.path===path&&d.side===side&&d.line===line);return <button className={`line-comment-button ${draft?'has-draft':''}`} aria-label={eligible?`Comment on ${side==='head'?'After':'Before'} line ${line}`:`Line ${line} is outside the PR diff`} disabled={!eligible} title={session.loading?'Loading review lines…':session.contextError||(!eligible?'Outside the PR diff; GitHub inline comments require a line in the diff.':draft?'Edit draft comment':'Add draft review comment')} onClick={()=>session.open({path,side,line,code:text})}>{draft?<MessageSquare size={12}/>:<Plus size={12}/>}</button>;}
