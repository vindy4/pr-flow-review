// Run with node --test tests/review-drafts.cjs; exercise the real storage/provenance helpers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const filename = path.join(__dirname, '../frontend/reviewDraftStorage.ts');
const helpers = fs.existsSync(filename) ? require(filename) : {};
const prefix = 'flowreview:drafts:owner/repo:12:';
const current = prefix + 'a'.repeat(40) + ':' + 'b'.repeat(40);
const old = prefix + 'a'.repeat(40) + ':' + 'c'.repeat(40);
function storage(initial = {}) {
  const records = new Map(Object.entries(initial));
  return { get length() { return records.size; }, key: i => [...records.keys()][i] ?? null,
    getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) };
}
function draft(id, extra = {}) { return { id, path: 'src/file.ts', side: 'head', line: 3, code: 'doWork();', body: id, ...extra }; }
function collect(store, pending) {
  assert.equal(typeof helpers.collectDraftOrigins, 'function', 'Draft gathering must include immutable records from every original snapshot');
  return helpers.collectDraftOrigins(store, prefix, current, pending);
}

test('all snapshot records retain distinct stable origin identities without requiring a legacy root array', () => {
  const store = storage({ [current]: JSON.stringify([draft('same')]), [old + ':comment:same']: JSON.stringify(draft('same')) });
  const origins = collect(store);
  assert.equal(origins.length, 2);
  assert.equal(new Set(origins.map(o => o.id)).size, 2, 'Local draft IDs from different snapshots must not collide');
  assert.deepEqual(origins.map(o => [o.key, o.baseSha, o.headSha]), [[current, 'a'.repeat(40), 'b'.repeat(40)], [old, 'a'.repeat(40), 'c'.repeat(40)]]);
  assert.deepEqual(collect(store).map(o => o.id), origins.map(o => o.id));
});

test('all snapshot gathering reconciles concurrent replacements, deletions and unsaved storage writes', () => {
  const store = storage({ [old]: JSON.stringify([draft('original'), draft('deleted')]),
    [old + ':comment:tab-a']: JSON.stringify(draft('tab-a', { replaces: 'original' })),
    [old + ':deleted:deleted']: '1' });
  const pending = new Map([[old + ':comment:tab-b', JSON.stringify(draft('tab-b', { replaces: 'original' }))]]);
  assert.deepEqual(collect(store, pending).map(o => o.draft.id).sort(), ['tab-a', 'tab-b']);
});

test('refresh results map renamed anchors to original versions and reject missing or duplicated provenance', () => {
  const origins = collect(storage({ [old]: JSON.stringify([draft('one', { path: 'src/old.ts', side: 'base' })]) }));
  assert.equal(typeof helpers.resolveDraftRefresh, 'function', 'Refreshed anchors must retain their original immutable draft version');
  const response = { baseSha: 'd'.repeat(40), headSha: 'e'.repeat(40), files: [], comments: [
    { id: origins[0].id, status: 'ready', path: 'src/new.ts', side: 'base', line: 3, reason: '' },
  ] };
  const result = helpers.resolveDraftRefresh(response, origins);
  assert.equal(result.comments[0].origin, origins[0]);
  assert.equal(result.comments[0].path, 'src/new.ts');
  assert.equal(result.baseSha, 'd'.repeat(40));
  assert.throws(() => helpers.resolveDraftRefresh({ ...response, comments: [] }, origins), /incomplete|invalid/i);
  assert.throws(() => helpers.resolveDraftRefresh({ ...response, comments: [response.comments[0], response.comments[0]] }, origins), /incomplete|invalid/i);
});

test('successful cleanup tombstones exact origin versions while preserving attention drafts and edits made during submit', () => {
  const store = storage({ [old]: JSON.stringify([draft('sent'), draft('attention')]) });
  const submitted = collect(store).filter(o => o.draft.id === 'sent');
  store.setItem(old + ':comment:concurrent', JSON.stringify(draft('concurrent', { replaces: 'sent', body: 'Edited while submitting' })));
  assert.equal(typeof helpers.submittedDraftTombstones, 'function');
  for (const [key, value] of helpers.submittedDraftTombstones(submitted)) store.setItem(key, value);
  assert.equal(store.getItem(old + ':deleted:sent'), '1');
  assert.equal(store.getItem(current + ':deleted:sent'), null);
  assert.deepEqual(collect(store).map(o => o.draft.id).sort(), ['attention', 'concurrent']);
  assert.equal(JSON.parse(store.getItem(old))[0].body, 'sent', 'Original persisted versions are never rewritten or reanchored');
});

test('pending submission recovery retains exact reviewed versions and payload, rejects corrupt persisted envelopes', () => {
  const origins = collect(storage({ [old]: JSON.stringify([draft('sent')]) }));
  assert.equal(typeof helpers.parsePendingSubmission, 'function');
  const envelope = { id: 'attempt', payload: { prUrl: 'https://github.com/owner/repo/pull/12', baseSha: 'd'.repeat(40), headSha: 'e'.repeat(40), body: 'summary', comments: [{ path: 'src/file.ts', side: 'head', line: 3, body: 'sent' }] }, origins, summaryKey: current + ':summary', summary: 'summary' };
  assert.deepEqual(helpers.parsePendingSubmission(JSON.stringify(envelope), prefix), envelope);
  assert.equal(helpers.parsePendingSubmission(JSON.stringify({ ...envelope, origins: [{ ...origins[0], key: 'another-pr' }] }), prefix), null);
  assert.equal(helpers.parsePendingSubmission('{', prefix), null);
});

test('storage read failures keep new drafts and pending concurrent replacements visible in memory', () => {
  const visible = collect(storage({ [old]: JSON.stringify([draft('original'), draft('kept')]) }));
  const pending = new Map([[old + ':comment:edited', JSON.stringify(draft('edited', { replaces: 'original' }))],
    [current + ':comment:new', JSON.stringify(draft('new'))], [old + ':deleted:kept', '1']]);
  assert.equal(typeof helpers.reconcilePendingOrigins, 'function', 'A browser storage failure must not discard visible in-memory drafts');
  const result = helpers.reconcilePendingOrigins(visible, prefix, current, pending);
  assert.deepEqual(result.map(o => [o.key, o.draft.id]), [[current, 'new'], [old, 'edited']]);
});

function validated(origins) {
  return { baseSha: 'd'.repeat(40), headSha: 'e'.repeat(40), files: [], comments: origins.map(origin => ({ origin, status: 'ready', path: origin.draft.path, side: origin.draft.side, line: origin.draft.line, reason: '' })) };
}
test('one explicit batch includes at most 50 ready active versions and leaves other versions unsent', () => {
  const origins = collect(storage({ [old]: JSON.stringify(Array.from({ length: 54 }, (_, i) => draft('draft-' + i))) }));
  const refresh = validated(origins);
  refresh.comments[0].status = 'needs_attention';
  assert.equal(typeof helpers.prepareDraftSubmission, 'function', 'Submission must respect review limits while retaining remaining drafts');
  const active = origins.filter(origin => origin.draft.id !== 'draft-1');
  const batch = helpers.prepareDraftSubmission(refresh, active, 'https://github.com/owner/repo/pull/12', 'review summary');
  assert.equal(batch.origins.length, 50);
  assert.equal(batch.totalReady, 52);
  assert.deepEqual(batch.origins.map(o => o.draft.id), Array.from({ length: 50 }, (_, i) => 'draft-' + (i + 2)));
  assert.equal(batch.payload.headSha, 'e'.repeat(40));
  assert.equal(batch.payload.body, 'review summary');
});

test('one explicit batch respects UTF-8 request bytes including summary and leaves the remaining prefix unsent', () => {
  const origins = collect(storage({ [old]: JSON.stringify([draft('one', { body: '界'.repeat(10000) }), draft('two', { body: '界'.repeat(10000) })]) }));
  assert.equal(typeof helpers.prepareDraftSubmission, 'function');
  const batch = helpers.prepareDraftSubmission(validated(origins), origins, 'https://github.com/owner/repo/pull/12', '界'.repeat(10000));
  assert.equal(batch.totalReady, 2);
  assert.deepEqual(batch.origins.map(o => o.draft.id), ['one']);
  assert.ok(Buffer.byteLength(JSON.stringify(batch.payload), 'utf8') <= 65536);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...batch.payload, comments: [...batch.payload.comments, { path: 'src/file.ts', side: 'head', line: 3, body: '界'.repeat(10000) }] }), 'utf8') > 65536);
});

test('an oversized summary/comment combination fails locally before creating a submission envelope', () => {
  const origins = collect(storage({ [old]: JSON.stringify([draft('one', { body: '😀'.repeat(10000) })]) }));
  assert.equal(typeof helpers.prepareDraftSubmission, 'function');
  assert.throws(() => helpers.prepareDraftSubmission(validated(origins), origins, 'https://github.com/owner/repo/pull/12', '😀'.repeat(10000)), /request size|shorten/i);
});
