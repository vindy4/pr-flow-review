"""Responsibility classification must follow syntax and conventions, not keywords."""
import unittest

from backend.backend_layers import classify_backend

class BackendLayerTests(unittest.TestCase):
    def test_path_conventions_cover_backend_responsibilities_without_source(self):
        cases = {
            'app/orders/views.py': 'backend_api',
            'app/orders/interface/order_interface.py': 'backend_api',
            'app/orders/permissions.py': 'backend_auth',
            'app/orders/services/pricing.py': 'backend_logic',
            'app/orders/models/order.py': 'backend_data',
            'app/orders/tasks/reconcile.py': 'backend_async',
            'app/orders/integrations/payments.py': 'backend_integrations',
            'app/orders/read_models/summary.py': 'backend_reporting',
            'app/orders/management/commands/backfill.py': 'backend_operations',
        }
        for path, layer in cases.items():
            with self.subTest(path=path):
                result = classify_backend(path)
                self.assertIsNotNone(result)
                self.assertEqual(result['layer'], layer)
                self.assertEqual(result['facts'], [])
                self.assertTrue(result['reason'])

    def test_pension_directory_conventions_keep_primary_when_calling_downstream_api(self):
        cases = {
            'app/pension_management/validations/contribution.py': 'backend_logic',
            'app/pension_management/us_pension_401k/limits/annual.py': 'backend_logic',
            'app/pension_management/events_consumer/enrollment.py': 'backend_async',
            'app/pension_management/event_consumers/deduction.py': 'backend_async',
            'app/pension_management/listeners/company_change.py': 'backend_async',
            'app/pension_management/syncers/payroll.py': 'backend_integrations',
            'app/pension_management/census/upload.py': 'backend_reporting',
            'app/pension_management/dtoMapper/employee.py': 'backend_reporting',
            'app/pension_management/serializers/plan.py': 'backend_reporting',
            'app/pension_management/audits/enrollment.py': 'backend_operations',
            'app/pension_management/snowflake_audits/contribution.py': 'backend_operations',
            'app/pension_management/data_migration/shadow.py': 'backend_operations',
            'app/pension_management/retool/company.py': 'backend_operations',
            'app/pension_management/support/reconcile.py': 'backend_operations',
        }
        api_source = 'from fastapi import APIRouter\ndef build(): return APIRouter()\n'
        for path, layer in cases.items():
            for source in (None, api_source):
                with self.subTest(path=path, source_available=source is not None):
                    result = classify_backend(path, source)
                    self.assertEqual(result['layer'], layer)
                    if source is None:
                        self.assertEqual(result['facts'], [])
                    else:
                        self.assertIn('APIs & routing', result['roles'])

    def test_backend_contract_artifacts_stay_supporting(self):
        for path in ('app/pension_management/api/pension.proto',
                     'app/pension_management/models/plan.pyi'):
            with self.subTest(path=path):
                result = classify_backend(path, 'from celery import shared_task\n@shared_task\ndef run(): pass')
                self.assertIsNotNone(result)
                self.assertEqual(result['layer'], 'supporting')
                self.assertEqual(result['facts'], [])

    def test_controllers_keep_business_identity_when_calling_permissions_or_jobs(self):
        source = ('from app.permissions import has_access\nfrom app.tasks.sync import synchronize\n'
                  'def update():\n    if has_access(): synchronize()\n')
        result = classify_backend('app/controller/enrollment.py', source)
        self.assertEqual(result['layer'], 'backend_logic')
        self.assertIn('Authorization', result['roles'])
        self.assertIn('Jobs & workflows', result['roles'])

    def test_external_adapters_and_nested_gateway_rule_configuration_have_path_fallback(self):
        for path, layer in {
            'app/external/hris.py': 'backend_integrations',
            'app/insurance_api_gateway/rule_configuration/common/flex.yaml': 'backend_api',
        }.items():
            with self.subTest(path=path):
                result = classify_backend(path)
                self.assertEqual(result['layer'], layer)
                self.assertEqual(result['facts'], [])

    def test_comprehension_targets_shadow_imported_transport_names(self):
        result = classify_backend('app/custom.py',
            'import requests as http\nresults = [http.post() for http in clients]\n')
        self.assertEqual(result['layer'], 'other')
        self.assertEqual(result['facts'], [])

    def test_unknown_python_does_not_become_business_logic(self):
        self.assertEqual(classify_backend('app/helpers.py', 'def identity(value): return value')['layer'], 'other')
        for path in ('frontend/api/client.ts', 'components/Panel.tsx', 'index.js'):
            with self.subTest(path=path):
                self.assertIsNone(classify_backend(path, ''))

    def test_supporting_files_override_production_directories_and_source(self):
        for path in ('app/services/tests/test_prices.py', 'app/models/conftest.py',
                     'app/tasks/fixtures/seed.py', 'app/docs/example.py',
                     'app/services/integration_tests/check.py', 'app/tasks/unit_tests/check.py',
                     'app/models/unit_test/example.py',
                     'app/constants.py', 'app/dto/order.py', 'docs/backend.md', 'config/settings.yaml'):
            with self.subTest(path=path):
                result = classify_backend(path, 'from celery import shared_task\n@shared_task\ndef run(): pass')
                self.assertEqual(result['layer'], 'supporting')
                self.assertEqual(result['facts'], [])

    def test_backend_gateway_configuration_is_routing_with_path_only_evidence(self):
        result = classify_backend('app/orders/gateway/rule_configuration.yaml')
        self.assertEqual(result['layer'], 'backend_api')
        self.assertEqual(result['facts'], [])

    def test_specialized_responsibilities_win_over_generic_service_names(self):
        for path, layer in {
            'app/services/edt_outbox_writer.py': 'backend_async',
            'app/services/census_upload_history_service.py': 'backend_reporting',
            'app/interface/pension_edt_interface.py': 'backend_api',
            'app/services/order_projection.py': 'backend_reporting',
        }.items():
            with self.subTest(path=path):
                self.assertEqual(classify_backend(path)['layer'], layer)

    def test_external_repository_uses_imported_gateway_origin(self):
        source = ('from benefits_marketplace.platform.gateways.apis.benefits_flow_orch import create_sr as create\n'
                  'def save(payload):\n    return create(payload)\n')
        result = classify_backend('app/repositories/service_request_repository.py', source)
        self.assertEqual(result['layer'], 'backend_integrations')
        self.assertTrue(any('create(payload)' in fact['expression'] for fact in result['facts']))
        self.assertFalse(any('mongo' in fact['reason'].lower() for fact in result['facts']))

    def test_recognized_framework_syntax_classifies_unconventional_paths(self):
        cases = [
            ('from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/orders")\ndef load(): pass', 'backend_api'),
            ('from rest_framework.permissions import BasePermission as Permission\nclass Allowed(Permission): pass', 'backend_auth'),
            ('from django.db import models as db\nclass Order(db.Model): pass', 'backend_data'),
            ('from celery import shared_task as task\n@task\ndef rebuild(): pass', 'backend_async'),
            ('import requests as transport\ndef send(): return transport.post("https://example.org")', 'backend_integrations'),
        ]
        for source, layer in cases:
            with self.subTest(layer=layer):
                self.assertEqual(classify_backend('app/custom.py', source)['layer'], layer)

    def test_known_entrypoint_keeps_primary_with_secondary_query_and_transport_roles(self):
        source = ('import requests as http\nfrom app.models import Order\n'
                  'def get_orders():\n    orders = Order.objects.filter(active=True)\n'
                  '    return http.post("https://example.org", json=list(orders))\n')
        for path, layer in [('app/views/orders.py', 'backend_api'), ('app/permissions/access.py', 'backend_auth')]:
            with self.subTest(path=path):
                result = classify_backend(path, source)
                self.assertEqual(result['layer'], layer)
                self.assertIn('Data & persistence', result['roles'])
                self.assertIn('Integrations & delivery', result['roles'])

    def test_evidence_points_at_available_source_and_describes_syntax(self):
        source = 'import requests as http\n\ndef deliver(payload):\n    return http.post("https://example.org", json=payload)\n'
        result = classify_backend('app/helpers.py', source)
        self.assertTrue(any('http.post' in f['expression'] for f in result['facts']))
        fact = next(f for f in result['facts'] if 'http.post' in f['expression'])
        self.assertEqual(fact['path'], 'app/helpers.py')
        self.assertEqual(fact['line'], 4)
        self.assertIn('http.post', fact['code'])
        self.assertLessEqual(fact['startLine'], fact['line'])
        self.assertIsNone(fact['symbolId'])
        self.assertTrue(fact['kind'])
        self.assertNotIn('enqueues', fact['reason'])
        self.assertNotIn('writes to', fact['reason'])

    def test_comments_strings_and_unbound_method_names_do_not_create_roles(self):
        source = ('# @shared_task\ntext = "requests.post(); Model.objects.save(); router.get()"\n'
                  'def save(repository):\n    return repository.save()\n')
        result = classify_backend('app/helpers.py', source)
        self.assertEqual(result['layer'], 'other')
        self.assertEqual(result['facts'], [])

    def test_import_aliases_shadowed_by_parameters_or_assignments_are_not_framework_calls(self):
        sources = [
            'import requests as http\ndef send(http): return http.post("value")',
            'from celery import shared_task\nshared_task = lambda fn: fn\n@shared_task\ndef run(): pass',
            'import requests as http\ndef send():\n    http = object()\n    return http.post("value")',
            'import requests as http\ndef send():\n    http.post("value")\n    import custom as http',
        ]
        for source in sources:
            with self.subTest(source=source):
                result = classify_backend('app/helpers.py', source)
                self.assertEqual(result['layer'], 'other')
                self.assertEqual(result['facts'], [])

    def test_obvious_client_instance_and_callable_alias_preserve_import_origin(self):
        source = ('import httpx as transport\nclient = transport.Client()\nsend = client.post\n'
                  'def deliver(): return send("https://example.org")\n')
        result = classify_backend('app/helpers.py', source)
        self.assertEqual(result['layer'], 'backend_integrations')
        self.assertTrue(any(f['expression'].startswith('send(') for f in result['facts']))

    def test_invalid_python_retains_honest_path_only_classification(self):
        result = classify_backend('app/tasks/rebuild.py', 'def broken(')
        self.assertEqual(result['layer'], 'backend_async')
        self.assertEqual(result['facts'], [])


if __name__ == '__main__':
    unittest.main()
