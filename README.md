# 🚀 slurmSight — Mission Control

> More exciting than just doing `squeue --me` every 5 seconds.

A single-file animated web dashboard for monitoring Slurm HPC jobs.

![slurmSight screenshot](https://github.com/Eric-Fowler/slurmSight/raw/main/screenshot.png)

## Features

- **Auto-refreshing job queue** — watches `squeue --me` every N seconds (configurable)
- **Live job change detection** — animated alerts when jobs start, complete, fail, or time out
- **Particle burst effects** — visual celebration / alarm on job events
- **Rotating neon border** + **scanner wave** flowing through the job table
- **FairShare view** — `sshare -a` output
- **Node status view** — `sinfo` with colour-coded node states
- **24 h Job history** — `sacct` for the last day
- **Demo mode** — runs entirely in the browser; no Slurm installation required
- **Configurable** — refresh interval, server URL, animation toggle

## Quick start

### Option A — Demo mode (no Slurm needed)

Just open `index.html` in a browser. It runs in demo mode by default, simulating
jobs appearing, starting, completing, and failing.

### Option B — Live mode (real Slurm cluster)

1. Copy `index.html` and `server.py` to your login node (or any node that can run
   Slurm commands).
2. Start the backend:

   ```bash
   python3 server.py          # listens on port 8787 by default
   python3 server.py 9000     # custom port
   ```

3. Open `http://localhost:8787` in a browser (or SSH-tunnel the port to your
   laptop).

4. In the **CONFIG** tab, switch from **DEMO** → **LIVE** and click **SAVE
   SETTINGS**.

## File overview

| File | Purpose |
|------|---------|
| `index.html` | Self-contained single-page UI (all CSS & JS inline) |
| `server.py` | Lightweight Python 3 HTTP server; proxies Slurm commands |

## Requirements

- **Browser**: any modern browser (Chrome, Firefox, Edge, Safari)
- **Backend**: Python 3.6+ (standard library only — no pip installs needed)
- **Slurm**: only required for live mode; demo mode works offline
