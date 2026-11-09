import unittest

from backend.analyzer import analyze_sources


class ArchitectureTests(unittest.TestCase):
    def analyze(self, sources):
        return analyze_sources(sources, sources, list(sources))

    def test_nested_imported_object_facade_resolves_to_declared_operation(self):
        result = self.analyze({
            'service/operation.ts': 'export function getBenefits() { return 1; }',
            'service/client.ts': 'import {getBenefits} from "./operation"; export const client = {benefits: {get: getBenefits}};',
            'page.ts': 'import {client} from "./service/client"; function page() { return client.benefits.get(); }',
        })
        self.assertTrue(any(e['source'] == 'page.ts:page' and e['target'] == 'service/operation.ts:getBenefits' for e in result['edges']))
        arch = result['architecture']
        self.assertTrue(any(e['source'] == 'file:page.ts' and e['target'] == 'file:service/client.ts' and e['relation'] == 'calls_service' for e in arch['edges']))
        self.assertTrue(any(e['source'] == 'file:service/client.ts' and e['target'] == 'file:service/operation.ts' and e['relation'] == 'delegates' for e in arch['edges']))

    def test_spread_computed_and_mutated_objects_do_not_prove_calls(self):
        cases = ['const client = {save, ...other};', 'const client = {[key]: save};',
                 'const client = {save}; client.save = other;',
                 'const client = {save}; const alias = client; alias.save = other;']
        for declaration in cases:
            with self.subTest(declaration=declaration):
                result = self.analyze({'a.ts': f'function save() {{}} {declaration} function page() {{ client.save(); }}'})
                self.assertFalse(any(e['source'] == 'a.ts:page' for e in result['edges']))

    def test_react_query_and_local_state_are_roles_on_the_real_screen_flow(self):
        result = self.analyze({
            'service/get.ts': 'export function get() { return 1; }',
            'feature/benefits.queries.ts': 'import {queryOptions as options} from "@tanstack/react-query"; import {get} from "../service/get"; export const benefitsOptions = () => options({queryKey: ["benefits"], queryFn: () => get()});',
            'feature/Page.tsx': 'import {useQuery as query} from "@tanstack/react-query"; import {useState} from "react"; import {benefitsOptions} from "./benefits.queries"; export function Page() { const result = query(benefitsOptions()); const [search, setSearch] = useState(""); return <input onChange={() => setSearch("x")} />; }',
        })
        arch = result['architecture']
        files = {n['path']: n for n in arch['nodes']}
        self.assertEqual(files['feature/Page.tsx']['head']['layer'], 'ui')
        self.assertIn('Local state', files['feature/Page.tsx']['head']['roles'])
        self.assertIn('React Query', files['feature/Page.tsx']['head']['roles'])
        self.assertEqual(files['feature/benefits.queries.ts']['head']['layer'], 'server_state')
        self.assertTrue(any(e['relation'] == 'runs_query' and e['source'] == 'file:feature/Page.tsx' and e['target'] == 'file:feature/benefits.queries.ts' for e in arch['edges']))
        self.assertTrue(any(f['root'] == 'file:feature/Page.tsx' for f in arch['features']))

    def test_zustand_reads_selectors_and_action_calls_are_distinguished(self):
        result = self.analyze({
            'state/store.ts': 'import {create as make} from "zustand"; export const usePlanStore = make((set) => ({draft: 1, reset: () => set({draft: 0})}));',
            'Page.tsx': 'import {usePlanStore} from "./state/store"; function Page() { const {reset} = usePlanStore(); const clear = usePlanStore(s => s.reset); reset(); clear(); usePlanStore.setState({draft: 2}); return <div />; }',
        })
        arch = result['architecture']
        store = next(n for n in arch['nodes'] if n['path'] == 'state/store.ts')
        self.assertEqual(store['head']['layer'], 'client_state')
        relationships = {e['relation'] for e in arch['edges'] if e['source'] == 'file:Page.tsx' and e['target'] == 'file:state/store.ts'}
        self.assertIn('reads_store', relationships)
        self.assertIn('updates_store', relationships)
        writes = [e for e in arch['edges'] if e['relation'] == 'calls_store_action']
        self.assertTrue(any('reset()' in ev['expression'] for e in writes for ev in e['headEvidence']))

    def test_framework_names_shadowed_by_parameters_do_not_create_store_or_query_facts(self):
        result = self.analyze({'Page.tsx': 'import {useQuery} from "@tanstack/react-query"; import {create} from "zustand"; function Page(useQuery, create) { const useFake = create(() => ({})); useQuery({}); return <div />; }'})
        facts = result['architecture']['nodes'][0]['head']['facts']
        self.assertFalse(any(f['kind'] in {'query', 'store'} for f in facts))

    def test_type_only_imports_are_not_runtime_relationships(self):
        result = self.analyze({'types.ts': 'export type Value = string;',
            'Page.tsx': 'import type {Value} from "./types"; function Page() { return <div />; }'})
        self.assertFalse(any(e['target'] == 'file:types.ts' for e in result['architecture']['edges']))
        types = next(n for n in result['architecture']['nodes'] if n['path'] == 'types.ts')
        self.assertEqual(types['head']['layer'], 'supporting')

    def test_moved_layer_node_keeps_both_versions_and_architecture_links(self):
        result = analyze_sources({'service/old.ts': 'export function get() { return 1; }'},
            {'service/read_models/new.ts': 'export function get() { return 1; }'}, ['service/old.ts', 'service/read_models/new.ts'],
            {'service/old.ts': 'service/read_models/new.ts'})
        node, = result['architecture']['nodes']
        self.assertEqual(node['status'], 'moved')
        self.assertEqual(node['base']['path'], 'service/old.ts')
        self.assertEqual(node['head']['path'], 'service/read_models/new.ts')
