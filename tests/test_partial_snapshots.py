"""Real filtered Git transport; only GitHub's network boundary is substituted."""

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import github
from backend.files import FileService


class PartialSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.remote = self.root / 'remote'
        self.remote.mkdir()
        self.command(self.remote, 'init', '-q')
        self.command(self.remote, 'config', 'user.name', 'Fixture')
        self.command(self.remote, 'config', 'user.email', 'fixture@example.test')
        self.command(self.remote, 'config', 'uploadpack.allowFilter', 'true')
        self.command(self.remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
        self.write('feature/service.py', 'def service():\n    return 1\n')
        self.write('feature/tests/test_service.py', 'def test_service():\n    pass\n')
        self.write('feature/data.json', '{"irrelevant":true}')
        self.write('feature/oversized.py', '#' + 'x' * (1024 * 1024 + 1))
        self.write('other/unused.py', 'def unused():\n    return 100\n')
        self.write('feature/old_name.py', ''.join(f'# context {i}\n' for i in range(40)) + 'def moved():\n    return 1\n')
        self.write('large-*.bin', ''.join(f'small fixture context {i}\n' for i in range(40)))
        (self.remote / 'feature/link.py').symlink_to('service.py')
        (self.remote / 'large-old.bin').write_bytes(os.urandom(2 * 1024 * 1024))
        self.base = self.commit()
        self.unused = self.command(self.remote, 'rev-parse', self.base + ':other/unused.py')
        self.binary = self.command(self.remote, 'rev-parse', self.base + ':large-old.bin')
        self.large_source = self.command(self.remote, 'rev-parse', self.base + ':feature/oversized.py')
        self.test_blob = self.command(self.remote, 'rev-parse', self.base + ':feature/tests/test_service.py')
        self.json_blob = self.command(self.remote, 'rev-parse', self.base + ':feature/data.json')
        self.write('feature/service.py', 'def service():\n    return 2\n')
        (self.remote / 'feature/old_name.py').rename(self.remote / 'feature/new_name.py')
        with (self.remote / 'feature/new_name.py').open('a') as output:
            output.write('# changed during rename\n')
        (self.remote / 'large-*.bin').rename(self.remote / 'small-renamed.bin')
        with (self.remote / 'small-renamed.bin').open('a') as output:
            output.write('changed during rename\n')
        binary = (self.remote / 'large-old.bin').read_bytes()
        (self.remote / 'large-old.bin').unlink()
        (self.remote / 'large-new.bin').write_bytes(binary[:-1] + b'x')
        self.head = self.commit()
        self.real_run = github._run
        self.fetches = []
        self.metadata_calls = 0
        self.patches = [patch.object(github, 'CACHE', self.root / 'cache'),
                        patch.object(github, '_run', side_effect=self.network)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def command(self, repo, *args):
        return subprocess.check_output(['git', '-C', str(repo), *args], text=True, stderr=subprocess.DEVNULL).strip()

    def write(self, path, text):
        target = self.remote / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self):
        self.command(self.remote, 'add', '.')
        self.command(self.remote, 'commit', '-qm', 'snapshot')
        return self.command(self.remote, 'rev-parse', 'HEAD')

    def network(self, args, **kwargs):
        if args[:3] == ['gh', 'api', 'graphql']:
            self.metadata_calls += 1
            query = json.loads(kwargs['data'])['query']
            # GitHub supplies sizes only; source data still travels through real Git.
            fields = re.findall(r'(b[0-9]+):\s*object\(oid:\s*"([a-f0-9]{40})"\)', query)
            self.assertTrue(fields, query)
            repository = {alias: {'byteSize': int(self.command(self.remote, 'cat-file', '-s', oid))}
                          for alias, oid in fields}
            return json.dumps({'data': {'repository': repository}}).encode()
        if args[0] == 'git' and 'fetch' in args:
            self.fetches.append((args, kwargs.get('data')))
        translated = list(args)
        if 'fetch' in args:
            index = args.index('fetch')
            translated[index:index] = ['-c', f'url.{self.remote.as_uri()}.insteadOf=https://github.com/fixture/repository.git']
        return self.real_run(translated, **kwargs)

    def fetch(self):
        return github._fetch_snapshots('fixture', 'repository', [self.base, self.head])

    def has_blob(self, repo, oid):
        result = subprocess.run(['git', '-C', str(repo.path), 'cat-file', '-e', oid],
                                env={**os.environ, 'GIT_NO_LAZY_FETCH': '1'}, capture_output=True)
        return result.returncode == 0

    def test_initial_fetch_does_not_download_unrelated_file_contents(self):
        repo = self.fetch()
        self.assertTrue(repo.has_commit(self.base))
        self.assertTrue(repo.has_commit(self.head))
        self.assertFalse(self.has_blob(repo, self.binary), 'Initial fetch downloaded a multi-megabyte unrelated binary')
        self.assertFalse(self.has_blob(repo, self.unused), 'Initial fetch downloaded source outside the requested scope')

    def test_scoped_sources_are_batched_without_downloading_excluded_or_oversized_files(self):
        repo = self.fetch()
        before, after, limited = repo.read_pair(self.base, self.head, ['feature'])
        self.assertEqual(before['feature/service.py'], 'def service():\n    return 1\n')
        self.assertEqual(after['feature/service.py'], 'def service():\n    return 2\n')
        self.assertTrue(limited)  # Oversized source and symlink remain excluded.
        self.assertEqual(set(after), {'feature/service.py', 'feature/new_name.py'})
        for oid in (self.binary, self.unused, self.large_source, self.test_blob, self.json_blob):
            self.assertFalse(self.has_blob(repo, oid), 'An excluded blob was downloaded')
        # There is one transport request for selected source contents on each side,
        # not an implicit request per file during ls-tree or cat-file.
        self.assertLessEqual(len(self.fetches), 3)

    def test_modified_source_renames_do_not_hydrate_large_binary_rename_candidates(self):
        repo = self.fetch()
        files = repo.changed_files(self.base, self.head)
        self.assertIn({'path': 'feature/new_name.py', 'previousPath': 'feature/old_name.py',
                       'status': 'moved_modified'}, files)
        self.assertFalse(self.has_blob(repo, self.binary), 'Rename detection downloaded a large unrelated binary')

    def test_file_reader_rejects_large_missing_blob_before_downloading_it(self):
        repo = self.fetch()
        service = FileService(self.root / 'descriptors')
        result = {'files': [{'path': 'feature/oversized.py', 'status': 'modified'}]}
        identifier = service.register(repo, self.base, self.head, result)
        with self.assertRaisesRegex(ValueError, '1 MiB|limit'):
            service.read({'analysisId': identifier, 'path': 'feature/oversized.py'})
        self.assertFalse(self.has_blob(repo, self.large_source))

    def test_scope_and_file_paths_with_glob_characters_are_literal(self):
        self.write('feature[1]/source[1].py', 'def literal():\n    return 1\n')
        self.write('feature1/source1.py', 'def unrelated():\n    return 2\n')
        self.head = self.commit()
        repo = self.fetch()
        sources, _ = repo.read_sources(self.head, ['feature[1]'])
        self.assertEqual(set(sources), {'feature[1]/source[1].py'})
        service = FileService(self.root / 'descriptors')
        result = {'files': [{'path': 'feature[1]/source[1].py', 'status': 'added'}]}
        identifier = service.register(repo, self.base, self.head, result)
        read = service.read({'analysisId': identifier, 'path': 'feature[1]/source[1].py'})
        self.assertEqual(read['head']['code'], sources['feature[1]/source[1].py'])

    def test_managed_fetch_does_not_use_user_url_rewrites_but_local_checkouts_still_do(self):
        repo = self.fetch()
        config = self.root / 'user.gitconfig'
        config.write_text('[url "ssh://git@invalid.test/"]\n\tinsteadOf = https://github.com/\n')
        with patch.dict(os.environ, {'GIT_CONFIG_GLOBAL': str(config)}):
            self.assertEqual(repo.git('ls-remote', '--get-url', 'https://github.com/owner/repo.git').decode().strip(),
                             'https://github.com/owner/repo.git')
            local = github.GitSnapshot(self.remote)
            self.assertEqual(local.git('ls-remote', '--get-url', 'https://github.com/owner/repo.git').decode().strip(),
                             'ssh://git@invalid.test/owner/repo.git')


if __name__ == '__main__':
    unittest.main()
