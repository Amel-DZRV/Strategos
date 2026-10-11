import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeFromPairUrl, findLiveDaemon, findNode, nodeCandidates, requestPairCode, strategosHome, type DaemonInfo, type DiscoveryDeps } from './discovery.ts';

/** A fake ~/.strategos: files by name, and a daemon that answers (or not) on its control route. */
function fakeHome(o: { info?: DaemonInfo | null; secret?: string | null; alive?: boolean; pairUrl?: unknown; pairStatus?: number } = {}) {
  const calls: { port: number; secret: string; name: string }[] = [];
  const deps: DiscoveryDeps = {
    readInfo: () => (o.info === undefined ? { pid: 10, port: 47800, startedAt: 1, version: '0.0.0' } : o.info),
    readSecret: () => (o.secret === undefined ? 'sekret' : o.secret),
    control: (info, secret, name) => {
      calls.push({ port: info.port, secret, name });
      if (o.alive === false) return Promise.resolve(null);
      if (name === 'status') return Promise.resolve({ status: 200, json: { pid: info.pid } });
      return Promise.resolve({ status: o.pairStatus ?? 200, json: { url: o.pairUrl ?? `http://127.0.0.1:${info.port}/#pair=abc_DEF-123` } });
    },
  };
  return { deps, calls };
}

describe('daemon discovery with a fake home', () => {
  it('finds the daemon that answers on /control/status, using the secret', async () => {
    const f = fakeHome();
    expect(await findLiveDaemon('/h', f.deps)).toMatchObject({ port: 47800, pid: 10 });
    expect(f.calls).toEqual([{ port: 47800, secret: 'sekret', name: 'status' }]);
  });
  it('treats a leftover daemon.json (nothing answers) as no daemon', async () => {
    expect(await findLiveDaemon('/h', fakeHome({ alive: false }).deps)).toBeNull();
  });
  it('finds nothing without daemon.json or without the secret, and does not call out', async () => {
    const a = fakeHome({ info: null });
    expect(await findLiveDaemon('/h', a.deps)).toBeNull();
    const b = fakeHome({ secret: null });
    expect(await findLiveDaemon('/h', b.deps)).toBeNull();
    expect(a.calls.length + b.calls.length).toBe(0);
  });
  it('asks /control/pair and returns only the code', async () => {
    const f = fakeHome();
    const info = f.deps.readInfo('/h')!;
    expect(await requestPairCode('/h', info, f.deps)).toBe('abc_DEF-123');
    expect(f.calls.at(-1)).toMatchObject({ name: 'pair', secret: 'sekret' });
  });
  it('refuses a pairing link that does not point at this daemon, and failures', async () => {
    const info: DaemonInfo = { pid: 1, port: 47800, startedAt: 0, version: 'x' };
    expect(await requestPairCode('/h', info, fakeHome({ pairUrl: 'http://127.0.0.1:9999/#pair=abc' }).deps)).toBeNull();
    expect(await requestPairCode('/h', info, fakeHome({ pairUrl: 'http://evil.test:47800/#pair=abc' }).deps)).toBeNull();
    expect(await requestPairCode('/h', info, fakeHome({ pairUrl: 42 }).deps)).toBeNull();
    expect(await requestPairCode('/h', info, fakeHome({ pairStatus: 401 }).deps)).toBeNull();
    expect(await requestPairCode('/h', info, fakeHome({ secret: null }).deps)).toBeNull();
    expect(await requestPairCode('/h', info, fakeHome({ alive: false }).deps)).toBeNull();
  });
  it('codeFromPairUrl reads the fragment', () => {
    expect(codeFromPairUrl('http://127.0.0.1:1/#pair=a%2Bb', 1)).toBe('a+b');
    expect(codeFromPairUrl('http://127.0.0.1:1/', 1)).toBeNull();
    expect(codeFromPairUrl('http://127.0.0.1:1/#pair=', 1)).toBeNull();
    expect(codeFromPairUrl('nope', 1)).toBeNull();
  });
});

describe('strategosHome', () => {
  it('uses STRATEGOS_HOME, else ~/.strategos', () => {
    expect(strategosHome({}, path.resolve('/u/me'))).toBe(path.join(path.resolve('/u/me'), '.strategos'));
    expect(strategosHome({ STRATEGOS_HOME: '' }, path.resolve('/u/me'))).toBe(path.join(path.resolve('/u/me'), '.strategos'));
    expect(strategosHome({ STRATEGOS_HOME: 'rel' }, '/u/me')).toBe(path.resolve('rel'));
  });
});

describe('finding the system Node', () => {
  const win = (files: string[], env: Record<string, string> = {}, reg: string | null = null) => ({
    platform: 'win32' as const,
    env: { Path: 'C:\\Windows;C:\\Tools;"C:\\Quoted"', ProgramFiles: 'C:\\Program Files', ...env },
    exists: (p: string) => files.includes(p),
    registryInstallPath: () => reg,
  });
  it('takes the first node.exe on PATH', () => {
    expect(findNode(win(['C:\\Tools\\node.exe', 'C:\\Program Files\\nodejs\\node.exe']))).toBe('C:\\Tools\\node.exe');
    expect(findNode(win(['C:\\Quoted\\node.exe']))).toBe('C:\\Quoted\\node.exe');
  });
  it('falls back to the registry install path, then Program Files', () => {
    expect(findNode(win(['D:\\node\\node.exe'], {}, 'D:\\node'))).toBe('D:\\node\\node.exe');
    expect(findNode(win(['C:\\Program Files\\nodejs\\node.exe']))).toBe('C:\\Program Files\\nodejs\\node.exe');
  });
  it('returns null when there is none (Electron itself is never offered)', () => {
    expect(findNode(win([]))).toBeNull();
    expect(nodeCandidates(win([])).some((c) => /electron/i.test(c))).toBe(false);
  });
  it('works on macOS and Linux paths', () => {
    const d = { platform: 'darwin' as const, env: { PATH: '/usr/bin:/opt/x/bin' }, exists: (p: string) => p === '/opt/homebrew/bin/node' };
    expect(findNode(d)).toBe('/opt/homebrew/bin/node');
    expect(findNode({ ...d, exists: (p: string) => p === '/opt/x/bin/node' })).toBe('/opt/x/bin/node');
  });
});
