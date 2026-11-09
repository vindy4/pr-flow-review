// End-to-end UI regression. Only repository/network boundaries are replaced.
// Run with PLAYWRIGHT_MODULE=/path/to/playwright PLAYWRIGHT_BROWSERS_PATH=.cache/browsers node tests/browser/review-workspace.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screenCode = [
  "import { save } from './service';",
  "const FLOW_NAME = 'Enrollment';",
  ...Array.from({ length: 60 }, (_, i) => `// Source context ${i + 1}: preserve this file while reviewing relationships.`),
  'export function Screen() {',
  '  const onConfirm = () => { save(); trackConfirmation(); };',
  '  return <button onClick={onConfirm}>{FLOW_NAME}</button>;',
  '}',
  '',
].join('\n');
const serviceCode = "import { client } from './client';\nexport const API_ENDPOINT = '/enroll';\nexport function save() { return client.post(API_ENDPOINT); }\n";
const sources = {
  'src/Screen.tsx': { path: 'src/Screen.tsx', base: { path: 'src/Screen.tsx', code: screenCode.replace('  const onConfirm = () => { save(); trackConfirmation(); };', '  const onConfirm = () => { save(); removed(); }; // BEFORE_ONLY_CONNECTION'), startLine: 1 }, head: { path: 'src/Screen.tsx', code: screenCode, startLine: 1 }, diff: '--- a/src/Screen.tsx\n+++ b/src/Screen.tsx\n@@ -64 +64 @@\n-  const onConfirm = () => { save(); removed(); }; // BEFORE_ONLY_CONNECTION\n+  const onConfirm = () => { save(); trackConfirmation(); };\n' },
  'src/service.ts': { path: 'src/service.ts', base: { path: 'src/service.ts', code: serviceCode.replace("'/enroll'", "'/old-enroll'"), startLine: 1 }, head: { path: 'src/service.ts', code: serviceCode, startLine: 1 }, diff: "--- a/src/service.ts\n+++ b/src/service.ts\n@@ -2 +2 @@\n-export const API_ENDPOINT = '/old-enroll';\n+export const API_ENDPOINT = '/enroll';\n" },
  'src/client.ts': { path: 'src/client.ts', base: { path: 'src/client.ts', code: "export const client = { post: (url) => fetch(url) };\n", startLine: 1 }, head: { path: 'src/client.ts', code: "export const client = { post: (url) => fetch(url) };\n", startLine: 1 }, diff: '' },
  'src/removed.ts': { path: 'src/removed.ts', base: { path: 'src/removed.ts', code: 'export function removed() { return "old behavior"; }\n', startLine: 1 }, head: null, diff: '--- a/src/removed.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export function removed() { return "old behavior"; }\n' },
  'src/new.ts': { path: 'src/new.ts', base: { path: 'src/old.ts', code: 'export function renamed() { return "old path"; }\n', startLine: 1 }, head: { path: 'src/new.ts', code: 'export function renamed() { return "new path"; }\n', startLine: 1 }, diff: '--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-export function renamed() { return "old path"; }\n+export function renamed() { return "new path"; }\n' },
  'src/Screen.test.tsx': { path: 'src/Screen.test.tsx', base: { path: 'src/Screen.test.tsx', code: 'test("screen", () => expect(true).toBe(true));\n', startLine: 1 }, head: { path: 'src/Screen.test.tsx', code: 'test("screen", () => expect(false).toBe(false));\n', startLine: 1 }, diff: '--- a/src/Screen.test.tsx\n+++ b/src/Screen.test.tsx\n@@ -1 +1 @@\n-test("screen", () => expect(true).toBe(true));\n+test("screen", () => expect(false).toBe(false));\n' },
  'README.md': { path: 'README.md', base: { path: 'README.md', code: '# Enrollment before\n', startLine: 1 }, head: { path: 'README.md', code: '# Enrollment after\n', startLine: 1 }, diff: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Enrollment before\n+# Enrollment after\n' },
};
function symbol(id, file, name, line, code, extra = {}) {
  const version = { startLine: line, endLine: line + code.split('\n').length - 1, code, signature: code.split('\n')[0] };
  return { id, path: file, basePath: file, headPath: file, module: file, qualname: name, name,
    className: null, kind: 'function', language: 'typescript', status: 'modified', base: version,
    head: version, diff: '', unresolvedCalls: [], ...extra };
}
const nodes = [
  symbol('screen', 'src/Screen.tsx', 'Screen', 63, screenCode.split('\n').slice(62, 66).join('\n'), { kind: 'component' }),
  symbol('confirm', 'src/Screen.tsx', 'onConfirm', 64, '  const onConfirm = () => { save(); trackConfirmation(); };', { qualname: 'Screen.onConfirm', kind: 'callback' }),
  symbol('save', 'src/service.ts', 'save', 3, 'export function save() { return client.post(API_ENDPOINT); }'),
  symbol('post', 'src/client.ts', 'post', 1, "export const client = { post: (url) => fetch(url) };", { status: 'unchanged' }),
  symbol('removed', 'src/removed.ts', 'removed', 1, 'export function removed() { return "old behavior"; }', { head: null, headPath: null, status: 'removed' }),
  symbol('renamed', 'src/new.ts', 'renamed', 1, 'export function renamed() { return "new path"; }', { basePath: 'src/old.ts', status: 'moved_modified' }),
];
function evidence(file, line, expression, symbolId, targetSymbolId) {
  return { path: file, line, startLine: line, code: expression, expression, kind: 'call',
    reason: 'Resolved source binding', symbolId, targetSymbolId };
}
function architectureNode(id, file, layer, roles, extra = {}) {
  const operations = nodes.filter(n => n.path === file).map(n => ({ id: n.id, label: n.qualname, kind: n.kind, line: n.head?.startLine || n.base.startLine }));
  const version = { path: file, roles, layer, reason: 'Source-backed fixture classification', indexed: true, facts: [], operations };
  return { id, path: file, label: file.split('/').pop(), status: 'modified', base: version, head: version,
    symbolIds: operations.map(op => op.id), ...extra };
}
const screenService = evidence('src/Screen.tsx', 64, 'save()', 'confirm', 'save');
const serviceClient = evidence('src/service.ts', 3, 'client.post(API_ENDPOINT)', 'save', 'post');
const screenRemoved = { ...evidence('src/Screen.tsx', 64, 'removed()', 'confirm', 'removed'), code: '  const onConfirm = () => { save(); removed(); }; // BEFORE_ONLY_CONNECTION' };
const fixture = {
  meta: { analysisId: 'fixture', title: 'Enrollment review workspace', prUrl: 'https://github.com/a/b/pull/1', number: 1,
    repository: 'a/b', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), baseRef: 'main', headRef: 'feature',
    mode: 'github', scopes: ['src'], indexedFiles: 5, changedFiles: 6,
    analyzedAt: '2026-11-01T00:00:00Z', limited: false, includeTests: false },
  nodes,
  edges: [
    { id: 'screen-confirm', source: 'screen', target: 'confirm', relation: 'callback', expression: 'onConfirm', line: 65, basePath: 'src/Screen.tsx', headPath: 'src/Screen.tsx', baseLine: 65, headLine: 65, inBase: true, inHead: true, status: 'unchanged', evidence: { path: 'src/Screen.tsx', line: 65, side: 'head', expression: 'onConfirm' } },
    { id: 'confirm-save', source: 'confirm', target: 'save', relation: 'call', expression: 'save()', line: 64, basePath: 'src/Screen.tsx', headPath: 'src/Screen.tsx', baseLine: 64, headLine: 64, inBase: true, inHead: true, status: 'unchanged', evidence: { path: 'src/Screen.tsx', line: 64, side: 'head', expression: 'save()' } },
    { id: 'confirm-removed', source: 'confirm', target: 'removed', relation: 'call', expression: 'removed()', line: 64, basePath: 'src/Screen.tsx', headPath: 'src/Screen.tsx', baseLine: 64, headLine: null, inBase: true, inHead: false, status: 'removed', evidence: { path: 'src/Screen.tsx', line: 64, side: 'base', expression: 'removed()' } },
    { id: 'save-post', source: 'save', target: 'post', relation: 'call', expression: 'client.post(API_ENDPOINT)', line: 3, basePath: 'src/service.ts', headPath: 'src/service.ts', baseLine: 3, headLine: 3, inBase: true, inHead: true, status: 'unchanged', evidence: { path: 'src/service.ts', line: 3, side: 'head', expression: 'client.post(API_ENDPOINT)' } },
  ],
  files: [
    { path: 'src/Screen.tsx', status: 'modified', changedMethods: 2, indexed: true },
    { path: 'src/service.ts', status: 'modified', changedMethods: 1, indexed: true },
    { path: 'src/removed.ts', status: 'removed', changedMethods: 1, indexed: true },
    { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', changedMethods: 1, indexed: true },
    { path: 'src/Screen.test.tsx', status: 'modified', changedMethods: 0, indexed: false },
    { path: 'README.md', status: 'modified', changedMethods: 0, indexed: false },
  ],
  architecture: {
    layers: [{ id: 'ui', label: 'Screens & JSX', description: 'Screens' }, { id: 'services', label: 'Services', description: 'Services' }, { id: 'api', label: 'API integrations', description: 'API' }, { id: 'supporting', label: 'Supporting files', description: 'Tests and documentation' }],
    nodes: [
      architectureNode('file:screen', 'src/Screen.tsx', 'ui', ['JSX', 'Local state']),
      architectureNode('file:service', 'src/service.ts', 'services', ['Service']),
      architectureNode('file:client', 'src/client.ts', 'api', ['API client'], { status: 'unchanged' }),
      architectureNode('file:removed', 'src/removed.ts', 'services', ['Service'], { status: 'removed', head: null }),
      architectureNode('file:renamed', 'src/new.ts', 'services', ['Service'], { status: 'moved_modified', base: { path: 'src/old.ts', roles: ['Service'], layer: 'services', reason: 'Moved source', indexed: true, facts: [], operations: [{ id: 'renamed', label: 'renamed', kind: 'function', line: 1 }] } }),
      architectureNode('file:test', 'src/Screen.test.tsx', 'supporting', ['Test'], { base: { path: 'src/Screen.test.tsx', roles: ['Test'], layer: 'supporting', reason: 'Tests excluded', indexed: false, facts: [], operations: [] }, head: { path: 'src/Screen.test.tsx', roles: ['Test'], layer: 'supporting', reason: 'Tests excluded', indexed: false, facts: [], operations: [] } }),
      architectureNode('file:readme', 'README.md', 'supporting', ['Documentation'], { base: { path: 'README.md', roles: ['Documentation'], layer: 'supporting', reason: 'Documentation', indexed: false, facts: [], operations: [] }, head: { path: 'README.md', roles: ['Documentation'], layer: 'supporting', reason: 'Documentation', indexed: false, facts: [], operations: [] } }),
    ],
    edges: [
      { id: 'file:screen-service', source: 'file:screen', target: 'file:service', relation: 'calls_service', inBase: true, inHead: true, status: 'unchanged', baseEvidence: [screenService], headEvidence: [screenService] },
      { id: 'file:service-client', source: 'file:service', target: 'file:client', relation: 'calls_api', inBase: true, inHead: true, status: 'unchanged', baseEvidence: [serviceClient], headEvidence: [serviceClient] },
      { id: 'file:screen-removed', source: 'file:screen', target: 'file:removed', relation: 'calls', inBase: true, inHead: false, status: 'removed', baseEvidence: [screenRemoved], headEvidence: [] },
    ],
    features: [{ id: 'file:screen', root: 'file:screen', label: 'Screen.tsx' }],
    summaries: [{ id: 'ui', title: 'Screens & JSX', body: '1 changed file', fileIds: ['file:screen'] }, { id: 'services', title: 'Services', body: '3 changed files', fileIds: ['file:service', 'file:removed', 'file:renamed'] }],
  },
  warnings: [],
};

(async () => {
  const output = process.env.QA_DIR || '.cache/review-workspace-work';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1720, height: 1100 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  const results = [];
  let submits = 0;
  let delayedServiceRead = false;
  let activeFixture = fixture;
  const staleReads = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/reviews/submit') {
        submits++;
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Test does not submit reviews.' }) });
      }
      let data;
      if (url.pathname === '/api/health') data = { githubAuthenticated: true, githubMessage: 'Fixture' };
      else if (url.pathname === '/api/analyze') data = { jobId: 'fixture' };
      else if (url.pathname === '/api/jobs/fixture') data = { id: 'fixture', status: 'complete', stage: 'Complete', result: activeFixture };
      else if (url.pathname === '/api/files/read') {
        const body = route.request().postDataJSON();
        assert.equal(body.analysisId, activeFixture.meta.analysisId, 'Full-file reads must use the pinned analysis descriptor');
        if (body.analysisId === 'fixture-narrow' && body.path === 'src/client.ts') {
          staleReads.push(body.path);
          return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'File is outside this analysis descriptor.' }) });
        }
        data = sources[body.path];
        assert.ok(data, `Unexpected source read: ${body.path}`);
        if (body.path === 'src/service.ts' && !delayedServiceRead) {
          delayedServiceRead = true;
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } else if (url.pathname === '/api/reviews/context') data = { files: [{ path: 'src/Screen.tsx', baseLines: [64], headLines: [64] }] };
      else if (url.pathname === '/api/reviews/refresh') {
        const body = route.request().postDataJSON();
        data = { baseSha: activeFixture.meta.baseSha, headSha: activeFixture.meta.headSha,
          files: [{ path: 'src/Screen.tsx', previousPath: null, baseLines: [64], headLines: [64] }],
          comments: (body.comments || []).map(item => ({ ...item, status: 'ready', reason: '' })),
          reviewed: (body.reviewed || []).map(item => ({ ...item, status: 'ready', reason: '' })) };
      }
      else throw new Error(`Unexpected network boundary: ${url.pathname}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto(process.env.APP_URL || 'http://127.0.0.1:8765/');
    await page.screenshot({ path: path.join(output, 'compact-entry.png'), fullPage: true });
    fs.writeFileSync(path.join(output, 'chrome-layout.json'), JSON.stringify(await page.evaluate(() => ({
      headerHeight: document.querySelector('.app-header').getBoundingClientRect().height,
      formTop: document.querySelector('.analysis-form').getBoundingClientRect().top,
      formBottom: document.querySelector('.analysis-form').getBoundingClientRect().bottom,
      localComparisonOptions: [...document.querySelectorAll('button')].filter(button => /Local Git comparison/.test(button.textContent)).length,
    })), null, 2));
    async function analyze() {
      await page.getByRole('button', { name: 'Analyze flow', exact: true }).click();
      await page.getByRole('button', { name: 'Change comparison', exact: true }).waitFor();
    }
    await analyze();
    // This must fail on the former disconnected Overview/Code review workspace.
    await page.locator('.workspace-center .file-reader').getByRole('tab', { name: 'Diff', exact: true }).waitFor();
    const inventory = page.locator('.inventory-panel');
    const reader = page.locator('.workspace-center .file-reader');
    const drawer = page.locator('aside[aria-label="Code drawer"] .file-reader');
    async function expectSubject(basename) {
      await page.waitForFunction(name => document.querySelector('.review-subject')?.textContent.includes(name), basename);
      assert.match(await reader.innerText(), new RegExp(basename.replaceAll('.', '\\.')));
    }
    async function chooseFile(file) {
      await inventory.locator('.changed-file-item').filter({ has: page.locator(`strong[title="${file}"]`) }).click();
      await expectSubject(file.split('/').pop());
    }
    async function tab(name) {
      await reader.getByRole('tab', { name, exact: true }).click();
      assert.equal(await reader.getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true');
    }
    async function graphNodes(ids) {
      await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.architecture-map .react-flow__node')].filter(n => !n.dataset.id.startsWith('layer:')).map(n => n.dataset.id).sort()) === JSON.stringify(expected), [...ids].sort());
    }
    await expectSubject('Screen.tsx');
    await tab('Full file');
    assert.match(await reader.innerText(), /import \{ save \} from '\.\/service'/);
    assert.match(await reader.innerText(), /const FLOW_NAME = 'Enrollment'/);
    assert.match(await reader.innerText(), /const onConfirm = \(\) => \{ save\(\); trackConfirmation\(\); \};/);
    assert.match(await reader.innerText(), /<button onClick=\{onConfirm\}>\{FLOW_NAME\}<\/button>/);
    const overview = page.locator('summary').filter({ hasText: 'PR overview' });
    await overview.click();
    await expectSubject('Screen.tsx');
    assert.equal(await reader.getByRole('tab', { name: 'Full file', exact: true }).getAttribute('aria-selected'), 'true');
    await overview.click();
    results.push('Full file includes imports, constants, short mutation handler and JSX.');
    await tab('Relationships');
    await graphNodes(['file:screen', 'file:service']);
    if (!process.argv.includes('--search-only')) {
    assert.equal(await reader.getByRole('button', { name: /^(Before|Changes|After|Overlay)$/ }).count(), 0, 'File relationships must have no snapshot switch');
    assert.equal(await reader.getByRole('checkbox', { name: 'Import context', exact: true }).count(), 1);
    await reader.getByRole('combobox', { name: 'Relationship scope', exact: true }).selectOption('all');
    await graphNodes(['file:screen', 'file:service', 'file:renamed', 'file:test', 'file:readme']);
    await reader.getByRole('combobox', { name: 'Relationship scope', exact: true }).selectOption('file');
    await tab('Full file');
    await reader.getByRole('button', { name: 'Before', exact: true }).click();
    await reader.locator('.code-line').filter({ hasText: 'BEFORE_ONLY_CONNECTION' }).waitFor();
    await tab('Relationships');
    await graphNodes(['file:screen', 'file:service']);
    assert.equal(await reader.locator('.react-flow__edge[data-id="file:screen-removed"]').count(), 0, 'Before source selection must not expose removed file relationships');
    results.push('File relationships always show the current PR, including after reading Before source; map scope and import context remain available.');
    await tab('Relationships');
    await reader.getByRole('combobox', { name: 'Graph detail', exact: true }).selectOption({ label: 'Functions and callbacks' });
    await reader.getByRole('region', { name: 'Source call graph', exact: true }).waitFor();
    assert.ok(await reader.locator('.method-node').count() > 0, 'Function detail must expose the real source relationship graph');
    assert.equal(await reader.getByRole('button', { name: /^(Before|Changes|After|Overlay)$/ }).count(), 0, 'Function relationships must have no snapshot switch');
    await expectSubject('Screen.tsx');
    await inventory.getByRole('checkbox', { name: 'Show callbacks and nested helpers' }).check();
    // Horizontal SVG paths have zero geometric height, including React Flow's clickable edge overlay.
    await reader.locator('.react-flow__edge[data-id="confirm-save"] .react-flow__edge-interaction').waitFor({ state: 'attached' });
    assert.equal(await reader.locator('.react-flow__node[data-id="removed"]').count(), 0, 'Function detail must exclude methods removed from the current PR');
    assert.equal(await reader.locator('.react-flow__edge[data-id="confirm-removed"]').count(), 0, 'Function detail must exclude removed calls even after reading Before source');
    await reader.locator('.react-flow__edge[data-id="confirm-save"] .react-flow__edge-interaction').dispatchEvent('click');
    assert.equal(await reader.getByRole('tab', { name: 'Relationships', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await drawer.getByRole('tab', { name: 'Full file', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await drawer.getByRole('button', { name: 'After', exact: true }).getAttribute('class'), 'active', 'Current graph evidence must open After source regardless of the previous reader selection');
    await drawer.locator('.code-line.highlight').filter({ hasText: 'trackConfirmation' }).waitFor();
    await drawer.getByRole('button', { name: 'Before', exact: true }).click();
    await tab('Relationships');
    await reader.locator('.react-flow__node[data-id="confirm"] .method-node').click();
    assert.equal(await reader.getByRole('tab', { name: 'Relationships', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await drawer.getByRole('tab', { name: 'Full file', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await drawer.getByRole('button', { name: 'After', exact: true }).getAttribute('class'), 'active', 'Current graph methods must open their After definition');
    await drawer.locator('.code-line.highlight').filter({ hasText: 'trackConfirmation' }).waitFor();
    results.push('Function relationships exclude removed calls and methods; selecting current graph evidence or methods opens After source.');
    await tab('Relationships');
    await reader.getByRole('combobox', { name: 'Graph detail', exact: true }).selectOption({ label: 'Files' });
    await graphNodes(['file:screen', 'file:service']);
    }
    await chooseFile('src/service.ts');
    await graphNodes(['file:screen', 'file:service', 'file:client']);
    await chooseFile('src/Screen.tsx');
    await tab('Full file');
    await page.waitForTimeout(350); // Let an earlier file read finish after the current selection.
    assert.match(await reader.innerText(), /FLOW_NAME/);
    assert.doesNotMatch(await reader.innerText(), /API_ENDPOINT/);
    await chooseFile('src/service.ts');
    await tab('Full file');
    await page.waitForFunction(() => document.querySelector('.workspace-center .file-reader')?.textContent.includes("API_ENDPOINT = '/enroll'"));
    assert.doesNotMatch(await reader.innerText(), /FLOW_NAME/);
    await tab('Relationships');
    await reader.locator('.react-flow__edge[data-id="file:screen-service"] .react-flow__edge-interaction').dispatchEvent('click');
    await reader.locator('.react-flow__edge.selected[data-id="file:screen-service"]').waitFor();
    await reader.locator('.react-flow__node[data-id="file:screen"] .architecture-file-card').click();
    await expectSubject('Screen.tsx');
    const savedSubject = await page.evaluate(() => JSON.parse(localStorage.getItem(`flowreview:session:a/b:1:${'a'.repeat(40)}:${'b'.repeat(40)}`)));
    assert.equal(savedSubject.path, 'src/Screen.tsx', 'Graph navigation must persist the caller file rather than the previous callee');
    await chooseFile('src/service.ts');
    await tab('Relationships');
    await reader.locator('.react-flow__node[data-id="file:client"] .architecture-file-card').click();
    await expectSubject('client.ts');
    await tab('Full file');
    await page.waitForFunction(() => document.querySelector('.workspace-center .file-reader')?.textContent.includes('fetch(url)'));
    results.push('Changed files and unchanged graph dependencies share the reader and current file; graph navigation persists the selected file.');
    await chooseFile('src/Screen.tsx');
    await tab('Diff');
    // Keyboard operation should preserve the native button/tab contract.
    await reader.getByRole('tab', { name: 'Full file', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await reader.getByRole('tab', { name: 'Full file', exact: true }).getAttribute('aria-selected'), 'true');
    const helpers = inventory.getByRole('checkbox', { name: 'Show callbacks and nested helpers' });
    if (!(await helpers.isChecked())) await helpers.check();
    await inventory.locator('.inventory-method').filter({ hasText: 'onConfirm' }).click();
    await expectSubject('Screen.tsx');
    assert.equal(await reader.getByRole('tab', { name: 'Full file', exact: true }).getAttribute('aria-selected'), 'true');
    await reader.locator('.code-line.highlight').filter({ hasText: 'trackConfirmation' }).waitFor();
    results.push('Selecting a callback jumps to its full-file line while retaining the file subject.');
    await reader.getByRole('textbox', { name: 'Find in file', exact: true }).fill('FLOW_NAME =');
    await reader.getByRole('button', { name: 'Find next', exact: true }).click();
    await reader.locator('.code-line.highlight[data-source-line="2"]').filter({ hasText: 'FLOW_NAME' }).waitFor();
    await tab('Relationships');
    await expectSubject('Screen.tsx');
    await inventory.locator('.inventory-method').filter({ has: page.locator('strong[title="Screen"]') }).click();
    assert.equal(await reader.getByRole('tab', { name: 'Relationships', exact: true }).getAttribute('aria-selected'), 'true');
    await drawer.locator('.source-code-view .code-line.highlight[data-source-line="63"]').waitFor();
    const jumpScrollTop = await drawer.locator('.file-code-scroll').evaluate(scroller => scroller.scrollTop);
    const drawerScrollTop = await drawer.locator('.file-code-scroll').evaluate(async scroller => {
      scroller.scrollTop = 200;
      // Let the browser deliver the scroll event that saves the shared reading position.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return scroller.scrollTop;
    });
    assert.ok(drawerScrollTop > 100 && jumpScrollTop > drawerScrollTop + 100, 'Fixture must manually scroll away from the selected method');
    await tab('Full file');
    await reader.locator('.source-code-view').waitFor();
    const expandedScrollTop = await reader.locator('.file-code-scroll').evaluate(scroller => scroller.scrollTop);
    assert.ok(Math.abs(expandedScrollTop - drawerScrollTop) < 3,
      `Opening Full file must preserve the drawer's manual position (${drawerScrollTop}), received ${expandedScrollTop}`);
    results.push('Opening the main Full file reader preserves manual drawer reading position after a method jump.');
    await tab('Diff');
    await expectSubject('Screen.tsx');
    await tab('Full file');
    const scrollTop = await reader.locator('.file-code-scroll').evaluate(scroller => {
      scroller.scrollTop = Math.min(500, scroller.scrollHeight - scroller.clientHeight);
      return scroller.scrollTop;
    });
    assert.ok(scrollTop > 100, 'Fixture source must produce meaningful reading progress');
    await chooseFile('src/service.ts');
    await page.waitForFunction(() => document.querySelectorAll('.workspace-center .file-reader .code-line.highlight').length === 0);
    await tab('Diff');
    await page.getByRole('button', { name: 'Previous file', exact: true }).click();
    await expectSubject('Screen.tsx');
    assert.equal(await reader.getByRole('tab', { name: 'Full file', exact: true }).getAttribute('aria-selected'), 'true');
    await page.waitForFunction(expected => Math.abs((document.querySelector('.workspace-center .file-reader .file-code-scroll')?.scrollTop ?? -1) - expected) < 3, scrollTop);
    await page.getByRole('button', { name: 'Next visited file', exact: true }).click();
    await expectSubject('service.ts');
    assert.equal(await reader.getByRole('tab', { name: 'Diff', exact: true }).getAttribute('aria-selected'), 'true');
    results.push('Previous/next visited navigation restores each file’s reader tab and source position.');
    results.push('Find overrides an earlier symbol jump, clears stale file highlights, and history restores manual reading position.');
    await chooseFile('src/Screen.tsx');
    await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
    await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Next unreviewed file', exact: true }).click();
    await expectSubject('service.ts');
    await page.getByRole('button', { name: 'Change comparison', exact: true }).click();
    await analyze();
    await chooseFile('src/Screen.tsx');
    await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).waitFor();
    await page.reload();
    await analyze();
    await chooseFile('src/Screen.tsx');
    await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).waitFor();
    results.push('Review markers persist across same-snapshot reanalysis and next-unreviewed advances the file.');
    await tab('Full file');
    await reader.getByRole('button', { name: 'Comment on After line 64', exact: true }).click();
    await page.getByRole('textbox', { name: 'Comment text', exact: true }).fill('Please explain the confirmation tracking side effect.');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await chooseFile('src/service.ts');
    await page.getByRole('button', { name: 'Review drafts (1)', exact: true }).click();
    assert.match(await page.getByRole('dialog', { name: 'Review drafts', exact: true }).innerText(), /confirmation tracking side effect/);
    await page.getByRole('button', { name: 'Close review drafts', exact: true }).click();
    assert.equal(submits, 0, 'Saving and previewing drafts must never submit a review');
    results.push('Full-file inline comments remain anchored and drafts survive file navigation; no review submitted.');
    await chooseFile('src/removed.ts');
    await tab('Full file');
    await page.waitForFunction(() => document.querySelector('.workspace-center .file-reader')?.textContent.includes('old behavior'));
    await chooseFile('src/new.ts');
    await tab('Diff');
    await page.waitForFunction(() => document.querySelector('.workspace-center .file-reader')?.textContent.includes('old path') && document.querySelector('.workspace-center .file-reader')?.textContent.includes('new path'));
    await tab('Full file');
    await reader.getByRole('button', { name: 'After', exact: true }).click();
    await chooseFile('src/Screen.test.tsx');
    await tab('Full file');
    await page.waitForFunction(() => document.querySelector('.workspace-center .file-reader')?.textContent.includes('expect(false)'));
    await chooseFile('README.md');
    await tab('Full file');
    await page.waitForFunction(() => document.querySelector('.workspace-center .file-reader')?.textContent.includes('Enrollment after'));
    results.push('Removed, renamed, excluded-test and documentation files remain readable.');
    await chooseFile('src/Screen.tsx');
    await tab('Full file');
    await page.screenshot({ path: path.join(output, 'workspace-desktop.png'), fullPage: true });
    for (const width of [800, 360]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No page overflow at ${width}px`);
      await page.screenshot({ path: path.join(output, `workspace-${width}.png`), fullPage: true });
    }
    results.push('Desktop, 800px and 360px file workspace remains within the viewport.');
    await page.setViewportSize({ width: 1720, height: 1100 });
    await chooseFile('src/service.ts');
    await tab('Relationships');
    await graphNodes(['file:screen', 'file:service', 'file:client']);
    await reader.locator('.react-flow__node[data-id="file:client"] .architecture-file-card').click();
    await expectSubject('client.ts');
    await tab('Full file');
    await page.waitForFunction(() => document.querySelector('.workspace-center .file-reader')?.textContent.includes('fetch(url)'));
    activeFixture = {
      ...fixture,
      meta: { ...fixture.meta, analysisId: 'fixture-narrow', scopes: ['src/Screen.tsx', 'src/service.ts'], indexedFiles: 4 },
      nodes: fixture.nodes.filter(node => node.path !== 'src/client.ts'),
      edges: fixture.edges.filter(edge => edge.target !== 'post' && edge.source !== 'post'),
      architecture: { ...fixture.architecture,
        nodes: fixture.architecture.nodes.filter(node => node.id !== 'file:client'),
        edges: fixture.architecture.edges.filter(edge => edge.source !== 'file:client' && edge.target !== 'file:client') },
    };
    await page.getByRole('button', { name: 'Change comparison', exact: true }).click();
    await analyze();
    await expectSubject('Screen.tsx');
    assert.deepEqual(staleReads, [], 'A narrower same-SHA analysis must not keep or read an out-of-scope dependency');
    await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).waitFor();
    results.push('Same-SHA scope changes reset stale dependency selection while preserving snapshot review progress.');
    await chooseFile('src/Screen.test.tsx');
    activeFixture = {
      ...activeFixture,
      meta: { ...activeFixture.meta, includeTests: true },
      files: activeFixture.files.map(file => file.path === 'src/Screen.test.tsx' ? { ...file, indexed: true } : file),
      architecture: { ...activeFixture.architecture, nodes: activeFixture.architecture.nodes.map(node => node.id === 'file:test' ? {
        ...node, base: { ...node.base, indexed: true }, head: { ...node.head, indexed: true },
      } : node) },
    };
    await page.getByRole('button', { name: 'Change comparison', exact: true }).click();
    await analyze();
    await expectSubject('Screen.test.tsx');
    await tab('Full file');
    await page.waitForFunction(() => document.querySelector('.workspace-center .file-reader')?.textContent.includes('expect(false)'));
    results.push('Same-descriptor reanalysis preserves the selected test file and its readable source when test inclusion changes.');
    assert.deepEqual(errors, [], 'No client runtime errors');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, submits }, null, 2));
    console.log(JSON.stringify({ results, errors, submits }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    fs.writeFileSync(path.join(output, 'failure.txt'), `${error.stack}\n\n${await page.locator('body').innerText()}`);
    throw error;
  } finally {
    await browser.close();
  }
})();
