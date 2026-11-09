import unittest

from backend.analyzer import analyze_sources


class MovementTests(unittest.TestCase):
    def test_renamed_file_preserves_modified_function_and_exact_paths(self):
        result = analyze_sources({'old.ts': 'export function save() { return 1; }'},
            {'new.ts': 'export function save() { return 2; }'}, ['old.ts', 'new.ts'], {'old.ts': 'new.ts'})
        node, = result['nodes']
        self.assertEqual(node['status'], 'moved_modified')
        self.assertEqual((node['id'], node['baseId']), ('new.ts:save', 'old.ts:save'))
        self.assertEqual((node['basePath'], node['headPath']), ('old.ts', 'new.ts'))
        self.assertIn('return 1', node['base']['code'])
        self.assertIn('return 2', node['head']['code'])

    def test_unique_exact_function_move_aligns_callers_and_callees(self):
        result = analyze_sources({
            'old.ts': 'export function helper() { return 1; }',
            'page.ts': 'import {helper} from "./old"; function page() { return helper(); }',
        }, {
            'new.ts': 'export function helper() { /* comment */ return 1; }',
            'page.ts': 'import {helper} from "./new"; function page() {\nreturn helper(); }',
        }, ['old.ts', 'new.ts', 'page.ts'])
        nodes = {n['id']: n for n in result['nodes']}
        self.assertNotIn('old.ts:helper', nodes)
        self.assertEqual(nodes['new.ts:helper']['status'], 'moved')
        edge, = result['edges']
        self.assertEqual((edge['source'], edge['target'], edge['status']), ('page.ts:page', 'new.ts:helper', 'unchanged'))

    def test_moved_caller_edge_uses_matching_side_path_and_line(self):
        result = analyze_sources({'a.ts': 'function helper() {}\nfunction page() { helper(); }'},
            {'b.ts': '\nfunction helper() {}\nfunction page() { helper(); }'}, ['a.ts', 'b.ts'], {'a.ts': 'b.ts'})
        edge, = result['edges']
        self.assertEqual((edge['basePath'], edge['headPath']), ('a.ts', 'b.ts'))
        self.assertEqual((edge['baseLine'], edge['headLine']), (2, 3))
        self.assertTrue(edge['inBase'] and edge['inHead'])

    def test_ambiguous_duplicate_functions_do_not_get_paired(self):
        result = analyze_sources({'a.ts': 'function save() { return 1; }', 'b.ts': 'function save() { return 1; }'},
            {'c.ts': 'function save() { return 1; }'}, ['a.ts', 'b.ts', 'c.ts'])
        self.assertEqual(sorted(n['status'] for n in result['nodes']), ['added', 'removed', 'removed'])

    def test_same_name_with_changed_body_is_not_enough_for_a_cross_file_move(self):
        result = analyze_sources({'a.ts': 'function save() { return 1; }'},
            {'b.ts': 'function save() { return 2; }'}, ['a.ts', 'b.ts'])
        self.assertEqual(sorted(n['status'] for n in result['nodes']), ['added', 'removed'])

    def test_python_moves_preserve_the_existing_graph_contract(self):
        result = analyze_sources({'old.py': 'def save():\n    return 1\n'},
            {'new.py': 'def save():\n    return 1\n'}, ['old.py', 'new.py'], {'old.py': 'new.py'})
        node, = result['nodes']
        self.assertEqual(node['status'], 'moved')
        self.assertEqual(node['language'], 'python')
