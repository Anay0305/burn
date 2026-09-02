'use strict';

const AGENT_META = {
  'claude-code': { label: 'Claude Code', color: '--s1' },
  codex: { label: 'Codex', color: '--s2' },
  opencode: { label: 'OpenCode', color: '--s3' },
};
const FALLBACK_COLOR = '--s4';

const state = {
  snap: null,
  rangeSec: 900,
  mode: 'all',       // 'all' | 'out'
  agentFilter: null, // null = all
  meterBase: null,   // { cost, atMs, perMs } — odometer interpolation
};

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- formatting ----------
function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K';
  if (n >= 1000) return Math.round(n).toLocaleString('en-US');
  return String(Math.round(n));
}
function fmtMoney(x) {
  if (x >= 100) return '$' + Math.round(x).toLocaleString('en-US');
  if (x >= 10) return '$' + x.toFixed(1);
  if (x >= 1) return '$' + x.toFixed(2);
  if (x >= 0.01) return '$' + x.toFixed(3);
  if (x > 0) return '$' + x.toFixed(4);
  return '$0';
}
function fmtMeter(x) {
  return '$' + x.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
function fmtAgo(t, now) {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 10) return 'now';
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(1) + 'h';
}
function fmtClock(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// ---------- data shaping ----------
function rollingSeries(bucketArr) {
  const out = new Array(bucketArr.length).fill(0);
  let sum = 0;
  for (let i = 0; i < bucketArr.length; i++) {
    sum += bucketArr[i];
    if (i >= 6) sum -= bucketArr[i - 6];
    out[i] = sum;
  }
  return out;
}
function agentColor(agent) {
  return css((AGENT_META[agent] || { color: FALLBACK_COLOR }).color);
}
function agentLabel(agent) {
  return (AGENT_META[agent] || { label: agent }).label;
}
function buildSeries(metricPick) {
  const b = state.snap.buckets;
  const agents = Object.keys(b.agents).sort();
  const nWant = Math.floor((state.rangeSec * 1000) / b.stepMs);
  const from = b.n - Math.min(nWant, b.n);
  return {
    start: b.start + from * b.stepMs,
    stepMs: b.stepMs,
    series: agents.map((a) => ({
      agent: a,
      label: agentLabel(a),
      color: agentColor(a),
      values: rollingSeries(metricPick(b.agents[a])).slice(from),
    })),
  };
}

// ---------- chart ----------
function niceTicks(max, count = 3) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}
const svgNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs) {
  const e = document.createElementNS(svgNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

const charts = {};

function renderChart(plotId, data, fmtValue) {
  const plot = $(plotId);
  const W = plot.clientWidth || 500;
  const H = plot.clientHeight || 216;
  const M = { l: 52, r: 16, t: 10, b: 22 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const allVals = data.series.flatMap((s) => s.values);
  const max = Math.max(0, ...allVals);
  const ticks = niceTicks(max * 1.05 || 1);
  const yMax = ticks[ticks.length - 1];
  const n = data.series[0] ? data.series[0].values.length : 0;

  const x = (i) => M.l + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v) => M.t + ih - (v / yMax) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });

  for (const t of ticks) {
    svg.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: y(t), y2: y(t), stroke: css('--grid'), 'stroke-width': 1 }));
    const lbl = el('text', { x: M.l - 8, y: y(t) + 4, 'text-anchor': 'end', fill: css('--muted'), 'font-size': 10.5 });
    lbl.textContent = fmtValue(t, true);
    svg.appendChild(lbl);
  }
  svg.appendChild(el('line', { x1: M.l, x2: W - M.r, y1: y(0), y2: y(0), stroke: css('--baseline'), 'stroke-width': 1 }));

  for (let k = 0; k <= 3; k++) {
    const i = Math.round((k / 3) * (n - 1));
    if (i < 0) continue;
    const lbl = el('text', {
      x: x(i), y: H - 5, 'text-anchor': k === 0 ? 'start' : k === 3 ? 'end' : 'middle',
      fill: css('--muted'), 'font-size': 10.5,
    });
    lbl.textContent = fmtClock(data.start + i * data.stepMs);
    svg.appendChild(lbl);
  }

  // series: faint wash + 2px line + end marker with surface ring
  for (const s of data.series) {
    if (!s.values.length) continue;
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    svg.appendChild(el('polygon', {
      points: `${M.l},${y(0)} ${pts} ${x(n - 1)},${y(0)}`, fill: s.color, opacity: 0.08,
    }));
    svg.appendChild(el('polyline', {
      points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    svg.appendChild(el('circle', {
      cx: x(n - 1), cy: y(s.values[n - 1]), r: 4, fill: s.color,
      stroke: css('--surface'), 'stroke-width': 2,
    }));
  }

  const cross = el('g', {});
  svg.appendChild(cross);
  plot.replaceChildren(svg);

  if (max === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No activity in this window yet';
    plot.appendChild(empty);
  }

  charts[plotId] = { data, fmtValue, W, H, M, iw, n, x, y };
  svg.addEventListener('pointermove', (ev) => onHover(plotId, svg, cross, ev));
  svg.addEventListener('pointerleave', () => {
    cross.replaceChildren();
    $('tooltip').hidden = true;
  });
}

function onHover(plotId, svg, cross, ev) {
  const c = charts[plotId];
  if (!c || c.n < 2) return;
  const rect = svg.getBoundingClientRect();
  const px = ((ev.clientX - rect.left) / rect.width) * c.W;
  const i = Math.max(0, Math.min(c.n - 1, Math.round(((px - c.M.l) / c.iw) * (c.n - 1))));
  const cx = c.x(i);

  cross.replaceChildren(
    el('line', { x1: cx, x2: cx, y1: c.M.t, y2: c.M.t + (c.H - c.M.t - c.M.b), stroke: css('--baseline'), 'stroke-width': 1 })
  );
  for (const s of c.data.series) {
    cross.appendChild(el('circle', {
      cx, cy: c.y(s.values[i]), r: 4, fill: s.color,
      stroke: css('--surface'), 'stroke-width': 2,
    }));
  }

  const tt = $('tooltip');
  tt.replaceChildren();
  const time = document.createElement('div');
  time.className = 'tt-time';
  time.textContent = fmtClock(c.data.start + i * c.data.stepMs);
  tt.appendChild(time);
  for (const s of c.data.series) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('i');
    key.style.background = s.color;
    const val = document.createElement('b');
    val.textContent = c.fmtValue(s.values[i], false);
    const name = document.createElement('span');
    name.textContent = s.label;
    row.append(key, val, name);
    tt.appendChild(row);
  }
  tt.hidden = false;
  const pad = 14;
  let left = ev.clientX + pad;
  if (left + tt.offsetWidth > window.innerWidth - 8) left = ev.clientX - tt.offsetWidth - pad;
  tt.style.left = left + 'px';
  tt.style.top = Math.min(window.innerHeight - tt.offsetHeight - 8, ev.clientY + pad) + 'px';
}

// Legend doubles as the live readout: key stroke, name, current value.
function renderLegend(id, series, fmtValue) {
  const box = $(id);
  box.replaceChildren();
  if (series.length < 2) return;
  for (const s of series) {
    const k = document.createElement('span');
    k.className = 'key';
    const i = document.createElement('i');
    i.style.background = s.color;
    const t = document.createElement('span');
    t.textContent = s.label;
    const v = document.createElement('b');
    v.textContent = fmtValue(s.values[s.values.length - 1] || 0, true);
    k.append(i, t, v);
    box.appendChild(k);
  }
}

// ---------- sparkline ($/min, last 12 min) ----------
function renderSpark() {
  const b = state.snap.buckets;
  const total = new Array(b.n).fill(0);
  for (const a of Object.values(b.agents)) {
    for (let i = 0; i < b.n; i++) total[i] += a.cost[i];
  }
  const pts = rollingSeries(total).slice(-72); // 12 min at 10s steps
  const max = Math.max(...pts, 1e-9);
  const svg = $('sparkCost');
  svg.replaceChildren();
  const xs = (i) => (i / (pts.length - 1)) * 114 + 3;
  const ys = (v) => 23 - (v / max) * 19;
  svg.appendChild(el('polyline', {
    points: pts.map((v, i) => `${xs(i)},${ys(v)}`).join(' '),
    fill: 'none', stroke: css('--muted'), 'stroke-width': 1.5,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  svg.appendChild(el('circle', { cx: xs(pts.length - 1), cy: ys(pts[pts.length - 1]), r: 2.5, fill: css('--ink') }));
}

// ---------- sessions ----------
function renderChips() {
  const box = $('agentChips');
  const agents = [...new Set(state.snap.sessions.map((s) => s.agent))].sort();
  box.replaceChildren();
  if (agents.length < 2) { state.agentFilter = null; return; }
  const mk = (label, value) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = state.agentFilter === value ? 'on' : '';
    btn.setAttribute('aria-pressed', String(state.agentFilter === value));
    btn.addEventListener('click', () => {
      state.agentFilter = value;
      renderChips();
      renderTable();
    });
    return btn;
  };
  box.appendChild(mk('All', null));
  for (const a of agents) box.appendChild(mk(agentLabel(a), a));
}

function renderTable() {
  const tbody = $('sessions').querySelector('tbody');
  tbody.replaceChildren();
  const now = state.snap.now;
  const rows = state.snap.sessions.filter((s) => !state.agentFilter || s.agent === state.agentFilter);
  const maxCost = Math.max(...rows.map((s) => s.cost), 1e-9);
  for (const s of rows) {
    const tr = document.createElement('tr');
    if (!s.active) tr.className = 'idle';

    const tdAgent = document.createElement('td');
    const key = document.createElement('span');
    key.className = 'agent-key';
    const dot = document.createElement('i');
    dot.style.background = agentColor(s.agent);
    const nm = document.createElement('span');
    nm.textContent = agentLabel(s.agent);
    key.append(dot, nm);
    tdAgent.appendChild(key);

    const tdProj = document.createElement('td');
    tdProj.textContent = s.cwd ? s.cwd.split('/').slice(-2).join('/') : s.session.slice(0, 8);
    tdProj.title = s.cwd || s.session;

    const tdModel = document.createElement('td');
    const model = document.createElement('span');
    model.className = 'model';
    model.textContent = s.model || '—';
    tdModel.appendChild(model);

    const mk = (txt, strong) => {
      const td = document.createElement('td');
      td.className = 'num' + (strong ? ' strong' : '');
      td.textContent = txt;
      return td;
    };

    const tdCost = document.createElement('td');
    tdCost.className = 'num strong cost-cell';
    const costVal = document.createElement('span');
    costVal.textContent = s.unpriced && s.cost === 0 ? '—' : fmtMoney(s.cost);
    const bar = document.createElement('span');
    bar.className = 'cost-bar';
    const fill = document.createElement('i');
    fill.style.width = Math.max(2, (s.cost / maxCost) * 100).toFixed(1) + '%';
    bar.appendChild(fill);
    tdCost.append(costVal, bar);

    const tdAgo = document.createElement('td');
    tdAgo.className = 'num';
    tdAgo.dataset.t = String(s.lastT);
    tdAgo.textContent = fmtAgo(s.lastT, now);

    tr.append(
      tdAgent, tdProj, tdModel,
      mk(s.outPerSec >= 0.05 ? s.outPerSec.toFixed(1) : '·', s.outPerSec >= 0.05),
      mk(s.costPerMin >= 0.0005 ? fmtMoney(s.costPerMin) : '·', s.costPerMin >= 0.0005),
      mk(fmtTok(s.tokens)),
      tdCost,
      tdAgo
    );
    tbody.appendChild(tr);
  }
}

// ---------- top-level render ----------
function render() {
  if (!state.snap) return;
  const r = state.snap.rates;

  state.meterBase = {
    cost: state.snap.today.cost,
    atMs: performance.now(),
    perMs: Math.max(0, r.costPerMin60) / 60000,
  };
  $('meter').textContent = fmtMeter(state.snap.today.cost);

  const sub = $('heroSub');
  sub.replaceChildren();
  const parts = [
    [fmtTok(state.snap.today.tokens), ' tokens'],
    [fmtTok(state.snap.today.out), ' output'],
    [String(state.snap.activeSessions), ' active session' + (state.snap.activeSessions === 1 ? '' : 's')],
  ];
  parts.forEach(([strong, rest], i) => {
    if (i) sub.appendChild(document.createTextNode('  ·  '));
    const b = document.createElement('b');
    b.textContent = strong;
    sub.append(b, document.createTextNode(rest));
  });

  $('rCostMin').textContent = fmtMoney(r.costPerMin60);
  $('rTokMin').textContent = fmtTok(r.tokensPerMin60);
  $('rOutSec').textContent = r.outPerSec10 >= 10 ? String(Math.round(r.outPerSec10)) : r.outPerSec10.toFixed(1);

  document.title = r.costPerMin60 >= 0.005 ? `${fmtMoney(r.costPerMin60)}/min · agent monitor` : 'agent monitor';

  const note = $('unpricedNote');
  if (state.snap.today.unpriced > 0) {
    note.hidden = false;
    note.textContent = `${fmtTok(state.snap.today.unpriced)} tokens today have no pricing entry and are excluded from cost — add the model in src/pricing.json`;
  } else {
    note.hidden = true;
  }

  const fmtCost = (v, axis) => (axis ? fmtMoney(v) : fmtMoney(v) + '/min');
  const fmtTokV = (v, axis) => (axis ? fmtTok(v) : fmtTok(v) + ' tok/min');
  const costData = buildSeries((a) => a.cost);
  const tokData = buildSeries((a) => (state.mode === 'out' ? a.out : a.tokens));
  renderChart('plotCost', costData, fmtCost);
  renderChart('plotTok', tokData, fmtTokV);
  renderLegend('legendCost', costData.series, fmtCost);
  renderLegend('legendTok', tokData.series, fmtTokV);
  renderSpark();
  renderChips();
  renderTable();
}

// ---------- the odometer + slow clocks ----------
setInterval(() => {
  if (!state.meterBase || REDUCED) return;
  const b = state.meterBase;
  $('meter').textContent = fmtMeter(b.cost + b.perMs * (performance.now() - b.atMs));
}, 120);

setInterval(() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if (!state.snap) return;
  const now = Date.now();
  for (const td of document.querySelectorAll('td[data-t]')) {
    td.textContent = fmtAgo(Number(td.dataset.t), now);
  }
}, 1000);

// ---------- controls ----------
function segHandler(segId, apply) {
  $(segId).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of $(segId).children) {
      b.classList.toggle('on', b === btn);
      b.setAttribute('aria-pressed', String(b === btn));
    }
    apply(btn);
    render();
  });
}
segHandler('rangeSeg', (btn) => { state.rangeSec = Number(btn.dataset.range); });
segHandler('modeSeg', (btn) => {
  state.mode = btn.dataset.mode;
  $('tokTitle').textContent = state.mode === 'out'
    ? 'Output · tok/min · rolling 60s'
    : 'Tokens · tok/min · rolling 60s';
});
window.addEventListener('resize', () => render());

// ---------- SSE ----------
function connect() {
  const es = new EventSource('/events');
  es.onopen = () => {
    $('conn').classList.add('live');
    $('connText').textContent = 'live';
    document.querySelector('main').classList.remove('stale');
  };
  es.onmessage = (ev) => {
    state.snap = JSON.parse(ev.data);
    render();
  };
  es.onerror = () => {
    $('conn').classList.remove('live');
    $('connText').textContent = 'reconnecting';
    document.querySelector('main').classList.add('stale');
  };
}
connect();
