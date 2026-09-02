import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { costAnthropic } from '../lib/pricing.js';

// OpenCode stores assistant messages in SQLite; rows are inserted at turn
// start and updated as tokens/cost accumulate, so we watermark on
// time_updated and emit per-message deltas.
//
// Data directories, all of which are polled when they hold a database (the
// same set ccusage scans, plus the Flatpak install's private data dir):
//   $OPENCODE_DATA_DIR            colon-separated list, if set
//   $XDG_DATA_HOME/opencode       default ~/.local/share/opencode
//   ~/.var/app/ai.opencode.opencode/data/opencode   (Flatpak)
// Inside a dir the database is opencode.db, or a release-channel variant
// opencode-<channel>.db.
export function openCodeDataDirs(env = process.env) {
  const dirs = [];
  for (const d of String(env.OPENCODE_DATA_DIR || '').split(path.delimiter)) if (d) dirs.push(d);
  dirs.push(path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode'));
  dirs.push(path.join(os.homedir(), '.var', 'app', 'ai.opencode.opencode', 'data', 'opencode'));
  return [...new Set(dirs.map((d) => path.resolve(d.replace(/^~(?=$|\/)/, os.homedir()))))];
}

function findDb(dir) {
  const main = path.join(dir, 'opencode.db');
  if (existsSync(main)) return main;
  try {
    const alt = readdirSync(dir)
      .filter((f) => /^opencode-[\w-]+\.db$/.test(f))
      .sort();
    if (alt.length) return path.join(dir, alt[0]);
  } catch {}
  return null;
}

// Newer OpenCode rows carry `model: { id | modelID, providerID }`; older ones
// have top-level modelID / providerID.
function modelOf(d) {
  const m = d.model && typeof d.model === 'object' ? d.model : null;
  return {
    model: m?.id || m?.modelID || d.modelID || '',
    provider: m?.providerID || d.providerID || '',
  };
}

export async function startOpenCode({ store, backfillStart, pollMs = 2000, persist = null }) {
  const dbs = openCodeDataDirs().map(findDb).filter(Boolean);
  if (!dbs.length) return null;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    console.error('[opencode] node:sqlite unavailable (need Node 22.5+); skipping');
    return null;
  }
  const readers = dbs.map((p) => openReader(p)).filter(Boolean);
  if (!readers.length) return null;
  const poll = () => {
    for (const r of readers) r.poll();
  };
  poll();
  const timer = setInterval(poll, pollMs);
  return { stop: () => clearInterval(timer), dbs };

  function openReader(dbPath) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (err) {
      console.error(`[opencode] cannot open ${dbPath}:`, err.message);
      return null;
    }
    const has = (t) =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const queries = [];
    if (has('message')) {
      queries.push(
        db.prepare(
          `SELECT id, session_id, time_updated, data FROM message
           WHERE time_updated > ? AND json_extract(data, '$.role') = 'assistant'
           ORDER BY time_updated ASC LIMIT 1000`
        )
      );
    }
    if (has('session_message')) {
      queries.push(
        db.prepare(
          `SELECT id, session_id, time_updated, data FROM session_message
           WHERE time_updated > ? AND data LIKE '%"tokens"%'
           ORDER BY time_updated ASC LIMIT 1000`
        )
      );
    }
    if (!queries.length) return null;
    // Resume from the persisted watermark so restarts re-read nothing.
    const WM_KEY = `opencode:watermark:${dbPath}`;
    let watermark = Math.max(backfillStart, persist?.load(WM_KEY)?.offset ?? 0);
    const seen = new Map(); // message id -> last-seen cumulative usage

    return {
      poll() {
        let rows = [];
        try {
          for (const q of queries) rows.push(...q.all(watermark));
        } catch (err) {
          console.error(`[opencode] query error (${dbPath}):`, err.message);
          return;
        }
        if (!rows.length) return;
        rows.sort((a, b) => a.time_updated - b.time_updated);
        persist?.save(WM_KEY, Math.max(...rows.map((r) => r.time_updated)), null);
        for (const row of rows) {
          watermark = Math.max(watermark, row.time_updated);
          let d;
          try {
            d = JSON.parse(row.data);
          } catch {
            continue;
          }
          const tk = d.tokens;
          if (!tk || typeof tk !== 'object') continue;
          const cache = tk.cache && typeof tk.cache === 'object' ? tk.cache : {};
          // OpenCode reports reasoning apart from output; it is billed as
          // output, so fold it in (ccusage does the same).
          const cur = {
            in: tk.input || 0,
            out: (tk.output || 0) + (tk.reasoning || 0),
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

          // OpenCode's token model is Anthropic-shaped for every provider
          // (input excludes cache; reads and writes reported separately), so
          // bill it that way. Prefer OpenCode's own cost figure when it has
          // one; fall back to our table, trying "<provider>/<model>" too.
          const { model, provider } = modelOf(d);
          let cost = dCost;
          let priced = dCost > 0;
          if (!priced) {
            const candidates = [model];
            if (provider && provider !== 'unknown') candidates.push(`${provider.replace(/-/g, '_')}/${model}`);
            for (const c of candidates) {
              const computed = costAnthropic(c, delta);
              if (computed != null) {
                cost = computed;
                priced = true;
                break;
              }
            }
          }
          if (d.time?.completed) {
            store.pushActivity({
              t: d.time.completed, agent: 'opencode', session: row.session_id,
              cwd: d.path?.cwd || '', kind: 'done', detail: 'turn done',
            });
          }
          store.add({
            t: d.time?.completed || d.time?.created || row.time_updated || Date.now(),
            agent: 'opencode',
            session: row.session_id,
            model: model || 'unknown',
            cwd: d.path?.cwd || '',
            ...delta,
            style: 'anthropic',
            cost,
            priced,
          });
        }
      },
    };
  }
}
