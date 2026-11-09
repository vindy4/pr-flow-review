// Real relationship and reader components; only external HTTP boundaries are replaced.
// PLAYWRIGHT_MODULE=/path/to/playwright PLAYWRIGHT_BROWSERS_PATH=.cache/browsers node tests/browser/relationship-drawer.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '../..');
const { analysis, sources } = JSON.parse(execFileSync(path.join(project, '.venv/bin/python'), [
  '-c', 'import json; from tests.test_backend_architecture import browser_fixture; print(json.dumps(browser_fixture()))',
], { cwd: project, encoding: 'utf8' }));

const controller = 'app/pension_management/controller/enrollment.py';
const task = 'app/pension_management/tasks/sync.py';
const context = 'app/pension_management/repositories/plan.py';
const removed = 'app/pension_management/removed.py';
const renamed = 'app/pension_management/new_name.py';
const previous = 'app/pension_management/old_name.py';
// Keep the real analyzer's dependency and method graph. Make one dependency
// unchanged and add complete file-boundary variants for inventory-only cases.
analysis.files = analysis.files.filter(file => file.path !== context);
analysis.architecture.nodes.find(file => file.path === context).status = 'unchanged';
sources[context].base = { ...sources[context].head };
sources[context].diff = '';
function addInventoryFile(filePath, status, before, after, previousPath = filePath) {
  const version = snapshotPath => ({ path: snapshotPath, layer: 'supporting', reason: 'Browser boundary fixture',
    roles: ['Supporting'], facts: [], operations: [], indexed: false });
  analysis.files.push({ path: filePath, status, indexed: false, changedMethods: 0,
    ...(previousPath !== filePath ? { previousPath } : {}) });
  analysis.architecture.nodes.push({ id: `file:${filePath}`, path: filePath, label: path.basename(filePath),
    status: status === 'renamed' ? 'moved_modified' : status, symbolIds: [],
    base: before === null ? null : version(previousPath), head: after === null ? null : version(filePath) });
  sources[filePath] = { path: filePath,
    base: before === null ? null : { path: previousPath, code: before + '\n', startLine: 1 },
    head: after === null ? null : { path: filePath, code: after + '\n', startLine: 1 },
    diff: `--- a/${previousPath}\n+++ ${after === null ? '/dev/null' : `b/${filePath}`}\n@@ -1 +${after === null ? '0,0' : '1'} @@\n-${before}\n${after === null ? '' : `+${after}\n`}` };
}
addInventoryFile(removed, 'removed', 'REMOVED_ONLY = "old behavior"', null);
addInventoryFile(renamed, 'renamed', 'RENAMED_VALUE = "before"', 'RENAMED_VALUE = "after"', previous);
analysis.meta.changedFiles = analysis.files.length;
const reviewFiles = [
  { path: task, previousPath: null, baseLines: [1, 2], headLines: [1, 2] },
  { path: removed, previousPath: null, baseLines: [1], headLines: [] },
  { path: renamed, previousPath: previous, baseLines: [1], headLines: [1] },
];

(async () => {
  const output = path.resolve(project, process.env.QA_DIR || '.cache/relationship-drawer');
  const appUrl = process.env.APP_URL || 'http://127.0.0.1:8765/';
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
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return url.origin === new URL(appUrl).origin ? route.continue() : route.abort();
      let data;
      if (url.pathname === '/api/health') data = { githubAuthenticated: true, githubMessage: 'Relationship drawer fixture' };
      else if (url.pathname === '/api/analyze') data = { jobId: 'relationship-drawer' };
      else if (url.pathname === '/api/jobs/relationship-drawer') data = { id: 'relationship-drawer', status: 'complete', stage: 'Complete', result: analysis };
      else if (url.pathname === '/api/files/read') {
        const body = request.postDataJSON();
        assert.equal(body.analysisId, analysis.meta.analysisId);
        assert.ok(sources[body.path], `Unexpected pinned file read: ${body.path}`);
        reads.push(body.path);
        data = sources[body.path];
      } else if (url.pathname === '/api/reviews/context') data = { files: reviewFiles };
      else if (url.pathname === '/api/reviews/refresh') {
        const body = request.postDataJSON();
        data = { baseSha: analysis.meta.baseSha, headSha: analysis.meta.headSha, files: reviewFiles,
          comments: (body.comments || []).map(item => ({ ...item, status: 'ready', reason: '' })),
          reviewed: (body.reviewed || []).map(item => ({ ...item, status: 'ready', reason: '' })) };
      } else {
        if (url.pathname === '/api/reviews/submit') submits++;
        errors.push(`Unexpected API request: ${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 403, json: { error: 'Live requests and review submissions are blocked.' } });
      }
      return route.fulfill({ status: 200, json: data });
    });
    await page.goto(appUrl);
    await page.getByRole('button', { name: 'Analyze flow', exact: true }).click();
    const main = page.locator('.file-review-workspace .workspace-center .file-reader');
    const inventory = page.getByRole('complementary', { name: 'Changed files', exact: true });
    // An expanded code-only reader must not transfer its hidden graph state into Relationships.
    await page.getByRole('button', { name: 'Expand reader', exact: true }).click();
    await main.getByRole('tab', { name: 'Relationships', exact: true }).click();
    const graph = page.getByRole('region', { name: 'File relationship map', exact: true });
    assert.equal(await graph.isVisible(), true, 'Opening Relationships from an expanded code reader must reveal the graph alongside code');
    results.push('Switching from expanded code to Relationships reveals the graph and reader together.');
    async function card(filePath) {
      await graph.locator('.architecture-file-card').filter({ has: page.locator(`strong[title="${filePath}"]`) }).click();
    }
    async function choose(filePath) {
      await inventory.locator('.changed-file-item').filter({ has: page.locator(`strong[title="${filePath}"]`) }).click();
    }
    await card(controller);
    // Catches selecting a graph card replacing the graph, or failing to open code alongside it.
    const drawer = page.getByRole('complementary', { name: 'Code drawer', exact: true });
    assert.equal(await drawer.count(), 1, 'Selecting a relationship file must automatically open its code drawer beside the mounted graph');
    await drawer.waitFor({ state: 'visible' });
    assert.equal(await graph.isVisible(), true, 'Relationships must remain visible alongside code');
    const code = drawer.locator('.file-reader');
    async function selectedTab(name) {
      assert.equal(await code.getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true', `Drawer must display ${name}`);
      assert.equal(await main.getByRole('tab', { name: 'Relationships', exact: true }).getAttribute('aria-selected'), 'true', 'Code actions must keep the main Relationships tab selected');
    }
    async function heading(filePath) {
      await code.locator('.file-reader-heading p').filter({ hasText: filePath }).waitFor();
      assert.equal(await code.locator('.file-reader-heading p').innerText(), filePath);
    }
    async function fullSource(filePath, side = 'head') {
      const expected = sources[filePath][side].code.replace(/\r?\n$/, '').split(/\r?\n/).map(line => line.trimEnd());
      await code.getByRole('region', { name: 'Source code', exact: true }).waitFor();
      assert.deepEqual((await code.locator('.source-code-view code').allTextContents()).map(line => line.trimEnd()), expected, 'Reader must display the complete selected file snapshot');
    }
    async function graphMounted(handle) {
      assert.equal(await handle.evaluate(element => element.isConnected && element === document.querySelector('.architecture-map')), true, 'Drawer actions must retain the same graph DOM and its user viewport');
    }
    async function viewport() { return graph.locator('.react-flow__viewport').getAttribute('style'); }
    await heading(controller);
    await selectedTab('Diff');
    assert.deepEqual(await code.getByRole('tab').allTextContents(), ['Diff', 'Full file'], 'Drawer offers code views only');
    const ids = await page.locator('.file-reader [id]').evaluateAll(elements => elements.map(element => element.id));
    assert.equal(new Set(ids).size, ids.length, 'Simultaneous readers must have unique tab and panel IDs');
    for (const reader of [main, code]) {
      for (const tab of await reader.getByRole('tab').all()) {
        const target = await tab.getAttribute('aria-controls');
        assert.equal(await reader.locator(`[id="${target}"]`).count(), 1, 'Each tab must control a panel inside its own reader');
      }
    }
    results.push('A relationship file card opens a code drawer without replacing the graph.');

    // Catches stale drawer contents or selecting a file leaving the drawer in Full file.
    await card(task);
    await heading(task);
    await selectedTab('Diff');
    await code.getByRole('region', { name: 'File diff', exact: true }).waitFor();
    assert.equal(await code.locator('.diff-view .deletion code').innerText(), '    return False');
    assert.equal(await code.locator('.diff-view .addition code').innerText(), '    return True');
    await code.getByRole('tab', { name: 'Full file', exact: true }).click();
    await fullSource(task);
    await selectedTab('Full file');
    const find = code.getByRole('textbox', { name: 'Find in file', exact: true });
    await find.fill('return True');
    await code.locator('mark.active-search-match').waitFor();
    assert.equal(await code.locator('mark.active-search-match').innerText(), 'return True');
    assert.equal(await code.locator('.file-find [role="status"]').innerText(), '1 of 1');
    await selectedTab('Full file');
    await choose(task);
    await selectedTab('Diff');
    assert.equal(await find.inputValue(), '', 'File selection resets stale source searches');
    results.push('Graph cards and inventory selections update the pinned diff; Full file and search operate within the drawer.');

    // A distinctive user zoom must survive closing, reopening and resizing code.
    await page.waitForTimeout(400); // Finish React Flow's initial fit animation.
    const graphHandle = await graph.elementHandle();
    await graph.locator('.react-flow__controls-zoomin').click();
    await page.waitForTimeout(300); // Finish the user zoom animation.
    const userViewport = await viewport();
    const withDrawer = await graph.boundingBox();
    await drawer.getByRole('button', { name: 'Close code drawer', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    await graphMounted(graphHandle);
    assert.equal(await viewport(), userViewport, 'Closing code must preserve the relationship viewport');
    assert.ok((await graph.boundingBox()).width > withDrawer.width, 'Closing code returns horizontal room to the graph');
    // The selected card must reopen code even though its path has not changed.
    await card(task);
    await drawer.waitFor({ state: 'visible' });
    await selectedTab('Diff');
    await graphMounted(graphHandle);
    assert.equal(await viewport(), userViewport, 'Reopening the same card must preserve the relationship viewport');
    const separator = page.getByRole('separator', { name: 'Resize reader', exact: true });
    const originalWidth = (await drawer.boundingBox()).width;
    await separator.focus();
    await separator.press('Shift+ArrowLeft');
    const wider = (await drawer.boundingBox()).width;
    assert.ok(wider > originalWidth + 10, 'Keyboard resizing must increase the drawer width');
    const dividerBounds = await separator.boundingBox();
    const dividerX = dividerBounds.x + dividerBounds.width / 2;
    const dividerY = dividerBounds.y + dividerBounds.height / 2;
    await page.mouse.move(dividerX, dividerY);
    await page.mouse.down();
    await page.mouse.move(dividerX - 36, dividerY, { steps: 4 });
    await page.mouse.up();
    const draggedWidth = (await drawer.boundingBox()).width;
    assert.ok(draggedWidth > wider + 10, 'Dragging the divider left must increase the drawer width');
    await page.mouse.move(dividerX - 90, dividerY);
    assert.equal((await drawer.boundingBox()).width, draggedWidth, 'Releasing the divider must stop resizing');
    await graphMounted(graphHandle);
    assert.equal(await viewport(), userViewport, 'Resizing code must preserve the graph viewport');
    const graphBounds = await graph.boundingBox();
    const drawerBounds = await drawer.boundingBox();
    assert.ok(graphBounds.x + graphBounds.width <= drawerBounds.x + 1, 'Wide layouts must place code alongside the graph');
    assert.ok(graphBounds.width > 200 && drawerBounds.width >= 360, 'Both graph and code need usable space');
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('flowreview:review-panel-widths:v2'))?.right >= 360), 'Review drawer widths use the dedicated versioned storage key');
    await page.getByRole('button', { name: 'Hide reader', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Show reader', exact: true }).click();
    await drawer.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Expand reader', exact: true }).click();
    await graphMounted(graphHandle);
    await page.getByRole('button', { name: 'Restore layout', exact: true }).click();
    await drawer.waitFor({ state: 'visible' });
    assert.equal(await graph.isVisible(), true);
    await page.screenshot({ path: path.join(output, 'relationships-and-diff.png'), fullPage: false });
    results.push('Close, same-card reopen, toolbar visibility, expansion, keyboard and pointer resize preserve graph DOM and viewport.');

    // An unchanged dependency needs its honest empty diff plus a route to source.
    await choose(controller);
    await card(context);
    await heading(context);
    await selectedTab('Diff');
    await code.getByText('No textual changes in this file.', { exact: true }).waitFor();
    await code.getByRole('button', { name: 'Read full file', exact: true }).click();
    await fullSource(context);
    await selectedTab('Full file');
    results.push('Unchanged relationship context shows an empty diff and can open its full source.');

    // Method and call evidence jumps must reveal source while retaining Relationships.
    await choose(controller);
    await inventory.locator('.inventory-method').filter({ has: page.locator('strong[title="enroll"]') }).click();
    await heading(controller);
    await selectedTab('Full file');
    await fullSource(controller);
    assert.equal(await code.locator('.source-code-view .code-line.highlight').getAttribute('data-source-line'), '8');
    assert.equal(await graph.isVisible(), true);
    await main.getByRole('combobox', { name: 'Graph detail', exact: true }).selectOption('functions');
    const calls = main.getByRole('region', { name: 'Source call graph', exact: true });
    const callHandle = await calls.elementHandle();
    const call = analysis.edges.find(edge => edge.source === `${controller}:enroll` && edge.target.endsWith(':load_role'));
    async function clickCall(edge) {
      await calls.locator(`.react-flow__edge[data-id="${edge.id}"]`).waitFor();
      await page.waitForTimeout(450); // Finish the method graph's initial fit animation.
      // An SVG edge's bounding-box center can be a node. Click an exposed point
      // on the actual edge stroke, as a user would, without forced event delivery.
      const point = await calls.locator(`.react-flow__edge[data-id="${edge.id}"]`).evaluate(element => {
        const stroke = element.querySelector('.react-flow__edge-interaction');
        if (!stroke) return null;
        for (const fraction of [0.5, 0.25, 0.75, 0.1, 0.9, 0.35, 0.65]) {
          const position = stroke.getPointAtLength(stroke.getTotalLength() * fraction).matrixTransform(stroke.getScreenCTM());
          if (element.contains(document.elementFromPoint(position.x, position.y))) return { x: position.x, y: position.y };
        }
        return null;
      });
      assert.ok(point, 'A relationship edge must have a visible clickable source-evidence segment');
      await page.mouse.click(point.x, point.y);
    }
    await clickCall(call);
    await heading(controller);
    await selectedTab('Full file');
    assert.equal(await code.locator('.source-code-view .code-line.highlight').getAttribute('data-source-line'), '13');
    assert.equal(await callHandle.evaluate(element => element.isConnected), true, 'Opening call evidence must keep the method graph mounted');
    assert.equal(await calls.isVisible(), true);

    // Cross-file evidence must add one history visit, without duplicating its origin.
    await choose(task);
    await heading(task);
    const incoming = analysis.edges.find(edge => edge.source === `${controller}:enroll` && edge.target === `${task}:sync_plan`);
    await clickCall(incoming);
    await heading(controller);
    await selectedTab('Full file');
    assert.equal(await code.locator('.source-code-view .code-line.highlight').getAttribute('data-source-line'), '12');
    const previousFile = page.getByRole('button', { name: 'Previous file', exact: true });
    const nextFile = page.getByRole('button', { name: 'Next visited file', exact: true });
    await previousFile.click();
    await heading(task);
    await nextFile.click();
    await heading(controller);
    await previousFile.click();
    await heading(task);
    await previousFile.click();
    assert.equal(await code.locator('.file-reader-heading p').innerText(), controller, 'A cross-file evidence jump must create exactly one visit: two Back actions return to the file visited before its origin');
    await nextFile.click();
    await heading(task);
    await nextFile.click();
    await heading(controller);
    await selectedTab('Full file');
    await main.getByRole('combobox', { name: 'Graph detail', exact: true }).selectOption('files');
    results.push('Inventory method and function-edge jumps reveal exact source lines, retain Relationships and add only one cross-file history visit.');

    // Removed and moved files remain readable through inventory even without head nodes.
    await choose(removed);
    await heading(removed);
    await selectedTab('Diff');
    assert.equal(await code.locator('.diff-view .deletion code').innerText(), 'REMOVED_ONLY = "old behavior"');
    await code.getByRole('tab', { name: 'Full file', exact: true }).click();
    await fullSource(removed, 'base');
    await code.getByRole('button', { name: 'After', exact: true }).click();
    await code.getByText('File absent after this change.', { exact: true }).waitFor();
    await code.getByRole('button', { name: 'Read Before file', exact: true }).click();
    await fullSource(removed, 'base');
    await choose(renamed);
    await heading(renamed);
    await selectedTab('Diff');
    assert.equal(await code.locator('.reader-rename').innerText(), `Moved from ${previous}`);
    assert.equal(await code.locator('.diff-view .deletion code').innerText(), 'RENAMED_VALUE = "before"');
    assert.equal(await code.locator('.diff-view .addition code').innerText(), 'RENAMED_VALUE = "after"');

    // Drawer duplication must never mis-anchor Before/After comments, including old paths.
    const draftBodies = [];
    for (const [side, sideName, anchorPath] of [['base', 'Before', previous], ['head', 'After', renamed]]) {
      await code.getByRole('button', { name: `Comment on ${sideName} line 1`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Draft comment', exact: true });
      assert.equal(await dialog.locator('.comment-anchor code').innerText(), anchorPath);
      assert.match(await dialog.innerText(), new RegExp(`${sideName} · line 1`));
      const body = `Drawer ${side} anchor regression`;
      draftBodies.push(body);
      await dialog.getByRole('textbox', { name: 'Comment text', exact: true }).fill(body);
      await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    const drafts = await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes(':comment:')).map(key => JSON.parse(localStorage.getItem(key))));
    assert.deepEqual(drafts.filter(draft => draftBodies.includes(draft.body)).map(({ path, side, line, body }) => ({ path, side, line, body })).sort((a, b) => a.side.localeCompare(b.side)), [
      { path: previous, side: 'base', line: 1, body: draftBodies[0] },
      { path: renamed, side: 'head', line: 1, body: draftBodies[1] },
    ], 'Saved drafts must retain the exact snapshot path, side and source line from the drawer');
    results.push('Removed and renamed inventory files retain source snapshots and exact Before/After draft anchors without submitting.');

    // On smaller screens the close control and reader must stay inside the window.
    await choose(task);
    await selectedTab('Diff');
    await page.setViewportSize({ width: 760, height: 980 });
    await drawer.waitFor({ state: 'visible' });
    const close = drawer.getByRole('button', { name: 'Close code drawer', exact: true });
    const closeBounds = await close.boundingBox();
    assert.ok(closeBounds && closeBounds.x >= 0 && closeBounds.y >= 0 && closeBounds.x + closeBounds.width <= 761 && closeBounds.y + closeBounds.height <= 980, 'Narrow drawer must keep its close button fully reachable');
    assert.ok((await code.boundingBox()).width >= 300, 'Narrow code must retain readable width');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Narrow drawer must not create page-level horizontal overflow');
    await page.screenshot({ path: path.join(output, 'narrow-code-drawer.png'), fullPage: false });
    await close.click();
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(await graph.isVisible(), true, 'Closing narrow code returns immediately to Relationships');
    await page.setViewportSize({ width: 1720, height: 1100 });
    await main.getByRole('tab', { name: 'Diff', exact: true }).click();
    assert.equal(await page.locator('.file-reader:visible').count(), 1, 'Ordinary Diff mode uses one reader');
    await main.getByRole('tab', { name: 'Full file', exact: true }).click();
    assert.equal(await page.locator('.file-reader:visible').count(), 1, 'Ordinary Full file mode uses one reader');
    assert.equal(await main.getByRole('tab', { name: 'Full file', exact: true }).getAttribute('aria-selected'), 'true');
    results.push('Narrow code stays readable with a reachable close button and no horizontal page overflow; ordinary code modes remain single-reader.');
    assert.deepEqual(errors, [], 'No runtime errors or unmocked API boundaries');
    assert.equal(submits, 0, 'Browser regression must never submit a review');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, submits, reads }, null, 2));
    console.log(JSON.stringify({ results, errors, submits }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false });
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, submits, reads, failure: error.message }, null, 2));
    fs.writeFileSync(path.join(output, 'failure.txt'), `${error.stack}\n\n${await page.locator('body').innerText()}`);
    throw error;
  } finally {
    await browser.close();
  }
})();
