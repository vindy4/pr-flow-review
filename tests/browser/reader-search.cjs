// Real reader regressions; only HTTP boundaries are replaced. No GitHub writes.
// PLAYWRIGHT_MODULE=/path/to/playwright PLAYWRIGHT_BROWSERS_PATH=.cache/browsers node tests/browser/reader-search.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const operations = [
  [' ', 'export function searchFixture() {'],
  ['-', '  const obsolete = "BEFORE_ONLY_REMOVED";'],
  ['+', '  const replacement = "AFTER_ONLY_ADDED";'],
  [' ', '  const duplicates = "needle needle";'],
  ['-', '  const changed = "needle";'],
  ['+', '  const changed = "needle"; // AFTER_VERSION'],
  [' ', '  const literal = "invoice.total[0] + tax? (literal).*";'],
  ...Array.from({ length: 130 }, (_, index) => [' ', `  const filler${index + 1} = ${index + 1};`]),
  [' ', '  const distant = "VERTICAL_TARGET";'],
  [' ', `  const long = "${'LONG_SEGMENT '.repeat(160)}HORIZONTAL_TARGET";`],
  [' ', '  return changed;'],
  [' ', '}'],
];
const baseCode = operations.filter(([prefix]) => prefix !== '+').map(([, code]) => code).join('\n') + '\n';
const headCode = operations.filter(([prefix]) => prefix !== '-').map(([, code]) => code).join('\n') + '\n';
const fixtureDiff = [
  'diff --git a/src/search.ts b/src/search.ts',
  'index aaaaaaa..bbbbbbb 100644',
  '--- a/src/search.ts',
  '+++ b/src/search.ts',
  '@@ -1,139 +1,139 @@',
  ...operations.map(([prefix, code]) => prefix + code),
  '',
].join('\n');
const otherCode = 'export const other = "SECOND_FILE_ONLY";\n';
const sources = {
  'src/search.ts': {
    path: 'src/search.ts',
    base: { path: 'src/search.ts', code: baseCode, startLine: 1 },
    head: { path: 'src/search.ts', code: headCode, startLine: 1 },
    diff: fixtureDiff,
  },
  'src/other.ts': {
    path: 'src/other.ts',
    base: { path: 'src/other.ts', code: 'export const other = "old";\n', startLine: 1 },
    head: { path: 'src/other.ts', code: otherCode, startLine: 1 },
    diff: '--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-export const other = "old";\n+export const other = "SECOND_FILE_ONLY";\n',
  },
};
const fixture = {
  meta: {
    analysisId: 'reader-search-fixture', title: 'Reader search regression',
    prUrl: 'https://github.com/fixture/reader/pull/1', number: 1, repository: 'fixture/reader',
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), baseRef: 'main', headRef: 'reader',
    mode: 'github', scopes: ['src'], indexedFiles: 2, changedFiles: 2,
    analyzedAt: '2026-11-02T00:00:00Z', limited: false, includeTests: false,
  },
  nodes: [], edges: [], warnings: [],
  files: [
    { path: 'src/search.ts', status: 'modified', changedMethods: 0, indexed: true },
    { path: 'src/other.ts', status: 'modified', changedMethods: 0, indexed: true },
  ],
};

// A mark inside its scroll container can still be clipped by the reader or window.
function activeGeometryInPage(visibleOnly) {
  const mark = document.querySelector('.file-reader mark.active-search-match');
  const scroll = document.querySelector('.file-code-scroll');
  const reader = document.querySelector('.file-reader');
  if (!mark || !scroll || !reader) return visibleOnly ? false : { missing: true };
  const rect = element => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left, width: bounds.width, height: bounds.height };
  };
  const found = rect(mark);
  const scrollBounds = rect(scroll);
  const readerBounds = rect(reader);
  const windowBounds = { top: 0, right: innerWidth, bottom: innerHeight, left: 0 };
  const clip = {
    top: Math.max(scrollBounds.top + scroll.clientTop, readerBounds.top, 0),
    right: Math.min(scrollBounds.left + scroll.clientLeft + scroll.clientWidth, readerBounds.right, innerWidth),
    bottom: Math.min(scrollBounds.top + scroll.clientTop + scroll.clientHeight, readerBounds.bottom, innerHeight),
    left: Math.max(scrollBounds.left + scroll.clientLeft, readerBounds.left, 0),
  };
  const visible = found.width > 0 && found.height > 0 && found.top >= clip.top - 1 && found.right <= clip.right + 1 && found.bottom <= clip.bottom + 1 && found.left >= clip.left - 1;
  const geometry = { text: mark.textContent, visible, found, clip, scrollBounds, readerBounds, windowBounds, scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft };
  return visibleOnly && !visible ? false : geometry;
}

(async () => {
  const output = process.env.QA_DIR || '.cache/reader-search';
  const appUrl = process.env.APP_URL || 'http://127.0.0.1:8765/';
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  let reviewWrites = 0;
  let currentPage;
  try {
    async function scenario(name, run) {
      const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
      currentPage = page;
      page.setDefaultTimeout(3500);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/')) {
          return url.origin === new URL(appUrl).origin ? route.continue() : route.abort();
        }
        let data;
        if (url.pathname === '/api/health') data = { githubAuthenticated: true, githubMessage: 'Fixture' };
        else if (url.pathname === '/api/analyze') data = { jobId: 'reader-search-fixture' };
        else if (url.pathname === '/api/jobs/reader-search-fixture') data = { id: 'reader-search-fixture', status: 'complete', stage: 'Complete', result: fixture };
        else if (url.pathname === '/api/files/read') {
          const body = request.postDataJSON();
          if (body.analysisId !== fixture.meta.analysisId || !sources[body.path]) {
            errors.push(`Unexpected pinned file read: ${JSON.stringify(body)}`);
            return route.fulfill({ status: 400, json: { error: 'Unexpected fixture file read' } });
          }
          data = sources[body.path];
        } else if (url.pathname === '/api/reviews/context') data = { files: [] };
        else if (url.pathname === '/api/reviews/refresh') data = { baseSha: fixture.meta.baseSha, headSha: fixture.meta.headSha, files: [], comments: [], reviewed: [] };
        else {
          if (url.pathname === '/api/reviews/submit') reviewWrites++;
          errors.push(`Unexpected API request: ${request.method()} ${url.pathname}`);
          return route.fulfill({ status: 403, json: { error: 'All live API calls and review writes are blocked.' } });
        }
        return route.fulfill({ status: 200, json: data });
      });
      try {
        await page.goto(appUrl);
        await page.getByRole('button', { name: 'Analyze flow', exact: true }).click();
        await page.locator('.file-reader .diff-view .code-line').first().waitFor();
        const reader = page.locator('.file-reader');
        const input = reader.getByRole('textbox', { name: 'Find in file', exact: true });
        const searchStatus = reader.locator('.file-find [role="status"]');
        const active = reader.locator('mark.search-match.active-search-match');
        async function search(query, count) {
          await input.fill(query);
          await page.waitForFunction(({ expected }) => document.querySelector('.file-find [role="status"]')?.textContent === expected, { expected: count ? `1 of ${count}` : 'No matches' });
          assert.equal(await reader.locator('mark.search-match').count(), count, 'Every literal occurrence in the displayed code needs its own mark');
          assert.equal(await active.count(), count ? 1 : 0, 'Only the current exact occurrence should be active');
          if (count) assert.equal((await active.innerText()).toLowerCase(), query.toLowerCase(), 'Highlight the exact substring, not its entire line');
        }
        async function tab(name) {
          await reader.getByRole('tab', { name, exact: true }).click();
          await page.waitForFunction(label => [...document.querySelectorAll('.file-reader [role="tab"]')].some(item => item.textContent === label && item.getAttribute('aria-selected') === 'true'), name);
        }
        async function visibleActive() {
          try {
            await page.waitForFunction(activeGeometryInPage, true);
          } catch {
            const geometry = await page.evaluate(activeGeometryInPage, false);
            fs.writeFileSync(path.join(output, 'clipped-active-match.json'), JSON.stringify(geometry, null, 2));
            assert.fail(`The whole active substring must fit the reader's visible viewport: ${JSON.stringify(geometry)}`);
          }
        }
        await run({ page, reader, input, active, searchStatus, search, tab, visibleActive });
        assert.deepEqual(errors, [], 'Reader should not crash or reach an unmocked API boundary');
        results.push({ name, status: 'passed' });
        console.log(`PASS ${name}`);
      } catch (error) {
        const artifact = name.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase();
        await page.screenshot({ path: path.join(output, `${artifact}.png`), fullPage: false });
        results.push({ name, status: 'failed', error: error.message, pageErrors: errors });
        console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        await page.close();
        currentPage = null;
      }
    }

    // Catches the former findNext() switch to Full file, which hid deleted lines.
    await scenario('Diff search preserves Diff and reveals deleted-only text while typing', async ({ reader, input, active, search }) => {
      await input.fill('needle');
      await reader.getByRole('button', { name: 'Find next', exact: true }).click();
      assert.equal(await reader.getByRole('tab', { name: 'Diff', exact: true }).getAttribute('aria-selected'), 'true', 'Searching a diff must keep the displayed Diff tab');
      await search('BEFORE_ONLY_REMOVED', 1);
      assert.equal(await active.locator('xpath=ancestor::*[contains(@class,"code-line")]').getAttribute('data-side'), 'base');
      await search('AFTER_ONLY_ADDED', 1);
      await search('missing literal text', 0);
      await input.fill('');
      assert.equal(await reader.locator('mark.search-match').count(), 0);
    });

    // Four displayed occurrences: two on one context line, one removal, one addition.
    await scenario('Diff counts occurrences and navigates forward and backward', async ({ page, reader, input, active, searchStatus, search }) => {
      await search('needle', 4);
      const marks = reader.locator('mark.search-match');
      const positions = await marks.evaluateAll(items => items.map(item => ({ line: item.closest('.code-line')?.getAttribute('data-source-line'), side: item.closest('.code-line')?.getAttribute('data-side') })));
      assert.deepEqual(positions, [{ line: '3', side: 'head' }, { line: '3', side: 'head' }, { line: '4', side: 'base' }, { line: '4', side: 'head' }]);
      async function index(expected) {
        await page.waitForFunction(wanted => document.querySelector('.file-find [role="status"]')?.textContent === `${wanted} of 4`, expected);
        assert.equal(await marks.evaluateAll(items => items.findIndex(item => item.classList.contains('active-search-match'))), expected - 1);
        assert.equal(await active.innerText(), 'needle');
      }
      await input.press('Enter'); await index(2);
      await reader.getByRole('button', { name: 'Find next', exact: true }).click(); await index(3);
      await input.press('Shift+Enter'); await index(2);
      await reader.getByRole('button', { name: 'Previous match', exact: true }).click(); await index(1);
      await input.press('Shift+Enter'); await index(4);
      assert.equal(await searchStatus.innerText(), '4 of 4');
    });

    // Literal metacharacters must not become a regex, even across syntax spans.
    await scenario('Exact literal search preserves syntax highlighting', async ({ reader, active, search }) => {
      await search('invoice.total[0] + tax? (literal).*', 1);
      await search('INVOICE.TOTAL[0]', 1);
      await search('const literal = "invoice.total[0]', 1);
      assert.equal(await active.innerText(), 'const literal = "invoice.total[0]');
      assert.ok(await reader.locator('.diff-view .syntax-keyword').count() > 0, 'Diff code must retain syntax colors while searching');
    });

    // A stale search target must not survive a mode, snapshot, or file change.
    await scenario('Full file highlights exact occurrences and clears stale snapshot and file results', async ({ page, reader, input, active, searchStatus, search, tab }) => {
      async function cleared() {
        await page.waitForFunction(() => document.querySelector('.file-find input')?.value === '' && document.querySelector('.file-find [role="status"]')?.textContent === '');
        assert.equal(await reader.locator('mark.search-match').count(), 0, 'A new snapshot or file must not retain old search marks');
      }
      await tab('Full file');
      await search('needle', 3);
      await search('AFTER_ONLY_ADDED', 1);
      await reader.getByRole('button', { name: 'Before', exact: true }).click();
      await cleared();
      await search('BEFORE_ONLY_REMOVED', 1);
      await reader.getByRole('button', { name: 'After', exact: true }).click();
      await cleared();
      assert.equal(await active.count(), 0);
      await search('AFTER_ONLY_ADDED', 1);
      await page.locator('.inventory-panel .changed-file-item').filter({ has: page.locator('strong[title="src/other.ts"]') }).click();
      await page.waitForFunction(() => document.querySelector('.file-reader-heading')?.textContent.includes('other.ts') && document.querySelector('.code-view code')?.textContent.includes('SECOND_FILE_ONLY'));
      await cleared();
      assert.equal(await input.inputValue(), '');
      assert.equal(await searchStatus.innerText(), '', 'A different file must not inherit the previous match count');
      await search('SECOND_FILE_ONLY', 1);
      await search('invoice.total[0]', 0);
    });

    // Fails if finding only colors a line while the exact text remains off screen.
    await scenario('Typing reveals distant and long-line matches in Diff and Full file', async ({ page, reader, input, search, tab, visibleActive }) => {
      for (const mode of ['Diff', 'Full file']) {
        await tab(mode);
        const wrap = reader.getByRole('checkbox', { name: 'Wrap long lines', exact: true });
        await wrap.check();
        await reader.locator('.file-code-scroll').evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
        await search('VERTICAL_TARGET', 1); await visibleActive();
        assert.ok(await reader.locator('.file-code-scroll').evaluate(element => element.scrollTop) > 100, `${mode} must reveal the first distant match as soon as the query changes`);
        assert.equal(await input.evaluate(element => element === document.activeElement), true, 'Revealing matches must retain the search field keyboard focus');
        await search('HORIZONTAL_TARGET', 1); await visibleActive();
        await wrap.uncheck();
        await search('VERTICAL_TARGET', 1);
        await reader.locator('.file-code-scroll').evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
        await search('HORIZONTAL_TARGET', 1); await visibleActive();
        assert.ok(await reader.locator('.file-code-scroll').evaluate(element => element.scrollLeft) > 100, `${mode} must horizontally reveal an unwrapped distant-column match`);
      }
      await page.screenshot({ path: path.join(output, 'visible-long-line-search.png'), fullPage: false });
    });

    // Cycling a single occurrence must reveal it again even though its ID is unchanged.
    await scenario('Find next and Enter reveal a single match again after scrolling away', async ({ reader, input, search, tab, visibleActive }) => {
      for (const mode of ['Diff', 'Full file']) {
        await tab(mode);
        await search('VERTICAL_TARGET', 1); await visibleActive();
        await reader.locator('.file-code-scroll').evaluate(element => { element.scrollTop = 0; });
        await reader.getByRole('button', { name: 'Find next', exact: true }).click();
        await visibleActive();
        await reader.locator('.file-code-scroll').evaluate(element => { element.scrollTop = 0; });
        await input.press('Enter');
        await visibleActive();
      }
    });

    // Catches raw patch rendering: copied +/- prefixes, fake numbers and no wrapping.
    await scenario('Diff renders readable syntax with separate markers and real line gutters', async ({ page, reader }) => {
      const diff = reader.locator('.diff-view');
      const deleted = diff.locator('.code-line.deletion').filter({ hasText: 'BEFORE_ONLY_REMOVED' });
      const added = diff.locator('.code-line.addition').filter({ hasText: 'AFTER_ONLY_ADDED' });
      const context = diff.locator('.code-line.context').filter({ hasText: 'const duplicates' });
      assert.equal(await deleted.locator('code').innerText(), '  const obsolete = "BEFORE_ONLY_REMOVED";', 'Copyable code must exclude the diff prefix');
      assert.equal(await added.locator('code').innerText(), '  const replacement = "AFTER_ONLY_ADDED";');
      assert.match(await deleted.locator('.diff-marker').innerText(), /^[-−]$/);
      assert.equal(await added.locator('.diff-marker').innerText(), '+');
      assert.deepEqual(await deleted.locator('.line-number').allTextContents(), ['2', '']);
      assert.deepEqual(await added.locator('.line-number').allTextContents(), ['', '2']);
      assert.deepEqual(await context.locator('.line-number').allTextContents(), ['3', '3']);
      assert.ok(await deleted.locator('code .syntax-keyword').count() > 0, 'Removed code needs the same syntax colors as source code');
      assert.ok(await added.locator('code .syntax-string').count() > 0, 'Added code needs syntax colors');
      assert.doesNotMatch(await diff.innerText(), /--- a\/src|\+\+\+ b\/src|diff --git|index aaaaaaa/, 'Patch metadata must not be rendered as source code');
      const geometry = await diff.locator('.code-line').filter({ hasText: 'HORIZONTAL_TARGET' }).locator('code').evaluate(element => {
        const style = getComputedStyle(element);
        return { height: element.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), whiteSpace: style.whiteSpace, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      });
      assert.ok(['pre-wrap', 'break-spaces'].includes(geometry.whiteSpace), 'Long diff lines must wrap by default');
      assert.ok(geometry.height > geometry.lineHeight * 2, 'The long fixture line must visibly wrap across multiple rows');
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, 'Wrapped code must stay within its available width');
      await page.screenshot({ path: path.join(output, 'readable-diff.png'), fullPage: true });
    });

    assert.equal(reviewWrites, 0, 'Reader regressions must never attempt a real review submission');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, reviewWrites }, null, 2));
    assert.equal(results.filter(result => result.status === 'failed').length, 0, 'Reader search regressions failed; inspect .cache/reader-search/results.json');
  } finally {
    if (currentPage) await currentPage.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
