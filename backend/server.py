"""Loopback-only API and production frontend server."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import secrets
import shutil
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from backend.github import PROJECT, analyze_request
from backend.files import FileReadError, FileService
from backend.reviews import ReviewError, ReviewService


class JobStore:
    def __init__(self, analyzer=analyze_request):
        self.analyzer = analyzer
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="analysis")

    def start(self, body: dict) -> str:
        with self.lock:
            active = sum(j["status"] in {"queued", "running"} for j in self.jobs.values())
            if active >= 6:
                raise ValueError("Several analyses are already running. Wait for one to finish.")
            completed = [key for key, job in self.jobs.items() if job["status"] in {"complete", "error"}]
            for key in completed[:-12]:
                del self.jobs[key]
            job_id = uuid.uuid4().hex
            self.jobs[job_id] = {"id": job_id, "status": "queued", "stage": "Waiting to start…"}
        self.executor.submit(self._run, job_id, body)
        return job_id

    def _run(self, job_id: str, body: dict) -> None:
        def progress(stage: str):
            with self.lock:
                self.jobs[job_id].update(status="running", stage=stage)
        try:
            progress("Starting analysis…")
            result = self.analyzer(body, progress)
            with self.lock:
                self.jobs[job_id].update(status="complete", stage="Analysis complete", result=result)
        except ValueError as exc:
            with self.lock:
                self.jobs[job_id].update(status="error", stage="Analysis could not complete", error=str(exc))
        except Exception:
            if os.environ.get('PR_FLOW_DESKTOP') != '1':
                traceback.print_exc()
            with self.lock:
                self.jobs[job_id].update(status="error", stage="Analysis failed", error="Unexpected analysis error. See the backend terminal for details.")

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job else None

    def close(self) -> None:
        self.executor.shutdown(wait=True, cancel_futures=True)


def make_handler(jobs: JobStore, reviews=None, api_secret: str | None = None):
    reviews = reviews or ReviewService()
    files = FileService()
    class Handler(BaseHTTPRequestHandler):
        def _json(self, status: int, data: dict) -> None:
            content = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(content)

        def _trusted(self) -> bool:
            supplied_secret = self.headers.get('X-PR-Flow-Secret', '')
            if api_secret is not None and not secrets.compare_digest(supplied_secret.encode(), api_secret.encode()):
                self._json(403, {"error": "This request is not from the desktop application."})
                return False
            port = self.server.server_port
            hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
            if self.headers.get("Host") not in hosts:
                self._json(403, {"error": "Only requests to the local application host are accepted."})
                return False
            origin = self.headers.get("Origin")
            allowed_origins = {f"http://{host}" for host in hosts} | {"http://127.0.0.1:5173", "http://localhost:5173"}
            if origin is not None and origin not in allowed_origins:
                self._json(403, {"error": "Requests from other websites are not accepted."})
                return False
            return True

        def do_POST(self) -> None:
            if not self._trusted():
                return
            path = urlsplit(self.path).path
            if path not in {"/api/analyze", "/api/reviews/context", "/api/reviews/refresh", "/api/reviews/submit", "/api/files/read"}:
                self._json(404, {"error": "Unknown API route."})
                return
            if self.headers.get_content_type() != "application/json":
                self._json(415, {"error": "Send an application/json request."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                limit = 1024 * 1024 if path == '/api/reviews/refresh' else 65536
                if not 0 < length <= limit:
                    raise ValueError(f"Request body must be between 1 byte and {limit // 1024} KiB.")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("Request body must be a JSON object.")
                if path == '/api/files/read':
                    self._json(200, files.read(body))
                    return
                if path.startswith('/api/reviews/'):
                    method = {'/api/reviews/context': reviews.context, '/api/reviews/refresh': reviews.refresh,
                        '/api/reviews/submit': reviews.submit}[path]
                    result = method(body)
                    self._json(200, result)
                    return
                job_id = jobs.start(body)
            except FileReadError as exc:
                self._json(exc.status, {"error": str(exc)})
                return
            except ReviewError as exc:
                self._json(exc.status, {"error": str(exc), "ambiguous": exc.ambiguous})
                return
            except (ValueError, UnicodeError) as exc:
                self._json(400, {"error": str(exc)})
                return
            self._json(202, {"jobId": job_id})

        def do_GET(self) -> None:
            if not self._trusted():
                return
            path = urlsplit(self.path).path
            if path == "/api/health":
                available = shutil.which("gh") is not None
                self._json(200, {"ok": True, "githubAvailable": available, "githubAuthenticated": None, "githubMessage": "GitHub CLI ready. Repository access is checked when analyzing." if available else "Install GitHub CLI and run gh auth login to analyze GitHub PRs. Local comparisons are available."})
            elif path.startswith("/api/jobs/"):
                job = jobs.get(path.removeprefix("/api/jobs/"))
                self._json(200 if job else 404, job or {"error": "Analysis job not found. Start a new analysis."})
            elif path.startswith("/api/"):
                self._json(404, {"error": "Unknown API route."})
            else:
                self._static(path)

        def _static(self, url_path: str) -> None:
            dist = (PROJECT / "dist").resolve()
            target = (dist / unquote(url_path).lstrip("/")).resolve()
            if not target.is_relative_to(dist):
                self._json(404, {"error": "File not found."})
                return
            if not target.is_file():
                # Vite app has a single route; do not serve the project directory.
                if url_path != "/":
                    self._json(404, {"error": "File not found."})
                    return
                target = dist / "index.html"
            if not target.is_file():
                self._json(503, {"error": "Frontend is not built. Run npm install and npm run build, or npm run dev during development."})
                return
            content = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-cache" if target.name == "index.html" else "public, max-age=86400")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(content)

        def log_message(self, fmt: str, *args) -> None:
            # Avoid noisy progress polling; errors remain visible in the terminal.
            if api_secret is None and len(args) > 1 and str(args[1]).startswith(("4", "5")):
                super().log_message(fmt, *args)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Local PR Flow Review server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument('--desktop', action='store_true')
    args = parser.parse_args()
    api_secret = os.environ.get('PR_FLOW_API_SECRET') if args.desktop else None
    if args.desktop and (not api_secret or len(api_secret) < 32):
        parser.error('Desktop mode requires a private API secret.')
    if args.desktop:
        os.environ['PR_FLOW_DESKTOP'] = '1'
    jobs = JobStore()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(jobs, api_secret=api_secret))
    print(json.dumps({'event': 'ready', 'port': server.server_port, 'pid': os.getpid()}) if args.desktop
        else f"PR Flow Review → http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        jobs.close()


if __name__ == "__main__":
    main()
