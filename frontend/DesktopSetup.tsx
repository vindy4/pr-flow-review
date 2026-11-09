import {useState} from 'react';
import {AlertCircle, CheckCircle2, Github, LoaderCircle} from 'lucide-react';
import type {AuthState, RuntimeState} from './desktop';
import './desktop.css';

export default function DesktopSetup({auth,runtime}:{auth:AuthState|null;runtime:RuntimeState|null}) {
  const [error,setError]=useState('');
  if(!auth)return null;
  const run=(action:()=>Promise<unknown>)=>{setError('');action().catch(()=>setError('The action could not finish. Please try again.'));};
  return <section className="desktop-setup" aria-label="Desktop connection">
    {runtime?.status==='error' && <div className="desktop-runtime-error" role="alert"><AlertCircle size={16}/><span>{runtime.message}</span><button type="button" onClick={()=>run(()=>window.desktop!.retry())}>Restart engine</button><button type="button" onClick={()=>run(()=>window.desktop!.showDiagnostics())}>Show log</button></div>}
    <div className={`desktop-auth ${auth.status}`}>
      {auth.status==='signed_in'?<CheckCircle2 size={15}/>:auth.status==='checking'||auth.status==='signing_in'?<LoaderCircle size={15} className="spin"/>:<Github size={16}/>}
      {auth.status==='signed_in'?<span>Connected as <strong>{auth.login}</strong></span>:
        auth.status==='checking'?<span>Checking GitHub access…</span>:
        auth.status==='signing_in'?<><span>{auth.code?<>Enter <strong className="device-code">{auth.code}</strong> on <a href={auth.url} target="_blank" rel="noreferrer">GitHub</a> to finish signing in.</>:'Starting GitHub sign-in…'}</span><button type="button" onClick={()=>run(()=>window.desktop!.cancelSignIn())}>Cancel</button></>:
        <><span>{auth.message||'Connect GitHub to review pull requests.'}</span><button type="button" onClick={()=>run(()=>window.desktop!.signIn())}>Sign in to GitHub</button><button type="button" onClick={()=>run(()=>window.desktop!.authStatus())}>Check again</button></>}
    </div>
    {auth.status!=='signed_in' && auth.status!=='checking' && <p className="desktop-auth-note">Uses GitHub CLI’s account and macOS Keychain. An existing GitHub CLI login is shared. Your organization may require SSO authorization.</p>}
    {error && <p className="desktop-action-error" role="alert">{error}</p>}
  </section>;
}
