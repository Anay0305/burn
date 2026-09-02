import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { openDb, fileStateStore } from './lib/db.js';
import { startNotifier } from './lib/notify.js';
import { startClaudeCode } from './sources/claude-code.js';
import { startCodex } from './sources/codex.js';
import { startOpenCode } from './sources/opencode.js';

const PORT = Number(process.env.PORT || 4090);
const BACKFILL_HOURS = Number(process.env.BACKFILL_HOURS || 26);

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const store = new Store();
const backfillStart = Date.now() - BACKFILL_HOURS * 3600 * 1000;

// Persistence: events + tail offsets survive restarts, so startup replays the
// database instead of re-parsing a day of logs. TUI runs stay memory-only —
// one writer, no contention.
let persist = null;
try {
  const db = openDb();
  const restored = store.attachDb(db);
  const files = fileStateStore(db);
  // Flush pending events before advancing offsets — an offset ahead of its
  // events would silently drop them on a crash.
  persist = {
    load: files.load,
    save: (p, offset, extra) => {
      store.flushDb();
      files.save(p, offset, extra);
    },
  };
  console.log(`agent-monitor: restored ${restored} events from db`);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      store.flushDb();
      process.exit(0);
    });
  }
} catch (err) {
  console.error('agent-monitor: persistence unavailable, running in-memory:', err.message);
}

startClaudeCode({ store, backfillStart, persist });
startCodex({ store, backfillStart, persist });
startOpenCode({ store, backfillStart, persist });
startNotifier(store);

const sseClients = new Set();
setInterval(() => {
  if (sseClients.size === 0) return;
  const data = `data: ${JSON.stringify(store.snapshot(Date.now()))}\n\n`;
  for (const res of sseClients) res.write(data);
}, 2000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/snapshot') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(store.snapshot(Date.now())));
    return;
  }
  if (url.pathname === '/api/session') {
    const detail = store.sessionDetail(
      Date.now(),
      url.searchParams.get('agent') || '',
      url.searchParams.get('id') || ''
    );
    res.writeHead(detail ? 200 : 404, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(detail ?? { error: 'session not found' }));
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(`data: ${JSON.stringify(store.snapshot(Date.now()))}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  // static
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await fsp.readFile(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`agent-monitor: port ${PORT} is already in use — another instance running? (PORT=${PORT + 1} to use a different port)`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`agent-monitor: http://127.0.0.1:${PORT}  (backfill ${BACKFILL_HOURS}h)`);
});
