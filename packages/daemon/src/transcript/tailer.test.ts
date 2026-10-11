import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { appendBytes, makeTmpDir, removeDir, truncateTo, writeText } from '../testing/tmp-fs.ts';
import { FileTailer, type TailInfo } from './tailer.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = makeTmpDir();
  file = join(dir, 't.jsonl');
});
afterEach(() => removeDir(dir));

interface Seen { recs: unknown[]; offset: number; info: TailInfo }
function collect(t: FileTailer, from = 0): { seen: Seen[]; all: () => unknown[]; stop: () => void } {
  const seen: Seen[] = [];
  const stop = t.follow(file, from, (recs, offset, info) => seen.push({ recs, offset, info }));
  return { seen, all: () => seen.flatMap((s) => s.recs), stop };
}
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
// Far-apart poll interval: tests drive polling themselves with pollNow().
const manual = () => new FileTailer({ pollMs: 3_600_000 });

describe('Tailer', () => {
  it('delivers complete lines and the offset after them', async () => {
    writeText(file, line({ a: 1 }) + line({ b: 2 }));
    const t = manual();
    const c = collect(t);
    await t.pollNow();
    expect(c.all()).toEqual([{ a: 1 }, { b: 2 }]);
    expect(c.seen.at(-1)?.offset).toBe(Buffer.byteLength(line({ a: 1 }) + line({ b: 2 })));
    c.stop();
  });

  it('holds a partial line until its newline arrives and never parses it', async () => {
    writeText(file, `${line({ a: 1 })}{"b":`);
    const t = manual();
    const c = collect(t);
    await t.pollNow();
    expect(c.all()).toEqual([{ a: 1 }]);
    const afterFirst = c.seen.at(-1)?.offset;
    expect(afterFirst).toBe(Buffer.byteLength(line({ a: 1 })));
    appendBytes(file, '2}');
    await t.pollNow();
    expect(c.all()).toEqual([{ a: 1 }]); // still no newline
    appendBytes(file, '\n');
    await t.pollNow();
    expect(c.all()).toEqual([{ a: 1 }, { b: 2 }]);
    c.stop();
  });

  it('a malformed complete line is skipped, the next one still arrives', async () => {
    writeText(file, `not json\n${line({ ok: true })}`);
    const t = manual();
    const c = collect(t);
    await t.pollNow();
    expect(c.all()).toEqual([{ ok: true }]);
    c.stop();
  });

  it('decodes a multi-byte character that is split across polls at every possible byte', async () => {
    const full = Buffer.from(line({ text: 'héllo € 😀 — done' }), 'utf8');
    for (let cut = 1; cut < full.length; cut++) {
      writeText(file, '');
      const t = manual();
      const c = collect(t);
      appendBytes(file, full.subarray(0, cut));
      await t.pollNow();
      appendBytes(file, full.subarray(cut));
      await t.pollNow();
      expect(c.all(), `cut at ${cut}`).toEqual([{ text: 'héllo € 😀 — done' }]);
      expect(c.seen.at(-1)?.offset).toBe(full.length);
      c.stop();
    }
  });

  it('decodes multi-byte characters split across read chunks inside one poll', async () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ i, t: '日本語€😀'.repeat(5) }));
    writeText(file, records.map(line).join(''));
    const t = new FileTailer({ pollMs: 3_600_000, chunkBytes: 7 });
    const c = collect(t);
    await t.pollNow();
    expect(c.all()).toEqual(records);
    c.stop();
  });

  it('strips a byte-order mark at the start of the file', async () => {
    writeText(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line({ a: 1 }))]));
    const t = manual();
    const c = collect(t);
    await t.pollNow();
    expect(c.all()).toEqual([{ a: 1 }]);
    c.stop();
  });

  it('resumes from a saved offset', async () => {
    const first = line({ a: 1 });
    writeText(file, first + line({ b: 2 }));
    const t = manual();
    const c = collect(t, Buffer.byteLength(first));
    await t.pollNow();
    expect(c.all()).toEqual([{ b: 2 }]);
    expect(c.seen.every((s) => !s.info.reset)).toBe(true);
    c.stop();
  });

  it('resets to 0 when the file shrinks, and says so', async () => {
    writeText(file, line({ a: 1 }) + line({ b: 2 }) + line({ c: 3 }));
    const t = manual();
    const c = collect(t);
    await t.pollNow();
    truncateTo(file, 0);
    writeText(file, line({ n: 1 }));
    await t.pollNow();
    expect(c.all().slice(3)).toEqual([{ n: 1 }]);
    const last = c.seen.at(-1);
    expect(last?.info.reset).toBe(true);
    expect(last?.offset).toBe(Buffer.byteLength(line({ n: 1 })));
    c.stop();
  });

  it('a saved offset past the end of the file counts as shrink', async () => {
    writeText(file, line({ a: 1 }));
    const t = manual();
    const c = collect(t, 99_999);
    await t.pollNow();
    expect(c.all()).toEqual([{ a: 1 }]);
    expect(c.seen[0]?.info.reset).toBe(true);
    c.stop();
  });

  it('shrink to empty reports the reset even with no records', async () => {
    writeText(file, line({ a: 1 }));
    const t = manual();
    const c = collect(t);
    await t.pollNow();
    truncateTo(file, 0);
    await t.pollNow();
    expect(c.seen.at(-1)).toEqual({ recs: [], offset: 0, info: { reset: true } });
    c.stop();
  });

  it('waits quietly for a file that does not exist yet', async () => {
    const errors: unknown[] = [];
    const t = new FileTailer({ pollMs: 3_600_000, onError: (e) => errors.push(e) });
    const c = collect(t);
    await t.pollNow();
    expect(c.seen).toEqual([]);
    writeText(file, line({ a: 1 }));
    await t.pollNow();
    expect(c.all()).toEqual([{ a: 1 }]);
    expect(errors).toEqual([]);
    c.stop();
  });

  it('reports unexpected stat errors through onError and keeps going', async () => {
    const errors: unknown[] = [];
    const t = new FileTailer({ pollMs: 3_600_000, onError: (e) => errors.push(e) });
    // a NUL in the path makes stat fail with something other than ENOENT
    const stop = t.follow(join(dir, 'bad\u0000name'), 0, () => undefined);
    await t.pollNow();
    expect(errors).toHaveLength(1);
    stop();
  });

  it('a throwing callback is reported and does not stop the tailer', async () => {
    const errors: unknown[] = [];
    const t = new FileTailer({ pollMs: 3_600_000, onError: (e) => errors.push(e) });
    writeText(file, line({ a: 1 }));
    let calls = 0;
    const stop = t.follow(file, 0, () => {
      calls++;
      throw new Error('boom');
    });
    await t.pollNow();
    appendBytes(file, line({ b: 2 }));
    await t.pollNow();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
    stop();
  });

  it('concurrent polls never deliver a record twice', async () => {
    writeText(file, line({ a: 1 }) + line({ b: 2 }));
    const t = manual();
    const c = collect(t);
    await Promise.all([t.pollNow(), t.pollNow(), t.pollNow()]);
    expect(c.all()).toEqual([{ a: 1 }, { b: 2 }]);
    c.stop();
  });

  it('stop() ends delivery', async () => {
    writeText(file, line({ a: 1 }));
    const t = manual();
    const c = collect(t);
    await t.pollNow();
    c.stop();
    appendBytes(file, line({ b: 2 }));
    await t.pollNow();
    expect(c.all()).toEqual([{ a: 1 }]);
  });

  it('stop() during a read ends that poll early', async () => {
    writeText(file, Array.from({ length: 200 }, (_, i) => line({ i })).join(''));
    const t = new FileTailer({ pollMs: 3_600_000, chunkBytes: 16 });
    const seen: unknown[] = [];
    const stop = t.follow(file, 0, (recs) => {
      seen.push(...recs);
      stop();
    });
    await t.pollNow();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(200);
  });
});

describe('Tailer on a 12 MB transcript', () => {
  const body = 'x'.repeat(280);
  const mk = (i: number): string => line({ i, body });
  const count = 40_000; // about 11.6 MB
  let size = 0;
  beforeEach(() => {
    writeText(file, Array.from({ length: count }, (_, i) => mk(i)).join(''));
    size = Array.from({ length: count }, (_, i) => Buffer.byteLength(mk(i))).reduce((a, b) => a + b, 0);
  });

  it('reads it in chunks from zero and gets every record', async () => {
    expect(size).toBeGreaterThan(11 * 1024 * 1024);
    const t = manual();
    const c = collect(t);
    await t.pollNow();
    expect(c.all()).toHaveLength(count);
    expect(c.seen.at(-1)?.offset).toBe(size);
    expect(c.seen.length).toBeGreaterThan(5); // delivered in batches, offsets advance
    c.stop();
  });

  it('a poll with nothing new reads zero bytes; a new line reads only that line', async () => {
    const t = manual();
    const c = collect(t, size);
    await t.pollNow();
    await t.pollNow();
    expect(t.bytesRead).toBe(0);
    appendBytes(file, mk(count));
    await t.pollNow();
    expect(t.bytesRead).toBe(Buffer.byteLength(mk(count)));
    expect(c.all()).toHaveLength(1);
    c.stop();
  });

  it('delivers an appended line within 600 ms on the default 500 ms poll', async () => {
    const t = new FileTailer();
    const c = collect(t, size);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = performance.now();
    appendBytes(file, mk(count));
    await new Promise<void>((resolve, reject) => {
      const tick = (): void => {
        if (c.all().length > 0) resolve();
        else if (performance.now() - t0 > 2000) reject(new Error('no delivery'));
        else setTimeout(tick, 5);
      };
      tick();
    });
    expect(performance.now() - t0).toBeLessThanOrEqual(600);
    c.stop();
  });
});
