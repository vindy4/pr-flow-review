import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.server import JobStore, make_handler


class DesktopRuntimeTests(unittest.TestCase):
    def test_writable_paths_are_separate_from_packaged_resources(self):
        from backend.runtime import runtime_paths
        paths = runtime_paths({
            'PR_FLOW_RESOURCE_DIR': '/Applications/PR Flow Review.app/Contents/Resources',
            'PR_FLOW_DATA_DIR': '/tmp/state', 'PR_FLOW_CACHE_DIR': '/tmp/cache',
        })
        self.assertEqual(paths.resources, Path('/Applications/PR Flow Review.app/Contents/Resources'))
        self.assertEqual(paths.data, Path('/tmp/state'))
        self.assertEqual(paths.cache, Path('/tmp/cache'))
        self.assertEqual(runtime_paths({}).data, runtime_paths({}).cache)

    def test_receipts_and_descriptors_use_durable_data_not_cache(self):
        from backend.files import FileService
        from backend.reviews import ReviewService
        with tempfile.TemporaryDirectory() as root, patch.dict('os.environ', {
            'PR_FLOW_DATA_DIR': root, 'PR_FLOW_CACHE_DIR': root + '/expendable',
        }):
            self.assertEqual(FileService().descriptors, Path(root) / 'file-analyses')
            self.assertEqual(ReviewService().cache_dir, Path(root) / 'reviews' / 'submissions')

    def test_desktop_does_not_discover_repositories_relative_to_bundle(self):
        from backend.github import _matching_checkout
        with patch.dict('os.environ', {'PR_FLOW_DESKTOP': '1'}), patch('backend.github.GitSnapshot') as snapshot:
            self.assertIsNone(_matching_checkout('owner', 'repo', None))
            snapshot.assert_not_called()

    def test_secret_is_required_for_reads_and_writes_without_weakening_origin(self):
        from http.server import ThreadingHTTPServer
        secret = 'a' * 64
        jobs = JobStore(lambda body, progress: {})
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(jobs, api_secret=secret))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def request(method='GET', headers=None):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
                connection.request(method, '/api/health' if method == 'GET' else '/api/analyze',
                    '{}' if method == 'POST' else None,
                    {'Content-Type': 'application/json', **(headers or {})})
                response = connection.getresponse()
                status, body = response.status, json.loads(response.read())
                connection.close()
                return status, body
            for method in ('GET', 'POST'):
                self.assertEqual(request(method)[0], 403)
                self.assertEqual(request(method, {'X-PR-Flow-Secret': 'wrong'})[0], 403)
                self.assertEqual(request(method, {'X-PR-Flow-Secret': secret, 'Origin': 'app://flow-review'})[0], 403)
                self.assertEqual(request(method, {'X-PR-Flow-Secret': secret, 'Origin': 'https://evil.test'})[0], 403)
            self.assertEqual(request(headers={'X-PR-Flow-Secret': secret})[0], 200)
            self.assertEqual(request('POST', {'X-PR-Flow-Secret': secret})[0], 202)
        finally:
            server.shutdown()
            server.server_close()
            jobs.close()


if __name__ == '__main__':
    unittest.main()
