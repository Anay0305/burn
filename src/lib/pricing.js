import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(readFileSync(path.join(here, '..', 'pricing.json'), 'utf8'));

const MTOK = 1_000_000;
const prefixes = Object.keys(table.models).sort((a, b) => b.length - a.length);

export function matchModel(model) {
  if (!model) return null;
  if (table.models[model]) return table.models[model];
  const stripped = model.replace(/-\d{8}$/, '').replace(/@\d{8}$/, '');
  if (table.models[stripped]) return table.models[stripped];
  for (const p of prefixes) {
    if (stripped.startsWith(p)) return table.models[p];
  }
  // gateway/router ids often embed the real model (e.g. antigravity-claude-sonnet-4-6)
  for (const p of prefixes) {
    if (stripped.includes(p)) return table.models[p];
  }
  return null;
}

// Anthropic-style usage: cache tokens are billed separately from input_tokens.
export function costAnthropic(model, u) {
  const p = matchModel(model);
  if (!p) return null;
  const m = table.anthropicCacheMultipliers;
  return (
    (u.in * p.in +
      u.cacheRead * p.in * m.read +
      u.cacheW5m * p.in * m.write5m +
      u.cacheW1h * p.in * m.write1h +
      u.out * p.out) / MTOK
  );
}

// OpenAI-style usage: cached_input_tokens is a subset of input_tokens;
// cache writes are billed as ordinary input.
export function costOpenAI(model, u) {
  const p = matchModel(model);
  if (!p) return null;
  const cachedRate = p.cachedIn ?? p.in * 0.1;
  const fresh = Math.max(0, u.in - u.cacheRead);
  return (fresh * p.in + u.cacheRead * cachedRate + u.out * p.out) / MTOK;
}

// Cost split by token kind — powers "output is 0.4% of tokens but 30% of
// cost" style breakdowns.
export function costParts(agent, model, u) {
  const p = matchModel(model);
  if (!p) return null;
  if (agent === 'claude-code') {
    const m = table.anthropicCacheMultipliers;
    return {
      input: (u.in * p.in) / MTOK,
      output: (u.out * p.out) / MTOK,
      cacheRead: (u.cacheRead * p.in * m.read) / MTOK,
      cacheWrite: (u.cacheW5m * p.in * m.write5m + u.cacheW1h * p.in * m.write1h) / MTOK,
    };
  }
  const cachedRate = p.cachedIn ?? p.in * 0.1;
  return {
    input: (Math.max(0, u.in - u.cacheRead) * p.in) / MTOK,
    output: (u.out * p.out) / MTOK,
    cacheRead: (u.cacheRead * cachedRate) / MTOK,
    cacheWrite: 0,
  };
}

// What the same request would have cost with no cache at all — the baseline
// for "cache saved you $X".
export function costUncached(agent, model, u) {
  const p = matchModel(model);
  if (!p) return null;
  if (agent === 'claude-code') {
    return ((u.in + u.cacheRead + u.cacheW5m + u.cacheW1h) * p.in + u.out * p.out) / MTOK;
  }
  // openai-style: cacheRead is a subset of in, so full-in covers it
  return (Math.max(u.in, u.cacheRead) * p.in + u.out * p.out) / MTOK;
}
