import {useEffect, useState} from 'react';

export type AuthState = {status:'checking'|'signed_out'|'signing_in'|'signed_in'|'error'; login?:string; code?:string; url?:string; message?:string};
export type RuntimeState = {status:'starting'|'ready'|'error'; message?:string};
export type DesktopBridge = {
  authStatus:()=>Promise<AuthState>; signIn:()=>Promise<AuthState>; cancelSignIn:()=>Promise<AuthState>;
  selectRepository:()=>Promise<string|null>; retry:()=>Promise<RuntimeState>; runtimeStatus:()=>Promise<RuntimeState>;
  showDiagnostics:()=>Promise<void>; onAuth:(callback:(state:AuthState)=>void)=>(()=>void);
  onRuntime:(callback:(state:RuntimeState)=>void)=>(()=>void);
};
declare global {interface Window {desktop?:DesktopBridge}}

export function useDesktop() {
  const [auth,setAuth]=useState<AuthState|null>(window.desktop?{status:'checking'}:null);
  const [runtime,setRuntime]=useState<RuntimeState|null>(null);
  useEffect(()=>{
    const bridge=window.desktop;if(!bridge)return;
    let alive=true;
    const offAuth=bridge.onAuth(state=>{if(alive)setAuth(state);});
    const offRuntime=bridge.onRuntime(state=>{if(alive)setRuntime(state);});
    bridge.authStatus().then(state=>{if(alive)setAuth(state);}).catch(()=>{if(alive)setAuth({status:'error',message:'Unable to check GitHub access. Try again.'});});
    bridge.runtimeStatus().then(state=>{if(alive)setRuntime(state);}).catch(()=>{});
    return ()=>{alive=false;offAuth();offRuntime();};
  },[]);
  return {auth,runtime};
}
