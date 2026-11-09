export type Status = 'added' | 'modified' | 'removed' | 'unchanged' | 'moved' | 'moved_modified';
export type View = 'base' | 'overlay' | 'head';
export type Version = { startLine: number; endLine: number; code: string; signature: string };
export type FileSource = { path: string; base: { path: string; code: string; startLine: number } | null; head: { path: string; code: string; startLine: number } | null; diff: string };
export type Symbol = {
  id: string;
  path: string;
  basePath?: string | null;
  headPath?: string | null;
  baseId?: string;
  module: string;
  qualname: string;
  name: string;
  className: string | null;
  kind: 'function' | 'method' | 'component' | 'hook' | 'callback';
  language?: 'python' | 'javascript' | 'typescript';
  status: Status;
  base: Version | null;
  head: Version | null;
  diff: string;
  unresolvedCalls: { expression: string; line: number; reason: string }[];
};
export type CallEdge = {
  basePath?: string | null;
  headPath?: string | null;
  relation?: 'call' | 'render' | 'callback';
  id: string;
  source: string;
  target: string;
  expression: string;
  baseExpression?: string | null;
  headExpression?: string | null;
  line: number;
  baseLine: number | null;
  headLine: number | null;
  inBase: boolean;
  inHead: boolean;
  status: 'added' | 'removed' | 'unchanged';
  evidence: { path: string; line: number; side: 'base' | 'head'; expression: string };
};
export type ChangedFile = { path: string; previousPath?: string; status: string; changedMethods: number; indexed?: boolean };
export type Layer = { id: string; label: string; description: string };
export type ArchitectureEvidence = {
  path: string; line: number; expression: string; kind: string; reason: string;
  symbolId: string | null; targetSymbolId?: string | null; startLine: number; code: string;
};
export type FileVersion = {
  path: string; roles: string[]; layer: string; reason: string; indexed: boolean;
  facts: ArchitectureEvidence[]; operations: { id: string; label: string; kind: string; line: number }[];
};
export type ArchitectureFile = {
  id: string; path: string; label: string; status: Status;
  base: FileVersion | null; head: FileVersion | null; symbolIds: string[];
};
export type ArchitectureEdge = {
  id: string; source: string; target: string; relation: string;
  inBase: boolean; inHead: boolean; status: 'added' | 'removed' | 'unchanged';
  baseEvidence: ArchitectureEvidence[]; headEvidence: ArchitectureEvidence[];
};
export type Architecture = {
  layers: Layer[]; nodes: ArchitectureFile[]; edges: ArchitectureEdge[];
  features: { id: string; root: string; label: string }[];
  summaries: { id: string; title: string; body: string; fileIds: string[] }[];
};
export type Analysis = {
  architecture?: Architecture;
  nodes: Symbol[];
  edges: CallEdge[];
  warnings: string[];
  files: ChangedFile[];
  meta: {
    analysisId?: string;
    title: string;
    prUrl: string | null;
    number: number | null;
    repository: string;
    baseSha: string;
    headSha: string;
    baseRef: string;
    headRef: string;
    mode: 'github' | 'local';
    scopes: string[];
    indexedFiles: number;
    changedFiles: number;
    analyzedAt: string;
    limited: boolean;
    includeTests: boolean;
  };
};
export type Job = {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'error';
  stage: string;
  error?: string;
  result?: Analysis;
};

export function isSourceFile(path: string) {
  return /\.(py|[cm]?[jt]sx?)$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
}
