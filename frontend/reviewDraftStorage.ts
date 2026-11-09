export type ReviewAnchor = { path:string; side:'base'|'head'; line:number; code:string };
export type ReviewDraft = ReviewAnchor & { id:string; body:string; replaces?:string };
export type DraftOrigin = { id:string; key:string; baseSha:string; headSha:string; draft:ReviewDraft };
export type ReviewFile = { path:string; previousPath:string|null; baseLines:number[]; headLines:number[] };
export type RefreshedDraft = { origin:DraftOrigin; status:'ready'|'needs_attention'; path:string; side:'base'|'head'; line:number; reason:string };
export type DraftRefresh = { baseSha:string; headSha:string; files:ReviewFile[]; comments:RefreshedDraft[] };
export type SubmissionPayload = { prUrl:string; baseSha:string; headSha:string; body:string; comments:{path:string;side:'base'|'head';line:number;body:string}[] };
export type PendingSubmission = { id:string; payload:SubmissionPayload; origins:DraftOrigin[]; summaryKey:string; summary:string };
export type DraftStorage = Pick<Storage,'length'|'key'|'getItem'>;
export type PendingWrites = Map<string,string|null>;
const sha = (value:unknown):value is string => typeof value==='string'&&/^[a-f0-9]{40}$/i.test(value);
export function parsed(value:string|null):unknown {try{return JSON.parse(value||'null');}catch{return null;}}
export function validDraft(value:unknown):value is ReviewDraft {
 if(!value||typeof value!=='object')return false;
 const d=value as ReviewDraft;
 return typeof d.id==='string'&&typeof d.body==='string'&&typeof d.path==='string'&&['base','head'].includes(d.side)&&Number.isInteger(d.line)&&d.line>0&&typeof d.code==='string'&&(d.replaces===undefined||typeof d.replaces==='string');
}
export function storageValue(storage:DraftStorage,key:string,pending:PendingWrites=new Map()):string|null {
 return pending.has(key)?pending.get(key)!:storage.getItem(key);
}
function storageKeys(storage:DraftStorage,pending:PendingWrites):string[] {
 const keys=new Set(pending.keys());
 for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key!==null)keys.add(key);}
 return [...keys];
}
// Versions stay at their original key. Replacement records and tombstones hide
// only an exact version, so simultaneous edits cannot overwrite each other.
export function readDraftVersions(storage:DraftStorage,key:string,pending:PendingWrites=new Map()):ReviewDraft[] {
 const legacy=parsed(storageValue(storage,key,pending));
 const versions=new Map<string,ReviewDraft>();const hidden=new Set<string>();
 if(Array.isArray(legacy))for(const draft of legacy)if(validDraft(draft))versions.set(draft.id,draft);
 for(const name of storageKeys(storage,pending)){
  if(name.startsWith(key+':deleted:')){if(storageValue(storage,name,pending)!==null)hidden.add(name.slice((key+':deleted:').length));continue;}
  if(!name.startsWith(key+':comment:'))continue;
  const draft=parsed(storageValue(storage,name,pending));
  if(validDraft(draft)){versions.set(draft.id,draft);if(draft.replaces)hidden.add(draft.replaces);}
 }
 return [...versions.values()].filter(draft=>!hidden.has(draft.id));
}
export function collectDraftOrigins(storage:DraftStorage,prefix:string,currentKey:string,pending:PendingWrites=new Map()):DraftOrigin[] {
 const roots=new Set<string>([currentKey]);
 for(const name of storageKeys(storage,pending)){
  if(!name.startsWith(prefix))continue;
  const match=name.slice(prefix.length).match(/^([a-f0-9]{40}):([a-f0-9]{40})(?::(?:comment|deleted):|:summary$|$)/i);
  if(match)roots.add(prefix+match[1]+':'+match[2]);
 }
 return [...roots].sort((a,b)=>a===currentKey?-1:b===currentKey?1:a.localeCompare(b)).flatMap(key=>{
  const parts=key.split(':');const baseSha=parts.at(-2)!;const headSha=parts.at(-1)!;
  return readDraftVersions(storage,key,pending).map(draft=>({id:JSON.stringify([key,draft.id]),key,baseSha,headSha,draft}));
 });
}
// Storage can be disabled while the tab is open. Reconcile pending versions
// against the last visible records without requiring another browser read.
export function reconcilePendingOrigins(origins:DraftOrigin[],prefix:string,currentKey:string,pending:PendingWrites):DraftOrigin[] {
 const records=new Map(origins.map(origin=>[origin.key+':comment:'+origin.draft.id,JSON.stringify(origin.draft)]));
 const keys=[...records.keys()];
 return collectDraftOrigins({length:keys.length,key:index=>keys[index]??null,getItem:name=>records.get(name)??null},prefix,currentKey,pending);
}
export function resolveDraftRefresh(value:unknown,origins:DraftOrigin[]):DraftRefresh {
 const fail=()=>{throw new Error('Draft refresh returned incomplete or invalid results. Your drafts are preserved.');};
 if(!value||typeof value!=='object')return fail();
 const result=value as {baseSha:unknown;headSha:unknown;files:unknown;comments:unknown};
 if(!sha(result.baseSha)||!sha(result.headSha)||!Array.isArray(result.files)||!Array.isArray(result.comments)||result.comments.length!==origins.length)return fail();
 const byId=new Map(origins.map(origin=>[origin.id,origin]));
 const seen=new Set<string>();
 const comments:RefreshedDraft[]=result.comments.map(item=>{
  if(!item||typeof item!=='object')return fail();
  const row=item as {id:string;status:string;path:string;side:'base'|'head';line:number;reason:string};
  const origin=byId.get(row.id);
  if(!origin||seen.has(row.id)||!['ready','needs_attention'].includes(row.status)||typeof row.path!=='string'||!['base','head'].includes(row.side)||!Number.isInteger(row.line)||row.line<1||typeof row.reason!=='string')return fail();
  seen.add(row.id);
  return {origin,status:row.status as RefreshedDraft['status'],path:row.path,side:row.side,line:row.line,reason:row.reason};
 });
 return {baseSha:result.baseSha,headSha:result.headSha,files:result.files as ReviewFile[],comments};
}
export function prepareDraftSubmission(refresh:DraftRefresh,activeOrigins:DraftOrigin[],prUrl:string,summary:string):{payload:SubmissionPayload;origins:DraftOrigin[];totalReady:number} {
 const active=new Set(activeOrigins.map(origin=>origin.id));
 const ready=refresh.comments.filter(comment=>comment.status==='ready'&&active.has(comment.origin.id));
 const payload:SubmissionPayload={prUrl,baseSha:refresh.baseSha,headSha:refresh.headSha,body:summary,comments:[]};
 const origins:DraftOrigin[]=[];const encoder=new TextEncoder();
 for(const comment of ready.slice(0,50)){
  payload.comments.push({path:comment.path,side:comment.side,line:comment.line,body:comment.origin.draft.body});
  if(encoder.encode(JSON.stringify(payload)).byteLength>65536){payload.comments.pop();break;}
  origins.push(comment.origin);
 }
 if(ready.length&&!origins.length)throw new Error('The summary and first ready comment exceed the local API request size. Shorten the summary or comment before submitting. Your drafts are preserved.');
 return {payload,origins,totalReady:ready.length};
}
export function submittedDraftTombstones(origins:DraftOrigin[]):[string,string][] {
 return origins.map(origin=>[origin.key+':deleted:'+origin.draft.id,'1']);
}
export function parsePendingSubmission(value:string|null,prefix:string):PendingSubmission|null {
 const candidate=parsed(value) as PendingSubmission|null;
 if(!candidate||typeof candidate!=='object'||typeof candidate.id!=='string'||!candidate.payload||typeof candidate.payload!=='object'||!Array.isArray(candidate.origins)||!candidate.origins.length||typeof candidate.summary!=='string'||typeof candidate.summaryKey!=='string'||!candidate.summaryKey.startsWith(prefix))return null;
 const {payload}=candidate;
 if(!sha(payload.baseSha)||!sha(payload.headSha)||typeof payload.prUrl!=='string'||typeof payload.body!=='string'||!Array.isArray(payload.comments)||payload.comments.length!==candidate.origins.length)return null;
 if(!payload.comments.every(c=>c&&typeof c.path==='string'&&['base','head'].includes(c.side)&&Number.isInteger(c.line)&&c.line>0&&typeof c.body==='string'))return null;
 if(!candidate.origins.every(o=>o&&typeof o.key==='string'&&o.key.startsWith(prefix)&&sha(o.baseSha)&&sha(o.headSha)&&o.key===prefix+o.baseSha+':'+o.headSha&&validDraft(o.draft)&&o.id===JSON.stringify([o.key,o.draft.id])))return null;
 return candidate;
}
