import { useEffect, useRef, useState } from 'react';
import type { Analysis, FileSource } from './types';

export default function useFileSource(analysis: Analysis, path: string) {
  const identity = `${analysis.meta.analysisId}:${path}`;
  const cache = useRef(new Map<string,FileSource>());
  const [state,setState] = useState<{key:string;source:FileSource|null;loading:boolean;error:string}>({key:'',source:null,loading:true,error:''});
  const [retry,setRetry] = useState(0);
  useEffect(()=>{
    const controller = new AbortController();
    const cached = cache.current.get(identity);
    if(cached){setState({key:identity,source:cached,loading:false,error:''});return;}
    if(!analysis.meta.analysisId){setState({key:identity,source:null,loading:false,error:'Reanalyze this comparison to load complete file snapshots.'});return;}
    setState({key:identity,source:null,loading:true,error:''});
    void (async()=>{
      try {
        const response=await fetch('/api/files/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({analysisId:analysis.meta.analysisId,path}),signal:controller.signal});
        const result=await response.json();
        if(!response.ok)throw new Error(result.error||'The file snapshot could not be read.');
        if(typeof result.path!=='string'||typeof result.diff!=='string'||(!result.base&&!result.head))throw new Error('The server returned an invalid file snapshot.');
        if(controller.signal.aborted)return;
        cache.current.set(identity,result);
        setState({key:identity,source:result,loading:false,error:''});
      } catch(reason) {
        if(!controller.signal.aborted)setState({key:identity,source:null,loading:false,error:reason instanceof Error?reason.message:'The file snapshot could not be read.'});
      }
    })();
    return ()=>controller.abort();
  },[analysis.meta.analysisId,identity,path,retry]);
  return {...(state.key===identity?state:{source:null,loading:true,error:''}),retry:()=>setRetry(n=>n+1)};
}
