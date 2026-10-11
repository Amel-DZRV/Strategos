// The daemon's HTTP server (plan section 10). Binds 127.0.0.1 only.
//
// Routes and the guards each one gets, in order:
//   /hook/<sid>/<Event>, /statusline/<sid> : Host (421) -> no Origin header (403) -> X-Strategos-Token (404/401)
//                                            -> rate limit (429) -> body cap (413) -> pluggable handler
//   POST /api/pair                         : Host -> Origin exact -> rate limit 5/min -> body cap -> cookie issued
//   POST /control/<name>                   : Host -> NO Origin header (403) -> X-Strategos-Control equal to the secret in
//                                            <home>/cli.secret (401) -> rate limit 20/s (429) -> 4 KiB body cap. For the
//                                            local CLI only (pair, status, shutdown). A browser always sends Origin on a
//                                            POST and cannot read the secret file, so a web page can never reach it.
//   /api/*  and  /ws (upgrade)             : Host -> Origin exact -> pairing cookie -> (cap) -> handler
//   everything else (the built UI)         : Host only. Static files hold no data, and the page must load before it
//                                            can pair. All data goes through /api and /ws, which need the cookie.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { LOOPBACK_HOST } from '../config.ts';
import {
  CAPS, KiB, LIMITS, createRateLimiter, hasOriginHeader, headerValue, hostAllowed, readBody, reply, replyJson, replyTooLarge,
  safeEqual, uiOriginAllowed, type RateLimiter,
} from './guards.ts';
import { createPairing, type Pairing } from './pairing.ts';
import { createStaticHandler, type StaticHandler } from './static.ts';
import { createWsHub, type WsHub } from './ws-hub.ts';

/** Another lane implements these. The handler may keep `res` open (held permission requests) and must end it. */
export type HookHandler = (sid: string, event: string, body: unknown, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export type StatusLineHandler = (sid: string, body: unknown, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export type ApiHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>;

export interface StrategosServerOptions {
  /** 0 picks a free port (tests). The Host check always uses the port actually bound. */
  port: number;
  /** Only 127.0.0.1 is accepted. */
  host?: string;
  /** Directory of the built UI. Without it, the UI routes answer 404. */
  staticDir?: string;
  /** Extra allowed Origin (Vite in development). Default: env STRATEGOS_DEV_ORIGIN. */
  devOrigin?: string;
  /** The session's hook token, or undefined for an unknown session. */
  tokenFor: (strategosId: string) => string | undefined;
  hub?: WsHub;
  pairing?: Pairing;
  /** Secret for /control/* (the daemon also writes it to a user-only file for the CLI). Without it those routes answer 404. */
  controlSecret?: string;
  now?: () => number;
}

export interface StrategosServer {
  listen(): Promise<number>;
  close(): Promise<void>;
  readonly port: number;
  readonly http: Server;
  readonly hub: WsHub;
  readonly pairing: Pairing;
  setHookHandler(h: HookHandler | null): void;
  setStatusLineHandler(h: StatusLineHandler | null): void;
  /** Mount an API route behind the guards (Origin + cookie, 64 KiB body cap). */
  registerApi(method: string, pathname: string, handler: ApiHandler): void;
  /** Mount a /control/<name> route (CLI only, see the route table above). */
  registerControl(name: string, handler: ApiHandler): void;
  /** A new one-time pairing URL: http://127.0.0.1:<port>/#pair=<code>. */
  pairUrl(): string;
}

const HOOK_RE = /^\/hook\/([A-Za-z0-9_-]{1,128})\/([A-Za-z][A-Za-z0-9]{0,63})$/;
const STATUS_RE = /^\/statusline\/([A-Za-z0-9_-]{1,128})$/;

function splitUrl(raw: string | undefined): { pathname: string } | null {
  if (raw === undefined || !raw.startsWith('/') || raw.startsWith('//')) return null;
  const end = raw.search(/[?#]/);
  return { pathname: end < 0 ? raw : raw.slice(0, end) };
}

export function createStrategosServer(opts: StrategosServerOptions): StrategosServer {
  const host = opts.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new Error(`Strategos only listens on ${LOOPBACK_HOST}; refusing to bind ${JSON.stringify(host)} (there is no LAN mode).`);
  }
  const now = opts.now ?? Date.now;
  const devOrigin = opts.devOrigin ?? process.env['STRATEGOS_DEV_ORIGIN'];
  const hub = opts.hub ?? createWsHub();
  const pairing = opts.pairing ?? createPairing({ now });
  const stat: StaticHandler | null = opts.staticDir === undefined ? null : createStaticHandler(opts.staticDir);
  const pairLimiter: RateLimiter = createRateLimiter({ max: LIMITS.pairingPerMinute, windowMs: 60_000, now });
  const hookLimiter: RateLimiter = createRateLimiter({ max: LIMITS.hookPerSecondPerSession, windowMs: 1000, now });
  const apiRoutes = new Map<string, ApiHandler>();
  const controlRoutes = new Map<string, ApiHandler>();
  const controlLimiter: RateLimiter = createRateLimiter({ max: 20, windowMs: 1000, now });
  let hookHandler: HookHandler | null = null;
  let statusHandler: StatusLineHandler | null = null;
  let boundPort = opts.port;

  const uiHeaders = (): Record<string, string> => ({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${boundPort}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  });

  /** Origin rule for UI routes. A same-origin GET/HEAD may omit Origin (browsers do); everything else must send it. */
  function originOk(req: IncomingMessage): boolean {
    const origin = headerValue(req, 'origin');
    if (origin !== undefined) return uiOriginAllowed(origin, boundPort, devOrigin);
    const safeMethod = req.method === 'GET' || req.method === 'HEAD';
    return safeMethod && headerValue(req, 'sec-fetch-site') === 'same-origin';
  }

  function hookAuth(req: IncomingMessage, res: ServerResponse, sid: string): boolean {
    if (hasOriginHeader(req)) {
      reply(res, 403);
      return false;
    }
    const token = opts.tokenFor(sid);
    if (token === undefined) {
      reply(res, 404);
      return false;
    }
    const given = headerValue(req, 'x-strategos-token');
    if (given === undefined || !safeEqual(given, token)) {
      reply(res, 401);
      return false;
    }
    if (!hookLimiter.hit(sid)) {
      reply(res, 429, { 'Retry-After': '1' });
      return false;
    }
    return true;
  }

  async function readJsonBody(req: IncomingMessage, res: ServerResponse, cap: number): Promise<{ value: unknown } | null> {
    const buf = await readBody(req, cap);
    if (buf === null) {
      replyTooLarge(req, res);
      return null;
    }
    if (buf.length === 0) return { value: null };
    try {
      return { value: JSON.parse(buf.toString('utf8')) };
    } catch {
      reply(res, 400);
      return null;
    }
  }

  async function handleHook(req: IncomingMessage, res: ServerResponse, sid: string, event: string): Promise<void> {
    if (req.method !== 'POST') return reply(res, 405, { Allow: 'POST' });
    if (!hookAuth(req, res, sid)) return;
    const body = await readJsonBody(req, res, CAPS.hook);
    if (body === null) return;
    if (hookHandler === null) return reply(res, 404);
    await hookHandler(sid, event, body.value, req, res);
  }

  async function handleStatusLine(req: IncomingMessage, res: ServerResponse, sid: string): Promise<void> {
    if (req.method !== 'POST') return reply(res, 405, { Allow: 'POST' });
    if (!hookAuth(req, res, sid)) return;
    const body = await readJsonBody(req, res, CAPS.statusLine);
    if (body === null) return;
    if (statusHandler === null) return reply(res, 404);
    await statusHandler(sid, body.value, req, res);
  }

  async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return reply(res, 405, { Allow: 'POST' });
    if (!originOk(req)) return reply(res, 403);
    if (!pairLimiter.hit('pair')) return reply(res, 429, { 'Retry-After': '60' });
    const body = await readJsonBody(req, res, CAPS.uiCommand);
    if (body === null) return;
    const code = typeof body.value === 'object' && body.value !== null ? (body.value as { code?: unknown }).code : undefined;
    const session = typeof code === 'string' ? pairing.redeem(code) : null;
    if (session === null) return reply(res, 401);
    reply(res, 204, { 'Set-Cookie': pairing.setCookie(session), 'Cache-Control': 'no-store' });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (!originOk(req)) return reply(res, 403);
    if (!pairing.isAuthenticated(headerValue(req, 'cookie'))) return reply(res, 401);
    if (pathname === '/api/session' && req.method === 'GET') return replyJson(res, 200, { ok: true, port: boundPort });
    const handler = apiRoutes.get(`${req.method} ${pathname}`);
    if (handler === undefined) return reply(res, 404);
    const body = await readBody(req, CAPS.uiCommand);
    if (body === null) return replyTooLarge(req, res);
    await handler(req, res, body);
  }

  async function handleControl(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (opts.controlSecret === undefined) return reply(res, 404);
    if (req.method !== 'POST') return reply(res, 405, { Allow: 'POST' });
    if (hasOriginHeader(req)) return reply(res, 403);
    const given = headerValue(req, 'x-strategos-control');
    if (given === undefined || !safeEqual(given, opts.controlSecret)) return reply(res, 401);
    if (!controlLimiter.hit('control')) return reply(res, 429, { 'Retry-After': '1' });
    const handler = controlRoutes.get(pathname);
    if (handler === undefined) return reply(res, 404);
    const body = await readBody(req, 4 * KiB);
    if (body === null) return replyTooLarge(req, res);
    await handler(req, res, body);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(headerValue(req, 'host'), boundPort)) return reply(res, 421);
    const url = splitUrl(req.url);
    if (url === null) return reply(res, 400);
    const { pathname } = url;
    let m: RegExpExecArray | null;
    if ((m = HOOK_RE.exec(pathname)) !== null) return handleHook(req, res, m[1]!, m[2]!);
    if ((m = STATUS_RE.exec(pathname)) !== null) return handleStatusLine(req, res, m[1]!);
    if (pathname.startsWith('/hook/') || pathname.startsWith('/statusline/')) return reply(res, 404);
    if (pathname.startsWith('/control/')) return handleControl(req, res, pathname);
    if (pathname === '/api/pair') return handlePair(req, res);
    if (pathname.startsWith('/api/') || pathname === '/api') return handleApi(req, res, pathname);
    if (pathname === '/ws') return reply(res, 426, { Upgrade: 'websocket' });
    if (stat === null) return reply(res, 404);
    await stat.handle(req, res, pathname, uiHeaders());
  }

  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500);
      else res.destroy();
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000; // receiving a request; a held hook response is not limited by this

  function refuseUpgrade(socket: Duplex, status: number, text: string): void {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined);
    if (!hostAllowed(headerValue(req, 'host'), boundPort)) return refuseUpgrade(socket, 421, 'Misdirected Request');
    const url = splitUrl(req.url);
    if (url === null || url.pathname !== '/ws') return refuseUpgrade(socket, 404, 'Not Found');
    // A browser always sends Origin on a WebSocket upgrade, so it is required here (no same-origin exemption).
    if (!uiOriginAllowed(headerValue(req, 'origin'), boundPort, devOrigin)) return refuseUpgrade(socket, 403, 'Forbidden');
    if (!pairing.isAuthenticated(headerValue(req, 'cookie'))) return refuseUpgrade(socket, 401, 'Unauthorized');
    hub.handleUpgrade(req, socket, head);
  });

  return {
    listen() {
      return new Promise<number>((resolve, reject) => {
        const onError = (e: NodeJS.ErrnoException) => {
          reject(e.code === 'EADDRINUSE'
            ? new Error(`Port ${opts.port} on ${LOOPBACK_HOST} is already in use. Strategos keeps one port (config.json machine.port) because run settings embed it; stop whatever uses it or change the port.`)
            : e);
        };
        server.once('error', onError);
        server.listen(opts.port, LOOPBACK_HOST, () => {
          server.off('error', onError);
          const a = server.address();
          boundPort = typeof a === 'object' && a !== null ? a.port : opts.port;
          resolve(boundPort);
        });
      });
    },
    async close() {
      pairing.revokeAll();
      await hub.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
    get port() { return boundPort; },
    http: server,
    hub,
    pairing,
    setHookHandler(h) { hookHandler = h; },
    setStatusLineHandler(h) { statusHandler = h; },
    registerApi(method, pathname, handler) {
      if (pathname === '/api/pair' || pathname === '/api/session') throw new Error(`${pathname} is reserved`);
      if (!pathname.startsWith('/api/')) throw new Error('API routes must start with /api/');
      apiRoutes.set(`${method.toUpperCase()} ${pathname}`, handler);
    },
    registerControl(name, handler) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error('bad control route name');
      controlRoutes.set('/control/' + name, handler);
    },
    pairUrl() {
      return `http://${LOOPBACK_HOST}:${boundPort}/#pair=${pairing.issueCode()}`;
    },
  };
}
