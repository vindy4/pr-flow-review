"""Tree-sitter JS/TS source relationships. Never evaluate target sources.

Bindings are lexical/import-only. Unknown receivers, reassignment and props
remain unresolved; types are not used as proof of a runtime target.
"""
from __future__ import annotations

import difflib
import hashlib
import posixpath
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from tree_sitter import Language, Node, Parser
import tree_sitter_javascript
import tree_sitter_typescript

from backend.javascript_bindings import SyntaxBindings

EXTENSIONS = {'.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'}
FUNCTIONS = {'function_declaration', 'generator_function_declaration', 'function_expression',
             'generator_function', 'arrow_function', 'method_definition'}
LANGUAGES = {
    'js': Language(tree_sitter_javascript.language()),
    'ts': Language(tree_sitter_typescript.language_typescript()),
    'tsx': Language(tree_sitter_typescript.language_tsx()),
}


def is_javascript(path):
    return PurePosixPath(path).suffix in EXTENSIONS and not path.endswith(('.d.ts', '.d.mts', '.d.cts'))


def text(node: Node | None):
    return node.text.decode('utf-8') if node else ''


def fingerprint(node):
    # Leaf tokens retain punctuation/literals but discard trivia and positions.
    if node.type == 'comment':
        return ()
    return (node.type, tuple(fingerprint(c) for c in node.children if c.type != 'comment')) if node.children else (node.type, text(node))


@dataclass
class Scope:
    path: str
    node: Node
    parent: Scope | None
    qualname: str = ''
    kind: str = 'block'
    bindings: dict = field(default_factory=dict)
    declarations: dict = field(default_factory=dict)
    count: int = 0

    def bind(self, name, value):
        if name:
            self.bindings[name] = value if name not in self.bindings else None


class Snapshot(SyntaxBindings):
    def __init__(self, sources, trees):
        self.sources, self.trees = sources, trees
        self.modules, self.symbols, self.owners, self.exports = {}, {}, {}, {}
        self.node_symbols = {}
        self.calls, self.unresolved = {}, {}
        self.warnings = []
        self.writes = []
        self.wrapped_callbacks = []
        self.syntax_nodes, self.stores = {}, {}
        self.invalid_objects, self.member_writes = set(), []
        for path, tree in trees.items():
            scope = Scope(path, tree.root_node, None, kind='module')
            self.modules[path] = scope
            self.exports[path] = {}
            self.index(tree.root_node, scope)
        # All writes invalidate the corresponding lexical binding regardless of
        # execution order. Do this after declarations to catch forward writes.
        invalid = set()
        for scope, name in self.writes:
            while scope:
                if name in scope.bindings:
                    scope.bindings[name] = None
                    invalid.add((id(scope), name))
                    break
                scope = scope.parent
        for scope, name, callee, symbol_id in self.wrapped_callbacks:
            value = self.lookup(scope, text(callee)) if callee.type == 'identifier' else None
            if (value and value[0] == 'import' and value[2:] == ('useCallback', 'react')
                    and scope.declarations.get(name) == 1
                    and (id(scope), name) not in invalid):
                scope.bindings[name] = ('symbol', symbol_id)
        for path, module in self.modules.items():
            self.index_exports(path, module.node)
        self.invalidate_member_writes()
        for symbol_id, scope in self.symbols.items():
            self.unresolved[symbol_id] = []
            body = scope.node.child_by_field_name('body')
            if body:
                self.visit(body, scope, symbol_id, {})

    def binding_names(self, node):
        if not node:
            return []
        if node.type in {'identifier', 'shorthand_property_identifier_pattern'}:
            return [text(node)]
        if node.type in {'required_parameter', 'optional_parameter', 'assignment_pattern', 'object_assignment_pattern'}:
            return self.binding_names(node.child_by_field_name('pattern') or node.child_by_field_name('left'))
        if node.type == 'pair_pattern':
            return self.binding_names(node.child_by_field_name('value'))
        if node.type in {'object_pattern', 'array_pattern', 'rest_pattern', 'formal_parameters'}:
            return [name for c in node.named_children for name in self.binding_names(c)]
        return []

    def index(self, node, scope):
        self.owners[node.id] = scope
        self.syntax_nodes[node.id] = (node, scope)
        if node.type == 'import_statement':
            self.index_import(node, scope)
            return
        if node.type in FUNCTIONS and node.child_by_field_name('body'):
            parent = node.parent
            name = text(node.child_by_field_name('name'))
            binding = name if node.type in {'function_declaration', 'generator_function_declaration'} else ''
            if not name and parent and parent.type in {'variable_declarator', 'pair', 'public_field_definition', 'field_definition'}:
                name = text(parent.child_by_field_name('name') or parent.child_by_field_name('key'))
                if parent.type == 'variable_declarator':
                    binding = name
            wrapper = None
            if not name and parent and parent.type == 'arguments' and parent.parent.type == 'call_expression':
                call = parent.parent
                if call.parent and call.parent.type == 'variable_declarator' and parent.named_children[0].id == node.id:
                    name = text(call.parent.child_by_field_name('name'))
                    wrapper = call.child_by_field_name('function')
            if not name:
                scope.count += 1
                name = 'default' if scope.kind == 'module' and parent and parent.type == 'export_statement' else f'<callback:{scope.count}>'
            qualname = f'{scope.qualname}.{name}' if scope.qualname else name
            symbol_id = f'{scope.path}:{qualname}'
            if symbol_id in self.symbols:
                # Block-local duplicates still have separate inventory IDs.
                scope.count += 1
                qualname += f'~{scope.count}'
                symbol_id = f'{scope.path}:{qualname}'
            child = Scope(scope.path, node, scope, qualname, 'method' if node.type == 'method_definition' or scope.kind == 'class' else 'function')
            self.symbols[symbol_id] = child
            self.node_symbols[node.id] = symbol_id
            if wrapper and name:
                self.wrapped_callbacks.append((scope, name, wrapper, symbol_id))
            if binding:
                # Variable declarator already reserved this binding.
                if parent and parent.type == 'variable_declarator':
                    if scope.declarations.get(binding) == 1:
                        scope.bindings[binding] = ('symbol', symbol_id)
                else:
                    scope.bind(binding, ('symbol', symbol_id))
            # Named function expressions bind their own name only internally.
            own_name = text(node.child_by_field_name('name'))
            if own_name and node.type in {'function_expression', 'generator_function'}:
                child.bind(own_name, ('symbol', symbol_id))
            params = node.child_by_field_name('parameters') or node.child_by_field_name('parameter')
            for parameter in self.binding_names(params):
                child.bind(parameter, None)
            self.owners[node.id] = child
            for c in node.named_children:
                self.index(c, child)
            return
        if node.type in {'class_declaration', 'class'}:
            name = text(node.child_by_field_name('name')) or '<class>'
            scope.bind(name, None)
            child = Scope(scope.path, node, scope, f'{scope.qualname}.{name}'.strip('.'), 'class')
            for c in node.named_children:
                self.index(c, child)
            return
        if node.type in {'statement_block', 'catch_clause', 'for_statement', 'for_in_statement', 'switch_statement'}:
            scope = Scope(scope.path, node, scope, scope.qualname)
            self.owners[node.id] = scope
            if node.type == 'catch_clause':
                for name in self.binding_names(node.child_by_field_name('parameter')):
                    scope.bind(name, None)
            if node.type == 'for_in_statement':
                left = node.child_by_field_name('left')
                kind = text(node.child_by_field_name('kind'))
                if kind:
                    dest = scope
                    if kind == 'var':
                        while dest.parent and dest.kind == 'block':
                            dest = dest.parent
                    for name in self.binding_names(left):
                        dest.bind(name, None)
                else:
                    for name in self.binding_names(left):
                        self.writes.append((scope, name))
        if node.type == 'variable_declarator':
            dest = scope
            # var is function-scoped, even when declared in a nested block.
            if node.parent and text(node.parent).lstrip().startswith('var '):
                while dest.parent and dest.kind == 'block':
                    dest = dest.parent
            for name in self.binding_names(node.child_by_field_name('name')):
                pattern = node.child_by_field_name('name')
                value = node.child_by_field_name('value')
                binding = ('expression', value.id) if value and pattern.type == 'identifier' else None
                if value and pattern.type == 'object_pattern':
                    for prop in pattern.named_children:
                        if prop.type == 'shorthand_property_identifier_pattern' and text(prop) == name:
                            binding = ('property', value.id, name)
                        elif prop.type == 'pair_pattern' and text(prop.child_by_field_name('value')) == name:
                            binding = ('property', value.id, text(prop.child_by_field_name('key')))
                if value and pattern.type == 'array_pattern' and len(pattern.named_children) == 2 and text(pattern.named_children[1]) == name:
                    binding = ('local_setter', value.id)
                dest.bind(name, binding)
                dest.declarations[name] = dest.declarations.get(name, 0) + 1
        deleting = node.type == 'unary_expression' and text(node.child_by_field_name('operator')) == 'delete'
        if node.type in {'assignment_expression', 'augmented_assignment_expression', 'update_expression'} or deleting:
            left = node.child_by_field_name('left') or node.child_by_field_name('argument')
            for name in self.binding_names(left):
                self.writes.append((scope, name))
            if left and left.type in {'member_expression', 'subscript_expression'}:
                self.member_writes.append((left, scope))
        for c in node.named_children:
            self.index(c, scope)

    def index_import(self, node, scope):
        if text(node).startswith('import type '):
            return
        specifier = text(node.child_by_field_name('source'))[1:-1]
        module = self.module_path(scope.path, specifier)
        clause = next((c for c in node.named_children if c.type == 'import_clause'), None)
        if not clause:
            return
        for c in clause.named_children:
            if c.type == 'identifier':
                scope.bind(text(c), ('import', module, 'default', specifier))
            elif c.type == 'namespace_import':
                scope.bind(text(c.named_children[-1]), ('namespace', module, specifier))
            elif c.type == 'named_imports':
                for spec in c.named_children:
                    if text(spec).startswith('type '):
                        continue
                    original = text(spec.child_by_field_name('name'))
                    local = text(spec.child_by_field_name('alias')) or original
                    scope.bind(local, ('import', module, original, specifier))

    def module_path(self, path, specifier):
        stem = posixpath.normpath(posixpath.join(posixpath.dirname(path), specifier)) if specifier.startswith('.') else specifier
        # Exact files, conventional extension substitution, then index barrels.
        candidates = [stem, *[stem + e for e in ('.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs')],
                      *[stem + '/index' + e for e in ('.ts', '.tsx', '.js', '.jsx')]]
        if stem.endswith(('.js', '.mjs', '.cjs')):
            candidates[1:1] = [str(PurePosixPath(stem).with_suffix(e)) for e in ('.ts', '.tsx', '.mts', '.cts')]
        return next((p for p in candidates if p in self.trees), None)

    def index_exports(self, path, root):
        for node in root.named_children:
            if node.type != 'export_statement' or text(node).startswith('export type '):
                continue
            source = node.child_by_field_name('source')
            module = self.module_path(path, text(source)[1:-1]) if source else None
            clause = next((c for c in node.named_children if c.type == 'export_clause'), None)
            if clause:
                for spec in clause.named_children:
                    original = text(spec.child_by_field_name('name'))
                    alias = text(spec.child_by_field_name('alias')) or original
                    self.exports[path][alias] = ('import', module, original) if source else ('local', original)
                continue
            decl = node.child_by_field_name('declaration') or node.child_by_field_name('value')
            if not decl:
                continue  # export-star is deliberately unresolved (ambiguity).
            if 'default' in [text(c) for c in node.children if not c.is_named]:
                name = text(decl.child_by_field_name('name'))
                symbol = next((sid for sid, s in self.symbols.items() if s.node.id == decl.id), None)
                # A named default declaration has a live local binding; do not
                # bypass reassignment invalidation by jumping to its symbol.
                self.exports[path]['default'] = ('local', name) if name and decl.type in {'function_declaration', 'generator_function_declaration'} else ('symbol', symbol) if symbol else ('local', name or text(decl))
            elif decl.type in {'lexical_declaration', 'variable_declaration'}:
                for var in decl.named_children:
                    for name in self.binding_names(var.child_by_field_name('name')):
                        self.exports[path][name] = ('local', name)
            else:
                name = text(decl.child_by_field_name('name'))
                if name:
                    self.exports[path][name] = ('local', name)

    def lookup(self, scope, name):
        while scope:
            # Class method names are not lexical identifiers in JS.
            if scope.kind != 'class' and name in scope.bindings:
                return scope.bindings[name]
            scope = scope.parent
        return None

    def follow(self, value, seen=None):
        binding = self.binding_value(value, seen)
        return binding[1] if binding and binding[0] == 'symbol' and binding[1] in self.symbols else None

    def resolve(self, node, scope):
        return self.follow(self.expression_value(node, scope))

    def visit(self, node, scope, source, counts):
        scope = self.owners.get(node.id, scope)
        if node.type in FUNCTIONS:
            target = self.node_symbols.get(node.id)
            # A callback reference is not a claim that its body executes now.
            if target and node.parent and node.parent.type not in {'variable_declarator', 'statement_block', 'program', 'export_statement'}:
                self.edge(source, target, node, 'callback', self.symbols[target].qualname, counts)
            return
        relation = 'call'
        callee = None
        if node.type == 'call_expression':
            callee = node.child_by_field_name('function')
        elif node.type in {'jsx_opening_element', 'jsx_self_closing_element'}:
            callee = node.child_by_field_name('name')
            relation = 'render'
            if callee and text(callee)[:1].islower():
                callee = None  # Intrinsic HTML elements.
        if callee:
            target = self.resolve(callee, scope)
            if target:
                self.edge(source, target, node, relation, text(callee), counts)
            else:
                self.unresolved[source].append({'expression': text(node), 'line': node.start_point.row + 1,
                    'reason': f'Unresolved {relation}: dynamic, shadowed, external or unindexed target; no binding proven'})
        if node.type == 'identifier' and node.parent and (node.parent.type == 'arguments' or
                (node.parent.type == 'jsx_expression' and node.parent.parent and node.parent.parent.type == 'jsx_attribute')):
            target = self.resolve(node, scope)
            if target:
                self.edge(source, target, node, 'callback', text(node), counts)
        for c in node.named_children:
            self.visit(c, scope, source, counts)

    def edge(self, source, target, node, relation, callee, counts):
        group = (source, target, relation, callee)
        occurrence = counts.get(group, 0)
        counts[group] = occurrence + 1
        self.calls[(*group, occurrence)] = {'source': source, 'target': target, 'relation': relation,
            'expression': text(node), 'line': node.start_point.row + 1, 'path': self.symbols[source].path}

    def version(self, scope):
        node = scope.node
        # The source spans the complete expression/function, in UTF-8 byte
        # coordinates from Tree-sitter; Unicode never changes line evidence.
        body = node.child_by_field_name('body')
        code = text(node)
        prefix = self.sources[scope.path].encode()[node.start_byte:body.start_byte].decode() if body else code
        return {'startLine': node.start_point.row + 1, 'endLine': node.end_point.row + 1,
                'code': code, 'signature': prefix.strip()}


def parse(sources, side):
    trees, failed, warnings = {}, set(), []
    for path, source in sorted(sources.items()):
        if not is_javascript(path):
            continue
        suffix = PurePosixPath(path).suffix
        language = 'tsx' if suffix == '.tsx' else 'ts' if suffix in {'.ts', '.mts', '.cts'} else 'js'
        tree = Parser(LANGUAGES[language]).parse(source.encode())
        if tree.root_node.has_error:
            failed.add(path)
            warnings.append(f'{side} {path}: syntax parse failed (Tree-sitter); no partial graph used')
        else:
            trees[path] = tree
    return trees, failed, warnings


def analyze_javascript(base_sources, head_sources):
    before_trees, before_failed, warnings = parse(base_sources, 'base')
    after_trees, after_failed, after_warnings = parse(head_sources, 'head')
    warnings.extend(after_warnings)
    for path in sorted(before_failed | after_failed):
        before_trees.pop(path, None)
        after_trees.pop(path, None)
        warnings.append(f'Skipped {path} in both snapshots because parsing failed; symbols and edges are not compared')
    base, head = Snapshot(base_sources, before_trees), Snapshot(head_sources, after_trees)
    nodes, edges = [], []
    for sid in sorted(base.symbols.keys() | head.symbols.keys()):
        a, b = base.symbols.get(sid), head.symbols.get(sid)
        scope = b or a
        status = 'added' if not a else 'removed' if not b else 'unchanged' if fingerprint(a.node) == fingerprint(b.node) else 'modified'
        av, bv = base.version(a) if a else None, head.version(b) if b else None
        name = scope.qualname.split('.')[-1]
        kind = scope.kind
        if name.startswith('<callback:'):
            kind = 'callback'
        elif name[:1].isupper() and any(c.type.startswith('jsx_') for c in walk(scope.node)):
            kind = 'component'
        elif name.startswith('use') and len(name) > 3 and name[3].isupper():
            kind = 'hook'
        diff = '\n'.join(difflib.unified_diff((av['code'] if av else '').splitlines(), (bv['code'] if bv else '').splitlines(),
            fromfile=f'base/{scope.path}:{scope.qualname}', tofile=f'head/{scope.path}:{scope.qualname}', lineterm='')) if status != 'unchanged' else ''
        nodes.append({'id': sid, 'path': scope.path, 'module': str(PurePosixPath(scope.path).with_suffix('')),
            'qualname': scope.qualname, 'name': name, 'className': scope.parent.qualname if scope.kind == 'method' else None,
            'kind': kind, 'language': 'typescript' if PurePosixPath(scope.path).suffix in {'.ts', '.tsx', '.mts', '.cts'} else 'javascript',
            '_baseFingerprint': hashlib.sha256(repr(fingerprint(a.node)).encode()).hexdigest() if a else None,
            '_headFingerprint': hashlib.sha256(repr(fingerprint(b.node)).encode()).hexdigest() if b else None,
            'status': status, 'base': av, 'head': bv, 'diff': diff, 'unresolvedCalls': (head if b else base).unresolved[sid]})
    for key in sorted(base.calls.keys() | head.calls.keys()):
        a, b = base.calls.get(key), head.calls.get(key)
        call = b or a
        edges.append({**call, 'id': 'js:' + hashlib.sha256(repr(key).encode()).hexdigest()[:20],
            'baseExpression': a['expression'] if a else None, 'headExpression': b['expression'] if b else None,
            'baseLine': a['line'] if a else None, 'headLine': b['line'] if b else None,
            'inBase': bool(a), 'inHead': bool(b), 'status': 'unchanged' if a and b else 'added' if b else 'removed',
            'evidence': {'path': call['path'], 'line': call['line'], 'expression': call['expression'], 'side': 'head' if b else 'base'}})
    warnings.append('JS/TS: Tree-sitter syntax with lexical/import bindings and explicit object-literal facades. Imported React Query and Zustand APIs identify layer relationships; these are not runtime traces. Dynamic or explicitly mutated objects, props, custom aliases, export-star, CommonJS and external targets remain unresolved. Anonymous callback IDs are ordinal within their parent. Layer assignments based on directories are labeled as conventions.')
    return {'nodes': nodes, 'edges': edges, 'warnings': warnings, '_snapshots': (base, head)}


def walk(node):
    yield node
    for child in node.named_children:
        yield from walk(child)
