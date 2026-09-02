// Pricing: USD per 1M tokens, resolved the same way ccusage does it so the two
// agree to within rounding.
//
//  - Source of truth is LiteLLM's model_prices_and_context_window.json (what
//    ccusage prices against). loadPricing() fetches it, caches it on disk for
//    24h, and falls back to the bundled src/pricing.json when offline.
//  - Every model carries explicit cache rates (read / 5m write / 1h write);
//    the Anthropic 10% / 125% / 200% multipliers are only a fallback for
//    models that lack them. This matters: e.g. claude-fable-5-1 reads cache at
//    $0.25/M, not the $1.00/M a 10%-of-input rule would give.
//  - Lookup order: exact → alias → date-suffix stripped → case-insensitive →
//    provider prefix stripped → boundary-aware fuzzy match (longest key wins,
//    but a key never matches a longer version number: "gpt-5" does not price
//    "gpt-5.6-sol", "claude-fable-5" does not price "claude-fable-5-1").
//  - ccusage's `pricingOverrides` (~/.config/claude/ccusage.json) are honoured,
//    so custom gateway models price identically in both tools.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_PATH = path.join(here, '..', 'pricing.json');
const CACHE_PATH = path.join(os.homedir(), '.local', 'share', 'agent-monitor', 'pricing-cache.json');
const CACHE_TTL_MS = 24 * 3600 * 1000;
export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const MTOK = 1_000_000;
const bundled = JSON.parse(readFileSync(BUNDLED_PATH, 'utf8'));

// ---------- table state ----------
let table = null; // { models, aliases, fastMultipliers, defaults }
let index = null; // derived lookup structures
let status = { source: 'bundled', models: 0, fetchedAt: null };

function setTable(models, extra = {}) {
  table = {
    models,
    aliases: bundled.aliases || {},
    fastMultipliers: bundled.fastMultipliers || { exact: {}, prefix: {} },
    defaults: bundled.anthropicCacheMultipliers || { read: 0.1, write5m: 1.25, write1h: 2.0 },
    ...extra,
  };
  index = buildIndex(models);
}

function buildIndex(models) {
  const lower = new Map(); // lowercased key -> key
  const bySegment = new Map(); // last path segment (lowercased) -> key, bare keys win
  const bare = []; // keys without a provider prefix, for fuzzy matching
  for (const key of Object.keys(models)) {
    if (!lower.has(key.toLowerCase())) lower.set(key.toLowerCase(), key);
    const seg = key.slice(key.lastIndexOf('/') + 1).toLowerCase();
    const prev = bySegment.get(seg);
    if (!prev || (prev.includes('/') && !key.includes('/'))) bySegment.set(seg, key);
    if (!key.includes('/')) bare.push({ key, norm: normalize(key) });
  }
  return { lower, bySegment, bare };
}

setTable({ ...bundled.models });

// ---------- LiteLLM ingestion ----------
const per = (v) => (typeof v === 'number' && Number.isFinite(v) ? +(v * MTOK).toPrecision(12) : undefined);

/** Reduce a raw LiteLLM table to BURN's per-model shape ($/MTok). */
export function reduceLiteLLM(raw) {
  const out = {};
  for (const [key, v] of Object.entries(raw || {})) {
    if (!v || typeof v !== 'object' || key === 'sample_spec') continue;
    if (v.mode && !['chat', 'responses', 'completion'].includes(v.mode)) continue;
    const e = { in: per(v.input_cost_per_token), out: per(v.output_cost_per_token) };
    if (e.in == null || e.out == null) continue;
    const cr = per(v.cache_read_input_token_cost);
    const cw = per(v.cache_creation_input_token_cost);
    const cw1h = per(v.cache_creation_input_token_cost_above_1hr);
    if (cr != null) e.cacheRead = cr;
    if (cw != null) e.cacheWrite5m = cw;
    if (cw1h != null) e.cacheWrite1h = cw1h;
    const fast = v.provider_specific_entry?.fast;
    if (typeof fast === 'number') e.fast = fast;
    out[key] = e;
  }
  return out;
}

export async function fetchLiteLLM({ timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(LITELLM_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || typeof json !== 'object' || !Object.keys(json).length) throw new Error('empty table');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function readCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (!c?.models || typeof c.fetchedAt !== 'number') return null;
    return c;
  } catch {
    return null;
  }
}

function writeCache(models) {
  try {
    mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), models }));
  } catch {}
}

// ccusage-compatible overrides: { defaults: { pricingOverrides: { model: {
//   inputCostPerToken, outputCostPerToken, cacheReadInputTokenCost,
//   cacheCreationInputTokenCost } } } } — per-token USD.
function readCcusageOverrides() {
  const out = {};
  const files = [
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude', 'ccusage.json'),
    path.join(os.homedir(), '.claude', 'ccusage.json'),
  ];
  for (const f of files) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    const ov = cfg?.defaults?.pricingOverrides || cfg?.pricingOverrides || {};
    for (const [model, o] of Object.entries(ov)) {
      if (!o || typeof o !== 'object') continue;
      const e = { in: per(o.inputCostPerToken), out: per(o.outputCostPerToken) };
      if (e.in == null || e.out == null) continue;
      const cr = per(o.cacheReadInputTokenCost);
      const cw = per(o.cacheCreationInputTokenCost);
      if (cr != null) e.cacheRead = cr;
      if (cw != null) e.cacheWrite5m = cw;
      out[model] = e;
    }
  }
  return out;
}

/**
 * Load the live table: bundled ← LiteLLM (disk cache, refreshed daily) ←
 * ccusage overrides. Never throws; on any failure the bundled table stays in
 * force. Returns { source, models, fetchedAt }.
 */
export async function loadPricing({ offline = process.env.BURN_OFFLINE === '1', timeoutMs = 8000 } = {}) {
  let models = { ...bundled.models };
  let source = 'bundled';
  let fetchedAt = null;
  if (!offline) {
    let cache = readCache();
    if (!cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
      try {
        const fresh = reduceLiteLLM(await fetchLiteLLM({ timeoutMs }));
        if (Object.keys(fresh).length > 100) {
          writeCache(fresh);
          cache = { fetchedAt: Date.now(), models: fresh };
          source = 'litellm';
        }
      } catch {
        // offline or GitHub hiccup — a stale cache still beats the bundle
        if (cache) source = 'cache (stale)';
      }
    } else {
      source = 'cache';
    }
    if (cache) {
      Object.assign(models, cache.models);
      fetchedAt = cache.fetchedAt;
    }
  }
  const overrides = readCcusageOverrides();
  Object.assign(models, overrides);
  setTable(models);
  status = { source, models: Object.keys(models).length, fetchedAt, overrides: Object.keys(overrides).length };
  return status;
}

export function pricingStatus() {
  return status;
}

// ---------- model resolution ----------
function normalize(s) {
  return s.toLowerCase().replace(/[.@]/g, '-');
}
function stripDate(s) {
  return s.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/@\d{8}$/, '');
}
function isBoundary(ch) {
  return ch == null || !/[a-z0-9]/i.test(ch);
}

// A key ending in a digit must not match a longer version: "gpt-5" vs
// "gpt-5.6-sol", "claude-fable-5" vs "claude-fable-5-1".
function suffixIsVersion(key, suffix) {
  if (!/\d$/.test(key)) return false;
  if (!suffix || !'-.'.includes(suffix[0])) return false;
  return /^\d/.test(suffix.slice(1));
}

function containsKey(value, key) {
  let from = 0;
  while (true) {
    const i = value.indexOf(key, from);
    if (i < 0) return false;
    const before = i > 0 ? value[i - 1] : null;
    const suffix = value.slice(i + key.length);
    if (isBoundary(before) && isBoundary(suffix[0]) && !suffixIsVersion(key, suffix)) return true;
    from = i + 1;
  }
}

function direct(name) {
  const m = table.models;
  if (m[name]) return name;
  const lower = index.lower.get(name.toLowerCase());
  if (lower) return lower;
  const seg = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  return index.bySegment.get(seg) || null;
}

/** Resolve a model id to a pricing-table key (or null). */
export function resolveModel(model) {
  if (!model || typeof model !== 'string') return null;
  const candidates = [model];
  const alias = table.aliases[model] || table.aliases[stripDate(model)];
  if (alias) candidates.push(alias);
  const stripped = stripDate(model);
  if (stripped !== model) candidates.push(stripped);
  for (const c of candidates) {
    const hit = direct(c);
    if (hit) return hit;
  }
  // Fuzzy, ccusage-style: key contained in model or model contained in key at
  // token boundaries (raw or normalized), longest key wins.
  const raw = model.toLowerCase();
  const norm = normalize(model);
  let best = null;
  for (const { key, norm: kn } of index.bare) {
    const kl = key.toLowerCase();
    const ok =
      containsKey(raw, kl) || containsKey(kl, raw) || containsKey(norm, kn) || containsKey(kn, norm);
    if (!ok) continue;
    if (!best || key.length > best.length || (key.length === best.length && key < best)) best = key;
  }
  return best;
}

/** Full rate card for a model: { in, out, cacheRead, cacheWrite5m, cacheWrite1h, fast } in $/MTok. */
export function matchModel(model) {
  const key = resolveModel(model);
  if (!key) return null;
  const p = table.models[key];
  const d = table.defaults;
  return {
    key,
    in: p.in,
    out: p.out,
    cacheRead: p.cacheRead ?? p.in * d.read,
    cacheWrite5m: p.cacheWrite5m ?? p.in * d.write5m,
    cacheWrite1h: p.cacheWrite1h ?? p.cacheWrite5m ?? p.in * d.write1h,
    fast: p.fast ?? fastMultiplier(key) ?? null,
  };
}

/** Priority/fast-tier multiplier for a model, if one is known. */
export function fastMultiplier(model) {
  if (!model) return null;
  const fm = table.fastMultipliers;
  const exact = fm.exact?.[model] ?? fm.exact?.[table.aliases[model]] ?? null;
  if (exact != null) return exact;
  const norm = normalize(model);
  for (const part of norm.split(/[/:]/)) {
    for (const [base, mult] of Object.entries(fm.prefix || {})) {
      const i = part.lastIndexOf(base);
      if (i < 0) continue;
      const rest = part.slice(i + base.length);
      if (rest === '' || rest[0] === '-') return mult;
    }
  }
  return null;
}

// ---------- cost math ----------
// u: { in, out, cacheRead, cacheW5m, cacheW1h, mult?, style? }
//   in    — non-cached input tokens in BOTH accounting styles. Anthropic
//           reports it that way natively; Codex/OpenAI report cached tokens as
//           a subset of input_tokens, so sources subtract before storing.
//           Token totals are then in + out + cacheRead + cache writes, the
//           same sum ccusage reports.
//   mult  — service-tier multiplier (Codex priority/fast = 2x), default 1
//   style — 'anthropic' | 'openai' accounting; overrides the per-agent default

// Anthropic-style usage: cache tokens are billed separately from input_tokens.
export function costAnthropic(model, u) {
  const p = matchModel(model);
  if (!p) return null;
  const mult = u.mult ?? 1;
  return (
    ((u.in * p.in +
      u.cacheRead * p.cacheRead +
      u.cacheW5m * p.cacheWrite5m +
      u.cacheW1h * p.cacheWrite1h +
      u.out * p.out) /
      MTOK) *
    mult
  );
}

// OpenAI-style usage: cached reads at the cache rate, cache writes are not
// billed separately (they are ordinary input on the request that wrote them).
export function costOpenAI(model, u) {
  const p = matchModel(model);
  if (!p) return null;
  const mult = u.mult ?? 1;
  return ((u.in * p.in + u.cacheRead * p.cacheRead + u.out * p.out) / MTOK) * mult;
}

const isAnthropicStyle = (agent, u) => (u.style ? u.style === 'anthropic' : agent === 'claude-code');

// Cost split by token kind — powers "output is 0.4% of tokens but 30% of
// cost" style breakdowns.
export function costParts(agent, model, u) {
  const p = matchModel(model);
  if (!p) return null;
  const mult = u.mult ?? 1;
  if (isAnthropicStyle(agent, u)) {
    return {
      input: (u.in * p.in * mult) / MTOK,
      output: (u.out * p.out * mult) / MTOK,
      cacheRead: (u.cacheRead * p.cacheRead * mult) / MTOK,
      cacheWrite: ((u.cacheW5m * p.cacheWrite5m + u.cacheW1h * p.cacheWrite1h) * mult) / MTOK,
    };
  }
  return {
    input: (u.in * p.in * mult) / MTOK,
    output: (u.out * p.out * mult) / MTOK,
    cacheRead: (u.cacheRead * p.cacheRead * mult) / MTOK,
    cacheWrite: 0,
  };
}

// What the same request would have cost with no cache at all — the baseline
// for "cache saved you $X".
export function costUncached(agent, model, u) {
  const p = matchModel(model);
  if (!p) return null;
  const mult = u.mult ?? 1;
  if (isAnthropicStyle(agent, u)) {
    return (((u.in + u.cacheRead + u.cacheW5m + u.cacheW1h) * p.in + u.out * p.out) / MTOK) * mult;
  }
  return (((u.in + u.cacheRead) * p.in + u.out * p.out) / MTOK) * mult;
}
