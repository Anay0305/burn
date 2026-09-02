// Diagonal shimmer over a cfonts wordmark — same technique as the megallm
// CLI's banner, re-tuned to an ember palette for the burn monitor: render the
// wordmark once as plain text, strip ANSI to a 2D char grid, then per frame
// recolour a diagonal stripe from base-ember toward hot white.
import cfonts from 'cfonts';

const BASE      = [234, 88, 12];    // ember orange
const HIGHLIGHT = [255, 241, 214];  // hot white

const STRIPE = 16;
const FRAME_STEP = 3;
const FRAME_MS = 120; /* slower sweep — fewer full-frame repaints */

const ANSI_RE = /\x1B\[[0-9;]*m/g;
const ansi = ([r, g, b]) => `\x1B[38;2;${r};${g};${b}m`;
const RESET = '\x1B[0m';

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export function buildWordmarkGrid(text) {
  const raw = cfonts.render(text, {
    font: 'block',
    colors: ['white'],
    align: 'left',
    space: false,
    lineHeight: 0,
    env: 'node',
  });
  return raw.array
    .join('\n')
    .replace(ANSI_RE, '')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

export function shimmerSpan(grid) {
  const cols = Math.max(...grid.map((l) => l.length));
  const rows = grid.length;
  return {
    start: -STRIPE,
    end: cols + rows * 2 + STRIPE,
    rows,
    cols,
    step: FRAME_STEP,
    intervalMs: FRAME_MS,
  };
}

export function renderShimmerFrame(grid, shimmerPos) {
  return grid.map((line, row) => {
    let out = '';
    let lastKey = null;
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === ' ' || ch === '\t') {
        if (lastKey !== null) { out += RESET; lastKey = null; }
        out += ch;
        continue;
      }
      const d = col + row * 2 - shimmerPos;
      let color = BASE;
      if (d >= 0 && d <= STRIPE) {
        const t = 1 - Math.abs((d - STRIPE / 2) / (STRIPE / 2));
        color = lerp(BASE, HIGHLIGHT, t);
      }
      const key = color[0] * 65536 + color[1] * 256 + color[2];
      if (key !== lastKey) {
        out += ansi(color);
        lastKey = key;
      }
      out += ch;
    }
    return out + RESET;
  });
}
