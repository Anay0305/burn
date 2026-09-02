<p align="center">
  <img src="assets/icons/burn.svg" width="72" alt="BURN">
</p>

<h1 align="center">BURN · agent monitor</h1>

<p align="center">
  Live token &amp; cost burn-rate for your coding agents — <b>Claude Code</b>, <b>Codex</b>, <b>OpenCode</b>.<br>
  A web dashboard, a full-screen TUI, desktop notifications, and an always-on collector. All local. No proxy, no wrapper, no prompts ever read.
</p>

<p align="center">
  <img src="docs/dashboard.png" alt="BURN web dashboard" width="900">
</p>

---

## Why

Coding agents burn tokens fast and quietly. `ccusage` tells you what yesterday cost; nothing tells you what *this minute* costs, which session is stuck, or that an agent finished twenty minutes ago and has been waiting on you since. BURN tails the session logs your agents already write and turns them into a live instrument:

- **$/min · tok/min · output tok/s** — rolling live rates, plus all-time records
- **Session states** — `working / ◉ needs you / idle`, derived from transcript structure (stop reasons, tool-use blocks) — never from message content
- **Desktop notifications** when a session finishes and is waiting on you, when one turn runs 15+ minutes, when a session looks like a runaway loop, or when you cross a budget
- **Context meters** per session — how close each one is to compaction
- **Cache economics** — hit rate, "cache saved you $X", and token-vs-cost mix (spoiler: cache reads are ~95% of tokens and output is ~10% of cost)
- **Live activity ticker** — tool names, turn boundaries, compactions, model switches, with the token/cost delta of each step
- **Per-session pages**, 5m/15m/1h/24h ranges, forecast to midnight, light & dark themes

Numbers cross-check against `ccusage daily` to the cent (`npm run check:ccusage` prints both side by side) — same LiteLLM price table, same dedupe rules, and the **nested subagent transcripts** (Task and Workflow agents) that a shallow directory walk misses. On a parallel-agent workload that's a 30%+ undercount.

## Sources

| Agent | Reads | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | per-response `usage`, cache read / 5m / 1h write split, deduped by `message.id` (final usage of a streamed response wins); walks the whole tree, so `<session>/subagents/*.jsonl` and `<session>/subagents/workflows/*/agent-*.jsonl` count |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | cumulative `token_count` events, diffed per rollout; forked/subagent threads skip the parent history they replay; `service_tier: priority` bills at the model's fast multiplier; rate-limit headroom when reported |
| OpenCode | `opencode.db` in `$OPENCODE_DATA_DIR`, `~/.local/share/opencode`, and the Flatpak data dir | read-only SQLite via `node:sqlite`; assistant-message `tokens` (reasoning billed as output) + OpenCode's own `cost`, diffed as rows update |

Gemini CLI isn't supported: its local chat files carry no token usage.

## Install

Requires **Node ≥ 22.5** (for the built-in `node:sqlite`). Linux desktop notifications use `notify-send` if present.

```sh
git clone https://github.com/Anay0305/burn.git
cd burn
npm ci && (cd web && npm ci && npm run build)
ln -s "$(pwd)/bin/burn" ~/.local/bin/burn      # or anywhere on your PATH
```

## Run

```sh
burn              # full-screen TUI — standalone, tails logs directly
burn web          # collector + Next.js dashboard → http://localhost:3000
burn serve        # collector only (SSE/API on :4090 + a lightweight vanilla UI)
burn ask "which project cost the most this week?"   # Claude over aggregates (needs Anthropic creds)
```

Everything starts populated: the collector backfills the last 26h of logs (`BACKFILL_HOURS` to change) and, after the first run, restores from its own SQLite store in milliseconds. When an upgrade changes how logs are read or priced, the store is dropped and rebuilt from the logs automatically.

### Always-on collector (recommended)

```sh
cp scripts/systemd/agent-monitor.service ~/.config/systemd/user/
# edit WorkingDirectory if the repo isn't at ~/Desktop/Projects/agent-monitor
systemctl --user enable --now agent-monitor.service
```

With the service running, `burn web` just attaches the dashboard, notifications never miss a session, and records persist. Budget alerts are opt-in via `Environment=` lines in the unit:

| Variable | Effect |
|---|---|
| `BURN_ALERT_PER_MIN=15` | notify when burn stays above $15/min for 5 minutes |
| `BURN_ALERT_TODAY=2500` | notify once when today's spend crosses $2500 |
| `AGENT_MONITOR_NOTIFY=0` | disable all desktop notifications |

<p align="center">
  <img src="docs/tui.png" alt="BURN TUI" width="900">
</p>

### TUI keys

`↑/↓` select a session (chart follows it) · `esc` back to all agents · `1/2/3/4` = 5m/15m/1h/24h · `t` all tokens ↔ output only · `q` quit

It runs in the alternate screen buffer with synchronized-output frames (no flicker), fills the terminal height, and draws braille line charts.

<p align="center">
  <img src="docs/session.png" alt="BURN session page" width="900">
</p>

## Pricing

Rates come from [LiteLLM's model price table](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) — the same source `ccusage` uses — so the two agree. The collector and TUI refresh it on start (cached 24h in `~/.local/share/agent-monitor/pricing-cache.json`); set `BURN_OFFLINE=1` to skip the network and use the bundled `src/pricing.json`, which `npm run pricing:update` regenerates from the same table.

- Every model carries its own cache-read / 5m-write / 1h-write rates (e.g. `claude-fable-5-1` reads cache at $0.25/M, not 10% of input); the Anthropic 10% / 125% / 200% multipliers are only the fallback for models without them
- Model ids resolve exact → alias → date-stripped → provider prefix stripped → boundary-aware fuzzy match, and a key never matches a longer version (`gpt-5` does not price `gpt-5.6-sol`; `claude-fable-5` does not price `claude-fable-5-1`)
- `pricingOverrides` in `~/.config/claude/ccusage.json` (ccusage's format) are honoured, so custom gateway models price identically in both tools
- Codex priority/fast tier: 2× for gpt-5.6 (from LiteLLM / ccusage's multiplier table)
- Unknown models still count tokens; their cost is excluded and the UI says so
- `npm run check:ccusage [-- --since YYYY-MM-DD]` replays the logs and prints BURN vs `ccusage daily` per day and model

Costs are **API list rates**. Subscription plans bill differently — treat the dollar figures as "what this would cost on the API".

## Privacy

Set `BURN_MASK=1` on the collector or TUI to replace every project path with a stable pseudonym (`~/work/project-a`, `-b`, …) in all output — for screenshots, screen-shares and demos. The screenshots in this README were taken that way.

BURN reads *metadata*: token counts, model ids, timestamps, stop reasons, tool **names**, and the working-directory path. It never reads or stores prompt text, tool inputs/outputs, or message content. BURN makes two kinds of network call: a once-a-day fetch of LiteLLM's public price table (a static JSON file; nothing about you is sent, and `BURN_OFFLINE=1` turns it off), and `burn ask`, which sends per-day/per-project/per-model **aggregates** to the Claude API — and only when you invoke it.

## Architecture

```
src/
  server.js          collector: tails sources, SQLite persistence, SSE + JSON API, notifications
  lib/store.js       events, sessions, rolling rates, buckets, states, peaks, cache & forecast math
  lib/tailer.js      resumable JSONL tailer (offsets + per-file state persisted)
  lib/db.js          node:sqlite (~/.local/share/agent-monitor/events.db, 14-day retention)
  lib/notify.js      notify-send: waiting-on-you, stuck turn, runaway, budget
  sources/           claude-code.js · codex.js · opencode.js  (~100 lines each; add your own)
  tui/               Ink + htm, no build step
  cli/ask.js         burn ask
web/                 Next.js + shadcn/ui + Recharts; proxies the collector same-origin
public/              zero-dependency vanilla dashboard, served by the collector itself
```

Adding an agent: a source provides `listFiles()` and an `onLine(file, json)` that calls `store.add({...})` with per-event deltas (see `codex.js` for JSONL, `opencode.js` for SQLite polling), then gets a color slot in the UIs.

## License

MIT © Anay Gupta
