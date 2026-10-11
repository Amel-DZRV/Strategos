import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { mkTmp, rmTree, writeText } from '../../../../tools/tmp-fs.ts';
import { bundleRefusal } from './common/bundle.ts';
import { defaultDeps, type LocatorDeps } from './common/locate.ts';
import { locateClaudeWin32, resolveCmdShim } from './win32/locator.ts';
import { locateClaudeDarwin, darwinDeps } from './darwin/locator.ts';

const SHIM_CMD = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*', '',
].join('\r\n');
const SH_SHIM = '#!/bin/sh\nexec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"\n';
const REAL_REL = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];

describe('bundleRefusal (pure)', () => {
  const refused = [
    'C:\\Program Files\\Claude\\claude.exe',
    'C:\\Program Files (x86)\\Claude\\app\\claude.exe',
    'C:\\Users\\u\\AppData\\Local\\AnthropicClaude\\app-1.2\\resources\\claude.exe',
    'C:\\Program Files\\WindowsApps\\Anthropic.Claude_1.0_x64\\app\\claude.exe',
    'C:\\Users\\u\\AppData\\Local\\Packages\\Claude_abc123\\LocalCache\\claude.exe',
    '/Applications/Claude.app/Contents/MacOS/claude',
    '/Users/u/Applications/Some Thing.app/Contents/Resources/claude',
    'C:/Program Files/Claude/claude.exe',
  ];
  const allowed = [
    'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    'C:\\Users\\u\\.local\\bin\\claude.exe',
    '/Users/u/.local/bin/claude',
    '/opt/homebrew/bin/claude',
    'C:\\Program Files\\nodejs\\claude.exe',
    '/Users/u/dev/application/claude',
  ];
  it.each(refused)('refuses %s', (p) => { expect(bundleRefusal(p)).not.toBeNull(); });
  it.each(allowed)('allows %s', (p) => { expect(bundleRefusal(p)).toBeNull(); });
});

describe('win32 locator with temp dirs', () => {
  let root: string;
  const versions = new Map<string, string | null>();
  const mk = (env: Record<string, string>): LocatorDeps => ({
    ...defaultDeps(env),
    runVersion: async (exe) => (versions.has(exe) ? versions.get(exe)! : '2.1.292 (Claude Code)\n'),
  });
  beforeEach(() => { root = mkTmp('loc-'); versions.clear(); });
  afterEach(() => rmTree(root));

  function npmGlobal(dir: string): string {
    writeText(join(dir, 'claude'), SH_SHIM);
    writeText(join(dir, 'claude.cmd'), SHIM_CMD);
    writeText(join(dir, 'claude.ps1'), '# ps1 shim');
    return writeText(join(dir, ...REAL_REL), 'MZ');
  }

  it('skips the extensionless sh shim and resolves claude.cmd to the real claude.exe', async () => {
    const npm = join(root, 'npm');
    const real = npmGlobal(npm);
    const r = await locateClaudeWin32({}, mk({ PATH: npm, PATHEXT: '.COM;.EXE;.BAT;.CMD' }));
    expect(r).toEqual({ exe: real, version: '2.1.292 (Claude Code)' });
  });

  it('PATHEXT order decides: .exe beside a .cmd wins when .EXE is listed first', async () => {
    const dir = join(root, 'bin');
    const exe = writeText(join(dir, 'claude.exe'), 'MZ');
    npmGlobal(dir);
    const r = await locateClaudeWin32({}, mk({ PATH: dir, PATHEXT: '.EXE;.CMD' }));
    expect('exe' in r && r.exe).toBe(exe);
    const r2 = await locateClaudeWin32({}, mk({ PATH: dir, PATHEXT: '.CMD;.EXE' }));
    expect('exe' in r2 && r2.exe).toBe(join(dir, ...REAL_REL));
  });

  it('only the extensionless shim present: nothing runnable', async () => {
    const dir = join(root, 'bin');
    writeText(join(dir, 'claude'), SH_SHIM);
    const r = await locateClaudeWin32({}, mk({ PATH: dir, PATHEXT: '.EXE;.CMD', APPDATA: join(root, 'none'), USERPROFILE: join(root, 'none') }));
    expect(r).toEqual({ error: expect.stringContaining('claude not found') });
  });

  it('refuses a bundle path on PATH and falls through to the npm global one', async () => {
    const bad = writeText(join(root, 'Program Files', 'Claude', 'claude.exe'), 'MZ');
    const apps = writeText(join(root, 'WindowsApps', 'claude.exe'), 'MZ');
    const appData = join(root, 'Roaming');
    const real = npmGlobal(join(appData, 'npm'));
    const r = await locateClaudeWin32({}, mk({ PATH: [join(root, 'Program Files', 'Claude'), join(root, 'WindowsApps')].join(';'), PATHEXT: '.EXE;.CMD', APPDATA: appData, USERPROFILE: join(root, 'none') }));
    expect(r).toEqual({ exe: real, version: '2.1.292 (Claude Code)' });
    expect(bad).not.toBe(real); expect(apps).not.toBe(real);
  });

  it('error mentions the refusal when only a bundle exists', async () => {
    writeText(join(root, 'WindowsApps', 'claude.exe'), 'MZ');
    const r = await locateClaudeWin32({}, mk({ PATH: join(root, 'WindowsApps'), PATHEXT: '.EXE', APPDATA: join(root, 'x'), USERPROFILE: join(root, 'x') }));
    expect(r).toEqual({ error: expect.stringMatching(/refusing .*WindowsApps/) });
  });

  it('config.claudePath is used first and never falls through when bad', async () => {
    const npm = join(root, 'npm');
    npmGlobal(npm);
    const mine = writeText(join(root, 'mine', 'claude.exe'), 'MZ');
    const env = { PATH: npm, PATHEXT: '.EXE;.CMD' };
    expect(await locateClaudeWin32({ claudePath: mine }, mk(env))).toEqual({ exe: mine, version: '2.1.292 (Claude Code)' });
    expect(await locateClaudeWin32({ claudePath: join(root, 'missing.exe') }, mk(env))).toEqual({ error: expect.any(String) });
    const bundle = writeText(join(root, 'AnthropicClaude', 'app', 'claude.exe'), 'MZ');
    expect(await locateClaudeWin32({ claudePath: bundle }, mk(env))).toEqual({ error: expect.stringContaining('refusing') });
  });

  it('config.claudePath may be a .cmd shim', async () => {
    const npm = join(root, 'npm');
    const real = npmGlobal(npm);
    expect(await locateClaudeWin32({ claudePath: join(npm, 'claude.cmd') }, mk({}))).toEqual({ exe: real, version: '2.1.292 (Claude Code)' });
  });

  it('falls back to %USERPROFILE%\\.local\\bin\\claude.exe', async () => {
    const profile = join(root, 'profile');
    const exe = writeText(join(profile, '.local', 'bin', 'claude.exe'), 'MZ');
    const r = await locateClaudeWin32({}, mk({ PATH: '', USERPROFILE: profile, APPDATA: join(root, 'none') }));
    expect('exe' in r && r.exe).toBe(exe);
  });

  it('a binary whose --version fails is skipped', async () => {
    const dir = join(root, 'bin');
    const exe = writeText(join(dir, 'claude.exe'), 'MZ');
    versions.set(exe, null);
    const r = await locateClaudeWin32({}, mk({ PATH: dir, PATHEXT: '.EXE', APPDATA: join(root, 'x'), USERPROFILE: join(root, 'x') }));
    expect(r).toEqual({ error: expect.stringContaining('--version') });
    versions.set(exe, 'garbage');
    expect(await locateClaudeWin32({}, mk({ PATH: dir, PATHEXT: '.EXE', APPDATA: join(root, 'x'), USERPROFILE: join(root, 'x') }))).toHaveProperty('error');
  });

  it('shim parser: falls back to the sibling path when the shim text is unfamiliar', () => {
    const dir = join(root, 'npm');
    const real = npmGlobal(dir);
    writeText(join(dir, 'claude.cmd'), '@echo odd shim');
    expect(resolveCmdShim(join(dir, 'claude.cmd'), defaultDeps({}))).toBe(real);
    expect(resolveCmdShim(join(root, 'nowhere', 'claude.cmd'), defaultDeps({}))).toBeNull();
  });

  it.runIf(process.platform === 'win32')('this machine: the real npm shim resolves to a runnable claude.exe', async () => {
    const r = await locateClaudeWin32({}, defaultDeps());
    expect(r).toHaveProperty('exe');
    if ('exe' in r) {
      expect(r.exe.toLowerCase().endsWith('claude.exe')).toBe(true);
      expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(bundleRefusal(r.exe)).toBeNull();
    }
  }, 30_000);
});

describe('darwin locator, injected deps (pure, runs on every OS)', () => {
  const files = new Set<string>();
  const mk = (env: Record<string, string>, links: Record<string, string> = {}): LocatorDeps => ({
    env,
    isFile: (p) => files.has(p),
    readFile: () => '',
    runVersion: async () => '2.1.292 (Claude Code)',
    realpath: (p) => links[p] ?? p,
  });
  beforeEach(() => files.clear());

  it('prefers ~/.local/bin/claude', async () => {
    files.add('/Users/u/.local/bin/claude'); files.add('/usr/local/bin/claude');
    expect(await locateClaudeDarwin({}, mk({ HOME: '/Users/u', PATH: '/usr/local/bin' }))).toEqual({ exe: '/Users/u/.local/bin/claude', version: '2.1.292 (Claude Code)' });
  });
  it('finds the npm global install on PATH and under /opt/homebrew/bin', async () => {
    files.add('/opt/homebrew/bin/claude');
    expect(await locateClaudeDarwin({}, mk({ HOME: '/Users/u', PATH: '/bin' }))).toHaveProperty('exe', '/opt/homebrew/bin/claude');
  });
  it('refuses anything inside an .app bundle, including through a symlink', async () => {
    files.add('/Applications/Claude.app/Contents/MacOS/claude');
    expect(await locateClaudeDarwin({ claudePath: '/Applications/Claude.app/Contents/MacOS/claude' }, mk({ HOME: '/Users/u' }))).toEqual({ error: expect.stringContaining('.app bundle') });
    files.add('/usr/local/bin/claude');
    const r = await locateClaudeDarwin({}, mk({ HOME: '/Users/u', PATH: '/usr/local/bin' }, { '/usr/local/bin/claude': '/Applications/Claude.app/Contents/Resources/claude' }));
    expect(r).toEqual({ error: expect.stringContaining('.app bundle') });
  });
  it('explicit claudePath never falls through', async () => {
    files.add('/Users/u/.local/bin/claude');
    expect(await locateClaudeDarwin({ claudePath: '/nope/claude' }, mk({ HOME: '/Users/u' }))).toHaveProperty('error');
  });
});

describe.runIf(process.platform === 'darwin')('darwin locator, real files (macOS only)', () => {
  let root: string;
  beforeEach(() => { root = mkTmp('loc-'); });
  afterEach(() => rmTree(root));
  const script = (p: string): string => { writeText(p, '#!/bin/sh\necho "2.1.292 (Claude Code)"\n'); chmodSync(p, 0o755); return p; };

  it('finds ~/.local/bin/claude and runs --version', async () => {
    const exe = script(join(root, '.local', 'bin', 'claude'));
    const r = await locateClaudeDarwin({}, darwinDeps({ HOME: root, PATH: '/usr/bin:/bin' }));
    expect(r).toEqual({ exe, version: '2.1.292 (Claude Code)' });
  });
  it('refuses a claude inside an .app bundle', async () => {
    const exe = script(join(root, 'Claude.app', 'Contents', 'MacOS', 'claude'));
    expect(await locateClaudeDarwin({ claudePath: exe }, darwinDeps({ HOME: root }))).toEqual({ error: expect.stringContaining('.app') });
  });
});
