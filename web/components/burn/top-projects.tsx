"use client";

import { fmtMoney, fmtTok, type ProjectRow } from "@/lib/burn";

// The collector aggregates all sessions before limiting the session table.
export function TopProjects({ projects }: { projects: ProjectRow[] }) {
  const rows = projects.slice(0, 6).map((project) => ({
    ...project,
    name: project.cwd ? project.cwd.split("/").slice(-2).join("/") : project.key.slice(0, 16),
  }));

  const max = Math.max(...rows.map((r) => r.cost), 1e-9);

  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Top projects · last 24h
      </div>
      <div className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <div
            key={r.key}
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
