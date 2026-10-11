// Transcript tailer (plan section 4.1): follow a JSONL file from a byte offset.
// - Only complete lines are parsed. Bytes after the last newline are held until the rest arrives.
// - Splitting happens on the 0x0A byte, which can never occur inside a multi-byte UTF-8 sequence, so a character
//   cut by a chunk or poll boundary is decoded only once all of its bytes are here.
// - If the file becomes shorter than what we consumed (rewritten or truncated), we start again from 0.
// - A poll stats the file and reads only the new bytes, never the whole file.

import { stat } from 'node:fs/promises';
import { jsonLines, readRange } from './fsutil.ts';

export interface TailInfo {
  /** True when the file shrank (or the saved offset was past its end) and reading restarted at 0. */
  reset: boolean;
}
export type TailCallback = (records: unknown[], offset: number, info: TailInfo) => void;

export interface Tailer {
  follow(path: string, fromOffset: number, cb: TailCallback): () => void;
}

export interface TailerOptions {
  /** Poll interval while following. Default 500 ms. */
  pollMs?: number;
  /** Largest single read. Default 1 MiB. */
  chunkBytes?: number;
  onError?: (err: unknown, path: string) => void;
}

interface Follow {
  path: string;
  cb: TailCallback;
  offset: number; // byte offset of the first byte not yet delivered (start of `pending`)
  pending: Buffer; // bytes after the last newline we have seen
  stopped: boolean;
  timer?: NodeJS.Timeout;
  inflight?: Promise<void>;
}

export class FileTailer implements Tailer {
  /** Total bytes read from disk by all follows (for tests and the "never reads the whole file" check). */
  bytesRead = 0;
  readonly #pollMs: number;
  readonly #chunk: number;
  readonly #onError: (err: unknown, path: string) => void;
  readonly #follows = new Set<Follow>();

  constructor(opts: TailerOptions = {}) {
    this.#pollMs = opts.pollMs ?? 500;
    this.#chunk = opts.chunkBytes ?? 1024 * 1024;
    this.#onError = opts.onError ?? (() => undefined);
  }

  follow(path: string, fromOffset: number, cb: TailCallback): () => void {
    const f: Follow = { path, cb, offset: Math.max(0, fromOffset), pending: Buffer.alloc(0), stopped: false };
    this.#follows.add(f);
    this.#schedule(f, 0);
    return () => {
      f.stopped = true;
      if (f.timer) clearTimeout(f.timer);
      this.#follows.delete(f);
    };
  }

  /** Poll every followed file now and wait for the deliveries. Used on demand and by tests. */
  async pollNow(): Promise<void> {
    await Promise.all([...this.#follows].map((f) => this.#run(f)));
  }

  #schedule(f: Follow, delay: number): void {
    f.timer = setTimeout(() => {
      void this.#run(f).finally(() => {
        if (!f.stopped) this.#schedule(f, this.#pollMs);
      });
    }, delay);
    f.timer.unref();
  }

  #run(f: Follow): Promise<void> {
    // Never let two polls of the same follow overlap.
    const prev = f.inflight ?? Promise.resolve();
    const next = prev.then(() => this.#poll(f)).catch((err: unknown) => this.#onError(err, f.path));
    f.inflight = next;
    return next;
  }

  async #poll(f: Follow): Promise<void> {
    if (f.stopped) return;
    let size: number;
    try {
      size = (await stat(f.path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // not created yet
      throw err;
    }
    let reset = false;
    if (size < f.offset + f.pending.length) {
      f.offset = 0;
      f.pending = Buffer.alloc(0);
      reset = true;
    }
    let pos = f.offset + f.pending.length;
    while (pos < size && !f.stopped) {
      const buf = await readRange(f.path, pos, Math.min(size, pos + this.#chunk));
      if (buf.length === 0) break;
      this.bytesRead += buf.length;
      pos += buf.length;
      const data = f.pending.length > 0 ? Buffer.concat([f.pending, buf]) : buf;
      const nl = data.lastIndexOf(0x0a);
      if (nl < 0) {
        f.pending = Buffer.from(data);
        continue;
      }
      const complete = data.subarray(0, nl + 1);
      f.pending = Buffer.from(data.subarray(nl + 1));
      f.offset += complete.length;
      this.#deliver(f, jsonLines(new TextDecoder().decode(complete)), reset);
      reset = false;
    }
    if (reset) this.#deliver(f, [], true);
  }

  #deliver(f: Follow, records: unknown[], reset: boolean): void {
    try {
      f.cb(records, f.offset, { reset });
    } catch (err) {
      this.#onError(err, f.path);
    }
  }
}
