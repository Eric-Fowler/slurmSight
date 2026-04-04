# slurmSight — Mission Control 🚀

A real-time, browser-based Slurm job dashboard with animated queue monitoring, FairShare analysis, GPU/CPU node status, job history, and an all-users queue view.

---

## Quick Start

```bash
python3 server.py
# open http://localhost:8787
```

No dependencies beyond Python 3.9+ standard library. Slurm is optional — the UI works in **Demo mode** without it.

---

## File Structure

| File | Purpose |
|------|---------|
| `server.py` | Python HTTP backend — proxies Slurm commands, optional auth/TLS/metrics |
| `index.html` | Thin HTML shell |
| `style.css` | All styles (dark/light theme, mobile layout) |
| `app.js` | All frontend logic |
| `config.json.example` | Annotated example configuration |
| `tests/test_server.py` | Python unittest suite (24 tests) |

---

## Configuration

Copy `config.json.example` to `config.json` in the same directory as `server.py`:

```json
{
  "port": 8787,
  "auth_token": "change-me",
  "enable_submit": false,
  "enable_metrics": false,
  "enable_all_users": false
}
```

All keys are optional — defaults are used if the file is absent.

### Environment variables (override config.json)

| Variable | Purpose |
|----------|---------|
| `SLURMSIGHT_PORT` | Listening port |
| `SLURMSIGHT_AUTH_TOKEN` | Bearer auth token |
| `SLURMSIGHT_SSL_CERT` | Path to TLS certificate PEM |
| `SLURMSIGHT_SSL_KEY` | Path to TLS private key PEM |
| `SLURMSIGHT_ALL_USERS` | `1` to enable all-users queue |
| `SLURMSIGHT_ENABLE_SUBMIT` | `1` to enable job submission |
| `SLURMSIGHT_ENABLE_METRICS` | `1` to enable SQLite metrics |

---

## Features

### Queue panel
- Live `squeue --me` with auto-refresh (configurable 2–60 s)
- Sort by any column; per-column visibility toggle (persisted)
- Substring + `/regex/` search filter
- CSV / JSON export
- Row click → job detail modal with dependency display
- Mobile card view on narrow screens

### FairShare panel
- `sshare -U` rendered as account cards with progress bars
- Sortable by fairshare, usage, raw shares, account name, or user count
- Live filter by account / username

### Node panels (GPU / CPU)
- Parsed from `scontrol show node`
- Per-GPU-model and per-CPU-arch breakdown chips
- Tracks active / idle / offline counts

### History panel
- `sacct` last 24 h, searchable, sortable, exportable

### All-users panel
- Hierarchical by user → job name → individual jobs
- Partition filter chips + user/job search
- Requires `enable_all_users: true` in server config

### Job submission panel
- `sbatch` via web form (partition, cores, walltime, mem, name)
- Requires `enable_submit: true` in server config

### Metrics panel
- Canvas sparkline chart of running / pending / total queue depth over time
- Stored in SQLite (`metrics_db` path), polled every `metrics_interval` seconds
- Requires `enable_metrics: true` in server config

### Notifications
- In-browser toast + optional sound on every state change
- Desktop notifications via Browser Notification API (opt-in)
- Optional webhook POST on RUNNING / COMPLETED / FAILED / CANCELLED / TIMEOUT

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `r` | Refresh queue now |
| `1`–`9` | Switch to tab by position |
| `/` | Focus queue search |
| `n` | Request notification permission |
| `Esc` | Close modal / dropdowns |

### Theme
Click ☀️/🌙 in the header or set `slurmSight_theme = 'light'` in localStorage.

---

## HTTPS / TLS

```json
{ "ssl_cert": "/etc/ssl/certs/server.crt", "ssl_key": "/etc/ssl/private/server.key" }
```

---

## Running tests

```bash
python3 -m unittest tests.test_server -v
```

---

## Security notes

- Set a strong `auth_token` when exposing the server beyond localhost.
- `enable_all_users` exposes every user's job data — use only on trusted networks.
- `enable_submit` allows arbitrary `sbatch` calls — restrict accordingly.
- Rate limiting on `scancel` is enforced per IP (`rate_limit_scancel`, default 10/min).
