"use client";

import { useMemo, type ComponentProps } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  agentColor, agentLabel, fmtClock, rollingSeries, type Buckets,
} from "@/lib/burn";

// Round up to a clean axis maximum (1/1.5/2/2.5/3/4/5/6/8 × 10^k).
function niceCeil(x: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  return (steps.find((s) => s * mag >= x) ?? 10) * mag;
}

type Props = {
  buckets: Buckets;
  metric: (a: { tokens: number[]; out: number[]; cost: number[] }) => number[];
  rangeSec: number;
  fmtValue: (v: number) => string;
};

export function BurnChart({ buckets, metric, rangeSec, fmtValue }: Props) {
  const { rows, agents, max } = useMemo(() => {
    const agents = Object.keys(buckets.agents).sort();
    const nWant = Math.floor((rangeSec * 1000) / buckets.stepMs);
    const from = buckets.n - Math.min(nWant, buckets.n);
    // 5-min buckets (24h view) are already per-window sums — scale to per-min;
    // 10s buckets get the rolling-60s treatment.
    const wide = buckets.stepMs >= 60_000;
    const perMin = buckets.stepMs / 60_000;
    const perAgent = new Map(
      agents.map((a) => [
        a,
        wide
          ? metric(buckets.agents[a]).slice(from).map((v) => v / perMin)
          : rollingSeries(metric(buckets.agents[a])).slice(from),
      ])
    );
    const n = buckets.n - from;
    const rows: Record<string, number>[] = [];
    let max = 0;
    for (let i = 0; i < n; i++) {
      const row: Record<string, number> = { t: buckets.start + (from + i) * buckets.stepMs };
      for (const a of agents) {
        const v = perAgent.get(a)![i] ?? 0;
        row[a] = v;
        if (v > max) max = v;
      }
      rows.push(row);
    }
    return { rows, agents, max };
  }, [buckets, metric, rangeSec]);

  const config: ChartConfig = Object.fromEntries(
    agents.map((a) => [a, { label: agentLabel(a), color: agentColor(a) }])
  );

  const ticks = useMemo(() => {
    if (rows.length < 2) return [];
    const idx = [0, 1, 2, 3].map((k) => Math.round((k / 3) * (rows.length - 1)));
    return [...new Set(idx)].map((i) => rows[i].t as number);
  }, [rows]);

  return (
    <div className="relative">
      <ChartContainer config={config} className="h-[216px] w-full">
        <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            ticks={ticks}
            axisLine={false}
            tickLine={false}
            tick={
              (({ x, y, payload, index }: { x: number; y: number; payload: { value: number }; index: number }) => (
                <text
                  x={x}
                  y={y + 12}
                  fill="var(--muted-foreground)"
                  fontSize={10.5}
                  fontFamily="var(--font-geist-mono)"
                  textAnchor={index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"}
                >
                  {fmtClock(payload.value)}
                </text>
              )) as unknown as ComponentProps<typeof XAxis>["tick"]
            }
          />
          <YAxis
            width={52}
            tickFormatter={(v: number) => fmtValue(v)}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10.5, fill: "var(--muted-foreground)", fontFamily: "var(--font-geist-mono)" }}
            domain={[0, (dataMax: number) => niceCeil(dataMax * 1.05 || 1)]}
            tickCount={4}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) =>
                  payload?.[0] ? fmtClock(payload[0].payload.t as number) : ""
                }
                formatter={(value, name, item) => (
                  <div className="flex w-full items-center gap-2">
                    <span
                      className="h-0.5 w-3 shrink-0 rounded-full"
                      style={{ background: (item as { color?: string }).color }}
                    />
                    <span className="font-mono font-semibold text-foreground">
                      {fmtValue(Number(value))}
                    </span>
                    <span className="text-muted-foreground">{agentLabel(String(name))}</span>
                  </div>
                )}
              />
            }
          />
          {agents.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          {agents.map((a) => (
            <Line
              key={a}
              dataKey={a}
              type="linear"
              stroke={`var(--color-${a})`}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              dot={false}
              activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
      {max === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          No activity in this window yet
        </div>
      )}
    </div>
  );
}
