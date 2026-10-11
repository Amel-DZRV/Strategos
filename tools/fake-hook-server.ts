// A tiny local HTTP server that plays the daemon's part for fake-claude tests: it records hook requests and answers them
// as scripted (immediately, after a hold, or not at all). Also builds a --settings file shaped like plan section 5 "Injected settings".
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeText } from './tmp-fs.ts';

export interface RecordedHook {
  strategosId: string;
  event: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
  /** true once the client closed the connection before we answered */
  closedByClient: boolean;
  /** true once a response was sent */
  answered: boolean;
}

export type Reply = { status?: number; json?: unknown } | 'hold' | 'none';
export type Responder = (h: RecordedHook) => Reply | Promise<Reply>;

export interface HookServer {
  port: number;
  hooks: RecordedHook[];
  /** Pending held requests, oldest first. */
  held: { hook: RecordedHook; respond(r: { status?: number; json?: unknown }): void }[];
  setResponder(fn: Responder): void;
  waitFor(pred: (h: RecordedHook) => boolean, ms?: number): Promise<RecordedHook>;
  /** Resolves with the oldest held request once there is one (a request is recorded slightly before it is parked). */
  waitHeld(ms?: number): Promise<HookServer['held'][number]>;
  events(): string[];
  close(): Promise<void>;
}

export async function startHookServer(responder: Responder = () => ({ status: 200 })): Promise<HookServer> {
  let respondWith = responder;
  const hooks: RecordedHook[] = [];
  const held: HookServer['held'] = [];
  const waiters: { pred: (h: RecordedHook) => boolean; resolve: (h: RecordedHook) => void }[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const m = /^\/hook\/([^/]+)\/([^/?]+)/.exec(req.url ?? '');
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* keep {} */ }
      const rec: RecordedHook = { strategosId: m?.[1] ?? '', event: m?.[2] ?? '', headers: req.headers, body, closedByClient: false, answered: false };
      res.on('close', () => { if (!rec.answered) rec.closedByClient = true; });
      hooks.push(rec);
      for (const w of [...waiters]) if (w.pred(rec)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(rec); }
      const send = (r: { status?: number; json?: unknown }): void => {
        if (res.writableEnded || rec.closedByClient) return;
        rec.answered = true;
        if (r.json === undefined) { res.writeHead(r.status ?? 200).end(); return; }
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(r.json));
      };
      void Promise.resolve(respondWith(rec)).then((r) => {
        if (r === 'none') return; // never answered
        if (r === 'hold') { held.push({ hook: rec, respond: send }); return; }
        send(r);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port, hooks, held,
    setResponder(fn) { respondWith = fn; },
    waitFor(pred, ms = 45_000) {
      const found = hooks.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for hook; saw: ${hooks.map((h) => h.event).join(',')}`)), ms);
        waiters.push({ pred, resolve: (h) => { clearTimeout(t); resolve(h); } });
      });
    },
    async waitHeld(ms = 45_000) {
      const end = Date.now() + ms;
      while (held.length === 0) {
        if (Date.now() > end) throw new Error('timed out waiting for a held request');
        await new Promise((r) => setTimeout(r, 10));
      }
      return held[0]!;
    },
    events: () => hooks.map((h) => h.event),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'CwdChanged', 'PermissionRequest'];

/** Settings in the shape of plan section 5 (http hooks, token header from $STRATEGOS_HOOK_TOKEN, held events with long timeouts). */
export function buildTestSettings(o: { port: number; strategosId: string; relayPath?: string }): Record<string, unknown> {
  const relay = o.relayPath ?? fileURLToPath(new URL('./hook-relay.mjs', import.meta.url));
  const fwd = (p: string): string => p.replace(/\\/g, '/');
  const hook = (ev: string, timeout?: number): Record<string, unknown> => ({
    type: 'http', url: `http://127.0.0.1:${o.port}/hook/${o.strategosId}/${ev}`,
    headers: { 'X-Strategos-Token': '$STRATEGOS_HOOK_TOKEN' }, allowedEnvVars: ['STRATEGOS_HOOK_TOKEN'], ...(timeout ? { timeout } : {}),
  });
  const hooks: Record<string, unknown[]> = {};
  for (const ev of EVENTS) {
    // [ran, spike S1] SessionStart never arrives over type:"http": it is a command hook running the relay (env: STRATEGOS_PORT, STRATEGOS_HOOK_TOKEN)
    if (ev === 'SessionStart') hooks[ev] = [{ hooks: [{ type: 'command', command: `"${fwd(process.execPath)}" "${fwd(relay)}" ${o.strategosId} SessionStart`, timeout: 5 }] }];
    else if (ev === 'PreToolUse') hooks[ev] = [{ matcher: '*', hooks: [hook(ev, 5)] }, { matcher: 'AskUserQuestion', hooks: [hook(ev, 86400)] }];
    else if (ev === 'PermissionRequest') hooks[ev] = [{ matcher: '*', hooks: [hook(ev, 86400)] }];
    else if (ev === 'PostToolUse' || ev === 'PostToolUseFailure') hooks[ev] = [{ matcher: '*', hooks: [hook(ev)] }];
    else if (ev === 'SessionEnd') hooks[ev] = [{ hooks: [hook(ev, 3)] }];
    else hooks[ev] = [{ hooks: [hook(ev)] }];
  }
  return { hooks, disableAgentView: true };
}

export function writeTestSettings(dir: string, o: { port: number; strategosId: string; relayPath?: string }): string {
  return writeText(join(dir, `${o.strategosId}.settings.json`), JSON.stringify(buildTestSettings(o), null, 2));
}
