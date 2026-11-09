// Exercise the real inventory markup and connection descriptions without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
}
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const FileInventory = require('../frontend/FileInventory.tsx').default;
const { bundleConnections, connectionLabel, connectionDescription } = require('../frontend/architecture.ts');

function fixture() {
  const layers = [
    ['backend_api', 'APIs & routing'], ['backend_auth', 'Authorization'],
    ['backend_logic', 'Business logic & rules'], ['backend_data', 'Data & persistence'],
    ['backend_async', 'Jobs & workflows'], ['backend_integrations', 'Integrations & delivery'],
    ['backend_reporting', 'Reporting & projections'], ['backend_operations', 'Operations & migrations'],
    ['supporting', 'Supporting files'],
  ].map(([id, label]) => ({ id, label, description: '' }));
  const records = [
    ['misc/unknown.py', 'other'], ['workers/job.py', 'backend_async'],
    ['services/rules.py', 'backend_logic'], ['api/routes.py', 'backend_api'],
    ['auth/permissions.py', 'backend_auth'], ['models/plan.py', 'backend_data'],
    ['integrations/client.py', 'backend_integrations'], ['reports/report.py', 'backend_reporting'],
    ['admin/migrate.py', 'backend_operations'], ['tests/test_plan.py', 'supporting'],
    ['api/old_routes.py', 'backend_api', 'removed'], ['api/new_routes.py', 'backend_api', 'moved_modified'],
    ['misc/no_architecture.txt', null],
  ];
  const files = records.map(([path, , status = 'modified']) => ({ path, status, changedMethods: 0, indexed: true,
    ...(status === 'moved_modified' ? { previousPath: 'legacy/routes.py' } : {}) }));
  const nodes = records.filter(([, layer]) => layer).map(([path, layer, status = 'modified']) => {
    const version = { path, layer, roles: [], facts: [], operations: [], indexed: true, reason: '' };
    return { id: path, path, label: path.split('/').at(-1), status, symbolIds: [],
      base: version, head: status === 'removed' ? null : version };
  });
  return { files, nodes: [], edges: [], warnings: [],
    architecture: { layers, nodes, edges: [], features: [], summaries: [] },
    meta: { title: '', prUrl: null, number: null, repository: '', baseSha: '', headSha: '', baseRef: '', headRef: '',
      mode: 'local', scopes: [], indexedFiles: files.length, changedFiles: files.length, analyzedAt: '', limited: false, includeTests: false } };
}

function inventory(analysis, options = {}) {
  return renderToStaticMarkup(createElement(FileInventory, {
    analysis, search: '', expanded: new Set(), selectedFile: null, selectedId: null, showHelpers: false,
    onHelpers() {}, onToggle() {}, onFile() {}, onMethod() {}, ...options,
  }));
}
function headings(markup) {
  return [...markup.matchAll(/class="file-group-label">([^<]*)</g)].map(match => match[1].replaceAll('&amp;', '&'));
}
function fileNames(markup) {
  return [...markup.matchAll(/<strong title="([^"]+)">/g)].map(match => match[1]);
}

test('inventory defaults to architectural layer order and keeps unknown files last', () => {
  const markup = inventory(fixture());
  assert.deepEqual(headings(markup), ['APIs & routing', 'Authorization', 'Business logic & rules', 'Data & persistence',
    'Jobs & workflows', 'Integrations & delivery', 'Reporting & projections', 'Operations & migrations', 'Supporting files', 'Other files']);
  assert.deepEqual(fileNames(markup).slice(0, 3), ['api/new_routes.py', 'api/old_routes.py', 'api/routes.py']);
  assert.deepEqual(fileNames(markup).slice(-2), ['misc/no_architecture.txt', 'misc/unknown.py']);
});

test('folder inventory preserves alphabetical folders and files', () => {
  const markup = inventory(fixture(), { groupBy: 'folder' });
  assert.deepEqual(headings(markup), ['admin', 'api', 'auth', 'integrations', 'misc', 'models', 'reports', 'services', 'tests', 'workers']);
  assert.deepEqual(fileNames(markup).slice(0, 4), ['admin/migrate.py', 'api/new_routes.py', 'api/old_routes.py', 'api/routes.py']);
});

test('layer inventory follows a mixed profile without imposing a frontend or backend order', () => {
  const analysis = fixture();
  analysis.architecture.layers.unshift({ id: 'ui', label: 'Components & pages', description: '' });
  analysis.files.push({ path: 'web/Page.tsx', status: 'modified', changedMethods: 0, indexed: true });
  const version = { path: 'web/Page.tsx', layer: 'ui', roles: [], facts: [], operations: [], indexed: true, reason: '' };
  analysis.architecture.nodes.push({ id: 'page', path: version.path, label: 'Page.tsx', status: 'modified', symbolIds: [], base: version, head: version });
  assert.deepEqual(headings(inventory(analysis, { groupBy: 'layer' })).slice(0, 3), ['Components & pages', 'APIs & routing', 'Authorization']);
});

test('layer inventory search retains moved and removed files using available snapshots', () => {
  assert.deepEqual(headings(inventory(fixture(), { groupBy: 'layer', search: 'OLD_ROUTES' })), ['APIs & routing']);
  assert.deepEqual(fileNames(inventory(fixture(), { groupBy: 'layer', search: 'OLD_ROUTES' })), ['api/old_routes.py']);
  assert.deepEqual(fileNames(inventory(fixture(), { groupBy: 'layer', search: 'legacy/' })), ['api/new_routes.py']);
  assert.deepEqual(headings(inventory(fixture(), { groupBy: 'layer', search: 'does-not-exist' })), []);
});

function edge(relation) {
  return { id: relation, source: 'caller', target: 'target', relation, inBase: true, inHead: true, status: 'unchanged',
    baseEvidence: [], headEvidence: [] };
}

test('backend resolved calls have readable outgoing and incoming descriptions without inferred side effects', () => {
  for (const [relation, outgoing, incoming] of [
    ['checks_permission', 'checks permission', 'checked by'],
    ['calls_data_access', 'calls data access', 'called by'],
    ['calls_job', 'calls job', 'called by'],
    ['calls_integration', 'calls integration', 'called by'],
    ['calls_report', 'calls report', 'called by'],
    ['calls_operation', 'calls operation', 'called by'],
    ['calls_service', 'calls service', 'called by'],
    ['calls', 'calls', 'called by'],
  ]) {
    assert.equal(connectionLabel(edge(relation)), outgoing, relation);
    assert.equal(connectionDescription(edge(relation), 'caller'), outgoing, relation);
    assert.equal(connectionDescription(edge(relation), 'target'), incoming, relation);
  }
});

test('bundles keep backend call priorities stable across source order and retain existing webapp priorities', () => {
  const relations = ['imports', 'calls_operation', 'calls_report', 'calls_integration', 'calls_job', 'calls_data_access',
    'calls', 'calls_service', 'checks_permission', 'calls_api', 'mutates', 'runs_query'];
  const expected = ['runs_query', 'mutates', 'calls_api', 'checks_permission', 'calls_service', 'calls_data_access',
    'calls_job', 'calls_integration', 'calls_report', 'calls_operation', 'calls', 'imports'];
  for (const order of [relations, [...relations].reverse()]) {
    const [bundle] = bundleConnections(order.map(edge));
    assert.deepEqual(bundle.relations, expected);
    assert.equal(bundle.id, 'runs_query');
    assert.deepEqual(bundle.memberIds, expected);
  }
});
