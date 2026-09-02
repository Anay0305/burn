// Desktop notifications for session-state transitions (collector only —
// in the TUI you're already looking at the screen).
//
//   working → waiting   "agent finished, waiting on you"
//   working > 15 min    "still grinding one turn" (once per turn)
//
// Disable with AGENT_MONITOR_NOTIFY=0.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionState } from './store.js';

const ICONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'icons');
const ICON = {
  waiting: path.join(ICONS_DIR, 'waiting.png'),
  stuck: path.join(ICONS_DIR, 'stuck.png'),
  alert: path.join(ICONS_DIR, 'alert.png'),
  burn: path.join(ICONS_DIR, 'burn.png'),
};

const STUCK_MS = 15 * 60 * 1000;
const MIN_WORKED_MS = 30 * 1000; // don't ping for trivial one-shot answers

// Budget alerts, opt-in via env:
//   BURN_ALERT_PER_MIN=15   sustained burn above $15/min for 5 min
//   BURN_ALERT_TODAY=2000   today's spend crossed $2000 (once per day)
const ALERT_PER_MIN = Number(process.env.BURN_ALERT_PER_MIN || 0);
const ALERT_TODAY = Number(process.env.BURN_ALERT_TODAY || 0);
// Runaway: a session burning ≥$1/min with almost no output for 10 minutes
// straight is usually a loop, not progress.
const RUNAWAY_MS = 10 * 60 * 1000;

function send(title, body, urgency = 'normal', icon = ICON.burn) {
  try {
    const p = spawn(
      'notify-send',
      ['-a', 'agent-monitor', '-u', urgency, '-i', icon, title, body],
      { stdio: 'ignore' }
    );
    p.on('error', () => {}); // notify-send missing — silently do nothing
  } catch {}
}

const fmtMin = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m ? `${m}m ${s}s` : `${s}s`;
};

export function startNotifier(store, { intervalMs = 5000 } = {}) {
  if (process.env.AGENT_MONITOR_NOTIFY === '0') return null;

  const prev = new Map(); // key -> { state, since, stuckNotified }
  let warmedUp = false;
  // Skip the first pass entirely: backfill replays history and every session
  // "transitions" at once.
  setTimeout(() => (warmedUp = true), 15_000);

  let burnHighSince = 0;
  let burnNotifiedAt = 0;
  let todayNotifiedDay = '';
  const runaway = new Map(); // key -> { since, notifiedTurn }

  const tick = () => {
    const now = Date.now();

    // ---- budget alerts (opt-in) + runaway watch (always on) ----
    {
      if (ALERT_PER_MIN > 0) {
        const w60 = store.windowSums(now, 60_000);
        if (w60.cost >= ALERT_PER_MIN) {
          if (!burnHighSince) burnHighSince = now;
          if (now - burnHighSince >= 5 * 60 * 1000 && now - burnNotifiedAt > 3600_000) {
            burnNotifiedAt = now;
            send(
              'burn alert',
              `sustained $${w60.cost.toFixed(2)}/min for 5+ minutes (threshold $${ALERT_PER_MIN}/min)`,
              'critical',
              ICON.alert
            );
          }
        } else {
          burnHighSince = 0;
        }
      }
      if (ALERT_TODAY > 0 && warmedUp) {
        const day = new Date(now).toDateString();
        const today = store.todaySums(now);
        if (today.cost >= ALERT_TODAY && todayNotifiedDay !== day) {
          todayNotifiedDay = day;
          send('budget crossed', `today's spend hit $${today.cost.toFixed(0)} (threshold $${ALERT_TODAY})`, 'critical', ICON.alert);
        }
      }
      // ---- runaway sessions: heavy burn, no output ----
      const rates = store.sessionRates(now);
      for (const [key, r] of rates) {
        const costMin = r.cost60;
        const outSec = r.out30 / 30;
        const rw = runaway.get(key) || { since: 0, notifiedTurn: 0 };
        if (costMin >= 1 && outSec < 0.3) {
          if (!rw.since) rw.since = now;
          const s = store.sessions.get(key);
          if (
            warmedUp && s &&
            now - rw.since >= RUNAWAY_MS &&
            rw.notifiedTurn !== (s.meta.turnStart || 1)
          ) {
            rw.notifiedTurn = s.meta.turnStart || 1;
            const name = s.cwd ? s.cwd.split('/').slice(-2).join('/') : key;
            send(
              `${name} — possible runaway`,
              `$${costMin.toFixed(2)}/min for 10+ min with almost no output — check it`,
              'critical',
              ICON.alert
            );
          }
        } else {
          rw.since = 0;
        }
        runaway.set(key, rw);
      }
    }

    for (const s of store.sessions.values()) {
      const key = `${s.agent}:${s.session}`;
      const state = sessionState(s, now);
      const p = prev.get(key);
      if (!p) {
        prev.set(key, { state, since: now, stuckNotified: false, turnStart: s.meta.turnStart });
        continue;
      }
      if (s.meta.turnStart !== p.turnStart) {
        p.turnStart = s.meta.turnStart;
        p.stuckNotified = false; // new turn, new budget
      }
      if (state !== p.state) {
        const workedMs = now - (s.meta.turnStart || p.since);
        if (warmedUp && p.state === 'working' && state === 'waiting' && workedMs >= MIN_WORKED_MS) {
          const name = s.cwd ? s.cwd.split('/').slice(-2).join('/') : s.session.slice(0, 8);
          send(
            `${name} — waiting on you`,
            `turn took ${fmtMin(workedMs)} · session total $${s.cost.toFixed(2)}`,
            'normal',
            ICON.waiting
          );
        }
        prev.set(key, { state, since: now, stuckNotified: false, turnStart: s.meta.turnStart });
      } else if (
        warmedUp &&
        state === 'working' &&
        !p.stuckNotified &&
        s.meta.turnStart &&
        now - s.meta.turnStart > STUCK_MS
      ) {
        p.stuckNotified = true;
        const name = s.cwd ? s.cwd.split('/').slice(-2).join('/') : s.session.slice(0, 8);
        send(
          `${name} — still working`,
          `one turn running for ${fmtMin(now - s.meta.turnStart)} — might be worth a look`,
          'low',
          ICON.stuck
        );
      }
    }
  };

  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer) };
}
