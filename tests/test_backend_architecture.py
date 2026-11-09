"""Backend review lanes must describe real file responsibilities and calls."""
import difflib
import unittest

from backend.analyzer import analyze_sources
from backend.architecture import include_unindexed_files


SOURCES = {
    'app/pension_management/apis/enrollment.py': '''from pension_management.controller.enrollment import enroll

def enrollment_view(request):
    return enroll()
''',
    'app/pension_management/permissions.py': '''from pension_management.external.hris import load_role

def has_access():
    return bool(load_role())
''',
    'app/pension_management/controller/enrollment.py': '''from pension_management.permissions import has_access
from pension_management.repositories.plan import get_plan
from pension_management.tasks.sync import sync_plan
from pension_management.external.hris import load_role
from pension_management.read_models.history import build_history
from pension_management.migrations.repair import repair_plan

def enroll():
    if not has_access():
        return False
    plan = get_plan()
    sync_plan()
    load_role()
    build_history()
    repair_plan()
    return plan
''',
    'app/pension_management/repositories/plan.py': 'def get_plan():\n    return {"id": "fixture"}\n',
    'app/pension_management/tasks/sync.py': 'def sync_plan():\n    return True\n',
    'app/pension_management/external/hris.py': 'def load_role():\n    return {"company": "fixture"}\n',
    'app/pension_management/read_models/history.py': 'def build_history():\n    return []\n',
    'app/pension_management/migrations/repair.py': 'def repair_plan():\n    return True\n',
}
EXPECTED = {
    'app/pension_management/apis/enrollment.py': 'backend_api',
    'app/pension_management/permissions.py': 'backend_auth',
    'app/pension_management/controller/enrollment.py': 'backend_logic',
    'app/pension_management/repositories/plan.py': 'backend_data',
    'app/pension_management/tasks/sync.py': 'backend_async',
    'app/pension_management/external/hris.py': 'backend_integrations',
    'app/pension_management/read_models/history.py': 'backend_reporting',
    'app/pension_management/migrations/repair.py': 'backend_operations',
}
EXTRAS = {
    'app/pension_management/tests/test_enrollment.py': 'def test_enrollment():\n    assert True\n',
    'app/pension_management/docs/authorization.md': '# Hiring authorization\n',
    'app/insurance_api_gateway/rule_configuration/common/flex.yaml': 'gateway-api-groups: []\n',
}


def browser_fixture():
    """Use real analyzer output at the browser's API boundary, never fake layers."""
    before_sources = {path: code.replace('True', 'False') if 'True' in code else code + '\n' for path, code in SOURCES.items()}
    analysis = analyze_sources(before_sources, SOURCES, list(SOURCES))
    files = [{'path': path, 'status': 'modified', 'indexed': True,
              'changedMethods': sum(node['path'] == path and node['status'] != 'unchanged' for node in analysis['nodes'])}
             for path in SOURCES]
    files += [{'path': path, 'status': 'modified', 'changedMethods': 0, 'indexed': False} for path in EXTRAS]
    analysis['files'] = files
    include_unindexed_files(analysis['architecture'], files)
    analysis['meta'] = {
        'analysisId': 'backend-layers-fixture', 'title': 'Pension backend review layers',
        'repository': 'fixture/backend', 'prUrl': 'https://github.com/fixture/backend/pull/1',
        'number': 1, 'baseSha': 'a' * 40, 'headSha': 'b' * 40,
        'baseRef': 'main', 'headRef': 'backend-layers', 'mode': 'github',
        'scopes': ['app/pension_management'], 'indexedFiles': len(SOURCES),
        'changedFiles': len(files), 'analyzedAt': '2026-11-02T00:00:00Z',
        'limited': False, 'includeTests': False,
    }
    sources = {}
    for path, code in {**SOURCES, **EXTRAS}.items():
        before = code.replace('True', 'False') if 'True' in code else code + '\n'
        sources[path] = {
            'path': path, 'base': {'path': path, 'code': before, 'startLine': 1},
            'head': {'path': path, 'code': code, 'startLine': 1},
            'diff': ''.join(difflib.unified_diff(before.splitlines(keepends=True), code.splitlines(keepends=True),
                                              fromfile='a/' + path, tofile='b/' + path)),
        }
    return {'analysis': analysis, 'sources': sources}


class BackendArchitectureTests(unittest.TestCase):
    def test_python_review_exposes_eight_distinct_responsibilities(self):
        arch = analyze_sources(SOURCES, SOURCES, list(SOURCES))['architecture']
        files = {node['path']: node for node in arch['nodes']}
        for path, layer in EXPECTED.items():
            with self.subTest(path=path):
                self.assertEqual(files[path]['head']['layer'], layer)
                self.assertEqual(files[path]['base']['layer'], layer)
                self.assertTrue(files[path]['head']['reason'])
        labels = {layer['id']: layer['label'] for layer in arch['layers']}
        self.assertEqual(labels.get('backend_auth'), 'Authorization')
        self.assertEqual({s['id'] for s in arch['summaries']}, set(EXPECTED.values()))

    def test_resolved_calls_keep_evidence_and_describe_the_target_responsibility(self):
        arch = analyze_sources(SOURCES, SOURCES, list(SOURCES))['architecture']
        calls = {(edge['source'], edge['target']): edge for edge in arch['edges']}
        source = 'file:app/pension_management/controller/enrollment.py'
        for path, relation in [
            ('permissions.py', 'checks_permission'),
            ('repositories/plan.py', 'calls_data_access'),
            ('tasks/sync.py', 'calls_job'),
            ('external/hris.py', 'calls_integration'),
            ('read_models/history.py', 'calls_report'),
            ('migrations/repair.py', 'calls_operation'),
        ]:
            with self.subTest(path=path):
                edge = calls[source, 'file:app/pension_management/' + path]
                self.assertEqual(edge['relation'], relation)
                ev = edge['headEvidence'][0]
                self.assertEqual(ev['path'], 'app/pension_management/controller/enrollment.py')
                self.assertIn(ev['expression'], SOURCES[ev['path']])
                self.assertGreater(ev['line'], 0)

    def test_backend_and_webapp_layers_coexist_without_changing_frontend_api_clients(self):
        sources = {**SOURCES,
            'frontend/Page.tsx': 'export function Page(){return <button/>;}',
            'frontend/api/client.ts': 'export function get(){return fetch("/api/plan");}',
        }
        arch = analyze_sources(sources, sources, list(sources))['architecture']
        layers = {node['path']: node['head']['layer'] for node in arch['nodes']}
        self.assertEqual(layers['frontend/Page.tsx'], 'ui')
        self.assertEqual(layers['frontend/api/client.ts'], 'integrations')
        self.assertEqual(layers['app/pension_management/permissions.py'], 'backend_auth')
        self.assertTrue({'ui', 'integrations', 'backend_auth'} <= {layer['id'] for layer in arch['layers']})

    def test_moved_file_retains_the_responsibility_of_each_snapshot(self):
        old, new = 'app/feature/services/plan.py', 'app/feature/repositories/plan.py'
        code = 'def load():\n    return 1\n'
        arch = analyze_sources({old: code}, {new: code}, [old, new], {old: new})['architecture']
        node, = arch['nodes']
        self.assertEqual(node['base']['layer'], 'backend_logic')
        self.assertEqual(node['head']['layer'], 'backend_data')
        self.assertEqual(node['base']['path'], old)
        self.assertEqual(node['head']['path'], new)

    def test_partially_indexed_renames_keep_both_snapshot_layers(self):
        old, new = 'app/orders/services/order.py', 'app/billing/repositories/order.py'
        code = 'def get():\n    return 1\n'
        for indexed_side in ('base', 'head'):
            with self.subTest(indexed_side=indexed_side):
                arch = analyze_sources(
                    {old: code} if indexed_side == 'base' else {},
                    {new: code} if indexed_side == 'head' else {},
                    [old, new], {old: new},
                )['architecture']
                include_unindexed_files(arch, [{
                    'path': new, 'previousPath': old, 'status': 'moved', 'indexed': True,
                }])
                node, = arch['nodes']
                self.assertEqual(node['status'], 'moved')
                for side, path, layer in (
                    ('base', old, 'backend_logic'), ('head', new, 'backend_data'),
                ):
                    self.assertIsNotNone(node[side])
                    self.assertEqual(node[side]['path'], path)
                    self.assertEqual(node[side]['layer'], layer)
                    self.assertEqual(node[side]['indexed'], side == indexed_side)
                    if side != indexed_side:
                        self.assertEqual(node[side]['facts'], [])
                        self.assertEqual(node[side]['operations'], [])
                self.assertIn('backend_data', {summary['id'] for summary in arch['summaries']})

    def test_excluded_files_have_path_only_layers_and_supporting_artifacts_stay_separate(self):
        fixture = browser_fixture()['analysis']
        files = {node['path']: node for node in fixture['architecture']['nodes']}
        for path in EXTRAS:
            with self.subTest(path=path):
                version = files[path]['head']
                self.assertFalse(version['indexed'])
                self.assertEqual(version['facts'], [])
                self.assertEqual(version['layer'], 'backend_api' if path.endswith('.yaml') else 'supporting')

    def test_unknown_python_does_not_claim_to_be_business_logic(self):
        sources = {'misc/unknown.py': 'def mystery():\n    return 42\n'}
        node, = analyze_sources(sources, sources, list(sources))['architecture']['nodes']
        self.assertEqual(node['head']['layer'], 'other')

    def test_removed_backend_files_keep_their_layer_in_the_change_summary(self):
        path = 'app/feature/migrations/repair.py'
        arch = analyze_sources({path: 'def repair():\n    pass\n'}, {}, [path])['architecture']
        node, = arch['nodes']
        self.assertIsNone(node['head'])
        self.assertEqual(node['base']['layer'], 'backend_operations')
        self.assertEqual(arch['summaries'][0]['id'], 'backend_operations')
