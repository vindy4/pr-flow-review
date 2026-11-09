// Run with node --test tests/review-progress.cjs; keep storage/session logic real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const helper = path.join(__dirname, '../frontend/review-progress.ts');
const createReviewProgress = fs.existsSync(helper) ? require(helper).createReviewProgress : undefined;
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), OLD_BASE = 'c'.repeat(40), OLD_HEAD = 'd'.repeat(40);
const TARGET = `flowreview:reviewed:a/b:1:${BASE}:${HEAD}`;
const OLD = `flowreview:reviewed:a/b:1:${OLD_BASE}:${OLD_HEAD}`;
function storage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function comparison(extra = {}) {
  return { meta: { repository: 'a/b', number: 1, analysisId: 'fixture', baseSha: BASE, headSha: HEAD,
    mode: 'github', prUrl: 'https://github.com/a/b/pull/1', ...extra },
    files: [{ path: 'unchanged.ts' }, { path: 'changed.ts' }, { path: 'renamed.ts', previousPath: 'old.ts' }] };
}
function session(store, extra) {
  assert.equal(typeof createReviewProgress, 'function', 'Viewed progress must validate previous snapshots before automatic carry-forward');
  return createReviewProgress(comparison(extra), store);
}
function response(request, statuses = {}) {
  return { baseSha: BASE, headSha: HEAD, files: [], comments: [], reviewed: request.reviewed.map(item => ({
    id: item.id, status: statuses[item.path]?.status || 'ready', path: statuses[item.path]?.path || item.path,
    reason: statuses[item.path]?.status === 'needs_attention' ? 'File content changed' : '',
  })) };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('carries only backend-verified displayed files, preserving each origin comparison and rename', async () => {
  const store = storage({ [OLD]: JSON.stringify(['unchanged.ts', 'changed.ts', 'old.ts', 'out-of-scope.ts']),
    [`flowreview:reviewed:another/repo:1:${OLD_BASE}:${OLD_HEAD}`]: '["other.ts"]',
    [`${OLD}:summary`]: '["other.ts"]' });
  const progress = session(store);
  let request;
  const result = await progress.refresh(async body => {
    request = body;
    return response(body, { 'changed.ts': { status: 'needs_attention' }, 'old.ts': { path: 'renamed.ts' } });
  });
  assert.deepEqual([...result].sort(), ['renamed.ts', 'unchanged.ts']);
  assert.equal(request.prUrl, 'https://github.com/a/b/pull/1');
  assert.equal(request.baseSha, BASE); assert.equal(request.headSha, HEAD);
  assert.deepEqual(request.reviewed.map(({ path, baseSha, headSha }) => ({ path, baseSha, headSha })), [
    { path: 'unchanged.ts', baseSha: OLD_BASE, headSha: OLD_HEAD },
    { path: 'changed.ts', baseSha: OLD_BASE, headSha: OLD_HEAD },
    { path: 'old.ts', baseSha: OLD_BASE, headSha: OLD_HEAD },
    { path: 'out-of-scope.ts', baseSha: OLD_BASE, headSha: OLD_HEAD },
  ]);
  assert.equal(new Set(request.reviewed.map(item => item.id)).size, 4);
  assert.deepEqual(JSON.parse(store.getItem(TARGET)).sort(), ['renamed.ts', 'unchanged.ts']);
  assert.equal(store.getItem(OLD), '["unchanged.ts","changed.ts","old.ts","out-of-scope.ts"]');
});

test('an existing target array is authoritative, including an explicit empty comparison', async () => {
  for (const target of ['[]', '["changed.ts"]']) {
    const store = storage({ [OLD]: '["unchanged.ts"]', [TARGET]: target });
    const progress = session(store);
    await progress.refresh(() => { assert.fail('Initialized target must not recarry historical markers'); });
    assert.equal(store.getItem(TARGET), target);
    assert.deepEqual([...progress.reviewed], JSON.parse(target));
  }
});

test('persists successful empty migration so remount cannot resurrect older progress', async () => {
  const store = storage({ [OLD]: '["changed.ts"]' });
  const progress = session(store);
  await progress.refresh(async body => response(body, { 'changed.ts': { status: 'needs_attention' } }));
  assert.equal(store.getItem(TARGET), '[]');
  await session(store).refresh(() => assert.fail('Empty initialized target must survive remount'));
});

test('initializes an empty new comparison even when it has no migration candidates', async () => {
  const store = storage();
  await session(store).refresh(() => assert.fail('No GitHub call is needed without previous markers'));
  assert.equal(store.getItem(TARGET), '[]');
});

test('preserves toggles during refresh and persists an empty explicit unmark immediately', async () => {
  const store = storage({ [OLD]: '["unchanged.ts","old.ts"]' });
  const progress = session(store), pending = deferred();
  let request;
  const refresh = progress.refresh(body => { request = body; return pending.promise; });
  progress.toggle('unchanged.ts');
  progress.toggle('unchanged.ts');
  assert.equal(store.getItem(TARGET), '[]');
  pending.resolve(response(request, { 'old.ts': { path: 'renamed.ts' } }));
  assert.deepEqual([...(await refresh)], ['renamed.ts']);
  assert.equal(store.getItem(TARGET), '["renamed.ts"]');
  progress.toggle('renamed.ts');
  await session(store).refresh(() => assert.fail('Explicit unmark must not be resurrected after remount'));
  assert.equal(store.getItem(TARGET), '[]');
});

test('rejects refresh results for commits newer than the displayed comparison', async () => {
  const store = storage({ [OLD]: '["unchanged.ts"]' });
  const progress = session(store);
  const result = await progress.refresh(async body => ({ ...response(body), headSha: 'e'.repeat(40) }));
  assert.equal(result, null);
  assert.deepEqual([...progress.reviewed], []);
  assert.equal(store.getItem(TARGET), null);
});

test('canceling an unmounted session blocks its response while a new session can retry', async () => {
  const store = storage({ [OLD]: '["unchanged.ts"]' });
  const progress = session(store), pending = deferred();
  let request;
  const refresh = progress.refresh(body => { request = body; return pending.promise; });
  progress.cancelRefresh();
  pending.resolve(response(request));
  assert.equal(await refresh, null);
  assert.equal(store.getItem(TARGET), null);
  await session(store).refresh(async body => response(body));
  assert.equal(store.getItem(TARGET), '["unchanged.ts"]');
});

test('a canceled effect can restart on the same session without an older response winning', async () => {
  const store = storage({ [OLD]: '["unchanged.ts"]' });
  const progress = session(store), first = deferred();
  let request;
  const canceled = progress.refresh(body => { request = body; return first.promise; });
  progress.cancelRefresh();
  await progress.refresh(async body => response(body, { 'unchanged.ts': { status: 'needs_attention' } }));
  first.resolve(response(request));
  assert.equal(await canceled, null);
  assert.equal(store.getItem(TARGET), '[]');
});

test('a newer target stored by another session wins over a pending migration', async () => {
  const store = storage({ [OLD]: '["unchanged.ts"]' });
  const progress = session(store), pending = deferred();
  let request;
  const refresh = progress.refresh(body => { request = body; return pending.promise; });
  store.setItem(TARGET, '["changed.ts"]');
  pending.resolve(response(request));
  assert.deepEqual([...(await refresh)], ['changed.ts']);
  assert.equal(store.getItem(TARGET), '["changed.ts"]');
});

test('failed verification keeps original progress and can retry without marking the target initialized', async () => {
  const store = storage({ [OLD]: '["unchanged.ts"]' });
  const progress = session(store);
  await assert.rejects(progress.refresh(async () => { throw Error('GitHub unavailable'); }), /GitHub unavailable/);
  assert.equal(store.getItem(OLD), '["unchanged.ts"]');
  assert.equal(store.getItem(TARGET), null);
  await session(store).refresh(async body => response(body));
  assert.equal(store.getItem(TARGET), '["unchanged.ts"]');
});

test('local comparisons keep progress without calling GitHub or scanning PR candidates', async () => {
  const store = storage({ [OLD]: '["unchanged.ts"]' });
  const progress = session(store, { mode: 'local', number: null, prUrl: null });
  await progress.refresh(() => assert.fail('Local comparisons must never use GitHub migration'));
  progress.toggle('changed.ts');
  assert.deepEqual([...progress.reviewed], ['changed.ts']);
  assert.equal(store.getItem(`flowreview:reviewed:a/b:fixture:${BASE}:${HEAD}`), '["changed.ts"]');
  assert.equal(store.getItem(TARGET), null);
});

test('ignores unrequested response identifiers and cannot mark files absent from the displayed analysis', async () => {
  const store = storage({ [OLD]: '["unchanged.ts"]' });
  const progress = session(store);
  await progress.refresh(async body => ({ ...response(body), reviewed: [
    { id: 'injected', status: 'ready', path: 'changed.ts', reason: '' },
    { id: body.reviewed[0].id, status: 'ready', path: 'missing.ts', reason: '' },
  ] }));
  assert.equal(store.getItem(TARGET), '[]');
});

function latestResponse(request, statuses) {
  return { ...response(request, statuses), baseSha: request.baseSha, headSha: request.headSha };
}

test('an explicit unmark stays unreviewed across future comparisons until a later explicit re-mark', async () => {
  const store = storage({ [OLD]: '["unchanged.ts"]' });
  const c = session(store);
  await c.refresh(async body => latestResponse(body));
  c.toggle('unchanged.ts');
  const dHead = 'e'.repeat(40), eHead = 'f'.repeat(40);
  const d = session(store, { headSha: dHead });
  await d.refresh(async body => latestResponse(body));
  assert.deepEqual([...d.reviewed], [], 'C unmark must supersede B and C historical reviewed markers');
  d.toggle('unchanged.ts');
  const e = session(store, { headSha: eHead });
  let request;
  await e.refresh(async body => { request = body; return latestResponse(body); });
  assert.deepEqual([...e.reviewed], ['unchanged.ts']);
  assert.equal(request.reviewed.find(item => item.path === 'unchanged.ts').headSha, dHead, 'Re-mark must verify its new source comparison');
  assert.equal(store.getItem(OLD), '["unchanged.ts"]', 'Legacy arrays remain intact');
});

test('unmark after a carried rename suppresses original aliases after remount and another rename', async () => {
  const store = storage({ [OLD]: '["old.ts"]' });
  const c = session(store);
  await c.refresh(async body => latestResponse(body, { 'old.ts': { path: 'renamed.ts' } }));
  session(store).toggle('renamed.ts');
  const dAnalysis = comparison({ headSha: 'e'.repeat(40) });
  dAnalysis.files = [{ path: 'newest.ts', previousPath: 'renamed.ts' }];
  const d = createReviewProgress(dAnalysis, store);
  await d.refresh(async body => latestResponse(body, {
    'old.ts': { path: 'newest.ts' }, 'renamed.ts': { path: 'newest.ts' },
  }));
  assert.deepEqual([...d.reviewed], [], 'Negative decision must cover the original and carried rename aliases');
  d.toggle('newest.ts');
  const eAnalysis = { ...dAnalysis, meta: { ...dAnalysis.meta, headSha: 'f'.repeat(40) } };
  const e = createReviewProgress(eAnalysis, store);
  await e.refresh(async body => latestResponse(body, {
    'old.ts': { path: 'newest.ts' }, 'renamed.ts': { path: 'newest.ts' },
  }));
  assert.deepEqual([...e.reviewed], ['newest.ts']);
});

test('a negative decision supersedes older content even when its own source needs attention', async () => {
  const store = storage({ [OLD]: '["unchanged.ts"]' });
  const c = session(store);
  await c.refresh(async body => latestResponse(body));
  c.toggle('unchanged.ts');
  const d = session(store, { headSha: 'e'.repeat(40) });
  await d.refresh(async body => ({ ...latestResponse(body), reviewed: body.reviewed.map(item => ({
    id: item.id, path: item.path, status: item.headSha === HEAD ? 'needs_attention' : 'ready', reason: '',
  })) }));
  assert.deepEqual([...d.reviewed], [], 'A stale positive cannot bypass the latest negative decision');
});

test('different sessions merge explicit decisions for different file lineages', async () => {
  const store = storage({ [TARGET]: '["unchanged.ts","changed.ts"]' });
  const first = session(store), second = session(store);
  first.toggle('unchanged.ts');
  second.toggle('changed.ts');
  const d = session(store, { headSha: 'e'.repeat(40) });
  await d.refresh(async body => latestResponse(body));
  assert.deepEqual([...d.reviewed], [], 'Writing a second decision must preserve the first file’s negative decision');
});

test('historical progress is verified in bounded batches before any target markers are persisted', async () => {
  const entries = {};
  for (let index = 0; index < 2001; index++) entries[`flowreview:reviewed:a/b:1:${OLD_BASE}:${index.toString(16).padStart(40, '0')}`] = '["unchanged.ts"]';
  const store = storage(entries), progress = session(store);
  let requests = 0;
  await progress.refresh(async body => {
    requests++;
    assert.ok(body.reviewed.length <= 200, 'Refresh must respect backend record limits');
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 900000, 'Refresh must respect backend JSON size limits');
    assert.equal(store.getItem(TARGET), null, 'Earlier chunks must not initialize the target before all chunks validate');
    return latestResponse(body);
  });
  assert.ok(requests > 1);
  assert.deepEqual([...progress.reviewed], ['unchanged.ts']);
});

test('a later batch with different SHAs rejects every earlier batch without initializing the target', async () => {
  const entries = {};
  for (let index = 0; index < 201; index++) entries[`flowreview:reviewed:a/b:1:${OLD_BASE}:${index.toString(16).padStart(40, '0')}`] = '["unchanged.ts"]';
  const store = storage(entries), progress = session(store);
  let requests = 0;
  const result = await progress.refresh(async body => {
    requests++;
    return { ...latestResponse(body), headSha: requests === 1 ? HEAD : 'e'.repeat(40) };
  });
  assert.equal(result, null);
  assert.equal(store.getItem(TARGET), null);
  assert.deepEqual([...progress.reviewed], []);
});

test('interleaved different-file unmarks cannot overwrite each other between decision read and write', async () => {
  const store = storage({ [TARGET]: '["unchanged.ts","changed.ts"]' });
  const first = session(store), second = session(store);
  const originalGet = store.getItem;
  let interleaved = false;
  store.getItem = key => {
    const stale = originalGet(key);
    if (key === 'flowreview:reviewed-decisions:a/b:1' && !interleaved) {
      interleaved = true;
      second.toggle('changed.ts');
    }
    return stale;
  };
  first.toggle('unchanged.ts');
  store.getItem = originalGet;
  assert.equal(interleaved, true);
  const next = session(store, { headSha: 'e'.repeat(40) });
  await next.refresh(async body => latestResponse(body));
  assert.deepEqual([...next.reviewed], [], 'Each tab must retain its own immutable negative decision');
});

test('legacy decision ledger remains readable while subsequent actions append immutable replacements', async () => {
  const decisionKey = 'flowreview:reviewed-decisions:a/b:1';
  const legacy = JSON.stringify([{ path: 'unchanged.ts', baseSha: BASE, headSha: HEAD, reviewed: false, aliases: ['unchanged.ts'] }]);
  const store = storage({ [OLD]: '["unchanged.ts"]', [decisionKey]: legacy });
  const next = session(store, { headSha: 'e'.repeat(40) });
  await next.refresh(async body => latestResponse(body));
  assert.deepEqual([...next.reviewed], []);
  next.toggle('unchanged.ts');
  const later = session(store, { headSha: 'f'.repeat(40) });
  await later.refresh(async body => latestResponse(body));
  assert.deepEqual([...later.reviewed], ['unchanged.ts']);
  assert.equal(store.getItem(decisionKey), legacy, 'New actions must preserve legacy records instead of replacing a shared array');
});

test('same-lineage simultaneous events have a stable tie-break and later actions supersede both', async () => {
  const eventPrefix = 'flowreview:reviewed-decisions:a/b:1:event:';
  const common = { path: 'unchanged.ts', baseSha: BASE, headSha: HEAD, aliases: ['unchanged.ts'], order: 1 };
  for (const reverse of [false, true]) {
    const events = [
      [eventPrefix + 'a', JSON.stringify({ ...common, reviewed: false })],
      [eventPrefix + 'b', JSON.stringify({ ...common, reviewed: true })],
    ];
    const store = storage(Object.fromEntries(reverse ? events.reverse() : events));
    const next = session(store, { headSha: 'e'.repeat(40) });
    await next.refresh(async body => latestResponse(body));
    assert.deepEqual([...next.reviewed], ['unchanged.ts'], 'Event enumeration order must not change the latest decision');
    next.toggle('unchanged.ts');
    const later = session(store, { headSha: 'f'.repeat(40) });
    await later.refresh(async body => latestResponse(body));
    assert.deepEqual([...later.reviewed], [], 'A later lineage order must override both simultaneous events');
  }
});

test('verified rename aliases do not change the identity of an explicit positive decision in flight', async () => {
  const store = storage({ [TARGET]: '[]' });
  session(store).toggle('unchanged.ts');
  const nextAnalysis = comparison({ headSha: 'e'.repeat(40) });
  nextAnalysis.files = [{ path: 'renamed.ts' }];
  const next = createReviewProgress(nextAnalysis, store);
  await next.refresh(async body => latestResponse(body, { 'unchanged.ts': { path: 'renamed.ts' } }));
  assert.deepEqual([...next.reviewed], ['renamed.ts'], 'A verified rename must preserve the immutable decision identity');
});

test('a later explicit mark wins when verification connects previously unknown rename lineages', async () => {
  const eventPrefix = 'flowreview:reviewed-decisions:a/b:1:event:';
  const store = storage({ [TARGET]: '[]', [eventPrefix + 'old']: JSON.stringify({
    path: 'old.ts', baseSha: OLD_BASE, headSha: OLD_HEAD, reviewed: false, aliases: ['old.ts'], order: 7,
  }) });
  const currentAnalysis = comparison(); currentAnalysis.files = [{ path: 'middle.ts' }];
  createReviewProgress(currentAnalysis, store).toggle('middle.ts');
  const laterAnalysis = comparison({ headSha: 'e'.repeat(40) }); laterAnalysis.files = [{ path: 'final.ts' }];
  const later = createReviewProgress(laterAnalysis, store);
  await later.refresh(async body => latestResponse(body, {
    'old.ts': { path: 'final.ts' }, 'middle.ts': { path: 'final.ts' },
  }));
  assert.deepEqual([...later.reviewed], ['final.ts'], 'A newer mark must remain newer after previously unknown aliases join');
});

test('an initialized comparison reconciles a stale array with durable current negative decisions on remount', async () => {
  const store = storage({ [TARGET]: '["unchanged.ts","changed.ts"]' });
  const first = session(store), second = session(store);
  const originalGet = store.getItem;
  let interleaved = false;
  store.getItem = key => {
    const stale = originalGet(key);
    if (key === 'flowreview:reviewed-decisions:a/b:1' && !interleaved) {
      interleaved = true;
      second.toggle('changed.ts');
    }
    return stale;
  };
  first.toggle('unchanged.ts');
  store.getItem = originalGet;
  const remount = session(store);
  await remount.refresh(() => assert.fail('Initialized comparison must not automatically recarry historical arrays'));
  assert.deepEqual([...remount.reviewed], [], 'Durable explicit unmarks must survive stale legacy-array writes on the same comparison');
});

test('same-SHA explicit positive restoration does not mark a newly added file reusing a rename alias', async () => {
  const store = storage({ [TARGET]: '[]' });
  const analysis = comparison();
  analysis.files = [{ path: 'new.ts', previousPath: 'old.ts' }, { path: 'old.ts', status: 'added' }];
  const current = createReviewProgress(analysis, store);
  current.toggle('new.ts');
  assert.deepEqual([...current.reviewed], ['new.ts']);
  const remount = createReviewProgress(analysis, store);
  await remount.refresh(() => assert.fail('Initialized comparison must not reverify historical progress'));
  assert.deepEqual([...remount.reviewed], ['new.ts'], 'An explicit mark must apply only to its exact path within the same SHAs');
});
