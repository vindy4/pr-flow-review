"""Read immutable Git snapshots; never check out or execute target code."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable
from urllib.parse import urlsplit

from backend.javascript import is_javascript
from backend.runtime import runtime_paths

PROJECT = runtime_paths().resources
CACHE = runtime_paths().cache
_FETCH_LOCK = threading.Lock()
_PART = r"[A-Za-z0-9_][A-Za-z0-9_.-]*"


def parse_pr_url(value: str) -> tuple[str, str, int]:
    parsed = urlsplit(value.strip())
    match = re.fullmatch(rf"/({_PART})/({_PART})/pull/([1-9][0-9]*)(?:/(?:files|commits|checks))?/?", parsed.path)
    if parsed.scheme != "https" or parsed.netloc.lower() != "github.com" or not match:
        raise ValueError("Enter a GitHub pull request URL, such as https://github.com/owner/repo/pull/123.")
    return match[1], match[2], int(match[3])


def validate_scope(value: str) -> str:
    value = value.strip().rstrip("/") or "."
    if value == ".":
        return value
    if value.startswith(("/", "-", "\\")) or any(c in value for c in (":", "\x00", "\n", "\r", "\\")) or ".." in PurePosixPath(value).parts:
        raise ValueError("Scope must be a repository-relative directory, without '..' or revision syntax.")
    return PurePosixPath(value).as_posix()


def select_scopes(paths: list[str]) -> list[str]:
    scopes = set()
    for path in paths:
        if not (path.endswith(".py") or is_javascript(path)):
            continue
        parts = PurePosixPath(path).parts[:-1]
        # One feature package beneath the application package, including siblings.
        depth = 3 if parts and parts[0] in {"app", "src", "lib"} else 2
        if parts[:2] == ('app', 'products'):
            depth = 4
        scopes.add("/".join(parts[:depth]) or ".")
    if "." in scopes:
        return ["."]
    return sorted(s for s in scopes if not any(s.startswith(other + "/") for other in scopes if s != other))


def _run(args: list[str], *, data: bytes | None = None, timeout: int = 90, isolated_git: bool = False) -> bytes:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1", "GH_HOST": "github.com"}
    if isolated_git:
        # App-owned caches use GitHub CLI over HTTPS, independent of a developer's
        # SSH URL rewrites, external credential helpers or injected Git config.
        env = {key: value for key, value in env.items() if not key.startswith('GIT_CONFIG')}
        env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
    try:
        result = subprocess.run(args, input=data, capture_output=True, timeout=timeout, env=env)
    except FileNotFoundError as exc:
        raise ValueError(f"{args[0]} is not installed or is not available on PATH.") from exc
    except subprocess.TimeoutExpired as exc:
        raise ValueError(f"{args[0]} timed out while reading repository data. Check connectivity, or select an existing checkout under Advanced options and retry.") from exc
    if result.returncode:
        if args[0] == "gh":
            raise ValueError("GitHub could not read this PR. Check the URL, run 'gh auth login', and authorize organization SSO if required.")
        raise ValueError("Git could not read the requested repository or snapshot. Check the local path, refs, and repository access.")
    return result.stdout


class GitSnapshot:
    def __init__(self, path: Path):
        self.path = path.expanduser().resolve()
        self.managed = self.path.parent == (CACHE / 'repositories').expanduser().resolve()
        self._objects: dict[tuple[str, str], str] = {}
        self._sizes: dict[str, int] = {}
        self._present: set[str] = set()
        if not self.path.is_dir():
            raise ValueError("The local repository directory does not exist.")
        self.git("rev-parse", "--git-dir")

    def git(self, *args: str, data: bytes | None = None, timeout: int = 90) -> bytes:
        # Never let a metadata command silently download file contents. Managed
        # caches hydrate explicitly, in batches, after checking remote sizes.
        flags = ['--literal-pathspecs', *(['--no-lazy-fetch'] if self.managed else [])]
        return _run(["git", *flags, "-C", str(self.path), *args], data=data,
                    timeout=timeout, isolated_git=self.managed)

    def _blob_sizes(self, oids: list[str]) -> dict[str, int]:
        missing = sorted(set(oids) - self._sizes.keys())
        if not missing:
            return self._sizes
        records = self.git('cat-file', '--batch-check', data=('\n'.join(missing) + '\n').encode()).decode().splitlines()
        absent = []
        for record in records:
            fields = record.split()
            if len(fields) == 3 and fields[1] == 'blob':
                self._sizes[fields[0]] = int(fields[2])
                self._present.add(fields[0])
            elif len(fields) == 2 and fields[1] == 'missing':
                absent.append(fields[0])
            else:
                raise ValueError('A selected snapshot object is not a readable source blob.')
        if absent:
            remote = self.git('config', '--local', '--get', 'remote.origin.url').decode().strip()
            match = re.fullmatch(rf'https://github\.com/({_PART})/({_PART})\.git', remote)
            if not self.managed or not match:
                raise ValueError('The cached snapshot is incomplete. Run the analysis again.')
            for start in range(0, len(absent), 100):
                batch = absent[start:start + 100]
                fields = ' '.join(f'b{i}: object(oid:"{oid}") {{ ... on Blob {{ byteSize }} }}' for i, oid in enumerate(batch))
                query = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){' + fields + '}}'
                payload = json.loads(_run(['gh', 'api', 'graphql', '--input', '-'], data=json.dumps({
                    'query': query, 'variables': {'owner': match[1], 'name': match[2]},
                }).encode()))
                repository = (payload.get('data') or {}).get('repository') or {}
                for i, oid in enumerate(batch):
                    size = (repository.get(f'b{i}') or {}).get('byteSize')
                    if payload.get('errors') or type(size) is not int or size < 0:
                        raise ValueError('GitHub could not read snapshot file sizes. Check repository access and retry.')
                    self._sizes[oid] = size
        return self._sizes

    def _hydrate(self, oids: list[str]) -> None:
        if not self.managed:
            return
        missing = sorted(set(oids) - self._present)
        if missing:
            # Same batched transport as Git's promisor remote, without per-blob
            # lazy fetches or downloading unrelated assets/history.
            self.git('fetch', 'origin', '--no-tags', '--no-write-fetch-head',
                     '--recurse-submodules=no', '--filter=blob:none', '--stdin',
                     data=('\n'.join(missing) + '\n').encode(), timeout=240)
            self._present.update(missing)

    def entry(self, sha: str, path: str) -> tuple[str, str, str, int] | None:
        for record in self.git('ls-tree', '--full-tree', '-z', sha, '--', path).split(b'\0'):
            if b'\t' not in record or record.split(b'\t', 1)[1] != path.encode():
                continue
            mode, kind, oid = record.split(b'\t', 1)[0].decode().split()
            size = self._blob_sizes([oid])[oid] if mode in {'100644', '100755'} and kind == 'blob' else -1
            return mode, kind, oid, size
        return None

    def read_blob(self, oid: str) -> bytes:
        self._blob_sizes([oid])
        self._hydrate([oid])
        return self.git('cat-file', 'blob', oid)

    def resolve_ref(self, ref: str) -> str:
        if not isinstance(ref, str) or not ref or len(ref) > 240 or ref.startswith("-") or any(c in ref for c in "\x00\n\r"):
            raise ValueError("Enter a valid branch name or commit SHA.")
        return self.git("rev-parse", "--verify", "--end-of-options", ref + "^{commit}").decode().strip()

    def has_commit(self, sha: str) -> bool:
        try:
            return self.resolve_ref(sha) == sha
        except ValueError:
            return False

    def merge_base(self, base: str, head: str) -> str:
        return self.git("merge-base", base, head).decode().strip()

    def changed_files(self, base: str, head: str) -> list[dict]:
        threshold = '100%' if self.managed else '50%'
        files = self._changes(base, head, threshold)
        if self.managed:
            # Exact renames need tree OIDs only. Similarity detection needs
            # contents: restrict it to bounded small add/delete candidates.
            added = [f['path'] for f in files if f['status'] == 'added']
            removed = [f['path'] for f in files if f['status'] == 'removed']
            if added and removed:
                candidates: dict[str, tuple[str, str]] = {}
                for sha, paths in ((base, removed), (head, added)):
                    entries = {}
                    for record in self.git('ls-tree', '--full-tree', '-z', sha, '--', *paths[:2000]).split(b'\0'):
                        if b'\t' not in record:
                            continue
                        metadata, path_bytes = record.split(b'\t', 1)
                        mode, kind, oid = metadata.decode().split()
                        if mode in {'100644', '100755'} and kind == 'blob':
                            entries[path_bytes.decode()] = oid
                    sizes = self._blob_sizes(list(entries.values()))
                    for path, oid in entries.items():
                        if sizes[oid] <= 1024 * 1024:
                            candidates[path] = (oid, sha)
                chosen, totals = [], {base: 0, head: 0}
                for path in sorted(candidates):
                    oid, sha = candidates[path]
                    size = self._sizes[oid]
                    if totals[sha] + size <= 32 * 1024 * 1024:
                        totals[sha] += size
                        chosen.append(path)
                if chosen:
                    self._hydrate([candidates[path][0] for path in chosen])
                    renames = [f for f in self._changes(base, head, '50%', chosen) if 'previousPath' in f]
                    consumed = {p for f in renames for p in (f['path'], f['previousPath'])}
                    files = [f for f in files if f['path'] not in consumed] + renames
        return sorted(files, key=lambda f: f['path'])

    def _changes(self, base: str, head: str, threshold: str, paths: list[str] | None = None) -> list[dict]:
        chunks = self.git("diff", "--no-ext-diff", "--no-textconv", f"--find-renames={threshold}", "--name-status", "-z", base, head, "--", *(paths or [])).decode("utf-8", errors="replace").split("\0")
        files, i = [], 0
        while i < len(chunks) - 1:
            status, path = chunks[i:i + 2]
            if status.startswith('R'):
                files.append({'path': chunks[i + 2], 'previousPath': path,
                              'status': 'moved' if status == 'R100' else 'moved_modified'})
                i += 3
            else:
                files.append({'path': path, 'status': {'A': 'added', 'D': 'removed'}.get(status, 'modified')})
                i += 2
        return files

    def _manifest(self, sha: str, scopes: list[str], include_tests: bool) -> dict[str, str | None]:
        if not scopes:
            return {}
        pathspecs = [] if "." in scopes else scopes
        entries = self.git("ls-tree", "-r", "-z", sha, "--", *pathspecs).decode("utf-8", errors="replace").split("\0")
        manifest = {}
        for entry in entries:
            if "\t" not in entry:
                continue
            metadata, path = entry.split("\t", 1)
            parts = PurePosixPath(path).parts
            if not (path.endswith(".py") or is_javascript(path)) or any(p in {".venv", "venv", "node_modules", "__pycache__", ".git", "dist", "build"} for p in parts):
                continue
            is_test = any(p in {"tests", "test", "__tests__", "__mocks__", "integration_tests", "integration-tests", "component-tests"} for p in parts) or PurePosixPath(path).name.startswith("test_") or path.endswith("_test.py") or bool(re.search(r'\.(?:test|spec)\.[cm]?[jt]sx?$', path))
            if include_tests or not is_test:
                fields = metadata.split()
                # Symlinks are not sources; do not follow them or compare a
                # regular source against its link text on the opposite side.
                oid = fields[2] if fields[0] in {"100644", "100755"} and fields[1] == "blob" else None
                manifest[path] = oid
                if oid:
                    self._objects[sha, path] = oid
        return manifest

    def _coverage(self, base: dict[str, str | None], head: dict[str, str | None], max_files: int, priority: list[str]) -> tuple[list[str], bool]:
        chosen = []
        total_base = total_head = 0
        preferred = set(priority)
        union = set(base) | set(head)
        ordered = sorted(union, key=lambda p: (p not in preferred, p))
        for start in range(0, len(ordered), 100):
            if len(chosen) >= max_files:
                break
            batch = ordered[start:start + 100]
            sizes = self._blob_sizes([oid for path in batch for oid in (base.get(path), head.get(path)) if oid])
            for path in batch:
                a = 0 if path not in base else sizes.get(base[path], -1)
                b = 0 if path not in head else sizes.get(head[path], -1)
                if len(chosen) >= max_files or min(a, b) < 0 or max(a, b) > 1024 * 1024 or "\n" in path or "\r" in path:
                    continue
                if total_base + a > 32 * 1024 * 1024 or total_head + b > 32 * 1024 * 1024:
                    continue
                chosen.append(path)
                total_base += a
                total_head += b
        return chosen, len(chosen) < len(union)

    def _read_blobs(self, sha: str, paths: list[str]) -> dict[str, str]:
        if not paths:
            return {}
        self._hydrate([self._objects[sha, path] for path in paths])
        # A single process reads pinned blobs, independent of working-tree contents.
        # Manifest sizes are checked before requesting contents, bounding memory.
        output = self.git("cat-file", "--batch", data="".join(f"{sha}:{p}\n" for p in paths).encode())
        cursor = 0
        sources = {}
        for path in paths:
            end = output.find(b"\n", cursor)
            fields = output[cursor:end].split()
            cursor = end + 1
            if len(fields) != 3 or fields[1] != b"blob":
                raise ValueError("A selected source blob could not be read from the pinned snapshot.")
            size = int(fields[2])
            content = output[cursor:cursor + size]
            cursor += size + 1
            sources[path] = content.decode("utf-8", errors="replace")
        return sources

    def read_sources(self, sha: str, scopes: list[str], *, include_tests: bool = False, max_files: int = 2000) -> tuple[dict[str, str], bool]:
        manifest = self._manifest(sha, scopes, include_tests)
        chosen, limited = self._coverage(manifest, manifest, max_files, [])
        return self._read_blobs(sha, chosen), limited

    def read_pair(self, base: str, head: str, scopes: list[str], *, include_tests: bool = False, max_files: int = 2000, priority: list[str] | None = None) -> tuple[dict[str, str], dict[str, str], bool]:
        before = self._manifest(base, scopes, include_tests)
        after = self._manifest(head, scopes, include_tests)
        # Decide once for both versions. Omitting a file must never invent a
        # method addition/removal merely because coverage changed at a limit.
        chosen, limited = self._coverage(before, after, max_files, priority or [])
        return self._read_blobs(base, [p for p in chosen if p in before]), self._read_blobs(head, [p for p in chosen if p in after]), limited


def _matching_checkout(owner: str, name: str, supplied: str | None) -> GitSnapshot | None:
    if not supplied and os.environ.get('PR_FLOW_DESKTOP') == '1':
        return None
    candidates = [Path(supplied)] if supplied else [PROJECT.parent / name, Path.cwd() / name]
    for path in candidates:
        try:
            repo = GitSnapshot(path)
            remote = repo.git("remote", "get-url", "origin").decode().strip().removesuffix(".git").lower()
            accepted = {f"ssh://git@github.com/{owner}/{name}".lower(), f"git@github.com:{owner}/{name}".lower(), f"https://github.com/{owner}/{name}".lower()}
            if remote in accepted:
                return repo
        except ValueError:
            pass
    if supplied:
        raise ValueError("The supplied checkout does not have an origin matching this GitHub repository.")
    return None


def _fetch_snapshots(owner: str, name: str, shas: list[str]) -> GitSnapshot:
    slug = hashlib.sha256(f"{owner}/{name}".lower().encode()).hexdigest()[:16]
    directory = CACHE / "repositories" / (slug + ".git")
    with _FETCH_LOCK:
        if not directory.exists():
            directory.parent.mkdir(parents=True, exist_ok=True)
            _run(["git", "init", "--bare", str(directory)], isolated_git=True)
        repo = GitSnapshot(directory)
        for key, value in {
            'remote.origin.url': f'https://github.com/{owner}/{name}.git',
            'remote.origin.promisor': 'true', 'remote.origin.partialclonefilter': 'blob:none',
            'credential.helper': '', 'credential.https://github.com.helper': '!gh auth git-credential',
        }.items():
            repo.git('config', '--local', '--replace-all', key, value)
        missing = [sha for sha in shas if not repo.has_commit(sha)]
        if missing:
            repo.git('fetch', '--no-tags', '--depth=1', '--filter=blob:none',
                     '--recurse-submodules=no', 'origin', *missing, timeout=240)
        return repo


def analyze_request(request: dict, progress: Callable[[str], None]) -> dict:
    from backend.analyzer import analyze_sources

    supplied = request.get("repoPath") or None
    if supplied is not None and not isinstance(supplied, str):
        raise ValueError("Local checkout path must be text.")
    if request.get("prUrl"):
        if not isinstance(request["prUrl"], str):
            raise ValueError("Pull request URL must be text.")
        owner, name, number = parse_pr_url(request["prUrl"])
        progress("Reading pull request metadata from GitHub…")
        metadata = json.loads(_run(["gh", "pr", "view", str(number), "--repo", f"{owner}/{name}", "--json", "title,url,number,baseRefName,headRefName,baseRefOid,headRefOid"]))
        head = metadata["headRefOid"]
        base_tip = metadata["baseRefOid"]
        repository = f"{owner}/{name}"
        repo = _matching_checkout(owner, name, supplied)
        base = None
        if repo and repo.has_commit(head) and repo.has_commit(base_tip):
            try:
                base = repo.merge_base(base_tip, head)
            except ValueError:
                pass
        if not base:
            progress("Finding the PR merge base…")
            base = _run(["gh", "api", f"repos/{repository}/compare/{base_tip}...{head}", "--jq", ".merge_base_commit.sha"]).decode().strip()
        if not re.fullmatch(r"[a-f0-9]{40}", base) or not re.fullmatch(r"[a-f0-9]{40}", head):
            raise ValueError("GitHub returned an invalid snapshot identifier.")
        if not repo or not repo.has_commit(base) or not repo.has_commit(head):
            progress("Fetching immutable snapshots into the app cache…")
            repo = _fetch_snapshots(owner, name, [base, head])
        meta = {"title": metadata["title"], "prUrl": metadata["url"], "number": number, "repository": repository, "baseRef": metadata["baseRefName"], "headRef": metadata["headRefName"], "mode": "github"}
    else:
        if not supplied or not request.get("baseRef") or not request.get("headRef"):
            raise ValueError("Enter a PR URL, or choose a local repository with base and head refs.")
        progress("Reading local Git snapshots…")
        repo = GitSnapshot(Path(supplied))
        head = repo.resolve_ref(request["headRef"])
        base = repo.merge_base(repo.resolve_ref(request["baseRef"]), head)
        meta = {"title": "Local branch comparison", "prUrl": None, "number": None, "repository": repo.path.name, "baseRef": request["baseRef"], "headRef": request["headRef"], "mode": "local"}
    progress("Identifying changed files and analysis scope…")
    files = repo.changed_files(base, head)
    changed = [path for f in files for path in (f['path'], f.get('previousPath')) if path]
    renames = {f['previousPath']: f['path'] for f in files if f.get('previousPath')}
    scope_input = request.get("scope") or ""
    if not isinstance(scope_input, str):
        raise ValueError("Scope must be text.")
    scopes = [validate_scope(part) for part in scope_input.split(",") if part.strip()] if scope_input.strip() else select_scopes(changed)
    include_tests = request.get("includeTests", False)
    if not isinstance(include_tests, bool):
        raise ValueError("Include tests must be true or false.")
    key = hashlib.sha256(json.dumps(["v10", meta["repository"], meta["prUrl"], base, head, scopes, include_tests, meta["mode"]]).encode()).hexdigest()
    cache_file = CACHE / "analyses" / (key + ".json")
    if cache_file.is_file() and not request.get("force"):
        progress("Loading cached analysis for these exact commits…")
        try:
            result = json.loads(cache_file.read_text())
            from backend.files import FileService
            result["meta"]["analysisId"] = FileService().register(repo, base, head, result)
            return result
        except (ValueError, OSError):
            pass
    progress("Reading base and head sources, including unchanged callers…")
    base_sources, head_sources, limited = repo.read_pair(base, head, scopes, include_tests=include_tests, priority=changed)
    progress(f"Resolving symbols and relationships across {len(set(base_sources) | set(head_sources))} source files…")
    result = analyze_sources(base_sources, head_sources, changed, renames)
    for file in files:
        file["changedMethods"] = sum(node["path"] == file["path"] and node["status"] != "unchanged" for node in result["nodes"])
        file["indexed"] = (file.get('previousPath') or file['path']) in base_sources or file["path"] in head_sources
    result["files"] = files
    from backend.architecture import include_unindexed_files
    include_unindexed_files(result['architecture'], files)
    result["meta"] = {**meta, "baseSha": base, "headSha": head, "scopes": scopes, "indexedFiles": len(set(base_sources) | set(head_sources)), "changedFiles": len(files), "analyzedAt": datetime.now(timezone.utc).isoformat(), "limited": limited, "includeTests": include_tests}
    result["warnings"].append("Call graphs describe statically resolved source relationships, not runtime execution. Callers outside the displayed scope are not indexed.")
    if not include_tests:
        result["warnings"].append("Test files are excluded. Enable Include tests to index their call relationships.")
    if limited:
        result["warnings"].append("Index limit reached (2,000 shared file paths, 1 MiB per file, 32 MiB of sources per snapshot). Narrow the scope to avoid omitted files.")
    if not head_sources and not base_sources:
        result["warnings"].append("No supported sources matched this scope. Supported: Python, JavaScript, JSX, TypeScript and TSX (declaration files excluded).")
    from backend.files import FileService
    result["meta"]["analysisId"] = FileService().register(repo, base, head, result)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    # Independent jobs may finish the same comparison concurrently.
    with tempfile.NamedTemporaryFile(mode="w", dir=cache_file.parent, suffix=".tmp", delete=False) as output:
        json.dump(result, output)
    Path(output.name).replace(cache_file)
    return result
