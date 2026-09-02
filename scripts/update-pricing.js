#!/usr/bin/env node
// Regenerate src/pricing.json — the bundled fallback pricing table — from the
// same LiteLLM dataset ccusage prices against. The collector also refreshes
// from LiteLLM at runtime (see src/lib/pricing.js); this keeps the offline
// fallback current for users who run with BURN_OFFLINE=1 or without network.
//
//   node scripts/update-pricing.js            # fetch + rewrite src/pricing.json
//   node scripts/update-pricing.js --check    # fetch + print what would change
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LITELLM_URL, fetchLiteLLM, reduceLiteLLM } from '../src/lib/pricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'src', 'pricing.json');
const check = process.argv.includes('--check');

const current = JSON.parse(readFileSync(OUT, 'utf8'));
const raw = await fetchLiteLLM({ timeoutMs: 30_000 });
const all = reduceLiteLLM(raw);

// Bundle canonical (un-prefixed) ids only: "claude-opus-5", "gpt-5.6-sol", …
// Provider-prefixed entries ("azure/gpt-5.6-sol") are gateway resale rates and
// come from the runtime refresh instead.
const models = {};
for (const key of Object.keys(all).sort()) {
  if (!key.includes('/')) models[key] = all[key];
}
// Keep hand-maintained entries that LiteLLM does not carry.
for (const [key, entry] of Object.entries(current.models || {})) {
  if (entry._local && !models[key]) models[key] = entry;
}

const next = {
  _comment: current._comment,
  source: LITELLM_URL,
  generatedAt: new Date().toISOString(),
  aliases: current.aliases,
  fastMultipliers: current.fastMultipliers,
  anthropicCacheMultipliers: current.anthropicCacheMultipliers,
  models,
};

const before = Object.keys(current.models || {});
const after = Object.keys(models);
const added = after.filter((k) => !current.models?.[k]);
const removed = before.filter((k) => !models[k]);
const changed = after.filter(
  (k) => current.models?.[k] && JSON.stringify(current.models[k]) !== JSON.stringify(models[k])
);
console.log(`litellm: ${Object.keys(raw).length} entries → ${after.length} bundled models`);
console.log(`added ${added.length}, removed ${removed.length}, changed ${changed.length}`);
for (const k of changed.slice(0, 40)) {
  console.log(`  ~ ${k}: ${JSON.stringify(current.models[k])} → ${JSON.stringify(models[k])}`);
}
if (!check) {
  writeFileSync(OUT, JSON.stringify(next, null, 2) + '\n');
  console.log(`wrote ${OUT}`);
}
