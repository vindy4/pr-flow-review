const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const file = path.join(__dirname, '../frontend/readerModel.ts');
const model = fs.existsSync(file) ? require(file) : {};
function rows(diff, base = 1, head = 1) {
  assert.equal(typeof model.diffRows, 'function', 'Diff rows must separate code, real line numbers, and change markers');
  return model.diffRows(diff, base, head);
}
test('unified diff rows omit transport file headers and preserve both snapshot line numbers', () => {
  const result = rows('--- a/one.ts\n+++ b/one.ts\n@@ -8,3 +8,3 @@ function run\n const before = 1;\n-oldOnly();\n+newOnly();\n return true;\n');
  assert.deepEqual(result.map(row => [row.kind, row.text, row.baseLine, row.headLine]), [
    ['hunk', '@@ -8,3 +8,3 @@ function run', undefined, undefined],
    ['context', 'const before = 1;', 8, 8], ['deletion', 'oldOnly();', 9, undefined],
    ['addition', 'newOnly();', undefined, 9], ['context', 'return true;', 10, 10],
  ]);
  assert.equal(new Set(result.map(row => row.id)).size, result.length);
});
test('new, removed, and method-relative hunks keep exact comment anchors', () => {
  assert.deepEqual(rows('@@ -0,0 +1,2 @@\n+const one = 1;\n+\n').slice(1).map(row => [row.baseLine, row.headLine]), [[undefined, 1], [undefined, 2]]);
  assert.deepEqual(rows('@@ -1,2 +0,0 @@\n-const one = 1;\n-\n').slice(1).map(row => [row.baseLine, row.headLine]), [[1, undefined], [2, undefined]]);
  assert.deepEqual(rows('@@ -2 +3 @@\n-old();\n+new();\n', 20, 40).slice(1).map(row => [row.baseLine, row.headLine]), [[21, undefined], [undefined, 42]]);
});
test('text that starts with diff header markers remains code inside a hunk', () => {
  assert.deepEqual(rows('@@ -1 +1 @@\n----old\n++++new\n').slice(1).map(row => row.text), ['---old', '+++new']);
});
test('search covers removed, context and added text, counts every literal occurrence and skips hunk labels', () => {
  const input = rows('@@ -1,2 +1,2 @@ token\n-token token\n+TOKEN\n token\n');
  const found = model.findTextMatches(input, 'token');
  assert.deepEqual(found.map(match => [match.rowId, match.start, match.end]), [[input[1].id, 0, 5], [input[1].id, 6, 11], [input[2].id, 0, 5], [input[3].id, 0, 5]]);
  assert.equal(new Set(found.map(match => match.id)).size, 4);
});
test('source search preserves literal special characters, Unicode offsets, and original whitespace', () => {
  assert.equal(typeof model.sourceRows, 'function');
  const input = model.sourceRows('İ a.b [x] a.b\r\n  final();\n', 5, 'base');
  assert.deepEqual(input.map(row => [row.id, row.text, row.baseLine]), [['source-5', 'İ a.b [x] a.b', 5], ['source-6', '  final();', 6]]);
  assert.deepEqual(model.findTextMatches(input, 'a.b').map(match => [match.start, match.end]), [[2, 5], [10, 13]]);
  assert.equal(model.findTextMatches(input, '[x]').length, 1);
  assert.deepEqual(model.findTextMatches(input, 'absent'), []);
  assert.deepEqual(model.findTextMatches(input, ''), []);
});
test('no-newline annotations do not consume snapshot lines or become searchable code', () => {
  const result = rows('@@ -2 +2 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  assert.deepEqual(result.filter(row => row.kind === 'deletion' || row.kind === 'addition').map(row => [row.baseLine, row.headLine]), [[2, undefined], [undefined, 2]]);
  assert.deepEqual(model.findTextMatches(result, 'newline'), []);
});
