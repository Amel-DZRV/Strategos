// One group per row of the section 10 table that applies to the server.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createStrategosServer, type StrategosServer } from './http.ts';
import { CAPS, MiB } from './guards.ts';
import { Client, http, originOf, pairCookie, startServer } from './testkit.ts';

let srv: StrategosServer;
let seen: { sid: string; event: string; body: unknown }[];
beforeEach(async () => {
  seen = [];
  srv = await startServer();
  srv.setHookHandler((sid, event, body, _req, res) => {
    seen.push({ sid, event, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  srv.setStatusLineHandler((sid, body, _req, res) => {
    seen.push({ sid, event: 'statusline', body });
    res.writeHead(204);
    res.end();
  });
});
afterEach(async () => { await srv.close(); });

const hook = (o: { sid?: string; event?: string; token?: string | null; headers?: Record<string, string>; body?: string | Buffer; method?: string } = {}) =>
  http(srv.port, {
    method: o.method ?? 'POST',
    path: `/hook/${o.sid ?? 'sid-1'}/${o.event ?? 'PreToolUse'}`,
    headers: { 'Content-Type': 'application/json', ...(o.token === null ? {} : { 'X-Strategos-Token': o.token ?? 'tok-1' }), ...(o.headers ?? {}) },
    body: o.body ?? '{"tool_name":"Bash"}',
  });

describe('guard matrix: Binding', () => {
  it('listens on 127.0.0.1 only', () => {
    const a = srv.http.address();
    expect(typeof a === 'object' && a?.address).toBe('127.0.0.1');
  });
  it.each(['0.0.0.0', '192.168.1.20', '::', 'localhost', ''])('refuses to be created for host %j', (host) => {
    expect(() => createStrategosServer({ port: 0, host, tokenFor: () => undefined })).toThrow(/127\.0\.0\.1/);
  });
  it('reports a busy port with a clear message', async () => {
    const other = createStrategosServer({ port: srv.port, tokenFor: () => undefined });
    await expect(other.listen()).rejects.toThrow(/already in use/);
  });
});

describe('guard matrix: Host', () => {
  it.each([
    ['evil.example', true],
    ['127.0.0.1', true],
    ['localhost', true],
    ['127.0.0.1:1', true],
    ['localhost:1', true],
    ['127.0.0.1.evil.example:PORT', true],
    ['[::1]:PORT', true],
    ['127.0.0.1:PORT', false],
    ['localhost:PORT', false],
  ])('Host %s refused=%s', async (host, refused) => {
    const r = await http(srv.port, { path: '/', headers: { Host: host.replace('PORT', String(srv.port)) } });
    if (refused) expect(r.status).toBe(421);
    else expect(r.status).not.toBe(421);
  });
  it('is checked on hook routes and on the WebSocket upgrade too', async () => {
    expect((await hook({ headers: { Host: 'evil.example' } })).status).toBe(421);
    const cookie = await pairCookie(srv);
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Host: 'evil.example', Origin: originOf(srv), Cookie: cookie } });
    const status = await new Promise<number>((resolve) => {
      ws.once('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
      ws.once('error', () => resolve(-1));
    });
    expect(status).toBe(421);
    expect(seen).toEqual([]);
  });
});

describe('guard matrix: Origin (UI routes)', () => {
  const pair = (origin: string | null) =>
    http(srv.port, { method: 'POST', path: '/api/pair', headers: origin === null ? {} : { Origin: origin }, body: JSON.stringify({ code: srv.pairing.issueCode() }) });

  it('accepts exactly http://127.0.0.1:<port>', async () => {
    expect((await pair(originOf(srv))).status).toBe(204);
  });
  it.each([
    ['another local dev server', () => 'http://127.0.0.1:3000'],
    ['localhost instead of 127.0.0.1', () => `http://localhost:${srv.port}`],
    ['https', () => `https://127.0.0.1:${srv.port}`],
    ['a trailing slash', () => `http://127.0.0.1:${srv.port}/`],
    ['null origin', () => 'null'],
    ['a foreign site', () => 'https://evil.example'],
  ])('refuses %s', async (_name, origin) => {
    expect((await pair(origin())).status).toBe(403);
  });
  it('refuses a missing Origin on POST', async () => {
    expect((await pair(null)).status).toBe(403);
  });
  it('accepts the one explicit STRATEGOS_DEV_ORIGIN and nothing else', async () => {
    const dev = await startServer({ devOrigin: 'http://localhost:5173' });
    try {
      const go = (origin: string) => http(dev.port, { method: 'POST', path: '/api/pair', headers: { Origin: origin }, body: JSON.stringify({ code: dev.pairing.issueCode() }) });
      expect((await go('http://localhost:5173')).status).toBe(204);
      expect((await go('http://localhost:5174')).status).toBe(403);
    } finally {
      await dev.close();
    }
  });
  it('is required on the WebSocket upgrade even with a valid cookie', async () => {
    const cookie = await pairCookie(srv);
    await expect(Client.connect(srv, cookie, { Origin: 'http://127.0.0.1:3000' })).rejects.toThrow(/403/);
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Cookie: cookie } });
    const status = await new Promise<number>((resolve) => {
      ws.once('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
      ws.once('error', () => resolve(-1));
    });
    expect(status).toBe(403);
  });
  it('API routes with a valid cookie still need the Origin', async () => {
    const cookie = await pairCookie(srv);
    const ok = await http(srv.port, { path: '/api/session', headers: { Cookie: cookie, Origin: originOf(srv) } });
    expect(ok.status).toBe(200);
    const bad = await http(srv.port, { path: '/api/session', headers: { Cookie: cookie, Origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    const none = await http(srv.port, { path: '/api/session', headers: { Cookie: cookie } });
    expect(none.status).toBe(403);
  });
});

describe('guard matrix: Session token (pairing)', () => {
  const redeem = (code: string) =>
    http(srv.port, { method: 'POST', path: '/api/pair', headers: { Origin: originOf(srv) }, body: JSON.stringify({ code }) });

  it('a code is 32 random bytes', () => {
    const code = srv.pairing.issueCode();
    expect(Buffer.from(code, 'base64url')).toHaveLength(32);
    expect(srv.pairing.issueCode()).not.toBe(code);
  });
  it('a code works once', async () => {
    const code = srv.pairing.issueCode();
    expect((await redeem(code)).status).toBe(204);
    expect((await redeem(code)).status).toBe(401);
  });
  it('a code dies after 60 s', async () => {
    let t = 1000;
    const s = await startServer({ now: () => t });
    try {
      const code = s.pairing.issueCode();
      t += 61_000;
      const r = await http(s.port, { method: 'POST', path: '/api/pair', headers: { Origin: originOf(s) }, body: JSON.stringify({ code }) });
      expect(r.status).toBe(401);
      const code2 = s.pairing.issueCode();
      t += 59_000;
      const r2 = await http(s.port, { method: 'POST', path: '/api/pair', headers: { Origin: originOf(s) }, body: JSON.stringify({ code: code2 }) });
      expect(r2.status).toBe(204);
    } finally {
      await s.close();
    }
  });
  it('wrong or malformed codes get 401 and no cookie', async () => {
    for (const body of [JSON.stringify({ code: 'nope' }), '{}', '[]', JSON.stringify({ code: 5 })]) {
      const r = await http(srv.port, { method: 'POST', path: '/api/pair', headers: { Origin: originOf(srv) }, body });
      expect(r.status).toBe(401);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    const bad = await http(srv.port, { method: 'POST', path: '/api/pair', headers: { Origin: originOf(srv) }, body: '{not json' });
    expect(bad.status).toBe(400);
  });
  it('the cookie is HttpOnly and SameSite=Strict, and the code is not in the daemon response', async () => {
    const code = srv.pairing.issueCode();
    const r = await redeem(code);
    const cookie = r.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^strategos_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain(code);
    expect(r.body.length).toBe(0);
  });
  it('every API request and the WebSocket upgrade need the cookie', async () => {
    const noCookie = await http(srv.port, { path: '/api/session', headers: { Origin: originOf(srv) } });
    expect(noCookie.status).toBe(401);
    const forged = await http(srv.port, { path: '/api/session', headers: { Origin: originOf(srv), Cookie: 'strategos_session=forged' } });
    expect(forged.status).toBe(401);
    const cookie = await pairCookie(srv);
    expect((await http(srv.port, { path: '/api/session', headers: { Origin: originOf(srv), Cookie: cookie } })).status).toBe(200);
    expect((await http(srv.port, { path: '/api/other', headers: { Origin: originOf(srv), Cookie: cookie } })).status).toBe(404);
    await expect(Client.connect(srv, 'strategos_session=forged')).rejects.toThrow(/401/);
    const c = await Client.connect(srv, cookie);
    c.close();
  });
  it('registered API routes sit behind the same guards', async () => {
    srv.registerApi('POST', '/api/echo', (_req, res, body) => { res.writeHead(200); res.end(body); });
    const cookie = await pairCookie(srv);
    expect((await http(srv.port, { method: 'POST', path: '/api/echo', headers: { Origin: originOf(srv) }, body: 'x' })).status).toBe(401);
    const ok = await http(srv.port, { method: 'POST', path: '/api/echo', headers: { Origin: originOf(srv), Cookie: cookie }, body: 'hi' });
    expect(ok.body.toString()).toBe('hi');
  });
  it('the pairing URL carries the code in the fragment', () => {
    const u = new URL(srv.pairUrl());
    expect(u.search).toBe('');
    expect(u.hash).toMatch(/^#pair=[A-Za-z0-9_-]{43}$/);
  });
});

describe('guard matrix: Hook routes', () => {
  it('delivers a valid hook to the handler', async () => {
    const r = await hook({ event: 'PreToolUse' });
    expect(r.status).toBe(200);
    expect(seen).toEqual([{ sid: 'sid-1', event: 'PreToolUse', body: { tool_name: 'Bash' } }]);
  });
  it('refuses any request carrying an Origin header, even the right one', async () => {
    expect((await hook({ headers: { Origin: originOf(srv) } })).status).toBe(403);
    expect((await hook({ headers: { Origin: 'null' } })).status).toBe(403);
    expect((await hook({ headers: { Origin: '' } })).status).toBe(403);
    expect(seen).toEqual([]);
  });
  it('unknown session: 404 with an empty body', async () => {
    const r = await hook({ sid: 'nobody' });
    expect(r.status).toBe(404);
    expect(r.body.length).toBe(0);
  });
  it('missing or wrong token: 401; another session\'s token: 401', async () => {
    expect((await hook({ token: null })).status).toBe(401);
    expect((await hook({ token: 'wrong' })).status).toBe(401);
    expect((await hook({ token: 'tok-2' })).status).toBe(401);
    expect((await hook({ sid: 'sid-2', token: 'tok-2' })).status).toBe(200);
    expect(seen.map((s) => s.sid)).toEqual(['sid-2']);
  });
  it('a hook cookie-less request cannot reach the UI API with the hook token', async () => {
    const r = await http(srv.port, { path: '/api/session', headers: { 'X-Strategos-Token': 'tok-1' } });
    expect(r.status).toBe(403);
  });
  it('only POST, only /hook/<sid>/<Event>', async () => {
    expect((await hook({ method: 'GET' })).status).toBe(405);
    expect((await http(srv.port, { method: 'POST', path: '/hook/sid-1', headers: { 'X-Strategos-Token': 'tok-1' } })).status).toBe(404);
    expect((await http(srv.port, { method: 'POST', path: '/hook/sid-1/Pre/Tool', headers: { 'X-Strategos-Token': 'tok-1' } })).status).toBe(404);
    expect((await http(srv.port, { method: 'POST', path: '/hook/..%2f..%2fapi/Pre', headers: { 'X-Strategos-Token': 'tok-1' } })).status).toBe(404);
  });
  it('malformed JSON is 400; an empty body reaches the handler as null', async () => {
    expect((await hook({ body: '{oops' })).status).toBe(400);
    expect((await hook({ body: '' })).status).toBe(200);
    expect(seen.at(-1)?.body).toBeNull();
  });
  it('the handler may hold the response open and answer later', async () => {
    let release!: () => void;
    srv.setHookHandler((_sid, _event, _body, _req, res) => {
      release = () => { res.writeHead(200); res.end('{"decision":"allow"}'); };
    });
    const pending = hook({ event: 'PermissionRequest' });
    await new Promise((r) => setTimeout(r, 100));
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(false);
    release();
    expect((await pending).body.toString()).toBe('{"decision":"allow"}');
  });
  it('statusline route has the same guards', async () => {
    const sl = (headers: Record<string, string>, sid = 'sid-1') => http(srv.port, { method: 'POST', path: `/statusline/${sid}`, headers, body: '{"a":1}' });
    expect((await sl({ 'X-Strategos-Token': 'tok-1' })).status).toBe(204);
    expect((await sl({ 'X-Strategos-Token': 'tok-1', Origin: originOf(srv) })).status).toBe(403);
    expect((await sl({ 'X-Strategos-Token': 'bad' })).status).toBe(401);
    expect((await sl({ 'X-Strategos-Token': 'tok-1' }, 'nobody')).status).toBe(404);
  });
  it('with no handler installed the answer is an empty 404 (no decision)', async () => {
    srv.setHookHandler(null);
    const r = await hook();
    expect(r.status).toBe(404);
    expect(r.body.length).toBe(0);
  });
});

describe('guard matrix: Body caps', () => {
  it('hook bodies over 8 MiB: 413 and the connection is closed', async () => {
    const small = await hook({ body: JSON.stringify({ pad: 'x'.repeat(MiB) }) });
    expect(small.status).toBe(200);
    const big = await hook({ body: Buffer.alloc(CAPS.hook + 1, 0x61) });
    expect(big.status).toBe(413);
    await big.closed;
    expect(seen).toHaveLength(1);
  }, 20_000);
  it('a chunked hook body over the cap is cut off too', async () => {
    const small = await http(srv.port, { method: 'POST', path: '/statusline/sid-1', headers: { 'X-Strategos-Token': 'tok-1', 'Transfer-Encoding': 'chunked' }, body: JSON.stringify({ pad: 'x'.repeat(1000) }) });
    expect(small.status).toBe(204);
    const big = await http(srv.port, { method: 'POST', path: '/statusline/sid-1', headers: { 'X-Strategos-Token': 'tok-1', 'Transfer-Encoding': 'chunked' }, body: Buffer.alloc(CAPS.statusLine + 10, 0x61) });
    expect(big.status).toBe(413);
    await big.closed;
  });
  it('status line over 256 KiB: 413 and closed', async () => {
    const ok = await http(srv.port, { method: 'POST', path: '/statusline/sid-1', headers: { 'X-Strategos-Token': 'tok-1' }, body: JSON.stringify({ pad: 'x'.repeat(200 * 1024) }) });
    expect(ok.status).toBe(204);
    const big = await http(srv.port, { method: 'POST', path: '/statusline/sid-1', headers: { 'X-Strategos-Token': 'tok-1' }, body: Buffer.alloc(CAPS.statusLine + 1, 0x61) });
    expect(big.status).toBe(413);
    await big.closed;
  });
  it('UI command bodies over 64 KiB: 413 and closed', async () => {
    srv.registerApi('POST', '/api/echo', (_req, res, body) => { res.writeHead(200); res.end(String(body.length)); });
    const cookie = await pairCookie(srv);
    const h = { Origin: originOf(srv), Cookie: cookie };
    expect((await http(srv.port, { method: 'POST', path: '/api/echo', headers: h, body: Buffer.alloc(CAPS.uiCommand, 0x61) })).status).toBe(200);
    const big = await http(srv.port, { method: 'POST', path: '/api/echo', headers: h, body: Buffer.alloc(CAPS.uiCommand + 1, 0x61) });
    expect(big.status).toBe(413);
    await big.closed;
    const pairBig = await http(srv.port, { method: 'POST', path: '/api/pair', headers: { Origin: originOf(srv) }, body: Buffer.alloc(CAPS.uiCommand + 1, 0x61) });
    expect(pairBig.status).toBe(413);
  });
  it('a WebSocket frame over 1 MiB closes the connection (1009)', async () => {
    const cookie = await pairCookie(srv);
    const c = await Client.connect(srv, cookie);
    c.ws.send('x'.repeat(CAPS.wsFrame + 1));
    expect(await c.closed()).toBe(1009);
  });
  it('a WebSocket command over 64 KiB closes the connection (1009)', async () => {
    const cookie = await pairCookie(srv);
    const c = await Client.connect(srv, cookie);
    c.send({ id: 'big', c: 'reply.send', strategosId: 's', text: 'x'.repeat(CAPS.uiCommand + 10) });
    expect(await c.closed()).toBe(1009);
  });
});

describe('guard matrix: Rate limits', () => {
  it('pairing: 5 attempts per minute, then 429', async () => {
    let t = 5_000_000;
    const s = await startServer({ now: () => t });
    try {
      const attempt = () => http(s.port, { method: 'POST', path: '/api/pair', headers: { Origin: originOf(s) }, body: JSON.stringify({ code: 'guess' }) });
      for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
      const sixth = await attempt();
      expect(sixth.status).toBe(429);
      expect(sixth.headers['retry-after']).toBe('60');
      // Even a correct code is refused while limited.
      const good = await http(s.port, { method: 'POST', path: '/api/pair', headers: { Origin: originOf(s) }, body: JSON.stringify({ code: s.pairing.issueCode() }) });
      expect(good.status).toBe(429);
      t += 60_001;
      expect((await attempt()).status).toBe(401);
    } finally {
      await s.close();
    }
  });
  it('hooks: 200 per second per session, other sessions unaffected', async () => {
    let t = 9_000_000;
    const s = await startServer({ now: () => t });
    s.setHookHandler((_sid, _e, _b, _req, res) => { res.writeHead(200); res.end(); });
    try {
      const go = (sid: string, token: string) => http(s.port, { method: 'POST', path: `/hook/${sid}/Stop`, headers: { 'X-Strategos-Token': token }, body: '{}' });
      const statuses: number[] = [];
      for (let i = 0; i < 201; i++) statuses.push((await go('sid-1', 'tok-1')).status);
      expect(statuses.filter((x) => x === 200)).toHaveLength(200);
      expect(statuses[200]).toBe(429);
      expect((await go('sid-2', 'tok-2')).status).toBe(200);
      t += 1001;
      expect((await go('sid-1', 'tok-1')).status).toBe(200);
    } finally {
      await s.close();
    }
  }, 30_000);
  it('unauthenticated hook traffic does not use up a session\'s budget', async () => {
    const t = 1;
    const s = await startServer({ now: () => t });
    s.setHookHandler((_sid, _e, _b, _req, res) => { res.writeHead(200); res.end(); });
    try {
      for (let i = 0; i < 210; i++) await http(s.port, { method: 'POST', path: '/hook/sid-1/Stop', headers: { 'X-Strategos-Token': 'wrong' }, body: '{}' });
      expect((await http(s.port, { method: 'POST', path: '/hook/sid-1/Stop', headers: { 'X-Strategos-Token': 'tok-1' }, body: '{}' })).status).toBe(200);
    } finally {
      await s.close();
    }
  }, 30_000);
});
