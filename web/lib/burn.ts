// Shared types + formatting for the burn dashboard.

export type Rates = {
  outPerSec10: number;
  tokensPerMin60: number;
  costPerMin60: number;
  tokensPerMin5m: number;
  costPerMin5m: number;
};

export type SessionState = "working" | "waiting" | "idle";

export type SessionRow = {
  agent: string;
  session: string;
  cwd: string;
  model: string;
  lastT: number;
  tokens: number;
  cost: number;
  unpriced: boolean;
  active: boolean;
  outPerSec: number;
  costPerMin: number;
  state?: SessionState;
  ctx?: number;
  turnMs?: number;
};

export type Buckets = {
  start: number;
  stepMs: number;
  n: number;
  agents: Record<string, { tokens: number[]; out: number[]; cost: number[] }>;
};

export type Peak = { v: number; t: number };

export type Snapshot = {
  now: number;
  rates: Rates;
  today: {
    tokens: number;
    out: number;
    cost: number;
    unpriced: number;
    tin?: number;
    cacheRead?: number;
    cacheW?: number;
    costParts?: CostParts;
  };
  peaks?: { tokensPerMin: Peak; costPerMin: Peak; outPerSec: Peak };
  cache?: { hitRate: number; savings: number; multiplier: number };
  forecast?: { today: number };
  activity?: ActivityEntry[];
  activeSessions: number;
  waiting?: number;
  sessions: SessionRow[];
  buckets: Buckets;
  buckets24?: Buckets;
};

export type CostParts = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type SessionDetail = {
  now: number;
  info: {
    agent: string;
    session: string;
    cwd: string;
    model: string;
    models: string[];
    state: SessionState;
    ctx: number;
    turnMs: number;
    firstT: number;
    lastT: number;
    outPerSec: number;
    costPerMin: number;
    tokens: number;
    cost: number;
    unpriced: boolean;
    breakdown: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costParts?: CostParts;
    savings: number;
    hitRate: number;
  };
  buckets: Buckets;
  buckets24: Buckets;
  activity: ActivityEntry[];
};

export function contextWindow(model: string): number {
  if (!model) return 0;
  if (model.includes("haiku")) return 200_000;
  if (model.includes("claude")) return 1_000_000;
  if (model.includes("gpt")) return 258_400;
  return 0;
}

export type ActivityEntry = {
  t: number;
  agent: string;
  session: string;
  cwd: string;
  kind: "prompt" | "tool" | "done" | "compact" | "model" | "turn";
  detail: string;
  tok?: number;
  cost?: number;
};

export const AGENT_META: Record<string, { label: string; cssVar: string }> = {
  "claude-code": { label: "Claude Code", cssVar: "--chart-1" },
  codex: { label: "Codex", cssVar: "--chart-2" },
  opencode: { label: "OpenCode", cssVar: "--chart-3" },
};

export const agentLabel = (a: string) => AGENT_META[a]?.label ?? a;
export const agentColor = (a: string) => `var(${AGENT_META[a]?.cssVar ?? "--chart-4"})`;

// 10s buckets -> rolling 60s sums (per-minute rate at each step)
export function rollingSeries(bucketArr: number[]): number[] {
  const out = new Array(bucketArr.length).fill(0);
  let sum = 0;
  for (let i = 0; i < bucketArr.length; i++) {
    sum += bucketArr[i];
    if (i >= 6) sum -= bucketArr[i - 6];
    out[i] = sum;
  }
  return out;
}

export function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "K";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  return String(Math.round(n));
}

export function fmtMoney(x: number): string {
  if (x >= 100) return "$" + Math.round(x).toLocaleString("en-US");
  if (x >= 10) return "$" + x.toFixed(1);
  if (x >= 1) return "$" + x.toFixed(2);
  if (x >= 0.01) return "$" + x.toFixed(3);
  if (x > 0) return "$" + x.toFixed(4);
  return "$0";
}

export function fmtMeter(x: number): string {
  return (
    "$" +
    x.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })
  );
}

export function fmtAgo(t: number, now: number): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 10) return "now";
  if (s < 60) return Math.round(s) + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  return (s / 3600).toFixed(1) + "h";
}

export function fmtClock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}
