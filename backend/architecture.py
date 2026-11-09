"""Versioned file/layer overview derived from syntax and explicit bindings."""
from collections import defaultdict
import hashlib
from pathlib import PurePosixPath
import re

from backend.javascript import text, walk, fingerprint
from backend.backend_layers import BACKEND_LAYERS, classify_backend

LAYERS = [
    {'id': 'ui', 'label': 'Screens & JSX', 'description': 'Pages, components and rendered UI'},
    {'id': 'client_state', 'label': 'Client state', 'description': 'Zustand stores and client-side actions'},
    {'id': 'server_state', 'label': 'Server state', 'description': 'React Query queries, mutations and options'},
    {'id': 'services', 'label': 'Services', 'description': 'Service boundaries, business logic and read models'},
    {'id': 'integrations', 'label': 'API integrations', 'description': 'API clients, transport and downstream integrations'},
    *BACKEND_LAYERS,
    {'id': 'supporting', 'label': 'Supporting changes', 'description': 'Routes, types, constants, translations, tests and fixtures'},
    {'id': 'other', 'label': 'Unclassified', 'description': 'Sources without a recognized architectural role'},
]
QUERY_APIS = {'useQuery', 'useSuspenseQuery', 'useInfiniteQuery', 'useSuspenseInfiniteQuery', 'queryOptions', 'infiniteQueryOptions'}
MUTATION_APIS = {'useMutation', 'mutationOptions'}


def classify(path, roles, has_functions=False):
    backend = classify_backend(path)
    if backend is not None:
        return backend['layer'], backend['reason']
    parts = PurePosixPath(path).parts
    name = PurePosixPath(path).name
    support = {'types.ts', 'types.tsx', 'contracts.ts', 'constants.ts', 'queryKeys.ts', 'AGENTS.md'}
    if (name in support or re.search(r'\.(types|constants|test|spec)\.', name) or
            any(p in {'__tests__', '__mocks__', 'tests', 'test', 'mocks', 'translations'} for p in parts) or name == '.gitkeep'):
        return 'supporting', 'File name or directory identifies supporting code'
    if 'routes' in parts or re.search(r'\.routes\.', name):
        return 'supporting', 'Routing module; supports navigation between screens'
    if 'Zustand' in roles:
        return 'client_state', 'Defines a store through an imported Zustand factory'
    if 'JSX' in roles:
        return 'ui', 'Contains JSX syntax'
    if 'React Query' in roles:
        return 'server_state', 'Uses a recognized API imported from @tanstack/react-query'
    if 'Local state' in roles:
        return 'client_state', 'Uses local React state through an imported useState/useReducer API'
    if 'Zustand consumer' in roles:
        return 'client_state', 'Reads or calls a store created through an imported Zustand factory'
    if any(p in {'integrations', 'api', 'transport'} for p in parts):
        return 'integrations', 'Directory convention identifies API integration code'
    if any(p in {'service', 'services', 'domain', 'read_models'} for p in parts) or 'Service façade' in roles:
        return 'services', 'Service directory, exported façade, or Python service context'
    if not has_functions and path.endswith(('.json', '.md', '.css', '.scss')):
        return 'supporting', 'Non-executable supporting file'
    return 'other', 'No recognized layer; kept visible for manual review'


def evidence(path, node, sources, kind, reason, symbol_id=None):
    line = node.start_point.row + 1
    start = max(1, line - 2)
    lines = sources[path].splitlines()
    return {'path': path, 'line': line, 'expression': text(node)[:3000], 'kind': kind, 'reason': reason,
            'symbolId': symbol_id, 'startLine': start, 'code': '\n'.join(lines[start - 1:line + 4])}


def nearest_symbol(snapshot, scope):
    while scope:
        sid = snapshot.node_symbols.get(scope.node.id)
        if sid:
            return sid
        scope = scope.parent
    return None


def imported_origin(snapshot, callee, scope):
    root = callee
    while root and root.type == 'member_expression':
        root = root.child_by_field_name('object')
    if root and root.type == 'identifier':
        binding = snapshot.lookup(scope, text(root))
        if binding and binding[0] in {'import', 'namespace'}:
            return binding[1]
    return None


def snapshot_architecture(snapshot, sources, symbols, side):
    files, connections = {}, []
    for path, source in sources.items():
        operations = [{'id': n['id'], 'label': n['qualname'], 'kind': n['kind'], 'line': n[side]['startLine']}
            for n in symbols if n.get(side) and n.get(side + 'Path') == path]
        files[path] = {'path': path, 'roles': [], 'facts': [], 'operations': operations, 'indexed': True}
        backend = classify_backend(path, source)
        if backend is not None:
            files[path].update(backend)
    if not snapshot:
        for file in files.values():
            if 'layer' not in file:
                file['layer'], file['reason'] = classify(file['path'], [], bool(file['operations']))
        return files, connections
    # Populate store definitions before visiting consumers in other modules.
    for node, scope in list(snapshot.syntax_nodes.values()):
        if node.type == 'variable_declarator':
            snapshot.expression_value(node.child_by_field_name('value'), scope)
    action_stores = {sid: store for store in snapshot.stores.values() for sid in store['actions'].values()}

    def add(path, target, relation, node, scope, reason, target_symbol=None):
        if target in files and path != target:
            ev = evidence(path, node, sources, relation, reason, nearest_symbol(snapshot, scope))
            ev['targetSymbolId'] = target_symbol
            connections.append({'source': path, 'target': target, 'relation': relation,
                'evidence': ev})

    def fact(path, node, scope, kind, role, reason):
        file = files[path]
        if role not in file['roles']:
            file['roles'].append(role)
        file['facts'].append(evidence(path, node, sources, kind, reason, nearest_symbol(snapshot, scope)))

    for path, module in snapshot.modules.items():
        for node in walk(module.node):
            scope = snapshot.owners.get(node.id, module)
            if node.type in {'jsx_opening_element', 'jsx_self_closing_element'}:
                if 'JSX' not in files[path]['roles']:
                    fact(path, node, scope, 'jsx', 'JSX', 'JSX render syntax')
                callee = node.child_by_field_name('name')
                target = snapshot.resolve(callee, scope) if callee else None
                if target:
                    add(path, snapshot.symbols[target].path, 'renders', node, scope, 'JSX references a bound component')
            if node.type == 'import_statement':
                clause = next((c for c in node.named_children if c.type == 'import_clause'), None)
                if text(node).startswith('import type '):
                    continue
                if clause:
                    names = [c for c in walk(clause) if c.type == 'import_specifier']
                    other = any(c.type in {'identifier', 'namespace_import'} for c in clause.named_children)
                    if names and not other and all(text(n).startswith('type ') for n in names):
                        continue
                target = snapshot.module_path(path, text(node.child_by_field_name('source'))[1:-1])
                add(path, target, 'imports', node, scope, 'Runtime import dependency; not proof of a function invocation')
            if node.type != 'call_expression':
                continue
            callee = node.child_by_field_name('function')
            if not callee:
                continue
            api = snapshot.external_api(callee, scope)
            arguments = node.child_by_field_name('arguments')
            if api and api[0] == '@tanstack/react-query' and api[1] in QUERY_APIS | MUTATION_APIS:
                mutation = api[1] in MUTATION_APIS
                fact(path, node, scope, 'mutation' if mutation else 'query', 'React Query',
                     f'{api[1]} imported from @tanstack/react-query; registers server-state behavior')
                if arguments:
                    for arg in arguments.named_children:
                        if arg.type == 'call_expression':
                            target = snapshot.resolve(arg.child_by_field_name('function'), scope)
                            if target:
                                add(path, snapshot.symbols[target].path, 'mutates' if mutation else 'runs_query', node, scope,
                                    'React Query consumes these options; query/mutation execution depends on the framework')
                        value = snapshot.expression_value(arg, scope)
                        if value and value[0] == 'object':
                            obj, obj_scope = snapshot.syntax_nodes[value[1]]
                            field = 'mutationFn' if mutation else 'queryFn'
                            callback = (snapshot.object_fields(obj) or {}).get(field)
                            if callback:
                                callback_scope = snapshot.owners.get(callback.id, obj_scope)
                                target = snapshot.resolve(callback, callback_scope)
                                if target:
                                    target_path = snapshot.symbols[target].path
                                    origin = imported_origin(snapshot, callback, callback_scope)
                                    add(path, origin or target_path, 'mutates' if mutation else 'runs_query', callback, callback_scope,
                                        f'React Query {field} registration; this function reference does not prove immediate execution', target)
            if api == ('react', 'useState') or api == ('react', 'useReducer'):
                fact(path, node, scope, 'local_state', 'Local state', f'{api[1]} imported from React')
            value = snapshot.expression_value(callee, scope)
            if value and value[0] in {'store', 'store_method'}:
                store = snapshot.stores[value[1]]
                write = value[0] == 'store_method' and value[2] == 'setState'
                kind = 'updates_store' if write else 'reads_store'
                fact(path, node, scope, kind, 'Zustand consumer', 'Reference to a store created through an imported Zustand factory')
                add(path, store['path'], kind, node, scope, 'Updates Zustand state' if write else 'Reads or subscribes to Zustand state')
            target = snapshot.resolve(callee, scope)
            if target:
                target_path = snapshot.symbols[target].path
                store = action_stores.get(target)
                origin = imported_origin(snapshot, callee, scope)
                if store:
                    relation, target_path = 'calls_store_action', store['path']
                    fact(path, node, scope, relation, 'Zustand consumer', 'Calls an action explicitly defined in a Zustand store initializer')
                elif origin and origin != target_path:
                    relation, target_path = 'calls_service', origin
                else:
                    relation = 'calls'
                add(path, target_path, relation, node, scope, 'Callable target resolved through explicit lexical/import/object bindings', target)
        # Preserve an exported object facade in the overview even when a method
        # graph jumps directly to the referenced implementation function.
        for exported in snapshot.exports[path].values():
            binding = snapshot.lookup(module, exported[1]) if exported[0] == 'local' else exported
            value = snapshot.binding_value(binding)
            if not value or value[0] != 'object':
                continue
            obj, _ = snapshot.syntax_nodes[value[1]]
            for prop in walk(obj):
                if prop.type not in {'pair', 'shorthand_property_identifier'}:
                    continue
                expr = prop.child_by_field_name('value') or prop
                target = snapshot.resolve(expr, snapshot.owners.get(expr.id, module))
                if target and snapshot.symbols[target].path != path:
                    fact(path, prop, module, 'facade', 'Service façade', 'Exported object property delegates to an imported function')
                    add(path, snapshot.symbols[target].path, 'delegates', prop, module, 'Object property references this implementation; not an invocation by itself', target)
    for store in snapshot.stores.values():
        node = store['node']
        scope = snapshot.owners[node.id]
        fact(store['path'], node, scope, 'store', 'Zustand', 'Store defined through an imported Zustand create/createStore factory')
    for path, file in files.items():
        if 'layer' not in file:
            file['layer'], file['reason'] = classify(path, file['roles'], bool(file['operations']))
        if file['layer'] == 'integrations' and 'API integration' not in file['roles']:
            file['roles'].append('API integration')
        if file['layer'] == 'supporting' and not file['roles']:
            file['roles'].append('Supporting')
        if path not in snapshot.trees and not path.endswith('.py'):
            file['indexed'] = False
            file['reason'] = 'Syntax parsing failed; source relationships unavailable'
    # Give ordinary resolved calls their architectural meaning after classifying
    # both endpoints. Fall back to imports only when no semantic edge exists.
    semantic_pairs = {(e['source'], e['target']) for e in connections if e['relation'] != 'imports'}
    for edge in connections:
        if edge['relation'] == 'calls':
            layer = files[edge['target']]['layer']
            edge['relation'] = {'services': 'calls_service', 'integrations': 'calls_api'}.get(layer, 'calls')
    return files, [e for e in connections if e['relation'] != 'imports' or (e['source'], e['target']) not in semantic_pairs]


def build_architecture(base_sources, head_sources, result, changed_paths, renames=None, snapshots=None):
    renames = renames or {}
    snapshots = snapshots or (None, None)
    before, a_edges = snapshot_architecture(snapshots[0], base_sources, result['nodes'], 'base')
    after, b_edges = snapshot_architecture(snapshots[1], head_sources, result['nodes'], 'head')
    # Python relationships use the existing AST analyzer's proven calls.
    by_id = {n['id']: n for n in result['nodes']}
    for side, files, edges in (('base', before, a_edges), ('head', after, b_edges)):
        for edge in result['edges']:
            source = by_id[edge['source']]
            target = by_id[edge['target']]
            if source.get('language') != 'python' or not edge['inBase' if side == 'base' else 'inHead']:
                continue
            path, other = source[side + 'Path'], target[side + 'Path']
            if path != other:
                line = edge[side + 'Line']
                relation = {
                    'backend_auth': 'checks_permission', 'backend_logic': 'calls_service',
                    'backend_data': 'calls_data_access', 'backend_async': 'calls_job',
                    'backend_integrations': 'calls_integration', 'backend_reporting': 'calls_report',
                    'backend_operations': 'calls_operation',
                }.get(files[other]['layer'], 'calls')
                edges.append({'source': path, 'target': other, 'relation': relation,
                    'evidence': {'path': path, 'line': line, 'expression': edge[side + 'Expression'], 'kind': relation,
                        'symbolId': source['id'], 'reason': 'Callable resolved by the Python AST analyzer', 'startLine': line,
                        'code': source[side]['code'].splitlines()[line - source[side]['startLine']]}})
    paths = set(after) | {renames.get(p, p) for p in before}
    reverse = {new: old for old, new in renames.items()}
    nodes = []
    for path in sorted(paths):
        old_path = reverse.get(path, path)
        a, b = before.get(old_path), after.get(path)
        status = 'added' if not a else 'removed' if not b else 'modified' if old_path in changed_paths or path in changed_paths else 'unchanged'
        if a and b and old_path != path:
            # Full-file comparison still catches imports/constants changed
            # around methods; symbol move statuses alone cannot decide it.
            old_tree = snapshots[0].trees.get(old_path) if snapshots[0] else None
            new_tree = snapshots[1].trees.get(path) if snapshots[1] else None
            same = fingerprint(old_tree.root_node) == fingerprint(new_tree.root_node) if old_tree and new_tree else base_sources[old_path] == head_sources[path]
            status = 'moved' if same else 'moved_modified'
        nodes.append({'id': 'file:' + path, 'path': path, 'label': PurePosixPath(path).name,
            'status': status, 'base': a, 'head': b, 'symbolIds': [n['id'] for n in result['nodes']
                if n.get('basePath') == old_path or n.get('headPath') == path]})
    groups = defaultdict(lambda: {'base': [], 'head': []})
    for side, edges in (('base', a_edges), ('head', b_edges)):
        for edge in edges:
            source = renames.get(edge['source'], edge['source']) if side == 'base' else edge['source']
            target = renames.get(edge['target'], edge['target']) if side == 'base' else edge['target']
            key = ('file:' + source, 'file:' + target, edge['relation'])
            ev = edge['evidence']
            # Canonicalize a moved symbol ID, while keeping its original path.
            if ev.get('symbolId'):
                match = next((n['id'] for n in result['nodes'] if n.get('baseId') == ev['symbolId']), None)
                ev['symbolId'] = match or ev['symbolId']
            if ev.get('targetSymbolId'):
                match = next((n['id'] for n in result['nodes'] if n.get('baseId') == ev['targetSymbolId']), None)
                ev['targetSymbolId'] = match or ev['targetSymbolId']
            if ev not in groups[key][side]:
                groups[key][side].append(ev)
    edges = []
    for key, versions in sorted(groups.items()):
        a, b = versions['base'], versions['head']
        edges.append({'id': 'architecture:' + hashlib.sha256(repr(key).encode()).hexdigest()[:20],
            'source': key[0], 'target': key[1], 'relation': key[2], 'inBase': bool(a), 'inHead': bool(b),
            'status': 'unchanged' if a and b else 'added' if b else 'removed', 'baseEvidence': a, 'headEvidence': b})
    architecture = {'layers': LAYERS, 'nodes': nodes, 'edges': edges, 'features': [], 'summaries': []}
    refresh_overview(architecture)
    return architecture


def refresh_overview(architecture):
    nodes, edges = architecture['nodes'], architecture['edges']
    screens = [n for n in nodes if n['status'] != 'unchanged' and (n.get('head') or n.get('base'))['layer'] == 'ui']
    if not screens:
        screens = [n for n in nodes if n['status'] != 'unchanged' and (n.get('head') or n.get('base'))['layer'] not in {'supporting', 'other'}]
    def score(node):
        version = node.get('head') or node['base']
        return (not bool(node.get('head')), not ('Page' in node['label']), -sum(e['source'] == node['id'] and e['inHead'] for e in edges), version['path'])
    architecture['features'] = [{'id': n['id'], 'root': n['id'], 'label': n['label']} for n in sorted(screens, key=score)]
    changes = [n for n in nodes if n['status'] != 'unchanged']
    moved = [n for n in changes if n['status'].startswith('moved')]
    removed = [n for n in changes if n['status'] == 'removed']
    summaries = []
    for layer in architecture.get('layers', LAYERS):
        files = [n for n in changes if (n.get('head') or n['base'])['layer'] == layer['id']]
        if files:
            summaries.append({'id': layer['id'], 'title': layer['label'], 'body': f"{len(files)} changed file{'s' if len(files) != 1 else ''}", 'fileIds': [n['id'] for n in files]})
    if moved:
        summaries.insert(0, {'id': 'moves', 'title': 'Code reorganized', 'body': f'{len(moved)} files moved; preserved Before/After paths', 'fileIds': [n['id'] for n in moved]})
    if removed:
        summaries.append({'id': 'removed', 'title': 'Removed files', 'body': f'{len(removed)} removed files remain available in Before and the change inventory', 'fileIds': [n['id'] for n in removed]})
    architecture['summaries'] = summaries


def include_unindexed_files(architecture, files):
    existing = {n['path']: n for n in architecture['nodes']}
    for file in files:
        path = file['path']
        def version(p):
            backend = classify_backend(p)
            layer, reason = classify(p, []) if backend is None else (backend['layer'], backend['reason'])
            return {'path': p, 'layer': layer, 'reason': reason,
                    'roles': backend['roles'] if backend else ['Supporting'] if layer == 'supporting' else [],
                    'facts': [], 'operations': [], 'indexed': False}
        node = existing.get(path)
        if node is not None:
            # Scope/size limits can index only one side of a move. Preserve
            # proven source metadata and fill the other side from its path.
            filled = False
            if node.get('base') is None and file['status'] != 'added':
                node['base'] = version(file.get('previousPath', path))
                filled = True
            if node.get('head') is None and file['status'] != 'removed':
                node['head'] = version(path)
                filled = True
            if filled:
                node['status'] = file['status']
            continue
        architecture['nodes'].append({'id': 'file:' + path, 'path': path, 'label': PurePosixPath(path).name,
            'status': file['status'], 'base': None if file['status'] == 'added' else version(file.get('previousPath', path)),
            'head': None if file['status'] == 'removed' else version(path), 'symbolIds': []})
    refresh_overview(architecture)
