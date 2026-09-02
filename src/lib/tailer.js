import { promises as fsp } from 'node:fs';

// Tails a growing set of JSONL files. `listFiles()` returns candidate paths;
// files whose mtime predates `backfillStart` are skipped to their end (only
// new appends count), newer ones are read from the top so history backfills.
//
// With `persist` ({ load(path), save(path, offset, extra) }), read offsets —
// and an opaque per-file `extra` a source may attach via setExtra() — survive
// restarts, so nothing is re-parsed and cumulative counters keep their base.
export class Tailer {
  constructor({ listFiles, onLine, backfillStart, pollMs = 1500, relistMs = 10_000, persist = null }) {
    this.listFiles = listFiles;
    this.onLine = onLine;
    this.backfillStart = backfillStart;
    this.pollMs = pollMs;
    this.relistMs = relistMs;
    this.persist = persist;
    this.files = new Map(); // path -> { offset, remainder, extra }
    this.known = [];
    this.lastList = 0;
    this.stopped = false;
  }

  getExtra(file) {
    return this.files.get(file)?.extra ?? null;
  }

  setExtra(file, extra) {
    const state = this.files.get(file);
    if (state) state.extra = extra;
  }

  async start() {
    while (!this.stopped) {
      const t0 = Date.now();
      try {
        await this.poll();
      } catch (err) {
        console.error('[tailer] poll error:', err.message);
      }
      const elapsed = Date.now() - t0;
      await sleep(Math.max(100, this.pollMs - elapsed));
    }
  }

  stop() {
    this.stopped = true;
  }

  async poll() {
    const now = Date.now();
    if (now - this.lastList >= this.relistMs || this.known.length === 0) {
      this.known = await this.listFiles();
      this.lastList = now;
    }
    for (const file of this.known) {
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        this.files.delete(file);
        continue;
      }
      let state = this.files.get(file);
      if (!state) {
        const saved = this.persist?.load(file);
        state =
          saved && saved.offset <= st.size
            ? { offset: saved.offset, remainder: '', extra: saved.extra }
            : {
                offset: st.mtimeMs >= this.backfillStart ? 0 : st.size,
                remainder: '',
                extra: null,
              };
        this.files.set(file, state);
      }
      if (st.size < state.offset) {
        // truncated/rewritten — start over
        state.offset = 0;
        state.remainder = '';
        state.extra = null;
      }
      if (st.size > state.offset) {
        await this.readChunk(file, state, st.size);
        this.persist?.save(file, state.offset, state.extra);
      }
    }
  }

  async readChunk(file, state, size) {
    const fh = await fsp.open(file, 'r');
    try {
      const len = size - state.offset;
      const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
      let pos = state.offset;
      let remaining = len;
      while (remaining > 0) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, remaining), pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        remaining -= bytesRead;
        const text = state.remainder + buf.toString('utf8', 0, bytesRead);
        const lines = text.split('\n');
        state.remainder = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            this.onLine(file, JSON.parse(trimmed));
          } catch {
            // partial/corrupt line — ignore
          }
        }
      }
      state.offset = pos;
    } finally {
      await fh.close();
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
