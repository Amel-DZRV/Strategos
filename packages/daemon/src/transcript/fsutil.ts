// Read-only file helpers for transcripts and Claude's config dir (plan section 4, transcript/*).
// Written fresh (the Bot Crossing source was not available); the function names follow the plan's port list.
// Everything here only reads. Reads are ranged: nothing reads a whole transcript.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/** Read bytes [start, end) of a file. Returns fewer bytes if the file is shorter. */
export async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  const stream = createReadStream(path, { start, end: end - 1 });
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The first `bytes` bytes as text, cut back to the last full line so the last line is never partial. */
export async function readHead(path: string, bytes: number): Promise<string> {
  const { size } = await stat(path);
  const buf = await readRange(path, 0, Math.min(bytes, size));
  if (size <= bytes) return buf.toString('utf8');
  const cut = buf.lastIndexOf(0x0a);
  return cut < 0 ? '' : buf.subarray(0, cut + 1).toString('utf8');
}

/** The last `bytes` bytes as text, advanced to the first full line so the first line is never partial. */
export async function readTail(path: string, bytes: number): Promise<string> {
  const { size } = await stat(path);
  const start = Math.max(0, size - bytes);
  const buf = await readRange(path, start, size);
  if (start === 0) return buf.toString('utf8');
  const cut = buf.indexOf(0x0a);
  return cut < 0 ? '' : buf.subarray(cut + 1).toString('utf8');
}

/** Parse JSON Lines text. Blank and malformed lines are skipped; a trailing line without a newline is parsed only if complete JSON. */
export function jsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // a torn or foreign line: skip it
    }
  }
  return out;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
