"""Serve full text from private, allowlisted, immutable analysis snapshots."""

from __future__ import annotations

import difflib
import hashlib
import json
import re
import tempfile
from pathlib import Path

from backend import github
from backend.runtime import persistent_root


MAX_FILE_BYTES = 1024 * 1024
_SHA = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")


class FileReadError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _valid_path(path) -> bool:
    return (isinstance(path, str) and 0 < len(path) <= 4096
        and not path.startswith(("/", "-"))
        and not any(c in path for c in "\\:")
        and not any(ord(c) < 32 or ord(c) == 127 for c in path)
        and all(part not in {"", ".", ".."} for part in path.split("/")))


def _file_pairs(result: dict) -> dict:
    """Authorize displayed files, including dependencies with no callable nodes."""
    pairs, canonical = {}, set()
    for node in result.get("nodes", []):
        for field in ("path", "basePath", "headPath"):
            path = node.get(field)
            if _valid_path(path):
                pairs.setdefault(path, {"base": path, "head": path})
    for node in result.get("architecture", {}).get("nodes", []):
        path = node.get("path")
        if _valid_path(path):
            canonical.add(path)
            pairs[path] = {side: node[side].get("path", path) if node.get(side) else None
                for side in ("base", "head")}
    for file in result.get("files", []):
        path = file.get("path")
        if _valid_path(path):
            canonical.add(path)
            pairs[path] = {"base": None if file["status"] == "added" else file.get("previousPath", path),
                "head": None if file["status"] == "removed" else path}
    for path, pair in list(pairs.items()):
        before, after = pair["base"], pair["head"]
        if any(p is not None and not _valid_path(p) for p in (before, after)):
            del pairs[path]
        elif before and after and before != after and before not in canonical:
            pairs[before] = pair
    return pairs


class FileService:
    def __init__(self, cache: Path | None = None):
        self.cache = cache

    @property
    def descriptors(self) -> Path:
        return (self.cache if self.cache is not None else persistent_root(github.CACHE)) / "file-analyses"

    def register(self, repo: github.GitSnapshot, base: str, head: str, result: dict) -> str:
        if not _SHA.fullmatch(base) or not _SHA.fullmatch(head):
            raise FileReadError("The analysis has invalid pinned snapshot identifiers.")
        descriptor = {"repository": str(repo.path), "baseSha": base, "headSha": head,
            "files": _file_pairs(result)}
        content = json.dumps(descriptor, sort_keys=True)
        analysis_id = hashlib.sha256(content.encode()).hexdigest()
        self.descriptors.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Atomic replacement also handles concurrent analyses of the same pair.
        with tempfile.NamedTemporaryFile(mode="w", dir=self.descriptors, suffix=".tmp", delete=False) as output:
            output.write(content)
        Path(output.name).replace(self.descriptors / (analysis_id + ".json"))
        return analysis_id

    def read(self, body: dict) -> dict:
        analysis_id, path = body.get("analysisId"), body.get("path")
        if not isinstance(analysis_id, str) or not re.fullmatch(r"[a-f0-9]{64}", analysis_id):
            raise FileReadError("A valid analysis identifier is required. Run the analysis again.")
        if not _valid_path(path):
            raise FileReadError("File path must be a repository-relative path without traversal or revision syntax.")
        try:
            descriptor = json.loads((self.descriptors / (analysis_id + ".json")).read_text())
        except (OSError, ValueError) as exc:
            raise FileReadError("Analysis source descriptor was not found. Run the analysis again.", 404) from exc
        pair = descriptor["files"].get(path)
        if pair is None:
            raise FileReadError("This file is not part of the requested analysis.", 403)
        repo = github.GitSnapshot(Path(descriptor["repository"]))
        base = self._version(repo, descriptor["baseSha"], pair["base"])
        head = self._version(repo, descriptor["headSha"], pair["head"])
        if base is None and head is None:
            raise FileReadError("The file is absent from both pinned analysis snapshots.", 404)
        diff = difflib.unified_diff((base["code"] if base else "").splitlines(keepends=True),
            (head["code"] if head else "").splitlines(keepends=True),
            fromfile="base/" + base["path"] if base else "/dev/null",
            tofile="head/" + head["path"] if head else "/dev/null")
        # Keep unterminated last lines separate and make newline-only changes visible.
        patch = "".join(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n" for line in diff)
        return {"path": path, "base": base, "head": head, "diff": patch}

    @staticmethod
    def _version(repo: github.GitSnapshot, sha: str, path: str | None) -> dict | None:
        if path is None:
            return None
        if not _SHA.fullmatch(sha) or not _valid_path(path):
            raise FileReadError("The analysis source descriptor is invalid. Run the analysis again.")
        # Inspect the exact tree entry before reading any content. Never follow a
        # Git symlink or read a large object only to discover its size afterwards.
        entry = repo.entry(sha, path)
        if entry is None:
            return None
        mode, kind, oid, size = entry
        if mode not in {"100644", "100755"} or kind != "blob":
            raise FileReadError("Only regular text files can be read; symlinks and submodules are excluded.")
        if int(size) > MAX_FILE_BYTES:
            raise FileReadError("This file exceeds the 1 MiB source reading limit.")
        content = repo.read_blob(oid)
        if b"\0" in content or any(c < 32 and c not in (9, 10, 12, 13) for c in content):
            raise FileReadError("Binary files cannot be displayed as source text.")
        try:
            code = content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise FileReadError("Binary or non-UTF-8 files cannot be displayed as source text.") from exc
        return {"path": path, "code": code, "startLine": 1}
