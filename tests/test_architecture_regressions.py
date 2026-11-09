"""Regressions for misleading or missing architecture relationships."""
import unittest
from backend.analyzer import analyze_sources


class ArchitectureRegressionTests(unittest.TestCase):
    def analyze(self, sources):
        return analyze_sources(sources, sources, list(sources))

    def test_computed_property_writes_and_deletes_invalidate_facade_targets(self):
        cases = [
            'client["save"] = other;', 'client["save"]++;', 'delete client.save;',
            'delete client["save"];', 'client["nested"].save = other;',
            'client.nested["save"] = other;', 'delete client["nested"].save;',
        ]
        for mutation in cases:
            with self.subTest(mutation=mutation):
                result = self.analyze({'a.ts': 'function save() {} function other() {} const client={save,nested:{save}}; ' + mutation + ' function page(){client.save();client.nested.save();}'})
                self.assertFalse(any(e['source'] == 'a.ts:page' and e.get('relation', 'call') == 'call' for e in result['edges']))

    def test_equivalent_quoted_object_keys_do_not_prove_first_target(self):
        for fields in ['save, "save":other', '"save":save, save:other', "'save':save, \"save\":other"]:
            with self.subTest(fields=fields):
                result = self.analyze({'a.ts': 'function save() {} function other() {} const client={' + fields + '}; function page(){client.save();}'})
                self.assertFalse(any(e['source'] == 'a.ts:page' for e in result['edges']))

    def test_named_query_and_mutation_callbacks_connect_registered_service(self):
        cases = [('queryOptions', 'queryFn', 'runs_query'), ('useQuery', 'queryFn', 'runs_query'),
                 ('mutationOptions', 'mutationFn', 'mutates'), ('useMutation', 'mutationFn', 'mutates')]
        for api, field, relation in cases:
            with self.subTest(api=api):
                result = self.analyze({'service/get.ts': 'export function get() { return 1; }',
                    'query.ts': f'import {{{api}}} from "@tanstack/react-query"; import {{get}} from "./service/get"; export function options() {{ return {api}({{queryKey:["x"], {field}:get}}); }}'})
                edge = next((e for e in result['architecture']['edges'] if e['source'] == 'file:query.ts' and e['target'] == 'file:service/get.ts' and e['relation'] == relation), None)
                self.assertIsNotNone(edge)
                self.assertEqual(edge['headEvidence'][0]['targetSymbolId'], 'service/get.ts:get')
                self.assertIn('registration', edge['headEvidence'][0]['reason'])

    def test_named_facade_query_callback_keeps_facade_and_target_identity(self):
        result = self.analyze({'service/get.ts': 'export function get() {}',
            'service/client.ts': 'import {get} from "./get"; export const client={benefits:{get}};',
            'query.ts': 'import {queryOptions} from "@tanstack/react-query"; import {client} from "./service/client"; const config={queryKey:["x"],queryFn:client.benefits.get}; export const options=()=>queryOptions(config);'})
        edge = next((e for e in result['architecture']['edges'] if e['source'] == 'file:query.ts' and e['target'] == 'file:service/client.ts' and e['relation'] == 'runs_query'), None)
        self.assertIsNotNone(edge)
        self.assertEqual(edge['headEvidence'][0]['targetSymbolId'], 'service/get.ts:get')

    def test_unchanged_local_state_hook_is_classified_as_client_state(self):
        for api, invocation in [('useState', 'useState(0)'), ('useReducer', 'useReducer((s)=>s,0)')]:
            with self.subTest(api=api):
                sources = {'state/useDraft.ts': f'import {{{api}}} from "react"; export function useDraft() {{return {invocation};}}',
                    'Page.tsx': 'import {useDraft} from "./state/useDraft"; export function Page(){const draft=useDraft();return <div/>;}'}
                result = analyze_sources(sources, sources, ['Page.tsx'])
                hook = next(n for n in result['architecture']['nodes'] if n['path'] == 'state/useDraft.ts')
                self.assertEqual(hook['status'], 'unchanged')
                self.assertEqual(hook['head']['layer'], 'client_state')
                self.assertTrue(any(e['source'] == 'file:Page.tsx' and e['target'] == hook['id'] and e['inHead'] for e in result['architecture']['edges']))

    def test_ambiguous_store_state_does_not_invent_action_targets(self):
        cases = ['reset:()=>set({count:0}), ...other', '[key]:()=>set({count:0})',
                 'reset:()=>set({count:0}), "reset":other', 'get reset(){return other;}']
        for fields in cases:
            with self.subTest(fields=fields):
                result = self.analyze({'store.ts': 'import {create} from "zustand"; export const useStore=create(set=>({' + fields + '}));',
                    'Page.tsx': 'import {useStore} from "./store"; function Page(){const {reset}=useStore();reset();return <div/>;}'})
                self.assertFalse(any(e['source'] == 'Page.tsx:Page' and e.get('relation', 'call') == 'call' for e in result['edges']))
                relations = {e['relation'] for e in result['architecture']['edges'] if e['source'] == 'file:Page.tsx'}
                self.assertIn('reads_store', relations)
                self.assertNotIn('updates_store', relations)
                self.assertNotIn('calls_store_action', relations)

    def test_read_only_store_functions_are_calls_without_assumed_writes(self):
        result = self.analyze({'store.ts': 'import {create} from "zustand"; export const useStore=create((set,get)=>({count:1,read:()=>get().count}));',
            'Page.tsx': 'import {useStore} from "./store"; function Page(){const {read}=useStore();read();return <div/>;}'})
        relations = {e['relation'] for e in result['architecture']['edges'] if e['source'] == 'file:Page.tsx'}
        self.assertIn('calls_store_action', relations)
        self.assertNotIn('updates_store', relations)
