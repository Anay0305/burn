// Reusable Ink building blocks for the burn-monitor TUI, in the megallm CLI
// house style (htm + Ink, cfonts hero numbers, unicode-animations spinners).
import chalk from 'chalk';
import gradient from 'gradient-string';
import spinners from 'unicode-animations';
import { html, Box, Text, useState, useEffect, useMemo } from './h.js';
import { renderShimmerFrame, shimmerSpan } from './shimmer.js';

// Ember gradient — amber → red, the burn-monitor's brand rule.
export const EMBER_GRADIENT = gradient(['#fbbf24', '#ef4444']);

export const AGENT_COLORS = {
  'claude-code': '#3987e5',
  codex: '#d95926',
  opencode: '#199e70',
};
export const AGENT_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};
export const agentColor = (a) => AGENT_COLORS[a] || '#c98500';
export const agentLabel = (a) => AGENT_LABELS[a] || a;

// Hand-drawn solid-block wordmark — no outline glyphs, so it renders clean
// in every terminal font (cfonts 'block' mixes ╗-borders into the fill).
const WORDMARK_LETTERS = {
  B: ['█████ ', '██  ██', '█████ ', '██  ██', '█████ '],
  U: ['██  ██', '██  ██', '██  ██', '██  ██', ' ████ '],
  R: ['█████ ', '██  ██', '█████ ', '██ ██ ', '██  ██'],
  N: ['██  ██', '███ ██', '██ ███', '██  ██', '██  ██'],
};
const WORDMARK_GRID = [0, 1, 2, 3, 4].map((row) =>
  ['B', 'U', 'R', 'N'].map((ch) => WORDMARK_LETTERS[ch][row]).join('  ')
);
export const WORDMARK_W = Math.max(...WORDMARK_GRID.map((l) => l.length));

/** Animated ember wordmark with a diagonal hot-white shimmer. */
export function ShimmerWordmark() {
  const span = useMemo(() => shimmerSpan(WORDMARK_GRID), []);
  const [pos, setPos] = useState(span.start);
  useEffect(() => {
    const t = setInterval(() => {
      setPos((p) => (p + span.step > span.end ? span.start : p + span.step));
    }, span.intervalMs);
    return () => clearInterval(t);
  }, [span]);
  const lines = renderShimmerFrame(WORDMARK_GRID, pos);
  return html`
    <${Box} flexDirection="column">
      ${lines.map((line, i) => html`<${Text} key=${i}>${line}</>`)}
    </>
  `;
}

/** Animated braille indicator (shared frame clock passed in as `tick`). */
export function BrailleSpinner({ name = 'braille', color = '#f97316', tick = 0 }) {
  const sp = spinners[name] || spinners.braille;
  return html`<${Text} color=${color}>${sp.frames[tick % sp.frames.length]}</>`;
}

/** Round-bordered panel with a coloured title, megallm-style. */
export function Panel({ title, color = '#f97316', children, ...rest }) {
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor=${color} paddingX=${1} ...${rest}>
      ${title ? html`<${Text} bold color=${color}>${title}</>` : null}
      ${children}
    </>
  `;
}

/**
 * Hero figure: cfonts `tiny` render of a value, coloured with the ember
 * gradient. Re-rendered per tick — tiny font is 2 rows, cost is negligible.
 */
// 3-row seven-segment digit face for the money figure — solid single colour,
// small $ prefix and /min suffix in plain text so the number stays the star.
const SEG = {
  0: ['█▀█', '█ █', '█▄█'],
  1: [' █ ', ' █ ', ' █ '],
  2: ['▀▀█', '█▀▀', '█▄▄'],
  3: ['▀▀█', '▀▀█', '▄▄█'],
  4: ['█ █', '▀▀█', '  █'],
  5: ['█▀▀', '▀▀█', '▄▄█'],
  6: ['█▀▀', '█▀█', '█▄█'],
  7: ['▀▀█', '  █', '  █'],
  8: ['█▀█', '█▀█', '█▄█'],
  9: ['█▀█', '▀▀█', '▄▄█'],
  '.': [' ', ' ', '▄'],
  ',': [' ', ' ', '▖'],
};

export function fmtHero(x) {
  if (x >= 100) return Math.round(x).toLocaleString('en-US');
  if (x >= 10) return x.toFixed(1);
  return x.toFixed(2);
}

export function Hero({ value, suffix = '/min', color = '#f97316' }) {
  const txt = fmtHero(value);
  const rows = ['', '', ''];
  for (const ch of txt) {
    const g = SEG[ch];
    for (let r = 0; r < 3; r++) rows[r] += (g ? g[r] : ' ') + ' ';
  }
  return html`
    <${Box} alignItems="flex-end">
      <${Box} flexDirection="column" marginRight=${1}>
        <${Text} color="gray"> </>
        <${Text} color="gray"> </>
        <${Text} color=${color} bold>$</>
      </>
      <${Box} flexDirection="column">
        ${rows.map((l, i) => html`
          <${Box} key=${i} height=${1} overflow="hidden"><${Text} color=${color} bold wrap="truncate">${l}</></>
        `)}
      </>
      ${suffix ? html`<${Text} color="gray"> ${suffix}</>` : null}
    </>
  `;
}

// ---------- charts ----------
const BLOCKS = ' ▁▂▃▄▅▆▇█';

// Braille dot bits by (dy%4, dx%2)
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/**
 * Multi-series braille line chart. Returns `height` pre-coloured strings,
 * each `width` cells wide (2×4 dots per cell). Series share one y-scale.
 */
export function brailleChart(seriesArr, width, height) {
  const W = width * 2;
  const H = height * 4;
  const max = Math.max(1e-9, ...seriesArr.flatMap((s) => s.values));
  const bits = Array.from({ length: height }, () => new Array(width).fill(0));
  const colors = Array.from({ length: height }, () => new Array(width).fill(null));
  const put = (dx, dy, color) => {
    if (dx < 0 || dx >= W || dy < 0 || dy >= H) return;
    const cx = dx >> 1;
    const cy = dy >> 2;
    bits[cy][cx] |= BRAILLE_BITS[dy & 3][dx & 1];
    colors[cy][cx] = color;
  };
  for (const s of seriesArr) {
    const n = s.values.length;
    if (!n) continue;
    let prevY = null;
    for (let dx = 0; dx < W; dx++) {
      const idx = n === 1 ? 0 : Math.round((dx / (W - 1)) * (n - 1));
      const y = Math.round((1 - s.values[idx] / max) * (H - 1));
      if (prevY === null) {
        put(dx, y, s.color);
      } else {
        const lo = Math.min(prevY, y);
        const hi = Math.max(prevY, y);
        for (let yy = lo; yy <= hi; yy++) put(dx, yy, s.color);
      }
      prevY = y;
    }
  }
  return bits.map((row, cy) => {
    let out = '';
    for (let cx = 0; cx < width; cx++) {
      if (!row[cx]) {
        out += ' ';
        continue;
      }
      out += chalk.hex(colors[cy][cx])(String.fromCharCode(0x2800 + row[cx]));
    }
    return out;
  });
}

/**
 * Thermal bar chart: one block char per column, colour by intensity —
 * calm blue → amber → red as the column approaches the window max.
 */
export function thermalBars(values, width) {
  const cols = downsample(values, width);
  const max = Math.max(...cols, 1e-9);
  let out = '';
  for (const v of cols) {
    const r = v / max;
    const ch = BLOCKS[Math.min(8, Math.max(v > 0 ? 1 : 0, Math.round(r * 8)))];
    const color = r >= 0.8 ? '#ef4444' : r >= 0.5 ? '#fbbf24' : '#3987e5';
    out += chalk.hex(color)(ch);
  }
  return out;
}

/** Single-colour sparkline for per-agent rows. */
export function spark(values, width, color) {
  const cols = downsample(values, width);
  const max = Math.max(...cols, 1e-9);
  let out = '';
  for (const v of cols) {
    out += BLOCKS[Math.min(8, Math.max(v > 0 ? 1 : 0, Math.round((v / max) * 8)))];
  }
  return chalk.hex(color)(out);
}

function downsample(values, width) {
  if (values.length <= width) return values;
  const out = new Array(width).fill(0);
  for (let i = 0; i < width; i++) {
    const a = Math.floor((i / width) * values.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) / width) * values.length));
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, values[j]);
    out[i] = m;
  }
  return out;
}

// ---------- formatting ----------
export function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K';
  return String(Math.round(n));
}
export function fmtMoney(x) {
  if (x >= 100) return '$' + Math.round(x).toLocaleString('en-US');
  if (x >= 10) return '$' + x.toFixed(1);
  if (x >= 1) return '$' + x.toFixed(2);
  if (x >= 0.01) return '$' + x.toFixed(3);
  if (x > 0) return '$' + x.toFixed(4);
  return '$0';
}
export function fmtAgo(t, now) {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 10) return 'now';
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(1) + 'h';
}
