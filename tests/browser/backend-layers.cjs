// Real Python analyzer output; only HTTP boundaries are replaced. No GitHub writes.
// Run with PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser/backend-layers.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '../..');
const { analysis, sources } = JSON.parse(execFileSync(path.join(project, '.venv/bin/python'), [
  '-c', 'import json; from tests.test_backend_architecture import browser_fixture; print(json.dumps(browser_fixture()))',
], { cwd: project, encoding: 'utf8' }));
const architecture = analysis.architecture;
const approvedLabels = ['APIs & routing', 'Authorization', 'Business logic & rules', 'Data & persistence',
  'Jobs & workflows', 'Integrations & delivery', 'Reporting & projections', 'Operations & migrations'];
const backendLayers = architecture.layers.filter(layer => layer.id.startsWith('backend_'));
assert.deepEqual(backendLayers.map(layer => layer.label), approvedLabels, 'Analyzer must provide the eight backend layers');
const fileFor = layer => architecture.nodes.find(file => file.head?.layer === layer);
for (const layer of backendLayers) assert.ok(fileFor(layer.id), `Fixture must exercise ${layer.label}`);
const permissions = fileFor('backend_auth');
const business = fileFor('backend_logic');
const integration = fileFor('backend_integrations');
const currentFiles = architecture.nodes.filter(file => file.head);
const currentIds = new Set(currentFiles.map(file => file.id));
const currentEdges = architecture.edges.filter(edge => edge.inHead && edge.relation !== 'imports'
  && currentIds.has(edge.source) && currentIds.has(edge.target));
const labelsFor = files => architecture.layers.filter(layer => files.some(file => file.head?.layer === layer.id)).map(layer => layer.label);
function connectedFiles(file) {
  const edges = currentEdges.filter(edge => edge.source === file.id || edge.target === file.id);
  const ids = new Set([file.id, ...edges.flatMap(edge => [edge.source, edge.target])]);
  return currentFiles.filter(item => ids.has(item.id));
}

(async () => {
  const output = path.resolve(project, process.env.QA_DIR || '.cache/backend-layers');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1720, height: 1100 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  const results = [];
  const reads = [];
  let submits = 0;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let data;
      if (url.pathname === '/api/reviews/submit') {
        submits++;
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Browser regression does not submit reviews.' }) });
      }
      if (url.pathname === '/api/health') data = { githubAuthenticated: true, githubMessage: 'Analyzer fixture' };
      else if (url.pathname === '/api/analyze') data = { jobId: 'backend-layers' };
      else if (url.pathname === '/api/jobs/backend-layers') data = { id: 'backend-layers', status: 'complete', stage: 'Complete', result: analysis };
      else if (url.pathname === '/api/files/read') {
        const body = route.request().postDataJSON();
        assert.equal(body.analysisId, analysis.meta.analysisId, 'Reader must use the analyzed snapshot');
        data = sources[body.path];
        assert.ok(data, `Unexpected file read: ${body.path}`);
        reads.push(body.path);
      } else if (url.pathname === '/api/reviews/context') data = { files: [] };
      else if (url.pathname === '/api/reviews/refresh') {
        const body = route.request().postDataJSON();
        data = { baseSha: analysis.meta.baseSha, headSha: analysis.meta.headSha, files: [],
          comments: (body.comments || []).map(item => ({ ...item, status: 'ready', reason: '' })),
          reviewed: (body.reviewed || []).map(item => ({ ...item, status: 'ready', reason: '' })) };
      } else throw new Error(`Unexpected network boundary: ${url.pathname}`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto('http://127.0.0.1:8765/');
    await page.getByRole('button', { name: 'Analyze flow', exact: true }).click();
    await page.getByRole('button', { name: 'Change comparison', exact: true }).waitFor();
    const inventory = page.locator('.inventory-panel');
    const reader = page.locator('.workspace-center .file-reader');
    async function subject(file) {
      await page.waitForFunction(expected => document.querySelector('.review-subject-file strong')?.textContent === expected,
        path.basename(file.path));
      const selected = inventory.locator('.changed-file-item[aria-current="true"] strong');
      assert.equal(await selected.getAttribute('title'), file.path, 'Inventory and reader must select the same file');
    }
    async function choose(file) {
      await inventory.locator('.changed-file-item').filter({ has: page.locator(`strong[title="${file.path}"]`) }).click();
      await subject(file);
    }
    async function tab(name) {
      await reader.getByRole('tab', { name, exact: true }).click();
      assert.equal(await reader.getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true');
    }
    async function sourceIs(file, side = 'head') {
      const expected = sources[file.path][side].code.replace(/\r?\n$/, '').split(/\r?\n/).map(line => line.trimEnd());
      await page.waitForFunction(lines => JSON.stringify([...document.querySelectorAll('.workspace-center .file-reader .source-code-view code')]
        .map(code => code.textContent.trimEnd())) === JSON.stringify(lines), expected);
    }
    async function graph(files, focus = null) {
      await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.architecture-map .react-flow__node')]
        .filter(node => !node.dataset.id.startsWith('layer:')).map(node => node.dataset.id).sort()) === JSON.stringify(expected), files.map(file => file.id).sort());
      assert.deepEqual(await reader.locator('.architecture-layer-label').allTextContents(), labelsFor(files),
        'Graph headings must follow architecture order and omit empty layers');
      assert.ok((await reader.locator('.architecture-layer-label').allTextContents()).every(label => label.trim()), 'Every visible layer needs a heading');
      const visibleIds = new Set(files.map(file => file.id));
      const edges = currentEdges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)
        && (!focus || edge.source === focus.id || edge.target === focus.id));
      const pairs = new Set(edges.map(edge => `${edge.source}|${edge.target}`));
      // React Flow measures node handles before rendering their connections.
      await page.waitForFunction(count => document.querySelectorAll('.workspace-center .file-reader .react-flow__edge').length === count, pairs.size);
      // Connections can bundle several source relationships into one arrow.
      const rendered = await reader.locator('.react-flow__edge').evaluateAll(items => items.map(item => item.dataset.id));
      assert.equal(rendered.length, pairs.size);
      for (const id of rendered) assert.ok(edges.some(edge => edge.id === id), 'Graph must contain current source edges only');
    }
    const initial = architecture.nodes.find(file => file.path === analysis.files[0].path);
    await subject(initial);
    await tab('Full file');
    await sourceIs(initial);
    results.push('Initial file selection and full source come from the real Python analyzer fixture.');
    assert.equal(await inventory.getByRole('combobox', { name: 'Group files by', exact: true }).inputValue(), 'layer');
    const changedPaths = new Set(analysis.files.map(file => file.path));
    const inventoryLabels = labelsFor(currentFiles.filter(file => changedPaths.has(file.path)));
    assert.deepEqual(await inventory.locator('.file-group-label').allTextContents(), inventoryLabels);
    assert.equal(inventoryLabels.at(-1), architecture.layers.find(layer => layer.id === 'supporting').label, 'Supporting files must follow backend layers');
    assert.equal(await inventory.locator('.changed-file-item').count(), analysis.files.length);
    results.push('Group by layer shows all eight backend lanes in architecture order, with supporting files last.');
    await tab('Relationships');
    await graph(connectedFiles(initial), initial);
    await choose(permissions);
    const permissionFiles = connectedFiles(permissions);
    assert.ok(permissionFiles.some(file => file.id === business.id), 'Permissions fixture must retain its real caller');
    assert.ok(permissionFiles.some(file => file.id === integration.id), 'Permissions fixture must retain its HRIS dependency');
    await graph(permissionFiles, permissions);
    assert.match(await reader.innerText(), /Authorization/);
    assert.match(await reader.innerText(), /checks permission/);
    assert.match(await reader.innerText(), /calls integration/);
    assert.equal(await reader.getByRole('button', { name: /^(Before|Changes|After|Overlay)$/ }).count(), 0);
    await tab('Full file');
    await reader.getByRole('button', { name: 'Before', exact: true }).click();
    await sourceIs(permissions, 'base');
    await tab('Relationships');
    await graph(permissionFiles, permissions);
    await page.getByRole('button', { name: 'Fit relationship map', exact: true }).click();
    await page.waitForTimeout(350); // Allow React Flow's fit animation to settle for visual QA.
    await page.screenshot({ path: path.join(output, 'permissions-relationships.png'), fullPage: true });
    results.push('Permission relationships show Authorization, the business caller and HRIS integration, including after reading Before source.');
    await reader.getByRole('combobox', { name: 'Relationship scope', exact: true }).selectOption('all');
    const allChanged = currentFiles.filter(file => file.status !== 'unchanged');
    await graph(allChanged);
    for (const label of approvedLabels) assert.ok((await reader.locator('.architecture-layer-label').allTextContents()).includes(label));
    results.push('All changed files exposes all eight populated backend lanes and current source connections.');
    await reader.getByRole('combobox', { name: 'Relationship scope', exact: true }).selectOption('file');
    await graph(permissionFiles, permissions);
    await reader.locator(`.react-flow__node[data-id="${integration.id}"] .architecture-file-card`).click();
    await subject(integration);
    await tab('Full file');
    await reader.getByRole('button', { name: 'After', exact: true }).click();
    await sourceIs(integration);
    assert.ok(reads.includes(integration.path));
    results.push('Selecting an integration graph node opens that file in the shared reader.');
    const supporting = currentFiles.filter(file => file.head.layer === 'supporting');
    assert.ok(supporting.some(file => file.path.endsWith('.md')) && supporting.some(file => /\/tests\//.test(file.path)));
    for (const file of supporting) {
      await choose(file);
      await tab('Full file');
      await sourceIs(file);
    }
    results.push('Excluded tests and documentation stay selectable and readable.');
    assert.deepEqual(errors, [], 'No browser runtime errors');
    assert.equal(submits, 0, 'No review submissions');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, submits, reads }, null, 2));
    console.log(JSON.stringify({ results, errors, submits }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    fs.writeFileSync(path.join(output, 'failure.txt'), `${error.stack}\n\n${await page.locator('body').innerText()}`);
    throw error;
  } finally {
    await browser.close();
  }
})();
