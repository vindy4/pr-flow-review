"""Conservative Python symbol/call comparison. Target modules are never imported."""

from __future__ import annotations

import ast
import difflib
import hashlib
from dataclasses import dataclass, field
from pathlib import PurePosixPath


Binding = tuple[str, str]
UNKNOWN: Binding = ("unknown", "")


@dataclass
class Scope:
    path: str
    module: str
    qualname: str
    kind: str
    node: ast.AST
    parent: Scope | None = None
    bindings: dict[str, Binding] = field(default_factory=dict)
    globals: set[str] = field(default_factory=set)
    nonlocals: set[str] = field(default_factory=set)

    def bind(self, name: str, value: Binding) -> None:
        previous = self.bindings.get(name)
        self.bindings[name] = value if previous is None or previous == value else UNKNOWN


def _module_name(path: str) -> str:
    parts = list(PurePosixPath(path).with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _positionless(node: ast.AST) -> str:
    return ast.dump(node, include_attributes=False)


def _parse_sources(sources: dict[str, str], side: str) -> tuple[dict[str, ast.Module], list[str], set[str]]:
    trees = {}
    warnings = []
    failed = set()
    for path, source in sorted(sources.items()):
        if not path.endswith(".py"):
            continue
        try:
            trees[path] = ast.parse(source, filename=path, type_comments=True)
        except (SyntaxError, ValueError, RecursionError) as error:
            line = getattr(error, "lineno", None)
            warnings.append(f"{side} {path}:{line or '?'}: syntax parse failed: {error}")
            failed.add(path)
    return trees, warnings, failed


class Snapshot:
    def __init__(self, sources: dict[str, str], side: str, trees: dict[str, ast.Module]):
        self.sources = sources
        self.side = side
        self.modules: dict[str, Scope] = {}
        self.symbols: dict[str, Scope] = {}
        self.classes: dict[str, Scope] = {}
        self.warnings: list[str] = []
        self.unresolved: dict[str, list[dict]] = {}
        self.calls: dict[tuple, dict] = {}
        self.attribute_writes: list[tuple[Scope, ast.Attribute]] = []
        self.receiver_writes: dict[str, set[str]] = {}
        self._mros: dict[str, list[str] | None] = {}
        for path, tree in sorted(trees.items()):
            module = _module_name(path)
            scope = Scope(path, module, "", "module", tree)
            if module in self.modules:
                self.warnings.append(f"{side}: duplicate module {module!r}; imports may be ambiguous")
            self.modules[module] = scope
            self._index(scope, tree.body)
        # Conventional source roots are not always part of Python's import
        # name (for example app/pension_management/... -> pension_management).
        # Preserve exact names and add only unambiguous stripped aliases.
        aliases: dict[str, list[Scope]] = {}
        for module, scope in list(self.modules.items()):
            root, separator, remainder = module.partition(".")
            if root in {"app", "src"} and separator:
                aliases.setdefault(remainder, []).append(scope)
        for module, candidates in aliases.items():
            if module in self.modules:
                continue
            if len(candidates) == 1:
                self.modules[module] = candidates[0]
            else:
                self.warnings.append(
                    f"{side}: ambiguous source-root alias {module!r}; short imports are unresolved")
        # Rebinding a global/closure cell can affect calls in other functions.
        # Keep those bindings unresolved rather than assuming execution order.
        for scope in self.symbols.values():
            for name in (scope.globals | scope.nonlocals) & scope.bindings.keys():
                outer = scope.parent
                while outer and (outer.kind == "class" or
                                 (outer.kind != "module" if name in scope.globals
                                  else name not in outer.bindings)):
                    outer = outer.parent
                if outer:
                    outer.bindings[name] = UNKNOWN
        # Instance/class attributes may replace the declared method. Include
        # writes in __init__ and other methods without assuming execution order.
        for scope, attribute in self.attribute_writes:
            kind, class_id = self.resolve(scope, attribute.value)
            if kind == "class":
                self.receiver_writes.setdefault(class_id, set()).add(attribute.attr)
        for symbol_id, scope in self.symbols.items():
            visitor = CallVisitor(self, scope)
            for statement in scope.node.body:
                visitor.visit(statement)
            self.unresolved[symbol_id] = visitor.unresolved
            seen: set[tuple] = set()
            counts: dict[tuple, int] = {}
            for target, call in visitor.calls:
                expression = self.expression(scope.path, call)
                callee = _positionless(call.func)
                duplicate = (target, callee, expression)
                if duplicate in seen:
                    continue
                seen.add(duplicate)
                group = (symbol_id, target, callee)
                occurrence = counts.get(group, 0)
                counts[group] = occurrence + 1
                self.calls[(*group, occurrence)] = {
                    "source": symbol_id, "target": target, "path": scope.path,
                    "expression": expression, "line": call.lineno,
                }

    def _index(self, scope: Scope, statements: list[ast.stmt]) -> None:
        collector = BindingCollector(self, scope)
        for statement in statements:
            collector.visit(statement)

    def define(self, parent: Scope, node: ast.AST, kind: str) -> None:
        qualname = f"{parent.qualname}.{node.name}" if parent.qualname else node.name
        symbol_id = f"{parent.path}:{qualname}"
        scope = Scope(parent.path, parent.module, qualname, kind, node, parent)
        table = self.classes if kind == "class" else self.symbols
        if symbol_id in table:
            self.warnings.append(
                f"{self.side} {parent.path}:{node.lineno}: duplicate definition {qualname}; "
                "only the final definition is shown")
        table[symbol_id] = scope
        parent.bind(node.name, ("class" if kind == "class" else "symbol", symbol_id))
        if kind == "function":
            args = node.args
            parameters = [*args.posonlyargs, *args.args, *args.kwonlyargs]
            parameters += [arg for arg in (args.vararg, args.kwarg) if arg]
            for parameter in parameters:
                scope.bind(parameter.arg, UNKNOWN)
            positional = [*args.posonlyargs, *args.args]
            decorators = {ast.unparse(value).split(".")[-1] for value in node.decorator_list}
            if parent.kind == "class" and positional and "staticmethod" not in decorators:
                receiver = positional[0].arg
                if receiver in {"self", "cls"}:
                    scope.bindings[receiver] = ("class", f"{parent.path}:{parent.qualname}")
        self._index(scope, node.body)

    def expression(self, path: str, node: ast.AST) -> str:
        return ast.get_source_segment(self.sources[path], node) or ast.unparse(node)

    def relative_module(self, scope: Scope, node: ast.ImportFrom) -> str | None:
        if not node.level:
            return node.module or ""
        package = scope.module.split(".")
        if PurePosixPath(scope.path).name != "__init__.py":
            package = package[:-1]
        if node.level > len(package):
            return None
        prefix = package[:len(package) - node.level + 1]
        return ".".join([*prefix, *([node.module] if node.module else [])])

    def lookup(self, scope: Scope, name: str, blocked: set[str] | None = None) -> Binding:
        if blocked and name in blocked:
            return UNKNOWN
        if name in (scope.globals | scope.nonlocals) and name in scope.bindings:
            return UNKNOWN
        current: Scope | None = scope
        skip_local = name in scope.nonlocals
        if name in scope.globals:
            while current and current.kind != "module":
                current = current.parent
        while current:
            if not skip_local and name in current.bindings:
                return self.resolve_binding(current.bindings[name], set())
            skip_local = False
            current = current.parent
            # Class namespaces do not participate in a method's lexical lookup.
            while current and current.kind == "class":
                current = current.parent
        return UNKNOWN

    def resolve_binding(self, binding: Binding, seen: set[str]) -> Binding:
        kind, target = binding
        if kind not in {"import", "moduleimport"}:
            return binding
        if target in seen:
            return UNKNOWN
        seen = seen | {target}
        if kind == "import":
            # ``from package import name`` prefers an existing package
            # attribute, even when a same-named submodule is also indexed.
            parts = target.split(".")
            for length in range(len(parts) - 1, 0, -1):
                module = self.modules.get(".".join(parts[:length]))
                if module and parts[length] in module.bindings:
                    value = self.resolve_binding(module.bindings[parts[length]], seen)
                    for attribute in parts[length + 1:]:
                        value = self.attribute(value, attribute, seen)
                    return value
        if target in self.modules or any(key.startswith(target + ".") for key in self.modules):
            return ("module", target)
        return UNKNOWN

    def attribute(self, binding: Binding, name: str, seen: set[str] | None = None) -> Binding:
        kind, target = binding
        if kind == "module":
            full = f"{target}.{name}" if target else name
            module = self.modules.get(target)
            if module and name in module.bindings:
                return self.resolve_binding(module.bindings[name], seen or set())
            if full in self.modules or any(key.startswith(full + ".") for key in self.modules):
                return ("module", full)
        elif kind in {"class", "super"}:
            cls = self.classes.get(target)
            if not cls:
                return UNKNOWN
            order = self.mro(target, set())
            if any(name in self.receiver_writes.get(class_id, set())
                   for class_id in (order or [target])):
                return UNKNOWN
            if kind == "class" and name in cls.bindings:
                return self.resolve_binding(cls.bindings[name], seen or set())
            if order:
                for base in order[1:]:
                    cls = self.classes[base]
                    if name in cls.bindings:
                        return self.resolve_binding(cls.bindings[name], seen or set())
        return UNKNOWN

    def resolve(self, scope: Scope, node: ast.AST, blocked: set[str] | None = None) -> Binding:
        if isinstance(node, ast.Name):
            return self.lookup(scope, node.id, blocked)
        if isinstance(node, ast.Attribute):
            return self.attribute(self.resolve(scope, node.value, blocked), node.attr)
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == "super" and not node.args and not node.keywords
                and scope.parent and scope.parent.kind == "class"
                and not (blocked and "super" in blocked)):
            current = scope
            while current:
                if "super" in current.bindings:
                    return UNKNOWN
                current = current.parent
            positional = [*scope.node.args.posonlyargs, *scope.node.args.args]
            if positional:
                class_id = f"{scope.parent.path}:{scope.parent.qualname}"
                if self.lookup(scope, positional[0].arg) == ("class", class_id):
                    return ("super", class_id)
        return UNKNOWN

    def mro(self, class_id: str, active: set[str]) -> list[str] | None:
        """C3 linearization; unknown bases make inherited resolution unresolved."""
        if class_id in self._mros:
            return self._mros[class_id]
        if class_id in active:
            return None
        cls = self.classes[class_id]
        bases: list[str] = []
        for expression in cls.node.bases:
            if isinstance(expression, ast.Name) and expression.id == "object":
                continue
            kind, target = self.resolve(cls.parent, expression)
            if kind != "class" or target not in self.classes:
                self._mros[class_id] = None
                return None
            bases.append(target)
        sequences = []
        for base in bases:
            order = self.mro(base, active | {class_id})
            if order is None:
                self._mros[class_id] = None
                return None
            sequences.append(list(order))
        sequences.append(list(bases))
        result = [class_id]
        while any(sequences):
            sequences = [sequence for sequence in sequences if sequence]
            candidate = next((sequence[0] for sequence in sequences
                              if not any(sequence[0] in other[1:] for other in sequences)), None)
            if candidate is None:
                self._mros[class_id] = None
                return None
            result.append(candidate)
            for sequence in sequences:
                if sequence[0] == candidate:
                    sequence.pop(0)
        self._mros[class_id] = result
        return result

    def version(self, scope: Scope) -> dict:
        node = scope.node
        start = min([node.lineno, *[item.lineno for item in node.decorator_list]])
        code = "\n".join(self.sources[scope.path].splitlines()[start - 1:node.end_lineno])
        prefix = "async " if isinstance(node, ast.AsyncFunctionDef) else ""
        returns = f" -> {ast.unparse(node.returns)}" if node.returns else ""
        return {"startLine": start, "endLine": node.end_lineno, "code": code,
                "signature": f"{prefix}def {node.name}({ast.unparse(node.args)}){returns}"}


class BindingCollector(ast.NodeVisitor):
    """Collect whole-scope bindings so later assignments shadow earlier calls."""

    def __init__(self, snapshot: Snapshot, scope: Scope):
        self.snapshot = snapshot
        self.scope = scope

    def visit_FunctionDef(self, node):
        self.snapshot.define(self.scope, node, "function")

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self.snapshot.define(self.scope, node, "class")

    def visit_Import(self, node):
        for alias in node.names:
            self.scope.bind(alias.asname or alias.name.split(".")[0],
                            ("moduleimport", alias.name if alias.asname else alias.name.split(".")[0]))

    def visit_ImportFrom(self, node):
        module = self.snapshot.relative_module(self.scope, node)
        for alias in node.names:
            if alias.name == "*":
                self.snapshot.warnings.append(
                    f"{self.snapshot.side} {self.scope.path}:{node.lineno}: wildcard import is unresolved")
                continue
            self.scope.bind(alias.asname or alias.name,
                            ("import", f"{module}.{alias.name}".lstrip(".")) if module is not None else UNKNOWN)

    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.scope.bind(node.id, UNKNOWN)

    def visit_Attribute(self, node):
        if (isinstance(node.ctx, (ast.Store, ast.Del))
                and isinstance(node.value, ast.Name) and node.value.id in {"self", "cls"}):
            self.snapshot.attribute_writes.append((self.scope, node))
        self.generic_visit(node)

    def visit_ExceptHandler(self, node):
        if node.name:
            self.scope.bind(node.name, UNKNOWN)
        self.generic_visit(node)

    def visit_Global(self, node):
        self.scope.globals.update(node.names)

    def visit_Nonlocal(self, node):
        self.scope.nonlocals.update(node.names)

    def visit_MatchAs(self, node):
        if node.name:
            self.scope.bind(node.name, UNKNOWN)
        self.generic_visit(node)

    visit_MatchStar = visit_MatchAs

    def visit_MatchMapping(self, node):
        if node.rest:
            self.scope.bind(node.rest, UNKNOWN)
        self.generic_visit(node)

    def visit_Lambda(self, node):
        return

    def visit_ListComp(self, node):
        # Generator targets are local to the comprehension, not its function.
        for child in ast.walk(node):
            if isinstance(child, ast.NamedExpr):
                self.visit(child.target)

    visit_SetComp = visit_ListComp
    visit_DictComp = visit_ListComp
    visit_GeneratorExp = visit_ListComp


class CallVisitor(ast.NodeVisitor):
    def __init__(self, snapshot: Snapshot, scope: Scope):
        self.snapshot = snapshot
        self.scope = scope
        self.calls: list[tuple[str, ast.Call]] = []
        self.unresolved: list[dict] = []
        self.blocked: set[str] = set()

    def visit_Call(self, node):
        if self.snapshot.resolve(self.scope, node, self.blocked)[0] == "super":
            self.generic_visit(node)
            return
        kind, target = self.snapshot.resolve(self.scope, node.func, self.blocked)
        if kind == "class":
            kind, target = self.snapshot.attribute((kind, target), "__init__")
        if kind == "symbol" and target in self.snapshot.symbols:
            self.calls.append((target, node))
        else:
            self.unresolved.append({"expression": self.snapshot.expression(self.scope.path, node),
                                    "line": node.lineno,
                                    "reason": "Dynamic, shadowed, external, or unindexed callable; no static target proven"})
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        return

    visit_AsyncFunctionDef = visit_FunctionDef
    visit_ClassDef = visit_FunctionDef
    visit_Lambda = visit_FunctionDef

    def visit_ListComp(self, node):
        previous = self.blocked.copy()
        for generator in node.generators:
            self.visit(generator.iter)
            self.blocked.update(item.id for item in ast.walk(generator.target) if isinstance(item, ast.Name))
            for condition in generator.ifs:
                self.visit(condition)
        if isinstance(node, ast.DictComp):
            self.visit(node.key)
            self.visit(node.value)
        else:
            self.visit(node.elt)
        self.blocked = previous

    visit_SetComp = visit_ListComp
    visit_DictComp = visit_ListComp
    visit_GeneratorExp = visit_ListComp


def _analyze_python_sources(base_sources: dict[str, str], head_sources: dict[str, str],
                    changed_paths: list[str]) -> dict:
    """Compare supplied snapshots, including unchanged callers in the scope.

    ``changed_paths`` describes the Git comparison; source ASTs determine status.
    A resolved edge is a static binding, not a guaranteed runtime invocation.
    """
    base_trees, base_warnings, base_failed = _parse_sources(base_sources, "base")
    head_trees, head_warnings, head_failed = _parse_sources(head_sources, "head")
    failed_paths = base_failed | head_failed
    parse_warnings = [*base_warnings, *head_warnings]
    for path in sorted(failed_paths):
        base_trees.pop(path, None)
        head_trees.pop(path, None)
        parse_warnings.append(
            f"Skipped {path} in both snapshots because parsing failed; symbols and edges are not compared")
    base = Snapshot(base_sources, "base", base_trees)
    head = Snapshot(head_sources, "head", head_trees)
    nodes = []
    for symbol_id in sorted(base.symbols.keys() | head.symbols.keys()):
        before, after = base.symbols.get(symbol_id), head.symbols.get(symbol_id)
        scope = after or before
        status = "added" if before is None else "removed" if after is None else (
            "unchanged" if _positionless(before.node) == _positionless(after.node) else "modified")
        before_version = base.version(before) if before else None
        after_version = head.version(after) if after else None
        diff = ""
        if status != "unchanged":
            diff = "\n".join(difflib.unified_diff(
                (before_version["code"] if before_version else "").splitlines(),
                (after_version["code"] if after_version else "").splitlines(),
                fromfile=f"base/{scope.path}:{scope.qualname}",
                tofile=f"head/{scope.path}:{scope.qualname}", lineterm=""))
        parent = scope.parent
        is_method = parent is not None and parent.kind == "class"
        nodes.append({"id": symbol_id, "path": scope.path, "module": scope.module,
                      "qualname": scope.qualname, "name": scope.node.name,
                      "className": parent.qualname if is_method else None,
                      "kind": "method" if is_method else "function", "status": status,
                      "_baseFingerprint": hashlib.sha256(_positionless(before.node).encode()).hexdigest() if before else None,
                      "_headFingerprint": hashlib.sha256(_positionless(after.node).encode()).hexdigest() if after else None,
                      "base": before_version, "head": after_version, "diff": diff,
                      "unresolvedCalls": (head if after else base).unresolved.get(symbol_id, [])})
    edges = []
    for key in sorted(base.calls.keys() | head.calls.keys()):
        before, after = base.calls.get(key), head.calls.get(key)
        call = after or before
        digest = hashlib.sha256(repr(key).encode()).hexdigest()[:20]
        edges.append({"id": f"call:{digest}", "source": call["source"], "target": call["target"],
                      "expression": call["expression"], "line": call["line"],
                      "baseExpression": before["expression"] if before else None,
                      "headExpression": after["expression"] if after else None,
                      "baseLine": before["line"] if before else None,
                      "headLine": after["line"] if after else None,
                      "inBase": before is not None, "inHead": after is not None,
                      "status": "unchanged" if before and after else "added" if after else "removed",
                      "evidence": {"path": call["path"], "line": call["line"],
                                   "side": "head" if after else "base", "expression": call["expression"]}})
    limits = ("Static source relationships only: module initialization, decorators/default expressions, "
              "lambda bodies, runtime dispatch, and external or unindexed targets are not resolved. "
              "app/ and src/ are accepted as import roots when the short module name is unique.")
    return {"nodes": nodes, "edges": edges,
            "warnings": [limits, *parse_warnings, *base.warnings, *head.warnings]}


def analyze_sources(base_sources: dict[str, str], head_sources: dict[str, str],
                    changed_paths: list[str], renames: dict[str, str] | None = None) -> dict:
    from backend.javascript import analyze_javascript, is_javascript
    from backend.comparison import reconcile_moves
    from backend.architecture import build_architecture

    result = {"nodes": [], "edges": [], "warnings": []}
    snapshots = None
    if any(p.endswith('.py') for p in base_sources.keys() | head_sources.keys()):
        result = _analyze_python_sources(base_sources, head_sources, changed_paths)
        for node in result['nodes']:
            node['language'] = 'python'
    if any(is_javascript(p) for p in base_sources.keys() | head_sources.keys()):
        js = analyze_javascript(base_sources, head_sources)
        snapshots = js.pop('_snapshots')
        for field in ('nodes', 'edges', 'warnings'):
            result[field].extend(js[field])
    result = reconcile_moves(result, renames)
    result['architecture'] = build_architecture(base_sources, head_sources, result, changed_paths, renames, snapshots)
    return result
