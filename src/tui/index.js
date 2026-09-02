#!/usr/bin/env node
// BURN — the agent-monitor TUI. Standalone: tails the same logs as the web
// dashboard (no server needed) and renders a live full-screen Ink app.
import { Writable } from 'node:stream';
import { Store } from '../lib/store.js';
import { startClaudeCode } from '../sources/claude-code.js';
import { startCodex } from '../sources/codex.js';
import { startOpenCode } from '../sources/opencode.js';
import {
  html, render, Box, Text, useApp, useInput, useStdout, useState, useEffect,
} from './h.js';
import {
  ShimmerWordmark, BrailleSpinner, Panel, Hero, EMBER_GRADIENT,
  agentColor, agentLabel, brailleChart, fmtTok, fmtMoney, fmtAgo, WORDMARK_W,
} from './components.js';

const BACKFILL_HOURS = Number(process.env.BACKFILL_HOURS || 26);
const store = new Store();
const backfillStart = Date.now() - BACKFILL_HOURS * 3600 * 1000;
startClaudeCode({ store, backfillStart });
startCodex({ store, backfillStart });
startOpenCode({ store, backfillStart });

// 10s buckets -> rolling 60s sums (per-minute rate at each step)
function rolling(values) {
  const out = new Array(values.length).fill(0);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= 6) sum -= values[i - 6];
    out[i] = sum;
  }
  return out;
}

const RANGES = { 300: '5m', 900: '15m', 3600: '1h', 86400: '24h' };
const STATE_COLORS = { working: '#22c55e', waiting: '#fbbf24', idle: '#898781' };

const fmtDur = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
};

// One clipped label/value line inside a fixed-width panel — never wraps.
function Row({ label, bold = false, children }) {
  return html`
    <${Box} height=${1} overflow="hidden">
      <${Box} width=${7} flexShrink=${0}><${Text} color="gray">${label}</></>
      <${Text} color="white" bold=${bold} wrap="truncate">${children}</>
    </>
  `;
}

const fmtRate = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));

function fmtPeakTime(t, now) {
  if (!t) return '—';
  const d = new Date(t);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) {
    return d.toTimeString().slice(0, 5);
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snap, setSnap] = useState(() => store.snapshot(Date.now()));
  const [tick, setTick] = useState(0);
  const [range, setRange] = useState(900);
  const [mode, setMode] = useState('all');
  const [selKey, setSelKey] = useState(null); // `${agent}:${session}` or null
  const [startedAt] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setSnap(store.snapshot(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, []);
  useInput((input, key) => {
    if (input === 'q') exit();
    if (key.escape) {
      if (selKey) setSelKey(null);
      else exit();
    }
    if (input === '1') setRange(300);
    if (input === '2') setRange(900);
    if (input === '3') setRange(3600);
    if (input === '4') setRange(86400);
    if (input === 't') setMode((m) => (m === 'all' ? 'out' : 'all'));
    if (key.upArrow || key.downArrow) {
      const keys = store.snapshot(Date.now()).sessions.map((s) => `${s.agent}:${s.session}`);
      const cur = selKey ? keys.indexOf(selKey) : -1;
      const next = key.downArrow
        ? Math.min(keys.length - 1, cur + 1)
        : Math.max(-1, cur - 1);
      setSelKey(next < 0 ? null : keys[next]);
    }
  });

  const cols = Math.max(70, stdout?.columns || 80);
  const rows = stdout?.rows || 40;
  const wide = cols >= 108;
  const short = rows < 34; // collapse the wordmark on small terminals
  const warming = Date.now() - startedAt < 6000;

  // Vertical budget: chart, ticker and session list flex to fill the terminal.
  const fixed = (short ? 2 : 8) + 1 + 10 + 5 + 4 + 2;
  const tickerLines = rows >= 48 ? Math.min(6, rows - 44) : 0;
  const avail = Math.max(9, rows - fixed - (tickerLines ? tickerLines + 4 : 0));

  const day = range === 86400; // 5-min buckets; values are per-5min sums
  const pick = (a) => (mode === 'out' ? a.out : a.tokens);

  const selected = selKey
    ? snap.sessions.find((s) => `${s.agent}:${s.session}` === selKey) || null
    : null;
  const sessFilter = selected
    ? (e) => e.agent === selected.agent && e.session === selected.session
    : null;
  const b = selected
    ? store.buckets(snap.now, day ? 86400_000 : 3600_000, day ? 300_000 : 10_000, sessFilter)
    : day
      ? snap.buckets24
      : snap.buckets;
  const nWant = Math.floor((range * 1000) / b.stepMs);
  const agents = Object.keys(b.agents).sort();

  const series = agents.map((a) => ({
    agent: a,
    color: agentColor(a),
    values: day
      ? pick(b.agents[a]).slice(-nWant).map((v) => v / 5)
      : rolling(pick(b.agents[a])).slice(-nWant),
  }));
  const totalSessions = snap.sessions.length;
  let nSessions = Math.min(Math.max(totalSessions, 1), Math.max(4, Math.round(avail * 0.55)));
  let chartH = Math.max(5, Math.min(18, avail - nSessions));
  nSessions = Math.min(Math.max(totalSessions, 1), Math.max(4, avail - chartH));

  const chartW = cols - 8;
  const chartRows = series.length ? brailleChart(series, chartW, chartH) : [];
  const chartMax = Math.max(1e-9, ...series.flatMap((s) => s.values));

  // per-agent 24h aggregates for the wide-screen panel
  const byAgent = new Map();
  for (const s of snap.sessions) {
    const cur = byAgent.get(s.agent) || { tokens: 0, cost: 0 };
    cur.tokens += s.tokens;
    cur.cost += s.cost;
    byAgent.set(s.agent, cur);
  }

  const r = snap.rates;
  // Scroll the session window so the selection stays visible.
  const allKeys = snap.sessions.map((s) => `${s.agent}:${s.session}`);
  const selIdx = selKey ? allKeys.indexOf(selKey) : -1;
  const winStart = selIdx < 0
    ? 0
    : Math.min(Math.max(0, selIdx - nSessions + 1), Math.max(0, totalSessions - nSessions));
  const sessions = snap.sessions.slice(winStart, winStart + nSessions);
  const selName = selected
    ? (selected.cwd ? selected.cwd.split('/').slice(-2).join('/') : selected.session.slice(0, 8))
    : null;
  const showModel = cols >= 118;
  const projW = Math.min(38, Math.max(18, cols - (49 + (showModel ? 22 : 0))));

  return html`
    <${Box} flexDirection="column" paddingX=${1} height=${rows}>
      ${short
        ? html`<${Text} bold>${EMBER_GRADIENT('▌BURN')}</>`
        : html`
          <${Box} flexDirection="column">
            <${ShimmerWordmark} />
            <${Text}>${EMBER_GRADIENT('━'.repeat(Math.min(cols - 2, WORDMARK_W)))}</>
          </>
        `}
      <${Box}>
        <${Text} color="#f97316" bold> ✻  </>
        <${Text} bold>agent monitor</>
        <${Text} color="gray">  ·  Claude Code / Codex / OpenCode  ·  </>
        ${warming
          ? html`<${Box}><${BrailleSpinner} tick=${tick} color="#fbbf24" /><${Text} color="#fbbf24"> backfilling ${BACKFILL_HOURS}h</></>`
          : html`<${Text} color="#22c55e">● live</>`}
        ${snap.waiting > 0 ? html`<${Text} color="#fbbf24" bold>  ·  ◉ ${snap.waiting} waiting on you</>` : null}
        <${Box} flexGrow=${1} />
        <${Text} color="gray">${new Date(snap.now).toTimeString().slice(0, 8)} </>
      </>

      <${Box} marginTop=${1} alignItems="flex-start">
        <${Panel} title="burn" color="#f97316" marginRight=${1} width=${Math.max(32, Math.min(46, cols - (wide ? 66 : 30)))}>
          <${Hero} value=${r.costPerMin60} suffix="/min" />
          <${Box}>
            <${Text} color="white" bold>${fmtTok(r.tokensPerMin60)}</>
            <${Text} color="gray"> tok/min · </>
            <${Text} color="white" bold>${r.outPerSec10 >= 10 ? Math.round(r.outPerSec10) : r.outPerSec10.toFixed(1)}</>
            <${Text} color="gray"> tok/s out</>
          </>
          ${!wide ? html`
            <${Box}>
              <${Text} color="gray">▲ ${fmtMoney(snap.peaks.costPerMin.v)}/m · ${fmtTok(snap.peaks.tokensPerMin.v)}/m · ${fmtRate(snap.peaks.outPerSec.v)} t/s</>
            </>
          ` : null}
        </>
        <${Panel} title="today" color="#898781" width=${31} marginRight=${wide ? 1 : 0}>
          <${Row} label="cost" bold>${fmtMoney(snap.today.cost)}</>
          <${Row} label="tokens" bold>${fmtTok(snap.today.tokens)}</>
          <${Row} label="output">${fmtTok(snap.today.out)}</>
          <${Row} label="active">${snap.activeSessions} session${snap.activeSessions === 1 ? '' : 's'}</>
          <${Row} label="cache">${Math.round(snap.cache.hitRate * 100)}% · ${fmtMoney(snap.cache.savings)} saved</>
          <${Row} label="pace">→ ${fmtMoney(snap.forecast.today)} today</>
        </>
        ${wide ? html`
          <${Panel} title="by agent · 24h" color="#898781" width=${39} marginRight=${1}>
            ${[...byAgent.entries()].map(([a, v]) => html`
              <${Box} key=${a}>
                <${Text} color=${agentColor(a)}>● </>
                <${Box} width=${13}><${Text} color="white">${agentLabel(a)}</></>
                <${Box} width=${9} justifyContent="flex-end"><${Text} bold color="white">${v.cost > 0 ? fmtMoney(v.cost) : '—'}</></>
                <${Box} width=${9} justifyContent="flex-end"><${Text} color="gray">${fmtTok(v.tokens)}</></>
              </>
            `)}
            ${byAgent.size === 0 ? html`<${Text} color="gray">no data yet…</>` : null}
            ${snap.agentInfo.codex?.limitPct != null ? html`
              <${Text} color="gray">codex limit ${Math.round(snap.agentInfo.codex.limitPct)}% used</>
            ` : null}
          </>
        ` : null}
        ${wide ? html`
          <${Panel} title="records · all-time" color="#fbbf24" flexGrow=${1}>
            ${[
              ['burn', `${fmtMoney(snap.peaks.costPerMin.v)}/min`, snap.peaks.costPerMin.t],
              ['tokens', `${fmtTok(snap.peaks.tokensPerMin.v)}/min`, snap.peaks.tokensPerMin.t],
              ['output', `${fmtRate(snap.peaks.outPerSec.v)} tok/s`, snap.peaks.outPerSec.t],
            ].map(([label, value, t]) => html`
              <${Box} key=${label} height=${1} overflow="hidden">
                <${Box} width=${7} flexShrink=${0}><${Text} color="gray">${label}</></>
                <${Box} width=${11} flexShrink=${0}><${Text} bold color="white" wrap="truncate">${value}</></>
                <${Text} color="gray" wrap="truncate">▲ ${fmtPeakTime(t, snap.now)}</>
              </>
            `)}
          </>
        ` : null}
      </>

      <${Panel}
        title=${`${selName ? `${selName} · ` : ''}${mode === 'out' ? 'output' : 'tokens'}/min · last ${RANGES[range]} · peak ${fmtTok(chartMax)}`}
        color=${selected ? agentColor(selected.agent) : '#3987e5'} marginTop=${1}
      >
        ${chartRows.map((line, i) => html`
          <${Box} key=${i} height=${1} overflow="hidden"><${Text} wrap="truncate">${line}</></>
        `)}
        ${series.length === 0 ? html`<${Text} color="gray">no activity in this window yet…</>` : null}
        ${series.length > 0 ? html`
          <${Box} marginTop=${0}>
            ${series.map((s) => html`
              <${Box} key=${s.agent} marginRight=${3}>
                <${Text} color=${s.color}>── </>
                <${Text} color="#c3c2b7">${selected ? selName : agentLabel(s.agent)} </>
                <${Text} bold color="white">${fmtTok(s.values[s.values.length - 1] || 0)}/m</>
              </>
            `)}
            ${selected ? html`
              <${Text} color=${STATE_COLORS[selected.state]}>● ${selected.state}${selected.state === 'working' && selected.turnMs ? ` ${fmtDur(selected.turnMs)}` : ''} </>
              <${Text} color="gray">· ${selected.model} · ctx ${fmtTok(selected.ctx)} · ${fmtTok(selected.tokens)} tok · ${selected.unpriced && selected.cost === 0 ? 'unpriced' : fmtMoney(selected.cost)} total</>
            ` : null}
          </>
        ` : null}
      </>

      ${tickerLines > 0 ? html`
        <${Panel} title="activity" color="#898781" marginTop=${1}>
          ${snap.activity.slice(-tickerLines).map((a, i) => {
            const kindColor = a.kind === 'done' ? '#22c55e'
              : a.kind === 'compact' || a.kind === 'model' ? '#fbbf24'
              : a.kind === 'prompt' ? 'white' : '#898781';
            return html`
              <${Box} key=${`${a.t}-${i}`} height=${1} overflow="hidden">
                <${Text} color="gray">${new Date(a.t).toTimeString().slice(0, 8)} </>
                <${Text} color=${agentColor(a.agent)}>● </>
                <${Box} width=${Math.min(28, Math.max(16, cols - 70))}>
                  <${Text} color="#c3c2b7" wrap="truncate">${a.cwd ? a.cwd.split('/').slice(-2).join('/') : a.session.slice(0, 8)}</>
                </>
                <${Text} color=${kindColor} wrap="truncate">${a.detail || a.kind}</>
              </>
            `;
          })}
          ${snap.activity.length === 0 ? html`<${Text} color="gray">watching for activity…</>` : null}
        </>
      ` : null}

      <${Panel} title=${`sessions · last 24h${snap.waiting > 0 ? ` · ◉ ${snap.waiting} waiting` : ''}${totalSessions > nSessions ? ` · ${winStart + 1}–${winStart + sessions.length} of ${totalSessions}` : ''}`} color=${snap.waiting > 0 ? '#fbbf24' : '#898781'} marginTop=${1}>
        ${sessions.map((s) => {
          const key = `${s.agent}:${s.session}`;
          const isSel = key === selKey;
          return html`
          <${Box} key=${key}>
            <${Box} width=${2}>
              ${isSel
                ? html`<${Text} color="white" bold>▸ </>`
                : s.state === 'waiting'
                  ? html`<${Text} color="#fbbf24" bold>◉ </>`
                  : s.state === 'working'
                    ? html`<${BrailleSpinner} tick=${tick} color=${agentColor(s.agent)} />`
                    : html`<${Text} color="gray"> </>`}
            </>
            <${Text} color=${agentColor(s.agent)}>● </>
            <${Box} width=${projW}>
              <${Text} color=${isSel || s.active ? 'white' : 'gray'} bold=${isSel} wrap="truncate">${s.cwd ? s.cwd.split('/').slice(-2).join('/') : s.session.slice(0, 8)}</>
            </>
            ${showModel ? html`
              <${Box} width=${22}><${Text} color="#898781" wrap="truncate">${s.model || '—'}</></>
            ` : null}
            <${Box} width=${10} justifyContent="flex-end"><${Text} color="gray">${s.outPerSec >= 0.05 ? s.outPerSec.toFixed(1) + ' t/s' : '·'}</></>
            <${Box} width=${11} justifyContent="flex-end"><${Text} color=${s.costPerMin >= 0.0005 ? '#fbbf24' : 'gray'}>${s.costPerMin >= 0.0005 ? fmtMoney(s.costPerMin) + '/m' : '·'}</></>
            <${Box} width=${9} justifyContent="flex-end"><${Text} color="gray">${fmtTok(s.tokens)}</></>
            <${Box} width=${10} justifyContent="flex-end"><${Text} color="white">${s.unpriced && s.cost === 0 ? '—' : fmtMoney(s.cost)}</></>
            <${Box} width=${7} justifyContent="flex-end"><${Text} color="gray">${fmtAgo(s.lastT, snap.now)}</></>
          </>
        `;
        })}
        ${sessions.length === 0 ? html`<${Text} color="gray">no sessions yet…</>` : null}
      </>

      <${Box} flexGrow=${1} />
      <${Box}>
        <${Text} color="gray">  [↑↓] session${selKey ? ' · [esc] all agents' : ''} · [1]5m [2]15m [3]1h [4]24h · [t] ${mode === 'all' ? 'all tokens → output' : 'output → all tokens'} · [q] quit</>
      </>
    </>
  `;
}

if (!process.stdout.isTTY) {
  // Non-interactive: wait for backfill, print one snapshot, exit.
  setTimeout(() => {
    const s = store.snapshot(Date.now());
    console.log(`burn: ${fmtMoney(s.rates.costPerMin60)}/min · ${fmtTok(s.rates.tokensPerMin60)} tok/min · today ${fmtMoney(s.today.cost)} / ${fmtTok(s.today.tokens)} tok · ${s.activeSessions} active`);
    for (const x of s.sessions.slice(0, 10)) {
      console.log(`  ${x.agent.padEnd(12)} ${(x.cwd.split('/').slice(-2).join('/') || x.session.slice(0, 8)).padEnd(30)} ${fmtTok(x.tokens).padStart(7)} ${fmtMoney(x.cost).padStart(9)}`);
    }
    process.exit(0);
  }, 8000);
} else {
  // Full-screen: alternate screen buffer (like Claude Code), and wrap every
  // frame in a synchronized-output block so terminals repaint atomically —
  // this is what kills the flicker.
  const real = process.stdout;
  const syncOut = new Writable({
    write(chunk, enc, cb) {
      real.write('\x1b[?2026h');
      real.write(chunk, enc, () => {
        real.write('\x1b[?2026l');
        cb();
      });
    },
  });
  syncOut.isTTY = true;
  Object.defineProperty(syncOut, 'columns', { get: () => real.columns });
  Object.defineProperty(syncOut, 'rows', { get: () => real.rows });
  real.on('resize', () => syncOut.emit('resize'));

  const restore = () => {
    try {
      real.write('\x1b[?1049l');
    } catch {}
  };
  process.on('exit', restore);
  real.write('\x1b[?1049h\x1b[2J\x1b[H');

  const app = render(html`<${App} />`, { stdout: syncOut, exitOnCtrlC: true });
  app.waitUntilExit().then(() => {
    restore();
    process.exit(0);
  });
}
