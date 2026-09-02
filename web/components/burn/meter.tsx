"use client";

// The signature element: a live cost odometer. Between server frames the
// figure advances at the current burn rate, like a fuel pump.
import { useEffect, useRef, useState } from "react";
import { fmtMeter } from "@/lib/burn";

export function Meter({ cost, perMin }: { cost: number; perMin: number }) {
  const [text, setText] = useState(fmtMeter(cost));
  const base = useRef({ cost, atMs: 0, perMs: 0 });

  useEffect(() => {
    base.current = {
      cost,
      atMs: performance.now(),
      perMs: Math.max(0, perMin) / 60000,
    };
    setText(fmtMeter(cost));
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => {
      const b = base.current;
      setText(fmtMeter(b.cost + b.perMs * (performance.now() - b.atMs)));
    }, 120);
    return () => clearInterval(t);
  }, [cost, perMin]);

  return (
    <div className="font-mono text-[56px] leading-[1.05] font-semibold tracking-tight tabular-nums max-md:text-[40px]">
      {text}
    </div>
  );
}
