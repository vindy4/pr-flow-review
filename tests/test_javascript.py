import unittest

from backend.analyzer import analyze_sources


class JavascriptTests(unittest.TestCase):
    def analyze(self, sources, before=None):
        return analyze_sources(sources if before is None else before, sources, list(sources))

    def test_typescript_alias_import_and_arrow_calls_have_precise_unicode_evidence(self):
        result = self.analyze({
            'app/feature/service.ts': 'export const save = (n: number) => n + 1;',
            'app/feature/page.tsx': 'import {save as persist} from "./service";\nexport function Page() { const emoji = "😀"; return persist(2); }',
        })
        self.assertEqual(len(result['nodes']), 2)
        edge, = result['edges']
        self.assertEqual((edge['source'], edge['target']), ('app/feature/page.tsx:Page', 'app/feature/service.ts:save'))
        self.assertEqual((edge['expression'], edge['headLine']), ('persist(2)', 2))

    def test_jsx_render_and_callback_reference_are_distinct_from_calls(self):
        result = self.analyze({'view.tsx': '''function Child() { return <div />; }
function helper() { return 1; }
export const Page = () => <Child onClick={() => helper()} />;
'''})
        nodes = {n['id']: n for n in result['nodes']}
        self.assertEqual(nodes['view.tsx:Child']['kind'], 'component')
        renders = [e for e in result['edges'] if e.get('relation') == 'render']
        self.assertEqual([(e['source'], e['target']) for e in renders], [('view.tsx:Page', 'view.tsx:Child')])
        calls = [e for e in result['edges'] if e.get('relation') == 'call']
        self.assertEqual(len(calls), 1)
        self.assertNotEqual(calls[0]['source'], 'view.tsx:Page')
        self.assertEqual(calls[0]['target'], 'view.tsx:helper')
        self.assertTrue(any(e.get('relation') == 'callback' and e['source'] == 'view.tsx:Page' for e in result['edges']))

    def test_shadowed_parameters_reassigned_bindings_and_unknown_receivers_are_unresolved(self):
        result = self.analyze({'a.ts': '''function save() { return 1; }
function shadow(save: () => void) { save(); }
let changed = save; changed = other;
function caller(obj: any) { changed(); obj.save(); }
'''})
        self.assertEqual(result['edges'], [])
        nodes = {n['name']: n for n in result['nodes']}
        self.assertEqual(len(nodes['shadow']['unresolvedCalls']), 1)
        self.assertEqual(len(nodes['caller']['unresolvedCalls']), 2)

    def test_root_import_barrel_reexport_and_namespace_import(self):
        result = self.analyze({
            'app/f/service.ts': 'export function save() { return 1; }',
            'app/f/index.ts': 'export {save as persist} from "./service";',
            'app/f/page.ts': 'import * as api from "app/f"; export function page() { return api.persist(); }',
        })
        self.assertEqual([e['target'] for e in result['edges']], ['app/f/service.ts:save'])

    def test_formatting_comments_do_not_change_status_and_edges_align_across_line_moves(self):
        before = {'a.ts': 'function helper() { return 1; }\nfunction go() { return helper(1); }'}
        after = {'a.ts': '\nfunction helper() { /* why */ return 1; }\n\nfunction go() {\n return helper(2);\n}'}
        result = self.analyze(after, before)
        nodes = {n['name']: n for n in result['nodes']}
        self.assertEqual(nodes['helper']['status'], 'unchanged')
        self.assertEqual(nodes['go']['status'], 'modified')
        edge, = result['edges']
        self.assertEqual(edge['status'], 'unchanged')
        self.assertEqual((edge['baseExpression'], edge['headExpression']), ('helper(1)', 'helper(2)'))

    def test_parse_failure_omits_both_versions_without_inventing_removals(self):
        result = self.analyze({'a.ts': 'function go( {'}, {'a.ts': 'function go() { return 1; }'})
        self.assertEqual(result['nodes'], [])
        self.assertTrue(any('both snapshots' in w for w in result['warnings']))

    def test_javascript_default_export_and_class_method_inventory(self):
        result = self.analyze({'a.js': 'export default function run() { return 1; }\nclass Store { save() { return run(); } }'})
        nodes = {n['id']: n for n in result['nodes']}
        self.assertEqual(nodes['a.js:Store.save']['kind'], 'method')
        self.assertEqual(result['edges'][0]['target'], 'a.js:run')

    def test_named_callback_in_query_options_and_jsx_handler_are_references(self):
        result = self.analyze({'a.tsx': '''function save() { return 1; }
function Page() { const click = () => save(); useQuery({queryFn: () => save()}); return <button onClick={click} />; }
'''})
        callbacks = [e for e in result['edges'] if e.get('relation') == 'callback']
        self.assertEqual({e['target'] for e in callbacks}, {'a.tsx:Page.click', 'a.tsx:Page.queryFn'})
        self.assertFalse(any(e['source'] == 'a.tsx:Page' and e['target'] == 'a.tsx:save' for e in result['edges']))

    def test_block_and_destructured_parameter_shadowing_and_type_import(self):
        result = self.analyze({'a.ts': '''function save() { return 1; }
function go({save}: {save: Function}) { save(); }
function other() { { const save = unknown; save(); } return save(); }
'''})
        self.assertEqual([(e['source'], e['target']) for e in result['edges']], [('a.ts:other', 'a.ts:save')])

    def test_anonymous_default_arrow_export_resolves(self):
        result = self.analyze({'a.ts': 'export default () => 1;', 'b.ts': 'import go from "./a"; function caller() { return go(); }'})
        self.assertEqual(len(result['edges']), 1)
        self.assertEqual(result['edges'][0]['target'], 'a.ts:default')

    def test_react_use_callback_preserves_named_handler_binding_but_use_memo_does_not(self):
        result = self.analyze({'a.tsx': '''import {useCallback as callback, useMemo} from 'react';
function helper() { return 1; }
function Page() { const save = callback(() => helper(), []); const value = useMemo(() => helper(), []); save(); value(); return <button onClick={save} />; }
'''})
        nodes = {n['id']: n for n in result['nodes']}
        self.assertIn('a.tsx:Page.save', nodes)
        self.assertTrue(any(e['source'] == 'a.tsx:Page' and e['target'] == 'a.tsx:Page.save' and e['relation'] == 'call' for e in result['edges']))
        self.assertTrue(any(c['expression'] == 'value()' for c in nodes['a.tsx:Page']['unresolvedCalls']))

    def test_shadowed_react_callback_factory_is_not_treated_as_identity(self):
        result = self.analyze({'a.ts': '''import {useCallback} from 'react';
function Page(useCallback: any) { const save = useCallback(() => 1, []); save(); }
'''})
        self.assertFalse(any(e['relation'] == 'call' for e in result['edges']))

    def test_loop_bindings_and_iteration_writes_do_not_call_outer_function(self):
        for target in ('const save', 'let save', 'var save', 'const {save}', 'save'):
            with self.subTest(target=target):
                result = self.analyze({'a.ts': f'function save() {{}} function go(xs) {{ for ({target} of xs) {{ save(); }} }}'})
                self.assertFalse(any(e['relation'] == 'call' for e in result['edges']))
        result = self.analyze({'lib.ts': 'export function save() {}', 'a.ts': 'import * as api from "./lib"; function go(xs) { for (const api of xs) { api.save(); } }'})
        self.assertEqual(result['edges'], [])

    def test_defaulted_object_patterns_shadow_and_invalidate_bindings(self):
        bodies = ['function go({save = other}) { save(); }',
                  'function go(obj) { const {save = other} = obj; save(); }',
                  'function go(obj) { ({save = other} = obj); save(); }',
                  'function go() { try {} catch ({save = other}) { save(); } }']
        for body in bodies:
            with self.subTest(body=body):
                result = self.analyze({'a.ts': 'function save() {} ' + body})
                self.assertEqual(result['edges'], [])

    def test_redeclared_var_does_not_recover_react_wrapper_binding(self):
        result = self.analyze({'a.ts': '''import {useCallback} from 'react';
function Page() { var save = useCallback(() => 1, []); var save = other; save(); }
'''})
        self.assertFalse(any(e['relation'] == 'call' for e in result['edges']))

    def test_reassigned_named_default_export_is_unresolved(self):
        result = self.analyze({'lib.ts': 'export default function save() {} save = other;',
            'a.ts': 'import save from "./lib"; function go() { save(); }'})
        self.assertEqual(result['edges'], [])

    def test_named_generator_self_reference_never_targets_outer_function(self):
        result = self.analyze({'a.ts': 'function save() {} const gen = function* save() { save(); };'})
        self.assertEqual(len(result['edges']), 1)
        edge = result['edges'][0]
        self.assertEqual(edge['source'], edge['target'])
        self.assertNotEqual(edge['target'], 'a.ts:save')


if __name__ == '__main__':
    unittest.main()
