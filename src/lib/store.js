// In-memory event store + rate/bucket math.
// An event: { t, agent, session, model, cwd, in, out, cacheRead, cacheW5m, cacheW1h, cost, priced }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import os from 'node:os';
import { costParts, costUncached } from './pricing.js';

const DAY = 24 * 3600 * 1000;
const PEAKS_PATH = path.join(os.homedir(), '.local', 'share', 'agent-monitor', 'peaks.json');

export class Store {
  constructor() {
    this.events = [];
    this.sourceBatches = new AsyncLocalStorage();
    this.sessions = new Map(); // `${agent}:${session}` -> aggregate
    this.dirty = false;
    // Live activity ticker — metadata only, live events only (backfill and
    // db-restore never land here), ring-buffered.
    this.activity = [];
    this.liveSince = Date.now();
    this.agentInfo = {}; // e.g. codex rate limits
    // BURN_MASK=1 replaces project paths with stable pseudonyms in every
    // output (screenshots, screen-shares, demos) — the data underneath is
    // untouched.
    this.mask = process.env.BURN_MASK === '1';
    this.maskMap = new Map();
    // All-time records, persisted across restarts: { v, t } each.
    this.peaks = { tokensPerMin: { v: 0, t: 0 }, costPerMin: { v: 0, t: 0 }, outPerSec: { v: 0, t: 0 } };
    try {
      const saved = JSON.parse(readFileSync(PEAKS_PATH, 'utf8'));
      for (const k of Object.keys(this.peaks)) {
        if (saved[k]?.v > this.peaks[k].v) this.peaks[k] = saved[k];
      }
    } catch {}
    this.lastPeakSave = Date.now(); // first save ~30s in, after backfill settles
  }

  // Sweep all stored events (covers the backfill window) for rolling-60s
  // rate records, merge into all-time peaks, persist throttled.
  updatePeaks(now) {
    if (now - (this.lastPeakScan || 0) < 5_000) return;
    this.lastPeakScan = now;
    const step = 10_000;
    const span = 27 * 3600 * 1000;
    const n = Math.ceil(span / step);
    const start = now - span;
    const tok = new Float64Array(n);
    const cost = new Float64Array(n);
    const out = new Float64Array(n);
    for (const e of this.events) {
      const i = Math.floor((e.t - start) / step);
      if (i < 0 || i >= n) continue;
      tok[i] += e.in + e.out + e.cacheRead + e.cacheW5m + e.cacheW1h;
      cost[i] += e.cost;
      out[i] += e.out;
    }
    let tokSum = 0, costSum = 0;
    for (let i = 0; i < n; i++) {
      tokSum += tok[i];
      costSum += cost[i];
      if (i >= 6) {
        tokSum -= tok[i - 6];
        costSum -= cost[i - 6];
      }
      const at = start + (i + 1) * step;
      if (tokSum > this.peaks.tokensPerMin.v) this.peaks.tokensPerMin = { v: tokSum, t: at };
      if (costSum > this.peaks.costPerMin.v) this.peaks.costPerMin = { v: costSum, t: at };
      const ops = out[i] / 10;
      if (ops > this.peaks.outPerSec.v) this.peaks.outPerSec = { v: ops, t: at };
    }
    if (now - this.lastPeakSave > 30_000 && this.peaks.tokensPerMin.v > 0) {
      this.lastPeakSave = now;
      try {
        mkdirSync(path.dirname(PEAKS_PATH), { recursive: true });
        // merge with whatever another instance (web vs TUI) wrote meanwhile
        let onDisk = {};
        try {
          onDisk = JSON.parse(readFileSync(PEAKS_PATH, 'utf8'));
        } catch {}
        for (const k of Object.keys(this.peaks)) {
          if (onDisk[k]?.v > this.peaks[k].v) this.peaks[k] = onDisk[k];
        }
        writeFileSync(PEAKS_PATH, JSON.stringify(this.peaks));
      } catch {}
    }
  }

  ensureSession(agent, session) {
    const key = `${agent}:${session}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        agent,
        session,
        cwd: '',
        model: '',
        firstT: 0,
        lastT: 0,
        tokens: 0,
        out: 0,
        cost: 0,
        unpriced: false,
        // live-state metadata (set by sources; claude-code fills all of it)
        meta: { lastEventT: 0, lastRole: '', stopReason: '', hasToolUse: false, turnStart: 0, ctx: 0 },
      };
      this.sessions.set(key, s);
    }
    return s;
  }

  maskCwd(cwd) {
    if (!this.mask || !cwd) return cwd;
    let name = this.maskMap.get(cwd);
    if (!name) {
      const i = this.maskMap.size;
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      name = `~/work/project-${letters[i % 26]}${i >= 26 ? Math.floor(i / 26) : ''}`;
      this.maskMap.set(cwd, name);
    }
    return name;
  }

  /** Ticker entry: { t, agent, session, cwd, kind, detail }. Live-only. */
  pushActivity(a) {
    if (a.t < this.liveSince - 15_000) return;
    if (a.kind === 'done') {
      const s = this.sessions.get(`${a.agent}:${a.session}`);
      if (s?.meta.turnStart) {
        const ms = a.t - s.meta.turnStart;
        const m = Math.floor(ms / 60000);
        a.detail = `turn done in ${m ? `${m}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s` : `${Math.round(ms / 1000)}s`}`;
      }
    }
    this.activity.push(a);
    if (this.activity.length > 250) this.activity.splice(0, this.activity.length - 250);
  }

  setAgentInfo(agent, info) {
    this.agentInfo[agent] = { ...this.agentInfo[agent], ...info };
  }

  add(ev, { fromDb = false } = {}) {
    const batch = this.sourceBatches.getStore();
    if (batch && !fromDb) {
      batch.events.push(ev);
      return;
    }
    if (ev.costNc == null) {
      ev.costNc = costUncached(ev.agent, ev.model, ev) ?? ev.cost;
    }
    if (ev.costParts == null) {
      ev.costParts = costParts(ev.agent, ev.model, ev);
    }
    this.events.push(ev);
    this.dirty = true;
    const s = this.ensureSession(ev.agent, ev.session);
    if (s.model && ev.model && ev.model !== s.model) {
      this.pushActivity({
        t: ev.t, agent: ev.agent, session: ev.session, cwd: s.cwd,
        kind: 'model', detail: `switched to ${ev.model}`,
      });
    }
    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.model) s.model = ev.model;
    if (!s.firstT) s.firstT = ev.t;
    s.lastT = Math.max(s.lastT, ev.t);
    s.tokens += totalTokens(ev);
    s.out += ev.out;
    if (ev.priced) s.cost += ev.cost;
    else s.unpriced = true;
    if (this.dbPending && !fromDb) {
      this.dbPending.push(ev);
      if (this.dbPending.length >= 500) this.flushDb();
    }
  }

  /** Sources report live-session metadata here (no content, ever). */
  setSessionMeta(agent, session, patch) {
    const s = this.ensureSession(agent, session);
    Object.assign(s.meta, patch);
    if (patch.lastEventT) s.lastT = Math.max(s.lastT, patch.lastEventT);
  }

  // ---------- persistence (collector only) ----------
  attachDb(db) {
    this.db = db;
    this.dbInsert = db.prepare(
      'INSERT INTO events(t, agent, session, model, cwd, tin, tout, cr, w5, w1, cost, priced, details) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    const cutoff = Date.now() - 25 * 3600 * 1000;
    const rows = db.prepare('SELECT * FROM events WHERE t >= ? ORDER BY t').all(cutoff);
    for (const r of rows) {
      this.add(
        {
          t: Number(r.t), agent: r.agent, session: r.session, model: r.model, cwd: r.cwd,
          in: Number(r.tin), out: Number(r.tout), cacheRead: Number(r.cr),
          cacheW5m: Number(r.w5), cacheW1h: Number(r.w1),
          cost: Number(r.cost), priced: !!r.priced,
          ...(r.details ? JSON.parse(r.details) : {}),
        },
        { fromDb: true }
      );
    }
    this.dbPending = [];
    this.dbTimer = setInterval(() => this.flushDb(), 2000);
    return rows.length;
  }

  writeEvents(events) {
    for (const e of events) {
      this.dbInsert.run(
        e.t, e.agent, e.session, e.model || '', e.cwd || '',
        e.in, e.out, e.cacheRead, e.cacheW5m, e.cacheW1h, e.cost, e.priced ? 1 : 0,
        JSON.stringify({ style: e.style, mult: e.mult, costParts: e.costParts, costNc: e.costNc })
      );
    }
  }

  flushDb() {
    if (!this.dbPending?.length) return true;
    const batch = this.dbPending;
    try {
      this.db.exec('BEGIN');
      this.writeEvents(batch);
      this.db.exec('COMMIT');
      this.dbPending = [];
      return true;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      console.error('[db] flush failed:', err.message);
      return false;
    }
  }

  prune(now) {
    const cutoff = now - DAY - 3600 * 1000;
    this.sortIfDirty();
    if (this.events.length && this.events[0].t < cutoff) {
      this.events = this.events.filter((e) => e.t >= cutoff);
      for (const [key, session] of this.sessions) {
        if (session.lastT < cutoff) this.sessions.delete(key);
      }
    }
  }

  // Keep events time-ordered. Appends are nearly sorted, so this is ~O(n);
  // it only really works during/after a multi-file backfill, which lands
  // events grossly out of order and breaks every windowed scan otherwise.
  sortIfDirty() {
    if (!this.dirty) return;
    this.events.sort((a, b) => a.t - b.t);
    this.dirty = false;
  }

  // Sum tokens/cost over [now - windowMs, now]
  windowSums(now, windowMs) {
    this.sortIfDirty();
    const from = now - windowMs;
    let tokens = 0, out = 0, cost = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.t < from) break;
      if (e.t > now) continue;
      tokens += totalTokens(e);
      out += e.out;
      cost += e.cost;
    }
    return { tokens, out, cost };
  }

  // Per-agent 10s buckets over the trailing hour: tokens, output tokens, cost.
  // Optional `filter(event)` narrows to e.g. a single session.
  buckets(now, spanMs = 3600 * 1000, stepMs = 10_000, filter = null) {
    const n = Math.ceil(spanMs / stepMs);
    const start = now - n * stepMs;
    const agents = {};
    for (const e of this.events) {
      if (e.t < start || e.t > now) continue;
      if (filter && !filter(e)) continue;
      let a = agents[e.agent];
      if (!a) {
        a = { tokens: new Array(n).fill(0), out: new Array(n).fill(0), cost: new Array(n).fill(0) };
        agents[e.agent] = a;
      }
      const idx = Math.min(n - 1, Math.floor((e.t - start) / stepMs));
      a.tokens[idx] += totalTokens(e);
      a.out[idx] += e.out;
      a.cost[idx] += e.cost;
    }
    return { start, stepMs, n, agents };
  }

  // Session rows, details and projects all report [now - 24h, now]. The
  // extra hour retained in memory is an ingestion buffer, not billable UI history.
  sessionRows(now, limit = 40) {
    this.sortIfDirty();
    const bySession = new Map();
    for (const e of this.events) {
      if (e.t < now - DAY || e.t > now) continue;
      const key = `${e.agent}:${e.session}`;
      let row = bySession.get(key);
      if (!row) {
        const session = this.sessions.get(key);
        row = { ...session, firstT: e.t, lastT: e.t, tokens: 0, out: 0, cost: 0, unpriced: false };
        if ((row.meta?.lastEventT || 0) > now) row.meta = {};
        bySession.set(key, row);
      }
      row.lastT = e.t;
      row.model = e.model || row.model;
      row.cwd = e.cwd || row.cwd;
      row.tokens += totalTokens(e);
      row.out += e.out;
      row.cost += e.cost;
      row.unpriced ||= !e.priced;
    }
    // A prompt may precede the first usage event; keep such live sessions.
    for (const [key, session] of this.sessions) {
      const t = session.meta?.lastEventT;
      if (!(t >= now - DAY && t <= now)) continue;
      if (!bySession.has(key)) bySession.set(key, { ...session, firstT: t, lastT: t, tokens: 0, out: 0, cost: 0, unpriced: false });
      bySession.get(key).lastT = Math.max(bySession.get(key).lastT, t);
    }
    return [...bySession.values()]
      .map((s) => ({ ...s, active: now - s.lastT < 5 * 60 * 1000 }))
      .sort((a, b) => b.lastT - a.lastT)
      .slice(0, limit);
  }

  projectRows(sessions) {
    const projects = new Map();
    for (const s of sessions) {
      const cwd = s.cwd;
      const key = cwd || `${s.agent}:${s.session}`;
      const p = projects.get(key) || { key, cwd, cost: 0, tokens: 0, sessions: 0, active: false };
      p.cost += s.cost;
      p.tokens += s.tokens;
      p.sessions++;
      p.active ||= s.state === 'working' || s.state === 'waiting';
      projects.set(key, p);
    }
    return [...projects.values()].sort((a, b) => b.cost - a.cost);
  }

  // Recent per-session rates (output tok/s over 30s, $/min over 60s)
  sessionRates(now) {
    this.sortIfDirty();
    const rates = new Map();
    const from30 = now - 30_000;
    const from60 = now - 60_000;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.t < from60) break;
      if (e.t > now) continue;
      const key = `${e.agent}:${e.session}`;
      let r = rates.get(key);
      if (!r) {
        r = { out30: 0, cost60: 0 };
        rates.set(key, r);
      }
      if (e.t >= from30) r.out30 += e.out;
      r.cost60 += e.cost;
    }
    return rates;
  }

  todaySums(now) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return this.windowSumsFrom(midnight.getTime(), now);
  }

  windowSumsFrom(from, now) {
    let tokens = 0, out = 0, cost = 0, unpriced = 0;
    let tin = 0, cacheRead = 0, cacheW = 0, costNc = 0;
    const costParts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const e of this.events) {
      if (e.t < from || e.t > now) continue;
      tokens += totalTokens(e);
      out += e.out;
      cost += e.cost;
      tin += e.in;
      cacheRead += e.cacheRead;
      cacheW += e.cacheW5m + e.cacheW1h;
      costNc += e.costNc ?? e.cost;
      if (e.costParts) {
        costParts.input += e.costParts.input;
        costParts.output += e.costParts.output;
        costParts.cacheRead += e.costParts.cacheRead;
        costParts.cacheWrite += e.costParts.cacheWrite;
      }
      if (!e.priced) unpriced += totalTokens(e);
    }
    return { tokens, out, cost, unpriced, tin, cacheRead, cacheW, costNc, costParts };
  }

  /** Everything the session detail page needs, in one call. */
  sessionDetail(now, agent, session) {
    const key = `${agent}:${session}`;
    const s = this.sessionRows(now, Infinity).find((row) => row.agent === agent && row.session === session);
    if (!s) return null;
    this.sortIfDirty();
    const filter = (e) => e.agent === agent && e.session === session;
    let tin = 0, out = 0, cr = 0, cw = 0, cost = 0, costNc = 0;
    const costParts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const models = new Set();
    for (const e of this.events) {
      if (!filter(e) || e.t < now - DAY || e.t > now) continue;
      tin += e.in;
      out += e.out;
      cr += e.cacheRead;
      cw += e.cacheW5m + e.cacheW1h;
      cost += e.cost;
      costNc += e.costNc ?? e.cost;
      if (e.costParts) {
        costParts.input += e.costParts.input;
        costParts.output += e.costParts.output;
        costParts.cacheRead += e.costParts.cacheRead;
        costParts.cacheWrite += e.costParts.cacheWrite;
      }
      if (e.model) models.add(e.model);
    }
    const r = this.sessionRates(now).get(key) || { out30: 0, cost60: 0 };
    const state = sessionState(s, now);
    const prompt = tin + cr + cw;
    return {
      now,
      info: {
        agent, session,
        cwd: this.maskCwd(s.cwd), model: s.model, models: [...models],
        state,
        ctx: s.meta.ctx || 0,
        turnMs: state === 'working' && s.meta.turnStart ? Math.max(0, now - s.meta.turnStart) : 0,
        firstT: s.firstT, lastT: s.lastT,
        outPerSec: r.out30 / 30, costPerMin: r.cost60,
        tokens: s.tokens, cost: s.cost, unpriced: s.unpriced,
        breakdown: { input: tin, output: out, cacheRead: cr, cacheWrite: cw },
        costParts,
        savings: Math.max(0, costNc - cost),
        hitRate: prompt > 0 ? cr / prompt : 0,
      },
      buckets: this.buckets(now, 3600 * 1000, 10_000, filter),
      buckets24: this.buckets(now, 24 * 3600 * 1000, 5 * 60 * 1000, filter),
      activity: this.activity
        .filter((a) => a.agent === agent && a.session === session)
        .slice(-30)
        .map((a) => ({ ...a, cwd: this.maskCwd(a.cwd) })),
    };
  }

  snapshot(now) {
    this.prune(now);
    this.updatePeaks(now);
    const w10 = this.windowSums(now, 10_000);
    const w60 = this.windowSums(now, 60_000);
    const w300 = this.windowSums(now, 300_000);
    const today = this.todaySums(now);
    const rates = this.sessionRates(now);
    const sessions = this.sessionRows(now, Infinity).map((s) => {
      const r = rates.get(`${s.agent}:${s.session}`) || { out30: 0, cost60: 0 };
      const state = sessionState(s, now);
      return {
        agent: s.agent,
        session: s.session,
        cwd: this.maskCwd(s.cwd),
        model: s.model,
        lastT: s.lastT,
        tokens: s.tokens,
        cost: s.cost,
        unpriced: s.unpriced,
        active: s.active,
        outPerSec: r.out30 / 30,
        costPerMin: r.cost60,
        state,
        ctx: s.meta.ctx || 0,
        turnMs:
          state === 'working' && s.meta.turnStart ? Math.max(0, now - s.meta.turnStart) : 0,
      };
    });
    // Cache economics for today
    const promptTok = today.tin + today.cacheRead + today.cacheW;
    const cache = {
      hitRate: promptTok > 0 ? today.cacheRead / promptTok : 0,
      savings: Math.max(0, today.costNc - today.cost),
      multiplier: today.cost > 0 ? today.costNc / today.cost : 1,
    };
    // Today's trajectory: spent so far + the last 3h burn rate carried to midnight.
    const w3h = this.windowSums(now, 3 * 3600 * 1000);
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const minsLeft = Math.max(0, (midnight.getTime() - now) / 60000);
    const forecast = { today: today.cost + (w3h.cost / 180) * minsLeft };

    return {
      now,
      rates: {
        outPerSec10: w10.out / 10,
        tokensPerMin60: w60.tokens,
        costPerMin60: w60.cost,
        tokensPerMin5m: (w300.tokens / 300) * 60,
        costPerMin5m: (w300.cost / 300) * 60,
      },
      today,
      cache,
      forecast,
      activity: this.activity.slice(-40).map((a) => ({ ...a, cwd: this.maskCwd(a.cwd) })),
      agentInfo: this.agentInfo,
      peaks: this.peaks,
      activeSessions: sessions.filter((s) => s.active).length,
      waiting: sessions.filter((s) => s.state === 'waiting').length,
      projects: this.projectRows(sessions),
      sessions: sessions.slice(0, 40),
      buckets: this.buckets(now),
      buckets24: this.buckets(now, 24 * 3600 * 1000, 5 * 60 * 1000),
    };
  }
}

/**
 * Resolve a session's live state from its metadata.
 * 'waiting' — the agent finished a turn and is waiting on the user (only
 * derivable for Claude Code, whose transcripts carry stop reasons).
 * 'working' — recent activity; 'idle' — nothing for a while.
 */
export function sessionState(s, now) {
  const m = s.meta || {};
  const lastT = Math.max(s.lastT || 0, m.lastEventT || 0);
  const age = now - lastT;
  if (age < 0) return 'idle';
  if (m.lastRole) {
    // claude-code: transcript-aware
    if (
      m.lastRole === 'assistant' &&
      m.stopReason &&
      m.stopReason !== 'tool_use' &&
      !m.hasToolUse
    ) {
      return age < 30 * 60 * 1000 ? 'waiting' : 'idle';
    }
    return age < 10 * 60 * 1000 ? 'working' : 'idle';
  }
  // codex/opencode: timing-only — never claim "waiting", we can't know
  return age < 90 * 1000 ? 'working' : 'idle';
}

export function totalTokens(e) {
  return e.in + e.out + e.cacheRead + e.cacheW5m + e.cacheW1h;
}
