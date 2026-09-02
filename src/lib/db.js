// SQLite persistence (node:sqlite, no deps). Only the collector opens this —
// the TUI stays log-backfill-only so there is never a second writer.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'agent-monitor', 'events.db');
const KEEP_MS = 14 * 24 * 3600 * 1000;

export function openDb() {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
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
  `);
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
      try {
        put.run(p, offset, extra ? JSON.stringify(extra) : null);
      } catch (err) {
        console.error('[db] file_state save:', err.message);
      }
    },
  };
}
