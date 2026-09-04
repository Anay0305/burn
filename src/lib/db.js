// SQLite persistence (node:sqlite, no deps). Only the collector opens this —
// the TUI stays log-backfill-only so there is never a second writer.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'agent-monitor', 'events.db');
const KEEP_MS = 14 * 24 * 3600 * 1000;

// Bump when ingestion or pricing rules change in a way that makes stored
// events wrong. The db is a cache of the agents' own logs, so on a mismatch
// we drop it and let the backfill rebuild it from source.
//   2 — per-model cache rates from LiteLLM; Codex fork replay + priority tier;
//       Codex input stored net of cached tokens; deep subagent transcripts.
export const INGEST_VERSION = '2';

export function openDb(dbPath = DB_PATH) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS events (
      t INTEGER NOT NULL,
      agent TEXT NOT NULL,
      session TEXT NOT NULL,
      model TEXT,
      cwd TEXT,
      tin INTEGER, tout INTEGER, cr INTEGER, w5 INTEGER, w1 INTEGER,
      cost REAL, priced INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_events_t ON events(t);
    CREATE TABLE IF NOT EXISTS file_state (
      path TEXT PRIMARY KEY,
      offset INTEGER NOT NULL,
      extra TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  if (!db.prepare('PRAGMA table_info(events)').all().some((column) => column.name === 'details')) {
    db.exec('ALTER TABLE events ADD COLUMN details TEXT');
  }
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'ingest_version'").get()?.value ?? null;
  if (stored !== INGEST_VERSION) {
    const had = db.prepare('SELECT count(*) AS n FROM events').get().n;
    db.exec('DELETE FROM events; DELETE FROM file_state;');
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('ingest_version', ?) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(INGEST_VERSION);
    if (had) {
      console.log(
        `[db] ingest rules changed (v${stored ?? '1'} → v${INGEST_VERSION}): dropped ${had} cached events; re-backfilling from logs`
      );
    }
  }
  db.prepare('DELETE FROM events WHERE t < ?').run(Date.now() - KEEP_MS);
  return db;
}

export function fileStateStore(db) {
  const get = db.prepare('SELECT offset, extra FROM file_state WHERE path = ?');
  const put = db.prepare(
    'INSERT INTO file_state(path, offset, extra) VALUES(?, ?, ?) ' +
    'ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, extra = excluded.extra'
  );
  return {
    load(p) {
      const row = get.get(p);
      if (!row) return null;
      let extra = null;
      try {
        extra = row.extra ? JSON.parse(row.extra) : null;
      } catch {}
      return { offset: Number(row.offset), extra };
    },
    save(p, offset, extra) {
      put.run(p, offset, extra ? JSON.stringify(extra) : null);
    },
  };
}
