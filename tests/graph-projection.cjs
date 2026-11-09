// Run with node --test tests/graph-projection.cjs. Compile the real TS modules
// in memory so projection regressions do not need a browser or a new runner.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const architecture = require('../frontend/architecture.ts');
const projection = fs.existsSync(require('node:path').join(__dirname, '../frontend/graphProjection.ts'))
  ? require('../frontend/graphProjection.ts') : {};

function file(id, layer, status = 'modified', sides = ['base', 'head']) {
  const version = { path: id + '.tsx', layer, roles: [], facts: [], operations: [], indexed: true, reason: '' };
  return { id, path: version.path, label: version.path, status, symbolIds: [],
    base: sides.includes('base') ? version : null, head: sides.includes('head') ? version : null };
}
function relationship(id, source, target, relation, sides = ['base', 'head']) {
  const ev = { path: source + '.tsx', line: 3, expression: id, kind: relation, reason: '', symbolId: null, startLine: 3, code: id };
  return { id, source, target, relation, inBase: sides.includes('base'), inHead: sides.includes('head'),
    status: sides.length === 2 ? 'unchanged' : sides[0] === 'head' ? 'added' : 'removed',
    baseEvidence: sides.includes('base') ? [ev] : [], headEvidence: sides.includes('head') ? [ev] : [] };
}
function arch(nodes, edges) { return { nodes, edges, features: [], summaries: [], layers: [] }; }

test('file relationships keep immediate incoming and outgoing semantic neighbors, without a transitive feature walk', () => {
  assert.equal(typeof architecture.fileGraph, 'function', 'fileGraph must support any selected file');
  const fixture = arch([file('page', 'ui'), file('parent', 'ui', 'unchanged'), file('service', 'services', 'unchanged'),
    file('api', 'integrations'), file('types', 'supporting'), file('other', 'ui')], [
    relationship('parent-page', 'parent', 'page', 'renders'), relationship('page-service', 'page', 'service', 'calls_service'),
    relationship('service-api', 'service', 'api', 'calls_api'), relationship('page-types', 'page', 'types', 'imports'),
  ]);
  const graph = architecture.fileGraph(fixture, 'page', 'head', false);
  assert.deepEqual(graph.files.map(f => f.id), ['page', 'parent', 'service']);
  assert.deepEqual(graph.edges.map(e => e.id), ['parent-page', 'page-service']);
  assert.deepEqual(architecture.fileGraph(fixture, 'page', 'head', true).files.map(f => f.id), ['page', 'parent', 'service', 'types']);
  assert.deepEqual(architecture.fileGraph(fixture, 'types', 'head', false).files.map(f => f.id), ['types']);
});

test('snapshot-specific file graphs cannot resurrect removed files or relationships', () => {
  assert.equal(typeof architecture.fileGraph, 'function');
  const fixture = arch([file('removed', 'ui', 'removed', ['base']), file('service', 'services'),
    file('added', 'ui', 'added', ['head'])], [relationship('old', 'removed', 'service', 'calls', ['base']),
    relationship('new', 'added', 'service', 'calls', ['head'])]);
  assert.deepEqual(architecture.fileGraph(fixture, 'removed', 'head', false), { files: [], edges: [] });
  assert.deepEqual(architecture.fileGraph(fixture, 'service', 'base', false).files.map(f => f.id), ['removed', 'service']);
  assert.deepEqual(architecture.fileGraph(fixture, 'service', 'head', false).files.map(f => f.id), ['service', 'added']);
});

test('a bundled file connection preserves query and mutation evidence on both snapshots', () => {
  const fixture = arch([file('page', 'ui'), file('service', 'services')], [
    relationship('query', 'page', 'service', 'runs_query'), relationship('mutation', 'page', 'service', 'mutates'),
  ]);
  const graph = architecture.featureGraph(fixture, 'page', 'overlay', false);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0].headEvidence.map(ev => ev.expression), ['query', 'mutation']);
  assert.deepEqual(graph.edges[0].baseEvidence.map(ev => ev.expression), ['query', 'mutation']);
  assert.match(architecture.connectionLabel(graph.edges[0]), /query.*mutation/);
});

test('incoming relationship wording describes the selected file as the target', () => {
  assert.equal(typeof architecture.connectionDescription, 'function');
  assert.equal(architecture.connectionDescription(relationship('render', 'parent', 'child', 'renders'), 'child'), 'rendered by');
  assert.equal(architecture.connectionDescription(relationship('render', 'parent', 'child', 'renders'), 'parent'), 'renders');
});

function symbol(id, path, qualname, kind, code, startLine = 1, sides = ['base', 'head']) {
  const version = { code, startLine, endLine: startLine + code.split('\n').length - 1, signature: '' };
  return { id, path, basePath: sides.includes('base') ? path : null, headPath: sides.includes('head') ? path : null,
    module: path, qualname, name: qualname.split('.').at(-1), kind, className: null,
    base: sides.includes('base') ? version : null, head: sides.includes('head') ? version : null,
    status: 'modified', diff: '', unresolvedCalls: [] };
}
function call(id, source, target, relation, expression, sides = ['base', 'head']) {
  return { id, source, target, relation, expression, line: 2, baseLine: sides.includes('base') ? 2 : null,
    headLine: sides.includes('head') ? 2 : null, baseExpression: sides.includes('base') ? expression : null,
    headExpression: sides.includes('head') ? expression : null, inBase: sides.includes('base'), inHead: sides.includes('head'),
    status: sides.length === 2 ? 'unchanged' : sides[0] === 'head' ? 'added' : 'removed',
    evidence: { path: 'Page.tsx', line: 2, side: sides.at(-1), expression } };
}
function symbols() {
  return { nodes: [
    symbol('page', 'Page.tsx', 'Page', 'component', 'function Page(){ return <button onClick={() => save()} />; }'),
    symbol('click', 'Page.tsx', 'Page.<callback:1>', 'callback', '() => save()'),
    symbol('unused', 'Page.tsx', 'Page.unused', 'function', '() => remove()'),
    symbol('save', 'service.ts', 'save', 'function', 'function save(){}'),
    symbol('remove', 'service.ts', 'remove', 'function', 'function remove(){}'),
    symbol('next', 'api.ts', 'request', 'function', 'function request(){}'),
  ], edges: [call('register', 'page', 'click', 'callback', '() => save()'), call('save-call', 'click', 'save', 'call', 'save()'),
    call('unused-call', 'unused', 'remove', 'call', 'remove()'), call('request', 'save', 'next', 'call', 'request()')],
    files: [{ path: 'Page.tsx', status: 'modified', changedMethods: 3, indexed: true }], warnings: [],
    meta: { title: '', prUrl: null, number: null, repository: '', baseSha: '', headSha: '', baseRef: '', headRef: '',
      mode: 'local', scopes: [], indexedFiles: 3, changedFiles: 1, analyzedAt: '', limited: false, includeTests: false } };
}
function project(fixture = symbols(), options = {}) {
  assert.equal(typeof projection.projectSymbolGraph, 'function', 'symbol projection must fold helpers before neighborhood expansion');
  return projection.projectSymbolGraph(fixture, { file: fixture.files[0], focusId: null, view: 'head', includeHelpers: false, ...options });
}

test('folded callbacks retain external calls with their real path and never become peer nodes', () => {
  const graph = project();
  assert.deepEqual(graph.nodes.map(n => n.id), ['page', 'save']);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].source, 'page');
  assert.equal(graph.edges[0].target, 'save');
  assert.deepEqual(graph.edges[0].via.map(n => n.id), ['click']);
  assert.deepEqual(graph.edges[0].evidenceEdges.map(e => e.id), ['register', 'save-call']);
  assert.match(graph.edges[0].label, /via.*onClick.*callback/);
  assert.deepEqual(graph.folded.get('page').map(n => n.id), ['click', 'unused']);
  assert.ok(!graph.nodes.some(n => n.id === 'remove'), 'an unused nested declaration is not a call from Page');
});

test('revealing local helpers restores original edges without hiding the callback dependency', () => {
  const graph = project(symbols(), { revealedOwners: new Set(['page']) });
  assert.deepEqual(graph.nodes.map(n => n.id), ['page', 'click', 'unused', 'save', 'remove']);
  assert.deepEqual(graph.edges.map(e => e.id), ['register', 'save-call', 'unused-call']);
  assert.ok(graph.edges.every(e => e.via.length === 0));
});

test('neighbor expansion applies the same callback folding at every depth', () => {
  const fixture = symbols();
  fixture.nodes.push(symbol('remote', 'service.ts', 'save.<callback:1>', 'callback', '() => request()'));
  fixture.edges = fixture.edges.filter(e => e.id !== 'request');
  fixture.edges.push(call('remote-register', 'save', 'remote', 'callback', '() => request()'),
    call('request', 'remote', 'next', 'call', 'request()'));
  const graph = project(fixture, { expanded: new Set(['save']) });
  assert.deepEqual(graph.nodes.map(n => n.id), ['page', 'save', 'next']);
  assert.deepEqual(graph.edges.find(e => e.target === 'next').via.map(n => n.id), ['remote']);
});

test('overlay cannot join a before callback registration to an after-only invocation', () => {
  const fixture = symbols();
  fixture.edges = [call('register-before', 'page', 'click', 'callback', '() => save()', ['base']),
    call('save-after', 'click', 'save', 'call', 'save()', ['head'])];
  const graph = project(fixture, { view: 'overlay' });
  assert.deepEqual(graph.edges, [], 'the complete folded path must exist in at least one snapshot');
});
