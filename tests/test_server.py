import http.client
import json
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

from backend.server import JobStore, make_handler


class ServerTests(unittest.TestCase):
    def setUp(self):
        def analyze(body, progress):
            progress("Reading fixture")
            if body.get("fail"):
                raise ValueError("The requested snapshot is missing")
            return {"nodes": [], "meta": {"mode": "local"}}
        self.jobs = JobStore(analyze)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.jobs))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.jobs.close()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        conn.request(method, path, json.dumps(body) if body is not None else None, {"Content-Type": "application/json", **(headers or {})})
        response = conn.getresponse()
        status = response.status
        data = json.loads(response.read())
        conn.close()
        return status, data

    def test_foreign_origin_and_host_cannot_start_analysis(self):
        for headers in ({"Origin": "https://evil.test"}, {"Host": "evil.test"}, {"Origin": "http://127.0.0.1:9999"}):
            with self.subTest(headers=headers):
                status, _ = self.request("POST", "/api/analyze", {}, headers)
                self.assertEqual(status, 403)

    def test_async_job_returns_result_and_reports_failed_analysis(self):
        for body, expected in (({}, "complete"), ({"fail": True}, "error")):
            status, data = self.request("POST", "/api/analyze", body)
            self.assertEqual(status, 202)
            for _ in range(50):
                status, job = self.request("GET", "/api/jobs/" + data["jobId"])
                if job["status"] in {"complete", "error"}:
                    break
                time.sleep(.01)
            self.assertEqual(job["status"], expected)
            if expected == "error":
                self.assertIn("snapshot is missing", job["error"])
            else:
                self.assertEqual(job["result"]["nodes"], [])

    def test_review_routes_apply_origin_and_body_validation(self):
        for route in ('/api/reviews/context', '/api/reviews/refresh', '/api/reviews/submit'):
            with self.subTest(route=route):
                self.assertEqual(self.request('POST', route, {}, {'Origin': 'https://evil.test'})[0], 403)
                self.assertEqual(self.request('POST', route, {})[0], 400)
                self.assertEqual(self.request('POST', route, [], {'Content-Type': 'text/plain'})[0], 415)

    def test_json_object_and_known_job_are_required(self):
        self.assertEqual(self.request("POST", "/api/analyze", ["bad"])[0], 400)
        self.assertEqual(self.request("GET", "/api/jobs/unknown")[0], 404)
        self.assertEqual(self.request("POST", "/api/analyze", {}, {"Content-Type": "text/plain"})[0], 415)

    def test_refresh_accepts_historical_record_payloads_above_submit_limit(self):
        # Invalid identity still reaches service validation instead of being
        # rejected by the ordinary 64 KiB request cap.
        status, data = self.request('POST', '/api/reviews/refresh', {'padding': 'x' * 70000})
        self.assertEqual(status, 400)
        self.assertIn('pull request URL', data['error'])


if __name__ == "__main__":
    unittest.main()
