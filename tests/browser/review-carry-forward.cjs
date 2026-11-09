// Real React UI; all GitHub boundaries are mocked, including every submission.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40), E = 'e'.repeat(40);
const prUrl = 'https://github.com/a/b/pull/1';
const draftKey = head => `flowreview:drafts:a/b:1:${A}:${head}`;
const progressKey = head => `flowreview:reviewed:a/b:1:${A}:${head}`;
const paths = ['src/Safe.tsx', 'src/Changed.tsx', 'src/Before.tsx'];
const code = 'export const result = 2;\n';
const diff = '@@ -1 +1 @@\n-export const result = 1;\n+export const result = 2;\n';
const fixture = {
  meta: { analysisId: 'carry-fixture', title: 'Carry-forward regression', prUrl, number: 1, repository: 'a/b',
    baseSha: A, headSha: C, baseRef: 'main', headRef: 'feature', mode: 'github', scopes: ['src'],
    indexedFiles: 0, changedFiles: paths.length, analyzedAt: '2026-11-01T00:00:00Z', limited: false, includeTests: false },
  nodes: [], edges: [], warnings: [], files: paths.map(path => ({ path, status: 'modified', changedMethods: 0, indexed: false })),
};
function draft(id, path, body, side = 'head') { return { id, path, body, side, line: 1, code }; }
function seeded(records = []) {
  return Object.fromEntries(records.map(([head, record]) => [draftKey(head) + ':comment:' + record.id, JSON.stringify(record)]));
}
const ready = draft('ready-old', paths[0], 'Keep the safe comment');
const changed = draft('changed-old', paths[1], 'Changed code needs attention');
const before = draft('before-current', paths[2], 'Check the Before side', 'base');
const results = [], errors = [], submits = [];

(async () => {
  fs.mkdirSync('.cache/review-carry-work', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  async function open({ storage = {}, refreshError = false, submitError = false, delaySubmit = false, latest = D, displayed = C, loseSubmission = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, storage);
    const state = { refreshError, submitError, latest, displayed, refreshes: [], submitBodies: [], release: null, delaySubmit, loseSubmission };
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
      let data;
      if (url.pathname === '/api/health') data = { githubAuthenticated: true, githubMessage: 'Mocked GitHub' };
      else if (url.pathname === '/api/analyze') data = { jobId: 'carry' };
      else if (url.pathname === '/api/jobs/carry') data = { id: 'carry', status: 'complete', result: { ...fixture, meta: { ...fixture.meta, headSha: state.displayed } } };
      else if (url.pathname === '/api/files/read') data = { path: body.path, base: { path: body.path, code: code.replace('2', '1'), startLine: 1 }, head: { path: body.path, code, startLine: 1 }, diff };
      else if (url.pathname === '/api/reviews/context') return route.fulfill({ status: 409, json: { error: 'The displayed comparison has older commits. Drafts are saved.' } });
      else if (url.pathname === '/api/reviews/refresh') {
        state.refreshes.push(body);
        if (state.refreshError) return route.fulfill({ status: 502, json: { error: 'Could not verify current files. Your drafts are preserved.' } });
        data = { baseSha: A, headSha: state.latest,
          files: paths.map(path => ({ path, previousPath: null, baseLines: [1], headLines: [1] })),
          comments: (body.comments || []).map(item => ({ ...item, status: item.path === paths[1] ? 'needs_attention' : 'ready',
            reason: item.path === paths[1] ? 'File content changed. Review this comment against the latest code.' : 'File content is unchanged.' })),
          reviewed: (body.reviewed || []).map(item => ({ id: item.id, path: item.path, status: item.path === paths[1] ? 'needs_attention' : 'ready',
            reason: item.path === paths[1] ? 'File content changed.' : 'Both sides are unchanged.' })) };
      } else if (url.pathname === '/api/reviews/submit') {
        submits.push(body); state.submitBodies.push(body);
        if (state.delaySubmit) await new Promise(resolve => { state.release = resolve; });
        if (state.loseSubmission) { state.loseSubmission = false; return route.abort('failed'); }
        if (state.submitError) return route.fulfill({ status: 409, json: { error: 'The PR changed again. Drafts are preserved.', ambiguous: false } });
        data = { id: 1, url: prUrl + '#pullrequestreview-mock' };
      } else throw new Error(`Unexpected API call: ${url.pathname}`);
      await route.fulfill({ status: 200, json: data });
    });
    await page.goto(process.env.APP_URL || 'http://127.0.0.1:8765/');
    async function analyze() {
      const change = page.getByRole('button', { name: 'Change comparison', exact: true });
      if (await change.count()) await change.click();
      await page.getByRole('button', { name: 'Analyze flow', exact: true }).click();
      await page.getByRole('button', { name: 'Change comparison', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Mark reviewed', exact: true }).or(page.getByRole('button', { name: 'Mark unreviewed', exact: true })).waitFor();
    }
    await analyze();
    async function queue() {
      await page.getByRole('button', { name: /Review drafts \(/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Review drafts', exact: true });
      await dialog.waitFor(); return dialog;
    }
    return { context, page, state, analyze, queue };
  }
  try {
    // Old versions may use the same opaque local draft id as another snapshot.
    const duplicateId = { ...before, id: ready.id };
    const first = await open({ storage: { ...seeded([[B, ready], [B, changed], [C, duplicateId]]), [draftKey(C) + ':summary']: 'Summary kept for remaining drafts' }, delaySubmit: true });
    const dialog = await first.queue();
    await dialog.getByText(/2 ready.*1 needs attention/i).waitFor();
    assert.equal(first.state.submitBodies.length, 0, 'Opening preview must never submit a review');
    await dialog.getByRole('button', { name: /Submit ready comments/i }).click();
    while (!first.state.release) await first.page.waitForTimeout(20);
    assert.equal(first.state.submitBodies.length, 1);
    const outgoing = first.state.submitBodies[0];
    assert.equal(outgoing.headSha, D, 'Submission must use the latest verified commit, even while reading an older analysis');
    assert.deepEqual(outgoing.comments.map(c => c.body).sort(), [ready.body, before.body].sort());
    assert.equal(outgoing.comments.find(c => c.body === before.body).side, 'base');
    assert.ok(first.state.refreshes.filter(r => r.comments?.length).length >= 2, 'Explicit submit must refresh again');
    // Concurrent replacement arrives while submission is pending; only sent versions can be cleared.
    const replacement = { ...ready, id: 'ready-concurrent-edit', replaces: ready.id, body: 'Concurrent edit must remain' };
    await first.page.evaluate(({ key, replacement }) => {
      const name = key + ':comment:' + replacement.id;
      localStorage.setItem(name, JSON.stringify(replacement));
      window.dispatchEvent(new StorageEvent('storage', { key: name, newValue: JSON.stringify(replacement) }));
    }, { key: draftKey(B), replacement });
    first.state.release();
    await dialog.getByText('Review submitted.', { exact: false }).waitFor();
    const after = await first.page.evaluate(() => ({ ...localStorage }));
    assert.ok(after[draftKey(B) + ':deleted:' + ready.id], 'Old submitted record must be cleared at its origin');
    assert.ok(after[draftKey(C) + ':deleted:' + duplicateId.id], 'Same local id in current snapshot must have its own cleanup');
    assert.ok(!after[draftKey(B) + ':deleted:' + changed.id], 'Attention records must remain');
    assert.ok(!after[draftKey(B) + ':deleted:' + replacement.id], 'Concurrent edits must remain');
    assert.equal(after[draftKey(C) + ':summary'], 'Summary kept for remaining drafts');
    await dialog.getByText(replacement.body, { exact: true }).waitFor();
    await first.page.screenshot({ path: '.cache/review-carry-work/mixed-review.png', fullPage: true });
    await first.page.setViewportSize({ width: 360, height: 900 });
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Draft actions and statuses must fit a narrow dialog');
    await first.page.screenshot({ path: '.cache/review-carry-work/mixed-review-mobile.png', fullPage: true });
    results.push('Mixed old/current drafts refresh automatically, submit only ready comments at latest SHAs, and clean only original submitted versions.');
    await first.context.close();

    const failed = await open({ storage: seeded([[B, ready]]), refreshError: true });
    const failedDialog = await failed.queue();
    await failedDialog.getByText(/Could not verify current files/).waitFor();
    assert.equal(failed.state.submitBodies.length, 0);
    assert.ok(await failedDialog.getByRole('button', { name: /Submit/ }).isDisabled());
    failed.state.refreshError = false;
    await failedDialog.getByRole('button', { name: 'Refresh drafts', exact: true }).click();
    await failedDialog.getByText(/1 ready.*0 need attention/i).waitFor();
    failed.state.submitError = true;
    await failedDialog.getByRole('button', { name: /Submit/ }).click();
    await failedDialog.getByText(/The PR changed again/).waitFor();
    assert.equal(await failed.page.evaluate(key => localStorage.getItem(key + ':deleted:ready-old'), draftKey(B)), null);
    failed.state.submitError = false; failed.state.latest = E;
    await failedDialog.getByRole('button', { name: /Submit/ }).click();
    await failedDialog.getByText('Review submitted.', { exact: false }).waitFor();
    assert.deepEqual(failed.state.submitBodies.map(body => body.headSha), [D, E]);
    results.push('Failed refresh and racing submission preserve drafts; an explicit retry verifies the newest commits again.');
    await failed.context.close();

    const recovery = await open({ storage: seeded([[B, ready]]), loseSubmission: true });
    const recoveryDialog = await recovery.queue();
    await recoveryDialog.getByText(/1 ready.*0 need attention/i).waitFor();
    await recoveryDialog.getByRole('button', { name: 'Submit review', exact: true }).click();
    await recoveryDialog.getByRole('button', { name: 'Confirm previous submission', exact: true }).waitFor();
    const originalPayload = recovery.state.submitBodies[0];
    assert.ok(await recovery.page.evaluate(() => localStorage.getItem('flowreview:drafts:a/b:1:pending-submit')));
    recovery.state.latest = E;
    await recovery.page.reload();
    await recovery.analyze();
    const recoveredDialog = await recovery.queue();
    await recoveredDialog.getByRole('button', { name: 'Confirm previous submission', exact: true }).click();
    await recoveredDialog.getByText('Review submitted.', { exact: false }).waitFor();
    assert.deepEqual(recovery.state.submitBodies, [originalPayload, originalPayload], 'Lost-response recovery must replay the exact receipt payload even after commits change');
    assert.equal(await recovery.page.evaluate(() => localStorage.getItem('flowreview:drafts:a/b:1:pending-submit')), null);
    results.push('Lost-response recovery survives reload and uses the exact previous receipt, preventing a duplicate review after unrelated commits.');
    await recovery.context.close();

    const bulkRecords = Array.from({ length: 51 }, (_, i) => [B, { ...ready, id: `bulk-${i}`, body: `Ready comment ${i}` }]);
    const bulk = await open({ storage: seeded(bulkRecords) });
    const bulkDialog = await bulk.queue();
    await bulkDialog.getByRole('button', { name: 'Submit 50 ready comments', exact: true }).click();
    await bulkDialog.getByText('Review submitted.', { exact: false }).waitFor();
    assert.equal(bulk.state.submitBodies.length, 1);
    assert.equal(bulk.state.submitBodies[0].comments.length, 50);
    await bulk.page.waitForFunction(() => document.querySelectorAll('dialog .draft-item').length === 1);
    results.push('Large queues submit at most 50 comments per explicit review and retain the remainder.');
    await bulk.context.close();

    const viewed = await open({ storage: { [progressKey(B)]: JSON.stringify([paths[0], paths[1]]) }, latest: C });
    await viewed.page.getByRole('button', { name: 'Mark unreviewed', exact: true }).waitFor();
    await viewed.page.waitForFunction(key => JSON.stringify(JSON.parse(localStorage.getItem(key))) === JSON.stringify(['src/Safe.tsx']), progressKey(C));
    await viewed.page.getByRole('button', { name: 'Mark unreviewed', exact: true }).click();
    await viewed.analyze();
    await viewed.page.getByRole('button', { name: 'Mark reviewed', exact: true }).waitFor();
    assert.deepEqual(await viewed.page.evaluate(key => JSON.parse(localStorage.getItem(key)), progressKey(C)), []);
    viewed.state.latest = D; viewed.state.displayed = D;
    await viewed.analyze();
    await viewed.page.waitForFunction(key => localStorage.getItem(key) !== null, progressKey(D));
    assert.equal(await viewed.page.getByRole('button', { name: 'Mark reviewed', exact: true }).count(), 1, 'Explicit unmark must remain unreviewed through later unrelated commits');
    await viewed.page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
    viewed.state.latest = E; viewed.state.displayed = E;
    await viewed.analyze();
    await viewed.page.getByRole('button', { name: 'Mark unreviewed', exact: true }).waitFor();
    results.push('Viewed markers carry for unchanged comparisons, reset changed files, and preserve explicit unmark/re-mark choices through later commits.');
    await viewed.context.close();

    const stale = await open({ storage: { [progressKey(B)]: JSON.stringify([paths[0]]) }, latest: D });
    await stale.page.waitForTimeout(200);
    assert.equal(await stale.page.getByRole('button', { name: 'Mark reviewed', exact: true }).count(), 1, 'Latest-state verification cannot mark a different displayed comparison reviewed');
    results.push('Viewed refresh refuses to apply results for a newer comparison than the one displayed.');
    await stale.context.close();
    assert.deepEqual(errors, []);
    fs.writeFileSync('.cache/review-carry-work/browser-results.json', JSON.stringify({ results, errors, mockedSubmits: submits.length, liveSubmits: 0 }, null, 2));
    process.stdout.write(JSON.stringify({ results, errors, mockedSubmits: submits.length, liveSubmits: 0 }, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
