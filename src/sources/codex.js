import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Tailer } from '../lib/tailer.js';
import { costOpenAI } from '../lib/pricing.js';

const ROOT = path.join(os.homedir(), '.codex', 'sessions');

// Codex rollout files live under sessions/YYYY/MM/DD/rollout-*.jsonl and emit
// cumulative token_count events; we diff consecutive totals per file.
export function startCodex({ store, backfillStart, persist = null }) {
  // Per-file cumulative state lives in the tailer's `extra`, so with a persist
  // store it survives restarts — vital: totals are cumulative, and losing the
  // base would re-count a whole session on the next event.
  let tailer;

  tailer = new Tailer({
    backfillStart,
    persist,
    listFiles: async () => {
      const files = [];
      const days = [];
      for (let t = backfillStart; t <= Date.now() + 3600_000; t += 24 * 3600 * 1000) {
        const d = new Date(t);
        days.push(
          path.join(
            ROOT,
            String(d.getFullYear()),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0')
          )
        );
      }
      await Promise.all(
        [...new Set(days)].map(async (dir) => {
          try {
            for (const f of await fsp.readdir(dir)) {
              if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
            }
          } catch {}
        })
      );
      return files;
    },
    onLine: (file, obj) => {
      let st = tailer.getExtra(file);
      if (!st) {
        st = { session: path.basename(file, '.jsonl'), cwd: '', model: '', lastTotal: null };
        tailer.setExtra(file, st);
      }
      const p = obj.payload;
      if (!p) return;
      // Liveness only for sessions that have already produced usage — every
      // rollout line counts as activity, but we don't create empty sessions.
      if (st.session && store.sessions.has(`codex:${st.session}`)) {
        store.setSessionMeta('codex', st.session, {
          lastEventT: Date.parse(obj.timestamp) || Date.now(),
        });
      }
      if (obj.type === 'session_meta') {
        st.session = p.session_id || p.id || st.session;
        st.cwd = p.cwd || st.cwd;
        return;
      }
      if (obj.type === 'turn_context' && p.model) {
        st.model = p.model;
        return;
      }
      if (obj.type !== 'event_msg' || p.type !== 'token_count') return;
      // Rate-limit headroom, when the provider reports it.
      const rl = p.rate_limits?.primary;
      if (rl?.used_percent != null) {
        store.setAgentInfo('codex', {
          limitPct: rl.used_percent,
          limitWindowMin: rl.window_minutes ?? null,
          at: Date.parse(obj.timestamp) || Date.now(),
        });
      }
      if (!p.info) return;
      const tot = p.info.total_token_usage;
      if (!tot) return;
      const prev = st.lastTotal;
      st.lastTotal = tot;
      const d = prev
        ? {
            in: Math.max(0, (tot.input_tokens || 0) - (prev.input_tokens || 0)),
            out: Math.max(0, (tot.output_tokens || 0) - (prev.output_tokens || 0)),
            cached: Math.max(0, (tot.cached_input_tokens || 0) - (prev.cached_input_tokens || 0)),
          }
        : {
            in: tot.input_tokens || 0,
            out: tot.output_tokens || 0,
            cached: tot.cached_input_tokens || 0,
          };
      if (d.in + d.out === 0) return;
      const usage = { in: d.in, out: d.out, cacheRead: d.cached, cacheW5m: 0, cacheW1h: 0 };
      const cost = costOpenAI(st.model, usage);
      const evT = Date.parse(obj.timestamp) || Date.now();
      store.pushActivity({
        t: evT, agent: 'codex', session: st.session, cwd: st.cwd,
        kind: 'turn', detail: 'turn',
        tok: d.in + d.out, cost: cost ?? 0,
      });
      store.add({
        t: evT,
        agent: 'codex',
        session: st.session,
        model: st.model || 'unknown',
        cwd: st.cwd,
        ...usage,
        cost: cost ?? 0,
        priced: cost != null,
      });
    },
  });

  tailer.start();
  return tailer;
}
