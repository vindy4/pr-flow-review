"""Conservative Python responsibility hints; syntax is evidence, never execution."""
import ast
from pathlib import PurePosixPath
import re

BACKEND_LAYERS = [
    {'id': 'backend_api', 'label': 'APIs & routing', 'description': 'Inbound endpoints, routing and request interfaces'},
    {'id': 'backend_auth', 'label': 'Authorization', 'description': 'Permissions and access policies'},
    {'id': 'backend_logic', 'label': 'Business logic & rules', 'description': 'Domain services, validation and business rules'},
    {'id': 'backend_data', 'label': 'Data & persistence', 'description': 'Models, repositories and database access'},
    {'id': 'backend_async', 'label': 'Jobs & workflows', 'description': 'Tasks, workflows, events and outbox coordination'},
    {'id': 'backend_integrations', 'label': 'Integrations & delivery', 'description': 'Outbound gateways, clients and delivery adapters'},
    {'id': 'backend_reporting', 'label': 'Reporting & projections', 'description': 'Reports, history views and read models'},
    {'id': 'backend_operations', 'label': 'Operations & migrations', 'description': 'Migrations, backfills and operational commands'},
]
_LABELS = {layer['id']: layer['label'] for layer in BACKEND_LAYERS}
_SUPPORT = {'tests', 'test', '__tests__', 'integration_tests', 'unit_tests', 'unit_test', 'fixtures', 'mocks', '__mocks__', 'docs', 'documentation',
            'dto', 'dtos', 'types', 'constants', 'enums', 'dataclasses', 'exceptions', 'errors'}
_PATH_RULES = [
    ('backend_operations', {'migrations', 'migration', 'scripts', 'operations', 'commands', 'backfill', 'backfills', 'cleanup',
                            'audits', 'snowflake_audits', 'data_migration', 'retool', 'support'}),
    ('backend_auth', {'auth', 'authorization', 'permissions', 'permission', 'access_control', 'acl'}),
    ('backend_api', {'api', 'apis', 'views', 'view', 'viewsets', 'viewset', 'routes', 'routing', 'router', 'routers',
                     'urls', 'interface', 'interfaces'}),
    ('backend_async', {'tasks', 'task', 'jobs', 'job', 'workflows', 'workflow', 'orchestrator', 'orchestration',
                       'outbox', 'consumers', 'producers', 'events_consumer', 'event_consumers', 'listeners'}),
    ('backend_reporting', {'reports', 'reporting', 'report', 'read_models', 'read_model', 'projections', 'projection', 'upload_history',
                           'census', 'dtomapper', 'serializers'}),
    ('backend_integrations', {'integrations', 'integration', 'clients', 'client', 'gateways', 'transport', 'delivery', 'sftp', 'external', 'syncers'}),
    ('backend_data', {'models', 'model', 'repositories', 'repository', 'persistence', 'storage', 'database', 'dao'}),
    ('backend_logic', {'services', 'service', 'domain', 'rules', 'validators', 'validation', 'validations', 'limits', 'calculators', 'controller', 'controllers'}),
]


def _path_layer(path):
    parts = set(path.parts[:-1])
    stem = path.stem
    if parts & _SUPPORT or stem in _SUPPORT | {'conftest', '__init__'} or re.search(r'(^test_|_test$|_tests$)', stem):
        return 'supporting'
    if path.suffix in {'.yaml', '.yml'}:
        gateway = any(part in {'gateway', 'gateways'} or part.endswith('_gateway') for part in parts)
        return 'backend_api' if gateway and (stem == 'rule_configuration' or 'rule_configuration' in parts) else 'supporting'
    if path.suffix != '.py':
        return 'supporting'
    # Match full convention components and underscore-delimited filename tokens,
    # rather than arbitrary substrings (e.g. a customer's country/provider name).
    names = parts | {stem} | set(stem.split('_'))
    if 'gateway' in parts and stem in {'route', 'routes', 'routing'}:
        return 'backend_api'
    for layer, conventions in _PATH_RULES:
        if names & conventions or any(('_' + c + '_') in ('_' + stem + '_') for c in conventions):
            return layer
    if stem.endswith('_gateway'):
        return 'backend_integrations'
    return 'other'


def _signal(origin):
    """Recognize explicit import origins, without guessing unknown .save/.delay calls."""
    parts = origin.split('.')
    root, leaf = parts[0], parts[-1]
    if (origin.startswith(('rest_framework.permissions.', 'django.contrib.auth.decorators.')) or
            any(p in {'permissions', 'authorization', 'access_control'} for p in parts[:-1])):
        return 'backend_auth'
    if (origin.startswith(('fastapi.', 'flask.')) and leaf in
            {'APIRouter', 'FastAPI', 'Flask', 'route', 'get', 'post', 'put', 'patch', 'delete', 'api_route'} or
            origin in {'django.urls.path', 'django.urls.re_path', 'django.conf.urls.url'} or
            origin.startswith('rest_framework.decorators.') and leaf in {'api_view', 'action'}):
        return 'backend_api'
    if (root == 'celery' and leaf in {'shared_task', 'task', 'Celery', 'delay', 'apply_async'} or
            origin.startswith(('temporalio.workflow.', 'temporalio.activity.', 'prefect.', 'airflow.')) or
            any(p in {'tasks', 'jobs', 'workflows', 'outbox'} for p in parts[:-1])):
        return 'backend_async'
    if (root in {'requests', 'httpx', 'aiohttp', 'boto3', 'botocore', 'paramiko'} or
            any(p in {'gateways', 'integrations', 'transport', 'external'} for p in parts[:-1])):
        return 'backend_integrations'
    if (origin in {'django.db.models.Model', 'mongoengine.Document', 'mongoengine.EmbeddedDocument',
                   'sqlalchemy.orm.DeclarativeBase', 'sqlalchemy.ext.declarative.declarative_base'} or
            root in {'pymongo', 'mongoengine', 'sqlalchemy', 'psycopg', 'psycopg2', 'sqlite3'} or
            'objects' in parts and 'models' in parts):
        return 'backend_data'
    return None


class _Syntax(ast.NodeVisitor):
    def __init__(self, path, source):
        self.path, self.source = path, source
        self.scopes = [{}]
        self.facts, self.layers = [], []

    def origin(self, node):
        if isinstance(node, ast.Name):
            return next((scope[node.id] for scope in reversed(self.scopes) if node.id in scope), None)
        if isinstance(node, ast.Attribute):
            base = self.origin(node.value)
            return base + '.' + node.attr if base else None
        if isinstance(node, ast.Call):
            base = self.origin(node.func)
            if base and base.rsplit('.', 1)[-1] in {'Client', 'AsyncClient', 'Session', 'ClientSession',
                                                     'APIRouter', 'FastAPI', 'Flask', 'MongoClient', 'Queue'}:
                return base
        return None

    def inspect(self, node):
        origin = self.origin(node.func if isinstance(node, ast.Call) else node)
        layer = _signal(origin) if origin else None
        if not layer:
            return
        # Bound snippets per responsibility while keeping aliases inspectable.
        if sum(fact['kind'] == layer for fact in self.facts) >= 3 or any(
                fact['line'] == node.lineno and fact['kind'] == layer for fact in self.facts):
            return
        if layer not in self.layers:
            self.layers.append(layer)
        line = node.lineno
        start = max(1, line - 2)
        self.facts.append({'path': self.path, 'line': line,
            'expression': (ast.get_source_segment(self.source, node) or '')[:3000],
            'kind': layer, 'reason': f'Syntax references {origin}, an imported {_LABELS[layer].lower()} API',
            'symbolId': None, 'startLine': start,
            'code': '\n'.join(self.source.splitlines()[start - 1:line + 4])})

    def visit_Import(self, node):
        for item in node.names:
            self.scopes[-1][item.asname or item.name.split('.')[0]] = item.name if item.asname else item.name.split('.')[0]

    def visit_ImportFrom(self, node):
        for item in node.names:
            if item.name != '*':
                self.scopes[-1][item.asname or item.name] = (node.module + '.' if node.module else '') + item.name

    def visit_Assign(self, node):
        self.visit(node.value)
        origin = self.origin(node.value)
        for target in node.targets:
            for name in ast.walk(target):
                if isinstance(name, ast.Name) and isinstance(name.ctx, ast.Store):
                    self.scopes[-1][name.id] = origin if isinstance(target, ast.Name) else None

    def visit_AnnAssign(self, node):
        if node.value:
            self.visit(node.value)
        if isinstance(node.target, ast.Name):
            self.scopes[-1][node.target.id] = self.origin(node.value)

    def _body(self, node, params=()):
        # Python locals shadow enclosing imports throughout a function, even
        # before the assignment. Nested scopes do not bind names in this one.
        bound = {arg.arg: None for arg in params}
        def collect(child):
            if isinstance(child, (ast.Import, ast.ImportFrom)):
                for item in child.names:
                    bound[item.asname or item.name.split('.')[0]] = None
                return
            if isinstance(child, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                return
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                bound[child.name] = None
                return
            if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)):
                bound[child.id] = None
            for nested in ast.iter_child_nodes(child):
                collect(nested)
        for child in node.body:
            collect(child)
        self.scopes.append(bound)
        for child in node.body:
            self.visit(child)
        self.scopes.pop()

    def visit_FunctionDef(self, node):
        for decorator in node.decorator_list:
            self.inspect(decorator)
            self.visit(decorator)
        for default in node.args.defaults + [d for d in node.args.kw_defaults if d]:
            self.visit(default)
        self.scopes[-1][node.name] = None
        args = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
        self._body(node, args + [a for a in (node.args.vararg, node.args.kwarg) if a])

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        for base in node.bases + node.decorator_list:
            self.inspect(base)
            self.visit(base)
        self.scopes[-1][node.name] = None
        self._body(node)

    def visit_Call(self, node):
        self.inspect(node)
        self.generic_visit(node)

    def visit_ListComp(self, node):
        self.visit(node.generators[0].iter)
        self.scopes.append({})
        for index, generator in enumerate(node.generators):
            if index:
                self.visit(generator.iter)
            for target in ast.walk(generator.target):
                if isinstance(target, ast.Name):
                    self.scopes[-1][target.id] = None
            for condition in generator.ifs:
                self.visit(condition)
        for value in ([node.key, node.value] if isinstance(node, ast.DictComp) else [node.elt]):
            self.visit(value)
        self.scopes.pop()

    visit_SetComp = visit_DictComp = visit_GeneratorExp = visit_ListComp

    def visit_Lambda(self, node):
        args = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
        self.scopes.append({arg.arg: None for arg in args + [a for a in (node.args.vararg, node.args.kwarg) if a]})
        self.visit(node.body)
        self.scopes.pop()


def classify_backend(path, source=None):
    """Return a backend layer plus descriptive facts, or None for other languages.

    Path conventions survive missing/invalid source. Imported API calls and class
    bases provide secondary roles; they do not prove execution or side effects.
    """
    normalized = PurePosixPath(path.replace('\\', '/').lower())
    if normalized.suffix not in {'.py', '.pyi', '.proto', '.yaml', '.yml', '.md', '.rst'}:
        return None
    layer = _path_layer(normalized)
    reason = ('File name or directory identifies supporting code' if layer == 'supporting' else
              'No recognized backend responsibility; kept visible for manual review' if layer == 'other' else
              f'Path convention identifies {_LABELS[layer].lower()}')
    result = {'layer': layer, 'reason': reason, 'roles': [], 'facts': []}
    if layer == 'supporting':
        result['roles'] = ['Supporting']
        return result
    syntax = None
    if source is not None and normalized.suffix == '.py':
        try:
            tree = ast.parse(source)
        except (SyntaxError, ValueError, TypeError, RecursionError):
            pass
        else:
            syntax = _Syntax(path, source)
            syntax.visit(tree)
            result['facts'] = syntax.facts
    if syntax and syntax.layers:
        # Entry boundaries retain identity when they query storage or call a
        # transport. A repository backed by an outbound gateway is an adapter.
        preferred = next((p for p in ('backend_api', 'backend_auth', 'backend_async') if p in syntax.layers), None)
        if layer == 'other':
            layer = preferred or syntax.layers[0]
        elif layer == 'backend_data' and 'backend_integrations' in syntax.layers:
            layer = 'backend_integrations'
        if layer != result['layer']:
            result.update(layer=layer, reason=f'Imported syntax identifies {_LABELS[layer].lower()}')
    result['roles'] = [_LABELS[layer]] if layer in _LABELS else []
    if syntax:
        result['roles'].extend(_LABELS[p] for p in syntax.layers if _LABELS[p] not in result['roles'])
    return result
