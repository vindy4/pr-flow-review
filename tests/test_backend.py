import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from backend.github import GitSnapshot, parse_pr_url, select_scopes, validate_scope


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


class InputTests(unittest.TestCase):
    def test_private_pr_url_parses_without_allowing_other_hosts_or_shell_flags(self):
        self.assertEqual(parse_pr_url("https://github.com/Rippling/rippling-main/pull/605463/files"), ("Rippling", "rippling-main", 605463))
        for value in ("https://evil.test/a/b/pull/1", "https://github.com.evil.test/a/b/pull/1", "file:///tmp/repo", "--help", "https://github.com/a/b/pull/0"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_pr_url(value)

    def test_scope_must_be_repository_relative(self):
        self.assertEqual(validate_scope("app/pension_management"), "app/pension_management")
        self.assertEqual(validate_scope("."), ".")
        for value in ("../outside", "/tmp", "app/../../outside", "--all", "app:HEAD"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_scope(value)

    def test_default_scope_includes_unchanged_siblings_of_changed_packages(self):
        self.assertEqual(select_scopes(["app/pension_management/ai_onboarding/draft/service.py", "app/pension_management/ai_onboarding/steps.py"]), ["app/pension_management/ai_onboarding"])

    def test_webapp_default_scope_is_product_not_entire_hr_domain(self):
        self.assertEqual(select_scopes(['app/products/hr/Retirements/features/plan-setup/Page.tsx', 'translations/en.json']), ['app/products/hr/Retirements'])


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        git(self.root, "init", "-q")
        git(self.root, "config", "user.name", "Fixture")
        git(self.root, "config", "user.email", "fixture@example.test")
        folder = self.root / "app" / "feature"
        folder.mkdir(parents=True)
        (folder / "service.py").write_text("def helper():\n    return 1\n")
        (folder / "caller.py").write_text("from feature.service import helper\ndef call():\n    return helper()\n")
        (folder / "test_service.py").write_text("def test_helper():\n    pass\n")
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "base")
        self.base = git(self.root, "rev-parse", "HEAD")
        (folder / "service.py").write_text("def helper():\n    return 2\n")
        git(self.root, "commit", "-qam", "head")
        self.head = git(self.root, "rev-parse", "HEAD")
        # An uncommitted working tree change must never leak into the analysis.
        (folder / "service.py").write_text("THIS IS NOT COMMITTED\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_pinned_git_objects_and_includes_unchanged_callers(self):
        snapshot = GitSnapshot(self.root)
        sources, limited = snapshot.read_sources(self.head, ["app/feature"], include_tests=False)
        self.assertEqual(sources["app/feature/service.py"], "def helper():\n    return 2\n")
        self.assertIn("app/feature/caller.py", sources)
        self.assertNotIn("app/feature/test_service.py", sources)
        self.assertFalse(limited)
        self.assertEqual(snapshot.resolve_ref("HEAD"), self.head)
        self.assertEqual(snapshot.changed_files(self.base, self.head), [{"path": "app/feature/service.py", "status": "modified"}])

    def test_web_sources_and_tests_are_selected_from_git_without_declarations_or_dependencies(self):
        paths = ['web/Page.tsx', 'web/util.js', 'web/types.d.ts', 'web/__tests__/Page.test.tsx', 'web/util.spec.ts', 'web/node_modules/a.ts']
        for path in paths:
            file = self.root / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('export function go() { return 1; }')
        git(self.root, 'add', 'web')
        git(self.root, 'commit', '-qm', 'web sources')
        sha = git(self.root, 'rev-parse', 'HEAD')
        snapshot = GitSnapshot(self.root)
        sources, _ = snapshot.read_sources(sha, ['web'])
        self.assertEqual(set(sources), {'web/Page.tsx', 'web/util.js'})
        sources, _ = snapshot.read_sources(sha, ['web'], include_tests=True)
        self.assertEqual(set(sources), set(paths[:2] + paths[3:5]))

    def test_missing_refs_and_options_are_clear_errors(self):
        snapshot = GitSnapshot(self.root)
        for value in ("--help", "missing-branch", ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                snapshot.resolve_ref(value)

    def test_git_rename_is_one_change_with_old_and_new_paths(self):
        path = self.root / 'app/feature/caller.py'
        path.rename(path.with_name('entry.py'))
        git(self.root, 'add', 'app/feature')
        git(self.root, 'commit', '-qm', 'move caller')
        changed = GitSnapshot(self.root).changed_files(self.head, git(self.root, 'rev-parse', 'HEAD'))
        moved = [f for f in changed if f['path'] == 'app/feature/entry.py']
        self.assertEqual(len(moved), 1)
        self.assertEqual(moved[0]['status'], 'moved')
        self.assertEqual(moved[0]['previousPath'], 'app/feature/caller.py')
        self.assertFalse(any(f['path'] == 'app/feature/caller.py' for f in changed))

    def test_test_inclusion_and_limit_are_explicit(self):
        snapshot = GitSnapshot(self.root)
        sources, limited = snapshot.read_sources(self.head, ["app/feature"], include_tests=True, max_files=1)
        self.assertEqual(len(sources), 1)
        self.assertTrue(limited)

    def test_replace_refs_cannot_change_the_contents_of_a_pinned_snapshot(self):
        git(self.root, "replace", self.base, self.head)
        sources, _ = GitSnapshot(self.root).read_sources(self.base, ["app/feature"])
        self.assertEqual(sources["app/feature/service.py"], "def helper():\n    return 1\n")

    def test_local_analysis_connects_a_changed_method_to_an_unchanged_caller(self):
        from backend.github import analyze_request
        result = analyze_request({"repoPath": str(self.root), "baseRef": self.base, "headRef": self.head, "scope": "app/feature"}, lambda stage: None)
        symbols = {n["id"]: n for n in result["nodes"]}
        self.assertEqual(symbols["app/feature/service.py:helper"]["status"], "modified")
        self.assertEqual(symbols["app/feature/caller.py:call"]["status"], "unchanged")
        self.assertTrue(any(edge["source"] == "app/feature/caller.py:call" and edge["target"] == "app/feature/service.py:helper" for edge in result["edges"]))
        self.assertEqual(result["meta"]["mode"], "local")
        self.assertEqual(result["meta"]["headSha"], self.head)
        self.assertIsNone(result["meta"]["prUrl"])

    def test_pair_coverage_cannot_invent_removals_when_a_new_file_pushes_out_an_old_one(self):
        from backend.analyzer import analyze_sources
        folder = self.root / "cap"
        folder.mkdir()
        (folder / "b.py").write_text("def unchanged():\n    return 1\n")
        git(self.root, "add", "cap")
        git(self.root, "commit", "-qm", "cap base")
        base = git(self.root, "rev-parse", "HEAD")
        (folder / "a.py").write_text("def added():\n    return 2\n")
        git(self.root, "add", "cap")
        git(self.root, "commit", "-qm", "cap head")
        head = git(self.root, "rev-parse", "HEAD")
        before, after, limited = GitSnapshot(self.root).read_pair(base, head, ["cap"], max_files=1)
        result = analyze_sources(before, after, ["cap/a.py"])
        self.assertFalse(any(n["status"] == "removed" for n in result["nodes"]))
        self.assertTrue(limited)

    def test_oversized_blobs_are_filtered_before_source_contents_are_requested(self):
        (self.root / "large.py").write_text("#" + "x" * (1024 * 1024 + 1))
        git(self.root, "add", "large.py")
        git(self.root, "commit", "-qm", "large source")
        head = git(self.root, "rev-parse", "HEAD")
        requested = []
        class RecordingSnapshot(GitSnapshot):
            def git(self, *args, data=None):
                if args[:2] == ("cat-file", "--batch"):
                    requested.append(data.decode())
                return super().git(*args, data=data)
        sources, limited = RecordingSnapshot(self.root).read_sources(head, ["."])
        self.assertNotIn("large.py", sources)
        self.assertTrue(limited)
        self.assertFalse(any(":large.py\n" in request for request in requested))


if __name__ == "__main__":
    unittest.main()
