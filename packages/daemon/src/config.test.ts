import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { configPath, defaultConfig, loadConfig, PORT_MAX, PORT_MIN, randomPort, saveConfig, strategosHome, validateConfig } from './config.ts';
import { makeTestEnv, type TestEnv } from './store/testing.ts';

let env: TestEnv;
beforeEach(async () => { env = await makeTestEnv(); });
afterEach(async () => { await env.cleanup(); });

const errorsOf = (raw: unknown): string[] => {
  const r = validateConfig(raw, () => 50000);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
};

describe('config', () => {
  it('STRATEGOS_HOME overrides the home', () => {
    expect(strategosHome({ STRATEGOS_HOME: 'X:/s' }, 'H')).toBe(path.resolve('X:/s'));
    expect(strategosHome({}, 'H')).toBe(path.join('H', '.strategos'));
  });

  it('picks ports in 49152-65535', () => {
    for (let i = 0; i < 500; i++) {
      const p = randomPort();
      expect(p).toBeGreaterThanOrEqual(PORT_MIN);
      expect(p).toBeLessThanOrEqual(PORT_MAX);
    }
    expect(randomPort((a, b) => b - 1)).toBe(PORT_MAX);
  });

  it('an empty object is valid: defaults fill in and a port is assigned', () => {
    const r = validateConfig({}, () => 50001);
    expect(r.ok && r.portAssigned && r.config.machine.port === 50001).toBe(true);
    if (r.ok) {
      expect(r.config.portable.statusLine.mode).toBe('chain');
      expect(r.config.machine.host).toBe('127.0.0.1');
    }
  });

  it('refuses a non-loopback bind', () => {
    for (const host of ['0.0.0.0', '192.168.1.5', 'localhost', '::1', '']) {
      expect(errorsOf({ machine: { host } }).join('\n')).toMatch(/machine\.host.*127\.0\.0\.1/);
    }
  });

  it('gives clear, path-prefixed messages', () => {
    expect(errorsOf({ machine: { port: 80 } })[0]).toBe('machine.port: must be a whole number from 49152 to 65535 (got 80)');
    expect(errorsOf({ machine: { port: '50000' } })[0]).toMatch(/machine\.port.*"50000"/);
    expect(errorsOf({ machine: { repos: 'C:/x' } })[0]).toMatch(/machine\.repos: must be an array of strings/);
    expect(errorsOf({ portable: { guards: [{ id: 'a' }] } })[0]).toMatch(/portable\.guards\[0\]/);
    expect(errorsOf({ portable: { thresholds: { ctxWarnPct: 90, ctxFullPct: 80 } } })[0]).toMatch(/ctxWarnPct.*lower than ctxFullPct/);
    expect(errorsOf({ portable: { statusLine: { mode: 'loud' } } })[0]).toMatch(/statusLine\.mode.*"chain"/);
    expect(errorsOf({ portable: { testCommandPatterns: ['('] } })[0]).toMatch(/testCommandPatterns\[0\].*regular expression/);
    expect(errorsOf([])[0]).toMatch(/top level/);
    expect(errorsOf({ schema: 2 })[0]).toMatch(/schema/);
    expect(errorsOf({ machine: 5 })[0]).toMatch(/machine: must be an object/);
  });

  it('reports every problem at once', () => {
    const e = errorsOf({ machine: { port: 1, repos: 3 }, portable: { keymap: { a: 1 } } });
    expect(e).toHaveLength(3);
  });

  it('accepts guards and rejects duplicate ids', () => {
    const g = { id: 'g', description: 'd', tool: 'Bash', pattern: 'rm -rf', enabled: true };
    expect(validateConfig({ portable: { guards: [g] } }).ok).toBe(true);
    expect(errorsOf({ portable: { guards: [g, g] } })[0]).toMatch(/duplicate id/);
  });

  it('first run writes defaults with a stable port', async () => {
    const r = await loadConfig({ fs: env.fs, home: env.home });
    expect(r.ok && r.created).toBe(true);
    const port = r.ok ? r.config.machine.port : 0;
    const again = await loadConfig({ fs: env.fs, home: env.home, pickPort: () => 12345 });
    expect(again.ok && !again.created && again.config.machine.port === port).toBe(true);
    expect(JSON.parse(readFileSync(configPath(env.home), 'utf8')).machine.port).toBe(port);
  });

  it('a file without a port gets one chosen and saved once', async () => {
    await env.fs.writeFile(configPath(env.home), JSON.stringify({ machine: { repos: ['C:/a'] } }));
    const r1 = await loadConfig({ fs: env.fs, home: env.home, pickPort: () => 50500 });
    expect(r1.ok && r1.config.machine.port).toBe(50500);
    const r2 = await loadConfig({ fs: env.fs, home: env.home, pickPort: () => 60000 });
    expect(r2.ok && r2.config.machine.port).toBe(50500);
    expect(r2.ok && r2.config.machine.repos).toEqual(['C:/a']);
  });

  it('a broken file is reported with a clear message and is not overwritten', async () => {
    await env.fs.writeFile(configPath(env.home), '{ nope');
    const r = await loadConfig({ fs: env.fs, home: env.home });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not valid JSON/);
    expect(readFileSync(configPath(env.home), 'utf8')).toBe('{ nope');
    await env.fs.writeFile(configPath(env.home), JSON.stringify({ machine: { host: '0.0.0.0' } }));
    const r2 = await loadConfig({ fs: env.fs, home: env.home });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toMatch(/machine\.host/);
  });

  it('save validates and keeps config.json.bak', async () => {
    const first = await loadConfig({ fs: env.fs, home: env.home });
    if (!first.ok) throw new Error('setup');
    const c = structuredClone(first.config);
    c.machine.repos = ['C:/one'];
    expect((await saveConfig({ fs: env.fs, home: env.home }, c)).ok).toBe(true);
    c.machine.repos = ['C:/two'];
    await saveConfig({ fs: env.fs, home: env.home }, c);
    expect(JSON.parse(readFileSync(configPath(env.home) + '.bak', 'utf8')).machine.repos).toEqual(['C:/one']);
    const bad = await saveConfig({ fs: env.fs, home: env.home }, { machine: { host: '0.0.0.0' } });
    expect(bad.ok).toBe(false);
    expect(JSON.parse(readFileSync(configPath(env.home), 'utf8')).machine.repos).toEqual(['C:/two']);
  });

  it('defaultConfig round-trips through the validator', () => {
    const d = defaultConfig(50000);
    const r = validateConfig(JSON.parse(JSON.stringify(d)));
    expect(r.ok && r.config).toEqual(d);
    expect(existsSync(env.home)).toBe(true);
  });
});
