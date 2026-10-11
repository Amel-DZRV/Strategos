import { describe, expect, it } from 'vitest';
import { mkTmp, rmTree, writeText } from '../../../tools/tmp-fs.ts';
import * as path from 'node:path';
import { checkClaudeVersion, inTestedRange, parseVersion } from './claude-version.ts';
import { acquireLock } from './daemon-lock.ts';
import { assignRingSlot, buildLaunchArgs, buildLaunchEnv, planetColour, planetLabel, readOwnerStatusLine, resolveRepo, spiralCell } from './sessions/launch.ts';
import { makeTestEnv } from './store/testing.ts';
import { renderStatus } from './cli.ts';

describe('launch args and env', () => {
  it('always passes session id/resume, settings, name and permission mode (default "default")', () => {
    const a = buildLaunchArgs({ mode: { kind: 'new', claudeSessionId: 'c1' }, settingsPath: 'S', name: 'n', launch: { addDirs: ['d1'], extraArgs: ['--x'], model: 'm' } });
    expect(a).toEqual(['--session-id', 'c1', '--settings', 'S', '--name', 'n', '--permission-mode', 'default', '--model', 'm', '--add-dir', 'd1', '--x']);
    const r = buildLaunchArgs({ mode: { kind: 'resume', claudeSessionId: 'c1' }, settingsPath: 'S', name: 'n', launch: { addDirs: [], extraArgs: [], permissionMode: 'plan' } });
    expect(r.slice(0, 2)).toEqual(['--resume', 'c1']);
    expect(r).toContain('plan');
  });
  it('scrubs ANTHROPIC_*, keeps CLAUDE_CONFIG_DIR, adds token and optional chain', () => {
    const env = buildLaunchEnv({ source: { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_SIMPLE: '1', CLAUDE_CONFIG_DIR: 'C', PATH: 'p', STRATEGOS_CHAIN_STATUSLINE: 'old' }, hookToken: 'tok', port: 5 });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: 'C', PATH: 'p', STRATEGOS_HOOK_TOKEN: 'tok', STRATEGOS_PORT: '5' });
    expect(buildLaunchEnv({ source: {}, hookToken: 't', port: 1, chainStatusLine: 'echo hi' })['STRATEGOS_CHAIN_STATUSLINE']).toBe('echo hi');
  });
  it('reads the owner status line read-only', () => {
    const d = mkTmp('owner-');
    try {
      expect(readOwnerStatusLine(d)).toBeUndefined();
      writeText(path.join(d, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'my-line' } }));
      expect(readOwnerStatusLine(d)).toBe('my-line');
      writeText(path.join(d, 'settings.json'), '{not json');
      expect(readOwnerStatusLine(d)).toBeUndefined();
    } finally { rmTree(d); }
  });
});

describe('repo, ring slots, planets', () => {
  it('planetKey is the canonical common dir; repoRoot the main checkout', async () => {
    const git = async (_cwd: string, args: string[]): Promise<string | null> => (args[0] === 'rev-parse' ? '../main/.git\nC:/w/wt\n' : 'feat\n');
    const r = await resolveRepo(path.resolve('C:/w/wt'), (p) => p, git);
    expect(path.basename(r.planetKey)).toBe('.git');
    expect(path.basename(r.repoRoot)).toBe('main');
    expect(r).toMatchObject({ isRepo: true, branch: 'feat' });
    const none = await resolveRepo('C:/nogit', (p) => p, async () => null);
    expect(none).toEqual({ planetKey: 'C:/nogit', repoRoot: 'C:/nogit', isRepo: false });
  });
  it('lowest free slot, sticky per group', () => {
    const mk = (id: string, slot: number) => ({ strategosId: id, ringSlotByGroup: { g: slot } });
    expect(assignRingSlot([mk('a', 0), mk('b', 2)], 'g', 'new')).toBe(1);
    expect(assignRingSlot([mk('a', 0)], 'other', 'new')).toBe(0);
    expect(assignRingSlot([mk('a', 0), mk('self', 1)], 'g', 'self')).toBe(1);
  });
  it('labels, colours, spiral', () => {
    expect(planetLabel(path.join('/dev', 'strategos', '.git'))).toBe('strategos');
    expect(planetLabel('/x/bare.git')).toBe('bare');
    expect(planetColour('a')).toMatch(/^#[0-9a-f]{6}$/);
    expect(planetColour('a')).toBe(planetColour('A'));
    expect([0, 1, 2, 3, 4, 5].map(spiralCell)).toEqual([{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 1, row: 1 }, { col: 0, row: 1 }, { col: -1, row: 1 }, { col: -1, row: 0 }]);
  });
});

describe('version guard', () => {
  it('parses and checks', () => {
    expect(parseVersion('2.1.292 (Claude Code)')).toEqual([2, 1, 292]);
    expect(inTestedRange('2.1.292 (Claude Code)')).toBe(true);
    expect(inTestedRange('2.1.293')).toBe(false);
    expect(inTestedRange('2.1.300', '2.1.292 - 2.1.310')).toBe(true);
    expect(inTestedRange('garbage')).toBe(false);
    expect(checkClaudeVersion('3.0.0').message).toMatch(/outside the tested range/);
    expect(checkClaudeVersion(undefined)).toMatchObject({ inRange: false, claudeVersion: 'unknown' });
    expect(checkClaudeVersion('2.1.292')).toMatchObject({ inRange: true, message: '' });
  });
});

describe('daemon.lock', () => {
  it('live holder refuses, dead holder is replaced, release removes only our lock', async () => {
    const env = await makeTestEnv();
    try {
      const alive = new Set([111]);
      const deps = (pid: number) => ({ fs: env.fs, home: env.home, pid, startTime: async () => 'T', isAlive: async (p: number) => alive.has(p) });
      alive.add(111);
      const first = await acquireLock(deps(111));
      expect(first.ok).toBe(true);
      const second = await acquireLock(deps(222));
      expect(second).toMatchObject({ ok: false, holder: { pid: 111 } });
      alive.delete(111);
      const third = await acquireLock(deps(222));
      expect(third.ok).toBe(true);
      if (first.ok) await first.release(); // not ours any more: leaves 222's lock
      alive.add(222);
      expect((await acquireLock(deps(333))).ok).toBe(false);
      if (third.ok) await third.release();
      expect((await acquireLock(deps(333))).ok).toBe(true);
    } finally { await env.cleanup(); }
  });
});

describe('cli rendering', () => {
  it('renders a table', () => {
    const out = renderStatus({
      pid: 1, port: 2, version: '0', startedAt: 0, claude: { version: '2.1.292', testedRange: '2.1.292', inRange: true, error: null },
      sessions: [{ strategosId: 'abcdef123456', name: 'alpha', status: 'working', statusSource: 'hook', statusSince: 0, planet: 'repo', cwd: '/', last: 'hi', pending: null, ctxPct: null, costUsd: 0, pid: 4, archived: false }],
    }, 5000);
    expect(out).toContain('abcdef12');
    expect(out).toMatch(/working\s+5s\s+hook\s+repo\s+hi/);
  });
});
