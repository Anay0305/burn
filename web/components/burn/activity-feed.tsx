"use client";

import { agentColor, fmtMoney, fmtTok, type ActivityEntry } from "@/lib/burn";
import { cn } from "@/lib/utils";

// Live event river — session metadata only (tool names, turn boundaries,
// compactions), never message content.
const KIND_CLASS: Record<string, string> = {
  done: "text-[var(--good)]",
  compact: "text-[#fbbf24]",
  model: "text-[#fbbf24]",
  prompt: "text-foreground",
};

const clock = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function ActivityFeed({ activity }: { activity: ActivityEntry[] }) {
  const rows = activity.slice().reverse();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Activity · live
      </div>
      <ul
        className="scroll-thin mt-2 max-h-[70vh] min-h-0 flex-1 basis-0 space-y-1 overflow-y-auto pr-1.5 font-mono text-xs"
        aria-live="polite"
      >
        {rows.map((a, i) => (
          <li key={`${a.t}-${i}`} className="flex items-center gap-2 whitespace-nowrap overflow-hidden">
            <span className="text-muted-foreground tabular-nums">{clock(a.t)}</span>
            <i className="size-1.5 shrink-0 rounded-full" style={{ background: agentColor(a.agent) }} />
            <span className="w-28 shrink-0 truncate text-secondary-foreground">
              {a.cwd ? a.cwd.split("/").slice(-2).join("/") : a.session.slice(0, 8)}
            </span>
            <span className={cn("truncate", KIND_CLASS[a.kind] ?? "text-muted-foreground")}>
              {a.detail || a.kind}
            </span>
            {(a.tok ?? 0) > 0 && (
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                {fmtTok(a.tok!)}
                {(a.cost ?? 0) >= 0.005 && (
                  <span className="ml-2 text-secondary-foreground">{fmtMoney(a.cost!)}</span>
                )}
              </span>
            )}
          </li>
        ))}
        {rows.length === 0 && (
          <li className="text-muted-foreground">watching for activity…</li>
        )}
      </ul>
    </div>
  );
}
