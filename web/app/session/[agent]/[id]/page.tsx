"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { BurnChart } from "@/components/burn/burn-chart";
import { TokenMix } from "@/components/burn/token-mix";
import { ThemeToggle } from "@/components/burn/theme-toggle";
import {
  agentColor, agentLabel, contextWindow, fmtAgo, fmtMoney, fmtTok,
  type SessionDetail,
} from "@/lib/burn";
import { cn } from "@/lib/utils";

const pickTokens = (a: { tokens: number[] }) => a.tokens;
const pickCost = (a: { cost: number[] }) => a.cost;

const fmtDur = (ms: number) => {
  const m = Math.floor(ms / 60000);
  return m ? `${m}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`;
};

export default function SessionPage() {
  const { agent, id } = useParams<{ agent: string; id: string }>();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [rangeSec, setRangeSec] = useState(3600);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/session?agent=${encodeURIComponent(agent)}&id=${encodeURIComponent(id)}`
        );
        if (res.status === 404) {
          if (!cancelled) setMissing(true);
          return;
        }
        if (!res.ok) return;
        const data: SessionDetail = await res.json();
        if (!cancelled) {
          setDetail(data);
          setMissing(false);
        }
      } catch {}
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [agent, id]);

  const info = detail?.info;
  const project = info?.cwd ? info.cwd.split("/").slice(-2).join("/") : id.slice(0, 8);
  const win = contextWindow(info?.model ?? "");
  const ctxPct = win && info?.ctx ? info.ctx / win : 0;

  return (
    <div className="page-enter mx-auto w-full max-w-[1400px] px-6 pb-14">
      <header className="flex items-baseline justify-between pt-5">
        <div className="flex items-baseline gap-3">
          <Link
            href="/"
            className="font-mono text-[13px] font-bold tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
          >
            ← AGENT MONITOR
          </Link>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
          {info && (
            <span>
              session {id.slice(0, 8)} · started {fmtAgo(info.firstT, detail!.now)} ago
            </span>
          )}
          <ThemeToggle />
        </div>
      </header>

      {!info && !missing && (
        <div className="mt-7 space-y-4" aria-hidden>
          <div className="h-9 w-72 animate-pulse rounded-md bg-[var(--grid)]" />
          <div className="h-5 w-44 animate-pulse rounded-md bg-[var(--grid)]" />
          <div className="grid gap-3.5 md:grid-cols-2">
            <div className="h-[260px] animate-pulse rounded-xl bg-card" />
            <div className="h-[260px] animate-pulse rounded-xl bg-card" />
          </div>
        </div>
      )}

      {missing && (
        <p className="mt-10 text-sm text-muted-foreground">
          This session isn&apos;t in the collector&apos;s window anymore —{" "}
          <Link href="/" className="underline">back to the dashboard</Link>.
        </p>
      )}

      {info && (
        <>
          <section className="mt-7 flex flex-wrap items-end justify-between gap-6">
            <div>
              <div className="flex items-center gap-2.5">
                <i className="size-2.5 rounded-full" style={{ background: agentColor(info.agent) }} />
                <span className="text-sm text-muted-foreground">{agentLabel(info.agent)}</span>
                <StateBadge state={info.state} turnMs={info.turnMs} />
              </div>
              <h1 className="mt-2 font-mono text-[34px] font-semibold leading-tight" title={info.cwd}>
                {project}
              </h1>
              <div className="mt-1 font-mono text-xs text-muted-foreground">
                {info.models.join(" · ") || info.model}
              </div>
            </div>
            <div className="flex gap-9 pb-1">
              <Fig label="Cost" value={info.unpriced && info.cost === 0 ? "—" : fmtMoney(info.cost)} />
              <Fig label="Tokens" value={fmtTok(info.tokens)} />
              <Fig
                label="Burn"
                value={info.costPerMin >= 0.0005 ? fmtMoney(info.costPerMin) : "·"}
                unit="/min"
              />
              <Fig
                label="Output"
                value={info.outPerSec >= 0.05 ? info.outPerSec.toFixed(1) : "·"}
                unit="tok/s"
              />
              <Fig label="Cache saved" value={fmtMoney(info.savings)} />
            </div>
          </section>

          {info.ctx > 0 && win > 0 && (
            <div className="mt-5 max-w-md">
              <div className="flex items-baseline justify-between text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <span>Context</span>
                <span className="font-mono normal-case tracking-normal">
                  {fmtTok(info.ctx)} / {fmtTok(win)}
                </span>
              </div>
              <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-[var(--grid)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, ctxPct * 100).toFixed(1)}%`,
                    background: ctxPct > 0.85 ? "#fbbf24" : "var(--chart-1)",
                  }}
                />
              </div>
            </div>
          )}

          <div className="my-6 h-px bg-[var(--grid)]" />

          <div className="mb-3">
            <ToggleGroup
              size="sm"
              variant="outline"
              value={[String(rangeSec)]}
              onValueChange={(v) => v[0] && setRangeSec(Number(v[0]))}
            >
              <ToggleGroupItem value="900" className="px-3 text-xs">15m</ToggleGroupItem>
              <ToggleGroupItem value="3600" className="px-3 text-xs">1h</ToggleGroupItem>
              <ToggleGroupItem value="86400" className="px-3 text-xs">24h</ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="grid gap-3.5 md:grid-cols-2">
            <Card className="bento gap-3 py-4">
              <CardContent className="px-4">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Cost · $/min
                </div>
                <BurnChart
                  buckets={rangeSec === 86400 ? detail!.buckets24 : detail!.buckets}
                  metric={pickCost}
                  rangeSec={rangeSec}
                  fmtValue={fmtMoney}
                />
              </CardContent>
            </Card>
            <Card className="bento gap-3 py-4">
              <CardContent className="px-4">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Tokens · tok/min
                </div>
                <BurnChart
                  buckets={rangeSec === 86400 ? detail!.buckets24 : detail!.buckets}
                  metric={pickTokens}
                  rangeSec={rangeSec}
                  fmtValue={fmtTok}
                />
              </CardContent>
            </Card>
          </div>

          <div className="mt-3.5 grid gap-3.5 md:grid-cols-2">
            <Card className="bento gap-3 py-4">
              <CardContent className="px-4">
                <TokenMix
                  title="Token mix · this session"
                  values={info.breakdown}
                  costs={info.costParts}
                />
                <p className="mt-3 text-xs text-muted-foreground">
                  {Math.round(info.hitRate * 100)}% of prompt tokens came from cache.
                </p>
              </CardContent>
            </Card>
            <Card className="bento gap-3 py-4">
              <CardContent className="px-4">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Activity · this session
                </div>
                <ul className="mt-2 space-y-1 font-mono text-xs">
                  {detail!.activity.slice(-10).reverse().map((a, i) => (
                    <li key={`${a.t}-${i}`} className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
                      <span className="tabular-nums text-muted-foreground">
                        {new Date(a.t).toTimeString().slice(0, 8)}
                      </span>
                      <span className={cn(
                        "truncate",
                        a.kind === "done" ? "text-[var(--good)]"
                          : a.kind === "compact" || a.kind === "model" ? "text-[#fbbf24]"
                          : "text-secondary-foreground"
                      )}>
                        {a.detail || a.kind}
                      </span>
                    </li>
                  ))}
                  {detail!.activity.length === 0 && (
                    <li className="text-muted-foreground">no live events yet — they appear as the agent works</li>
                  )}
                </ul>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Fig({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-20">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 font-mono text-[22px] font-semibold">
        {value}
        {unit && <span className="ml-1 font-sans text-[11.5px] font-normal text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

function StateBadge({ state, turnMs }: { state: string; turnMs: number }) {
  if (state === "waiting")
    return <span className="text-xs font-medium text-[#fbbf24]">◉ needs you</span>;
  if (state === "working")
    return (
      <span className="text-xs text-[var(--good)]">
        ● working{turnMs > 60000 ? ` · ${fmtDur(turnMs)}` : ""}
      </span>
    );
  return <span className="text-xs text-muted-foreground">idle</span>;
}
