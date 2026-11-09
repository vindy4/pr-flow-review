import type { ChangedFile, Symbol, View } from './types';

export function belongsToFile(method: Symbol, file: ChangedFile, view: View = 'overlay') {
  const before = !!method.base && (method.basePath || method.path) === (file.previousPath || file.path);
  const after = !!method.head && (method.headPath || method.path) === file.path;
  return view === 'base' ? before : view === 'head' ? after : before || after;
}

export function isTopLevel(method: Symbol) {
  return method.kind !== 'callback' && (!method.qualname.includes('.') || method.kind === 'method');
}

export function fileMethods(nodes: Symbol[], file: ChangedFile) {
  return nodes.filter(node => belongsToFile(node, file)).sort((a, b) =>
    (a.head || a.base)!.startLine - (b.head || b.base)!.startLine || a.qualname.localeCompare(b.qualname));
}

export function methodFile(nodes: ChangedFile[], method: Symbol, view: View = 'head'): ChangedFile {
  return nodes.find(file => belongsToFile(method, file, view))
    || nodes.find(file => belongsToFile(method, file))
    || { path: method.path, status: 'unchanged', changedMethods: 0, indexed: true };
}
