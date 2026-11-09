"""GitHub review context and explicit, deduplicated COMMENT submissions."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading

from backend.github import CACHE, parse_pr_url
from backend.runtime import persistent_root


class ReviewError(ValueError):
    def __init__(self, message, status=400, *, ambiguous=False):
        super().__init__(message)
        self.status, self.ambiguous = status, ambiguous


def gh_json(method, path, payload=None):
    args = ['gh', 'api', '--hostname', 'github.com', '--method', method, path]
    data = None
    if payload is not None:
        args.extend(['--input', '-'])
        data = json.dumps(payload).encode()
    try:
        result = subprocess.run(args, input=data, capture_output=True, timeout=60,
            env={**os.environ, 'GH_HOST': 'github.com', 'GIT_TERMINAL_PROMPT': '0'})
    except FileNotFoundError as exc:
        raise ReviewError('Install GitHub CLI and run gh auth login to use GitHub reviews.', 503) from exc
    except (subprocess.TimeoutExpired, OSError) as exc:
        raise ReviewError('GitHub did not confirm the request. Check the PR on GitHub before trying again.', 502, ambiguous=method == 'POST') from exc
    if result.returncode:
        match = re.search(r'HTTP (\d{3})', result.stderr.decode(errors='replace'))
        status = int(match[1]) if match else 502
        message = ('GitHub permission required. Check gh auth login, repository write access, and organization SSO.'
            if status in {401, 403, 404} else 'GitHub rejected this review. Check the PR on GitHub; your local drafts are preserved.'
            if 400 <= status < 500 else 'GitHub did not confirm the request. Check the PR on GitHub before trying again.')
        raise ReviewError(message, status if status in {401, 403, 404, 409, 422} else 502,
            ambiguous=method == 'POST' and status >= 500)
    try:
        return json.loads(result.stdout)
    except (ValueError, UnicodeError) as exc:
        raise ReviewError('GitHub returned an unreadable response. Check the PR before trying again.', 502, ambiguous=method == 'POST') from exc


def patch_lines(patch):
    before, after = [], []
    old = new = None
    for line in patch.splitlines():
        hunk = re.match(r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@', line)
        if hunk:
            old, new = int(hunk[1]), int(hunk[2])
        elif old is not None and line.startswith(' '):
            before.append(old); after.append(new)
            old += 1; new += 1
        elif old is not None and line.startswith('-'):
            before.append(old); old += 1
        elif new is not None and line.startswith('+'):
            after.append(new); new += 1
    return before, after


class ReviewService:
    def __init__(self, request=gh_json, cache_dir=None):
        self.request = request
        self.cache_dir = Path(cache_dir) if cache_dir is not None else persistent_root(CACHE) / 'reviews' / 'submissions'
        self.lock = threading.Lock()

    def identity(self, body):
        try:
            owner, repo, number = parse_pr_url(body.get('prUrl', ''))
        except (ValueError, AttributeError, TypeError) as exc:
            raise ReviewError('A GitHub pull request URL is required for a review.') from exc
        for key in ('baseSha', 'headSha'):
            if not isinstance(body.get(key), str) or not re.fullmatch(r'[a-fA-F0-9]{40}', body[key]):
                raise ReviewError('Reanalyze this PR to load valid review snapshots.')
        return f'repos/{owner}/{repo}/pulls/{number}', f'repos/{owner}/{repo}'

    @staticmethod
    def _valid_path(path):
        return (isinstance(path, str) and bool(path) and len(path) <= 4096
            and not any(character in path for character in ('\\', '\0', '\n', '\r'))
            and all(part not in {'', '.', '..'} for part in path.split('/')))

    def _refresh_items(self, body, kind):
        items = body.get(kind, [])
        if not isinstance(items, list) or len(items) > 2000:
            raise ReviewError('Review refresh items must be lists of at most 2,000 records.')
        identifiers = set()
        for item in items:
            if (not isinstance(item, dict) or not isinstance(item.get('id'), str)
                    or not item['id'] or len(item['id']) > 4096 or item['id'] in identifiers
                    or not self._valid_path(item.get('path'))
                    or any(not isinstance(item.get(key), str)
                        or not re.fullmatch(r'[a-fA-F0-9]{40}', item[key]) for key in ('baseSha', 'headSha'))):
                raise ReviewError('Every refresh record needs a unique ID, repository-relative path, and immutable snapshots.')
            if kind == 'comments' and (not isinstance(item.get('side'), str)
                    or item['side'] not in {'base', 'head'} or type(item.get('line')) is not int or item['line'] < 1):
                raise ReviewError('Every comment needs a snapshot side and positive line number.')
            identifiers.add(item['id'])
        return items

    def _metadata(self, pull):
        metadata = self.request('GET', pull)
        if (not isinstance(metadata, dict) or not isinstance(metadata.get('state'), str)
                or metadata['state'] not in {'open', 'closed'}):
            raise ReviewError('GitHub returned invalid pull request metadata.', 502)
        if metadata['state'] != 'open':
            raise ReviewError('This PR is no longer open. Local drafts are preserved.', 409)
        for side in ('base', 'head'):
            value = metadata.get(side)
            sha = value.get('sha') if isinstance(value, dict) else None
            if not isinstance(sha, str) or not re.fullmatch(r'[a-fA-F0-9]{40}', sha):
                raise ReviewError('GitHub returned an invalid snapshot identifier.', 502)
        return metadata

    def _validate_files(self, batch):
        if not isinstance(batch, list):
            raise ReviewError('GitHub returned an invalid PR diff.', 502)
        for file in batch:
            if (not isinstance(file, dict) or not self._valid_path(file.get('filename'))
                    or file.get('previous_filename') is not None and not self._valid_path(file['previous_filename'])
                    or file.get('patch') is not None and not isinstance(file['patch'], str)):
                raise ReviewError('GitHub returned an invalid PR diff.', 502)
        return batch

    def _pr_files(self, pull):
        files = []
        for page in range(1, 31):
            batch = self._validate_files(self.request('GET', f'{pull}/files?per_page=100&page={page}'))
            files.extend(batch)
            if len(batch) < 100:
                break
        return files

    @staticmethod
    def _file_context(files):
        result = []
        for file in files:
            before, after = patch_lines(file.get('patch') or '')
            result.append({'path': file['filename'], 'previousPath': file.get('previous_filename'),
                'baseLines': before, 'headLines': after})
        return result

    @staticmethod
    def _source_path(file, side):
        return (file.get('previous_filename') or file['filename']) if side == 'base' else file['filename']

    def _mapped_file(self, files, path, side=None, previous_path=None):
        aliases = {path}
        if previous_path:
            aliases.add(previous_path)
        candidates = [file for file in files if self._source_path(file, side or 'head') in aliases
            or side != 'base' and file.get('status') == 'renamed' and file.get('previous_filename') in aliases]
        if len(candidates) != 1:
            raise ReviewError('The file is missing from the latest PR diff or its rename is ambiguous.', 409)
        return candidates[0]

    def _cached_read(self, path, cache):
        if path not in cache:
            try:
                cache[path] = self.request('GET', path)
            except ReviewError as error:
                cache[path] = error
        if isinstance(cache[path], ReviewError):
            raise cache[path]
        return cache[path]

    def _blob_identity(self, repository, sha, path, cache):
        # Read immutable Git trees rather than decoded/limited source responses.
        # A symlink or submodule cannot stand in for verified source content.
        try:
            commit = self._cached_read(f'{repository}/git/commits/{sha}', cache)
            tree_sha = commit['tree']['sha']
            parts = path.split('/')
            for index, part in enumerate(parts):
                if not isinstance(tree_sha, str) or not re.fullmatch(r'[a-fA-F0-9]{40}', tree_sha):
                    raise ValueError('Invalid tree identity')
                tree = self._cached_read(f'{repository}/git/trees/{tree_sha}', cache)
                if tree.get('truncated') or not isinstance(tree.get('tree'), list):
                    raise ValueError('Incomplete Git tree')
                entries = [entry for entry in tree['tree'] if entry.get('path') == part]
                if not entries:
                    return None  # Proven absence is distinct from an unavailable tree.
                if len(entries) != 1:
                    raise ValueError('Ambiguous Git tree')
                entry = entries[0]
                if index < len(parts) - 1:
                    if entry.get('type') != 'tree':
                        raise ValueError('Source parent is not a directory')
                    tree_sha = entry['sha']
                else:
                    blob = entry.get('sha')
                    if (entry.get('type') != 'blob' or entry.get('mode') not in {'100644', '100755'}
                            or not isinstance(blob, str) or not re.fullmatch(r'[a-fA-F0-9]{40}', blob)):
                        raise ValueError('Source is not a regular Git blob')
                    return blob
        except (ReviewError, KeyError, TypeError, AttributeError, ValueError) as error:
            raise ReviewError('Complete source content could not be verified at its immutable snapshot.', 409) from error

    def refresh(self, body):
        pull, repository = self.identity(body)
        comments = self._refresh_items(body, 'comments')
        reviewed = self._refresh_items(body, 'reviewed')
        metadata = self._metadata(pull)
        head, base_tip = metadata['head']['sha'], metadata['base']['sha']
        comparison = self.request('GET', f'{repository}/compare/{base_tip}...{head}')
        merge_base = comparison.get('merge_base_commit') if isinstance(comparison, dict) else None
        base = merge_base.get('sha') if isinstance(merge_base, dict) else None
        if not isinstance(base, str) or not re.fullmatch(r'[a-fA-F0-9]{40}', base):
            raise ReviewError('GitHub returned an invalid comparison base.', 502)
        files = self._pr_files(pull)
        contexts = self._file_context(files)
        cache = {}
        original_files = {(base, head): files}
        result = {'baseSha': base, 'headSha': head, 'files': contexts, 'comments': [], 'reviewed': []}
        for kind, items in (('comments', comments), ('reviewed', reviewed)):
            for item in items:
                record = {key: item[key] for key in (('id', 'path', 'side', 'line') if kind == 'comments' else ('id', 'path'))}
                record.update(status='needs_attention', reason='')
                try:
                    pair = (item['baseSha'], item['headSha'])
                    if pair not in original_files:
                        old = self._cached_read(f'{repository}/compare/{pair[0]}...{pair[1]}', cache)
                        if (not isinstance(old, dict) or not isinstance(old.get('merge_base_commit'), dict)
                                or old['merge_base_commit'].get('sha') != pair[0]):
                            raise ReviewError('The original comparison could not be verified.', 409)
                        original_files[pair] = self._validate_files(old.get('files'))
                    side = item.get('side') if kind == 'comments' else None
                    original = self._mapped_file(original_files[pair], item['path'], side)
                    previous_path = original.get('previous_filename') if side != 'base' and original.get('status') == 'renamed' else None
                    file = self._mapped_file(files, item['path'], side, previous_path)
                    if kind == 'comments':
                        side = item['side']
                        path = self._source_path(file, side)
                        context = contexts[files.index(file)]
                        if item['line'] not in context['baseLines' if side == 'base' else 'headLines']:
                            raise ReviewError('This line is no longer commentable in the latest PR diff.', 409)
                        previous = self._blob_identity(repository, item[side + 'Sha'], item['path'], cache)
                        current = self._blob_identity(repository, base if side == 'base' else head, path, cache)
                        if previous is None or current != previous:
                            raise ReviewError('The complete source file changed or is missing on this snapshot side.', 409)
                        record['path'] = path
                    else:
                        identities = []
                        for side, current_sha in (('base', base), ('head', head)):
                            previous = self._blob_identity(repository, item[side + 'Sha'], self._source_path(original, side), cache)
                            current = self._blob_identity(repository, current_sha, self._source_path(file, side), cache)
                            if previous != current:
                                raise ReviewError('The complete file changed on its before or after snapshot.', 409)
                            identities.append(current)
                        if identities == [None, None]:
                            raise ReviewError('The source file is missing from both snapshots.', 409)
                        record['path'] = file['filename']
                    record['status'] = 'ready'
                except ReviewError as error:
                    record['reason'] = str(error)
                result[kind].append(record)
        latest = self._metadata(pull)
        if latest['head']['sha'] != head or latest['base']['sha'] != base_tip:
            raise ReviewError('The PR changed while checking drafts. Refresh again; local records are preserved.', 409)
        return result

    def context(self, body):
        pull, repository = self.identity(body)
        metadata = self.request('GET', pull)
        if metadata.get('state') != 'open':
            raise ReviewError('This PR is no longer open. Local drafts are preserved.', 409)
        if metadata['head']['sha'] != body['headSha']:
            raise ReviewError('This PR has new commits. Refresh drafts and submit again; local drafts are preserved.', 409)
        comparison = self.request('GET', f"{repository}/compare/{metadata['base']['sha']}...{body['headSha']}")
        if comparison['merge_base_commit']['sha'] != body['baseSha']:
            raise ReviewError('The PR comparison base changed. Refresh drafts and submit again; local drafts are preserved.', 409)
        files = []
        for page in range(1, 31):
            batch = self.request('GET', f'{pull}/files?per_page=100&page={page}')
            for file in batch:
                before, after = patch_lines(file.get('patch') or '')
                files.append({'path': file['filename'], 'previousPath': file.get('previous_filename'),
                    'baseLines': before, 'headLines': after})
            if len(batch) < 100:
                break
        return {'files': files}

    def _save(self, path, value):
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', dir=self.cache_dir, delete=False, suffix='.tmp') as stream:
            json.dump(value, stream)
            temporary = Path(stream.name)
        temporary.replace(path)

    def submit(self, body):
        pull, _ = self.identity(body)
        comments = body.get('comments')
        summary = body.get('body', '')
        if not isinstance(summary, str) or len(summary) > 10000:
            raise ReviewError('Review summary must be at most 10,000 characters.')
        if not isinstance(comments, list) or not 1 <= len(comments) <= 50:
            raise ReviewError('Submit between 1 and 50 draft comments per review.')
        for comment in comments:
            if (not isinstance(comment, dict) or not isinstance(comment.get('path'), str)
                    or not isinstance(comment.get('side'), str) or comment['side'] not in {'base', 'head'}
                    or type(comment.get('line')) is not int
                    or comment['line'] < 1 or not isinstance(comment.get('body'), str)
                    or not comment['body'].strip() or len(comment['body']) > 10000):
                raise ReviewError('Every comment needs a file, snapshot side, positive line and non-empty text (up to 10,000 characters).')
        # Canonicalize before hashing so harmless field/comment ordering cannot
        # publish an already-submitted batch twice, including after a restart.
        normalized = sorted(({k: c[k] for k in ('path', 'side', 'line', 'body')} for c in comments), key=lambda c: (c['path'], c['side'], c['line'], c['body']))
        identity = [pull, body['baseSha'], body['headSha'], summary, normalized]
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        receipt = self.cache_dir / (key + '.json')
        with self.lock:
            if receipt.is_file():
                saved = json.loads(receipt.read_text())
                if saved.get('result'):
                    return saved['result']
                raise ReviewError('GitHub may already have received this review. Check the PR on GitHub before submitting it again. Drafts are preserved.', 409, ambiguous=True)
            files = self.context(body)['files']
            outgoing = []
            for comment in comments:
                file = next((f for f in files if (f['previousPath'] or f['path'] if comment['side'] == 'base' else f['path']) == comment['path']), None)
                if not file or comment['line'] not in file['baseLines' if comment['side'] == 'base' else 'headLines']:
                    raise ReviewError('A comment is outside the current PR diff. Reopen the line or review it on GitHub; drafts are preserved.', 409)
                outgoing.append({'path': file['path'], 'side': 'LEFT' if comment['side'] == 'base' else 'RIGHT', 'line': comment['line'], 'body': comment['body']})
            self._save(receipt, {'state': 'pending'})
            try:
                response = self.request('POST', pull + '/reviews', {'commit_id': body['headSha'], 'event': 'COMMENT', 'body': summary, 'comments': outgoing})
                result = {'id': response['id'], 'url': response['html_url']}
            except ReviewError as error:
                if not error.ambiguous:
                    receipt.unlink(missing_ok=True)
                raise
            self._save(receipt, {'state': 'complete', 'result': result})
            return result
