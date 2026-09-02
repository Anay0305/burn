import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { costAnthropic, costOpenAI } from '../lib/pricing.js';

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

// OpenCode stores assistant messages in SQLite; rows are inserted at turn
// start and updated as tokens/cost accumulate, so we watermark on
// time_updated and emit per-message deltas.
export async function startOpenCode({ store, backfillStart, pollMs = 2000, persist = null }) {
  if (!existsSync(DB_PATH)) return null;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    console.error('[opencode] node:sqlite unavailable (need Node 22.5+); skipping');
    return null;
  }
  return run(DatabaseSync);

  function run(DatabaseSync) {
    let db;
    try {
      db = new DatabaseSync(DB_PATH, { readOnly: true });
    } catch (err) {
      console.error('[opencode] cannot open db:', err.message);
      return null;
    }
    const q = db.prepare(
      `SELECT id, session_id, time_updated, data FROM message
       WHERE time_updated > ? AND json_extract(data, '$.role') = 'assistant'
       ORDER BY time_updated ASC LIMIT 1000`
    );
    // Resume from the persisted watermark so restarts re-read nothing.
    const WM_KEY = 'opencode:watermark';
    let watermark = Math.max(backfillStart, persist?.load(WM_KEY)?.offset ?? 0);
    const seen = new Map(); // message id -> { tokens, cost }

    const poll = () => {
      let rows;
      try {
        rows = q.all(watermark);
      } catch (err) {
        console.error('[opencode] query error:', err.message);
        return;
      }
      if (rows.length) persist?.save(WM_KEY, Math.max(...rows.map((r) => r.time_updated)), null);
      for (const row of rows) {
        watermark = Math.max(watermark, row.time_updated);
        let d;
        try {
          d = JSON.parse(row.data);
        } catch {
          continue;
        }
        const tk = d.tokens || {};
        const cache = tk.cache || {};
        const cur = {
          in: tk.input || 0,
          out: tk.output || 0,
          cacheRead: cache.read || 0,
          cacheW5m: cache.write || 0,
          cacheW1h: 0,
          cost: d.cost || 0,
        };
        const prev = seen.get(row.id) || { in: 0, out: 0, cacheRead: 0, cacheW5m: 0, cacheW1h: 0, cost: 0 };
        const delta = {
          in: Math.max(0, cur.in - prev.in),
          out: Math.max(0, cur.out - prev.out),
          cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
          cacheW5m: Math.max(0, cur.cacheW5m - prev.cacheW5m),
          cacheW1h: 0,
        };
        const dCost = Math.max(0, cur.cost - prev.cost);
        seen.set(row.id, cur);
        if (seen.size > 20_000) {
          for (const k of seen.keys()) {
            seen.delete(k);
            if (seen.size <= 10_000) break;
          }
        }
        const total = delta.in + delta.out + delta.cacheRead + delta.cacheW5m;
        if (total === 0) continue;

        // Prefer OpenCode's own cost figure; fall back to our pricing table.
        let cost = dCost;
        let priced = dCost > 0;
        if (!priced) {
          const model = d.modelID || '';
          const computed = (d.providerID || '').includes('anthropic')
            ? costAnthropic(model, delta)
            : costOpenAI(model, { ...delta, in: delta.in + delta.cacheRead });
          if (computed != null) {
            cost = computed;
            priced = true;
          }
        }
        if (d.time?.completed) {
          store.pushActivity({
            t: d.time.completed, agent: 'opencode', session: row.session_id,
            cwd: d.path?.cwd || '', kind: 'done', detail: 'turn done',
          });
        }
        store.add({
          t: d.time?.completed || row.time_updated || Date.now(),
          agent: 'opencode',
          session: row.session_id,
          model: d.modelID || 'unknown',
          cwd: d.path?.cwd || '',
          ...delta,
          cost,
          priced,
        });
      }
    };

    poll();
    const timer = setInterval(poll, pollMs);
    return { stop: () => clearInterval(timer) };
  }
}
