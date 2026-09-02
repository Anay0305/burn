"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmtMoney, fmtTok, type CostParts } from "@/lib/burn";
import { cn } from "@/lib/utils";

// Composition of token volume by kind — stacked bars with 2px surface gaps,
// identity carried by the legend (never color alone). Hovering a segment or a
// legend row highlights that kind across both bars and shows the numbers; the
// legend rows double as large hit targets for slivers too thin to hover.
const KINDS: Array<{ key: keyof CostParts; label: string; cssVar: string }> = [
  { key: "cacheRead", label: "Cache read", cssVar: "--chart-1" },
  { key: "cacheWrite", label: "Cache write", cssVar: "--chart-2" },
  { key: "input", label: "Input", cssVar: "--chart-3" },
  { key: "output", label: "Output", cssVar: "--chart-4" },
];

export function TokenMix({
  title,
  values,
  costs,
}: {
  title: string;
  values: CostParts; // token counts by kind
  costs?: CostParts; // dollars by kind
}) {
  const [hover, setHover] = useState<keyof CostParts | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const tipEl = useRef<HTMLDivElement | null>(null);

  // Keep the tooltip inside the viewport: flip to the other side of the
  // cursor near the right/bottom edges. The card lives bottom-right, so the
  // flip is the common case, not the exception.
  const tipStyle = (x: number, y: number): React.CSSProperties => {
    const w = tipEl.current?.offsetWidth ?? 180;
    const h = tipEl.current?.offsetHeight ?? 84;
    const pad = 14;
    let left = x + pad;
    if (typeof window !== "undefined" && left + w > window.innerWidth - 8) left = x - w - pad;
    let top = y + pad;
    if (typeof window !== "undefined" && top + h > window.innerHeight - 8) top = y - h - pad;
    return { left: Math.max(8, left), top: Math.max(8, top) };
  };

  const total = KINDS.reduce((sum, k) => sum + (values[k.key] || 0), 0);
  const costTotal = costs ? KINDS.reduce((sum, k) => sum + (costs[k.key] || 0), 0) : 0;
  const outTokPct = total ? ((values.output || 0) / total) * 100 : 0;
  const outCostPct = costTotal ? ((costs!.output || 0) / costTotal) * 100 : 0;

  const enter = (key: keyof CostParts) => (e: React.PointerEvent) => {
    setHover(key);
    setTip({ x: e.clientX, y: e.clientY });
  };
  const move = (e: React.PointerEvent) => tip && setTip({ x: e.clientX, y: e.clientY });
  const leave = () => {
    setHover(null);
    setTip(null);
  };

  const bar = (source: CostParts, sum: number) => (
    <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full">
      {KINDS.map((k) => {
        const v = source[k.key] || 0;
        if (v <= 0) return null;
        return (
          <div
            key={k.key}
            onPointerEnter={enter(k.key)}
            onPointerMove={move}
            onPointerLeave={leave}
            style={{ width: `${(v / sum) * 100}%`, background: `var(${k.cssVar})` }}
            className={cn(
              "min-w-[3px] rounded-[1px] transition-opacity duration-150",
              hover && hover !== k.key && "opacity-30"
            )}
          />
        );
      })}
    </div>
  );

  const hovered = hover ? KINDS.find((k) => k.key === hover) : null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </div>
        {costs && (
          <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
            tokens · cost
          </div>
        )}
      </div>
      {total > 0 ? (
        <>
          <div className="mt-3">{bar(values, total)}</div>
          {costs && costTotal > 0 && <div className="mt-1.5">{bar(costs, costTotal)}</div>}
          <div className="mt-3 space-y-0.5">
            {KINDS.map((k) => {
              const v = values[k.key] || 0;
              return (
                <div
                  key={k.key}
                  onPointerEnter={() => setHover(k.key)}
                  onPointerLeave={() => setHover(null)}
                  className={cn(
                    "-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors duration-150",
                    hover === k.key && "bg-foreground/[0.05]",
                    hover && hover !== k.key && "opacity-50"
                  )}
                >
                  <i
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ background: `var(${k.cssVar})` }}
                  />
                  <span className="text-secondary-foreground">{k.label}</span>
                  <span className="ml-auto font-mono tabular-nums text-foreground">{fmtTok(v)}</span>
                  <span className="w-11 text-right font-mono tabular-nums text-muted-foreground">
                    {total ? ((v / total) * 100).toFixed(1) : "0"}%
                  </span>
                  {costs && (
                    <span className="w-14 text-right font-mono tabular-nums text-secondary-foreground">
                      {fmtMoney(costs[k.key] || 0)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {costs && costTotal > 0 && outTokPct < 5 && outCostPct > 10 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Output is {outTokPct.toFixed(1)}% of tokens but{" "}
              <span className="text-secondary-foreground">{Math.round(outCostPct)}% of cost</span> —
              generation is the expensive part; cache keeps the rest cheap.
            </p>
          )}
          {hovered && tip && typeof document !== "undefined" && createPortal(
            <div
              ref={tipEl}
              className="pointer-events-none fixed z-20 min-w-36 rounded-md border border-border bg-card px-2.5 py-2 text-xs shadow-[0_2px_8px_rgba(0,0,0,0.35)]"
              style={tipStyle(tip.x, tip.y)}
            >
              <div className="flex items-center gap-1.5">
                <i className="h-0.5 w-3 rounded-full" style={{ background: `var(${hovered.cssVar})` }} />
                <span className="text-secondary-foreground">{hovered.label}</span>
              </div>
              <div className="mt-1 font-mono tabular-nums">
                <span className="font-semibold text-foreground">{fmtTok(values[hovered.key] || 0)}</span>
                <span className="text-muted-foreground">
                  {" "}tok · {total ? (((values[hovered.key] || 0) / total) * 100).toFixed(1) : 0}%
                </span>
              </div>
              {costs && costTotal > 0 && (
                <div className="font-mono tabular-nums">
                  <span className="font-semibold text-foreground">{fmtMoney(costs[hovered.key] || 0)}</span>
                  <span className="text-muted-foreground">
                    {" "}· {(((costs[hovered.key] || 0) / costTotal) * 100).toFixed(1)}% of cost
                  </span>
                </div>
              )}
            </div>,
            document.body
          )}
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No tokens yet.</p>
      )}
    </div>
  );
}
