import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, ArrowUpRight, ChevronDown, Command, Files, GitBranch, GitPullRequest, Info, Layers3, LoaderCircle, Settings2, SlidersHorizontal, X } from 'lucide-react';
import { ReviewProvider } from './ReviewDrafts';
import ReviewWorkspace, { reviewIdentity } from './ReviewWorkspace';
import type { Analysis, Job } from './types';
import DesktopSetup from './DesktopSetup';
import {useDesktop} from './desktop';

const DEFAULT_PR = 'https://github.com/Rippling/rippling-webapp/pull/230710';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error(`The local API returned an unreadable response (${response.status}). ${window.desktop ? 'Restart the review engine from the app menu.' : 'Check that the backend is running on port 8765.'}`); }
  if (!response.ok) {
    const data = payload as { error?: string; message?: string };
    throw new Error(data.error || data.message || `Request failed (${response.status}).`);
  }
  return payload as T;
}

export default function App() {
  const [prUrl, setPrUrl] = useState(window.desktop ? '' : DEFAULT_PR);
  const desktop = useDesktop();
  const [repoPath, setRepoPath] = useState('');
  const [scope, setScope] = useState('');
  const [includeTests, setIncludeTests] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [formOpen, setFormOpen] = useState(true);
  const [health, setHealth] = useState<{ githubAuthenticated: boolean | null; githubMessage: string } | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisRevision,setAnalysisRevision] = useState(0);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    request<{ githubAuthenticated: boolean | null; githubMessage: string }>('/api/health', { signal: controller.signal }).then(setHealth).catch(reason => { if (reason.name !== 'AbortError') setHealthError(true); });
    return () => { controller.abort(); abort.current?.abort(); generation.current++; };
  }, []);

  const changed = useMemo(() => analysis?.nodes.filter(node => node.status !== 'unchanged') || [], [analysis]);
  const analyze = async (event: React.FormEvent) => {
    event.preventDefault();
    const current = ++generation.current;
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(''); setJob({ id: '', status: 'queued', stage: 'Starting analysis' });
    try {
      const body = { prUrl: prUrl.trim(), ...(repoPath.trim() ? { repoPath: repoPath.trim() } : {}), ...(scope.trim() ? { scope: scope.trim() } : {}), includeTests };
      const { jobId } = await request<{ jobId: string }>('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      while (generation.current === current) {
        const next = await request<Job>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal });
        if (generation.current !== current) return;
        setJob(next);
        if (next.status === 'error') throw new Error(next.error || 'Analysis failed. Check the repository, refs, and GitHub access.');
        if (next.status === 'complete') {
          if (!next.result) throw new Error('The analysis completed without returning a result.');
          const result = next.result;
          setAnalysis(result);
          setAnalysisRevision(revision=>revision+1);
          setFormOpen(false); setCoverageOpen(false);
          break;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, 1000);
          const onAbort = () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    } catch (reason) {
      if (generation.current === current && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : 'Unable to analyze this comparison.');
    } finally { if (generation.current === current) setBusy(false); }
  };

  return <ReviewProvider analysis={analysis}><div className="app-shell">
    <header className="app-header"><a className="brand" href="/" aria-label="Flow Review home"><span className="brand-mark"><GitBranch size={17} strokeWidth={2}/></span><span>flow<span className="brand-light">review</span></span></a></header>
    <DesktopSetup {...desktop}/>
    <main>
      {analysis && <div className="workspace-title"><div><h1>{analysis.meta.title}</h1><p><span className="mode-tag github"><GitPullRequest size={12}/>{`#${analysis.meta.number}`}</span><span className="repository-name">{analysis.meta.repository}</span>{analysis.meta.prUrl && <a className="text-link" href={analysis.meta.prUrl} target="_blank" rel="noreferrer">View on GitHub <ArrowUpRight size={12}/></a>}</p></div><button className="secondary-button compare-toggle" onClick={() => setFormOpen(value => !value)}><SlidersHorizontal size={14}/>{formOpen ? 'Hide comparison' : 'Change comparison'}<ChevronDown size={13} className={formOpen ? 'rotate' : ''}/></button></div>}
      {formOpen && <form className="analysis-form" onSubmit={analyze}>
        <div className="form-fields"><label className="url-field"><span>Pull request URL</span><div className="input-with-icon"><GitPullRequest size={16}/><input type="url" required value={prUrl} onChange={event => setPrUrl(event.target.value)} placeholder="https://github.com/owner/repository/pull/123" aria-label="Pull request URL"/></div></label>
          <button className="primary-button analyze-button" type="submit" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin"/> : <GitBranch size={15}/>} {busy ? 'Analyzing…' : 'Analyze flow'}{!busy && <ArrowRight size={15}/>}</button></div>
        <div className="form-bottomline"><button type="button" className="advanced-toggle" onClick={() => setAdvanced(value => !value)}><Settings2 size={13}/>Advanced options<ChevronDown size={12} className={advanced ? 'rotate' : ''}/></button>{healthError && <span className="auth-state warning"><AlertCircle size={12}/>Local API unavailable</span>}</div>
        {advanced && <div className="advanced-options"><label><span>Local checkout path <em>optional</em></span><div className="repository-input"><input value={repoPath} onChange={event => setRepoPath(event.target.value)} placeholder={window.desktop?'Use an existing checkout or leave blank':'Auto-discover a matching checkout'}/>{window.desktop && <button className="secondary-button" type="button" onClick={()=>{window.desktop!.selectRepository().then(selected=>{if(selected)setRepoPath(selected);}).catch(()=>setError('The repository picker could not open. Enter the path manually or try again.'));}}>Browse…</button>}</div></label><label><span>Analysis scope <em>optional</em></span><input value={scope} onChange={event => setScope(event.target.value)} placeholder="e.g. app/pension_management"/></label><label className="checkbox-label"><input type="checkbox" checked={includeTests} onChange={event => setIncludeTests(event.target.checked)}/><span>Include test files</span></label></div>}
        {health?.githubAuthenticated === false && <div className="auth-help"><AlertCircle size={13}/><span>{health.githubMessage} Use <code>gh auth login</code> in your terminal, then analyze again.</span></div>}
      </form>}
      {busy && <div className="progress-banner" role="status" aria-live="polite"><LoaderCircle size={18} className="spin" /><div><strong>{job?.stage || 'Starting analysis'}</strong></div></div>}
      {error && <div className="error-banner" role="alert"><AlertCircle size={18} /><div><strong>Analysis could not finish</strong><p>{error}</p>{analysis && <small>The previous comparison remains visible below.</small>}</div><button className="icon-button" title="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
      {analysis && <section className="analysis-meta" aria-label="Analysis provenance"><div className="meta-summary"><span><Files size={14} /><strong>{analysis.meta.changedFiles}</strong> changed files</span><span><Command size={14} /><strong>{changed.length}</strong> changed methods</span><span><Layers3 size={14} /><strong>{analysis.meta.indexedFiles}</strong> indexed files</span></div><div className="snapshot-pair" title={`Before: ${analysis.meta.baseRef} (${analysis.meta.baseSha})\nAfter: ${analysis.meta.headRef} (${analysis.meta.headSha})`}><span>BEFORE <code>{analysis.meta.baseSha.slice(0, 7)}</code></span><ArrowRight size={12} /><span>AFTER <code>{analysis.meta.headSha.slice(0, 7)}</code></span></div><button className={`coverage-button ${analysis.warnings.length ? 'has-warning' : ''}`} onClick={() => setCoverageOpen(value => !value)}><Info size={13} />{analysis.meta.limited ? 'Limited scope' : 'Analysis scope'}{analysis.warnings.length > 0 && <span>{analysis.warnings.length}</span>}<ChevronDown size={12} className={coverageOpen ? 'rotate' : ''} /></button></section>}
      {analysis && coverageOpen && <div className="coverage-details"><div><h3>Coverage and limits</h3><p>This graph shows statically resolved source relationships within the indexed scope. Callers outside this scope are not included; dynamic dispatch and runtime behavior may differ.</p><div className="scope-chips">{analysis.meta.scopes.map(item => <code key={item}>{item || '(repository root)'}</code>)}</div><span className="coverage-footnote">{analysis.meta.includeTests ? 'Tests included' : 'Test files excluded'} · Analyzed {new Date(analysis.meta.analyzedAt).toLocaleString()}</span></div>{analysis.warnings.length > 0 && <div className="analysis-warnings"><h4><AlertCircle size={14} />Analysis warnings</h4>{analysis.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}</div>}
      {analysis && <ReviewWorkspace key={`${reviewIdentity(analysis)}:${analysisRevision}`} analysis={analysis} busy={busy}/>}
    </main>
  </div></ReviewProvider>;
}
