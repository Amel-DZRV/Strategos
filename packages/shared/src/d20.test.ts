import { describe, expect, it } from 'vitest';
import { isToastApprovablePath, toastActions } from './d20.ts';

// The same table as the daemon's isBatchApprovable test (daemon/src/features/risk.test.ts), minus symbolic links.
const ok = (tool: string, p: unknown, plat: 'win32' | 'posix' = 'posix', wt = plat === 'win32' ? 'C:\\Dev\\Repo' : '/repo'): boolean =>
  isToastApprovablePath(tool, p, wt, plat);

describe('isToastApprovablePath (D20, pure copy)', () => {
  it('passes Read, Edit and Write inside the worktree', () => {
    expect(ok('Read', '/repo/src/a.ts')).toBe(true);
    expect(ok('Edit', 'src/a.ts')).toBe(true);
    expect(ok('Write', '/repo/docs/new.md')).toBe(true);
    expect(ok('Edit', '/repo/src/./a.ts')).toBe(true);
    expect(ok('Edit', 'C:\\Dev\\Repo\\src\\a.ts', 'win32')).toBe(true);
    expect(ok('Edit', 'c:/dev/repo/src/a.ts', 'win32')).toBe(true);
  });
  it('never passes any other tool, above all not Bash', () => {
    for (const tool of ['Bash', 'PowerShell', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'Task', 'mcp__x__y', 'read', 'EDIT', '']) {
      expect(ok(tool, '/repo/a.ts')).toBe(false);
    }
  });
  it('never passes a path outside the worktree', () => {
    expect(ok('Read', '/etc/passwd')).toBe(false);
    expect(ok('Read', '/shared/lib/a.ts')).toBe(false);
    expect(ok('Edit', '/repo/../etc/x')).toBe(false);
    expect(ok('Edit', '../x')).toBe(false);
    expect(ok('Write', '/repo2/a.ts')).toBe(false);
    expect(ok('Write', '~/x')).toBe(false);
    expect(ok('Edit', 'D:\\Lib\\x.ts', 'win32')).toBe(false);
    expect(ok('Edit', 'C:\\Dev\\RepoEvil\\x.ts', 'win32')).toBe(false);
    expect(ok('Edit', 'C:\\Dev\\Repo\\..\\x.ts', 'win32')).toBe(false);
    expect(ok('Edit', '\\\\server\\share\\x', 'win32')).toBe(false);
  });
  it('never passes .git, .claude, .github or any dotfile or dot folder', () => {
    for (const p of [
      '/repo/.git/config', '/repo/.git/hooks/pre-commit', '/repo/.claude/settings.json', '/repo/.claude/settings.local.json',
      '/repo/.github/workflows/ci.yml', '/repo/.env', '/repo/.env.local', '/repo/src/.hidden/a.ts', '/repo/.gitignore',
      '/repo/.npmrc', '/repo/sub/.eslintrc', '.git/config', './.git/config', 'src/../.git/config', '/repo/.GIT/config',
    ]) {
      for (const t of ['Edit', 'Write', 'Read']) expect(ok(t, p), `${t} ${p}`).toBe(false);
    }
    for (const p of ['C:\\Dev\\Repo\\.git\\config', 'c:\\dev\\repo\\.GIT\\HEAD', 'C:\\Dev\\Repo\\.claude\\x', 'C:/Dev/Repo/.github/a.yml', 'C:\\Dev\\Repo\\src\\.env']) {
      expect(ok('Edit', p, 'win32'), p).toBe(false);
    }
  });
  it('never passes Windows spellings of a protected name or of a device', () => {
    for (const p of [
      'C:\\Dev\\Repo\\.git.\\config', 'C:\\Dev\\Repo\\.git \\config', 'C:\\Dev\\Repo\\GIT~1\\config', 'C:\\Dev\\Repo\\.git::$INDEX_ALLOCATION\\config',
      'C:\\Dev\\Repo\\a.txt:stream', 'C:\\Dev\\Repo\\NUL', 'C:\\Dev\\Repo\\con.txt', 'C:\\Dev\\Repo\\src\\*.ts', 'C:\\Dev\\Repo\\a.',
    ]) expect(ok('Edit', p, 'win32'), p).toBe(false);
  });
  it('fails closed on odd input', () => {
    expect(ok('Edit', undefined)).toBe(false);
    expect(ok('Edit', 5)).toBe(false);
    expect(ok('Edit', '')).toBe(false);
    expect(ok('Edit', '/repo/a\0.ts')).toBe(false);
    expect(ok('Edit', `/repo/${'a'.repeat(2000)}`)).toBe(false);
    expect(isToastApprovablePath('Edit', '/repo/a.ts', '', 'posix')).toBe(false);
    expect(isToastApprovablePath('Edit', '/repo/a.ts', 'repo', 'posix')).toBe(false);
    expect(ok('Edit', '{"command":"ls"}')).toBe(false);
  });
});

describe('toastActions', () => {
  const ctx = { worktree: '/repo', platform: 'posix' as const };
  const base = { kind: 'permission' as const, held: true, toolName: 'Edit', inputSummary: '/repo/src/a.ts', inputTruncated: false };
  it('offers Approve for an eligible Edit', () => {
    expect(toastActions(base, ctx)).toEqual(['approve', 'deny', 'open']);
  });
  it('drops Approve for Bash, dotfiles, outside paths and cut input (D21)', () => {
    expect(toastActions({ ...base, toolName: 'Bash', inputSummary: 'npm test' }, ctx)).toEqual(['deny', 'open']);
    expect(toastActions({ ...base, inputSummary: '/repo/.git/config' }, ctx)).toEqual(['deny', 'open']);
    expect(toastActions({ ...base, inputSummary: '/etc/hosts' }, ctx)).toEqual(['deny', 'open']);
    expect(toastActions({ ...base, inputTruncated: true }, ctx)).toEqual(['deny', 'open']);
  });
  it('only Open for questions, unheld requests and no pending', () => {
    expect(toastActions({ ...base, kind: 'question' }, ctx)).toEqual(['open']);
    expect(toastActions({ ...base, held: false }, ctx)).toEqual(['open']);
    expect(toastActions(undefined, ctx)).toEqual(['open']);
  });
});
