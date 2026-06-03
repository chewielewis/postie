"""Local browser UI — stdlib http.server with threaded SSE.

Background work (scan / copy / ingest) runs in worker threads; the browser
subscribes to an SSE event stream per job. State of record stays in Supabase,
so a browser refresh or process restart never loses ingest progress.
"""

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse, parse_qs

from . import drives, gpu, pipeline
from .settings import PACKAGE_DIR
from .supa import Supa

_INDEX = (PACKAGE_DIR / "web" / "index.html").read_text(encoding="utf-8")
_TERMINAL = {"done", "failed"}


class Job:
    def __init__(self) -> None:
        self.events: List[dict] = []
        self.cond = threading.Condition()
        self.finished = False

    def emit(self, etype: str, data: dict) -> None:
        with self.cond:
            self.events.append({"type": etype, "data": data})
            if etype in _TERMINAL:
                self.finished = True
            self.cond.notify_all()


class Server:
    def __init__(self, show_code: str, port: int) -> None:
        self.supa = Supa()
        self.show = self.supa.get_show(show_code)
        if not self.show:
            raise SystemExit("Show '{}' not found in Supabase 'shows' table.".format(show_code))
        self.show_code = show_code.upper()
        self.port = port
        self.jobs: Dict[str, Job] = {}
        self.scans: Dict[str, dict] = {}
        self._allowed_roots: set = set()
        self.drives = drives.detect_json()  # Avid media/project drives (one sweep)

    # -- job helpers ---------------------------------------------------------

    def new_job(self) -> str:
        jid = str(uuid.uuid4())
        self.jobs[jid] = Job()
        return jid

    def run_async(self, jid: str, target, *args) -> None:
        job = self.jobs[jid]

        def emit(etype: str, data: dict) -> None:
            job.emit(etype, data)

        def wrap() -> None:
            try:
                target(emit, *args)
            except Exception as e:  # surface to the browser
                job.emit("failed", {"message": str(e)})
        threading.Thread(target=wrap, daemon=True).start()

    def remember_root(self, *paths: Optional[str]) -> None:
        for p in paths:
            if p:
                try:
                    self._allowed_roots.add(str(Path(p).resolve()))
                except Exception:
                    pass

    def path_allowed(self, path: str) -> bool:
        try:
            rp = str(Path(path).resolve())
        except Exception:
            return False
        return any(rp == r or rp.startswith(r + "/") or rp.startswith(r + "\\")
                   for r in self._allowed_roots)

    def serve(self) -> None:
        srv = self
        handler = _make_handler(srv)
        httpd = ThreadingHTTPServer(("0.0.0.0", self.port), handler)
        print("\nPostie Ingestor — {}".format(self.show.get("name") or self.show_code))
        print(gpu.summary())
        print("Drives: {}".format(self.drives.get("summary") or "?"))
        print("http://localhost:{}\n".format(self.port))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


def _make_handler(srv: Server):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # quiet
            pass

        # -- response helpers ------------------------------------------------

        def _json(self, obj: Any, status: int = 200) -> None:
            body = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                return {}

        # -- GET -------------------------------------------------------------

        def do_GET(self):
            u = urlparse(self.path)
            path, qs = u.path, parse_qs(u.query)

            if path == "/":
                html = (_INDEX.replace("__SHOW__", srv.show_code)
                        .replace("__PORT__", str(srv.port))
                        .replace("__ACCENT__", srv.show.get("accent_color") or "#E63946"))
                body = html.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if path == "/api/db":
                slugs = srv.supa.get_slugs(srv.show["id"])
                self._json({"slugs": slugs, "gpu": gpu.summary(), "drives": srv.drives})
                return

            if path.startswith("/api/session/"):
                sid = path.rsplit("/", 1)[-1]
                session = srv.supa.get_session_with_cards(sid)
                if not session:
                    self._json({"error": "not found"}, 404)
                else:
                    self._json(session)
                return

            if path.startswith("/api/events/"):
                self._sse(path.rsplit("/", 1)[-1])
                return

            if path == "/api/preview" or path == "/api/download":
                self._serve_file(qs.get("path", [""])[0], download=(path == "/api/download"))
                return

            self.send_error(404)

        # -- POST ------------------------------------------------------------

        def do_POST(self):
            u = urlparse(self.path)
            path = u.path
            data = self._body()

            if path == "/api/slug":
                srv.supa.add_slug(srv.show["id"], data.get("name", ""))
                self._json({"slugs": srv.supa.get_slugs(srv.show["id"])})
                return

            if path == "/api/session":
                session = srv.supa.get_or_create_session(
                    srv.show["id"], date=data["date"], output_path=data["output"],
                    backup_path=data.get("backup") or None, avid_path=data.get("avid") or None,
                    log_preset=data.get("log") or "none", fps=data.get("fps") or "25")
                srv.remember_root(session["output_path"], session.get("backup_path"),
                                  session.get("avid_path"))
                session = srv.supa.get_session_with_cards(session["id"])
                self._json({"session": session, "db": {"slugs": srv.supa.get_slugs(srv.show["id"])}})
                return

            if path == "/api/scan":
                self._start_scan(data)
                return

            if path == "/api/commit":
                self._start_commit(data)
                return

            if path == "/api/ingest":
                self._start_ingest(data)
                return

            self.send_error(404)

        # -- job launchers ---------------------------------------------------

        def _start_scan(self, data: dict):
            session = srv.supa.get_session(data["sessionId"])
            if not session:
                self._json({"error": "session not found"}, 404)
                return
            srv.remember_root(session["output_path"])
            jid = srv.new_job()
            scan_id = jid
            self._json({"jobId": jid})

            def work(emit, *_):
                clips = pipeline.scan_card(
                    session, input_path=data["inputPath"], cam=data["cam"],
                    card_num=data["cardNum"], default_slug=data.get("defaultSlug"), emit=emit)
                srv.scans[scan_id] = {"clips": clips}
                emit("done", {"count": len(clips)})
            srv.run_async(jid, work)

        def _start_commit(self, data: dict):
            session = srv.supa.get_session(data["sessionId"])
            if not session:
                self._json({"error": "session not found"}, 404)
                return
            srv.remember_root(session.get("backup_path"))
            jid = srv.new_job()
            self._json({"jobId": jid})

            def work(emit, *_):
                pipeline.commit_card(
                    srv.supa, session, input_path=data["inputPath"], cam=data["cam"],
                    card_num=data["cardNum"], clips=data["clips"],
                    slug_assignments=data.get("slugAssignments") or {}, emit=emit)
                emit("done", {})
            srv.run_async(jid, work)

        def _start_ingest(self, data: dict):
            session = srv.supa.get_session(data["sessionId"])
            if not session:
                self._json({"error": "session not found"}, 404)
                return
            srv.remember_root(session["output_path"], session.get("avid_path"))
            jid = srv.new_job()
            self._json({"jobId": jid})

            def work(emit, *_):
                pipeline.run_ingest(srv.supa, data["sessionId"], emit=emit)
            srv.run_async(jid, work)

        # -- SSE -------------------------------------------------------------

        def _sse(self, jid: str):
            job = srv.jobs.get(jid)
            if not job:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            idx = 0
            try:
                while True:
                    with job.cond:
                        while idx >= len(job.events) and not job.finished:
                            job.cond.wait(timeout=30)
                        pending = job.events[idx:]
                        idx = len(job.events)
                        done = job.finished and idx >= len(job.events)
                    for ev in pending:
                        line = "event: {}\ndata: {}\n\n".format(ev["type"], json.dumps(ev["data"]))
                        self.wfile.write(line.encode("utf-8"))
                        self.wfile.flush()
                    if done:
                        break
            except (BrokenPipeError, ConnectionResetError):
                pass

        # -- file serving ----------------------------------------------------

        def _serve_file(self, fpath: str, download: bool):
            if not fpath or not srv.path_allowed(fpath):
                self.send_error(403)
                return
            p = Path(fpath)
            if not p.exists() or not p.is_file():
                self.send_error(404)
                return
            data = p.read_bytes()
            self.send_response(200)
            if download:
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition", 'attachment; filename="{}"'.format(p.name))
            else:
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Cache-Control", "max-age=3600")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler
