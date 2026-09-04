import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/lib/store.js';
import { openDb } from '../src/lib/db.js';
import { sourcePersistence } from '../src/lib/persistence.js';
import { Tailer } from '../src/lib/tailer.js';
import { startClaudeCode } from '../src/sources/claude-code.js';
import { startOpenCode } from '../src/sources/opencode.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const now = Date.now();
const event = (t = now, session = 's', cost = 1) => ({
  t, agent: 'claude-code', session, model: 'claude-opus-5', cwd: `/projects/${session}`,
  in: cost * 200000, out: 0, cacheRead: 0, cacheW5m: 0, cacheW1h: 0, cost, priced: true,
});
const store = () => { const s = new Store(); s.lastPeakSave = Infinity; return s; };
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'burn-integrity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function attached(t, db) {
  const s = store(); s.attachDb(db); t.after(() => clearInterval(s.dbTimer)); return s;
}

test('events and source checkpoint roll back together when checkpoint insertion fails', async (t) => {
  const root = await temp(t), file = path.join(root, 'events.db');
  const db = openDb(file); t.after(() => db.close());
  const s = attached(t, db), persist = sourcePersistence(s, db);
  db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON file_state BEGIN SELECT RAISE(ABORT, 'checkpoint failed'); END");
  assert.throws(() => persist.batch(() => { s.add(event()); persist.save('log', 100, { count: 1 }); }), /checkpoint failed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM file_state').get().n, 0);
  assert.equal(s.events.length, 0);
  db.exec('DROP TRIGGER fail_checkpoint');
  persist.batch(() => { s.add(event()); persist.save('log', 100, { count: 1 }); });
  const resumed = attached(t, db);
  assert.equal(resumed.events.length, 1);
  assert.deepEqual(persist.load('log'), { offset: 100, extra: { count: 1 } });
});

test('concurrent readers cannot flush another reader before its checkpoint', async (t) => {
  const root = await temp(t), db = openDb(path.join(root, 'events.db')); t.after(() => db.close());
  const s = attached(t, db), persist = sourcePersistence(s, db);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const unfinished = persist.batch(async () => { s.add(event(now, 'unfinished')); await gate; throw new Error('reader interrupted'); });
  const rejected = assert.rejects(unfinished, /reader interrupted/);
  persist.batch(() => { s.add(event(now, 'complete')); persist.save('complete', 20, null); });
  s.flushDb();
  assert.deepEqual(db.prepare('SELECT session FROM events').all().map((r) => r.session), ['complete']);
  assert.equal(s.events.length, 1);
  release(); await rejected;
  assert.equal(persist.load('unfinished'), null);
});

test('failed Claude commit can retry, and streaming watermarks survive restart', async (t) => {
  const root = await temp(t); const logs = path.join(root, 'logs'); await mkdir(logs);
  const file = path.join(logs, 'session.jsonl');
  const row = (out) => JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'assistant', sessionId: 's', requestId: 'r', message: { id: 'm', model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: out } } }) + '\n';
  await writeFile(file, row(10));
  const db = openDb(path.join(root, 'events.db')); t.after(() => db.close());
  const s = attached(t, db); const persist = sourcePersistence(s, db);
  const source = startClaudeCode({ store: s, backfillStart: 0, persist, root: logs, start: false });
  db.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON file_state BEGIN SELECT RAISE(ABORT, 'checkpoint failed'); END");
  await assert.rejects(source.poll(), /checkpoint failed/);
  db.exec('DROP TRIGGER fail_checkpoint'); await source.poll();
  assert.equal(s.events.length, 1);
  await appendFile(file, row(20));
  const resumed = attached(t, db);
  await startClaudeCode({ store: resumed, backfillStart: 0, persist: sourcePersistence(resumed, db), root: logs, start: false }).poll();
  assert.equal(sum(resumed.events, 'in'), 100);
  assert.equal(sum(resumed.events, 'out'), 20);
  assert.equal(db.prepare('SELECT SUM(tout) AS n FROM events').get().n, 20);
});

test('partial UTF-8 JSON lines resume at the last complete byte offset', async (t) => {
  const root = await temp(t), file = path.join(root, 'log.jsonl');
  const states = new Map(), rows = [];
  const persist = { load: (file) => structuredClone(states.get(file)), save: (file, offset, extra) => states.set(file, { offset, extra }) };
  const first = Buffer.from('{"name":"ok"}\n');
  const second = Buffer.from('{"name":"é"}\n');
  const split = second.indexOf(0xc3) + 1;
  await writeFile(file, Buffer.concat([first, second.subarray(0, split)]));
  const options = { listFiles: async () => [file], onLine: (_, value) => rows.push(value), backfillStart: 0, persist };
  await new Tailer(options).poll();
  assert.equal(states.get(file).offset, first.length);
  await appendFile(file, second.subarray(split));
  await new Tailer(options).poll();
  assert.deepEqual(rows, [{ name: 'ok' }, { name: 'é' }]);
});

async function openCodeFixture(t, table = 'message') {
  const root = await temp(t), dbPath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER, data TEXT)`);
  const output = openDb(path.join(root, 'events.db')); t.after(() => output.close());
  const s = attached(t, output);
  const reader = await startOpenCode({ store: s, backfillStart: 0, dbPaths: [dbPath], persist: sourcePersistence(s, output), start: false });
  t.after(() => reader.stop());
  let time = now;
  const put = (input, cost, extra = {}, id = 'm') => db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated, data=excluded.data`).run(id, 's', time++, JSON.stringify({ role: 'assistant', model: { id: 'claude-opus-5', providerID: 'anthropic' }, tokens: { input, output: 0 }, cost, ...extra }));
  return { db, output, s, reader, put, dbPath };
}

test('OpenCode applies late cost-only updates and downward corrections', async (t) => {
  const { s, reader, put, output } = await openCodeFixture(t);
  put(200000, 1); reader.poll();
  put(200000, 2); reader.poll(); near(sum(s.events, 'cost'), 2);
  put(200000, .5); reader.poll(); near(sum(s.events, 'cost'), .5);
  assert.equal(sum(s.events, 'in'), 200000);
  near(sum(attached(t, output).events, 'cost'), .5);
  near(s.events.reduce((n, e) => n + Object.values(e.costParts).reduce((a, b) => a + b, 0), 0), .5);
});

test('OpenCode replaces estimated amounts instead of adding the full provider charge', async (t) => {
  const { s, reader, put } = await openCodeFixture(t, 'session_message');
  put(200000, 0); reader.poll(); near(sum(s.events, 'cost'), 1);
  put(400000, 2); reader.poll(); near(sum(s.events, 'cost'), 2);
  put(400000, 0, { time: { completed: now } }); reader.poll(); near(sum(s.events, 'cost'), 0);
});

test('OpenCode resumes cumulative costs and persists counters across restarts', async (t) => {
  const { s, reader, put, output, dbPath } = await openCodeFixture(t);
  put(200000, 0); reader.poll();
  const resumed = attached(t, output);
  const next = await startOpenCode({ store: resumed, backfillStart: 0, dbPaths: [dbPath], persist: sourcePersistence(resumed, output), start: false });
  t.after(() => next.stop());
  put(400000, 2); next.poll(); next.poll();
  near(sum(resumed.events, 'cost'), 2);
  assert.equal(sum(resumed.events, 'in'), 400000);
  near(sum(s.events, 'cost'), 1);
});

test('OpenCode retries failed checkpoints without losing or duplicating deltas', async (t) => {
  const { s, reader, put, output } = await openCodeFixture(t);
  put(200000, 1);
  output.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON file_state BEGIN SELECT RAISE(ABORT, 'checkpoint failed'); END");
  assert.throws(() => reader.poll(), /checkpoint failed/);
  assert.equal(s.events.length, 0);
  output.exec('DROP TRIGGER fail_checkpoint'); reader.poll();
  assert.equal(s.events.length, 1); near(sum(s.events, 'cost'), 1);
});

test('session headlines, rows and breakdowns use the same 24-hour window after pruning and restart', async (t) => {
  const root = await temp(t), db = openDb(path.join(root, 'events.db')); t.after(() => db.close());
  const s = attached(t, db);
  s.add(event(now - 48 * 3600000, 's', 10));
  s.add(event(now - 24.5 * 3600000, 's', 5));
  s.add(event(now, 's', 1)); s.flushDb();
  s.prune(now);
  const info = s.sessionDetail(now, 'claude-code', 's').info;
  near(info.cost, 1);
  near(Object.values(info.costParts).reduce((a, b) => a + b, 0), 1);
  assert.equal(info.tokens, info.breakdown.input);
  near(s.sessionRows(now)[0].cost, 1);
  const restored = attached(t, db).sessionDetail(now, 'claude-code', 's').info;
  assert.equal(restored.tokens, info.tokens); near(restored.cost, info.cost);
});

test('project totals and active counts include sessions outside the displayed forty', () => {
  const s = store();
  s.add(event(now - 41000, 'expensive', 50));
  s.setSessionMeta('claude-code', 'expensive', { lastEventT: now - 41000, lastRole: 'assistant', stopReason: 'end_turn', hasToolUse: false });
  for (let i = 0; i < 40; i++) s.add(event(now - i * 1000, 'recent-' + i));
  const snapshot = s.snapshot(now);
  assert.equal(snapshot.sessions.length, 40);
  assert.equal(snapshot.activeSessions, 41);
  assert.equal(snapshot.waiting, 1);
  assert.equal(snapshot.projects[0].cwd, '/projects/expensive');
  near(snapshot.projects[0].cost, 50);
  near(sum(snapshot.projects, 'cost'), 90);
  s.mask = true;
  const masked = s.snapshot(now);
  assert.ok(masked.projects.every((p) => !p.cwd.startsWith('/projects/')));
  assert.equal(masked.projects.find((p) => p.cost === 1).cwd.startsWith('~/work/project-'), true);
  const row = masked.sessions[0];
  assert.ok(masked.projects.some((p) => p.cwd === row.cwd));
});

test('future events stay outside rates, details, projects and forecasts until due', () => {
  const s = store(); s.add(event(now, 'current', 1)); s.add(event(now + 300000, 'future', 123));
  const snapshot = s.snapshot(now);
  near(snapshot.rates.costPerMin60, 1);
  near(s.sessionRates(now).get('claude-code:current').cost60, 1);
  assert.equal(s.sessionRates(now).has('claude-code:future'), false);
  assert.equal(s.sessionDetail(now, 'claude-code', 'future'), null);
  near(sum(snapshot.projects, 'cost'), 1);
  const baseline = store(); baseline.add(event(now, 'current', 1));
  near(snapshot.forecast.today, baseline.snapshot(now).forecast.today);
  near(s.windowSums(now + 300000, 60000).cost, 123);
});

test('service tier and cost breakdown survive persistence', async (t) => {
  const root = await temp(t), db = openDb(path.join(root, 'events.db')); t.after(() => db.close());
  const s = attached(t, db);
  s.add({ ...event(), mult: 2, style: 'anthropic', cost: 2 }); s.flushDb();
  const resumed = attached(t, db);
  near(resumed.events[0].costParts.input, 2);
  near(resumed.events[0].costNc, 2);
});
