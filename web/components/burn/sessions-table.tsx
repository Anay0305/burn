"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  agentColor, agentLabel, fmtAgo, fmtMoney, fmtTok, type SessionRow,
} from "@/lib/burn";
import { cn } from "@/lib/utils";

// Fixed column budget so the table NEVER scrolls horizontally: the project
// cell is the only flexible one and truncates; agent identity lives in its
// dot (label + model in the tooltip and on the session page).
export function SessionsTable({ sessions, now }: { sessions: SessionRow[]; now: number }) {
  const router = useRouter();
  const [filter, setFilter] = useState<string>("all");
  const open = (s: SessionRow) =>
    router.push(`/session/${encodeURIComponent(s.agent)}/${encodeURIComponent(s.session)}`);

  const agents = useMemo(
    () => [...new Set(sessions.map((s) => s.agent))].sort(),
    [sessions]
  );
  const rows = sessions.filter((s) => filter === "all" || s.agent === filter);
  const maxCost = Math.max(...rows.map((s) => s.cost), 1e-9);

  return (
    <div className="overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Sessions · last 24h
        </div>
        {agents.length > 1 && (
          <ToggleGroup
            size="sm"
            value={[filter]}
            onValueChange={(v) => setFilter(v[0] || "all")}
            className="gap-1"
          >
            <ToggleGroupItem value="all" className="h-6 rounded-full px-3 text-xs">
              All
            </ToggleGroupItem>
            {agents.map((a) => (
              <ToggleGroupItem key={a} value={a} className="h-6 rounded-full px-3 text-xs">
                {agentLabel(a)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>
      <Table className="mt-2 table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <Th>Project</Th>
            <Th w="w-32">State</Th>
            <Th w="w-14" right>ctx</Th>
            <Th w="w-14" right>tok/s</Th>
            <Th w="w-16" right>$/min</Th>
            <Th w="w-16" right>Tokens</Th>
            <Th w="w-20" right>Cost</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <TableRow
              key={`${s.agent}:${s.session}`}
              tabIndex={0}
              onClick={() => open(s)}
              onKeyDown={(e) => e.key === "Enter" && open(s)}
              className={cn(
                "cursor-pointer border-[var(--grid)] transition-colors",
                !s.active && "opacity-50"
              )}
              title={`${agentLabel(s.agent)} · ${s.model || "unknown model"} — open session`}
            >
              <TableCell className="max-w-0">
                <span className="flex items-center gap-2 text-foreground">
                  <i
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: agentColor(s.agent) }}
                    aria-label={agentLabel(s.agent)}
                  />
                  <span className="truncate">
                    {s.cwd ? s.cwd.split("/").slice(-2).join("/") : s.session.slice(0, 8)}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                <StateBadge state={s.state} turnMs={s.turnMs} ago={fmtAgo(s.lastT, now)} />
              </TableCell>
              <Num strong={(s.ctx ?? 0) > 400_000}>{s.ctx ? fmtTok(s.ctx) : "·"}</Num>
              <Num strong={s.outPerSec >= 0.05}>
                {s.outPerSec >= 0.05 ? s.outPerSec.toFixed(1) : "·"}
              </Num>
              <Num strong={s.costPerMin >= 0.0005}>
                {s.costPerMin >= 0.0005 ? fmtMoney(s.costPerMin) : "·"}
              </Num>
              <Num>{fmtTok(s.tokens)}</Num>
              <TableCell className="text-right font-mono text-xs tabular-nums text-foreground">
                {s.unpriced && s.cost === 0 ? "—" : fmtMoney(s.cost)}
                <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-[var(--grid)]">
                  <i
                    className="block h-full rounded-full bg-[var(--chart-1)]"
                    style={{ width: `${Math.max(2, (s.cost / maxCost) * 100).toFixed(1)}%` }}
                  />
                </span>
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">
                No sessions yet — start an agent and it appears here.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

const fmtDur = (ms: number) => {
  const m = Math.floor(ms / 60000);
  return m ? `${m}m` : `${Math.round(ms / 1000)}s`;
};

// Status colors are reserved for state and always paired with a label.
function StateBadge({ state, turnMs, ago }: { state?: string; turnMs?: number; ago?: string }) {
  if (state === "waiting") {
    return <span className="whitespace-nowrap text-xs font-medium text-[#fbbf24]">◉ needs you</span>;
  }
  if (state === "working") {
    return (
      <span className="whitespace-nowrap text-xs text-[var(--good)]">
        ● working
        {turnMs && turnMs > 60_000 ? (
          <span className="ml-1 font-mono text-muted-foreground">{fmtDur(turnMs)}</span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap text-xs text-muted-foreground">
      idle{ago ? ` · ${ago}` : ""}
    </span>
  );
}

function Th({
  children,
  right,
  w,
}: {
  children: React.ReactNode;
  right?: boolean;
  w?: string;
}) {
  return (
    <TableHead
      className={cn(
        "h-8 px-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground",
        right && "text-right",
        w
      )}
    >
      {children}
    </TableHead>
  );
}

function Num({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <TableCell
      className={cn(
        "px-2.5 text-right font-mono text-xs tabular-nums",
        strong ? "text-foreground" : "text-secondary-foreground"
      )}
    >
      {children}
    </TableCell>
  );
}
