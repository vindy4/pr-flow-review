import textwrap
import unittest

from backend.analyzer import analyze_sources


def source(text):
    return textwrap.dedent(text).lstrip("\n")


def nodes_by_name(result):
    return {node["id"]: node for node in result["nodes"]}


def pairs(result):
    return {(edge["source"], edge["target"]) for edge in result["edges"]}


class AnalyzerTests(unittest.TestCase):
    def test_inventory_keeps_deleted_added_and_unchanged_methods(self):
        base = {"pkg/service.py": source('''
            class Service:
                def keep(self):
                    return 1
                def change(self):
                    return 1
                def remove(self):
                    return self.keep()
        ''')}
        head = {"pkg/service.py": source('''
            # A comment moves all line numbers.
            class Service:
                def keep(self):
                    return 1
                def change(self):
                    return 2
                async def add(self):
                    return self.keep()
        ''')}
        result = analyze_sources(base, head, ["pkg/service.py"])
        nodes = nodes_by_name(result)
        self.assertEqual({key: value["status"] for key, value in nodes.items()}, {
            "pkg/service.py:Service.keep": "unchanged",
            "pkg/service.py:Service.change": "modified",
            "pkg/service.py:Service.remove": "removed",
            "pkg/service.py:Service.add": "added",
        })
        self.assertIsNone(nodes["pkg/service.py:Service.remove"]["head"])
        self.assertIn("-        return 1", nodes["pkg/service.py:Service.change"]["diff"])
        self.assertEqual(nodes["pkg/service.py:Service.add"]["kind"], "method")
        self.assertEqual({edge["status"] for edge in result["edges"]}, {"added", "removed"})

    def test_decorated_ranges_are_exact_and_position_changes_do_not_modify(self):
        code = source('''
            @decorate("x")
            async def task(
                value: int,
            ) -> str:
                return str(value)
        ''')
        result = analyze_sources({"a.py": code}, {"a.py": "\n\n" + code}, ["a.py"])
        node = result["nodes"][0]
        self.assertEqual(node["status"], "unchanged")
        self.assertEqual(node["base"]["startLine"], 1)
        self.assertEqual(node["head"]["startLine"], 3)
        self.assertEqual(node["base"]["endLine"], 5)
        self.assertEqual(node["base"]["code"], code.rstrip("\n"))
        self.assertIn("async def task", node["head"]["signature"])
        self.assertEqual(node["diff"], "")

    def test_import_aliases_and_relative_imports_resolve(self):
        sources = {
            "pkg/__init__.py": "",
            "pkg/helpers.py": "def work():\n    return 1\n",
            "pkg/sub/__init__.py": "",
            "pkg/sub/use.py": source('''
                import pkg.helpers as helpers
                import pkg.helpers
                from ..helpers import work as run
                from .. import helpers as relative
                def entry():
                    helpers.work()
                    pkg.helpers.work()
                    run()
                    relative.work()
            '''),
        }
        result = analyze_sources(sources, sources, [])
        self.assertEqual(len(result["edges"]), 4)
        self.assertEqual(pairs(result), {("pkg/sub/use.py:entry", "pkg/helpers.py:work")})

    def test_self_cls_and_statically_known_inherited_methods(self):
        sources = {"a.py": source('''
            class Base:
                def work(self):
                    return 1
                @classmethod
                def build(cls):
                    return cls.work()
            class Child(Base):
                def entry(self):
                    return self.work()
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(pairs(result), {
            ("a.py:Base.build", "a.py:Base.work"),
            ("a.py:Child.entry", "a.py:Base.work"),
        })

    def test_nested_lexical_functions_resolve_and_class_scope_is_not_lexical(self):
        sources = {"a.py": source('''
            def helper():
                return 1
            class Service:
                def helper(self):
                    return 2
                def entry(self):
                    def local():
                        return helper()
                    return local()
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(pairs(result), {
            ("a.py:Service.entry", "a.py:Service.entry.local"),
            ("a.py:Service.entry.local", "a.py:helper"),
        })

    def test_parameters_assignments_and_unknown_receivers_do_not_guess_edges(self):
        sources = {"a.py": source('''
            def helper():
                return 1
            class Other:
                def work(self):
                    pass
            def entry(helper, obj):
                helper()
                obj.work()
            def shadow():
                helper()
                helper = unknown
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(result["edges"], [])
        nodes = nodes_by_name(result)
        self.assertEqual({call["expression"] for call in nodes["a.py:entry"]["unresolvedCalls"]},
                         {"helper()", "obj.work()"})
        self.assertEqual(len(nodes["a.py:shadow"]["unresolvedCalls"]), 1)
        self.assertTrue(all(call["reason"] for call in nodes["a.py:entry"]["unresolvedCalls"]))

    def test_imports_can_be_shadowed_and_function_imports_are_local(self):
        sources = {
            "pkg/helpers.py": "def work():\n    pass\n",
            "a.py": source('''
                from pkg.helpers import work
                def local():
                    from pkg.helpers import work as task
                    task()
                def shadow(work):
                    work()
                def unknown():
                    task()
            '''),
        }
        result = analyze_sources(sources, sources, [])
        self.assertEqual(pairs(result), {("a.py:local", "pkg/helpers.py:work")})

    def test_call_edges_survive_line_shifts_and_argument_changes(self):
        base = {"a.py": "def target(value):\n    pass\ndef entry():\n    target(1)\n"}
        head = {"a.py": "# moved\n\ndef target(value):\n    pass\ndef entry():\n    target(2)\n"}
        result = analyze_sources(base, head, ["a.py"])
        self.assertEqual(len(result["edges"]), 1)
        edge = result["edges"][0]
        self.assertEqual(edge["status"], "unchanged")
        self.assertEqual((edge["baseLine"], edge["headLine"]), (4, 6))
        self.assertEqual(edge["expression"], "target(2)")
        self.assertEqual(edge["baseExpression"], "target(1)")
        self.assertEqual(edge["headExpression"], "target(2)")
        self.assertEqual(edge["evidence"], {
            "path": "a.py", "line": 6, "side": "head", "expression": "target(2)"})
        self.assertEqual(edge["id"], analyze_sources(head, head, [])["edges"][0]["id"])

    def test_distinct_call_sites_keep_precise_evidence(self):
        sources = {"a.py": "def target(x):\n    pass\ndef entry():\n    target(1)\n    target(2)\n"}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(len(result["edges"]), 2)
        self.assertEqual({edge["headLine"] for edge in result["edges"]}, {4, 5})
        self.assertEqual({edge["expression"] for edge in result["edges"]}, {"target(1)", "target(2)"})

    def test_parse_failure_is_visible_and_other_files_still_analyze(self):
        result = analyze_sources({"bad.py": "def broken(:\n"}, {
            "bad.py": "def broken(:\n", "good.py": "def okay():\n    return 1\n"}, ["bad.py", "good.py"])
        self.assertEqual([node["id"] for node in result["nodes"]], ["good.py:okay"])
        self.assertTrue(any("bad.py" in warning and "syntax" in warning.lower()
                            for warning in result["warnings"]))

    def test_target_source_is_never_executed(self):
        sources = {"a.py": "raise RuntimeError('do not execute')\ndef okay():\n    return 1\n"}
        self.assertEqual(analyze_sources(sources, sources, [])["nodes"][0]["name"], "okay")

    def test_comprehension_target_does_not_resolve_to_outer_function(self):
        sources = {"a.py": source('''
            def work():
                pass
            def entry(items):
                values = [work() for work in items]
                work()
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(len(result["edges"]), 1)
        self.assertEqual(result["edges"][0]["headLine"], 5)
        self.assertEqual(nodes_by_name(result)["a.py:entry"]["unresolvedCalls"][0]["line"], 4)

    def test_staticmethod_parameter_named_self_remains_unknown(self):
        sources = {"a.py": source('''
            class Service:
                def work(self):
                    pass
                @staticmethod
                def entry(self):
                    return self.work()
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(result["edges"], [])
        self.assertEqual(len(nodes_by_name(result)["a.py:Service.entry"]["unresolvedCalls"]), 1)

    def test_c3_inheritance_chooses_override_in_diamond(self):
        sources = {"a.py": source('''
            class Root:
                def work(self):
                    pass
            class Left(Root):
                pass
            class Right(Root):
                def work(self):
                    pass
            class Child(Left, Right):
                def entry(self):
                    self.work()
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(pairs(result), {("a.py:Child.entry", "a.py:Right.work")})

    def test_unknown_base_does_not_guess_inherited_target(self):
        sources = {"a.py": source('''
            from external import Unknown
            class Known:
                def work(self):
                    pass
            class Child(Unknown, Known):
                def entry(self):
                    return self.work()
        ''')}
        self.assertEqual(analyze_sources(sources, sources, [])["edges"], [])

    def test_pattern_capture_shadows_outer_callable(self):
        sources = {"a.py": source('''
            def helper():
                pass
            def entry(value):
                match value:
                    case {"helper": helper}:
                        helper()
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(result["edges"], [])
        self.assertEqual(len(nodes_by_name(result)["a.py:entry"]["unresolvedCalls"]), 1)

    def test_rebound_nonlocal_callable_remains_unresolved(self):
        sources = {"a.py": source('''
            def outer():
                def helper():
                    pass
                def inner(value):
                    nonlocal helper
                    helper = value
                    helper()
                return inner
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(result["edges"], [])

    def test_zero_argument_super_resolves_next_c3_method(self):
        sources = {"a.py": source('''
            class Base:
                def work(self):
                    pass
            class Child(Base):
                def work(self):
                    return super().work()
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(pairs(result), {("a.py:Child.work", "a.py:Base.work")})

    def test_app_and_src_import_roots_keep_full_and_unique_short_names(self):
        sources = {
            "app/feature/service.py": "def work():\n    pass\n",
            "src/utility.py": "def tool():\n    pass\n",
            "entry.py": source('''
                import feature.service as short
                import app.feature.service as full
                from utility import tool
                def entry():
                    short.work()
                    full.work()
                    tool()
            '''),
        }
        result = analyze_sources(sources, sources, [])
        self.assertEqual(len(result["edges"]), 3)
        self.assertEqual(pairs(result), {
            ("entry.py:entry", "app/feature/service.py:work"),
            ("entry.py:entry", "src/utility.py:tool"),
        })

    def test_ambiguous_source_root_alias_does_not_guess(self):
        sources = {
            "app/feature.py": "def work():\n    pass\n",
            "src/feature.py": "def work():\n    pass\n",
            "entry.py": "from feature import work\ndef entry():\n    work()\n",
        }
        result = analyze_sources(sources, sources, [])
        self.assertEqual(result["edges"], [])
        self.assertTrue(any("ambiguous" in warning for warning in result["warnings"]))

    def test_real_top_level_module_wins_over_source_root_alias(self):
        sources = {
            "app/feature.py": "def work():\n    pass\n",
            "feature.py": "def work():\n    pass\n",
            "entry.py": "from feature import work\ndef entry():\n    work()\n",
        }
        result = analyze_sources(sources, sources, [])
        self.assertEqual(pairs(result), {("entry.py:entry", "feature.py:work")})

    def test_from_import_uses_package_attribute_before_same_named_submodule(self):
        sources = {
            "pkg/__init__.py": "def work():\n    pass\n",
            "pkg/work.py": "def work():\n    pass\n",
            "entry.py": "from pkg import work\ndef entry():\n    work()\n",
        }
        result = analyze_sources(sources, sources, [])
        self.assertEqual(pairs(result), {("entry.py:entry", "pkg/__init__.py:work")})

    def test_imported_base_and_reexported_function_are_resolved(self):
        sources = {
            "pkg/base.py": "class Base:\n    def work(self):\n        pass\n",
            "pkg/__init__.py": "from .base import Base\n",
            "entry.py": source('''
                from pkg import Base as Parent
                class Child(Parent):
                    def entry(self):
                        self.work()
            '''),
        }
        result = analyze_sources(sources, sources, [])
        self.assertEqual(pairs(result), {("entry.py:Child.entry", "pkg/base.py:Base.work")})

    def test_reassigned_receiver_method_stays_unresolved(self):
        for statement in ("self.work = replacement", "del self.work", "self.work += replacement"):
            with self.subTest(statement=statement):
                sources = {"a.py": source(f'''
                    class Service:
                        def work(self):
                            pass
                        def entry(self, replacement):
                            {statement}
                            return self.work()
                ''')}
                result = analyze_sources(sources, sources, [])
                self.assertEqual(result["edges"], [])
                unresolved = nodes_by_name(result)["a.py:Service.entry"]["unresolvedCalls"]
                self.assertEqual([call["expression"] for call in unresolved], ["self.work()"])

    def test_init_receiver_write_blocks_later_method_dispatch_but_not_other_members(self):
        sources = {"a.py": source('''
            class Service:
                def __init__(self, replacement):
                    self.work = replacement
                def work(self):
                    pass
                def keep(self):
                    pass
                def entry(self):
                    self.work()
                    self.keep()
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(pairs(result), {("a.py:Service.entry", "a.py:Service.keep")})
        self.assertEqual(nodes_by_name(result)["a.py:Service.entry"]["unresolvedCalls"][0]["expression"],
                         "self.work()")

    def test_cls_write_blocks_class_and_inherited_receiver_dispatch(self):
        sources = {"a.py": source('''
            class Base:
                @classmethod
                def replace(cls, replacement):
                    cls.work = replacement
                def work(self):
                    pass
            class Child(Base):
                def entry(self):
                    return self.work()
        ''')}
        result = analyze_sources(sources, sources, [])
        self.assertEqual(result["edges"], [])
        self.assertEqual(nodes_by_name(result)["a.py:Child.entry"]["unresolvedCalls"][0]["expression"],
                         "self.work()")

    def test_one_sided_parse_failure_skips_symbols_and_edges_on_both_sides(self):
        valid = "def target():\n    pass\ndef entry():\n    return target()\n"
        caller = "from broken import target\ndef external():\n    return target()\n"
        for base_code, head_code in ((valid, "def entry(:\n"), ("def entry(:\n", valid)):
            with self.subTest(base=base_code):
                result = analyze_sources(
                    {"broken.py": base_code, "caller.py": caller},
                    {"broken.py": head_code, "caller.py": caller}, ["broken.py"])
                self.assertEqual([node["id"] for node in result["nodes"]], ["caller.py:external"])
                self.assertEqual(result["edges"], [])
                self.assertEqual(result["nodes"][0]["status"], "unchanged")
                self.assertTrue(any("broken.py" in warning and "both snapshots" in warning
                                    for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
