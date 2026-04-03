#!/usr/bin/env python3
"""
slurmSight server — proxies Slurm commands to the web UI.

Usage:  python3 server.py [port]   (default port: 8787)
Then open: http://localhost:8787
"""

import http.server
import json
import os
import signal
import socket
import subprocess
import sys
from urllib.parse import urlparse

try:
    PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
except ValueError:
    print(f"Invalid port number: {sys.argv[1]!r}\nUsage: python3 server.py [port]", file=sys.stderr)
    sys.exit(1)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


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
        "--format=%i\t%j\t%P\t%T\t%M\t%l\t%D\t%C\t%m\t%N\t%r\t%Q\t%S",
    ]),
    "/api/squeueall": lambda: run_slurm([
        "squeue", "--all", "--noheader",
        "--format=%i\t%j\t%P\t%T\t%M\t%l\t%D\t%C\t%m\t%N\t%r\t%Q\t%S\t%u",
    ], timeout=60),
    "/api/sshare": lambda: run_slurm(["sshare", "-U"]),
    "/api/sinfo": lambda: run_slurm([
        "sinfo", "--noheader",
        "--format=%P\t%a\t%l\t%D\t%T\t%N\t%C\t%G",
    ]),
    "/api/sacct": lambda: run_slurm([
        "sacct", "--noheader", "--parsable2",
        "--starttime=now-24hours",
        "--format=JobID,JobName,State,Elapsed,TotalCPU,MaxRSS,Partition,NodeList,Start,End,ExitCode",
    ]),
    "/api/sdiag": lambda: run_slurm(["sdiag"]),
    "/api/gpunodes": lambda: run_slurm(["scontrol", "show", "node", "-o"]),
}

def cancel_job(jobid):
    """Cancel a Slurm job by ID."""
    return run_slurm(["scancel", str(jobid)], timeout=10)


class SlurmSightHandler(http.server.BaseHTTPRequestHandler):

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        # Serve the frontend
        if path in ("/", "/index.html"):
            fp = os.path.join(SCRIPT_DIR, "index.html")
            try:
                with open(fp, "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
            return

        if path in ROUTES:
            self._send_json(ROUTES[path]())
        else:
            self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/scancel":
            # Parse JSON body
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_len).decode("utf-8")
                data = json.loads(body)
                jobid = data.get("jobid")
                if not jobid:
                    self._send_json({"ok": False, "err": "Missing jobid"}, 400)
                else:
                    result = cancel_job(jobid)
                    self._send_json(result)
            except Exception as e:
                self._send_json({"ok": False, "err": str(e)}, 400)
        else:
            self._send_json({"error": "Not found"}, 404)

    def log_message(self, fmt, *args):  # suppress default per-request logging; startup messages are printed below
        pass


class ReuseAddrHTTPServer(http.server.HTTPServer):
    """HTTPServer with SO_REUSEADDR so the port is freed immediately on stop."""
    allow_reuse_address = True


if __name__ == "__main__":
    # Kill any stale process already bound to the port
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=1):
            result = subprocess.run(
                ["fuser", "-k", f"{PORT}/tcp"],
                capture_output=True, timeout=5,
            )
            import time; time.sleep(0.5)  # give the OS a moment to release the port
    except (ConnectionRefusedError, OSError):
        pass  # port already free

    srv = ReuseAddrHTTPServer(("", PORT), SlurmSightHandler)
    print(f"✨  slurmSight  →  http://localhost:{PORT}")
    print("    Press Ctrl+C to stop\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n👋  Shutting down…")
    finally:
        srv.shutdown()
        srv.server_close()
        print("👋  Server stopped.")
