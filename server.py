#!/usr/bin/env python3
"""
slurmSight server — proxies Slurm commands to the web UI.

Usage:  python3 server.py [port]   (default port: 8787)
Then open: http://localhost:8787
"""

import http.server
import json
import os
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
    "/api/sshare": lambda: run_slurm(["sshare", "-a"]),
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
}


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
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
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

    def log_message(self, fmt, *args):  # suppress default per-request logging; startup messages are printed below
        pass


if __name__ == "__main__":
    srv = http.server.HTTPServer(("", PORT), SlurmSightHandler)
    print(f"✨  slurmSight  →  http://localhost:{PORT}")
    print("    Press Ctrl+C to stop\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n👋  Server stopped.")
