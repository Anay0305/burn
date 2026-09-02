import { promises as fsp, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Tailer } from '../lib/tailer.js';
import { costOpenAI, fastMultiplier } from '../lib/pricing.js';

const ROOT = path.join(os.homedir(), '.codex', 'sessions');

// Codex rollout files live under sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
// and emit cumulative `token_count` events; we diff consecutive totals per
// file. Two things make that harder than it sounds, and both are handled the
// way ccusage handles them so the numbers agree:
//
//  1. Forks. A branched/subagent thread (t3code "thread_spawn", Codex
//     fork) opens a new rollout whose head *replays* the parent's history —
//     same cumulative totals, timestamps rewritten to the fork instant — and
//     then continues counting from the parent's total. Counting that replay
//     would bill the parent's whole history a second time. We anchor the
//     child on the parent's totals (`forked_from_id` / `parent_thread_id`)
//     and skip the matching prefix; if the parent log is gone we skip the
//     dense burst of events written within 1s of each other at the head.
//
//  2. Service tier. `thread_settings_applied` carries `service_tier`;
//     "priority"/"fast" bills at the model's fast multiplier (2x for gpt-5.6).
const BURST_MS = 1000;
const FAST_TIERS = new Set(['fast', 'priority']);

// [input, cached, cache_write, output, reasoning, total] — compared as a whole
// when matching a fork's replayed prefix against its parent.
const totalsOf = (tot) => [
  tot.input_tokens || 0,
  tot.cached_input_tokens || 0,
  tot.cache_write_input_tokens || 0,
  tot.output_tokens || 0,
  tot.reasoning_output_tokens || 0,
  tot.total_tokens || 0,
];
const sameTotals = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Every rollout under sessions/, optionally only day-directories on or after
// `sinceMs` (day dirs are named in local time). Sorted by path so a parent
// (created earlier, so named earlier) is always read before its forks.
export async function listRollouts(sinceMs = 0) {
  const sinceDay = localDay(sinceMs - 24 * 3600 * 1000);
  const files = [];
  let years = [];
  try {
    years = await fsp.readdir(ROOT);
  } catch {
    return files;
  }
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    let months = [];
    try {
      months = await fsp.readdir(path.join(ROOT, y));
    } catch {
      continue;
    }
    for (const m of months) {
      if (!/^\d{2}$/.test(m)) continue;
      let days = [];
      try {
        days = await fsp.readdir(path.join(ROOT, y, m));
      } catch {
        continue;
      }
      for (const d of days) {
        if (!/^\d{2}$/.test(d) || `${y}-${m}-${d}` < sinceDay) continue;
        let names = [];
        try {
          names = await fsp.readdir(path.join(ROOT, y, m, d));
        } catch {
          continue;
        }
        for (const f of names) if (f.endsWith('.jsonl')) files.push(path.join(ROOT, y, m, d, f));
      }
    }
  }
  return files.sort();
}

// Sync counterpart used once per fork to locate the parent rollout by id —
// it may live in a day directory outside the backfill window.
function findRolloutById(id, exclude) {
  try {
    for (const y of readdirSync(ROOT)) {
      if (!/^\d{4}$/.test(y)) continue;
      for (const m of readdirSync(path.join(ROOT, y))) {
        if (!/^\d{2}$/.test(m)) continue;
        for (const d of readdirSync(path.join(ROOT, y, m))) {
          if (!/^\d{2}$/.test(d)) continue;
          for (const f of readdirSync(path.join(ROOT, y, m, d))) {
            const full = path.join(ROOT, y, m, d, f);
            if (f.endsWith('.jsonl') && f.includes(id) && full !== exclude) return full;
          }
        }
      }
    }
  } catch {}
  return null;
}

// The parent's cumulative totals up to the fork instant, in order — the
// sequence a child's replayed head must reproduce.
function readParentTotals(file, forkedAtMs) {
  const out = [];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"token_count"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const tot = o.payload?.info?.total_token_usage;
    if (!tot || o.type !== 'event_msg' || o.payload.type !== 'token_count') continue;
    const t = Date.parse(o.timestamp);
    if (forkedAtMs && t > forkedAtMs) break;
    out.push(totalsOf(tot));
  }
  return out;
}

function beginReplay(file, parentId, forkedAtMs) {
  const parent = findRolloutById(parentId, file);
  const prefix = parent ? readParentTotals(parent, forkedAtMs) : [];
  // prefix: parent totals still to match; i: how many matched so far.
  // burst: fallback once the parent cannot anchor the replay (or is missing).
  return { prefix: prefix.length ? prefix : null, i: 0, burst: prefix.length ? null : { last: null, held: null } };
}

export function startCodex({ store, backfillStart, persist = null }) {
  // Per-file cumulative state lives in the tailer's `extra`, so with a persist
  // store it survives restarts — vital: totals are cumulative, and losing the
  // base would re-count a whole session on the next event.
  let tailer;

  const emit = (st, prev, cur, t) => {
    // Totals are cumulative per file; a drop in total_tokens means Codex
    // started a fresh series (new context window), so the event is its own
    // delta rather than a negative one to clamp away.
    const reset = prev && cur[5] < prev[5];
    const d = prev && !reset ? cur.map((v, i) => Math.max(0, v - prev[i])) : cur;
    const [input, cached, , out] = d;
    if (input + out === 0) return;
    // Codex reports cached tokens as a subset of input; store fresh input so
    // token totals line up with ccusage (input + output + cache read).
    const fresh = Math.max(0, input - cached);
    const model = st.model || 'unknown';
    const mult = FAST_TIERS.has(String(st.tier || '').toLowerCase()) ? fastMultiplier(model) ?? 1 : 1;
    const usage = { in: fresh, out, cacheRead: cached, cacheW5m: 0, cacheW1h: 0, mult };
    const cost = costOpenAI(model, usage);
    store.pushActivity({
      t, agent: 'codex', session: st.session, cwd: st.cwd,
      kind: 'turn', detail: mult > 1 ? 'turn · priority tier' : 'turn',
      tok: fresh + cached + out, cost: cost ?? 0,
    });
    store.add({
      t,
      agent: 'codex',
      session: st.session,
      model,
      cwd: st.cwd,
      ...usage,
      cost: cost ?? 0,
      priced: cost != null,
    });
  };

  tailer = new Tailer({
    backfillStart,
    persist,
    listFiles: () => listRollouts(backfillStart),
    onLine: (file, obj) => {
      let st = tailer.getExtra(file);
      if (!st) {
        st = {
          session: path.basename(file, '.jsonl').replace(/^rollout-[\dT-]+-/, ''),
          cwd: '', model: '', tier: '', lastTotal: null, meta: false, replay: null,
        };
        tailer.setExtra(file, st);
      }
      const p = obj.payload;
      if (!p) return;
      const t = Date.parse(obj.timestamp) || Date.now();
      // Liveness only for sessions that have already produced usage — every
      // rollout line counts as activity, but we don't create empty sessions.
      if (st.session && store.sessions.has(`codex:${st.session}`)) {
        store.setSessionMeta('codex', st.session, { lastEventT: t });
      }
      if (obj.type === 'session_meta') {
        // A fork's own meta comes first; the parent's copied meta follows as
        // part of the replayed history, so only the first one describes us.
        if (!st.meta) {
          st.meta = true;
          st.session = p.id || p.session_id || st.session;
          st.cwd = p.cwd || st.cwd;
          const parentId =
            p.forked_from_id ||
            p.parent_thread_id ||
            (p.session_id && p.id && p.session_id !== p.id ? p.session_id : null);
          if (parentId) st.replay = beginReplay(file, parentId, Date.parse(p.timestamp) || t);
        } else if (!st.cwd && p.cwd) {
          st.cwd = p.cwd;
        }
        return;
      }
      if (obj.type === 'turn_context' && p.model) {
        st.model = p.model;
        return;
      }
      if (obj.type !== 'event_msg') return;
      if (p.type === 'thread_settings_applied') {
        const tier = p.thread_settings?.service_tier;
        if (typeof tier === 'string') st.tier = tier;
        return;
      }
      if (p.type !== 'token_count') return;
      // Rate-limit headroom, when the provider reports it.
      const rl = p.rate_limits?.primary;
      if (rl?.used_percent != null) {
        store.setAgentInfo('codex', {
          limitPct: rl.used_percent,
          limitWindowMin: rl.window_minutes ?? null,
          at: t,
        });
      }
      const tot = p.info?.total_token_usage;
      if (!tot) return;
      const cur = totalsOf(tot);
      const prev = st.lastTotal;
      st.lastTotal = cur;

      // ---- fork replay filter ----
      const r = st.replay;
      if (r) {
        if (r.prefix) {
          if (r.i < r.prefix.length && sameTotals(r.prefix[r.i], cur)) {
            r.i++;
            if (r.i >= r.prefix.length) st.replay = null;
            return; // replayed parent history — already counted there
          }
          // The parent stream cannot anchor this replay: nothing matched at
          // all (fall back to the rewritten burst) or the replay ended early.
          if (r.i === 0) {
            r.prefix = null;
            r.burst = { last: null, held: null };
          } else {
            st.replay = null;
          }
        }
        if (st.replay && r.burst) {
          const b = r.burst;
          if (b.last == null) {
            // Hold the first event: it is replay only if a second one lands
            // within the burst window; otherwise this session started cold.
            b.last = t;
            b.held = { prev, cur, t };
            return;
          }
          if (t - b.last <= BURST_MS) {
            b.last = t;
            b.held = null;
            return;
          }
          const held = b.held;
          st.replay = null;
          if (held) emit(st, held.prev, held.cur, held.t);
        }
      }
      emit(st, prev, cur, t);
    },
  });

  tailer.start();
  return tailer;
}
