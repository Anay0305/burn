import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Tailer } from '../lib/tailer.js';
import { costAnthropic } from '../lib/pricing.js';

const ROOT = path.join(os.homedir(), '.claude', 'projects');

// Claude Code writes one JSONL line per assistant content block; the same API
// response (same message.id + requestId) repeats its usage on each line, and a
// streaming update can revise counts upward. Track last-seen usage per key and
// emit only the delta.
export function startClaudeCode({ store, backfillStart, persist = null }) {
  const seen = new Map(); // dedupe key -> last usage totals

  const tailer = new Tailer({
    backfillStart,
    persist,
    listFiles: async () => {
      // Transcripts live at <project>/<uuid>.jsonl, and subagent transcripts
      // at <project>/<sessionId>/subagents/agent-*.jsonl — walk recursively.
      const files = [];
      const walk = async (dir, depth) => {
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        await Promise.all(
          entries.map(async (e) => {
            const full = path.join(dir, e.name);
            if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
            else if (e.isDirectory() && depth < 4) await walk(full, depth + 1);
          })
        );
      };
      await walk(ROOT, 0);
      return files;
    },
    onLine: (file, obj) => {
      const t = Date.parse(obj.timestamp) || Date.now();
      const mainline = !obj.isSidechain && obj.sessionId;
      const act = (kind, detail, extra) =>
        store.pushActivity({
          t, agent: 'claude-code', session: obj.sessionId, cwd: obj.cwd || '',
          kind, detail, ...extra,
        });

      // Live-state metadata from the main transcript (never sidechains, never
      // content): user turns start work; a terminal assistant stop means the
      // agent is waiting on the user. Tool/done activity is pushed further
      // down, once this response's token delta is known.
      if (mainline && obj.type === 'user') {
        if (obj.isCompactSummary) act('compact', 'context compacted');
        else if (!obj.toolUseResult) act('prompt', 'you sent a message');
        store.setSessionMeta('claude-code', obj.sessionId, {
          lastEventT: t,
          lastRole: 'user',
          stopReason: '',
          hasToolUse: false,
          // a tool_result is machinery inside a turn; a real message starts one
          ...(obj.toolUseResult ? {} : { turnStart: t }),
        });
      }
      if (mainline && obj.type === 'assistant' && obj.message) {
        const content = Array.isArray(obj.message.content) ? obj.message.content : [];
        const u = obj.message.usage;
        store.setSessionMeta('claude-code', obj.sessionId, {
          lastEventT: t,
          lastRole: 'assistant',
          stopReason: obj.message.stop_reason || '',
          hasToolUse: content.some((b) => b && b.type === 'tool_use'),
          ...(u
            ? {
                ctx:
                  (u.input_tokens || 0) +
                  (u.cache_read_input_tokens || 0) +
                  (u.cache_creation_input_tokens || 0),
              }
            : {}),
        });
      }

      if (obj.type !== 'assistant' || !obj.message?.usage) return;
      const msg = obj.message;
      if (!msg.model || msg.model === '<synthetic>') return;
      const u = msg.usage;
      const cc = u.cache_creation || {};
      const cur = {
        in: u.input_tokens || 0,
        out: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheW5m: cc.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens || 0),
        cacheW1h: cc.ephemeral_1h_input_tokens || 0,
      };
      const key = `${msg.id || file}|${obj.requestId || ''}`;
      const prev = seen.get(key);
      let delta = cur;
      if (prev) {
        delta = {
          in: Math.max(0, cur.in - prev.in),
          out: Math.max(0, cur.out - prev.out),
          cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
          cacheW5m: Math.max(0, cur.cacheW5m - prev.cacheW5m),
          cacheW1h: Math.max(0, cur.cacheW1h - prev.cacheW1h),
        };
      }
      seen.set(key, cur);
      if (seen.size > 50_000) {
        for (const k of seen.keys()) {
          seen.delete(k);
          if (seen.size <= 25_000) break;
        }
      }
      const total = delta.in + delta.out + delta.cacheRead + delta.cacheW5m + delta.cacheW1h;
      if (total === 0) return;
      const cost = costAnthropic(msg.model, delta);
      // Activity with real numbers attached — the response's token delta and
      // cost ride along with the tool names.
      if (mainline) {
        const content = Array.isArray(msg.content) ? msg.content : [];
        const tools = content.filter((b) => b && b.type === 'tool_use').map((b) => b.name);
        const extra = { tok: total, cost: cost ?? 0 };
        if (tools.length) {
          const counts = new Map();
          for (const name of tools) counts.set(name, (counts.get(name) || 0) + 1);
          act('tool', [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', '), extra);
        } else if (msg.stop_reason && msg.stop_reason !== 'tool_use') {
          act('done', 'turn done', extra);
        }
      }
      store.add({
        t,
        agent: 'claude-code',
        session: obj.sessionId || path.basename(file, '.jsonl'),
        model: msg.model,
        cwd: obj.cwd || '',
        ...delta,
        cost: cost ?? 0,
        priced: cost != null,
      });
    },
  });

  tailer.start();
  return tailer;
}
