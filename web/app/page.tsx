"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Meter } from "@/components/burn/meter";
import { BurnChart } from "@/components/burn/burn-chart";
import { ActivityFeed } from "@/components/burn/activity-feed";
import { TokenMix } from "@/components/burn/token-mix";
import { TopProjects } from "@/components/burn/top-projects";
import { ThemeToggle } from "@/components/burn/theme-toggle";
import { SessionsTable } from "@/components/burn/sessions-table";
import { useSnapshot } from "@/hooks/use-snapshot";
import { fmtClock, fmtMoney, fmtTok, rollingSeries, type Peak } from "@/lib/burn";
import { cn } from "@/lib/utils";

// "▲ $9.12/min · 15:59" — all-time high, persisted by the collector.
function fmtPeakTime(t: number): string {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? fmtClock(t)
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function PeakLine({ peak, fmt, suffix }: { peak?: Peak; fmt: (v: number) => string; suffix: string }) {
  if (!peak || peak.v <= 0) return null;
  return (
    <div className="mt-1 font-mono text-[11px] text-muted-foreground" title="All-time record">
      ▲ {fmt(peak.v)}
      {suffix} · {fmtPeakTime(peak.t)}
    </div>
  );
}

const pickTokens = (a: { tokens: number[] }) => a.tokens;
const pickOut = (a: { out: number[] }) => a.out;
const pickCost = (a: { cost: number[] }) => a.cost;

export default function Page() {
  const { snap, live } = useSnapshot();
  const [rangeSec, setRangeSec] = useState(900);
  const [mode, setMode] = useState<"all" | "out">("all");
  const [clock, setClock] = useState("");

  useEffect(() => {
    const t = setInterval(() => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      setClock(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!snap) return;
    document.title =
      snap.rates.costPerMin60 >= 0.005
        ? `${fmtMoney(snap.rates.costPerMin60)}/min · agent monitor`
        : "agent monitor";
  }, [snap]);

  const sparkPts = useMemo(() => {
    if (!snap) return "";
    const b = snap.buckets;
    const total = new Array(b.n).fill(0);
    for (const a of Object.values(b.agents)) {
      for (let i = 0; i < b.n; i++) total[i] += a.cost[i];
    }
    const pts = rollingSeries(total).slice(-72); // last 12 min
    const max = Math.max(...pts, 1e-9);
    return pts
      .map((v, i) => `${(i / (pts.length - 1)) * 114 + 3},${23 - (v / max) * 19}`)
      .join(" ");
  }, [snap]);

  return (
    <div className="page-enter mx-auto w-full max-w-[1400px] px-6 pb-14">
      <header className="flex items-baseline justify-between pt-5">
        <div className="font-mono text-[13px] font-bold tracking-[0.14em]">
          AGENT MONITOR
        </div>
        <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
          <span
            className={cn("size-[7px] rounded-full", live ? "bg-[var(--good)]" : "bg-muted-foreground")}
          />
          <span className={cn(live && "text-secondary-foreground")}>
            {live ? "live" : "reconnecting"}
          </span>
          <span className="border-l border-[var(--grid)] pl-2">{clock}</span>
          <ThemeToggle />
        </div>
      </header>

      <section
        className={cn(
          "mt-7 flex flex-col justify-between gap-8 transition-opacity lg:flex-row lg:items-end",
          !live && "opacity-55"
        )}
      >
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Spent today
          </div>
          <div className="mt-2">
            <Meter cost={snap?.today.cost ?? 0} perMin={snap?.rates.costPerMin60 ?? 0} />
          </div>
          <div className="mt-2 text-[13px] text-muted-foreground">
            <B>{fmtTok(snap?.today.tokens ?? 0)}</B> tokens&ensp;·&ensp;
            <B>{fmtTok(snap?.today.out ?? 0)}</B> output&ensp;·&ensp;
            <B>{String(snap?.activeSessions ?? 0)}</B>{" "}
            active session{snap?.activeSessions === 1 ? "" : "s"}
            {(snap?.forecast?.today ?? 0) > 0 && (
              <>
                &ensp;·&ensp;on pace <B>{fmtMoney(snap!.forecast!.today)}</B>
              </>
            )}
            {(snap?.waiting ?? 0) > 0 && (
              <span className="ml-3 font-medium text-[#fbbf24]">
                ◉ {snap!.waiting} waiting on you
              </span>
            )}
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-x-12 gap-y-6 pb-1 sm:grid-cols-4">
          <div className="min-w-28">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Burn
            </div>
            <div className="mt-1.5 font-mono text-[22px] font-semibold">
              {fmtMoney(snap?.rates.costPerMin60 ?? 0)}
              <span className="ml-1 font-sans text-[11.5px] font-normal text-muted-foreground">/min</span>
            </div>
            <PeakLine peak={snap?.peaks?.costPerMin} fmt={fmtMoney} suffix="/min" />
            <svg viewBox="0 0 120 26" className="mt-1.5 h-[26px] w-[120px]" aria-hidden>
              {sparkPts && (
                <>
                  <polyline
                    points={sparkPts}
                    fill="none"
                    stroke="var(--muted-foreground)"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  <circle
                    cx={sparkPts.split(" ").at(-1)?.split(",")[0]}
                    cy={sparkPts.split(" ").at(-1)?.split(",")[1]}
                    r="2.5"
                    fill="var(--foreground)"
                  />
                </>
              )}
            </svg>
          </div>
          <div className="min-w-28">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Tokens
            </div>
            <div className="mt-1.5 font-mono text-[22px] font-semibold">
              {fmtTok(snap?.rates.tokensPerMin60 ?? 0)}
              <span className="ml-1 font-sans text-[11.5px] font-normal text-muted-foreground">/min</span>
            </div>
            <PeakLine peak={snap?.peaks?.tokensPerMin} fmt={fmtTok} suffix="/min" />
          </div>
          <div className="min-w-28">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Output
            </div>
            <div className="mt-1.5 font-mono text-[22px] font-semibold">
              {(snap?.rates.outPerSec10 ?? 0) >= 10
                ? Math.round(snap!.rates.outPerSec10)
                : (snap?.rates.outPerSec10 ?? 0).toFixed(1)}
              <span className="ml-1 font-sans text-[11.5px] font-normal text-muted-foreground">tok/s</span>
            </div>
            <PeakLine
              peak={snap?.peaks?.outPerSec}
              fmt={(v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1))}
              suffix=" tok/s"
            />
          </div>
          <div className="min-w-28">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Cache
            </div>
            <div className="mt-1.5 font-mono text-[22px] font-semibold">
              {Math.round((snap?.cache?.hitRate ?? 0) * 100)}
              <span className="ml-1 font-sans text-[11.5px] font-normal text-muted-foreground">% hit</span>
            </div>
            {(snap?.cache?.savings ?? 0) > 0 && (
              <div className="mt-1 font-mono text-[11px] text-muted-foreground" title="What today would cost with no prompt cache, minus what it did">
                saved {fmtMoney(snap!.cache!.savings)} today
              </div>
            )}
          </div>
        </div>
      </section>

      {(snap?.today.unpriced ?? 0) > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {fmtTok(snap!.today.unpriced)} tokens today have no pricing entry and are
          excluded from cost — add the model in <span className="font-mono">src/pricing.json</span>
        </p>
      )}

      <Separator className="my-6 bg-[var(--grid)]" />

      <div className="mb-3 flex gap-2.5">
        <ToggleGroup
          size="sm"
          variant="outline"
          value={[String(rangeSec)]}
          onValueChange={(v) => v[0] && setRangeSec(Number(v[0]))}
        >
          <ToggleGroupItem value="300" className="px-3 text-xs">5m</ToggleGroupItem>
          <ToggleGroupItem value="900" className="px-3 text-xs">15m</ToggleGroupItem>
          <ToggleGroupItem value="3600" className="px-3 text-xs">1h</ToggleGroupItem>
          <ToggleGroupItem value="86400" className="px-3 text-xs">24h</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          size="sm"
          variant="outline"
          value={[mode]}
          onValueChange={(v) => v[0] && setMode(v[0] as "all" | "out")}
        >
          <ToggleGroupItem value="all" className="px-3 text-xs">All tokens</ToggleGroupItem>
          <ToggleGroupItem value="out" className="px-3 text-xs">Output only</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className={cn("grid gap-3.5 md:grid-cols-2 transition-opacity", !live && "opacity-55")}>
        <Card className="bento gap-3 py-4">
          <CardContent className="px-4">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Cost · $/min · rolling 60s
            </div>
            {snap && (
              <BurnChart
                buckets={rangeSec === 86400 && snap.buckets24 ? snap.buckets24 : snap.buckets}
                metric={pickCost}
                rangeSec={rangeSec}
                fmtValue={fmtMoney}
              />
            )}
          </CardContent>
        </Card>
        <Card className="bento gap-3 py-4">
          <CardContent className="px-4">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {mode === "out" ? "Output" : "Tokens"} · tok/min · rolling 60s
            </div>
            {snap && (
              <BurnChart
                buckets={rangeSec === 86400 && snap.buckets24 ? snap.buckets24 : snap.buckets}
                metric={mode === "out" ? pickOut : pickTokens}
                rangeSec={rangeSec}
                fmtValue={fmtTok}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-3.5 grid items-stretch gap-3.5 xl:grid-cols-[minmax(0,2.2fr)_minmax(260px,1fr)]">
        <div className="flex flex-col gap-3.5">
          <Card className="bento gap-3 py-4">
            <CardContent className="px-4">
              <SessionsTable sessions={snap?.sessions ?? []} now={snap?.now ?? Date.now()} />
            </CardContent>
          </Card>
          <Card className="bento flex-1 gap-3 py-4">
            <CardContent className="px-4">
              <TopProjects sessions={snap?.sessions ?? []} />
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-col gap-3.5">
          <Card className="bento min-h-0 flex-1 gap-3 py-4">
            <CardContent className="min-h-0 flex-1 px-4">
              <ActivityFeed activity={snap?.activity ?? []} />
            </CardContent>
          </Card>
          <Card className="bento gap-3 py-4">
            <CardContent className="px-4">
              <TokenMix
                title="Token mix · today"
                values={{
                  input: snap?.today.tin ?? 0,
                  output: snap?.today.out ?? 0,
                  cacheRead: snap?.today.cacheRead ?? 0,
                  cacheWrite: snap?.today.cacheW ?? 0,
                }}
                costs={snap?.today.costParts}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Priced at API list rates from <span className="font-mono">src/pricing.json</span> —
        subscription plans may bill differently.
      </p>
    </div>
  );
}

function B({ children }: { children: React.ReactNode }) {
  return (
    <b className="font-mono text-[12.5px] font-medium text-secondary-foreground">{children}</b>
  );
}
