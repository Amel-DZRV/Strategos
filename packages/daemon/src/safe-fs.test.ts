import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { claudeConfigDir, createSafeFs, SafeFsError } from './safe-fs.ts';
import { makeTestEnv, type TestEnv } from './store/testing.ts';

let env: TestEnv;
beforeEach(async () => { env = await makeTestEnv(); });
afterEach(async () => { await env.cleanup(); });

describe('safe-fs', () => {
  it('writes inside the Strategos home', async () => {
    const f = path.join(env.home, 'a', 'b.txt');
    await env.fs.mkdirp(path.dirname(f));
    await env.fs.writeFile(f, 'hi');
    expect(readFileSync(f, 'utf8')).toBe('hi');
    await env.fs.appendLine(f, 'x');
    expect(readFileSync(f, 'utf8')).toBe('hix\n');
    await env.fs.writeFileAtomic(f, 'new');
    expect(readFileSync(f, 'utf8')).toBe('new');
    expect(readdirSync(path.dirname(f))).toEqual(['b.txt']);
  });

  it('refuses the Claude config dir and everything under it', async () => {
    const target = path.join(env.claudeDir, 'settings.json');
    await expect(env.fs.writeFile(target, '{}')).rejects.toMatchObject({ code: 'CLAUDE_DIR' });
    await expect(env.fs.mkdirp(env.claudeDir)).rejects.toBeInstanceOf(SafeFsError);
    await expect(env.fs.rm(env.claudeDir, { recursive: true })).rejects.toMatchObject({ code: 'CLAUDE_DIR' });
    expect(() => env.fs.check(path.join(env.claudeDir, 'projects', 'x.jsonl'))).toThrow(/Claude config dir/);
  });

  it('refuses the Claude dir even when a caller allows a root that contains it', () => {
    expect(() => env.fs.check(path.join(env.claudeDir, 'x'), [env.base])).toThrow(/Claude config dir/);
  });

  it('refuses a different letter case of the Claude dir (case-insensitive platforms)', () => {
    const ci = createSafeFs({ claudeDir: env.claudeDir, roots: [env.home], caseInsensitive: true });
    expect(() => ci.check(path.join(env.claudeDir.toUpperCase(), 'x'))).toThrow(SafeFsError);
    expect(() => ci.check(path.join(env.claudeDir.toLowerCase(), 'x'))).toThrow(SafeFsError);
  });

  it('refuses ..-traversal into the Claude dir', () => {
    const sneaky = path.join(env.home, '..', '.claude', 'settings.json');
    expect(() => env.fs.check(sneaky)).toThrow(/Claude config dir/);
    const sneaky2 = env.home + path.sep + 'sub' + path.sep + '..' + path.sep + '..' + path.sep + '.claude' + path.sep + 'x';
    expect(() => env.fs.check(sneaky2)).toThrow(/Claude config dir/);
  });

  it('refuses a junction that points into the Claude dir', async () => {
    const realClaude = path.join(env.base, 'real-claude');
    await env.fs.mkdirp(realClaude, { allow: [env.base] });
    const policy = createSafeFs({ claudeDir: realClaude, roots: [env.home] });
    const link = path.join(env.home, 'link');
    try {
      symlinkSync(realClaude, link, 'junction');
    } catch {
      return; // links not permitted on this machine
    }
    expect(() => policy.check(path.join(link, 'settings.json'))).toThrow(/Claude config dir/);
  });

  it('refuses paths outside the allowed roots unless the call allows them', async () => {
    const root = path.join(env.base, 'elsewhere');
    const outside = path.join(root, 'f.txt');
    expect(() => env.fs.check(outside)).toThrow(SafeFsError);
    await env.fs.mkdirp(root, { allow: [root] });
    await env.fs.writeFile(outside, 'ok', { allow: [root] });
    expect(readFileSync(outside, 'utf8')).toBe('ok');
  });

  it('does not confuse a sibling that shares a prefix with a root', () => {
    expect(() => env.fs.check(env.home + '-evil' + path.sep + 'f')).toThrow(SafeFsError);
  });

  it('rejects empty and NUL paths', () => {
    expect(() => env.fs.check('')).toThrow(/invalid path/);
    expect(() => env.fs.check('a\0b')).toThrow(SafeFsError);
  });

  it('rename and copyFile check both ends; rm removes', async () => {
    const a = path.join(env.home, 'a');
    const b = path.join(env.home, 'b');
    await env.fs.writeFile(a, '1');
    await env.fs.copyFile(a, b);
    await expect(env.fs.rename(a, path.join(env.claudeDir, 'a'))).rejects.toBeInstanceOf(SafeFsError);
    await env.fs.rename(a, path.join(env.home, 'c'));
    await env.fs.rm(b);
    expect(readdirSync(env.home)).toEqual(['c']);
  });

  it('chmodUserOnly keeps the folder usable', async () => {
    await env.fs.chmodUserOnly(env.home);
    await env.fs.writeFile(path.join(env.home, 'still-writable'), 'ok');
  });

  it('claudeConfigDir honours CLAUDE_CONFIG_DIR', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'X:/cfg' }, 'H')).toBe(path.resolve('X:/cfg'));
    expect(claudeConfigDir({}, 'H')).toBe(path.join('H', '.claude'));
  });
});
