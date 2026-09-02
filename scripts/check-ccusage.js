#!/usr/bin/env node
// Cross-check BURN's ingestion + pricing against `ccusage daily`.
//
// Runs every source once over the full local history (in memory, no db), sums
// per local day × agent × model, and — when ccusage is installed — prints
// ccusage's figures for the same day/model next to ours.
//
//   node scripts/check-ccusage.js                 # last 3 days
//   node scripts/check-ccusage.js --since 2026-09-01
//   node scripts/check-ccusage.js --no-ccusage    # BURN only
import { execFileSync } from 'node:child_process';
import { Store } from '../src/lib/store.js';
import { loadPricing } from '../src/lib/pricing.js';
import { startClaudeCode } from '../src/sources/claude-code.js';
import { startCodex } from '../src/sources/codex.js';
import { startOpenCode } from '../src/sources/opencode.js';

const args = process.argv.slice(2);
const sinceArg = args[args.indexOf('--since') + 1];
const since = args.includes('--since') && sinceArg ? sinceArg : localDay(Date.now() - 2 * 86400_000);
const withCcusage = !args.includes('--no-ccusage');

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const pricing = await loadPricing();
console.error(`pricing: ${pricing.source} (${pricing.models} models)`);

const store = new Store();
const backfillStart = new Date(since).getTime() - 2 * 86400_000; // day dirs / mtimes are coarse
const t0 = Date.now();
const cc = startClaudeCode({ store, backfillStart });
const cx = startCodex({ store, backfillStart });
const oc = await startOpenCode({ store, backfillStart });
await Promise.all([cc.firstPoll, cx.firstPoll]);
cc.stop();
cx.stop();
oc?.stop?.();
console.error(`scanned ${store.events.length} events in ${Date.now() - t0}ms`);

// ---- BURN per day × model (ccusage breaks days down by model across agents) ----
const burn = new Map();
for (const e of store.events) {
  const day = localDay(e.t);
  if (day < since) continue;
  const k = `${day}|${e.model}`;
  const a = burn.get(k) ?? burn.set(k, { in: 0, out: 0, cr: 0, cw: 0, cost: 0, n: 0, agents: new Set() }).get(k);
  a.in += e.in; a.out += e.out; a.cr += e.cacheRead; a.cw += e.cacheW5m + e.cacheW1h; a.cost += e.cost; a.n++;
  a.agents.add(e.agent);
}

// ---- ccusage per day × model ----
const ref = new Map();
if (withCcusage) {
  try {
    // Plain invocation on purpose: ccusage's Codex costs differ when it is
    // given an open-ended --since (its bounded-window replay path), and the
    // plain `npx ccusage daily` is what people actually compare against.
    const out = execFileSync('npx', ['--no-install', 'ccusage', 'daily', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20, cwd: process.env.HOME,
    });
    const json = JSON.parse(out);
    for (const d of json.daily || []) {
      if (d.period < since) continue;
      for (const m of d.modelBreakdowns || []) {
        ref.set(`${d.period}|${m.modelName}`, { in: m.inputTokens, out: m.outputTokens, cr: m.cacheReadTokens, cw: m.cacheCreationTokens, cost: m.cost });
      }
      ref.set(`${d.period}|*`, { cost: d.totalCost });
    }
  } catch (err) {
    console.error(`ccusage unavailable (${err.message.split('\n')[0]}); showing BURN only`);
  }
}

const fmt = (n) => (n == null ? '-' : Math.round(n).toLocaleString('en-US'));
const money = (n) => (n == null ? '-' : `$${n.toFixed(2)}`);
const tokens = (a) => `in ${fmt(a.in).padStart(11)} out ${fmt(a.out).padStart(9)} cr ${fmt(a.cr).padStart(13)} cw ${fmt(a.cw).padStart(11)}`;
const days = [...new Set([...burn.keys(), ...ref.keys()].map((k) => k.split('|')[0]))].sort();
let worst = 0;
for (const day of days) {
  console.log(`\n${day}`);
  const rows = [...burn.entries()].filter(([k]) => k.startsWith(day + '|')).sort((a, b) => b[1].cost - a[1].cost);
  let dayBurn = 0;
  const seen = new Set();
  for (const [k, a] of rows) {
    const model = k.split('|')[1];
    dayBurn += a.cost;
    const r = ref.get(`${day}|${model}`);
    if (r) seen.add(model);
    const cmp = r ? `  ccusage ${money(r.cost).padStart(8)}  Δ ${money(a.cost - r.cost)}` : ref.size ? '  ccusage        -' : '';
    console.log(`  ${model.padEnd(26)} ${[...a.agents].join('+').padEnd(18)} ${tokens(a)}  ${money(a.cost).padStart(9)}${cmp}`);
    if (r) {
      worst = Math.max(worst, Math.abs(a.cost - r.cost));
      if (r.in !== a.in || r.out !== a.out || r.cr !== a.cr || r.cw !== a.cw) {
        console.log(`  ${''.padEnd(26)} ${'ccusage tokens'.padEnd(18)} ${tokens(r)}`);
      }
    }
  }
  for (const [k, r] of ref) {
    const [d, model] = k.split('|');
    if (d !== day || model === '*' || seen.has(model)) continue;
    worst = Math.max(worst, Math.abs(r.cost));
    console.log(`  ${model.padEnd(26)} ${'(ccusage only)'.padEnd(18)} ${tokens(r)}  ${''.padStart(9)}  ccusage ${money(r.cost).padStart(8)}`);
  }
  const total = ref.get(`${day}|*`);
  console.log(`  ${'total'.padEnd(26)} ${''.padEnd(18)} ${''.padStart(58)}  ${money(dayBurn).padStart(9)}${total ? `  ccusage ${money(total.cost).padStart(8)}  Δ ${money(dayBurn - total.cost)}` : ''}`);
}
if (ref.size) console.log(`\nlargest per-model gap: ${money(worst)}`);
process.exit(0);
