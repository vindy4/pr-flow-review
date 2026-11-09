// Run with node --test tests/source-facts.cjs; exercise the real TypeScript helper.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const helper = path.join(__dirname, '../frontend/sourceFacts.ts');
const sourceFacts = fs.existsSync(helper) ? require(helper).sourceFacts : undefined;
function facts(code, filename) {
  assert.equal(typeof sourceFacts, 'function', 'Full-source facts must recognize actual import and export statements');
  return sourceFacts(code, filename);
}

test('Python imports include plain dotted and aliased imports, grouped continuations, and local imports', () => {
  const code = [
    '"""Module documentation', 'import fictitious', '"""',
    'import os', 'import package.module as module, sys as system',
    'from .service import (', '    call as invoke, # keep this comment out of the label', '    Result,', ')',
    'def use():', '    import local.dependency',
    'from pkg import one, \\', '    two as second',
    '# import commented', 'example = "import quoted"',
    "raw = r'''", 'from fake import text', "'''",
  ].join('\n');
  assert.deepEqual(facts(code, 'feature/service.py'), {
    imports: [
      { label: 'import os', line: 4 },
      { label: 'import package.module as module, sys as system', line: 5 },
      { label: 'from .service import ( call as invoke, Result, )', line: 6 },
      { label: 'import local.dependency', line: 11 },
      { label: 'from pkg import one, two as second', line: 12 },
    ], exports: [],
  });
});

test('JavaScript and TypeScript imports and exports keep declaration starts and complete multiline labels', () => {
  const code = [
    '/* documentation', 'import Fake from "fake";', 'export const fake = true;', '*/',
    'const text = `example', 'import Hidden from "hidden";', 'export const hidden = true;', '`;',
    'import React from "react";', 'import "./setup";',
    'import {', '  A,', '  B as C,', '} from', '  "./service";',
    'import type { T } from "./types";', 'const dynamic = import("./dynamic");',
    'import * as Utils from "./utils";',
    'export {', '  C as PublicC,', '} from', '  "./service";',
    'export * as Api from "./api";', 'export default function Page(', '  props: Props,', ') {', '  return null;', '}',
    'export const answer =', '  42;', 'export interface Props {', '  value: string;', '}',
  ].join('\n');
  assert.deepEqual(facts(code, 'Page.tsx'), {
    imports: [
      { label: 'import React from "react";', line: 9 },
      { label: 'import "./setup";', line: 10 },
      { label: 'import { A, B as C, } from "./service";', line: 11 },
      { label: 'import type { T } from "./types";', line: 16 },
      { label: 'import * as Utils from "./utils";', line: 18 },
    ], exports: [
      { label: 'export { C as PublicC, } from "./service";', line: 19 },
      { label: 'export * as Api from "./api";', line: 23 },
      { label: 'export default function Page( props: Props, ) {', line: 24 },
      { label: 'export const answer = 42;', line: 29 },
      { label: 'export interface Props {', line: 31 },
    ],
  });
});

test('comments within grouped imports and import attributes do not shift CRLF source links', () => {
  const code = [
    '/* intro */ import {', ' // import Imaginary from "imaginary";', ' Thing as Alias, /* inline */ Other,',
    '} from "./things"', 'with { type: "json" };',
    'export', '{ Alias }', 'from "./things";',
    'import "./side-effect"; import Default, { Named } from "./mixed";',
  ].join('\r\n');
  assert.deepEqual(facts(code, 'feature.mts'), {
    imports: [
      { label: 'import { Thing as Alias, Other, } from "./things" with { type: "json" };', line: 1 },
      { label: 'import "./side-effect";', line: 9 },
      { label: 'import Default, { Named } from "./mixed";', line: 9 },
    ], exports: [{ label: 'export { Alias } from "./things";', line: 6 }],
  });
});

test('strings and regular expressions cannot create or conceal source declarations', () => {
  const code = [
    'const pattern = /https?:\\/\\/[^/]+/;',
    'const quoted = "export default fake; \\"import\\"";',
    'import Real from "./real";',
    'function local() {', '  const object = { import: true, export: true };', '}',
    'export const patternCopy = pattern;',
  ].join('\n');
  assert.deepEqual(facts(code, 'feature.js'), {
    imports: [{ label: 'import Real from "./real";', line: 3 }],
    exports: [{ label: 'export const patternCopy = pattern;', line: 7 }],
  });
});

test('unsupported text files do not turn documentation examples into language facts', () => {
  assert.deepEqual(facts('import Fake from "./fake";\nexport const fake = true;', 'README.md'), { imports: [], exports: [] });
});

test('nested template strings and interpolation strings cannot leak declaration examples', () => {
  const code = [
    'const text = `outer ${', '  `inner', 'import Wrong from "./wrong";', '`', '} still outer',
    'export const imaginary = true;', '`;',
    'const another = `interpolation ${"`"} trailing', 'import WrongAgain from "./wrong-again";', '`;',
    'import Actual from "./actual";', 'export default Actual;',
  ].join('\n');
  assert.deepEqual(facts(code, 'feature.ts'), {
    imports: [{ label: 'import Actual from "./actual";', line: 11 }],
    exports: [{ label: 'export default Actual;', line: 12 }],
  });
});
