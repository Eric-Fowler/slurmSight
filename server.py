#!/usr/bin/env python3
"""
slurmSight server — proxies Slurm commands to the web UI.

Usage:  python3 server.py [port]   (default port: 8787)
        python3 server.py --config=config.json

Config file (config.json) keys (all optional):
  port                int     Listening port (default 8787)
  auth_token          str     Bearer token required on all API calls; "" = disabled
  ssl_cert            str     Path to PEM certificate for HTTPS; "" = HTTP only
  ssl_key             str     Path to PEM private key for HTTPS
  enable_all_users    bool    Enable /api/squeueall (default false)
  enable_submit       bool    Enable /api/sbatch job submission (default false)
  enable_metrics      bool    Enable /api/metrics SQLite time-series (default false)
  metrics_db          str     Path to SQLite DB file (default "metrics.db")
  metrics_interval    int     Seconds between metric snapshots (default 60)
  rate_limit_scancel  int     Max scancel calls per IP per minute (default 10)
"""

import http.server
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from collections import defaultdict
from urllib.parse import urlparse

# ──────────────────────────────────────────────────────────────
# Defaults
# ──────────────────────────────────────────────────────────────
DEFAULTS = {
    "port": 8787,
    "auth_token": "",
    "ssl_cert": "",
    "ssl_key": "",
    "enable_all_users": False,
    "enable_submit": False,
    "enable_metrics": False,
    "metrics_db": "metrics.db",
    "metrics_interval": 60,
    "rate_limit_scancel": 10,
}


def _find_config_path():
    for i, arg in enumerate(sys.argv[1:], 1):
        if arg.startswith("--config="):
            return arg.split("=", 1)[1]
        if arg == "--config" and i < len(sys.argv) - 1:
            return sys.argv[i + 1]
    return None


def load_config(path=None):
    cfg = dict(DEFAULTS)
    script_dir = os.path.dirname(os.path.abspath(__file__))

    # 1. Config file
    if path is None:
        path = os.path.join(script_dir, "config.json")
    if os.path.isfile(path):
        try:
            with open(path) as f:
                file_cfg = json.load(f)
            for k, v in file_cfg.items():
                if k in cfg:
                    cfg[k] = v
        except Exception as e:
            print(f"Warning: could not read config file {path!r}: {e}", file=sys.stderr)

    # 2. Environment variable overrides
    env_map = {
        "SLURMSIGHT_PORT":           ("port",             int),
        "SLURMSIGHT_AUTH_TOKEN":     ("auth_token",       str),
        "SLURMSIGHT_SSL_CERT":       ("ssl_cert",         str),
        "SLURMSIGHT_SSL_KEY":        ("ssl_key",          str),
        "SLURMSIGHT_ALL_USERS":      ("enable_all_users", lambda v: v.strip().lower() in ("1","true","yes")),
        "SLURMSIGHT_ENABLE_SUBMIT":  ("enable_submit",    lambda v: v.strip().lower() in ("1","true","yes")),
        "SLURMSIGHT_ENABLE_METRICS": ("enable_metrics",   lambda v: v.strip().lower() in ("1","true","yes")),
    }
    for env_key, (cfg_key, cast) in env_map.items():
        val = os.environ.get(env_key)
        if val is not None:
            try:
                cfg[cfg_key] = cast(val)
            except Exception:
                pass

    # 3. CLI — bare positional integer = port (legacy compat)
    for arg in sys.argv[1:]:
        if arg.startswith("--"):
            continue
        try:
            cfg["port"] = int(arg)
        except ValueError:
            pass

    return cfg


CONFIG = load_config(_find_config_path())
PORT = CONFIG["port"]
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

if not (1 <= PORT <= 65535):
    print(f"Invalid port: {PORT}", file=sys.stderr)
    sys.exit(1)

# ──────────────────────────────────────────────────────────────
# Slurm availability check at startup
# ──────────────────────────────────────────────────────────────
SLURM_AVAILABLE = False


def check_slurm():
    global SLURM_AVAILABLE
    try:
        r = subprocess.run(["squeue", "--version"], capture_output=True, timeout=5)
        SLURM_AVAILABLE = r.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        SLURM_AVAILABLE = False
    if not SLURM_AVAILABLE:
        print("⚠  Warning: Slurm commands not found in PATH — live mode will return errors.",
              file=sys.stderr)


check_slurm()

# ──────────────────────────────────────────────────────────────
# Rate limiter
# ──────────────────────────────────────────────────────────────
_rate_lock = threading.Lock()
_rate_buckets: dict = defaultdict(list)  # ip -> list[monotonic timestamp]


def is_rate_limited(ip: str, limit: int, window: int = 60) -> bool:
    """Return True if this IP has exceeded `limit` calls within `window` seconds."""
    if limit <= 0:
        return False
    now = time.monotonic()
    with _rate_lock:
        _rate_buckets[ip] = [t for t in _rate_buckets[ip] if now - t < window]
        if len(_rate_buckets[ip]) >= limit:
            return True
        _rate_buckets[ip].append(now)
        return False


# ──────────────────────────────────────────────────────────────
# SQLite metrics store
# ──────────────────────────────────────────────────────────────
_metrics_conn = None
_metrics_lock = threading.Lock()


def init_metrics_db():
    global _metrics_conn
    db_path = CONFIG["metrics_db"]
    if not os.path.isabs(db_path):
        db_path = os.path.join(SCRIPT_DIR, db_path)
    _metrics_conn = sqlite3.connect(db_path, check_same_thread=False)
    with _metrics_conn:
        _metrics_conn.execute("""
            CREATE TABLE IF NOT EXISTS queue_snapshots (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ts      INTEGER NOT NULL,
                running INTEGER NOT NULL DEFAULT 0,
                pending INTEGER NOT NULL DEFAULT 0,
                other   INTEGER NOT NULL DEFAULT 0,
                total   INTEGER NOT NULL DEFAULT 0
            )
        """)
    print(f"📊  Metrics DB: {db_path}")


def record_snapshot(running: int, pending: int, other: int, total: int):
    if _metrics_conn is None:
        return
    with _metrics_lock:
        with _metrics_conn:
            _metrics_conn.execute(
                "INSERT INTO queue_snapshots (ts, running, pending, other, total) VALUES (?,?,?,?,?)",
                (int(time.time()), running, pending, other, total),
            )


def get_snapshots(limit: int = 1440) -> list:
    if _metrics_conn is None:
        return []
    with _metrics_lock:
        cur = _metrics_conn.execute(
            "SELECT ts, running, pending, other, total "
            "FROM queue_snapshots ORDER BY ts DESC LIMIT ?",
            (limit,),
        )
        rows = cur.fetchall()
    return [{"ts": r[0], "running": r[1], "pending": r[2], "other": r[3], "total": r[4]}
            for r in reversed(rows)]


def _metrics_poller():
    interval = max(10, int(CONFIG["metrics_interval"]))
    while True:
        time.sleep(interval)
        result = run_slurm(["squeue", "--me", "--noheader", "--format=%T"], timeout=20)
        if result["ok"]:
            states = [line.strip() for line in result["out"].splitlines() if line.strip()]
            running = sum(1 for s in states if s == "RUNNING")
            pending = sum(1 for s in states if s == "PENDING")
            other   = len(states) - running - pending
            record_snapshot(running, pending, other, len(states))


if CONFIG["enable_metrics"]:
    init_metrics_db()
    threading.Thread(target=_metrics_poller, daemon=True, name="metrics-poller").start()

# ──────────────────────────────────────────────────────────────
# Slurm command helpers
# ──────────────────────────────────────────────────────────────
def run_slurm(cmd, timeout=20):
    """Run a Slurm command and return a structured result dict."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {"ok": r.returncode == 0, "out": r.stdout, "err": r.stderr}
    except FileNotFoundError:
        return {"ok": False, "out": "", "err": f"Command not found: {cmd[0]}. Is Slurm installed?"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "out": "", "err": f"Command timed out after {timeout}s"}
    except Exception as exc:
        return {"ok": False, "out": "", "err": str(exc)}


ROUTES = {
    "/api/squeue": lambda: run_slurm([
        "squeue", "--me", "--noheader",
        "--format=%i\t%j\t%P\t%T\t%M\t%l\t%D\t%C\t%m\t%N\t%r\t%Q\t%E\t%S",
    ]),
    "/api/sshare":   lambda: run_slurm(["sshare", "-U"]),
    "/api/sinfo":    lambda: run_slurm([
        "sinfo", "--noheader",
        "--format=%P\t%a\t%l\t%D\t%T\t%N\t%C\t%G",
    ]),
    "/api/sacct":    lambda: run_slurm([
        "sacct", "--noheader", "--parsable2",
        "--starttime=now-24hours",
        "--format=JobID,JobName,State,Elapsed,TotalCPU,MaxRSS,Partition,NodeList,Start,End,ExitCode",
    ]),
    "/api/sdiag":    lambda: run_slurm(["sdiag"]),
    "/api/gpunodes": lambda: run_slurm(["scontrol", "show", "node", "-o"]),
    "/api/slurm_status": lambda: {"ok": True, "available": SLURM_AVAILABLE},
}


def cancel_job(jobid):
    return run_slurm(["scancel", str(jobid)], timeout=10)


def submit_job(params: dict):
    script = params.get("script", "").strip()
    if not script:
        return {"ok": False, "err": "Missing script path"}
    cmd = ["sbatch"]
    if params.get("partition"):
        cmd += ["-p", str(params["partition"])]
    if params.get("cores"):
        try:
            cmd += ["-n", str(int(params["cores"]))]
        except (ValueError, TypeError):
            pass
    if params.get("walltime"):
        cmd += ["-t", str(params["walltime"])]
    if params.get("mem"):
        cmd += ["--mem", str(params["mem"])]
    if params.get("name"):
        cmd += ["-J", str(params["name"])]
    cmd.append(script)
    return run_slurm(cmd, timeout=30)


# ──────────────────────────────────────────────────────────────
# Static files
# ──────────────────────────────────────────────────────────────
STATIC_FILES = {
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js":    ("app.js",    "application/javascript; charset=utf-8"),
}


# ──────────────────────────────────────────────────────────────
# HTTP handler
# ──────────────────────────────────────────────────────────────
class SlurmSightHandler(http.server.BaseHTTPRequestHandler):

    def _client_ip(self):
        return self.client_address[0]

    def _send_json(self, data, status=200, allow_origin="*"):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", allow_origin)
        self.end_headers()
        self.wfile.write(body)

    def _localhost_origin(self):
        origin = self.headers.get("Origin", "")
        try:
            if urlparse(origin).hostname in {"localhost", "127.0.0.1", "::1"}:
                return origin
        except Exception:
            pass
        return "null"

    def _check_auth(self) -> bool:
        token = CONFIG["auth_token"]
        if not token:
            return True
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Bearer ") and auth_header[7:] == token:
            return True
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        # Frontend
        if path in ("/", "/index.html"):
            self._serve_file("index.html", "text/html; charset=utf-8")
            return

        # Static assets (no auth required)
        if path in STATIC_FILES:
            fname, mime = STATIC_FILES[path]
            self._serve_file(fname, mime)
            return

        # API — require auth
        if not self._check_auth():
            self._send_json({"ok": False, "err": "Unauthorized"}, 401)
            return

        if path in ROUTES:
            self._send_json(ROUTES[path]())

        elif path == "/api/squeueall":
            if not CONFIG["enable_all_users"]:
                self._send_json(
                    {"ok": False, "err": "All-users queue view is disabled. "
                     "Set enable_all_users=true in config.json or SLURMSIGHT_ALL_USERS=1."},
                    status=403,
                    allow_origin=self._localhost_origin(),
                )
                return
            result = run_slurm([
                "squeue", "--all", "--noheader",
                "--format=%i\t%j\t%P\t%T\t%M\t%l\t%D\t%C\t%m\t%N\t%r\t%Q\t%E\t%S\t%u",
            ], timeout=60)
            self._send_json(result, allow_origin=self._localhost_origin())

        elif path == "/api/metrics":
            if not CONFIG["enable_metrics"]:
                self._send_json(
                    {"ok": False, "err": "Metrics not enabled. Set enable_metrics=true in config.json."},
                    404,
                )
                return
            self._send_json({"ok": True, "data": get_snapshots()})

        elif path == "/api/config":
            self._send_json({"ok": True, "config": {
                "enable_submit":    CONFIG["enable_submit"],
                "enable_metrics":   CONFIG["enable_metrics"],
                "enable_all_users": CONFIG["enable_all_users"],
                "slurm_available":  SLURM_AVAILABLE,
            }})

        else:
            self._send_json({"ok": False, "err": "Not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path

        if not self._check_auth():
            self._send_json({"ok": False, "err": "Unauthorized"}, 401)
            return

        if path == "/api/scancel":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_len).decode("utf-8")
                data = json.loads(body)
                jobid = str(data.get("jobid", "")).strip()
                if not jobid:
                    self._send_json({"ok": False, "err": "Missing jobid"}, 400)
                    return
                if is_rate_limited(self._client_ip(), CONFIG["rate_limit_scancel"]):
                    self._send_json(
                        {"ok": False, "err": "Rate limit exceeded — too many cancel requests"}, 429
                    )
                    return
                self._send_json(cancel_job(jobid))
            except Exception as e:
                self._send_json({"ok": False, "err": str(e)}, 400)

        elif path == "/api/sbatch":
            if not CONFIG["enable_submit"]:
                self._send_json(
                    {"ok": False, "err": "Job submission is disabled. "
                     "Set enable_submit=true in config.json."}, 403
                )
                return
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_len).decode("utf-8")
                params = json.loads(body)
                self._send_json(submit_job(params))
            except Exception as e:
                self._send_json({"ok": False, "err": str(e)}, 400)

        else:
            self._send_json({"error": "Not found"}, 404)

    def _serve_file(self, filename, content_type):
        fp = os.path.join(SCRIPT_DIR, filename)
        try:
            with open(fp, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except FileNotFoundError:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass  # suppress per-request logs


class ReuseAddrHTTPServer(http.server.HTTPServer):
    allow_reuse_address = True


# ──────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import socket as _socket

    try:
        with _socket.create_connection(("127.0.0.1", PORT), timeout=1):
            subprocess.run(["fuser", "-k", f"{PORT}/tcp"], capture_output=True, timeout=5)
            time.sleep(0.5)
    except (ConnectionRefusedError, OSError):
        pass

    srv = ReuseAddrHTTPServer(("", PORT), SlurmSightHandler)

    ssl_cert = CONFIG["ssl_cert"]
    ssl_key  = CONFIG["ssl_key"]
    protocol = "http"
    if ssl_cert and ssl_key:
        try:
            import ssl as _ssl
            ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(ssl_cert, ssl_key)
            srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
            protocol = "https"
        except Exception as e:
            print(f"⚠  TLS setup failed: {e} — falling back to HTTP", file=sys.stderr)

    auth_note = "  (auth token enabled)" if CONFIG["auth_token"] else ""
    print(f"✨  slurmSight  →  {protocol}://localhost:{PORT}{auth_note}")
    if CONFIG["enable_submit"]:
        print("    Job submission: ENABLED")
    if CONFIG["enable_metrics"]:
        print(f"    Metrics:        ENABLED  ({CONFIG['metrics_db']})")
    if not SLURM_AVAILABLE:
        print("    Slurm:          NOT FOUND in PATH")
    print("    Press Ctrl+C to stop\n")

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n👋  Shutting down…")
    finally:
        srv.shutdown()
        srv.server_close()
        print("👋  Server stopped.")
