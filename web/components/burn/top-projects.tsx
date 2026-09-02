"use client";

import { useMemo } from "react";
import { fmtMoney, fmtTok, type SessionRow } from "@/lib/burn";

// Sessions rolled up by project — the table above is per-session, so a
// project running several sessions (subagent fleets, restarts) only shows its
// true weight here. Ranked bars, single hue: this encodes magnitude, not
// identity.
export function TopProjects({ sessions }: { sessions: SessionRow[] }) {
  const rows = useMemo(() => {
    const byProject = new Map<
      string,
      { name: string; cost: number; tokens: number; sessions: number; active: boolean }
    >();
    for (const s of sessions) {
      const key = s.cwd || s.session;
      const cur = byProject.get(key) ?? {
        name: s.cwd ? s.cwd.split("/").slice(-2).join("/") : s.session.slice(0, 8),
        cost: 0,
        tokens: 0,
        sessions: 0,
        active: false,
      };
      cur.cost += s.cost;
      cur.tokens += s.tokens;
      cur.sessions += 1;
      cur.active = cur.active || s.state === "working" || s.state === "waiting";
      byProject.set(key, cur);
    }
    return [...byProject.values()].sort((a, b) => b.cost - a.cost).slice(0, 6);
  }, [sessions]);

  const max = Math.max(...rows.map((r) => r.cost), 1e-9);

  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Top projects · last 24h
      </div>
      <div className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <div
            key={r.name}
            className="-mx-1.5 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-foreground/[0.05]"
          >
            <div className="flex items-baseline gap-2 text-xs">
              <span className="truncate text-foreground">{r.name}</span>
              {r.sessions > 1 && (
                <span className="shrink-0 text-muted-foreground">×{r.sessions}</span>
              )}
              {r.active && <span className="shrink-0 text-[10px] text-[var(--good)]">● live</span>}
              <span className="ml-auto shrink-0 font-mono tabular-nums text-foreground">
                {fmtMoney(r.cost)}
              </span>
              <span className="w-14 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
                {fmtTok(r.tokens)}
              </span>
            </div>
            <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-[var(--grid)]">
              <div
                className="h-full rounded-full bg-[var(--chart-1)]"
                style={{ width: `${Math.max(1.5, (r.cost / max) * 100).toFixed(1)}%` }}
              />
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs text-muted-foreground">No projects yet.</p>}
      </div>
    </div>
  );
}
