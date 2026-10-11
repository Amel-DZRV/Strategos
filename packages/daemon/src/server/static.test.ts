import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { makeTestEnv, type TestEnv } from '../store/testing.ts';
import type { StrategosServer } from './http.ts';
import { mimeFor } from './static.ts';
import { http, startServer } from './testkit.ts';

let env: TestEnv;
let srv: StrategosServer;
beforeEach(async () => {
  env = await makeTestEnv();
  const ui = path.join(env.home, 'ui');
  await env.fs.mkdirp(path.join(ui, 'assets'));
  await env.fs.writeFile(path.join(ui, 'index.html'), '<!doctype html><title>Strategos</title>');
  await env.fs.writeFile(path.join(ui, 'assets', 'app.js'), 'console.log(1)');
  await env.fs.writeFile(path.join(ui, 'assets', 'app.css'), 'a{}');
  await env.fs.writeFile(path.join(ui, 'assets', 'logo.svg'), '<svg/>');
  await env.fs.writeFile(path.join(env.home, 'secret.txt'), 'top secret');
  srv = await startServer({ staticDir: ui });
});
afterEach(async () => {
  await srv.close();
  await env.cleanup();
});

describe('static UI', () => {
  it('serves index.html at / with the right type and security headers', async () => {
    const r = await http(srv.port, { path: '/' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain(`connect-src 'self' ws://127.0.0.1:${srv.port}`);
    expect(r.body.toString()).toContain('Strategos');
  });
  it('serves assets with correct MIME types; HEAD has no body', async () => {
    expect((await http(srv.port, { path: '/assets/app.js' })).headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await http(srv.port, { path: '/assets/app.css' })).headers['content-type']).toBe('text/css; charset=utf-8');
    expect((await http(srv.port, { path: '/assets/logo.svg' })).headers['content-type']).toBe('image/svg+xml');
    const head = await http(srv.port, { method: 'HEAD', path: '/assets/app.js' });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe('14');
  });
  it('mimeFor covers fonts, wasm and unknown types', () => {
    expect(mimeFor('a.woff2')).toBe('font/woff2');
    expect(mimeFor('a.WASM')).toBe('application/wasm');
    expect(mimeFor('a.bin')).toBe('application/octet-stream');
  });
  it('falls back to index.html for extension-less app routes, 404s a missing asset', async () => {
    expect((await http(srv.port, { path: '/some/route' })).body.toString()).toContain('Strategos');
    expect((await http(srv.port, { path: '/assets/missing.js' })).status).toBe(404);
  });
  it.each([
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/assets/../../secret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/..%5csecret.txt',
    '/assets/..%5c..%5csecret.txt',
    '/%00',
    '/%c0%ae%c0%ae/secret.txt',
    '//secret.txt',
  ])('does not leave the root: %s', async (p) => {
    const r = await http(srv.port, { path: p });
    expect(r.body.toString()).not.toContain('top secret');
    expect([200, 400, 404]).toContain(r.status);
    if (r.status === 200) expect(r.body.toString()).toContain('Strategos'); // only the SPA fallback
  });
  it('refuses non-GET methods', async () => {
    expect((await http(srv.port, { method: 'POST', path: '/' })).status).toBe(405);
  });
  it('no static dir configured: 404', async () => {
    const bare = await startServer();
    try {
      expect((await http(bare.port, { path: '/' })).status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
