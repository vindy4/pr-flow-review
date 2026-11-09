"""Full-file reads are scoped to an analysis and pinned to its Git snapshots."""

import json
import http.client
import subprocess
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from backend.github import analyze_request


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


class FileReadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "repository"
        self.root.mkdir()
        self.cache = Path(self.tmp.name) / "cache"
        self.cache_patch = patch("backend.github.CACHE", self.cache)
        self.cache_patch.start()
        self.addCleanup(self.cache_patch.stop)
        git(self.root, "init", "-q")
        git(self.root, "config", "user.name", "Fixture")
        git(self.root, "config", "user.email", "fixture@example.test")
        self.before = "from .dependency import VALUE\n\nCONSTANT = 1\n\ndef run():\n    return CONSTANT\n"
        self.after = "from .dependency import VALUE\n\nCONSTANT = 2\n\ndef run():\n    return CONSTANT\n"
        self.write("feature/service.py", self.before)
        self.write("feature/dependency.py", "VALUE = 42\n")
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "base")
        self.base = git(self.root, "rev-parse", "HEAD")
        self.write("feature/service.py", self.after)
        git(self.root, "commit", "-qam", "head")
        self.head = git(self.root, "rev-parse", "HEAD")

    def write(self, path, code):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(code)

    def analyze(self, **options):
        return analyze_request({"repoPath": str(self.root), "baseRef": self.base,
            "headRef": self.head, "scope": "feature", **options}, lambda _: None)

    def commit(self):
        git(self.root, "add", ".")
        git(self.root, "commit", "-qm", "next snapshot")
        self.head = git(self.root, "rev-parse", "HEAD")

    def read(self, result, path, **extra):
        self.assertIsInstance(result["meta"].get("analysisId"), str,
            "Analyses must identify their private pinned source descriptor")
        from backend.files import FileService
        return FileService().read({"analysisId": result["meta"]["analysisId"], "path": path, **extra})

    def test_reads_imports_constants_and_real_file_lines_from_pinned_objects(self):
        result = self.analyze()
        self.write("feature/service.py", "UNCOMMITTED CONTENT\n")
        source = self.read(result, "feature/service.py")
        self.assertEqual(source["path"], "feature/service.py")
        self.assertEqual(source["base"], {"path": "feature/service.py", "code": self.before, "startLine": 1})
        self.assertEqual(source["head"], {"path": "feature/service.py", "code": self.after, "startLine": 1})
        self.assertEqual(source["diff"], "--- base/feature/service.py\n+++ head/feature/service.py\n@@ -1,6 +1,6 @@\n from .dependency import VALUE\n \n-CONSTANT = 1\n+CONSTANT = 2\n \n def run():\n     return CONSTANT\n")
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_unchanged_dependency_without_symbols_is_readable_after_cache_hit_and_restart(self):
        first = self.analyze()
        self.assertNotIn("feature/dependency.py", [f["path"] for f in first["files"]])
        self.assertFalse(any(n["path"] == "feature/dependency.py" for n in first["nodes"]))
        # The analysis cache remains useful after its private descriptor is lost.
        for descriptor in (self.cache / "file-analyses").glob("*.json"):
            descriptor.unlink()
        from backend import analyzer
        with patch.object(analyzer, "analyze_sources", side_effect=AssertionError("Cache was not used")):
            result = self.analyze()
        source = self.read(result, "feature/dependency.py")
        self.assertEqual(source["base"]["code"], "VALUE = 42\n")
        self.assertEqual(source["head"], {"path": "feature/dependency.py", "code": "VALUE = 42\n", "startLine": 1})
        self.assertEqual(source["diff"], "")
        self.assertEqual(first["meta"]["analysisId"], result["meta"]["analysisId"])
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_changed_excluded_tests_and_supporting_text_are_still_readable(self):
        self.write("feature/tests/test_service.py", "def test_run():\n    assert True\n")
        self.write("notes.md", "# Supporting change\n")
        self.commit()
        result = self.analyze()
        self.assertFalse(any(n["path"] == "feature/tests/test_service.py" for n in result["nodes"]))
        for path, code in (("feature/tests/test_service.py", "def test_run():\n    assert True\n"),
                ("notes.md", "# Supporting change\n")):
            with self.subTest(path=path):
                source = self.read(result, path)
                self.assertIsNone(source["base"])
                self.assertEqual(source["head"]["code"], code)
                self.assertIn("--- /dev/null\n", source["diff"])

    def test_rename_aliases_keep_both_paths_and_deleted_files_have_no_head(self):
        self.write("feature/moved.py", self.after)
        (self.root / "feature/service.py").unlink()
        (self.root / "feature/dependency.py").unlink()
        self.commit()
        result = self.analyze()
        for path in ("feature/moved.py", "feature/service.py"):
            with self.subTest(path=path):
                source = self.read(result, path)
                self.assertEqual(source["base"], {"path": "feature/service.py", "code": self.before, "startLine": 1})
                self.assertEqual(source["head"], {"path": "feature/moved.py", "code": self.after, "startLine": 1})
                self.assertIn("+++ head/feature/moved.py\n", source["diff"])
        removed = self.read(result, "feature/dependency.py")
        self.assertEqual(removed["base"]["code"], "VALUE = 42\n")
        self.assertIsNone(removed["head"])
        self.assertIn("+++ /dev/null\n", removed["diff"])

    def test_old_rename_alias_reads_both_versions_when_symbols_are_replaced(self):
        changed = self.before.replace("def run():", "def replacement():")
        self.write("feature/moved.py", changed)
        (self.root / "feature/service.py").unlink()
        self.commit()
        result = self.analyze()
        moved = next(f for f in result["files"] if f["path"] == "feature/moved.py")
        self.assertEqual(moved["previousPath"], "feature/service.py")
        source = self.read(result, "feature/service.py")
        self.assertEqual(source["base"]["code"], self.before)
        self.assertIsNotNone(source["head"], "A removed symbol must not hide the renamed file's head snapshot")
        self.assertEqual(source["head"]["code"], changed)

    def test_older_analysis_reads_exact_commits_after_refs_and_new_analysis_change(self):
        original = self.analyze(headRef="HEAD")
        self.write("feature/service.py", "VALUE = 'later snapshot'\n")
        self.commit()
        newer = self.analyze(headRef="HEAD")
        self.assertNotEqual(original["meta"].get("analysisId"), newer["meta"].get("analysisId"))
        self.assertEqual(self.read(original, "feature/service.py")["head"]["code"], self.after)
        self.assertEqual(self.read(newer, "feature/service.py")["head"]["code"], "VALUE = 'later snapshot'\n")

    def test_invalid_ids_traversal_and_files_outside_analysis_are_rejected(self):
        self.write("private/secret.txt", "Do not expose this file\n")
        self.commit()
        # It was changed, so analyze a later comparison where it is unchanged.
        result = self.analyze(baseRef=self.head)
        self.read(result, "feature/service.py")
        from backend.files import FileService
        service = FileService()
        for path in ("../feature/service.py", "/feature/service.py", "feature/../service.py",
                "feature\\service.py", "feature//service.py", "feature/./service.py", "", ".",
                "feature/service.py\x00", "feature/service.py\n", "HEAD:feature/service.py"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "path|Path"):
                service.read({"analysisId": result["meta"]["analysisId"], "path": path})
        for identity in (None, [], "../descriptor", "", "a" * 64):
            with self.subTest(analysisId=identity), self.assertRaisesRegex(ValueError, "[Aa]nalysis"):
                service.read({"analysisId": identity, "path": "feature/service.py"})
        with self.assertRaisesRegex(ValueError, "analysis|allow"):
            self.read(result, "private/secret.txt")

    def test_binary_symlink_and_oversized_files_are_rejected_in_either_snapshot(self):
        (self.root / "feature/binary.dat").write_bytes(b"a\x00b")
        (self.root / "feature/nonutf8.dat").write_bytes(b"\xff\xfe")
        (self.root / "feature/link.py").symlink_to("service.py")
        self.write("feature/large.txt", "x" * (1024 * 1024 + 1))
        self.commit()
        result = self.analyze()
        # Ensure the descriptor exists before making malformed content requests.
        self.read(result, "feature/service.py")
        for path, message in (("feature/binary.dat", "[Bb]inary"), ("feature/nonutf8.dat", "[Bb]inary|UTF-8"),
                ("feature/link.py", "[Ss]ymlink|regular"), ("feature/large.txt", "large|1 MiB|limit")):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, message):
                self.read(result, path)
        # Neither symlink text nor a replacement regular file may hide the base mode.
        self.base = self.head
        (self.root / "feature/link.py").unlink()
        self.write("feature/link.py", "def link():\n    return 1\n")
        self.commit()
        result = self.analyze()
        with self.assertRaisesRegex(ValueError, "[Ss]ymlink|regular"):
            self.read(result, "feature/link.py")

    def test_newline_only_change_has_a_visible_diff_at_real_file_lines(self):
        self.write("feature/service.py", self.before.rstrip("\n"))
        self.commit()
        source = self.read(self.analyze(), "feature/service.py")
        self.assertIn("@@ -3,4 +3,4 @@", source["diff"])
        self.assertIn("-    return CONSTANT\n+    return CONSTANT\n\\ No newline at end of file\n", source["diff"])

    def test_github_analysis_uses_persisted_local_snapshots_without_fetching_on_read(self):
        metadata = {"title": "Fixture PR", "url": "https://github.com/fixture/repository/pull/1", "number": 1,
            "baseRefName": "base", "headRefName": "head", "baseRefOid": self.base, "headRefOid": self.head}
        from backend.github import GitSnapshot, _run
        def read_metadata(args, **kwargs):
            if args[0] == "gh":
                return json.dumps(metadata).encode()
            return _run(args, **kwargs)
        with patch("backend.github._matching_checkout", return_value=GitSnapshot(self.root)), patch("backend.github._run", side_effect=read_metadata):
            result = analyze_request({"prUrl": metadata["url"], "scope": "feature"}, lambda _: None)
        with patch("backend.github._fetch_snapshots", side_effect=AssertionError("Source reads cannot fetch")):
            source = self.read(result, "feature/service.py")
        self.assertEqual(result["meta"]["mode"], "github")
        self.assertEqual(source["head"]["code"], self.after)

    def test_post_api_reads_the_descriptor_and_applies_origin_and_body_validation(self):
        result = self.analyze()
        from backend.server import JobStore, make_handler
        jobs = JobStore()
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(jobs))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(body, headers=None):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            conn.request("POST", "/api/files/read", json.dumps(body), {"Content-Type": "application/json", **(headers or {})})
            response = conn.getresponse()
            status, payload = response.status, json.loads(response.read())
            conn.close()
            return status, payload
        try:
            body = {"analysisId": result["meta"].get("analysisId"), "path": "feature/service.py"}
            status, source = request(body)
            self.assertEqual(status, 200)
            self.assertEqual(source["head"]["code"], self.after)
            self.assertEqual(request(body, {"Origin": "https://evil.test"})[0], 403)
            self.assertEqual(request(body, {"Content-Type": "text/plain"})[0], 415)
            self.assertEqual(request([])[0], 400)
            self.assertEqual(request({"analysisId": "../escape", "path": "feature/service.py"})[0], 400)
            self.assertEqual(request({"analysisId": "a" * 64, "path": "feature/service.py"})[0], 404)
            self.assertEqual(request({**body, "path": "not-in-analysis.txt"})[0], 403)
        finally:
            server.shutdown()
            server.server_close()
            jobs.close()
