#!/usr/bin/env node
// `burn ask "question"` — natural-language questions over the usage database.
// Only aggregates are sent to the API: per-day / per-project / per-model
// totals. Never prompts, transcripts or session content.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Anthropic from '@anthropic-ai/sdk';

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('usage: burn ask "which project cost the most this week?"');
  process.exit(1);
}

const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'agent-monitor');
let db;
try {
  db = new DatabaseSync(path.join(DATA_DIR, 'events.db'), { readOnly: true });
} catch {
  console.error('burn ask needs the collector\'s database — run `burn serve` or `burn web` at least once.');
  process.exit(1);
}

const q = (sql, ...args) => db.prepare(sql).all(...args);
const round = (x) => Math.round(x * 100) / 100;

const daily = q(`
  SELECT date(t/1000, 'unixepoch', 'localtime') AS day, agent,
         SUM(tin+tout+cr+w5+w1) AS tokens, SUM(tout) AS output, ROUND(SUM(cost),2) AS cost
  FROM events GROUP BY day, agent ORDER BY day`);
const projects = q(`
  SELECT cwd, SUM(tin+tout+cr+w5+w1) AS tokens, ROUND(SUM(cost),2) AS cost
  FROM events WHERE cwd != '' GROUP BY cwd ORDER BY SUM(cost) DESC LIMIT 12`);
const models = q(`
  SELECT model, agent, SUM(tin+tout+cr+w5+w1) AS tokens, ROUND(SUM(cost),2) AS cost
  FROM events GROUP BY model, agent ORDER BY SUM(cost) DESC LIMIT 10`);
let peaks = null;
try {
  peaks = JSON.parse(readFileSync(path.join(DATA_DIR, 'peaks.json'), 'utf8'));
} catch {}

const data = {
  generatedAt: new Date().toISOString(),
  note: 'tokens include cache reads/writes; cost is USD at API list rates; data covers up to the last 14 days',
  dailyByAgent: daily,
  topProjectsByCost: projects.map((p) => ({ ...p, cwd: p.cwd.split('/').slice(-2).join('/') })),
  topModels: models,
  allTimeRecords: peaks && {
    costPerMin: peaks.costPerMin && { usd: round(peaks.costPerMin.v), at: new Date(peaks.costPerMin.t).toISOString() },
    tokensPerMin: peaks.tokensPerMin && { tokens: Math.round(peaks.tokensPerMin.v), at: new Date(peaks.tokensPerMin.t).toISOString() },
    outputPerSec: peaks.outPerSec && { tokens: round(peaks.outPerSec.v), at: new Date(peaks.outPerSec.t).toISOString() },
  },
};

const client = new Anthropic();
try {
  const res = await client.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system:
      'You are the analyst inside BURN, a local coding-agent cost monitor. ' +
      'Answer the user\'s question from the JSON aggregates provided — concretely, with numbers, in a few sentences. ' +
      'If the data cannot answer it, say what is missing. Costs are US dollars at API list rates.',
    messages: [
      {
        role: 'user',
        content: `Usage data:\n${JSON.stringify(data)}\n\nQuestion: ${question}`,
      },
    ],
  });
  if (res.stop_reason === 'refusal') {
    console.error('the model declined to answer this one.');
    process.exit(1);
  }
  console.log(res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim());
} catch (err) {
  if (err?.status === 401 || /api key|authentication/i.test(String(err?.message))) {
    console.error('no Anthropic credentials — run `ant auth login` or export ANTHROPIC_API_KEY.');
  } else {
    console.error('ask failed:', err?.message || err);
  }
  process.exit(1);
}
