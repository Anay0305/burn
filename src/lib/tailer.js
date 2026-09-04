import { promises as fsp } from 'node:fs';

// Tails a growing set of JSONL files. `listFiles()` returns candidate paths;
// files whose mtime predates `backfillStart` are skipped to their end (only
// new appends count), newer ones are read from the top so history backfills.
//
// With `persist` ({ load(path), save(path, offset, extra) }), read offsets —
// and an opaque per-file `extra` a source may attach via setExtra() — survive
// restarts, so nothing is re-parsed and cumulative counters keep their base.
export class Tailer {
  constructor({ listFiles, onLine, backfillStart, pollMs = 1500, relistMs = 10_000, persist = null, onRollback = () => {} }) {
    this.listFiles = listFiles;
    this.onLine = onLine;
    this.backfillStart = backfillStart;
    this.pollMs = pollMs;
    this.relistMs = relistMs;
    this.persist = persist;
    this.onRollback = onRollback;
    this.files = new Map(); // path -> { offset, remainder, extra }
    this.known = [];
    this.lastList = 0;
    this.stopped = false;
    // Resolves once the first full pass over every file has finished — i.e.
    // the backfill is in. Lets one-shot tools run a single pass and stop.
    this.firstPoll = new Promise((resolve) => {
      this._resolveFirstPoll = resolve;
    });
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
      if (this._resolveFirstPoll) {
        this._resolveFirstPoll();
        this._resolveFirstPoll = null;
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
            ? { offset: saved.offset, remainder: Buffer.alloc(0), extra: saved.extra }
            : {
                offset: st.mtimeMs >= this.backfillStart ? 0 : st.size,
                remainder: Buffer.alloc(0),
                extra: null,
              };
        this.files.set(file, state);
      }
      if (st.size < state.offset) {
        // truncated/rewritten — start over
        state.offset = 0;
        state.remainder = Buffer.alloc(0);
        state.extra = null;
      }
      if (st.size > state.offset) {
        const before = structuredClone(state);
        const read = async () => {
          await this.readChunk(file, state, st.size);
          this.persist?.save(file, state.offset - state.remainder.length, state.extra);
        };
        try {
          await (this.persist?.batch ? this.persist.batch(read) : read());
        } catch (err) {
          this.files.set(file, before);
          this.onRollback(file);
          throw err;
        }
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
        const data = Buffer.concat([state.remainder, buf.subarray(0, bytesRead)]);
        let start = 0;
        let end;
        while ((end = data.indexOf(10, start)) !== -1) {
          const line = data.toString('utf8', start, end).trim();
          start = end + 1;
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          await this.onLine(file, obj);
        }
        state.remainder = Buffer.from(data.subarray(start));
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
