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
    enable_runs_browser bool    Enable /api/runs/* browse+viewer endpoints (default true)
    scratch_root        str     Root path for run browsing (default "/storage/home/hcoda1/5/efowler34/scratch")
  metrics_db          str     Path to SQLite DB file (default "metrics.db")
  metrics_interval    int     Seconds between metric snapshots (default 60)
  rate_limit_scancel  int     Max scancel calls per IP per minute (default 10)
"""

import http.server
import json
import mimetypes
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from collections import defaultdict
from urllib.parse import parse_qs, unquote, urlparse

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
    "enable_runs_browser": True,
    "scratch_root": "/storage/home/hcoda1/5/efowler34/scratch",
    "metrics_db": "metrics.db",
    "metrics_interval": 60,
    "rate_limit_scancel": 10,
}

TEXT_EXTENSIONS = {
    ".txt", ".log", ".out", ".err", ".json", ".yaml", ".yml", ".csv", ".tsv", ".md", ".sh", ".slurm"
}
MAX_TEXT_PREVIEW_BYTES = 512 * 1024
MAX_JOB_OUTPUT_PREVIEW_BYTES = 64 * 1024


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
        "SLURMSIGHT_ENABLE_RUNS":    ("enable_runs_browser", lambda v: v.strip().lower() in ("1","true","yes")),
        "SLURMSIGHT_SCRATCH_ROOT":   ("scratch_root",     str),
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
CONFIG_PATH = _find_config_path() or os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
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
        _metrics_conn.execute("""
            CREATE TABLE IF NOT EXISTS queue_partition_snapshots (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                ts        INTEGER NOT NULL,
                partition TEXT NOT NULL,
                running   INTEGER NOT NULL DEFAULT 0,
                pending   INTEGER NOT NULL DEFAULT 0,
                other     INTEGER NOT NULL DEFAULT 0,
                total     INTEGER NOT NULL DEFAULT 0
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


def record_partition_snapshots(partitions: dict):
    if _metrics_conn is None or not partitions:
        return
    ts = int(time.time())
    rows = [
        (ts, partition, values.get("running", 0), values.get("pending", 0), values.get("other", 0), values.get("total", 0))
        for partition, values in partitions.items()
    ]
    with _metrics_lock:
        with _metrics_conn:
            _metrics_conn.executemany(
                "INSERT INTO queue_partition_snapshots (ts, partition, running, pending, other, total) VALUES (?,?,?,?,?,?)",
                rows,
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


def get_partition_snapshots(limit: int = 5000) -> dict:
    if _metrics_conn is None:
        return {}
    with _metrics_lock:
        cur = _metrics_conn.execute(
            "SELECT ts, partition, running, pending, other, total "
            "FROM queue_partition_snapshots ORDER BY ts DESC LIMIT ?",
            (limit,),
        )
        rows = cur.fetchall()
    grouped = defaultdict(list)
    for ts, partition, running, pending, other, total in reversed(rows):
        grouped[partition].append({
            "ts": ts,
            "running": running,
            "pending": pending,
            "other": other,
            "total": total,
        })
    return dict(grouped)


def _metrics_poller():
    interval = max(10, int(CONFIG["metrics_interval"]))
    while True:
        time.sleep(interval)
        result = run_slurm(["squeue", "--me", "--noheader", "--format=%P\t%T"], timeout=20)
        if result["ok"]:
            partition_counts = defaultdict(lambda: {"running": 0, "pending": 0, "other": 0, "total": 0})
            running = pending = other = total = 0
            for line in result["out"].splitlines():
                if not line.strip():
                    continue
                part, state = (line.split("\t", 1) + [""])[:2]
                part = (part or "unknown").strip()
                state = (state or "").strip()
                bucket = partition_counts[part]
                bucket["total"] += 1
                total += 1
                if state == "RUNNING":
                    bucket["running"] += 1
                    running += 1
                elif state == "PENDING":
                    bucket["pending"] += 1
                    pending += 1
                else:
                    bucket["other"] += 1
                    other += 1
            record_snapshot(running, pending, other, total)
            record_partition_snapshots(partition_counts)


if CONFIG["enable_metrics"]:
    init_metrics_db()
    threading.Thread(target=_metrics_poller, daemon=True, name="metrics-poller").start()


def get_editable_config() -> dict:
    data = {}
    if os.path.isfile(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    data = loaded
        except Exception:
            data = {}
    result = {}
    for key, default in DEFAULTS.items():
        result[key] = data.get(key, CONFIG.get(key, default))
    return result


def _cast_config_value(key: str, value):
    if key not in DEFAULTS:
        raise ValueError(f"Unsupported config key: {key}")
    default = DEFAULTS[key]
    if isinstance(default, bool):
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            lv = value.strip().lower()
            if lv in {"1", "true", "yes", "on"}:
                return True
            if lv in {"0", "false", "no", "off"}:
                return False
        raise ValueError(f"Config key {key} must be boolean")
    if isinstance(default, int):
        try:
            return int(value)
        except Exception as e:
            raise ValueError(f"Config key {key} must be integer") from e
    return str(value)


def write_editable_config(new_config: dict) -> dict:
    if not isinstance(new_config, dict):
        return {"ok": False, "err": "config must be a JSON object"}

    normalized = {}
    for key in DEFAULTS:
        source_val = new_config.get(key, CONFIG.get(key, DEFAULTS[key]))
        try:
            normalized[key] = _cast_config_value(key, source_val)
        except ValueError as e:
            return {"ok": False, "err": str(e)}

    if not (1 <= int(normalized["port"]) <= 65535):
        return {"ok": False, "err": "port must be between 1 and 65535"}
    if int(normalized["metrics_interval"]) < 10:
        return {"ok": False, "err": "metrics_interval must be at least 10 seconds"}
    if int(normalized["rate_limit_scancel"]) < 0:
        return {"ok": False, "err": "rate_limit_scancel must be >= 0"}

    os.makedirs(os.path.dirname(os.path.abspath(CONFIG_PATH)), exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(normalized, f, indent=2, sort_keys=True)
        f.write("\n")

    return {
        "ok": True,
        "path": CONFIG_PATH,
        "config": normalized,
        "restart_required": True,
        "note": "Config file saved. Restart server.py to apply all changes.",
    }

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


def _is_truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def get_scratch_root() -> str:
    root = str(CONFIG.get("scratch_root") or DEFAULTS["scratch_root"]).strip()
    if not os.path.isabs(root):
        root = os.path.join(SCRIPT_DIR, root)
    return os.path.normpath(root)


def _safe_path_under_scratch(*parts):
    root = get_scratch_root()
    candidate = os.path.normpath(os.path.join(root, *parts))
    try:
        if os.path.commonpath([root, candidate]) != root:
            return None
    except ValueError:
        return None
    return candidate


def _list_subdirs(path: str) -> list:
    try:
        with os.scandir(path) as entries:
            return sorted(
                [e.name for e in entries if e.is_dir(follow_symlinks=False) and not e.name.startswith(".")],
                reverse=True,
            )
    except FileNotFoundError:
        return []


def _list_html_files(path: str) -> list:
    try:
        with os.scandir(path) as entries:
            return sorted(
                [e.name for e in entries if e.is_file(follow_symlinks=False)
                 and e.name.lower().endswith((".html", ".htm"))],
            )
    except FileNotFoundError:
        return []


def _list_text_files(path: str) -> list:
    try:
        with os.scandir(path) as entries:
            files = []
            for e in entries:
                if not e.is_file(follow_symlinks=False):
                    continue
                _, ext = os.path.splitext(e.name.lower())
                if ext in TEXT_EXTENSIONS:
                    files.append(e.name)
            return sorted(files)
    except FileNotFoundError:
        return []


def _list_asset_files(path: str) -> list:
    try:
        with os.scandir(path) as entries:
            return sorted([e.name for e in entries if e.is_file(follow_symlinks=False)])
    except FileNotFoundError:
        return []


def _read_json_file(path: str):
    try:
        if os.path.getsize(path) > 2 * 1024 * 1024:
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _get_run_dir(batch: str, run: str):
    if not batch or not run:
        return None
    if "/" in batch or "\\" in batch or "/" in run or "\\" in run:
        return None
    run_dir = _safe_path_under_scratch(batch, run)
    if run_dir is None or not os.path.isdir(run_dir):
        return None
    return run_dir


def _get_batch_dir(batch: str):
    if not batch or "/" in batch or "\\" in batch:
        return None
    batch_dir = _safe_path_under_scratch(batch)
    if batch_dir is None or not os.path.isdir(batch_dir):
        return None
    return batch_dir


def _build_batch_summary(batch_name: str) -> dict:
    batch_dir = _safe_path_under_scratch(batch_name)
    if batch_dir is None or not os.path.isdir(batch_dir):
        return {}

    run_names = _list_subdirs(batch_dir)
    completed = 0
    html_runs = 0
    total_html_files = 0
    latest_ts = 0

    for run_name in run_names:
        run_dir = _safe_path_under_scratch(batch_name, run_name)
        if run_dir is None or not os.path.isdir(run_dir):
            continue
        html_files = _list_html_files(run_dir)
        has_manifest = os.path.isfile(os.path.join(run_dir, "manifest.json"))
        if has_manifest:
            completed += 1
        if html_files:
            html_runs += 1
            total_html_files += len(html_files)
        try:
            latest_ts = max(latest_ts, int(os.path.getmtime(run_dir)))
        except OSError:
            pass

    if not latest_ts:
        try:
            latest_ts = int(os.path.getmtime(batch_dir))
        except OSError:
            latest_ts = 0

    return {
        "batch": batch_name,
        "run_count": len(run_names),
        "completed_count": completed,
        "html_run_count": html_runs,
        "html_file_count": total_html_files,
        "last_modified": latest_ts,
    }


def get_runs_summary() -> dict:
    root = get_scratch_root()
    if not os.path.isdir(root):
        return {
            "ok": False,
            "err": f"Scratch root not found: {root}",
            "data": [],
        }
    batches = _list_subdirs(root)
    data = [_build_batch_summary(name) for name in batches]
    data = [row for row in data if row]
    return {"ok": True, "root": root, "data": data}


def get_batch_runs(batch_name: str) -> dict:
    batch_dir = _get_batch_dir(batch_name)
    if batch_dir is None:
        return {"ok": False, "err": "Batch not found"}

    runs = []
    for run_name in _list_subdirs(batch_dir):
        run_dir = _safe_path_under_scratch(batch_name, run_name)
        if run_dir is None or not os.path.isdir(run_dir):
            continue
        html_files = _list_html_files(run_dir)
        text_files = _list_text_files(run_dir)
        manifest_path = os.path.join(run_dir, "manifest.json")
        config_path = os.path.join(run_dir, "run-config.json")
        run_cfg = _read_json_file(config_path) if os.path.isfile(config_path) else None

        run_id = ""
        run_label = run_name
        if isinstance(run_cfg, dict):
            run_id = str(run_cfg.get("run_id") or "")
            run_label = str(run_cfg.get("run_name") or run_name)

        try:
            mtime = int(os.path.getmtime(run_dir))
        except OSError:
            mtime = 0

        runs.append({
            "run": run_name,
            "run_id": run_id,
            "run_name": run_label,
            "has_manifest": os.path.isfile(manifest_path),
            "has_config": os.path.isfile(config_path),
            "completed": os.path.isfile(manifest_path),
            "html_files": html_files,
            "text_files": text_files,
            "text_file_count": len(text_files),
            "last_modified": mtime,
        })

    group_html = _list_html_files(batch_dir)
    group_text = _list_text_files(batch_dir)

    return {
        "ok": True,
        "batch": batch_name,
        "runs": runs,
        "group_files": {
            "html_files": group_html,
            "text_files": group_text,
            "all_files": _list_asset_files(batch_dir),
        },
    }


def get_run_metadata(batch_name: str, run_name: str) -> dict:
    run_dir = _get_run_dir(batch_name, run_name)
    if run_dir is None:
        return {"ok": False, "err": "Run not found"}

    cfg = _read_json_file(os.path.join(run_dir, "run-config.json"))
    manifest = _read_json_file(os.path.join(run_dir, "manifest.json"))
    return {
        "ok": True,
        "batch": batch_name,
        "run": run_name,
        "metadata": {
            "run_config": cfg,
            "manifest": manifest,
        },
    }


def resolve_run_html_path(batch_name: str, run_name: str, file_name: str):
    run_dir = _get_run_dir(batch_name, run_name)
    if run_dir is None:
        return None
    if not file_name or "/" in file_name or "\\" in file_name:
        return None
    if not file_name.lower().endswith((".html", ".htm")):
        return None
    fp = _safe_path_under_scratch(batch_name, run_name, file_name)
    if fp is None or not os.path.isfile(fp):
        return None
    return fp


def resolve_run_asset_path(batch_name: str, run_name: str, rel_path: str):
    run_dir = _get_run_dir(batch_name, run_name)
    if run_dir is None:
        return None
    rel_path = (rel_path or "").strip()
    if not rel_path:
        return None
    fp = os.path.normpath(os.path.join(run_dir, rel_path))
    try:
        if os.path.commonpath([run_dir, fp]) != run_dir:
            return None
    except ValueError:
        return None
    if not os.path.isfile(fp):
        return None
    return fp


def resolve_batch_asset_path(batch_name: str, rel_path: str):
    batch_dir = _get_batch_dir(batch_name)
    if batch_dir is None:
        return None
    rel_path = (rel_path or "").strip()
    if not rel_path or "/" in rel_path or "\\" in rel_path:
        return None
    fp = os.path.normpath(os.path.join(batch_dir, rel_path))
    try:
        if os.path.commonpath([batch_dir, fp]) != batch_dir:
            return None
    except ValueError:
        return None
    if not os.path.isfile(fp):
        return None
    return fp


def resolve_run_text_path(batch_name: str, run_name: str, file_name: str):
    run_dir = _get_run_dir(batch_name, run_name)
    if run_dir is None:
        return None
    if not file_name or "/" in file_name or "\\" in file_name:
        return None
    _, ext = os.path.splitext(file_name.lower())
    if ext not in TEXT_EXTENSIONS:
        return None
    fp = _safe_path_under_scratch(batch_name, run_name, file_name)
    if fp is None or not os.path.isfile(fp):
        return None
    return fp


def read_run_text_file(batch_name: str, run_name: str, file_name: str) -> dict:
    fp = resolve_run_text_path(batch_name, run_name, file_name)
    if fp is None:
        return {"ok": False, "err": "Text file not found"}

    try:
        size = os.path.getsize(fp)
        read_len = min(size, MAX_TEXT_PREVIEW_BYTES)
        with open(fp, "rb") as f:
            data = f.read(read_len)
        content = data.decode("utf-8", errors="replace")
        return {
            "ok": True,
            "file": file_name,
            "size": size,
            "truncated": size > MAX_TEXT_PREVIEW_BYTES,
            "content": content,
        }
    except OSError as e:
        return {"ok": False, "err": str(e)}


def read_batch_text_file(batch_name: str, file_name: str) -> dict:
    fp = resolve_batch_asset_path(batch_name, file_name)
    if fp is None:
        return {"ok": False, "err": "Text file not found"}
    _, ext = os.path.splitext(file_name.lower())
    if ext not in TEXT_EXTENSIONS:
        return {"ok": False, "err": "Unsupported text file type"}
    try:
        size = os.path.getsize(fp)
        read_len = min(size, MAX_TEXT_PREVIEW_BYTES)
        with open(fp, "rb") as f:
            data = f.read(read_len)
        content = data.decode("utf-8", errors="replace")
        return {
            "ok": True,
            "file": file_name,
            "size": size,
            "truncated": size > MAX_TEXT_PREVIEW_BYTES,
            "content": content,
        }
    except OSError as e:
        return {"ok": False, "err": str(e)}


def _parse_kv_tokens(line: str) -> dict:
    kv = {}
    if not line:
        return kv
    for match in re.finditer(r"(\w+)=((?:[^\s]|\\\s)+)", line):
        key = match.group(1)
        val = match.group(2).replace("\\ ", " ")
        kv[key] = val
    return kv


def _resolve_job_output_path(path: str, jobid: str, workdir: str = "") -> str:
    raw = str(path or "").strip()
    if not raw or raw == "(null)":
        return ""
    resolved = raw.replace("%j", str(jobid)).replace("%A", str(jobid)).replace("%a", "0")
    if os.path.isabs(resolved):
        return os.path.normpath(resolved)
    base = workdir.strip() if workdir else ""
    if not base:
        base = os.path.expanduser("~")
    return os.path.normpath(os.path.join(base, resolved))


def _read_file_tail(path: str, max_bytes: int = MAX_JOB_OUTPUT_PREVIEW_BYTES) -> dict:
    if not path:
        return {"exists": False, "path": "", "content": "", "truncated": False, "size": 0}
    try:
        size = os.path.getsize(path)
        read_len = min(size, max_bytes)
        with open(path, "rb") as f:
            if size > read_len:
                f.seek(-read_len, os.SEEK_END)
            data = f.read(read_len)
        return {
            "exists": True,
            "path": path,
            "content": data.decode("utf-8", errors="replace"),
            "truncated": size > read_len,
            "size": size,
        }
    except OSError as e:
        return {
            "exists": False,
            "path": path,
            "content": "",
            "truncated": False,
            "size": 0,
            "err": str(e),
        }


def get_job_output_preview(jobid: str) -> dict:
    jid = str(jobid or "").strip()
    if not jid:
        return {"ok": False, "err": "Missing jobid"}

    info = run_slurm(["scontrol", "show", "job", "-o", jid], timeout=12)
    if not info.get("ok"):
        return {"ok": False, "err": info.get("err") or "Could not inspect job metadata"}

    line = ""
    for cand in (info.get("out") or "").splitlines():
        if cand.strip():
            line = cand.strip()
            break
    if not line:
        return {"ok": False, "err": "No job metadata returned"}

    meta = _parse_kv_tokens(line)
    workdir = meta.get("WorkDir", "")
    stdout_path = _resolve_job_output_path(meta.get("StdOut", ""), jid, workdir)
    stderr_path = _resolve_job_output_path(meta.get("StdErr", ""), jid, workdir)

    stdout = _read_file_tail(stdout_path)
    stderr = _read_file_tail(stderr_path)

    return {
        "ok": True,
        "jobid": jid,
        "stdout": stdout,
        "stderr": stderr,
        "workdir": workdir,
    }


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
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

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

        elif path.startswith("/api/runs/file/"):
            if not _is_truthy(CONFIG.get("enable_runs_browser", True)):
                self._send_json({"ok": False, "err": "Runs browser is disabled"}, 403)
                return
            suffix = path[len("/api/runs/file/"):]
            parts = [unquote(p) for p in suffix.split("/") if p != ""]
            if len(parts) < 3:
                self._send_json({"ok": False, "err": "Invalid runs file path"}, 400)
                return
            batch = parts[0]
            run_name = parts[1]
            rel_path = "/".join(parts[2:])
            fp = resolve_run_asset_path(batch, run_name, rel_path)
            if fp is None:
                self._send_json({"ok": False, "err": "Run file not found"}, 404)
                return
            self._serve_binary_file(fp)

        elif path.startswith("/api/runs/batch-file/"):
            if not _is_truthy(CONFIG.get("enable_runs_browser", True)):
                self._send_json({"ok": False, "err": "Runs browser is disabled"}, 403)
                return
            suffix = path[len("/api/runs/batch-file/"):]
            parts = [unquote(p) for p in suffix.split("/") if p != ""]
            if len(parts) != 2:
                self._send_json({"ok": False, "err": "Invalid batch file path"}, 400)
                return
            batch = parts[0]
            file_name = parts[1]
            fp = resolve_batch_asset_path(batch, file_name)
            if fp is None:
                self._send_json({"ok": False, "err": "Batch file not found"}, 404)
                return
            self._serve_binary_file(fp)

        elif path == "/api/runs/summary":
            if not _is_truthy(CONFIG.get("enable_runs_browser", True)):
                self._send_json({"ok": False, "err": "Runs browser is disabled"}, 403)
                return
            result = get_runs_summary()
            status = 200 if result.get("ok") else 404
            self._send_json(result, status=status)

        elif path == "/api/runs/list":
            if not _is_truthy(CONFIG.get("enable_runs_browser", True)):
                self._send_json({"ok": False, "err": "Runs browser is disabled"}, 403)
                return
            batch = (query.get("batch") or [""])[0].strip()
            if not batch:
                self._send_json({"ok": False, "err": "Missing required query parameter: batch"}, 400)
                return
            result = get_batch_runs(batch)
            status = 200 if result.get("ok") else 404
            self._send_json(result, status=status)

        elif path == "/api/runs/meta":
            if not _is_truthy(CONFIG.get("enable_runs_browser", True)):
                self._send_json({"ok": False, "err": "Runs browser is disabled"}, 403)
                return
            batch = (query.get("batch") or [""])[0].strip()
            run_name = (query.get("run") or [""])[0].strip()
            if not batch or not run_name:
                self._send_json({"ok": False, "err": "Missing required query parameters: batch, run"}, 400)
                return
            result = get_run_metadata(batch, run_name)
            status = 200 if result.get("ok") else 404
            self._send_json(result, status=status)

        elif path == "/api/runs/view":
            if not _is_truthy(CONFIG.get("enable_runs_browser", True)):
                self._send_json({"ok": False, "err": "Runs browser is disabled"}, 403)
                return
            batch = (query.get("batch") or [""])[0].strip()
            run_name = (query.get("run") or [""])[0].strip()
            file_name = (query.get("file") or [""])[0].strip()
            if not batch or not run_name or not file_name:
                self._send_json(
                    {"ok": False, "err": "Missing required query parameters: batch, run, file"},
                    400,
                )
                return
            fp = resolve_run_html_path(batch, run_name, file_name)
            if fp is None:
                self._send_json({"ok": False, "err": "HTML file not found"}, 404)
                return
            try:
                with open(fp, "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(body)
            except OSError as e:
                self._send_json({"ok": False, "err": str(e)}, 500)

        elif path == "/api/runs/text":
            if not _is_truthy(CONFIG.get("enable_runs_browser", True)):
                self._send_json({"ok": False, "err": "Runs browser is disabled"}, 403)
                return
            batch = (query.get("batch") or [""])[0].strip()
            run_name = (query.get("run") or [""])[0].strip()
            file_name = (query.get("file") or [""])[0].strip()
            if not batch or not run_name or not file_name:
                self._send_json(
                    {"ok": False, "err": "Missing required query parameters: batch, run, file"},
                    400,
                )
                return
            result = read_run_text_file(batch, run_name, file_name)
            status = 200 if result.get("ok") else 404
            self._send_json(result, status=status)

        elif path == "/api/runs/batch-text":
            if not _is_truthy(CONFIG.get("enable_runs_browser", True)):
                self._send_json({"ok": False, "err": "Runs browser is disabled"}, 403)
                return
            batch = (query.get("batch") or [""])[0].strip()
            file_name = (query.get("file") or [""])[0].strip()
            if not batch or not file_name:
                self._send_json(
                    {"ok": False, "err": "Missing required query parameters: batch, file"},
                    400,
                )
                return
            result = read_batch_text_file(batch, file_name)
            status = 200 if result.get("ok") else 404
            self._send_json(result, status=status)

        elif path == "/api/job-output":
            jobid = (query.get("jobid") or [""])[0].strip()
            if not jobid:
                self._send_json({"ok": False, "err": "Missing required query parameter: jobid"}, 400)
                return
            result = get_job_output_preview(jobid)
            status = 200 if result.get("ok") else 404
            self._send_json(result, status=status)

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
            self._send_json({
                "ok": True,
                "data": get_snapshots(),
                "partitions": get_partition_snapshots(),
            })

        elif path == "/api/config":
            self._send_json({"ok": True, "config": {
                "enable_submit":    CONFIG["enable_submit"],
                "enable_metrics":   CONFIG["enable_metrics"],
                "enable_all_users": CONFIG["enable_all_users"],
                "enable_runs_browser": _is_truthy(CONFIG.get("enable_runs_browser", True)),
                "slurm_available":  SLURM_AVAILABLE,
            }})

        elif path == "/api/config-file":
            self._send_json({
                "ok": True,
                "path": CONFIG_PATH,
                "config": get_editable_config(),
            })

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

        elif path == "/api/config-file":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_len).decode("utf-8")
                payload = json.loads(body) if body.strip() else {}
                config_obj = payload.get("config") if isinstance(payload, dict) else None
                result = write_editable_config(config_obj)
                self._send_json(result, status=200 if result.get("ok") else 400)
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

    def _serve_binary_file(self, file_path):
        try:
            with open(file_path, "rb") as f:
                body = f.read()
            content_type, _ = mimetypes.guess_type(file_path)
            if not content_type:
                content_type = "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
        except OSError as e:
            self._send_json({"ok": False, "err": str(e)}, 500)

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
            if _is_truthy(os.environ.get("SLURMSIGHT_FORCE_KILL_PORT", "0")):
                subprocess.run(["fuser", "-k", f"{PORT}/tcp"], capture_output=True, timeout=5)
                time.sleep(0.5)
            else:
                print(
                    f"❌ Port {PORT} is already in use. Stop the existing process or rerun with "
                    "SLURMSIGHT_FORCE_KILL_PORT=1 to force-kill.",
                    file=sys.stderr,
                )
                sys.exit(2)
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
