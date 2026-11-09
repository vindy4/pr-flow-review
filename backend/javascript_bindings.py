"""Explicit syntax bindings for object facades and known framework factories.

This models source references, never executes JavaScript or infers receivers
from TypeScript types. Unknown/mutated/spread objects remain unknown.
"""


def label(node):
    return node.text.decode('utf-8') if node else ''


def descendants(node):
    yield node
    for child in node.named_children:
        yield from descendants(child)


class SyntaxBindings:
    def object_fields(self, node):
        """Return definite literal fields, rejecting unknown/overriding shapes."""
        fields = {}
        if not node or node.type != 'object' or node.id in self.invalid_objects:
            return None
        for prop in node.named_children:
            if prop.type == 'comment':
                continue
            key = prop.child_by_field_name('key') or prop.child_by_field_name('name') or (prop if prop.type == 'shorthand_property_identifier' else None)
            if prop.type not in {'pair', 'method_definition', 'shorthand_property_identifier'} or not key:
                return None
            if prop.type == 'method_definition' and any(c.type in {'get', 'set'} for c in prop.children):
                return None
            if key.type in {'property_identifier', 'identifier', 'shorthand_property_identifier'}:
                name = label(key)
            elif key.type == 'string' and '\\' not in label(key):
                name = label(key)[1:-1]
            else:
                return None
            if name in fields:
                return None
            fields[name] = prop.child_by_field_name('value') or prop
        return fields

    def binding_value(self, binding, seen=None):
        if not binding:
            return None
        seen = set() if seen is None else seen
        if binding in seen:
            return None
        seen = seen | {binding}
        kind = binding[0]
        if kind == 'import' and binding[1]:
            exported = self.exports[binding[1]].get(binding[2])
            if exported and exported[0] == 'local':
                exported = self.lookup(self.modules[binding[1]], exported[1])
            return self.binding_value(exported, seen)
        if kind == 'expression':
            node, scope = self.syntax_nodes[binding[1]]
            return self.expression_value(node, scope, seen)
        if kind == 'property':
            node, scope = self.syntax_nodes[binding[1]]
            return self.property_value(self.expression_value(node, scope, seen), binding[2], seen)
        if kind == 'local_setter':
            node, scope = self.syntax_nodes[binding[1]]
            if node.type == 'call_expression' and self.external_api(node.child_by_field_name('function'), scope) == ('react', 'useState'):
                return binding
            return None
        if kind == 'object' and binding[1] in self.invalid_objects:
            return None
        return binding

    def property_value(self, value, name, seen=None):
        if not value:
            return None
        if value[0] == 'namespace':
            return self.binding_value(('import', value[1], name), seen) if value[1] else None
        if value[0] == 'object' and value[1] not in self.invalid_objects:
            node, scope = self.syntax_nodes[value[1]]
            target = (self.object_fields(node) or {}).get(name)
            if target:
                return self.expression_value(target, self.owners.get(target.id, scope), seen)
        if value[0] == 'store':
            if name in {'getState', 'setState', 'subscribe'}:
                return ('store_method', value[1], name)
        if value[0] == 'state':
            symbol_id = self.stores[value[1]]['actions'].get(name)
            return ('symbol', symbol_id) if symbol_id else None
        return None

    def expression_value(self, node, scope, seen=None):
        if not node:
            return None
        seen = set() if seen is None else seen
        marker = ('syntax', node.id)
        if marker in seen:
            return None
        seen = seen | {marker}
        if node.id in self.node_symbols:
            return ('symbol', self.node_symbols[node.id])
        if node.type in {'identifier', 'type_identifier', 'shorthand_property_identifier'}:
            return self.binding_value(self.lookup(scope, label(node)), seen)
        if node.type in {'parenthesized_expression', 'as_expression', 'non_null_expression', 'satisfies_expression'}:
            return self.expression_value(node.named_children[0], scope, seen)
        if node.type == 'object':
            return ('object', node.id) if self.object_fields(node) is not None else None
        if node.type in {'member_expression', 'nested_identifier'}:
            receiver = node.child_by_field_name('object')
            member = node.child_by_field_name('property')
            return self.property_value(self.expression_value(receiver, scope, seen), label(member), seen)
        if node.type == 'call_expression':
            callee = node.child_by_field_name('function')
            api = self.external_api(callee, scope)
            # Zustand supports create<State>()(initializer) as well as create(initializer).
            if callee and callee.type == 'call_expression':
                inner_args = callee.child_by_field_name('arguments')
                if inner_args and not inner_args.named_children:
                    api = self.external_api(callee.child_by_field_name('function'), scope)
            if api and api[0] in {'zustand', 'zustand/vanilla'} and api[1] in {'create', 'createStore', 'default'}:
                self.register_store(node, scope)
                return ('store', node.id)
            value = self.expression_value(callee, scope, seen)
            args = node.child_by_field_name('arguments')
            if value and value[0] == 'store':
                if args and args.named_children:
                    selector = args.named_children[0]
                    body = selector.child_by_field_name('body')
                    params = selector.child_by_field_name('parameters') or selector.child_by_field_name('parameter')
                    names = self.binding_names(params)
                    if body and body.type == 'member_expression' and len(names) == 1 and label(body.child_by_field_name('object')) == names[0]:
                        return self.property_value(('state', value[1]), label(body.child_by_field_name('property')), seen)
                    return None
                return ('state', value[1])
            if value and value[0] == 'store_method' and value[2] == 'getState':
                return ('state', value[1])
        return None

    def external_api(self, node, scope):
        if not node:
            return None
        # Do not follow arbitrary calls while recognizing a library API.
        if node.type not in {'identifier', 'member_expression', 'parenthesized_expression'}:
            return None
        if node.type == 'identifier':
            value = self.lookup(scope, label(node))
            if value and value[0] == 'import' and len(value) > 3:
                return value[3], value[2]
        if node.type == 'member_expression':
            root = node.child_by_field_name('object')
            if root and root.type == 'identifier':
                value = self.lookup(scope, label(root))
                if value and value[0] == 'import' and len(value) > 3 and value[2] == 'default':
                    return value[3], label(node.child_by_field_name('property'))
                if value and value[0] == 'namespace' and len(value) > 2:
                    return value[2], label(node.child_by_field_name('property'))
        return None

    def register_store(self, node, scope):
        if node.id in self.stores:
            return
        record = {'path': scope.path, 'line': node.start_point.row + 1, 'actions': {}, 'node': node}
        self.stores[node.id] = record
        args = node.child_by_field_name('arguments')
        if not args:
            return
        initializer = next((n for arg in args.named_children for n in descendants(arg) if n.id in self.node_symbols), None)
        if not initializer:
            return
        body = initializer.child_by_field_name('body')
        if body and body.type == 'statement_block':
            returns = [c for c in body.named_children if c.type == 'return_statement']
            body = returns[0].named_children[0] if len(returns) == 1 and returns[0].named_children else None
        while body and body.type == 'parenthesized_expression':
            body = body.named_children[0]
        if body and body.type == 'object':
            for name, value in (self.object_fields(body) or {}).items():
                if name and value.id in self.node_symbols:
                    record['actions'][name] = self.node_symbols[value.id]

    def invalidate_member_writes(self):
        # Resolve receivers after all imports/exports have been indexed, so a
        # write through an imported alias invalidates the defining object too.
        invalid = set()
        for node, scope in self.member_writes:
            receiver = node.child_by_field_name('object')
            while receiver:
                value = self.expression_value(receiver, scope)
                if value and value[0] == 'object':
                    invalid.add(value[1])
                receiver = receiver.child_by_field_name('object') if receiver.type in {'member_expression', 'subscript_expression'} else None
        self.invalid_objects.update(invalid)
