// Request guards (plan section 10). Pure helpers; http.ts wires them in the right order.
// Rewritten stricter than Bot Crossing's isLocalRequest: hostname-only matching is not enough.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MiB = 1024 * 1024;
export const KiB = 1024;
export const CAPS = {
  hook: 8 * MiB, // large Write inputs
  statusLine: 256 * KiB,
  uiCommand: 64 * KiB,
  wsFrame: 1 * MiB,
} as const;

export const LIMITS = {
  pairingPerMinute: 5,
  hookPerSecondPerSession: 200,
} as const;

/** Host header: exactly 127.0.0.1:<port> or localhost:<port>. Anything else is a DNS-rebinding attempt (421). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Origin for UI routes: exactly http://127.0.0.1:<port>, plus the one explicit dev origin. */
export function uiOriginAllowed(origin: string | undefined, port: number, devOrigin?: string): boolean {
  if (origin === undefined) return false;
  if (origin === `http://127.0.0.1:${port}`) return true;
  return devOrigin !== undefined && devOrigin !== '' && origin === devOrigin;
}

/** Constant-time string compare (hashes first, so the lengths do not leak either). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Hooks never send an Origin; browsers always do. Presence of the header, even empty, is a refusal. */
export function hasOriginHeader(req: IncomingMessage): boolean {
  return Object.hasOwn(req.headers, 'origin');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k !== '' && !Object.hasOwn(out, k)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rate limiting: fixed windows, one counter per key.
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** true = allowed, false = over the limit. */
  hit(key: string): boolean;
}

export function createRateLimiter(o: { max: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = o.now ?? Date.now;
  const buckets = new Map<string, { start: number; count: number }>();
  let lastSweep = now();
  return {
    hit(key) {
      const t = now();
      if (t - lastSweep > o.windowMs * 4) {
        for (const [k, b] of buckets) if (t - b.start >= o.windowMs) buckets.delete(k);
        lastSweep = t;
      }
      const b = buckets.get(key);
      if (b === undefined || t - b.start >= o.windowMs) {
        buckets.set(key, { start: t, count: 1 });
        return true;
      }
      b.count += 1;
      return b.count <= o.max;
    },
  };
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** Reads the whole body up to `cap` bytes. Resolves null as soon as the cap is exceeded. */
export function readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > cap) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (v: Buffer | null) => {
      if (done) return;
      done = true;
      req.off('data', onData);
      resolve(v);
    };
    const onData = (c: Buffer) => {
      total += c.length;
      if (total > cap) finish(null);
      else chunks.push(c);
    };
    req.on('data', onData);
    req.once('end', () => finish(Buffer.concat(chunks)));
    req.once('error', (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
    req.once('close', () => finish(Buffer.concat(chunks)));
  });
}

/** Empty-bodied reply. */
export function reply(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Length': '0', ...headers });
  res.end();
}

export function replyJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(data.length), 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

/**
 * 413 and close. The client may still be sending, so the response goes out first, the rest of the upload is thrown
 * away (bounded in size and time), then the socket is destroyed.
 */
export function replyTooLarge(req: IncomingMessage, res: ServerResponse): void {
  if (!res.headersSent) res.writeHead(413, { 'Content-Length': '0', Connection: 'close' });
  res.end();
  const socket = req.socket;
  let discarded = 0;
  req.on('data', (c: Buffer) => {
    discarded += c.length;
    if (discarded > 32 * MiB) socket.destroy();
  });
  req.on('error', () => socket.destroy());
  const t = setTimeout(() => socket.destroy(), 1500);
  t.unref();
  socket.once('close', () => clearTimeout(t));
  req.resume();
}
