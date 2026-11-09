// Real reader markup: simultaneous readers must not duplicate tab targets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
for (const extension of ['.ts', '.tsx']) {
  require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
}
const { createElement, Fragment } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const FileReader = require('../frontend/FileReader.tsx').default;
const props = {
  analysis: { meta: { mode: 'local' } },
  file: { path: 'app/plan.py', status: 'modified' }, source: null, loading: false, error: '',
  onRetry() {}, mode: 'diff', onMode() {}, view: 'head', onView() {}, jump: null, relationships: null,
};

test('a code drawer limits navigation to diff and full file and exposes its close action', () => {
  // Ignoring modes would offer a Relationships tab that replaces the drawer's code.
  const markup = renderToStaticMarkup(createElement(FileReader, {
    ...props, modes: ['diff', 'source'], idPrefix: 'drawer-reader',
    headingActions: createElement('button', { 'aria-label': 'Close code drawer' }, 'Close'),
  }));
  assert.equal((markup.match(/role="tab"/g) || []).length, 2);
  assert.match(markup, />Diff<\/button>/);
  assert.match(markup, />Full file<\/button>/);
  assert.doesNotMatch(markup, />Relationships<\/button>/);
  assert.match(markup, /aria-label="Close code drawer"/);
});

test('simultaneous graph and code readers keep independent accessible tab targets', () => {
  // Shared tab/content IDs would associate the drawer tabs with the graph panel.
  const markup = renderToStaticMarkup(createElement(Fragment, null,
    createElement(FileReader, { ...props, mode: 'relationships' }),
    createElement(FileReader, { ...props, modes: ['diff', 'source'], idPrefix: 'drawer-reader' }),
  ));
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Each tab and content panel needs its own ID');
  const targets = [...markup.matchAll(/aria-controls="([^"]+)"/g)].map(match => match[1]);
  for (const target of targets) assert.ok(ids.includes(target), `Missing tab panel ${target}`);
});

test('ordinary file readers retain their three existing view choices', () => {
  const markup = renderToStaticMarkup(createElement(FileReader, props));
  assert.equal((markup.match(/role="tab"/g) || []).length, 3);
  assert.match(markup, />Relationships<\/button>/);
});
