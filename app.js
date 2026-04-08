/* ═══════════════════════════════════════════════════════
   slurmSight — Mission Control  app.js
═══════════════════════════════════════════════════════ */

// ─────────────────────────────────────────
// DOM helpers  (must come first — used at module top-level)
// ─────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─────────────────────────────────────────
// Config (persisted in localStorage)
// ─────────────────────────────────────────
const CFG_KEY = 'slurmSight_cfg';
const RUNS_MODE_KEY = 'slurmSight_runs_open_mode';
const UI_STATE_KEY = 'slurmSight_ui_state';
const SHARE_THRESH_KEY = 'slurmSight_share_thresholds';
const SUBMIT_TEMPLATES_KEY = 'slurmSight_submit_templates';
let cfg = {
  serverUrl:      'http://localhost:8787',
  refreshInterval: 5,
  demoMode:       true,
  animations:     true,
  sounds:         true,
  desktopNotif:   false,
  webhookUrl:     '',
  authToken:      '',
};
try { Object.assign(cfg, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch(_){}
// Clamp refreshInterval to a safe range to prevent divide-by-zero in updateCountdownUI
cfg.refreshInterval = Math.max(1, Math.min(3600, parseInt(cfg.refreshInterval, 10) || 5));

// ─────────────────────────────────────────
// Theme (persisted separately)
// ─────────────────────────────────────────
const THEME_KEY = 'slurmSight_theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t || '';
  const btn = $('btn-theme');
  if (btn) btn.textContent = t === 'light' ? '🌙' : '☀️';
}
applyTheme(localStorage.getItem(THEME_KEY) || '');

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? '' : 'light';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// ─────────────────────────────────────────
// Column visibility for queue table
// ─────────────────────────────────────────
const COLVIS_KEY = 'slurmSight_colvis';
const COL_NAMES  = ['JOB ID','NAME','PARTITION','STATE','ELAPSED','LIMIT','NODES','CPUS','MEM','NODELIST','REASON'];
let queueColVis = [true,true,true,true,true,true,true,true,true,true,true];
try {
  const saved = JSON.parse(localStorage.getItem(COLVIS_KEY) || 'null');
  if (Array.isArray(saved) && saved.length === queueColVis.length) queueColVis = saved;
} catch(_){}

function applyColVis() {
  const tbl = $('job-table');
  if (!tbl) return;
  for (let i = 0; i < queueColVis.length; i++) {
    tbl.classList.toggle('hide-col-' + (i + 1), !queueColVis[i]);
  }
}
applyColVis();

function saveColVis() {
  localStorage.setItem(COLVIS_KEY, JSON.stringify(queueColVis));
}

function buildColToggleMenu() {
  const menu = $('col-toggle-menu');
  if (!menu) return;
  menu.innerHTML = '';
  COL_NAMES.forEach((name, i) => {
    const item = document.createElement('div');
    item.className = 'col-toggle-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'col-cb-' + i;
    cb.checked = queueColVis[i];
    cb.addEventListener('change', () => {
      queueColVis[i] = cb.checked;
      applyColVis();
      saveColVis();
    });
    const lbl = document.createElement('label');
    lbl.htmlFor = 'col-cb-' + i;
    lbl.textContent = name;
    item.appendChild(cb);
    item.appendChild(lbl);
    menu.appendChild(item);
  });
}

// ─────────────────────────────────────────
// State
// ─────────────────────────────────────────
let prevJobs = {};
let refreshTimer = null;
let countdown = cfg.refreshInterval;
let uptimeStart = Date.now();
let connected = false;
let scanWaveFrame = null;
let queueSort    = { key: 'jobid',     direction: 'desc', type: 'number' };
let queueSearch  = '';
let infoRows     = [];
let infoSort     = { key: 'partition', direction: 'asc',  type: 'string' };
let gpuRows      = [];
let gpuSort      = { key: 'node',      direction: 'asc',  type: 'string' };
let gpuTypeFilter = 'ALL';
let cpuRows      = [];
let cpuSort      = { key: 'node',      direction: 'asc',  type: 'string' };
let cpuTypeFilter = 'ALL';
let shareRaw     = '';
let shareSort    = { key: 'fairShare', direction: 'desc' };
let shareFilter  = '';
let historyRows  = [];
let historySort  = { key: 'jobid', direction: 'desc', type: 'number' };
let historySearch = '';
let usersRows    = [];
let usersPartitionFilter = 'ALL';
let usersSearch  = '';
let usersExpanded       = {};
let usersJobNameExpanded = {};
let runsSummaryRows = [];
let runsSummarySort = { key: 'batch', direction: 'asc', type: 'string' };
let currentBatchRuns = [];
let runsSearch = '';
let selectedBatch = '';
let selectedRun = '';
let selectedRunFile = '';
let selectedTextFile = '';
let selectedGroupHtml = '';
let selectedGroupText = '';
let runsOpenMode = localStorage.getItem(RUNS_MODE_KEY) || 'embed';
let runsViewerExpanded = false;
let serverCapabilities  = { enable_submit: false, enable_metrics: false, enable_runs_browser: true };
let modalRefreshTimer = null;
let activePanel = 'queue';
let shareWarnThreshold = 0.6;
let shareCriticalThreshold = 0.3;
let submitTemplates = [];
let metricsPartition = 'ALL';
let serverConfigBaseline = '';
let serverConfigDirty = false;
let serverConfigLoadedOnce = false;
const SERVER_CONFIG_FORM_FIELDS = [
  { key: 'port', id: 'cfg-srv-port', type: 'int' },
  { key: 'metrics_interval', id: 'cfg-srv-metrics-interval', type: 'int' },
  { key: 'rate_limit_scancel', id: 'cfg-srv-rate-limit-scancel', type: 'int' },
  { key: 'scratch_root', id: 'cfg-srv-scratch-root', type: 'string' },
  { key: 'metrics_db', id: 'cfg-srv-metrics-db', type: 'string' },
  { key: 'auth_token', id: 'cfg-srv-auth-token', type: 'string' },
  { key: 'ssl_cert', id: 'cfg-srv-ssl-cert', type: 'string' },
  { key: 'ssl_key', id: 'cfg-srv-ssl-key', type: 'string' },
  { key: 'enable_all_users', id: 'cfg-srv-enable-all-users', type: 'bool' },
  { key: 'enable_submit', id: 'cfg-srv-enable-submit', type: 'bool' },
  { key: 'enable_metrics', id: 'cfg-srv-enable-metrics', type: 'bool' },
  { key: 'enable_runs_browser', id: 'cfg-srv-enable-runs-browser', type: 'bool' },
];
const SERVER_CONFIG_DEFAULTS = {
  port: 8787,
  auth_token: '',
  ssl_cert: '',
  ssl_key: '',
  enable_all_users: false,
  enable_submit: false,
  enable_metrics: false,
  enable_runs_browser: true,
  scratch_root: '/storage/home/hcoda1/5/efowler34/scratch',
  metrics_db: 'metrics.db',
  metrics_interval: 60,
  rate_limit_scancel: 10,
};
try {
  const savedThresholds = JSON.parse(localStorage.getItem(SHARE_THRESH_KEY) || '{}');
  shareWarnThreshold = Math.max(0, Math.min(1, Number(savedThresholds.warn) || shareWarnThreshold));
  shareCriticalThreshold = Math.max(0, Math.min(1, Number(savedThresholds.critical) || shareCriticalThreshold));
} catch (_) {}
try {
  const savedTemplates = JSON.parse(localStorage.getItem(SUBMIT_TEMPLATES_KEY) || '[]');
  if (Array.isArray(savedTemplates)) submitTemplates = savedTemplates;
} catch (_) {}

// ─────────────────────────────────────────
// Search filter helper
// ─────────────────────────────────────────
function buildFilter(query) {
  if (!query) return null;
  const q = query.trim();
  if (q.length > 2 && q.startsWith('/') && q.endsWith('/')) {
    try { return new RegExp(q.slice(1, -1), 'i'); } catch(_) {}
  }
  return q.toLowerCase();
}

function matchesFilter(filter, ...fields) {
  if (!filter) return true;
  if (filter instanceof RegExp) return fields.some(f => filter.test(String(f || '')));
  return fields.some(f => String(f || '').toLowerCase().includes(filter));
}

// ─────────────────────────────────────────
// Relative timestamp helper
// ─────────────────────────────────────────
function relTime(value) {
  if (!value || value === 'N/A' || value === 'Unknown' || value === '(null)') return value || 'N/A';
  const d = new Date(value);
  if (isNaN(d)) return value;
  const diffSec = Math.round((Date.now() - d) / 1000);
  if (diffSec < 0) {
    const abs = Math.abs(diffSec);
    if (abs < 60)  return 'in ' + abs + 's';
    if (abs < 3600) return 'in ' + Math.round(abs/60) + 'm';
    if (abs < 86400) return 'in ' + Math.round(abs/3600) + 'h';
    return 'in ' + Math.round(abs/86400) + 'd';
  }
  if (diffSec < 10)   return 'just now';
  if (diffSec < 60)   return diffSec + 's ago';
  if (diffSec < 3600) return Math.round(diffSec/60) + 'm ago';
  if (diffSec < 86400) return Math.round(diffSec/3600) + 'h ago';
  return Math.round(diffSec/86400) + 'd ago';
}

function formatEpoch(ts) {
  const n = Number(ts || 0);
  if (!n) return 'N/A';
  const d = new Date(n * 1000);
  if (isNaN(d)) return 'N/A';
  return d.toLocaleString();
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unknown';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `~${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `~${m}m`;
  return '<1m';
}

function computeQueueInsights(jobs) {
  const pendingByPartition = {};
  const runningByPartition = {};
  const runningRemainByPartition = {};

  for (const job of jobs) {
    const part = job.partition || 'default';
    if (job.state === 'PENDING') {
      if (!pendingByPartition[part]) pendingByPartition[part] = [];
      pendingByPartition[part].push(job);
      continue;
    }
    if (job.state === 'RUNNING') {
      runningByPartition[part] = (runningByPartition[part] || 0) + 1;
      const limitSecs = parseDurationToSeconds(job.timelimit);
      const elapsedSecs = parseDurationToSeconds(job.elapsed);
      const remain = Math.max(0, limitSecs - elapsedSecs);
      if (remain > 0) {
        if (!runningRemainByPartition[part]) runningRemainByPartition[part] = [];
        runningRemainByPartition[part].push(remain);
      }
    }
  }

  const insights = {};
  Object.entries(pendingByPartition).forEach(([part, list]) => {
    const ordered = [...list].sort((a, b) => {
      const ap = Number.parseFloat(a.priority) || 0;
      const bp = Number.parseFloat(b.priority) || 0;
      if (bp !== ap) return bp - ap;
      return String(a.jobid).localeCompare(String(b.jobid), undefined, { numeric: true });
    });
    const runCount = runningByPartition[part] || 0;
    const rems = runningRemainByPartition[part] || [];
    const avgRemain = rems.length ? rems.reduce((sum, val) => sum + val, 0) / rems.length : 0;
    ordered.forEach((job, idx) => {
      insights[job.jobid] = {
        position: idx + 1,
        etaSeconds: runCount > 0 && avgRemain > 0 ? (idx * avgRemain) / runCount : NaN,
      };
    });
  });
  return insights;
}

function summarizeQueuePartitions(jobs) {
  const byPartition = {};
  for (const job of jobs) {
    const part = String(job.partition || 'unknown');
    if (!byPartition[part]) byPartition[part] = { partition: part, running: 0, pending: 0, other: 0, total: 0 };
    byPartition[part].total += 1;
    if (job.state === 'RUNNING') byPartition[part].running += 1;
    else if (job.state === 'PENDING') byPartition[part].pending += 1;
    else byPartition[part].other += 1;
  }
  return Object.values(byPartition).sort((a, b) => b.total - a.total || a.partition.localeCompare(b.partition));
}

function renderQueuePartitions(jobs) {
  const box = $('queue-partition-strip');
  if (!box) return;
  const parts = summarizeQueuePartitions(jobs);
  if (!parts.length) {
    box.innerHTML = '<div class="partition-strip-empty">No partition activity in the current queue.</div>';
    return;
  }
  box.innerHTML = parts.map(part => `
    <div class="partition-chip">
      <div class="partition-chip-name">${esc(part.partition)}</div>
      <div class="partition-chip-stats">
        <span class="run">RUN ${esc(part.running)}</span>
        <span class="pend">PEND ${esc(part.pending)}</span>
        <span class="other">OTHER ${esc(part.other)}</span>
        <span class="total">TOTAL ${esc(part.total)}</span>
      </div>
    </div>`).join('');
}

function encodeSortState(sortState) {
  return [sortState.key || '', sortState.direction || 'asc', sortState.type || 'string'].join(':');
}

function applySortState(target, raw, fallback) {
  if (!raw) return;
  const [key, direction, type] = String(raw).split(':');
  if (!key) return;
  target.key = key;
  target.direction = direction === 'asc' ? 'asc' : 'desc';
  target.type = type || fallback.type || 'string';
}

function collectUiState() {
  return {
    activePanel,
    queueSearch,
    historySearch,
    shareFilter,
    usersSearch,
    usersPartitionFilter,
    runsSearch,
    runsOpenMode,
    selectedBatch,
    queueSort: encodeSortState(queueSort),
    historySort: encodeSortState(historySort),
    infoSort: encodeSortState(infoSort),
    gpuSort: encodeSortState(gpuSort),
    cpuSort: encodeSortState(cpuSort),
    runsSummarySort: encodeSortState(runsSummarySort),
    metricsPartition,
    shareSortKey: shareSort.key,
    shareSortDir: shareSort.direction,
  };
}

function syncUrlState() {
  const state = collectUiState();
  const params = new URLSearchParams();
  params.set('tab', state.activePanel || 'queue');
  if (state.queueSearch) params.set('q', state.queueSearch);
  if (state.historySearch) params.set('history', state.historySearch);
  if (state.shareFilter) params.set('share', state.shareFilter);
  if (state.usersSearch) params.set('users', state.usersSearch);
  if (state.usersPartitionFilter && state.usersPartitionFilter !== 'ALL') params.set('usersPart', state.usersPartitionFilter);
  if (state.runsSearch) params.set('runs', state.runsSearch);
  if (state.selectedBatch) params.set('batch', state.selectedBatch);
  if (state.runsOpenMode && state.runsOpenMode !== 'embed') params.set('runsMode', state.runsOpenMode);
  if (state.metricsPartition && state.metricsPartition !== 'ALL') params.set('metricsPart', state.metricsPartition);
  params.set('queueSort', state.queueSort);
  params.set('historySort', state.historySort);
  params.set('infoSort', state.infoSort);
  params.set('gpuSort', state.gpuSort);
  params.set('cpuSort', state.cpuSort);
  params.set('runsSort', state.runsSummarySort);
  if (state.shareSortKey) params.set('shareSort', `${state.shareSortKey}:${state.shareSortDir || 'desc'}`);
  const hash = params.toString();
  history.replaceState(null, '', window.location.pathname + window.location.search + (hash ? '#' + hash : ''));
}

function persistUiState() {
  localStorage.setItem(UI_STATE_KEY, JSON.stringify(collectUiState()));
  syncUrlState();
}

function readInitialUiState() {
  let state = {};
  try {
    state = JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}') || {};
  } catch (_) {}

  const rawHash = (window.location.hash || '').replace(/^#\??/, '');
  if (rawHash) {
    const params = new URLSearchParams(rawHash);
    if (params.get('tab')) state.activePanel = params.get('tab');
    if (params.has('q')) state.queueSearch = params.get('q') || '';
    if (params.has('history')) state.historySearch = params.get('history') || '';
    if (params.has('share')) state.shareFilter = params.get('share') || '';
    if (params.has('users')) state.usersSearch = params.get('users') || '';
    if (params.has('usersPart')) state.usersPartitionFilter = params.get('usersPart') || 'ALL';
    if (params.has('runs')) state.runsSearch = params.get('runs') || '';
    if (params.has('batch')) state.selectedBatch = params.get('batch') || '';
    if (params.has('runsMode')) state.runsOpenMode = params.get('runsMode') || 'embed';
    if (params.has('queueSort')) state.queueSort = params.get('queueSort');
    if (params.has('historySort')) state.historySort = params.get('historySort');
    if (params.has('infoSort')) state.infoSort = params.get('infoSort');
    if (params.has('gpuSort')) state.gpuSort = params.get('gpuSort');
    if (params.has('cpuSort')) state.cpuSort = params.get('cpuSort');
    if (params.has('runsSort')) state.runsSummarySort = params.get('runsSort');
    if (params.has('metricsPart')) state.metricsPartition = params.get('metricsPart') || 'ALL';
    if (params.has('shareSort')) {
      const [key, direction] = String(params.get('shareSort') || '').split(':');
      if (key) {
        state.shareSortKey = key;
        state.shareSortDir = direction || 'desc';
      }
    }
  }
  return state;
}

function applyInitialUiState() {
  const state = readInitialUiState();
  activePanel = TAB_PANELS.includes(state.activePanel) ? state.activePanel : 'queue';
  queueSearch = state.queueSearch || '';
  historySearch = state.historySearch || '';
  shareFilter = state.shareFilter || '';
  usersSearch = state.usersSearch || '';
  usersPartitionFilter = state.usersPartitionFilter || 'ALL';
  runsSearch = state.runsSearch || '';
  selectedBatch = state.selectedBatch || '';
  runsOpenMode = state.runsOpenMode || runsOpenMode;
  metricsPartition = state.metricsPartition || 'ALL';
  applySortState(queueSort, state.queueSort, { type: 'number' });
  applySortState(historySort, state.historySort, { type: 'number' });
  applySortState(infoSort, state.infoSort, { type: 'string' });
  applySortState(gpuSort, state.gpuSort, { type: 'string' });
  applySortState(cpuSort, state.cpuSort, { type: 'string' });
  applySortState(runsSummarySort, state.runsSummarySort, { type: 'string' });
  if (state.shareSortKey) shareSort.key = state.shareSortKey;
  if (state.shareSortDir) shareSort.direction = state.shareSortDir === 'asc' ? 'asc' : 'desc';
}

function syncUiControlsFromState() {
  if ($('queue-search')) $('queue-search').value = queueSearch;
  if ($('history-search')) $('history-search').value = historySearch;
  if ($('share-filter')) $('share-filter').value = shareFilter;
  if ($('users-search')) $('users-search').value = usersSearch;
  if ($('runs-search')) $('runs-search').value = runsSearch;
  if ($('runs-open-mode')) $('runs-open-mode').value = runsOpenMode;
  if ($('share-warn-threshold')) $('share-warn-threshold').value = shareWarnThreshold.toFixed(2);
  if ($('share-critical-threshold')) $('share-critical-threshold').value = shareCriticalThreshold.toFixed(2);
  syncShareSortControls();
}

function saveShareThresholds() {
  localStorage.setItem(SHARE_THRESH_KEY, JSON.stringify({ warn: shareWarnThreshold, critical: shareCriticalThreshold }));
}

function saveSubmitTemplates() {
  localStorage.setItem(SUBMIT_TEMPLATES_KEY, JSON.stringify(submitTemplates));
}

function getSubmitFormValues() {
  return {
    script: (($('sub-script') || {}).value || '').trim(),
    name: (($('sub-name') || {}).value || '').trim(),
    partition: (($('sub-partition') || {}).value || '').trim(),
    cores: (($('sub-cores') || {}).value || '').trim(),
    walltime: (($('sub-walltime') || {}).value || '').trim(),
    mem: (($('sub-mem') || {}).value || '').trim(),
  };
}

function applySubmitFormValues(values = {}) {
  if ($('sub-script')) $('sub-script').value = values.script || '';
  if ($('sub-name')) $('sub-name').value = values.name || '';
  if ($('sub-partition')) $('sub-partition').value = values.partition || '';
  if ($('sub-cores')) $('sub-cores').value = values.cores || '';
  if ($('sub-walltime')) $('sub-walltime').value = values.walltime || '';
  if ($('sub-mem')) $('sub-mem').value = values.mem || '';
}

function renderSubmitTemplates() {
  const select = $('submit-template-select');
  if (!select) return;
  const current = select.value || '';
  select.innerHTML = '<option value="">Saved templates…</option>' + submitTemplates
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
    .map(template => `<option value="${esc(template.name)}">${esc(template.name)}</option>`)
    .join('');
  if (current && submitTemplates.some(t => t.name === current)) select.value = current;
}

function loadSubmitTemplate() {
  const select = $('submit-template-select');
  const name = select ? select.value : '';
  if (!name) {
    toast('Choose a saved template first', 'warn', '⚠️');
    return;
  }
  const template = submitTemplates.find(item => item.name === name);
  if (!template) return;
  applySubmitFormValues(template.values || {});
  toast(`Loaded template ${name}`, 'info', '📥', 1800);
}

function saveCurrentAsSubmitTemplate() {
  const values = getSubmitFormValues();
  if (!values.script) {
    toast('Fill in the submit form before saving a template', 'warn', '⚠️');
    return;
  }
  const existingName = ($('submit-template-select') || {}).value || '';
  const rawName = prompt('Template name:', existingName || values.name || values.script.split('/').pop() || 'job-template');
  const name = String(rawName || '').trim();
  if (!name) return;
  submitTemplates = submitTemplates.filter(item => item.name !== name);
  submitTemplates.push({ name, values });
  saveSubmitTemplates();
  renderSubmitTemplates();
  if ($('submit-template-select')) $('submit-template-select').value = name;
  toast(`Saved template ${name}`, 'success', '💾', 1800);
}

function deleteSelectedSubmitTemplate() {
  const select = $('submit-template-select');
  const name = select ? select.value : '';
  if (!name) {
    toast('Choose a template to delete', 'warn', '⚠️');
    return;
  }
  submitTemplates = submitTemplates.filter(item => item.name !== name);
  saveSubmitTemplates();
  renderSubmitTemplates();
  toast(`Deleted template ${name}`, 'info', '🗑', 1800);
}

function hasNoFairshareData(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const rawShares = Number(entry.rawShares ?? entry.shares ?? 0) || 0;
  const normShares = Number(entry.normShares ?? 0) || 0;
  const rawUsage = Number(entry.rawUsage ?? 0) || 0;
  const effUse = Number(entry.effUse ?? 0) || 0;
  const fairShare = Number(entry.fairShare ?? 0) || 0;
  return rawShares === 0 && normShares === 0 && rawUsage === 0 && effUse === 0 && fairShare === 0;
}

function classifyFairshare(entry) {
  if (hasNoFairshareData(entry)) return 'ok';
  const value = Number(entry && typeof entry === 'object' ? entry.fairShare : entry) || 0;
  if (value < shareCriticalThreshold) return 'critical';
  if (value < shareWarnThreshold) return 'warn';
  return 'ok';
}

function formatRelativeTs(seconds) {
  const ts = Number(seconds) || 0;
  if (!ts) return 'N/A';
  return relTime(new Date(ts * 1000).toISOString());
}

function validateSubmitParams(values) {
  if (!values.script) return 'Script path is required.';
  if (!values.script.startsWith('/')) return 'Script path must be absolute.';
  if (values.cores && (!/^\d+$/.test(values.cores) || Number(values.cores) < 1)) return 'Cores must be a positive integer.';
  if (values.walltime && !/^(?:\d+-)?\d{1,2}:\d{2}(?::\d{2})?$/.test(values.walltime)) {
    return 'Wall time must look like HH:MM, HH:MM:SS, or D-HH:MM:SS.';
  }
  if (values.mem && !Number.isFinite(parseMemoryToBytes(values.mem))) return 'Memory must look like 32G, 8000M, or 1T.';
  return '';
}

function openRunsMetaArtifact(action) {
  const run = currentBatchRuns.find(item => item.run === selectedRun);
  if (!run || !selectedBatch) return;
  if (action === 'config' && run.text_files.includes('run-config.json')) {
    selectedTextFile = 'run-config.json';
    selectedRunFile = '';
    selectedGroupHtml = '';
    selectedGroupText = '';
    loadSelectedRunText();
  } else if (action === 'manifest' && run.text_files.includes('manifest.json')) {
    selectedTextFile = 'manifest.json';
    selectedRunFile = '';
    selectedGroupHtml = '';
    selectedGroupText = '';
    loadSelectedRunText();
  } else if (action === 'firstHtml' && run.html_files && run.html_files.length) {
    selectedRunFile = run.html_files[0];
    selectedTextFile = '';
    selectedGroupHtml = '';
    selectedGroupText = '';
    openSelectedRunHtml();
  } else if (action === 'firstText' && run.text_files && run.text_files.length) {
    selectedTextFile = run.text_files[0];
    selectedRunFile = '';
    selectedGroupHtml = '';
    selectedGroupText = '';
    loadSelectedRunText();
  }
  renderRunList(selectedBatch, currentBatchRuns);
}

// ─────────────────────────────────────────
// Export helper
// ─────────────────────────────────────────
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

function exportData(rows, columns, filename, format) {
  if (!rows || !rows.length) { toast('No data to export', 'warn', '⚠️'); return; }
  if (format === 'json') {
    downloadBlob(JSON.stringify(rows, null, 2), filename + '.json', 'application/json');
  } else {
    const header = columns.join(',');
    const body = rows.map(row =>
      columns.map(k => {
        const v = String(row[k] ?? '');
        return v.includes(',') || v.includes('"') || v.includes('\n')
          ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',')
    ).join('\n');
    downloadBlob(header + '\n' + body, filename + '.csv', 'text/csv');
  }
  toast('Downloaded ' + filename + '.' + format, 'success', '⬇️');
}

function exportQueue(format) {
  const cols = ['jobid','name','partition','state','elapsed','timelimit','nodes','cpus','mem','nodelist','reason','priority','dependency','start'];
  exportData(Object.values(prevJobs), cols, 'queue', format);
}

function exportHistory(format) {
  const cols = ['jobid','name','state','elapsed','cputime','maxrss','partition','nodelist','submitted','exitcode'];
  exportData(historyRows, cols, 'history', format);
}

// ─────────────────────────────────────────
// Drop-down toggle helper
// ─────────────────────────────────────────
function setupDropdown(btnId, wrapId) {
  const btn  = $(btnId);
  const wrap = $(wrapId);
  if (!btn || !wrap) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    wrap.classList.toggle('open');
  });
  document.addEventListener('click', () => wrap.classList.remove('open'));
}

// ─────────────────────────────────────────
// Desktop Notifications
// ─────────────────────────────────────────
function requestNotifPermission() {
  if (!('Notification' in window)) { toast('Browser notifications not supported', 'warn', '⚠️'); return; }
  Notification.requestPermission().then(p => {
    if (p === 'granted') {
      cfg.desktopNotif = true;
      localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
      const cb = $('cfg-notif');
      if (cb) cb.checked = true;
      toast('Desktop notifications enabled', 'success', '🔔');
    } else {
      toast('Notification permission denied', 'warn', '🔕');
    }
  });
}

function sendNotif(title, body) {
  if (!cfg.desktopNotif) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, icon: '' }); } catch(_) {}
}

// ─────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────
function sendWebhook(event, job) {
  if (!cfg.webhookUrl) return;
  fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, jobid: job.jobid, name: job.name, state: job.state }),
  }).catch(() => {});
}

// ─────────────────────────────────────────
// Dependency string parser
// ─────────────────────────────────────────
function parseDependency(dep) {
  if (!dep || dep === 'N/A' || dep === '(null)' || dep === 'None') return null;
  // format: type:id,id?type2:id
  const result = [];
  const segments = dep.split('?');
  for (const seg of segments) {
    const colon = seg.indexOf(':');
    if (colon === -1) continue;
    const type = seg.slice(0, colon);
    const ids  = seg.slice(colon + 1).split(',').filter(Boolean);
    result.push({ type, ids });
  }
  return result.length ? result : null;
}


// ─────────────────────────────────────────
// Sound Notifications
// ─────────────────────────────────────────
function playSound(type='update') {
  if (!cfg.sounds) return;
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    if (type === 'running') {
      const osc1 = audioCtx.createOscillator(), osc2 = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc1.frequency.value = 523.25; osc2.frequency.value = 659.25;
      osc1.connect(gain); osc2.connect(gain); gain.connect(audioCtx.destination);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc1.start(now); osc1.stop(now + 0.15);
      osc2.start(now + 0.1); osc2.stop(now + 0.3);
    } else if (type === 'completed') {
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.frequency.value = freq; osc.connect(gain); gain.connect(audioCtx.destination);
        const t = now + i * 0.08;
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
        osc.start(t); osc.stop(t + 0.2);
      });
    } else if (type === 'failed' || type === 'cancelled') {
      [349.23, 261.63].forEach((freq, i) => {
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.frequency.value = freq; osc.connect(gain); gain.connect(audioCtx.destination);
        const t = now + i * 0.1;
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
        osc.start(t); osc.stop(t + 0.25);
      });
    } else {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.frequency.value = 440; osc.connect(gain); gain.connect(audioCtx.destination);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
      osc.start(now); osc.stop(now + 0.2);
    }
  } catch(e) {}
}

const el = (tag, attrs={}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'cls') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  children.forEach(c => c && e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return e;
};
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function animNum(elemId, newVal) {
  const e = $(elemId);
  if (!e) return;
  const old = parseInt(e.textContent) || 0;
  if (old === newVal) return;
  e.textContent = newVal;
  if (cfg.animations) { e.classList.remove('bump'); void e.offsetWidth; e.classList.add('bump'); }
}

// ─────────────────────────────────────────
// Clock & Uptime
// ─────────────────────────────────────────
function updateClock() {
  const now = new Date();
  $('clock').textContent =
    now.toLocaleTimeString('en-US', {hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit'});
  const s = Math.floor((Date.now() - uptimeStart) / 1000);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sc = s%60;
  $('uptime-label').textContent = `UPTIME: ${h?h+'h ':''}${m?m+'m ':''}${sc}s`;
}
setInterval(updateClock, 1000);
updateClock();

function maybeGlitch() {
  const logo = $('logo-text');
  if (logo && cfg.animations) {
    logo.classList.add('glitch');
    setTimeout(() => logo.classList.remove('glitch'), 400);
  }
  setTimeout(maybeGlitch, 30000 + Math.random()*60000);
}
setTimeout(maybeGlitch, 15000);

// ─────────────────────────────────────────
// Toast Notifications
// ─────────────────────────────────────────
function toast(msg, type='info', icon='ℹ️', duration=4000) {
  const box = $('toasts');
  const t = el('div', {cls: `toast ${type}`});
  t.innerHTML = `<span>${icon}</span><span>${esc(msg)}</span>`;
  box.appendChild(t);
  t.onclick = () => remove(t);
  function remove(t) {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove(), {once:true});
  }
  setTimeout(() => remove(t), duration);
}

// ─────────────────────────────────────────
// Particle Burst
// ─────────────────────────────────────────
const pCanvas = $('particles');
const pCtx = pCanvas.getContext('2d');
let particles = [];

function resizeParticles() { pCanvas.width = window.innerWidth; pCanvas.height = window.innerHeight; }
resizeParticles();
window.addEventListener('resize', resizeParticles);

function spawnBurst(x, y, color, count=30) {
  if (!cfg.animations) return;
  for (let i=0; i<count; i++) {
    const angle = Math.random()*Math.PI*2, speed = 1.5 + Math.random()*4;
    particles.push({ x, y, vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed - 2,
      life: 1, decay: 0.02+Math.random()*0.03, r: 2+Math.random()*3, color });
  }
}

function animParticles() {
  pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
  particles = particles.filter(p => p.life > 0);
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.vx *= 0.98; p.life -= p.decay;
    pCtx.globalAlpha = Math.max(0, p.life); pCtx.fillStyle = p.color;
    pCtx.beginPath(); pCtx.arc(p.x, p.y, p.r, 0, Math.PI*2); pCtx.fill();
  }
  pCtx.globalAlpha = 1;
  requestAnimationFrame(animParticles);
}
animParticles();

function burstFromRow(row, color) {
  if (!row) return;
  const rect = row.getBoundingClientRect();
  spawnBurst(rect.left + rect.width/2, rect.top + rect.height/2, color, 35);
}

// ─────────────────────────────────────────
// Starfield
// ─────────────────────────────────────────
(function() {
  const c = $('starfield'), ctx = c.getContext('2d');
  let W, H, stars=[];
  function resize() {
    W = c.width = window.innerWidth; H = c.height = window.innerHeight;
    stars = Array.from({length:220}, () => ({
      x:Math.random()*W, y:Math.random()*H, r:Math.random()*1.6,
      speed:0.02+Math.random()*0.06, alpha:0.2+Math.random()*0.7,
      twinkle:Math.random()*Math.PI*2, twinkleSpeed:0.005+Math.random()*0.02,
    }));
  }
  resize();
  window.addEventListener('resize', resize);
  function draw() {
    ctx.clearRect(0,0,W,H);
    for (const s of stars) {
      s.twinkle += s.twinkleSpeed;
      ctx.globalAlpha = s.alpha * (0.5 + 0.5*Math.sin(s.twinkle));
      ctx.fillStyle = '#b0d8ff';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI*2); ctx.fill();
      s.y -= s.speed;
      if (s.y < -2) { s.y = H+2; s.x = Math.random()*W; }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  draw();
})();

// ─────────────────────────────────────────
// Scanner Wave
// ─────────────────────────────────────────
let waveIdx = 0;
function runScannerWave() {
  const rows = document.querySelectorAll('#job-tbody tr:not(.empty-row)');
  if (!rows.length) { scanWaveFrame = setTimeout(runScannerWave, 200); return; }
  rows.forEach(r => r.classList.remove('wave-scan'));
  if (waveIdx < rows.length) rows[waveIdx].classList.add('wave-scan');
  waveIdx++;
  if (waveIdx > rows.length + 3) waveIdx = 0;
  scanWaveFrame = setTimeout(runScannerWave, cfg.animations ? 130 : 99999);
}
runScannerWave();

// ─────────────────────────────────────────
// Refresh Countdown Timer
// ─────────────────────────────────────────
const CIRC = 94.25;
function updateCountdownUI(seconds, total) {
  const pct = seconds / total;
  $('refresh-circle').style.strokeDashoffset = CIRC * (1 - pct);
  $('refresh-countdown').textContent = seconds;
}

function startRefreshCycle() {
  clearInterval(refreshTimer);
  countdown = cfg.refreshInterval;
  updateCountdownUI(countdown, cfg.refreshInterval);
  refreshTimer = setInterval(() => {
    countdown--;
    if (countdown < 0) countdown = cfg.refreshInterval;
    updateCountdownUI(countdown, cfg.refreshInterval);
    if (countdown === 0) fetchQueue();
  }, 1000);
}

// ─────────────────────────────────────────
// State Badge
// ─────────────────────────────────────────
function stateBadge(state) {
  const s = state ? state.toUpperCase() : 'UNKNOWN';
  const cls = s in {RUNNING:1,PENDING:1,COMPLETING:1,COMPLETED:1,
    FAILED:1,CANCELLED:1,CANCELED:1,SUSPENDED:1,TIMEOUT:1} ? s : 'default';
  return `<span class="state-badge state-${cls}"><span class="dot"></span>${s}</span>`;
}


// ─────────────────────────────────────────
// Parse squeue raw output (14 fields now: +dependency, +start)
// Fields: jobid name partition state elapsed timelimit nodes cpus mem nodelist reason priority dependency start
// ─────────────────────────────────────────
function parseSqueue(raw) {
  return raw.trim().split('\n').filter(l => l.trim()).map(line => {
    const [jobid,name,partition,state,elapsed,timelimit,nodes,cpus,mem,nodelist,reason,priority,dependency,start] = line.split('\t');
    return {jobid,name,partition,state,elapsed,timelimit,nodes,cpus,mem,nodelist,reason,priority,dependency,start};
  });
}

// ─────────────────────────────────────────
// Mobile card rendering
// ─────────────────────────────────────────
function renderQueueCards(jobs) {
  const container = $('queue-cards');
  if (!container) return;
  if (!jobs.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎉</div><div>No active jobs — all clear!</div></div>`;
    return;
  }
  container.innerHTML = jobs.map(j => {
    const stateClass = j.state === 'RUNNING' ? 'running' : j.state === 'PENDING' ? 'pending' :
                       (j.state === 'FAILED' || j.state === 'TIMEOUT') ? 'failed' : '';
    return `<div class="job-card ${stateClass}" data-jid="${esc(j.jobid)}">
      <div class="job-card-header">
        <span class="job-card-id">#${esc(j.jobid)}</span>
        ${stateBadge(j.state)}
      </div>
      <div class="job-card-name">${esc(j.name)}</div>
      <div class="job-card-meta">
        <span>📂 ${esc(j.partition)}</span>
        <span>⚙ ${esc(j.cpus)} CPUs</span>
        <span>💾 ${esc(j.mem)}</span>
      </div>
      <div class="job-card-footer">
        <span>⏱ ${esc(j.elapsed)} / ${esc(j.timelimit)}</span>
        <span>${esc(j.nodelist !== 'N/A' ? j.nodelist.slice(0,20) : '')}</span>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.job-card[data-jid]').forEach(card => {
    card.addEventListener('click', () => {
      const jid = card.dataset.jid;
      const job = prevJobs[jid];
      if (job) openJobModal(job);
    });
  });
}

// ─────────────────────────────────────────
// Render Queue Table
// ─────────────────────────────────────────
function renderQueue(jobs) {
  const tbody = $('job-tbody');
  const queueInsights = computeQueueInsights(jobs);
  for (const j of jobs) {
    const insight = queueInsights[j.jobid];
    if (insight) {
      j.queuePosition = insight.position;
      j.queueEtaSeconds = insight.etaSeconds;
    } else {
      delete j.queuePosition;
      delete j.queueEtaSeconds;
    }
  }
  const nowMap = {};
  for (const j of jobs) nowMap[j.jobid] = j;

  for (const j of jobs) {
    const prev = prevJobs[j.jobid];
    if (!prev) {
      toast(`Job ${j.jobid} (${j.name}) appeared in queue`, 'info', '🆕');
    } else if (prev.state !== j.state) {
      if (j.state === 'RUNNING') {
        toast(`Job ${j.jobid} (${j.name}) is now RUNNING on ${j.nodelist}`, 'success', '▶️');
        playSound('running');
        sendNotif('Job Running', `${j.name} (#${j.jobid}) started on ${j.nodelist}`);
        sendWebhook('running', j);
      } else if (j.state === 'COMPLETING') {
        toast(`Job ${j.jobid} (${j.name}) is COMPLETING`, 'info', '🔵');
      }
    }
  }
  for (const [jid, prev] of Object.entries(prevJobs)) {
    if (!nowMap[jid]) {
      const s = prev.state;
      if (s === 'RUNNING' || s === 'COMPLETING') {
        toast(`Job ${jid} (${prev.name}) COMPLETED`, 'success', '✅', 5000);
        playSound('completed');
        sendNotif('Job Completed', `${prev.name} (#${jid}) finished successfully`);
        sendWebhook('completed', prev);
      } else if (s === 'FAILED') {
        toast(`Job ${jid} (${prev.name}) FAILED`, 'danger', '❌', 6000);
        playSound('failed');
        sendNotif('Job Failed', `${prev.name} (#${jid}) failed`);
        sendWebhook('failed', prev);
      } else if (s === 'CANCELLED' || s === 'CANCELED') {
        toast(`Job ${jid} (${prev.name}) was CANCELLED`, 'warn', '🚫');
        playSound('cancelled');
        sendNotif('Job Cancelled', `${prev.name} (#${jid}) was cancelled`);
        sendWebhook('cancelled', prev);
      } else if (s === 'TIMEOUT') {
        toast(`Job ${jid} (${prev.name}) TIMED OUT`, 'warn', '⏱', 6000);
        playSound('failed');
        sendNotif('Job Timed Out', `${prev.name} (#${jid}) timed out`);
        sendWebhook('timeout', prev);
      }
    }
  }

  prevJobs = nowMap;

  let running=0, pending=0, other=0;
  for (const j of jobs) {
    if (j.state === 'RUNNING') running++;
    else if (j.state === 'PENDING') pending++;
    else other++;
  }
  animNum('stat-running', running);
  animNum('stat-pending', pending);
  animNum('stat-other', other);
  animNum('stat-total', jobs.length);
  animNum('hdr-running', running);
  animNum('hdr-pending', pending);
  animNum('hdr-other', other);
  animNum('hdr-total', jobs.length);
  renderQueuePartitions(jobs);

  // Apply search filter
  const filter = buildFilter(queueSearch);
  const filtered = filter
    ? jobs.filter(j => matchesFilter(filter, j.jobid, j.name, j.partition, j.state, j.nodelist, j.reason))
    : jobs;

  renderQueueCards(filtered);

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="11"><div class="empty-state"><div class="empty-icon">${jobs.length?'🔎':'🎉'}</div><div>${jobs.length?'No jobs match the filter.':'No active jobs — all clear!'}</div></div></td></tr>`;
    updateSortableHeaders('#job-table', queueSort);
    return;
  }

  const existing = {};
  tbody.querySelectorAll('tr[data-jid]').forEach(r => { existing[r.dataset.jid] = r; });
  const nowSet = new Set(filtered.map(j => j.jobid));

  const sortedJobs = sortRows(filtered.map(job => ({
    ...job,
    reasonSort: (job.reason && job.reason !== 'None') ? job.reason : (job.priority || ''),
  })), queueSort);

  for (const [jid, row] of Object.entries(existing)) {
    if (!nowSet.has(jid)) {
      if (cfg.animations) {
        row.classList.add('row-exit');
        burstFromRow(row, '#00e5ff');
        row.addEventListener('animationend', () => row.remove(), {once:true});
      } else {
        row.remove();
      }
    }
  }

  for (const j of sortedJobs) {
    const priority = parseFloat(j.priority) || 0;
    const prioClass = priority > 0.9 ? 'high' : priority < 0.5 ? 'low' : '';
    const prioLabel = j.priority && j.priority !== 'N/A'
      ? `<span class="priority-chip ${prioClass}">${j.priority}</span>` : '';
    const reasonOrPrio = (j.reason && j.reason !== 'None') ? esc(j.reason) : prioLabel;
    const queueHint = j.state === 'PENDING' && Number.isFinite(j.queuePosition)
      ? `<div class="queue-hint">Q#${esc(String(j.queuePosition))} • ${esc(formatEta(j.queueEtaSeconds))}</div>`
      : '';
    const startRel = j.start && j.start !== 'N/A'
      ? `<span title="${esc(j.start)}">${esc(relTime(j.start))}</span>` : esc(j.start || 'N/A');

    const html = `
      <td>${esc(j.jobid)}</td>
      <td title="${esc(j.name)}">${esc(j.name.length>18?j.name.slice(0,17)+'…':j.name)}</td>
      <td>${esc(j.partition)}</td>
      <td>${stateBadge(j.state)}</td>
      <td>${esc(j.elapsed)}</td>
      <td>${esc(j.timelimit)}</td>
      <td>${esc(j.nodes)}</td>
      <td>${esc(j.cpus)}</td>
      <td>${esc(j.mem)}</td>
      <td title="${esc(j.nodelist)}">${esc(j.nodelist&&j.nodelist!=='N/A'?j.nodelist.slice(0,22):j.nodelist)}</td>
      <td><div class="reason-cell">${reasonOrPrio}${queueHint}</div></td>`;

    if (existing[j.jobid]) {
      const row = existing[j.jobid];
      const prevState = row.dataset.state;
      if (prevState !== j.state) {
        row.innerHTML = html; row.dataset.state = j.state;
        if (cfg.animations) {
          if (j.state === 'RUNNING') { row.classList.add('row-flash-success'); burstFromRow(row, '#00ff9d'); }
          else if (j.state === 'FAILED') { row.classList.add('row-flash-danger'); burstFromRow(row, '#ff4466'); }
          row.addEventListener('animationend', () => {
            row.classList.remove('row-flash-success','row-flash-danger');
          }, {once:true});
        }
      } else { row.innerHTML = html; }
      if (j.state === 'RUNNING') row.classList.add('row-glow-running');
      else row.classList.remove('row-glow-running');
      tbody.appendChild(row);
    } else {
      const row = document.createElement('tr');
      row.dataset.jid = j.jobid; row.dataset.state = j.state;
      row.innerHTML = html;
      if (j.state === 'RUNNING') row.classList.add('row-glow-running');
      if (cfg.animations) {
        row.classList.add('row-enter');
        row.addEventListener('animationend', () => row.classList.remove('row-enter'), {once:true});
      }
      tbody.querySelectorAll('.empty-row').forEach(r => r.remove());
      tbody.appendChild(row);
    }
  }
  if (currentJobDetail) {
    const latest = prevJobs[currentJobDetail.jobid];
    if (latest) {
      currentJobDetail = latest;
      populateJobModal(latest);
    }
  }
  updateSortableHeaders('#job-table', queueSort);
}

// ─────────────────────────────────────────
// Fetch Queue
// ─────────────────────────────────────────
async function fetchQueue() {
  $('last-update-time').textContent = new Date().toLocaleTimeString();
  if (cfg.demoMode) { renderQueue(demoNextTick()); setStatus('demo'); return; }
  try {
    const headers = cfg.authToken ? { Authorization: 'Bearer ' + cfg.authToken } : {};
    const r = await fetch(cfg.serverUrl + '/api/squeue', { signal: AbortSignal.timeout(8000), headers });
    const data = await r.json();
    if (!data.ok && data.err) { setStatus('err'); toast(`squeue error: ${data.err}`, 'danger', '❌'); return; }
    setStatus('ok');
    renderQueue(parseSqueue(data.out || ''));
  } catch(e) {
    setStatus('err');
    if (connected) toast('Lost connection to slurmSight server', 'danger', '🔌');
    connected = false;
  }
}

// ─────────────────────────────────────────
// Connection status
// ─────────────────────────────────────────
function setStatus(s) {
  const e = $('conn-status');
  e.className = 'conn-status ' + s;
  e.textContent = s==='ok'?'● LIVE':s==='demo'?'◈ DEMO':s==='err'?'✖ OFFLINE':'⚡ CONNECTING';
  connected = s === 'ok';
}

// ─────────────────────────────────────────
// Server capability check
// ─────────────────────────────────────────
async function fetchServerCapabilities() {
  if (cfg.demoMode) {
    serverCapabilities = { enable_submit: true, enable_metrics: false, enable_runs_browser: true };
    updateSubmitVisibility();
    return;
  }
  try {
    const headers = cfg.authToken ? { Authorization: 'Bearer ' + cfg.authToken } : {};
    const r = await fetch(cfg.serverUrl + '/api/config', { signal: AbortSignal.timeout(4000), headers });
    const data = await r.json();
    if (data.ok) {
      serverCapabilities = data.config;
      updateSubmitVisibility();
    }
  } catch(_) {}
}

async function testServerConnection() {
  const btn = $('btn-test-connection');
  const result = $('cfg-test-result');
  const serverUrl = (($('cfg-server') || {}).value || cfg.serverUrl || '').trim();
  const authToken = (($('cfg-auth-token') || {}).value || '').trim();
  if (!serverUrl) {
    if (result) {
      result.className = 'setting-help err';
      result.textContent = 'Enter a server URL first.';
    }
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'TESTING…';
  }
  if (result) {
    result.className = 'setting-help';
    result.textContent = 'Checking server status…';
  }
  try {
    const headers = authToken ? { Authorization: 'Bearer ' + authToken } : {};
    const r = await fetch(serverUrl.replace(/\/$/, '') + '/api/slurm_status', {
      signal: AbortSignal.timeout(5000),
      headers,
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      throw new Error(data.err || `HTTP ${r.status}`);
    }
    if (result) {
      result.className = 'setting-help ok';
      result.textContent = data.available
        ? 'Connected. Slurm commands are available on the server.'
        : 'Connected, but Slurm commands are not available on the server PATH.';
    }
  } catch (e) {
    if (result) {
      result.className = 'setting-help err';
      result.textContent = 'Connection test failed: ' + (e.message || e);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'TEST CONNECTION';
    }
  }
}

function getSettingsConnection() {
  const serverUrl = (($('cfg-server') || {}).value || cfg.serverUrl || '').trim();
  const authToken = (($('cfg-auth-token') || {}).value || cfg.authToken || '').trim();
  return {
    serverUrl: serverUrl.replace(/\/$/, ''),
    headers: authToken ? { Authorization: 'Bearer ' + authToken } : {},
  };
}

function populateServerConfigForm(configObj = {}) {
  SERVER_CONFIG_FORM_FIELDS.forEach(field => {
    const el = $(field.id);
    if (!el) return;
    const fallback = SERVER_CONFIG_DEFAULTS[field.key];
    const value = Object.prototype.hasOwnProperty.call(configObj, field.key) ? configObj[field.key] : fallback;
    if (field.type === 'bool') {
      el.checked = !!value;
    } else {
      el.value = value == null ? '' : String(value);
    }
  });
}

function parseServerConfigEditor() {
  const editor = $('cfg-server-json');
  if (!editor) return null;
  try {
    const parsed = JSON.parse(editor.value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function syncServerConfigFormFromJson(options = {}) {
  const silent = !!options.silent;
  const status = $('server-config-status');
  const parsed = parseServerConfigEditor();
  if (!parsed) {
    if (!silent && status) {
      status.className = 'setting-help err';
      status.textContent = 'Cannot sync form: JSON is invalid.';
    }
    return false;
  }
  populateServerConfigForm(parsed);
  if (!silent && status) {
    status.className = 'setting-help ok';
    status.textContent = 'Form synced from JSON editor.';
  }
  return true;
}

function applyServerConfigFormToJson() {
  const status = $('server-config-status');
  const editor = $('cfg-server-json');
  if (!editor) return;
  const base = parseServerConfigEditor() || {};
  const next = { ...base };

  for (const field of SERVER_CONFIG_FORM_FIELDS) {
    const el = $(field.id);
    if (!el) continue;
    if (field.type === 'bool') {
      next[field.key] = !!el.checked;
      continue;
    }
    if (field.type === 'int') {
      const raw = String(el.value || '').trim();
      if (!raw) {
        if (status) {
          status.className = 'setting-help err';
          status.textContent = `Missing value for ${field.key}.`;
        }
        return;
      }
      const num = Number(raw);
      if (!Number.isInteger(num)) {
        if (status) {
          status.className = 'setting-help err';
          status.textContent = `Invalid integer for ${field.key}.`;
        }
        return;
      }
      next[field.key] = num;
      continue;
    }
    next[field.key] = String(el.value || '');
  }

  editor.value = JSON.stringify(next, null, 2);
  trackServerConfigEditorDirty();
  if (status && !serverConfigDirty) {
    status.className = 'setting-help ok';
    status.textContent = 'Form applied to JSON editor.';
  }
}

function normalizeConfigJson(text) {
  try {
    return JSON.stringify(JSON.parse(String(text || '')));
  } catch (_) {
    return null;
  }
}

function setServerConfigDirtyState(isDirty) {
  serverConfigDirty = !!isDirty;
  const status = $('server-config-status');
  if (!status) return;
  if (serverConfigDirty) {
    if (!status.className.includes('err')) {
      status.className = 'setting-help warn';
      status.textContent = 'Unsaved server config changes.';
    }
  } else if (status.className.includes('warn')) {
    status.className = 'setting-help ok';
    status.textContent = 'Server config is saved.';
  }
}

function trackServerConfigEditorDirty() {
  const editor = $('cfg-server-json');
  if (!editor) return;
  const current = normalizeConfigJson(editor.value);
  if (current === null) {
    setServerConfigDirtyState(true);
    return;
  }
  setServerConfigDirtyState(serverConfigBaseline !== '' && current !== serverConfigBaseline);
}

async function loadServerConfigFile(options = {}) {
  const silent = !!options.silent;
  const status = $('server-config-status');
  const editor = $('cfg-server-json');
  const btn = $('btn-load-server-config');
  if (!editor) return;
  const { serverUrl, headers } = getSettingsConnection();
  if (!serverUrl) {
    if (status) { status.className = 'setting-help err'; status.textContent = 'Set SERVER URL first.'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'LOADING…'; }
  if (status && !silent) { status.className = 'setting-help'; status.textContent = 'Loading server config…'; }
  try {
    const r = await fetch(serverUrl + '/api/config-file', { signal: AbortSignal.timeout(8000), headers });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.err || `HTTP ${r.status}`);
    editor.value = JSON.stringify(data.config || {}, null, 2);
    populateServerConfigForm(data.config || {});
    const normalized = normalizeConfigJson(editor.value);
    serverConfigBaseline = normalized || '';
    serverConfigLoadedOnce = true;
    setServerConfigDirtyState(false);
    if (status) {
      status.className = 'setting-help ok';
      status.textContent = `Loaded ${data.path || 'config.json'}`;
    }
  } catch (e) {
    if (status && !silent) {
      status.className = 'setting-help err';
      status.textContent = 'Load failed: ' + (e.message || e);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'LOAD CONFIG'; }
  }
}

async function saveServerConfigFile() {
  const status = $('server-config-status');
  const editor = $('cfg-server-json');
  const btn = $('btn-save-server-config');
  if (!editor) return;
  const { serverUrl, headers } = getSettingsConnection();
  if (!serverUrl) {
    if (status) { status.className = 'setting-help err'; status.textContent = 'Set SERVER URL first.'; }
    return;
  }
  let configObj;
  try {
    configObj = JSON.parse(editor.value || '{}');
  } catch (e) {
    if (status) {
      status.className = 'setting-help err';
      status.textContent = 'JSON parse error: ' + (e.message || e);
    }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'SAVING…'; }
  if (status) { status.className = 'setting-help'; status.textContent = 'Saving server config…'; }
  try {
    const r = await fetch(serverUrl + '/api/config-file', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ config: configObj }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.err || `HTTP ${r.status}`);
    editor.value = JSON.stringify(data.config || configObj, null, 2);
    populateServerConfigForm(data.config || configObj || {});
    const normalized = normalizeConfigJson(editor.value);
    serverConfigBaseline = normalized || '';
    setServerConfigDirtyState(false);
    serverConfigLoadedOnce = true;
    if (status) {
      status.className = data.restart_required ? 'setting-help warn' : 'setting-help ok';
      status.textContent = data.note || 'Config saved.';
    }
    toast('Server config saved', 'success', '💾');
  } catch (e) {
    if (status) {
      status.className = 'setting-help err';
      status.textContent = 'Save failed: ' + (e.message || e);
    }
    toast('Config save failed', 'danger', '❌');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'SAVE CONFIG'; }
  }
}

function updateSubmitVisibility() {
  const tab = document.querySelector('.tab[data-panel="submit"]');
  const metricsTab = document.querySelector('.tab[data-panel="metrics"]');
  const runsTab = document.querySelector('.tab[data-panel="runs"]');
  if (tab) {
    tab.classList.toggle('unavailable', !serverCapabilities.enable_submit);
    tab.title = serverCapabilities.enable_submit
      ? 'Submit jobs'
      : 'Job submission is disabled on this server';
  }
  if (metricsTab) {
    metricsTab.classList.toggle('unavailable', !serverCapabilities.enable_metrics);
    metricsTab.title = serverCapabilities.enable_metrics
      ? 'Queue metrics'
      : 'Metrics are disabled on this server';
  }
  if (runsTab) runsTab.style.display = serverCapabilities.enable_runs_browser === false ? 'none' : '';
  const notice = $('submit-disabled-notice');
  if (notice) notice.style.display = serverCapabilities.enable_submit ? 'none' : '';
  const form = $('submit-form-fields');
  if (form) form.style.display = serverCapabilities.enable_submit ? '' : 'none';
}

function getRunsViewUrl(batch, run, fileName) {
  return cfg.serverUrl + '/api/runs/file/'
    + encodeURIComponent(batch) + '/'
    + encodeURIComponent(run) + '/'
    + String(fileName || '').split('/').map(p => encodeURIComponent(p)).join('/');
}

function getRunsBatchViewUrl(batch, fileName) {
  return cfg.serverUrl + '/api/runs/batch-file/'
    + encodeURIComponent(batch) + '/'
    + encodeURIComponent(fileName);
}

function setRunsCurrentFile(label) {
  const el = $('runs-current-file');
  if (el) el.textContent = label || 'No file selected';
}

function updateRunsExpandButton() {
  const btn = $('btn-runs-expand');
  if (!btn) return;
  btn.textContent = runsViewerExpanded ? 'Collapse Viewer' : 'Expand Viewer';
}

function toggleRunsViewerExpanded() {
  const panel = $('panel-runs');
  if (!panel) return;
  runsViewerExpanded = !runsViewerExpanded;
  panel.classList.toggle('viewer-expanded', runsViewerExpanded);
  updateRunsExpandButton();
}

function highlightTextContent(content, fileName) {
  const name = String(fileName || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  let html = esc(content || '');

  if (ext === '.json') {
    html = html.replace(/^(\s*)"([^"\\]*(?:\\.[^"\\]*)*)"(\s*:)/gm, '$1<span class="tok-key">"$2"</span>$3');
    html = html.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, '<span class="tok-str">"$1"</span>');
    html = html.replace(/\b(true|false|null)\b/g, '<span class="tok-kw">$1</span>');
    html = html.replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
    return html;
  }

  if (ext === '.sh' || ext === '.slurm' || name.endsWith('.bash')) {
    html = html.replace(/("[^"\n]*"|'[^'\n]*')/g, '<span class="tok-str">$1</span>');
    html = html.replace(/\b(if|then|else|fi|for|while|do|done|case|esac|function|echo|cd|export|module|srun|sbatch)\b/g, '<span class="tok-kw">$1</span>');
    html = html.replace(/(^|\n)(\s*#.*?)(?=\n|$)/g, '$1<span class="tok-com">$2</span>');
    return html;
  }

  if (ext === '.yaml' || ext === '.yml') {
    html = html.replace(/(^|\n)(\s*[a-zA-Z0-9_.-]+\s*:)/g, '$1<span class="tok-key">$2</span>');
    html = html.replace(/(:\s*)([^\n#]+)/g, '$1<span class="tok-str">$2</span>');
    html = html.replace(/(^|\n)(\s*#.*?)(?=\n|$)/g, '$1<span class="tok-com">$2</span>');
    return html;
  }

  html = html.replace(/\b(ERROR|FATAL|EXCEPTION)\b/g, '<span class="tok-err">$1</span>');
  html = html.replace(/\b(WARN|WARNING)\b/g, '<span class="tok-warn">$1</span>');
  html = html.replace(/\b(INFO|DEBUG)\b/g, '<span class="tok-info">$1</span>');
  return html;
}

function showRunsHtmlViewer(url) {
  const frame = $('runs-viewer');
  const textBox = $('runs-text-viewer');
  if (textBox) textBox.style.display = 'none';
  if (frame) {
    frame.style.display = '';
    frame.src = url || '';
  }
}

function showRunsTextViewer(text, fileName = '', highlight = true) {
  const frame = $('runs-viewer');
  const textBox = $('runs-text-viewer');
  if (frame) frame.style.display = 'none';
  if (textBox) {
    textBox.style.display = '';
    if (highlight) textBox.innerHTML = highlightTextContent(text || '', fileName);
    else textBox.textContent = text || '';
  }
}

function renderRunsMeta(metadata, summary = null) {
  const meta = $('runs-meta');
  if (!meta) return;
  const cfgMeta = metadata && metadata.run_config && typeof metadata.run_config === 'object'
    ? metadata.run_config
    : null;
  const manifest = metadata && metadata.manifest && typeof metadata.manifest === 'object'
    ? metadata.manifest
    : null;

  const runName = cfgMeta && cfgMeta.run_name ? cfgMeta.run_name : 'N/A';
  const runId = cfgMeta && cfgMeta.run_id ? cfgMeta.run_id : 'N/A';
  const filesCount = manifest && Array.isArray(manifest.files) ? manifest.files.length : 'N/A';
  const htmlCount = summary ? (summary.html_files || []).length : 0;
  const textCount = summary ? (summary.text_files || []).length : 0;
  const statusLabel = summary ? (summary.completed ? 'COMPLETE' : 'IN PROGRESS') : (manifest ? 'COMPLETE' : 'UNKNOWN');
  const statusCls = statusLabel === 'COMPLETE' ? 'ok' : 'warn';
  const lastModified = summary ? formatRelativeTs(summary.last_modified) : 'N/A';
  const actions = [];
  if (summary && summary.has_config && summary.text_files.includes('run-config.json')) actions.push('<button class="runs-meta-btn" data-run-meta-action="config">Open run-config.json</button>');
  if (summary && summary.has_manifest && summary.text_files.includes('manifest.json')) actions.push('<button class="runs-meta-btn" data-run-meta-action="manifest">Open manifest.json</button>');
  if (summary && summary.html_files && summary.html_files.length) actions.push('<button class="runs-meta-btn" data-run-meta-action="firstHtml">Open first HTML</button>');
  if (summary && summary.text_files && summary.text_files.length) actions.push('<button class="runs-meta-btn" data-run-meta-action="firstText">Open first text</button>');

  meta.innerHTML = `
    <div class="runs-meta-top">
      <span class="runs-meta-chip ${statusCls}">${esc(statusLabel)}</span>
      <span class="runs-meta-chip info">${esc(htmlCount)} HTML</span>
      <span class="runs-meta-chip info">${esc(textCount)} TEXT</span>
      <span class="runs-meta-chip">UPDATED ${esc(lastModified)}</span>
    </div>
    <div class="runs-meta-grid">
      <div><span class="runs-meta-k">RUN NAME</span><span class="runs-meta-v">${esc(runName)}</span></div>
      <div><span class="runs-meta-k">RUN ID</span><span class="runs-meta-v">${esc(runId)}</span></div>
      <div><span class="runs-meta-k">STATUS</span><span class="runs-meta-v">${esc(statusLabel)}</span></div>
      <div><span class="runs-meta-k">MANIFEST FILES</span><span class="runs-meta-v">${esc(filesCount)}</span></div>
      <div><span class="runs-meta-k">RUN HTML FILES</span><span class="runs-meta-v">${esc(htmlCount)}</span></div>
      <div><span class="runs-meta-k">RUN TEXT FILES</span><span class="runs-meta-v">${esc(textCount)}</span></div>
      <div><span class="runs-meta-k">LAST MODIFIED</span><span class="runs-meta-v">${esc(lastModified)}</span></div>
    </div>
    ${actions.length ? `<div class="runs-meta-actions">${actions.join('')}</div>` : ''}`;

  meta.querySelectorAll('[data-run-meta-action]').forEach(btn => {
    btn.addEventListener('click', () => openRunsMetaArtifact(btn.dataset.runMetaAction || ''));
  });
}

async function fetchRunMeta(batch, run) {
  const meta = $('runs-meta');
  if (!meta) return;
  meta.innerHTML = '<div class="runs-meta-empty"><span class="spinner"></span> Loading metadata…</div>';
  try {
    const headers = cfg.authToken ? { Authorization: 'Bearer ' + cfg.authToken } : {};
    const params = new URLSearchParams({ batch, run });
    const r = await fetch(cfg.serverUrl + '/api/runs/meta?' + params.toString(), {
      signal: AbortSignal.timeout(10000),
      headers,
    });
    const data = await r.json();
    if (!data.ok) {
      meta.innerHTML = '<div class="runs-meta-empty">Metadata unavailable.</div>';
      return;
    }
    const summary = currentBatchRuns.find(item => item.run === run) || null;
    renderRunsMeta(data.metadata || {}, summary);
  } catch (_) {
    meta.innerHTML = '<div class="runs-meta-empty">Metadata unavailable.</div>';
  }
}

function openSelectedRunHtml() {
  let url = '';
  if (selectedBatch && selectedRun && selectedRunFile) {
    url = getRunsViewUrl(selectedBatch, selectedRun, selectedRunFile);
    setRunsCurrentFile(`HTML: ${selectedRunFile}`);
  } else if (selectedBatch && selectedGroupHtml) {
    url = getRunsBatchViewUrl(selectedBatch, selectedGroupHtml);
    setRunsCurrentFile(`GROUP HTML: ${selectedGroupHtml}`);
  } else {
    toast('Select a run or group HTML file first', 'warn', '⚠️');
    return;
  }
  const frame = $('runs-viewer');
  if (runsOpenMode === 'newtab') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  if (frame) showRunsHtmlViewer(url);
}

async function loadSelectedRunText() {
  let endpoint = '';
  if (selectedBatch && selectedRun && selectedTextFile) {
    const params = new URLSearchParams({ batch: selectedBatch, run: selectedRun, file: selectedTextFile });
    endpoint = cfg.serverUrl + '/api/runs/text?' + params.toString();
    setRunsCurrentFile(`TEXT: ${selectedTextFile}`);
  } else if (selectedBatch && selectedGroupText) {
    const params = new URLSearchParams({ batch: selectedBatch, file: selectedGroupText });
    endpoint = cfg.serverUrl + '/api/runs/batch-text?' + params.toString();
    setRunsCurrentFile(`GROUP TEXT: ${selectedGroupText}`);
  } else {
    toast('Select a run or group text file first', 'warn', '⚠️');
    return;
  }
  showRunsTextViewer('Loading text artifact...', '', false);
  try {
    const headers = cfg.authToken ? { Authorization: 'Bearer ' + cfg.authToken } : {};
    const r = await fetch(endpoint, {
      signal: AbortSignal.timeout(12000),
      headers,
    });
    const data = await r.json();
    if (!data.ok) {
      showRunsTextViewer('Could not load text artifact: ' + (data.err || 'Unknown error'));
      return;
    }
    let content = data.content || '';
    if (data.truncated) {
      content += '\n\n---\nPreview truncated at 512 KiB.';
    }
    showRunsTextViewer(content, selectedTextFile || selectedGroupText, true);
  } catch (e) {
    showRunsTextViewer('Could not load text artifact: ' + e.message, '', false);
  }
}

function renderGroupFiles(batch, groupFiles) {
  const box = $('runs-group-files');
  if (!box) return;
  const htmlFiles = (groupFiles && groupFiles.html_files) || [];
  const textFiles = (groupFiles && groupFiles.text_files) || [];

  if (!htmlFiles.length && !textFiles.length) {
    box.innerHTML = '<div class="runs-group-empty">No batch-level files.</div>';
    return;
  }

  const htmlBtns = htmlFiles.map(fileName => {
    const cls = selectedGroupHtml === fileName ? ' active' : '';
    return `<button class="runs-file-btn runs-file-btn-group${cls}" data-ghtml="${esc(fileName)}">${esc(fileName)}</button>`;
  }).join('');
  const textBtns = textFiles.map(fileName => {
    const cls = selectedGroupText === fileName ? ' active' : '';
    return `<button class="runs-file-btn runs-file-btn-text${cls}" data-gtext="${esc(fileName)}">${esc(fileName)}</button>`;
  }).join('');

  box.innerHTML = `
    <div class="runs-files-label">BATCH HTML FILES</div>
    <div class="runs-run-files">${htmlBtns || '<div class="runs-no-files">None</div>'}</div>
    <div class="runs-files-label">BATCH TEXT FILES</div>
    <div class="runs-run-files">${textBtns || '<div class="runs-no-files">None</div>'}</div>
  `;

  box.querySelectorAll('[data-ghtml]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedGroupHtml = btn.dataset.ghtml || '';
      selectedGroupText = '';
      selectedRun = '';
      selectedRunFile = '';
      selectedTextFile = '';
      openSelectedRunHtml();
      renderGroupFiles(batch, groupFiles);
    });
  });

  box.querySelectorAll('[data-gtext]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedGroupText = btn.dataset.gtext || '';
      selectedGroupHtml = '';
      selectedRun = '';
      selectedRunFile = '';
      selectedTextFile = '';
      loadSelectedRunText();
      renderGroupFiles(batch, groupFiles);
    });
  });
}

function renderRunList(batch, runs) {
  const list = $('runs-run-list');
  const label = $('runs-selected-batch');
  if (!list || !label) return;
  label.textContent = 'RUNS: ' + batch;

  if (!runs.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🗂</div><div>No runs found in this batch.</div></div>';
    return;
  }

  list.innerHTML = runs.map(run => {
    const htmlItems = (run.html_files || []).map(fileName => {
      const cls = (selectedRun === run.run && selectedRunFile === fileName) ? ' active' : '';
      return `<button class="runs-file-btn${cls}" data-run="${esc(run.run)}" data-file="${esc(fileName)}">${esc(fileName)}</button>`;
    }).join('') || '<div class="runs-no-files">No HTML files</div>';

    const textItems = (run.text_files || []).map(fileName => {
      const cls = (selectedRun === run.run && selectedTextFile === fileName) ? ' active' : '';
      return `<button class="runs-file-btn runs-file-btn-text${cls}" data-run="${esc(run.run)}" data-tfile="${esc(fileName)}">${esc(fileName)}</button>`;
    }).join('') || '<div class="runs-no-files">No text files</div>';

    return `<article class="runs-run-card" data-run="${esc(run.run)}">
      <div class="runs-run-hdr">
        <div class="runs-run-title">${esc(run.run_name || run.run)}</div>
        <div class="runs-run-flags">${run.completed ? '<span class="runs-flag done">COMPLETE</span>' : '<span class="runs-flag">IN PROGRESS</span>'}</div>
      </div>
      <div class="runs-run-sub">${esc(run.run_id || run.run)}</div>
      <div class="runs-files-label">HTML</div>
      <div class="runs-run-files">${htmlItems}</div>
      <div class="runs-files-label">TEXT</div>
      <div class="runs-run-files">${textItems}</div>
    </article>`;
  }).join('');

  list.querySelectorAll('.runs-run-card').forEach(card => {
    card.addEventListener('click', () => {
      const run = card.dataset.run;
      if (!run || run === selectedRun) return;
      selectedRun = run;
      selectedRunFile = '';
      selectedTextFile = '';
      selectedGroupHtml = '';
      selectedGroupText = '';
      setRunsCurrentFile('No file selected');
      showRunsHtmlViewer('');
      fetchRunMeta(selectedBatch, selectedRun);
      renderRunList(selectedBatch, runs);
    });
  });

  list.querySelectorAll('.runs-file-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      selectedRun = btn.dataset.run || '';
      selectedRunFile = btn.dataset.file || '';
      selectedTextFile = '';
      selectedGroupHtml = '';
      selectedGroupText = '';
      openSelectedRunHtml();
      renderRunList(selectedBatch, runs);
    });
  });

  list.querySelectorAll('.runs-file-btn[data-tfile]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      selectedRun = btn.dataset.run || '';
      selectedTextFile = btn.dataset.tfile || '';
      selectedRunFile = '';
      selectedGroupHtml = '';
      selectedGroupText = '';
      loadSelectedRunText();
      renderRunList(selectedBatch, runs);
    });
  });
}

async function fetchRunsForBatch(batch) {
  const list = $('runs-run-list');
  if (!list) return;
  list.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading runs…</div>';
  try {
    const headers = cfg.authToken ? { Authorization: 'Bearer ' + cfg.authToken } : {};
    const params = new URLSearchParams({ batch });
    const r = await fetch(cfg.serverUrl + '/api/runs/list?' + params.toString(), {
      signal: AbortSignal.timeout(15000),
      headers,
    });
    const data = await r.json();
    if (!data.ok) {
      list.innerHTML = `<div class="empty-state" style="color:var(--danger)">${esc(data.err || 'Could not load runs')}</div>`;
      return;
    }
    const runs = data.runs || [];
    currentBatchRuns = runs;
    const groupFiles = data.group_files || { html_files: [], text_files: [] };
    if (!selectedRun || !runs.some(rn => rn.run === selectedRun)) {
      selectedRun = runs.length ? runs[0].run : '';
      selectedRunFile = '';
      selectedTextFile = '';
    }
    if (selectedGroupHtml && !(groupFiles.html_files || []).includes(selectedGroupHtml)) selectedGroupHtml = '';
    if (selectedGroupText && !(groupFiles.text_files || []).includes(selectedGroupText)) selectedGroupText = '';
    renderGroupFiles(batch, groupFiles);
    renderRunList(batch, runs);
    if (selectedRun) fetchRunMeta(batch, selectedRun);
  } catch (e) {
    currentBatchRuns = [];
    list.innerHTML = `<div class="empty-state" style="color:var(--danger)">${esc(e.message)}</div>`;
  }
}

function renderRunsSummary() {
  const tbody = $('runs-summary-tbody');
  if (!tbody) return;

  const filter = buildFilter(runsSearch);
  const visible = filter
    ? runsSummaryRows.filter(r => matchesFilter(filter, r.batch))
    : runsSummaryRows;

  animNum('runs-stat-batches', visible.length);
  animNum('runs-stat-runs', visible.reduce((s, r) => s + (parseInt(r.run_count, 10) || 0), 0));
  animNum('runs-stat-completed', visible.reduce((s, r) => s + (parseInt(r.completed_count, 10) || 0), 0));
  animNum('runs-stat-html', visible.reduce((s, r) => s + (parseInt(r.html_file_count, 10) || 0), 0));

  if (!visible.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4"><div class="empty-state"><div class="empty-icon">📁</div><div>No batch folders found.</div></div></td></tr>';
    updateSortableHeaders('#runs-summary-table', runsSummarySort);
    return;
  }

  const sorted = sortRows(visible, runsSummarySort, 'batch', 'string');
  tbody.innerHTML = sorted.map(row => {
    const active = row.batch === selectedBatch ? ' class="active"' : '';
    const lastModTs = Number(row.last_modified) || 0;
    const lastModDisplay = lastModTs ? relTime(new Date(lastModTs * 1000).toISOString()) : 'N/A';
    return `<tr data-batch="${esc(row.batch)}"${active}>
      <td title="${esc(row.batch)}">${esc(row.batch)}</td>
      <td>${esc(row.run_count)}</td>
      <td>${esc(row.completed_count)}</td>
      <td title="${esc(formatEpoch(row.last_modified))}">${esc(lastModDisplay)}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-batch]').forEach(row => {
    row.addEventListener('click', () => {
      selectedBatch = row.dataset.batch || '';
      selectedRun = '';
      selectedRunFile = '';
      selectedTextFile = '';
      selectedGroupHtml = '';
      selectedGroupText = '';
      renderRunsSummary();
      persistUiState();
      if (selectedBatch) fetchRunsForBatch(selectedBatch);
    });
  });

  updateSortableHeaders('#runs-summary-table', runsSummarySort);
}

async function fetchRunsSummary() {
  const tbody = $('runs-summary-tbody');
  if (tbody) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4"><div class="empty-state"><span class="spinner"></span> Loading…</div></td></tr>';
  }
  try {
    const headers = cfg.authToken ? { Authorization: 'Bearer ' + cfg.authToken } : {};
    const r = await fetch(cfg.serverUrl + '/api/runs/summary', {
      signal: AbortSignal.timeout(15000),
      headers,
    });
    const data = await r.json();
    if (!data.ok) {
      if (tbody) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="4"><div class="empty-state" style="color:var(--danger)">${esc(data.err || 'Could not scan scratch')}</div></td></tr>`;
      }
      return;
    }
    runsSummaryRows = data.data || [];
    if (!selectedBatch || !runsSummaryRows.some(rn => rn.batch === selectedBatch)) {
      selectedBatch = runsSummaryRows.length ? runsSummaryRows[0].batch : '';
      selectedRun = '';
      selectedRunFile = '';
      selectedTextFile = '';
      selectedGroupHtml = '';
      selectedGroupText = '';
    }
    renderRunsSummary();
    if (selectedBatch) fetchRunsForBatch(selectedBatch);
  } catch (e) {
    if (tbody) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="4"><div class="empty-state" style="color:var(--danger)">${esc(e.message)}</div></td></tr>`;
    }
  }
}


// ─────────────────────────────────────────
// FairShare
// ─────────────────────────────────────────
async function fetchShare() {
  const container = $('share-container');
  const out = $('share-output');
  out.innerHTML = `<span class="spinner"></span> Loading…`;
  if (cfg.demoMode) { shareRaw = DEMO_SSHARE; renderShareCards(shareRaw); return; }
  try {
    const headers = cfg.authToken ? { Authorization: 'Bearer ' + cfg.authToken } : {};
    const r = await fetch(cfg.serverUrl + '/api/sshare', { signal: AbortSignal.timeout(10000), headers });
    const data = await r.json();
    if (data.ok) { shareRaw = data.out || ''; renderShareCards(shareRaw); }
    else { container.innerHTML = `<div class="mono-output" style="color:var(--danger)">${esc(data.err)}</div>`; }
  } catch(e) { container.innerHTML = `<div class="mono-output" style="color:var(--danger)">Error: ${esc(e.message)}</div>`; }
}

// ─────────────────────────────────────────
// Node Info
// ─────────────────────────────────────────
function nodeStateClass(s) {
  if (!s) return '';
  const l = s.toLowerCase();
  if (l.includes('idle')) return 'node-idle';
  if (l.includes('alloc')) return 'node-alloc';
  if (l.includes('mix')) return 'node-mix';
  if (l.includes('down')) return 'node-down';
  if (l.includes('drain')) return 'node-drain';
  if (l.includes('comp')) return 'node-comp';
  return '';
}

async function fetchInfo() {
  const tbody = $('info-tbody');
  tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><span class="spinner"></span> Loading…</div></td></tr>`;
  if (cfg.demoMode) { renderInfo(DEMO_SINFO); return; }
  try {
    const headers = cfg.authToken ? { Authorization: 'Bearer ' + cfg.authToken } : {};
    const r = await fetch(cfg.serverUrl + '/api/sinfo', { signal: AbortSignal.timeout(10000), headers });
    const data = await r.json();
    if (!data.ok) { tbody.innerHTML = `<tr><td colspan="8" style="color:var(--danger);padding:20px">${esc(data.err)}</td></tr>`; return; }
    renderInfo(data.out);
  } catch(e) { tbody.innerHTML = `<tr><td colspan="8" style="color:var(--danger);padding:20px">${esc(e.message)}</td></tr>`; }
}

function renderInfo(raw) {
  const tbody = $('info-tbody');
  infoRows = (raw||'').trim().split('\n').filter(l=>l.trim()).map(line => {
    const [partition,avail,timelimit,nodes,state,nodelist,cpus,gres] = line.split('\t');
    return {partition:'',avail:'',timelimit:'',nodes:'',state:'',nodelist:'',cpus:'',gres:'',
      ...{partition,avail,timelimit,nodes,state,nodelist,cpus,gres}};
  });
  if (!infoRows.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div>No node data.</div></div></td></tr>`;
    updateSortableHeaders('#info-table', infoSort); return;
  }
  const rows = sortRows(infoRows, infoSort, 'partition', 'string');
  tbody.innerHTML = rows.map(row => {
    const sc = nodeStateClass(row.state);
    return `<tr><td>${esc(row.partition)}</td><td>${esc(row.avail)}</td><td>${esc(row.timelimit)}</td>
      <td>${esc(row.nodes)}</td><td class="${sc}">${esc(row.state)}</td>
      <td title="${esc(row.nodelist)}">${esc(row.nodelist.slice(0,30))}</td>
      <td>${esc(row.cpus)}</td><td>${esc(row.gres)}</td></tr>`;
  }).join('');
  updateSortableHeaders('#info-table', infoSort);
}

// ─────────────────────────────────────────
// GPU / CPU helpers (unchanged from original)
// ─────────────────────────────────────────
function parseScontrolLine(line) {
  const fields = {};
  const re = /([A-Za-z][A-Za-z0-9]*)=([^\s]+)/g;
  let match;
  while ((match = re.exec(line)) !== null) fields[match[1]] = match[2];
  return fields;
}

function parseTresGpuCount(tres) {
  if (!tres) return 0;
  return String(tres).split(',').reduce((sum, item) => {
    const [key, value] = item.split('=', 2);
    if (!key || value === undefined || !key.startsWith('gres/gpu')) return sum;
    return sum + (parseFloat(value) || 0);
  }, 0);
}

function parseTresCpuCount(tres) {
  if (!tres) return 0;
  return String(tres).split(',').reduce((sum, item) => {
    const [key, value] = item.split('=', 2);
    if (key !== 'cpu') return sum;
    return sum + (parseFloat(value) || 0);
  }, 0);
}

function parseGpuModel(gres) {
  const match = String(gres||'').match(/gpu:([^:,()]+)/i);
  return match ? match[1] : 'GPU';
}

function isOfflineNodeState(state) {
  const s = String(state||'').toLowerCase();
  return ['down','drain','drng','maint','fail','power_down','unknown','not_responding'].some(t=>s.includes(t));
}

function buildGpuRows(raw) {
  return (raw||'').trim().split('\n').filter(l=>l.trim()).map(line => {
    const row = parseScontrolLine(line);
    const total = parseTresGpuCount(row.CfgTRES);
    if (total <= 0) return null;
    const allocated = parseTresGpuCount(row.AllocTRES);
    const offline = isOfflineNodeState(row.State) ? total : 0;
    const active = offline ? 0 : Math.min(total, Math.max(0, allocated));
    const inactive = offline ? 0 : Math.max(0, total - active);
    return { node:row.NodeName||'unknown', partition:row.Partitions||'unknown',
      state:(row.State||'unknown').split('+')[0], active, inactive, offline, total, model:parseGpuModel(row.Gres) };
  }).filter(Boolean);
}

function summarizeGpuTypes(rows) {
  const byType = new Map();
  for (const row of rows) {
    const key = row.model||'GPU';
    if (!byType.has(key)) byType.set(key, {model:key,active:0,inactive:0,offline:0,total:0,nodes:0});
    const c = byType.get(key);
    c.active+=row.active||0; c.inactive+=row.inactive||0; c.offline+=row.offline||0; c.total+=row.total||0; c.nodes+=1;
  }
  return [...byType.values()].sort((a,b)=>b.total-a.total||a.model.localeCompare(b.model));
}

function renderGpuTypeBreakdown(rows) {
  const box = $('gpu-type-breakdown'); if (!box) return;
  if (!rows.length) { box.innerHTML=''; return; }
  const active=rows.reduce((s,r)=>s+(r.active||0),0);
  const inactive=rows.reduce((s,r)=>s+(r.inactive||0),0);
  const offline=rows.reduce((s,r)=>s+(r.offline||0),0);
  const total=rows.reduce((s,r)=>s+(r.total||0),0);
  const typeTotals=summarizeGpuTypes(rows);
  const allChip=`<button class="gpu-type-chip ${gpuTypeFilter==='ALL'?'active':''}" data-gpu-type="ALL"><span>ALL TYPES</span><span class="counts">A ${active} / I ${inactive} / O ${offline} / T ${total}</span></button>`;
  const typeChips=typeTotals.map(it=>`<button class="gpu-type-chip ${gpuTypeFilter===it.model?'active':''}" data-gpu-type="${esc(it.model)}"><span>${esc(it.model)} (${it.nodes})</span><span class="counts">A ${it.active} / I ${it.inactive} / O ${it.offline} / T ${it.total}</span></button>`).join('');
  box.innerHTML = allChip+typeChips;
}

function setupGpuTypeBreakdown() {
  const box=$('gpu-type-breakdown'); if(!box) return;
  box.addEventListener('click', e=>{
    const chip=e.target.closest('button[data-gpu-type]'); if(!chip) return;
    gpuTypeFilter=chip.dataset.gpuType||'ALL';
    renderGpuTypeBreakdown(gpuRows); renderGpuTable();
  });
}

function renderGpuTable() {
  const tbody=$('gpu-tbody');
  animNum('gpu-stat-active',  gpuRows.reduce((s,r)=>s+(r.active||0),0));
  animNum('gpu-stat-inactive',gpuRows.reduce((s,r)=>s+(r.inactive||0),0));
  animNum('gpu-stat-offline', gpuRows.reduce((s,r)=>s+(r.offline||0),0));
  animNum('gpu-stat-total',   gpuRows.reduce((s,r)=>s+(r.total||0),0));
  if (!gpuRows.length) {
    tbody.innerHTML=`<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">🎮</div><div>No GPU nodes found.</div></div></td></tr>`;
    updateSortableHeaders('#gpu-table',gpuSort); return;
  }
  const filtered=gpuTypeFilter==='ALL'?gpuRows:gpuRows.filter(r=>r.model===gpuTypeFilter);
  if (!filtered.length) {
    tbody.innerHTML=`<tr><td colspan="8"><div class="empty-state"><div>No nodes for GPU type ${esc(gpuTypeFilter)}.</div></div></td></tr>`;
    updateSortableHeaders('#gpu-table',gpuSort); return;
  }
  const rows=sortRows(filtered,gpuSort,'node','string');
  tbody.innerHTML=rows.map(row=>`<tr><td>${esc(row.node)}</td><td>${esc(row.partition)}</td>
    <td class="${nodeStateClass(row.state)}">${esc(row.state)}</td>
    <td>${esc(row.active)}</td><td>${esc(row.inactive)}</td><td>${esc(row.offline)}</td>
    <td>${esc(row.total)}</td><td>${esc(row.model)}</td></tr>`).join('');
  updateSortableHeaders('#gpu-table',gpuSort);
}

function renderGpuNodes(raw) {
  gpuRows=buildGpuRows(raw);
  const known=new Set(gpuRows.map(r=>r.model));
  if (gpuTypeFilter!=='ALL'&&!known.has(gpuTypeFilter)) gpuTypeFilter='ALL';
  renderGpuTypeBreakdown(gpuRows); renderGpuTable();
}

function buildCpuRows(raw) {
  return (raw||'').trim().split('\n').filter(l=>l.trim()).map(line=>{
    const row=parseScontrolLine(line);
    const total=parseTresCpuCount(row.CfgTRES); if(total<=0) return null;
    const allocated=parseTresCpuCount(row.AllocTRES);
    const offline=isOfflineNodeState(row.State)?total:0;
    const active=offline?0:Math.min(total,Math.max(0,allocated));
    const inactive=offline?0:Math.max(0,total-active);
    return {node:row.NodeName||'unknown',partition:row.Partitions||'unknown',
      state:(row.State||'unknown').split('+')[0],active,inactive,offline,total,arch:row.Arch||'unknown'};
  }).filter(Boolean);
}

function summarizeCpuTypes(rows) {
  const byType=new Map();
  for (const row of rows) {
    const key=row.arch||'unknown';
    if(!byType.has(key)) byType.set(key,{arch:key,active:0,inactive:0,offline:0,total:0,nodes:0});
    const c=byType.get(key);
    c.active+=row.active||0; c.inactive+=row.inactive||0; c.offline+=row.offline||0; c.total+=row.total||0; c.nodes+=1;
  }
  return [...byType.values()].sort((a,b)=>b.total-a.total||a.arch.localeCompare(b.arch));
}

function renderCpuTypeBreakdown(rows) {
  const box=$('cpu-type-breakdown'); if(!box) return;
  if(!rows.length){box.innerHTML='';return;}
  const active=rows.reduce((s,r)=>s+(r.active||0),0);
  const inactive=rows.reduce((s,r)=>s+(r.inactive||0),0);
  const offline=rows.reduce((s,r)=>s+(r.offline||0),0);
  const total=rows.reduce((s,r)=>s+(r.total||0),0);
  const typeTotals=summarizeCpuTypes(rows);
  const allChip=`<button class="gpu-type-chip ${cpuTypeFilter==='ALL'?'active':''}" data-cpu-type="ALL"><span>ALL ARCH</span><span class="counts">A ${active} / I ${inactive} / O ${offline} / T ${total}</span></button>`;
  const typeChips=typeTotals.map(it=>`<button class="gpu-type-chip ${cpuTypeFilter===it.arch?'active':''}" data-cpu-type="${esc(it.arch)}"><span>${esc(it.arch)} (${it.nodes})</span><span class="counts">A ${it.active} / I ${it.inactive} / O ${it.offline} / T ${it.total}</span></button>`).join('');
  box.innerHTML=allChip+typeChips;
}

function setupCpuTypeBreakdown() {
  const box=$('cpu-type-breakdown'); if(!box) return;
  box.addEventListener('click', e=>{
    const chip=e.target.closest('button[data-cpu-type]'); if(!chip) return;
    cpuTypeFilter=chip.dataset.cpuType||'ALL';
    renderCpuTypeBreakdown(cpuRows); renderCpuTable();
  });
}

function renderCpuTable() {
  const tbody=$('cpu-tbody');
  animNum('cpu-stat-active',  cpuRows.reduce((s,r)=>s+(r.active||0),0));
  animNum('cpu-stat-inactive',cpuRows.reduce((s,r)=>s+(r.inactive||0),0));
  animNum('cpu-stat-offline', cpuRows.reduce((s,r)=>s+(r.offline||0),0));
  animNum('cpu-stat-total',   cpuRows.reduce((s,r)=>s+(r.total||0),0));
  if(!cpuRows.length){
    tbody.innerHTML=`<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">🧠</div><div>No CPU nodes found.</div></div></td></tr>`;
    updateSortableHeaders('#cpu-table',cpuSort);return;
  }
  const filtered=cpuTypeFilter==='ALL'?cpuRows:cpuRows.filter(r=>r.arch===cpuTypeFilter);
  if(!filtered.length){
    tbody.innerHTML=`<tr><td colspan="8"><div class="empty-state"><div>No nodes for CPU arch ${esc(cpuTypeFilter)}.</div></div></td></tr>`;
    updateSortableHeaders('#cpu-table',cpuSort);return;
  }
  const rows=sortRows(filtered,cpuSort,'node','string');
  tbody.innerHTML=rows.map(row=>`<tr><td>${esc(row.node)}</td><td>${esc(row.partition)}</td>
    <td class="${nodeStateClass(row.state)}">${esc(row.state)}</td>
    <td>${esc(row.active)}</td><td>${esc(row.inactive)}</td><td>${esc(row.offline)}</td>
    <td>${esc(row.total)}</td><td>${esc(row.arch)}</td></tr>`).join('');
  updateSortableHeaders('#cpu-table',cpuSort);
}

function renderCpuNodes(raw) {
  cpuRows=buildCpuRows(raw);
  const known=new Set(cpuRows.map(r=>r.arch));
  if(cpuTypeFilter!=='ALL'&&!known.has(cpuTypeFilter)) cpuTypeFilter='ALL';
  renderCpuTypeBreakdown(cpuRows); renderCpuTable();
}

async function fetchCpuNodes() {
  const tbody=$('cpu-tbody');
  tbody.innerHTML=`<tr><td colspan="8"><div class="empty-state"><span class="spinner"></span> Loading…</div></td></tr>`;
  renderCpuTypeBreakdown([]); ['active','inactive','offline','total'].forEach(k=>animNum('cpu-stat-'+k,0));
  if(cfg.demoMode){renderCpuNodes(DEMO_CPU_NODES);return;}
  try {
    const headers=cfg.authToken?{Authorization:'Bearer '+cfg.authToken}:{};
    const r=await fetch(cfg.serverUrl+'/api/gpunodes',{signal:AbortSignal.timeout(10000),headers});
    const data=await r.json();
    if(!data.ok){tbody.innerHTML=`<tr><td colspan="8" style="color:var(--danger);padding:20px">${esc(data.err)}</td></tr>`;return;}
    renderCpuNodes(data.out||'');
  } catch(e){tbody.innerHTML=`<tr><td colspan="8" style="color:var(--danger);padding:20px">${esc(e.message)}</td></tr>`;}
}

async function fetchGpuNodes() {
  const tbody=$('gpu-tbody');
  tbody.innerHTML=`<tr><td colspan="8"><div class="empty-state"><span class="spinner"></span> Loading…</div></td></tr>`;
  renderGpuTypeBreakdown([]); ['active','inactive','offline','total'].forEach(k=>animNum('gpu-stat-'+k,0));
  if(cfg.demoMode){renderGpuNodes(DEMO_GPU_NODES);return;}
  try {
    const headers=cfg.authToken?{Authorization:'Bearer '+cfg.authToken}:{};
    const r=await fetch(cfg.serverUrl+'/api/gpunodes',{signal:AbortSignal.timeout(10000),headers});
    const data=await r.json();
    if(!data.ok){tbody.innerHTML=`<tr><td colspan="8" style="color:var(--danger);padding:20px">${esc(data.err)}</td></tr>`;return;}
    renderGpuNodes(data.out||'');
  } catch(e){tbody.innerHTML=`<tr><td colspan="8" style="color:var(--danger);padding:20px">${esc(e.message)}</td></tr>`;}
}


// ─────────────────────────────────────────
// History
// ─────────────────────────────────────────
async function fetchHistory() {
  const tbody=$('history-tbody');
  tbody.innerHTML=`<tr><td colspan="10"><div class="empty-state"><span class="spinner"></span> Loading…</div></td></tr>`;
  if(cfg.demoMode){renderHistory(DEMO_SACCT);return;}
  try {
    const headers=cfg.authToken?{Authorization:'Bearer '+cfg.authToken}:{};
    const r=await fetch(cfg.serverUrl+'/api/sacct',{signal:AbortSignal.timeout(15000),headers});
    const data=await r.json();
    if(!data.ok){tbody.innerHTML=`<tr><td colspan="10" style="color:var(--danger);padding:20px">${esc(data.err)}</td></tr>`;return;}
    renderHistory(data.out);
  } catch(e){tbody.innerHTML=`<tr><td colspan="10" style="color:var(--danger);padding:20px">${esc(e.message)}</td></tr>`;}
}

function parseDurationToSeconds(value) {
  const raw = String(value||'').trim();
  if (!raw) return Number.NaN;
  const [dayPart, timePart] = raw.includes('-') ? raw.split('-',2) : [null, raw];
  const segments = timePart.split(':').map(Number);
  if (segments.some(Number.isNaN)) return Number.NaN;
  let total = 0;
  if (segments.length === 3) total = segments[0]*3600+segments[1]*60+segments[2];
  else if (segments.length === 2) total = segments[0]*60+segments[1];
  else if (segments.length === 1) total = segments[0];
  if (dayPart !== null) { const days=Number(dayPart); if(Number.isNaN(days)) return Number.NaN; total+=days*86400; }
  return total;
}

function parseMemoryToBytes(value) {
  const raw = String(value||'').trim();
  const match = raw.match(/^([0-9]*\.?[0-9]+)\s*([KMGTP]?)(I?B?)?$/i);
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  const unit = (match[2]||'').toUpperCase();
  const powers = {'':0,K:1,M:2,G:3,T:4,P:5};
  return amount * (1024 ** (powers[unit] || 0));
}

function compareSortValues(a, b, type) {
  if (type === 'number') return (parseFloat(a)||0)-(parseFloat(b)||0);
  if (type === 'duration') return (parseDurationToSeconds(a)||0)-(parseDurationToSeconds(b)||0);
  if (type === 'datetime') return (Date.parse(a)||0)-(Date.parse(b)||0);
  if (type === 'memory') return (parseMemoryToBytes(a)||0)-(parseMemoryToBytes(b)||0);
  return String(a||'').localeCompare(String(b||''),undefined,{numeric:true,sensitivity:'base'});
}

function sortRows(rows, sortState, fallbackKey='jobid', fallbackType='number') {
  const {key,direction,type} = sortState;
  const df = direction==='asc'?1:-1;
  return [...rows].sort((l,r)=>{
    const p=compareSortValues(l[key],r[key],type);
    if(p!==0) return p*df;
    return compareSortValues(r[fallbackKey],l[fallbackKey],fallbackType);
  });
}

function updateSortableHeaders(tableSelector, sortState) {
  document.querySelectorAll(`${tableSelector} th.sortable`).forEach(th=>{
    const isActive=th.dataset.sortKey===sortState.key;
    th.classList.toggle('active-sort',isActive);
    th.dataset.sortIndicator=isActive?(sortState.direction==='asc'?'↑':'↓'):'↕';
    th.setAttribute('aria-sort',isActive?(sortState.direction==='asc'?'ascending':'descending'):'none');
  });
}

function setupTableSorting(tableSelector, sortState, onSort) {
  document.querySelectorAll(`${tableSelector} th.sortable`).forEach(th=>{
    th.addEventListener('click',()=>{
      const nextKey=th.dataset.sortKey, nextType=th.dataset.sortType||'string';
      if(sortState.key===nextKey) sortState.direction=sortState.direction==='asc'?'desc':'asc';
      else { sortState.key=nextKey; sortState.direction=nextKey==='jobid'?'desc':'asc'; }
      sortState.type=nextType;
      onSort();
      persistUiState();
    });
  });
}

function activatePanel(panelName, options = {}) {
  const panel = TAB_PANELS.includes(panelName) ? panelName : 'queue';
  if (activePanel === 'settings' && panel !== 'settings' && serverConfigDirty) {
    const leave = confirm('You have unsaved server config changes. Leave Settings anyway?');
    if (!leave) return;
  }
  const shouldFetch = options.fetch !== false;
  activePanel = panel;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + panel));

  if (shouldFetch) {
    if(panel==='share') fetchShare();
    else if(panel==='info') fetchInfo();
    else if(panel==='gpu') fetchGpuNodes();
    else if(panel==='cpu') fetchCpuNodes();
    else if(panel==='history') fetchHistory();
    else if(panel==='runs') fetchRunsSummary();
    else if(panel==='users') fetchUsersQueue();
    else if(panel==='metrics') fetchMetrics();
  }
  if (panel === 'settings' && !serverConfigLoadedOnce) {
    loadServerConfigFile({ silent: true });
  }
  persistUiState();
}

function parseHistoryRows(raw) {
  return (raw||'').trim().split('\n').filter(l=>l.trim()&&!l.startsWith('JobID')).map(line=>{
    const parts=line.split('|');
    const [jobid,name,state,elapsed,cputime,maxrss,partition,nodelist,submitted,,exitcode]=parts;
    if(!jobid||jobid.includes('.')) return null;
    return {
      jobid:jobid.trim(), name:(name||'').trim(), state:(state||'').trim(),
      elapsed:(elapsed||'').trim(), cputime:(cputime||'').trim(), maxrss:(maxrss||'').trim(),
      partition:(partition||'').trim(), nodelist:(nodelist||'').trim(),
      submitted:(submitted||'').trim(), exitcode:(exitcode||'').trim(),
    };
  }).filter(Boolean);
}

function renderHistoryTable() {
  const tbody=$('history-tbody');
  const filter=buildFilter(historySearch);
  const visible=filter
    ? historyRows.filter(j=>matchesFilter(filter,j.jobid,j.name,j.state,j.partition,j.nodelist))
    : historyRows;

  if (!visible.length) {
    tbody.innerHTML=`<tr><td colspan="10"><div class="empty-state"><div>${historyRows.length?'No jobs match the filter.':'No job history found.'}</div></div></td></tr>`;
    updateSortableHeaders('#history-table',historySort); return;
  }
  const rows=sortRows(visible,historySort);
  tbody.innerHTML=rows.slice(0,200).map(job=>{
    const sc='hist-'+(job.state||'').split(' ')[0].replace('+','').toUpperCase();
    const subRel=job.submitted?`<span title="${esc(job.submitted)}">${esc(relTime(job.submitted))}</span>`:esc('N/A');
    return `<tr><td>${esc(job.jobid)}</td>
      <td title="${esc(job.name)}">${esc(job.name.slice(0,20))}</td>
      <td class="${esc(sc)}">${esc(job.state)}</td>
      <td>${esc(job.elapsed)}</td><td>${esc(job.cputime)}</td>
      <td>${esc(job.maxrss)}</td><td>${esc(job.partition)}</td>
      <td>${esc(job.nodelist)}</td><td>${subRel}</td>
      <td>${esc(job.exitcode)}</td></tr>`;
  }).join('');
  updateSortableHeaders('#history-table',historySort);
}

function renderHistory(raw) {
  historyRows=parseHistoryRows(raw);
  renderHistoryTable();
}

function setupHistorySorting()  { setupTableSorting('#history-table',historySort,renderHistoryTable); }
function setupQueueSorting()    { setupTableSorting('#job-table',queueSort,()=>renderQueue(Object.values(prevJobs))); }
function setupInfoSorting() {
  setupTableSorting('#info-table',infoSort,()=>{
    if(infoRows.length) renderInfo(infoRows.map(r=>[r.partition,r.avail,r.timelimit,r.nodes,r.state,r.nodelist,r.cpus,r.gres].join('\t')).join('\n'));
    else updateSortableHeaders('#info-table',infoSort);
  });
}
function setupGpuSorting() { setupTableSorting('#gpu-table',gpuSort,renderGpuTable); }
function setupCpuSorting() { setupTableSorting('#cpu-table',cpuSort,renderCpuTable); }

// ─────────────────────────────────────────
// Users Queue
// ─────────────────────────────────────────
function parseUsersQueue(raw) {
  return raw.trim().split('\n').filter(l=>l.trim()).map(line=>{
    const parts=line.split('\t');
    const [jobid,name,partition,state,elapsed,timelimit,nodes,cpus,mem,nodelist,reason,priority,dependency,start]=parts;
    const user=(parts[14]||'unknown').trim();
    return {jobid,name,partition,state,elapsed,timelimit,nodes,cpus,mem,nodelist,reason,priority,dependency,start,user};
  });
}

function renderUsersPartitionChips(jobs) {
  const chipContainer=$('users-partition-chips'); if(!chipContainer) return;
  const partitionCounts=Object.create(null);
  for(const job of jobs) if(job.partition) partitionCounts[job.partition]=(partitionCounts[job.partition]||0)+1;
  const partitions=['ALL',...new Set(jobs.map(j=>j.partition).filter(Boolean).sort())];
  chipContainer.textContent='';
  partitions.forEach(p=>{
    const chip=document.createElement('button');
    chip.className=`gpu-type-chip${usersPartitionFilter===p?' active':''}`;
    chip.dataset.part=p;
    chip.appendChild(document.createTextNode(p));
    if(p!=='ALL'){const cnt=document.createElement('span');cnt.className='counts';cnt.textContent=partitionCounts[p]||0;chip.appendChild(cnt);}
    chip.addEventListener('click',()=>{usersPartitionFilter=chip.dataset.part;renderUsersPanel(usersRows);persistUiState();});
    chipContainer.appendChild(chip);
  });
}

function renderUsersPanel(jobs) {
  usersRows=jobs;
  const tree=$('users-tree'); if(!tree) return;
  renderUsersPartitionChips(jobs);
  const needle=usersSearch.trim().toLowerCase();
  let filtered=jobs;
  if(usersPartitionFilter!=='ALL') filtered=filtered.filter(j=>j.partition===usersPartitionFilter);
  if(needle) filtered=filtered.filter(j=>(j.user||'').toLowerCase().includes(needle)||(j.name||'').toLowerCase().includes(needle));
  const uniqueUsers=new Set(filtered.map(j=>j.user)).size;
  animNum('users-stat-users',uniqueUsers);
  animNum('users-stat-running',filtered.filter(j=>j.state==='RUNNING').length);
  animNum('users-stat-pending',filtered.filter(j=>j.state==='PENDING').length);
  animNum('users-stat-total',filtered.length);
  if(!filtered.length){
    tree.innerHTML=`<div class="empty-state"><div class="empty-icon">👥</div><div>${needle||usersPartitionFilter!=='ALL'?'No jobs match the current filter.':'No active jobs in queue.'}</div></div>`;
    return;
  }
  const byUser=Object.create(null);
  for(const j of filtered){
    if(!byUser[j.user]) byUser[j.user]={jobs:[],running:0,total:0};
    byUser[j.user].jobs.push(j); byUser[j.user].total++;
    if(j.state==='RUNNING') byUser[j.user].running++;
  }
  const sortedUsers=Object.entries(byUser).sort(([ua,a],[ub,b])=>{
    const rd=b.running-a.running; if(rd!==0) return rd;
    return b.total-a.total||ua.localeCompare(ub);
  });
  const html=sortedUsers.map(([user,{jobs:userJobs}])=>{
    const isExp=!!usersExpanded[user];
    const uR=userJobs.filter(j=>j.state==='RUNNING').length, uP=userJobs.filter(j=>j.state==='PENDING').length;
    const uO=userJobs.length-uR-uP;
    const uCpus=userJobs.reduce((s,j)=>s+(parseInt(j.cpus)||0),0);
    const uNodes=userJobs.reduce((s,j)=>s+(parseInt(j.nodes)||0),0);
    const uParts=[...new Set(userJobs.map(j=>j.partition))].join(', ');
    const chips=[
      uR?`<span class="user-chip running">▶ ${uR} running</span>`:'',
      uP?`<span class="user-chip pending">⏳ ${uP} pending</span>`:'',
      uO?`<span class="user-chip other">◉ ${uO} other</span>`:'',
      `<span class="user-chip cpus">⚙ ${uCpus} CPUs</span>`,
      `<span class="user-chip nodes">🖧 ${uNodes} nodes</span>`,
      `<span class="user-chip parts">${esc(uParts)}</span>`,
    ].filter(Boolean).join('');
    const byName=Object.create(null);
    for(const j of userJobs){if(!byName[j.name]) byName[j.name]=[];byName[j.name].push(j);}
    const sortedNames=Object.entries(byName).sort(([na,ja],[nb,jb])=>
      jb.filter(j=>j.state==='RUNNING').length-ja.filter(j=>j.state==='RUNNING').length||jb.length-ja.length||na.localeCompare(nb));
    const nameGroupsHtml=sortedNames.map(([name,nameJobs])=>{
      const key=user+'\0'+name, isNE=!!usersJobNameExpanded[key];
      const nR=nameJobs.filter(j=>j.state==='RUNNING').length, nP=nameJobs.filter(j=>j.state==='PENDING').length;
      const nO=nameJobs.length-nR-nP;
      const nCpus=nameJobs.reduce((s,j)=>s+(parseInt(j.cpus)||0),0);
      const nNodes=nameJobs.reduce((s,j)=>s+(parseInt(j.nodes)||0),0);
      const nameChips=[nR?`<span class="user-chip running">▶ ${nR}</span>`:'',nP?`<span class="user-chip pending">⏳ ${nP}</span>`:'',nO?`<span class="user-chip other">◉ ${nO}</span>`:'',`<span class="user-chip cpus">⚙ ${nCpus}</span>`,`<span class="user-chip nodes">🖧 ${nNodes}</span>`].filter(Boolean).join('');
      const jobRows=nameJobs.map(j=>{
        const prio=parseFloat(j.priority)||0;
        const prioClass=prio>0.9?'high':prio<0.5?'low':'';
        const prioLabel=j.priority&&j.priority!=='N/A'&&j.priority!=='0'?`<span class="priority-chip ${prioClass}">${esc(j.priority)}</span>`:'';
        const reasonOrPrio=(j.reason&&j.reason!=='None')?esc(j.reason):prioLabel;
        return `<tr><td>${esc(j.jobid)}</td><td>${esc(j.partition)}</td><td>${stateBadge(j.state)}</td><td>${esc(j.elapsed)}</td><td>${esc(j.timelimit)}</td><td>${esc(j.nodes)}</td><td>${esc(j.cpus)}</td><td>${esc(j.mem)}</td><td title="${esc(j.nodelist)}">${esc(j.nodelist&&j.nodelist!=='N/A'?j.nodelist.slice(0,24):j.nodelist)}</td><td>${reasonOrPrio}</td></tr>`;
      }).join('');
      return `<div class="job-name-group${isNE?' expanded':''}" data-user="${esc(user)}" data-name="${esc(name)}"><div class="job-name-group-hdr" role="button" tabindex="0" aria-expanded="${isNE}"><span class="job-name-expand-arrow">▶</span><span class="job-name-label">${esc(name)}</span><span class="job-name-chips">${nameChips}</span></div><div class="job-name-group-body"><table class="users-jobs-table"><thead><tr><th>JOB ID</th><th>PARTITION</th><th>STATE</th><th>ELAPSED</th><th>LIMIT</th><th>NODES</th><th>CPUS</th><th>MEM</th><th>NODELIST</th><th>REASON / PRIORITY</th></tr></thead><tbody>${jobRows}</tbody></table></div></div>`;
    }).join('');
    return `<div class="user-group${isExp?' expanded':''}" data-user="${esc(user)}"><div class="user-group-hdr" role="button" tabindex="0" aria-expanded="${isExp}"><span class="user-expand-arrow">▶</span><span class="user-name-label">${esc(user)}</span><span class="user-summary-chips">${chips}</span></div><div class="user-group-body">${nameGroupsHtml}</div></div>`;
  }).join('');
  tree.innerHTML=html;
  tree.querySelectorAll('.user-group-hdr').forEach(hdr=>{
    const toggle=()=>{const g=hdr.closest('.user-group'),u=g.dataset.user;usersExpanded[u]=!usersExpanded[u];g.classList.toggle('expanded',usersExpanded[u]);hdr.setAttribute('aria-expanded',usersExpanded[u]);};
    hdr.addEventListener('click',toggle);
    hdr.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;e.preventDefault();toggle();});
  });
  tree.querySelectorAll('.job-name-group-hdr').forEach(hdr=>{
    const toggle=()=>{const g=hdr.closest('.job-name-group'),u=g.dataset.user,n=g.dataset.name,k=u+'\0'+n;usersJobNameExpanded[k]=!usersJobNameExpanded[k];g.classList.toggle('expanded',usersJobNameExpanded[k]);hdr.setAttribute('aria-expanded',usersJobNameExpanded[k]);};
    hdr.addEventListener('click',toggle);
    hdr.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;e.preventDefault();toggle();});
  });
}

async function fetchUsersQueue() {
  const tree=$('users-tree');
  if(tree) tree.innerHTML=`<div class="empty-state"><span class="spinner"></span> Loading…</div>`;
  if(cfg.demoMode){renderUsersPanel(parseUsersQueue(DEMO_SQUEUE_USERS));return;}
  try {
    const headers=cfg.authToken?{Authorization:'Bearer '+cfg.authToken}:{};
    const r=await fetch(cfg.serverUrl+'/api/squeueall',{signal:AbortSignal.timeout(10000),headers});
    const data=await r.json();
    if(!data.ok){if(tree) tree.innerHTML=`<div class="empty-state" style="color:var(--danger)">${esc(data.err||'squeue error')}</div>`;return;}
    renderUsersPanel(parseUsersQueue(data.out||''));
  } catch(e){if(tree) tree.innerHTML=`<div class="empty-state" style="color:var(--danger)">${esc(e.message)}</div>`;}
}


// ─────────────────────────────────────────
// Job Submit
// ─────────────────────────────────────────
async function submitJob() {
  const btn = $('btn-submit-job');
  const result = $('submit-result');
  const params = getSubmitFormValues();
  const script = params.script;
  const validationError = validateSubmitParams(params);
  if (validationError) {
    if (result) {
      result.style.display='';
      result.className='submit-result err';
      result.textContent=validationError;
    }
    toast(validationError, 'warn', '⚠️');
    return;
  }
  btn.disabled = true; btn.textContent = '⏳ SUBMITTING…';
  if (result) { result.style.display='none'; result.className='submit-result'; }
  if (cfg.demoMode) {
    setTimeout(()=>{ btn.disabled=false; btn.textContent='🚀 SUBMIT JOB';
      if(result){result.style.display='';result.className='submit-result ok';result.textContent='Submitted batch job 999999 (demo mode)';}
      toast('Job submitted (demo)', 'success', '🚀');
    }, 800); return;
  }
  try {
    const headers = { 'Content-Type':'application/json', ...(cfg.authToken?{Authorization:'Bearer '+cfg.authToken}:{}) };
    const r = await fetch(cfg.serverUrl+'/api/sbatch', { method:'POST', headers, body:JSON.stringify(params), signal:AbortSignal.timeout(35000) });
    const data = await r.json();
    if (result) { result.style.display=''; result.className='submit-result '+(data.ok?'ok':'err'); result.textContent=(data.ok?data.out:data.err)||''; }
    if (data.ok) { toast('Job submitted successfully', 'success', '🚀'); setTimeout(fetchQueue, 1000); }
    else toast('Submit failed: '+data.err, 'danger', '❌');
  } catch(e) {
    if(result){result.style.display='';result.className='submit-result err';result.textContent=e.message;}
    toast('Error: '+e.message, 'danger', '❌');
  } finally { btn.disabled=false; btn.textContent='🚀 SUBMIT JOB'; }
}

// ─────────────────────────────────────────
// Metrics chart
// ─────────────────────────────────────────
async function fetchMetrics() {
  const canvas = $('metrics-canvas');
  const noData = $('metrics-nodata');
  const partitionBox = $('metrics-partitions');
  if (!canvas) return;
  if (cfg.demoMode) {
    if(noData) {
      noData.style.display = '';
      noData.textContent = 'Metrics not available in demo mode.';
    }
    if (partitionBox) partitionBox.innerHTML = '';
    return;
  }
  try {
    const headers = cfg.authToken?{Authorization:'Bearer '+cfg.authToken}:{};
    const r = await fetch(cfg.serverUrl+'/api/metrics', { signal:AbortSignal.timeout(8000), headers });
    const data = await r.json();
    if (!data.ok || !data.data || !data.data.length) {
      if(noData) {
        noData.style.display = '';
        noData.textContent = data.err || 'No metrics data yet.';
      }
      if (partitionBox) partitionBox.innerHTML = '';
      return;
    }
    if(noData) noData.style.display = 'none';
    renderMetricsPartitions(data.partitions || {});
    const partitionData = metricsPartition === 'ALL'
      ? data.data
      : ((data.partitions || {})[metricsPartition] || []);
    renderMetricsChart(canvas, partitionData, metricsPartition);
  } catch(e) {
    if(noData) {
      noData.style.display = '';
      noData.textContent = 'Could not load metrics: '+e.message;
    }
  }
}

function renderMetricsPartitions(partitions) {
  const box = $('metrics-partitions');
  if (!box) return;
  const names = ['ALL', ...Object.keys(partitions || {}).sort((a, b) => a.localeCompare(b))];
  if (!names.includes(metricsPartition)) metricsPartition = 'ALL';
  box.innerHTML = names.map(name => {
    const active = metricsPartition === name ? ' active' : '';
    const count = name === 'ALL' ? '' : `<span class="counts">${(partitions[name] || []).length}</span>`;
    return `<button class="gpu-type-chip${active}" data-metrics-part="${esc(name)}">${esc(name)}${count}</button>`;
  }).join('');
  box.querySelectorAll('[data-metrics-part]').forEach(btn => {
    btn.addEventListener('click', () => {
      metricsPartition = btn.dataset.metricsPart || 'ALL';
      persistUiState();
      fetchMetrics();
    });
  });
}

function renderMetricsChart(canvas, data, label = 'ALL') {
  const W = canvas.offsetWidth || 600, H = canvas.offsetHeight || 200;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const isDark = document.documentElement.dataset.theme !== 'light';
  ctx.clearRect(0,0,W,H);
  if (!data || !data.length) {
    ctx.fillStyle = isDark ? '#8ca4bc' : '#48627b';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`No metrics for ${label}`, W / 2, H / 2);
    return;
  }
  const pad = {top:16, right:16, bottom:32, left:44};
  const cw = W - pad.left - pad.right, ch = H - pad.top - pad.bottom;
  const maxVal = Math.max(...data.map(d=>d.total), 1);
  function xPos(i) { return pad.left + (i/(data.length-1||1))*cw; }
  function yPos(v) { return pad.top + ch - (v/maxVal)*ch; }
  const colors = { running:'#00ff9d', pending:'#ffcc00', total:'#00e5ff' };
  [['total','#00e5ff'],['pending','#ffcc00'],['running','#00ff9d']].forEach(([key,color])=>{
    ctx.beginPath();
    data.forEach((d,i)=>{
      const x=xPos(i), y=yPos(d[key]);
      i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    });
    ctx.strokeStyle=color; ctx.lineWidth=2; ctx.stroke();
  });
  // X-axis labels (first and last timestamp)
  ctx.fillStyle=isDark?'#7799bb':'#3a5a7a'; ctx.font='10px monospace'; ctx.textAlign='center';
  if(data.length>1){
    const fmt=ts=>new Date(ts*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    ctx.fillText(fmt(data[0].ts), pad.left, H-6);
    ctx.fillText(fmt(data[data.length-1].ts), W-pad.right, H-6);
  }
  // Y-axis max
  ctx.textAlign='right';
  ctx.fillText(maxVal, pad.left-4, pad.top+6);
  ctx.fillText('0', pad.left-4, pad.top+ch);
  // Legend
  const items=[[label === 'ALL' ? 'TOTAL QUEUE' : label,'#00e5ff'],['PENDING','#ffcc00'],['RUNNING','#00ff9d']];
  items.forEach(([label,color],i)=>{
    const lx=pad.left+i*90, ly=pad.top-2;
    ctx.fillStyle=color; ctx.fillRect(lx,ly,12,8);
    ctx.fillStyle=isDark?'#ddeeff':'#1a2a3a'; ctx.textAlign='left'; ctx.font='10px monospace';
    ctx.fillText(label,lx+16,ly+8);
  });
}

// ─────────────────────────────────────────
// FairShare parsing & rendering
// ─────────────────────────────────────────
function parseSshare(raw) {
  const lines=raw.trim().split('\n').filter(l=>l.trim()&&!l.includes('---'));
  if(!lines.length) return {accounts:[],users:[]};
  const accounts={}, users=[];
  for(const line of lines){
    const parts=line.trim().split(/\s+/);
    if(parts.length<5) continue;
    const [account,user,rawShares,normShares,rawUsage,effUse,fairShare]=parts;
    const isAccount=user==='parent'||(user&&rawShares&&normShares!=='NormShares'&&!user.match(/^\d+/));
    if(account&&!accounts[account]) accounts[account]={name:account,rawShares:parseFloat(rawShares)||0,normShares:parseFloat(normShares)||0,rawUsage:parseFloat(rawUsage)||0,effUse:parseFloat(effUse)||0,fairShare:parseFloat(fairShare)||0,users:[]};
    if(!isAccount&&user&&user!==account&&user!=='User'){
      const share=parseInt(rawShares)||0;
      users.push({account,user,shares:share,fairShare:parseFloat(fairShare)||0});
      if(accounts[account]) accounts[account].users.push({user,shares:share,fairShare:parseFloat(fairShare)||0});
    }
  }
  return {accounts:Object.values(accounts),users};
}

function sortShareAccounts(accounts) {
  const dir=shareSort.direction==='asc'?1:-1, key=shareSort.key;
  return [...accounts].sort((l,r)=>{
    const lv=key==='userCount'?l.users.length:l[key], rv=key==='userCount'?r.users.length:r[key];
    const cmp=typeof lv==='string'?String(lv||'').localeCompare(String(rv||''),undefined,{sensitivity:'base'}):(Number(lv)||0)-(Number(rv)||0);
    if(cmp!==0) return cmp*dir;
    return String(l.name||'').localeCompare(String(r.name||''),undefined,{sensitivity:'base'});
  });
}

function syncShareSortControls() {
  const f=$('share-filter'),k=$('share-sort-key'),d=$('btn-share-sort-dir');
  if(f) f.value=shareFilter;
  if(k) k.value=shareSort.key;
  if(d) d.textContent=shareSort.direction==='asc'?'↑ ASC':'↓ DESC';
  const warn = $('share-warn-threshold');
  const critical = $('share-critical-threshold');
  if (warn) warn.value = shareWarnThreshold.toFixed(2);
  if (critical) critical.value = shareCriticalThreshold.toFixed(2);
}

function renderShareCards(raw) {
  const container=$('share-container');
  const {accounts}=parseSshare(raw);
  if(!accounts.length){container.innerHTML=`<div class="mono-output">${esc(raw)}</div>`;return;}
  const needle=shareFilter.trim().toLowerCase();
  const filtered=accounts.map(acc=>{
    const su=[...acc.users].sort((l,r)=>(r.fairShare||0)-(l.fairShare||0)||(r.shares||0)-(l.shares||0));
    const vu=needle?su.filter(u=>u.user.toLowerCase().includes(needle)):su;
    const am=acc.name.toLowerCase().includes(needle);
    if(needle&&!am&&!vu.length) return null;
    return {...acc,users:am?su:vu};
  }).filter(Boolean);
  const sorted=sortShareAccounts(filtered);
  const warnCount = sorted.filter(acc => classifyFairshare(acc) === 'warn').length;
  const criticalCount = sorted.filter(acc => classifyFairshare(acc) === 'critical').length;
  if(!sorted.length){container.innerHTML=`<div style="padding:16px"><div class="empty-state"><div class="empty-icon">🔎</div><div>No fairshare matches for "${esc(shareFilter)}".</div></div></div>`;syncShareSortControls();return;}
  container.innerHTML=`<div style="padding:16px"><div class="share-toolbar"><span class="share-toolbar-label">SORTING LIVE VIEW</span><span class="share-summary">${sorted.length} of ${accounts.length} accounts • ${criticalCount} critical • ${warnCount} warning</span></div><div class="fairshare-container">${sorted.map(acc=>{
    const severity=classifyFairshare(acc);
    const riskChip=severity==='critical'?'<span class="account-risk critical">CRITICAL</span>':severity==='warn'?'<span class="account-risk warn">WATCH</span>':'';
    return `<div class="account-card ${severity==='ok'?'':severity}"><div class="card-header"><div class="card-title">${esc(acc.name)}</div><div style="display:flex;gap:6px;align-items:center">${riskChip}<span class="priority-chip ${acc.fairShare>=0.75?'high':''}">${acc.users.length} users</span></div></div><div class="card-meta"><div class="metric-col"><div class="metric-label">RAW SHARES</div><div class="metric-val">${acc.rawShares.toFixed(2)}</div></div><div class="metric-col"><div class="metric-label">NORM SHARES</div><div class="metric-val">${acc.normShares.toFixed(4)}</div></div></div><div class="progress-row"><div class="progress-label"><span>FAIRSHARE</span><span>${(acc.fairShare*100).toFixed(1)}%</span></div><div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100,acc.fairShare*100)}%"></div></div></div><div class="progress-row"><div class="progress-label"><span>USAGE</span><span>${(acc.effUse*100).toFixed(1)}%</span></div><div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100,acc.effUse*100)}%;background:linear-gradient(90deg,#ff9500,#ff4466)"></div></div></div>${acc.users.length?`<div class="user-list">${acc.users.map(u=>{
      const userSeverity=classifyFairshare(u);
      return `<div class="user-item ${userSeverity==='ok'?'':userSeverity}"><span class="user-name">${esc(u.user)}</span><span class="user-share"><span>${u.shares} shares</span><span class="user-fairshare">${((u.fairShare||0)*100).toFixed(1)}%</span></span></div>`;
    }).join('')}</div>`:''}</div>`;
  }).join('')}</div></div>`;
  syncShareSortControls();
}

// ─────────────────────────────────────────
// Job Modal
// ─────────────────────────────────────────
let currentJobDetail = null;

function openJobModal(job) {
  currentJobDetail = job;
  populateJobModal(job);
  $('job-modal').classList.add('active');
  const output = $('modal-output-preview');
  if (output) output.textContent = 'Click LOAD OUTPUT to fetch recent stdout/stderr lines.';
  if (modalRefreshTimer) clearInterval(modalRefreshTimer);
  modalRefreshTimer = setInterval(() => {
    if (!currentJobDetail || !$('job-modal').classList.contains('active')) return;
    const latest = prevJobs[currentJobDetail.jobid];
    if (latest) {
      currentJobDetail = latest;
      populateJobModal(latest);
    }
  }, 5000);
}

function closeJobModal() {
  $('job-modal').classList.remove('active');
  currentJobDetail = null;
  if (modalRefreshTimer) {
    clearInterval(modalRefreshTimer);
    modalRefreshTimer = null;
  }
}

function populateJobModal(job) {
  $('modal-job-id').textContent = `JOB ${job.jobid}`;
  $('modal-jid').textContent = job.jobid;
  $('modal-name').textContent = job.name;
  $('modal-state').innerHTML = stateBadge(job.state);
  $('modal-partition').textContent = job.partition;
  $('modal-nodes').textContent = job.nodes;
  $('modal-cpus').textContent = job.cpus;
  $('modal-mem').textContent = job.mem;
  $('modal-nodelist').textContent = job.nodelist||'N/A';
  $('modal-elapsed').textContent = job.elapsed;
  $('modal-timelimit').textContent = job.timelimit;
  const qPosEl = $('modal-queue-pos');
  if (qPosEl) {
    qPosEl.textContent = job.state === 'PENDING' && Number.isFinite(job.queuePosition)
      ? `#${job.queuePosition} (${job.partition})`
      : 'N/A';
  }
  const estEl = $('modal-est-start');
  if (estEl) {
    if (job.state === 'RUNNING' && job.start && job.start !== 'N/A') {
      estEl.textContent = 'Already running';
    } else {
      estEl.textContent = job.state === 'PENDING' ? formatEta(job.queueEtaSeconds) : 'N/A';
    }
  }
  const startEl = $('modal-start');
  if (startEl) {
    if (job.start && job.start !== 'N/A') {
      startEl.innerHTML = `<span title="${esc(job.start)}">${esc(relTime(job.start))}</span>`;
    } else { startEl.textContent = 'N/A'; }
  }
  $('modal-priority').textContent = job.priority||'N/A';
  $('modal-reason').textContent = job.reason||'None';
  // Dependency
  const depGroup = $('modal-dep-group');
  const depRow = $('modal-dep-row');
  const deps = parseDependency(job.dependency);
  if (depGroup && depRow) {
    if (deps) {
      depGroup.style.display = '';
      depRow.innerHTML = deps.map(seg =>
        `<span class="dep-type">${esc(seg.type)}</span> ` +
        seg.ids.map(id=>`<span class="dep-jobid" title="Job ${esc(id)}">${esc(id)}</span>`).join(' ')
      ).join(' → ');
    } else { depGroup.style.display = 'none'; }
  }
  const cancelBtn = $('modal-btn-cancel');
  const canCancel = ['RUNNING','PENDING','SUSPENDED'].includes(job.state);
  cancelBtn.disabled = !canCancel;
  cancelBtn.textContent = '❌ CANCEL';
  cancelBtn.style.opacity = canCancel ? '1' : '0.5';
}

async function loadJobOutputPreview() {
  if (!currentJobDetail) return;
  const out = $('modal-output-preview');
  const btn = $('modal-btn-output');
  if (!out || !btn) return;

  if (cfg.demoMode) {
    out.textContent = `Demo output for job ${currentJobDetail.jobid}\n[INFO] Mock run is active\n[INFO] Step 1 complete\n[WARN] This is demo data`;
    return;
  }

  const jid = currentJobDetail.jobid;
  btn.disabled = true;
  btn.textContent = '⏳ LOADING…';
  out.textContent = 'Loading output preview...';
  try {
    const headers = cfg.authToken ? { Authorization: 'Bearer ' + cfg.authToken } : {};
    const r = await fetch(
      cfg.serverUrl + '/api/job-output?jobid=' + encodeURIComponent(jid),
      { signal: AbortSignal.timeout(10000), headers },
    );
    const data = await r.json();
    if (!data.ok) {
      out.textContent = `Could not load output preview: ${data.err || 'Unknown error'}`;
      return;
    }

    const sections = [];
    const stdout = data.stdout || {};
    const stderr = data.stderr || {};

    sections.push(`STDOUT: ${stdout.exists ? (stdout.path || '(path unknown)') : 'not found'}`);
    if (stdout.exists && stdout.content) {
      sections.push(stdout.truncated ? '[tail preview]\n' + stdout.content : stdout.content);
    } else if (stdout.err) {
      sections.push(`(error reading stdout: ${stdout.err})`);
    }

    sections.push('\n' + '='.repeat(80) + '\n');
    sections.push(`STDERR: ${stderr.exists ? (stderr.path || '(path unknown)') : 'not found'}`);
    if (stderr.exists && stderr.content) {
      sections.push(stderr.truncated ? '[tail preview]\n' + stderr.content : stderr.content);
    } else if (stderr.err) {
      sections.push(`(error reading stderr: ${stderr.err})`);
    }

    out.textContent = sections.join('\n');
  } catch (e) {
    out.textContent = `Error loading output preview: ${e.message || e}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '📄 LOAD OUTPUT';
  }
}

async function cancelJob() {
  if (!currentJobDetail) return;
  const jid = currentJobDetail.jobid;
  if (!confirm(`Cancel job ${jid}? This action cannot be undone.`)) return;
  const btn = $('modal-btn-cancel');
  btn.disabled = true; btn.textContent = '⏳ CANCELLING…';
  if (cfg.demoMode) {
    _demoJobs = _demoJobs.filter(j=>j.jobid!==jid);
    toast(`Job ${jid} cancelled (demo mode)`, 'success', '✅');
    setTimeout(closeJobModal, 500); fetchQueue(); return;
  }
  try {
    const headers={'Content-Type':'application/json',...(cfg.authToken?{Authorization:'Bearer '+cfg.authToken}:{})};
    const r=await fetch(cfg.serverUrl+'/api/scancel',{method:'POST',headers,body:JSON.stringify({jobid:jid}),signal:AbortSignal.timeout(8000)});
    const data=await r.json();
    if(data.ok){toast(`Job ${jid} cancelled successfully`,'success','✅');setTimeout(closeJobModal,500);fetchQueue();}
    else{toast(`Failed to cancel: ${data.err}`,'danger','❌');btn.disabled=false;btn.textContent='❌ CANCEL';}
  } catch(e){toast(`Error: ${e.message}`,'danger','❌');btn.disabled=false;btn.textContent='❌ CANCEL';}
}

function setupRowClickHandlers() {
  const tbody=$('job-tbody');
  tbody.addEventListener('click',e=>{
    const row=e.target.closest('tr[data-jid]'); if(!row) return;
    const job=prevJobs[row.dataset.jid]; if(job) openJobModal(job);
  });
}


// ─────────────────────────────────────────
// Demo data
// ─────────────────────────────────────────
const PARTITIONS=['gpu','cpu','bigmem','debug','preemptible'];
const NAMES=['train_v3','data_proc','finetune','eval_run','batch_inf','preprocess','feature_eng','sweep_001','experiment','baseline'];
let _demoJobs=[
  {jobid:'112001',name:'train_v3',   partition:'gpu',state:'RUNNING', elapsed:'03:12:44',timelimit:'8:00:00',nodes:'2',cpus:'32',mem:'64G', nodelist:'gpu[01-02]',reason:'None',priority:'0.998',dependency:'N/A',start:'2024-01-15T09:00:00'},
  {jobid:'112002',name:'data_proc',  partition:'cpu',state:'RUNNING', elapsed:'00:45:18',timelimit:'2:00:00',nodes:'1',cpus:'8', mem:'16G', nodelist:'cn42',      reason:'None',priority:'0.975',dependency:'N/A',start:'2024-01-15T12:00:00'},
  {jobid:'112003',name:'finetune',   partition:'gpu',state:'PENDING', elapsed:'0:00:00', timelimit:'4:00:00',nodes:'4',cpus:'64',mem:'128G',nodelist:'N/A',       reason:'Resources',priority:'0.921',dependency:'afterok:112001',start:'N/A'},
  {jobid:'112004',name:'eval_run',   partition:'cpu',state:'PENDING', elapsed:'0:00:00', timelimit:'1:00:00',nodes:'1',cpus:'4', mem:'8G',  nodelist:'N/A',       reason:'Priority', priority:'0.834',dependency:'N/A',start:'N/A'},
];
let _demoTick=0, _demoNextId=112010;

const DEMO_SSHARE=`     Account       User  RawShares  NormShares  RawUsage  EffectvUsage  FairShare
---------- ---------- ---------- ----------- --------- ------------- ----------
      root                         1.000000         0      0.000000   0.500000
      root       root     parent    1.000000         0      0.000000   0.500000
    biolab                         0.200000   1234567      0.180000   0.542000
    biolab      alice          5    0.050000    987654      0.145000   0.620000
    biolab        bob          5    0.050000    246801      0.036000   0.880000
  mlresearch                       0.450000   3456789      0.505000   0.473000
  mlresearch    carol         20    0.200000   2345678      0.342000   0.389000
  mlresearch    david         10    0.100000   1111111      0.162000   0.452000
  mlresearch      eve          5    0.050000         0      0.000000   1.000000
    sysops                         0.350000    500000      0.073000   0.785000
    sysops     frank         10    0.100000    499999      0.073000   0.789000`;

const DEMO_SINFO=['gpu*\tup\t8:00:00\t8\tidle\tgpu[01-08]\t0/64/0/64\tgpu:a100:8','gpu*\tup\t8:00:00\t4\talloc\tgpu[09-12]\t32/0/0/32\tgpu:a100:4','cpu\tup\t48:00:00\t20\tidle\tcn[01-20]\t0/320/0/320\t(null)','cpu\tup\t48:00:00\t5\tmix\tcn[21-25]\t80/20/0/100\t(null)','bigmem\tup\t72:00:00\t4\tidle\tbm[01-04]\t0/256/0/256\t(null)','debug\tup\t1:00:00\t2\tidle\tdbg[01-02]\t0/16/0/16\t(null)','preemptible\tup\t24:00:00\t3\tdown\tpre[01-03]\t0/0/24/24\t(null)'].join('\n');

const DEMO_SACCT=['111990|train_v2|COMPLETED|02:34:15|02:33:41|24576K|gpu|gpu[01-02]|2024-01-15T06:00:00|2024-01-15T08:34:15|0:0','111985|baseline |FAILED   |00:12:03|00:12:01|8192K |cpu|cn10      |2024-01-15T05:00:00|2024-01-15T05:12:03|1:0','111980|sweep_001|COMPLETED|01:00:00|00:59:55|16384K|gpu|gpu05     |2024-01-15T04:00:00|2024-01-15T05:00:00|0:0','111975|preprocess|CANCELLED|00:05:10|00:05:08|4096K |cpu|cn22     |2024-01-15T03:00:00|2024-01-15T03:05:10|0:0','111970|eval_run |COMPLETED|00:30:00|00:29:45|12288K|cpu|cn05      |2024-01-15T02:00:00|2024-01-15T02:30:00|0:0'].join('\n');

const DEMO_GPU_NODES=['NodeName=gpu01 Arch=x86_64 CoresPerSocket=32 RealMemory=515000 State=IDLE ThreadsPerCore=1 TmpDisk=0 Weight=1 Owner=N/A MCS_label=N/A Partitions=gpu CfgTRES=cpu=64,mem=515000M,billing=64,gres/gpu:a100=8 AllocTRES= Gres=gpu:a100:8','NodeName=gpu02 Arch=x86_64 CoresPerSocket=32 RealMemory=515000 State=MIXED ThreadsPerCore=1 TmpDisk=0 Weight=1 Owner=N/A MCS_label=N/A Partitions=gpu CfgTRES=cpu=64,mem=515000M,billing=64,gres/gpu:a100=8 AllocTRES=cpu=40,mem=220000M,gres/gpu:a100=5 Gres=gpu:a100:8','NodeName=gpu03 Arch=x86_64 CoresPerSocket=32 RealMemory=515000 State=ALLOCATED ThreadsPerCore=1 TmpDisk=0 Weight=1 Owner=N/A MCS_label=N/A Partitions=gpu CfgTRES=cpu=64,mem=515000M,billing=64,gres/gpu:a100=8 AllocTRES=cpu=64,mem=500000M,gres/gpu:a100=8 Gres=gpu:a100:8','NodeName=gpu04 Arch=x86_64 CoresPerSocket=32 RealMemory=515000 State=DOWN+DRAIN ThreadsPerCore=1 TmpDisk=0 Weight=1 Owner=N/A MCS_label=N/A Partitions=gpu CfgTRES=cpu=64,mem=515000M,billing=64,gres/gpu:a100=8 AllocTRES= Gres=gpu:a100:8'].join('\n');

const DEMO_CPU_NODES=['NodeName=cn01 Arch=x86_64 CoresPerSocket=32 RealMemory=257000 State=IDLE CfgTRES=cpu=64,mem=257000M,billing=64 AllocTRES=cpu=0,mem=0M','NodeName=cn02 Arch=x86_64 CoresPerSocket=32 RealMemory=257000 State=MIXED CfgTRES=cpu=64,mem=257000M,billing=64 AllocTRES=cpu=38,mem=110000M','NodeName=cn03 Arch=x86_64 CoresPerSocket=32 RealMemory=257000 State=ALLOCATED CfgTRES=cpu=64,mem=257000M,billing=64 AllocTRES=cpu=64,mem=220000M','NodeName=cn04 Arch=aarch64 CoresPerSocket=48 RealMemory=257000 State=IDLE Partitions=bigmem CfgTRES=cpu=96,mem=257000M,billing=96 AllocTRES=cpu=24,mem=70000M','NodeName=cn05 Arch=aarch64 CoresPerSocket=48 RealMemory=257000 State=DOWN+DRAIN Partitions=bigmem CfgTRES=cpu=96,mem=257000M,billing=96 AllocTRES=cpu=0,mem=0M'].join('\n');

const DEMO_SQUEUE_USERS=[
  '112001\ttrain_v3\tgpu\tRUNNING\t03:12:44\t8:00:00\t2\t32\t64G\tgpu[01-02]\tNone\t0.998\tN/A\t2024-01-15T09:00:00\talice',
  '112002\ttrain_v3\tgpu\tRUNNING\t01:05:12\t8:00:00\t1\t16\t32G\tgpu03\tNone\t0.997\tN/A\t2024-01-15T11:00:00\talice',
  '112003\tfinetune\tgpu\tPENDING\t0:00:00\t4:00:00\t4\t64\t128G\tN/A\tResources\t0.921\tafterok:112001\tN/A\talice',
  '112004\teval_run\tcpu\tRUNNING\t00:45:00\t2:00:00\t1\t8\t16G\tcn42\tNone\t0.975\tN/A\t2024-01-15T12:00:00\talice',
  '112010\tdata_proc\tcpu\tRUNNING\t02:10:00\t6:00:00\t2\t16\t32G\tcn[10-11]\tNone\t0.960\tN/A\t2024-01-15T10:00:00\tbob',
  '112011\tdata_proc\tcpu\tPENDING\t0:00:00\t6:00:00\t2\t16\t32G\tN/A\tPriority\t0.850\tN/A\tN/A\tbob',
  '112012\tsweep_001\tgpu\tRUNNING\t00:30:00\t12:00:00\t4\t64\t128G\tgpu[01-04]\tNone\t0.990\tN/A\t2024-01-15T12:30:00\tbob',
  '112020\tbatch_inf\tgpu\tRUNNING\t01:00:00\t4:00:00\t1\t8\t32G\tgpu05\tNone\t0.955\tN/A\t2024-01-15T11:30:00\tcarol',
  '112021\tbatch_inf\tgpu\tPENDING\t0:00:00\t4:00:00\t1\t8\t32G\tN/A\tResources\t0.940\tafterok:112020\tN/A\tcarol',
  '112030\tbatch_inf\tgpu\tRUNNING\t00:15:00\t8:00:00\t2\t32\t64G\tgpu[03-04]\tNone\t0.980\tN/A\t2024-01-15T12:45:00\tdavid',
  '112031\tbatch_inf\tgpu\tPENDING\t0:00:00\t8:00:00\t2\t32\t64G\tN/A\tResources\t0.965\tN/A\tN/A\tdavid',
  '112032\tfeature_eng\tcpu\tPENDING\t0:00:00\t3:00:00\t1\t8\t16G\tN/A\tPriority\t0.800\tN/A\tN/A\tdavid',
].join('\n');

function demoNextTick() {
  _demoTick++;
  if(_demoTick%8===0){const p=_demoJobs.find(j=>j.state==='PENDING');if(p){p.state='RUNNING';p.elapsed='0:00:01';p.nodelist='cn'+String(10+Math.floor(Math.random()*30));p.reason='None';}}
  if(_demoTick%12===0){const run=_demoJobs.filter(j=>j.state==='RUNNING');if(run.length>1){const idx=Math.floor(Math.random()*run.length);_demoJobs=_demoJobs.filter(j=>j.jobid!==run[idx].jobid);}}
  if(_demoTick%20===0&&Math.random()<0.35){const run=_demoJobs.filter(j=>j.state==='RUNNING');if(run.length){const v=run[Math.floor(Math.random()*run.length)];v.state='FAILED';setTimeout(()=>{_demoJobs=_demoJobs.filter(j=>j.jobid!==v.jobid);},3000);}}
  if(_demoTick%15===0){_demoNextId++;_demoJobs.push({jobid:String(_demoNextId),name:NAMES[Math.floor(Math.random()*NAMES.length)],partition:PARTITIONS[Math.floor(Math.random()*PARTITIONS.length)],state:'PENDING',elapsed:'0:00:00',timelimit:`${1+Math.floor(Math.random()*23)}:00:00`,nodes:String(1<<Math.floor(Math.random()*3)),cpus:String([4,8,16,32,64][Math.floor(Math.random()*5)]),mem:['8G','16G','32G','64G','128G'][Math.floor(Math.random()*5)],nodelist:'N/A',reason:'Resources',priority:(0.5+Math.random()*0.5).toFixed(3),dependency:'N/A',start:'N/A'});}
  _demoJobs.forEach(j=>{if(j.state==='RUNNING'){const p=j.elapsed.split(':').map(Number);let[h,m,s]=p.length===3?p:[0,p[0]||0,p[1]||0];s+=cfg.refreshInterval;m+=Math.floor(s/60);s%=60;h+=Math.floor(m/60);m%=60;j.elapsed=`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;}});
  return [..._demoJobs];
}

// ─────────────────────────────────────────
// Keyboard shortcuts
// ─────────────────────────────────────────
const TAB_PANELS=['queue','share','info','gpu','cpu','history','runs','users','settings','submit','metrics'];

document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return;
  if (e.ctrlKey||e.metaKey||e.altKey) return;
  switch(e.key) {
    case 'Escape':
      if ($('job-modal').classList.contains('active')) { closeJobModal(); e.preventDefault(); }
      document.querySelectorAll('.drop-wrap.open').forEach(d=>d.classList.remove('open'));
      break;
    case 'r': case 'R':
      if (!$('job-modal').classList.contains('active')) { countdown=cfg.refreshInterval; fetchQueue(); e.preventDefault(); }
      break;
    case '/':
      { const s=$('queue-search'); if(s){s.focus();e.preventDefault();} }
      break;
    case 'n': case 'N':
      requestNotifPermission(); e.preventDefault();
      break;
    default:
      if (e.key>='1'&&e.key<='9') {
        const idx=parseInt(e.key)-1;
        const tabs=document.querySelectorAll('.tab');
        const visibleTabs=[...tabs].filter(t=>t.offsetParent!==null);
        if (idx<visibleTabs.length) { visibleTabs[idx].click(); e.preventDefault(); }
      }
  }
});

// ─────────────────────────────────────────
// Tab navigation
// ─────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    activatePanel(btn.dataset.panel);
  });
});

// ─────────────────────────────────────────
// Button wiring
// ─────────────────────────────────────────
$('btn-refresh').onclick = ()=>{countdown=cfg.refreshInterval;fetchQueue();};
$('btn-refresh-share').onclick = fetchShare;
$('btn-refresh-info').onclick = fetchInfo;
$('btn-refresh-gpu').onclick = fetchGpuNodes;
$('btn-refresh-cpu').onclick = fetchCpuNodes;
$('btn-refresh-history').onclick = fetchHistory;
$('btn-refresh-runs').onclick = fetchRunsSummary;
$('btn-refresh-users').onclick = fetchUsersQueue;
$('users-search').oninput = function(){usersSearch=this.value;renderUsersPanel(usersRows);persistUiState();};
$('runs-search').oninput = function(){runsSearch=this.value;renderRunsSummary();persistUiState();};
$('runs-open-mode').onchange = function(){runsOpenMode=this.value;localStorage.setItem(RUNS_MODE_KEY, runsOpenMode);persistUiState();};
$('btn-runs-open-selected').onclick = openSelectedRunHtml;
$('btn-runs-load-text').onclick = loadSelectedRunText;
$('btn-runs-expand').onclick = toggleRunsViewerExpanded;
$('share-filter').oninput = function(){shareFilter=this.value;if(shareRaw)renderShareCards(shareRaw);persistUiState();};
$('share-sort-key').onchange = function(){shareSort.key=this.value;if(shareRaw)renderShareCards(shareRaw);persistUiState();};
$('btn-share-sort-dir').onclick=()=>{shareSort.direction=shareSort.direction==='asc'?'desc':'asc';if(shareRaw)renderShareCards(shareRaw);persistUiState();};
const shareWarnInput = $('share-warn-threshold');
if (shareWarnInput) shareWarnInput.onchange = function(){
  shareWarnThreshold = Math.max(0, Math.min(1, Number(this.value) || 0.6));
  if (shareCriticalThreshold > shareWarnThreshold) shareCriticalThreshold = shareWarnThreshold;
  saveShareThresholds();
  syncShareSortControls();
  if (shareRaw) renderShareCards(shareRaw);
};
const shareCriticalInput = $('share-critical-threshold');
if (shareCriticalInput) shareCriticalInput.onchange = function(){
  shareCriticalThreshold = Math.max(0, Math.min(shareWarnThreshold, Number(this.value) || 0.3));
  saveShareThresholds();
  syncShareSortControls();
  if (shareRaw) renderShareCards(shareRaw);
};

const qSearchEl=$('queue-search');
if(qSearchEl) qSearchEl.oninput=function(){queueSearch=this.value;renderQueue(Object.values(prevJobs));persistUiState();};
const hSearchEl=$('history-search');
if(hSearchEl) hSearchEl.oninput=function(){historySearch=this.value;renderHistoryTable();persistUiState();};

$('cfg-refresh').oninput=function(){$('cfg-refresh-val').textContent=this.value+'s';};
$('btn-demo').onclick=()=>{cfg.demoMode=true;$('btn-demo').classList.add('active');$('btn-live').classList.remove('active');setStatus('demo');};
$('btn-live').onclick=()=>{cfg.demoMode=false;$('btn-live').classList.add('active');$('btn-demo').classList.remove('active');setStatus('connecting');fetchServerCapabilities();};

$('btn-save').onclick=()=>{
  cfg.serverUrl=$('cfg-server').value.trim()||'http://localhost:8787';
  cfg.refreshInterval=Math.max(1, Math.min(3600, parseInt($('cfg-refresh').value, 10) || 5));
  cfg.animations=$('cfg-anim').checked;
  cfg.sounds=$('cfg-sounds').checked;
  cfg.desktopNotif=($('cfg-notif')||{}).checked||false;
  cfg.webhookUrl=($('cfg-webhook')||{}).value||'';
  cfg.authToken=($('cfg-auth-token')||{}).value||'';
  localStorage.setItem(CFG_KEY,JSON.stringify(cfg));
  startRefreshCycle();
  toast('Settings saved!','success','💾');
  activatePanel('queue');
};

const themeBtn=$('btn-theme');
if(themeBtn) themeBtn.onclick=toggleTheme;
const notifBtn=$('btn-notif');
if(notifBtn) notifBtn.onclick=requestNotifPermission;
const submitBtn=$('btn-submit-job');
if(submitBtn) submitBtn.onclick=submitJob;
const testConnBtn = $('btn-test-connection');
if (testConnBtn) testConnBtn.onclick = testServerConnection;
const loadCfgBtn = $('btn-load-server-config');
if (loadCfgBtn) loadCfgBtn.onclick = loadServerConfigFile;
const saveCfgBtn = $('btn-save-server-config');
if (saveCfgBtn) saveCfgBtn.onclick = saveServerConfigFile;
const cfgJsonEditor = $('cfg-server-json');
if (cfgJsonEditor) cfgJsonEditor.addEventListener('input', trackServerConfigEditorDirty);
if (cfgJsonEditor) cfgJsonEditor.addEventListener('blur', () => syncServerConfigFormFromJson({ silent: true }));
const cfgSyncFormBtn = $('btn-server-config-sync-from-json');
if (cfgSyncFormBtn) cfgSyncFormBtn.onclick = () => syncServerConfigFormFromJson({ silent: false });
const cfgApplyFormBtn = $('btn-server-config-apply-form');
if (cfgApplyFormBtn) cfgApplyFormBtn.onclick = applyServerConfigFormToJson;
populateServerConfigForm();
const submitTemplateLoadBtn = $('btn-submit-template-load');
if (submitTemplateLoadBtn) submitTemplateLoadBtn.onclick = loadSubmitTemplate;
const submitTemplateSaveBtn = $('btn-submit-template-save');
if (submitTemplateSaveBtn) submitTemplateSaveBtn.onclick = saveCurrentAsSubmitTemplate;
const submitTemplateDeleteBtn = $('btn-submit-template-delete');
if (submitTemplateDeleteBtn) submitTemplateDeleteBtn.onclick = deleteSelectedSubmitTemplate;

// Export dropdowns
setupDropdown('btn-export-queue','drop-export-queue');
setupDropdown('btn-export-history','drop-export-history');
setupDropdown('btn-col-toggle','drop-col-toggle');

document.querySelectorAll('[data-export-queue]').forEach(btn=>{
  btn.addEventListener('click',()=>exportQueue(btn.dataset.exportQueue));
});
document.querySelectorAll('[data-export-history]').forEach(btn=>{
  btn.addEventListener('click',()=>exportHistory(btn.dataset.exportHistory));
});

// Close modal on overlay click
$('job-modal').addEventListener('click',e=>{if(e.target===$('job-modal')) closeJobModal();});

// Modal close button
const modalCloseBtn=document.querySelector('.modal-close-btn');
if(modalCloseBtn) modalCloseBtn.onclick=closeJobModal;
const modalCancelBtn=$('modal-btn-cancel');
if(modalCancelBtn) modalCancelBtn.onclick=cancelJob;
const modalDetailsBtn=$('modal-btn-details');
if(modalDetailsBtn) modalDetailsBtn.onclick=()=>{
  if (!currentJobDetail) return;
  const latest = prevJobs[currentJobDetail.jobid];
  if (latest) {
    currentJobDetail = latest;
    populateJobModal(latest);
    toast(`Refreshed job ${latest.jobid}`, 'info', '↻', 1800);
  } else {
    toast('Job is no longer in current queue view', 'warn', 'ℹ️', 2200);
  }
};
const modalOutputBtn = $('modal-btn-output');
if (modalOutputBtn) modalOutputBtn.onclick = loadJobOutputPreview;

// Populate settings
applyInitialUiState();
$('cfg-server').value=cfg.serverUrl;
$('cfg-refresh').value=cfg.refreshInterval;
$('cfg-refresh-val').textContent=cfg.refreshInterval+'s';
$('cfg-anim').checked=cfg.animations;
$('cfg-sounds').checked=cfg.sounds;
if($('cfg-notif')) $('cfg-notif').checked=cfg.desktopNotif||false;
if($('cfg-webhook')) $('cfg-webhook').value=cfg.webhookUrl||'';
if($('cfg-auth-token')) $('cfg-auth-token').value=cfg.authToken||'';
syncUiControlsFromState();
renderSubmitTemplates();
updateRunsExpandButton();
syncShareSortControls();
if(cfg.demoMode){$('btn-demo').classList.add('active');$('btn-live').classList.remove('active');}
else{$('btn-live').classList.add('active');$('btn-demo').classList.remove('active');}

// Col visibility menu
buildColToggleMenu();

// Init
setStatus(cfg.demoMode?'demo':'connecting');
fetchQueue();
setupRowClickHandlers();
setupQueueSorting();
setupInfoSorting();
setupGpuSorting();
setupGpuTypeBreakdown();
setupCpuSorting();
setupCpuTypeBreakdown();
setupHistorySorting();
setupTableSorting('#runs-summary-table', runsSummarySort, renderRunsSummary);
startRefreshCycle();
updateSubmitVisibility();
if(!cfg.demoMode) fetchServerCapabilities();
activatePanel(activePanel, { fetch: activePanel !== 'queue' });

setTimeout(()=>toast('Welcome to slurmSight Mission Control!','purple','🚀',4000), 800);
