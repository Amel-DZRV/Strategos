// Helpers for the server tests (not imported by production code).
import { request, type IncomingHttpHeaders } from 'node:http';
import WebSocket from 'ws';
import type { DaemonEvent } from '@strategos/shared';
import { createStrategosServer, type StrategosServer, type StrategosServerOptions } from './http.ts';
import { COOKIE_NAME } from './pairing.ts';

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  closed: Promise<void>;
}

export function http(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', agent: false,
      headers: { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let resolveClosed!: () => void;
      const closed = new Promise<void>((r) => { resolveClosed = r; });
      res.socket.once('close', resolveClosed);
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), closed }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

export async function startServer(over: Partial<StrategosServerOptions> = {}): Promise<StrategosServer> {
  const srv = createStrategosServer({ port: 0, tokenFor: (sid) => (sid === 'sid-1' ? 'tok-1' : sid === 'sid-2' ? 'tok-2' : undefined), ...over });
  await srv.listen();
  return srv;
}

export const originOf = (srv: StrategosServer): string => `http://127.0.0.1:${srv.port}`;

/** Pair like the UI does and return the Cookie header value. */
export async function pairCookie(srv: StrategosServer): Promise<string> {
  const code = srv.pairing.issueCode();
  const r = await http(srv.port, {
    method: 'POST', path: '/api/pair',
    headers: { Origin: originOf(srv), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (r.status !== 204) throw new Error(`pairing failed: ${r.status}`);
  const set = r.headers['set-cookie']?.[0] ?? '';
  const m = new RegExp(`${COOKIE_NAME}=[^;]+`).exec(set);
  if (!m) throw new Error('no cookie');
  return m[0];
}

export class Client {
  readonly ws: WebSocket;
  readonly inbox: DaemonEvent[] = [];
  private waiters: { pred: (e: DaemonEvent) => boolean; resolve: (e: DaemonEvent) => void }[] = [];
  closeCode: number | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (d) => {
      const ev = JSON.parse(d.toString()) as DaemonEvent;
      this.inbox.push(ev);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(ev)) return true;
        w.resolve(ev);
        return false;
      });
    });
    ws.on('close', (code) => { this.closeCode = code; });
  }

  static async connect(srv: StrategosServer, cookie: string, headers: Record<string, string> = {}): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Origin: originOf(srv), Cookie: cookie, ...headers } });
    const c = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    return c;
  }

  /** Resolves with the first event (already received or future) that matches. */
  next(pred: (e: DaemonEvent) => boolean, timeoutMs = 3000): Promise<DaemonEvent> {
    const have = this.inbox.find(pred);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for event')), timeoutMs);
      this.waiters.push({ pred, resolve: (e) => { clearTimeout(t); resolve(e); } });
    });
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  closed(): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
  }

  close(): void {
    this.ws.close();
  }
}
