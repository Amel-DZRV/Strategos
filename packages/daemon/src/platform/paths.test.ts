import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalWin32, canonicalWin32Real, claudeConfigDir, strategosHome } from './win32/paths.ts';
import * as mac from './darwin/paths.ts';
import { javaStyleHash, MAX_PROJECT_DIR_LEN, projectDirName, projectDirPrefix } from './common/project-dir.ts';

describe('canonicalWin32 (pure, runs on every OS)', () => {
  const table: [string, string][] = [
    ['c:\\dev\\strategos', 'C:\\dev\\strategos'],
    ['C:/dev/strategos', 'C:\\dev\\strategos'],
    ['C:\\dev\\\\strategos\\', 'C:\\dev\\strategos'],
    ['C:\\dev\\x\\..\\strategos\\.', 'C:\\dev\\strategos'],
    ['c:/', 'C:\\'],
    ['C:\\', 'C:\\'],
    ['\\\\?\\C:\\dev\\strategos', 'C:\\dev\\strategos'],
    ['\\\\?\\c:\\dev', 'C:\\dev'],
    ['\\\\?\\UNC\\srv\\share\\dir', '\\\\srv\\share\\dir'],
    ['\\\\srv\\share\\dir\\', '\\\\srv\\share\\dir'],
    ['//srv/share/dir', '\\\\srv\\share\\dir'],
    ['\\\\.\\COM3', '\\\\.\\COM3'],
    ['C:\\Users\\Owner.PC-EXAMPLE\\Mixed Case', 'C:\\Users\\Owner.PC-EXAMPLE\\Mixed Case'],
  ];
  it.each(table)('%s -> %s', (input, expected) => {
    expect(canonicalWin32(input)).toBe(expected);
  });

  it('keeps drive-verbatim and UNC-verbatim results distinct and never leaks "UNC\\" into the path', () => {
    const drive = canonicalWin32('\\\\?\\C:\\share\\x');
    const unc = canonicalWin32('\\\\?\\UNC\\C\\share\\x');
    expect(drive).toBe('C:\\share\\x');
    expect(unc).toBe('\\\\C\\share\\x');
    expect(drive).not.toBe(unc);
    expect(unc).not.toMatch(/UNC/);
  });

  it('is idempotent', () => {
    for (const [input] of table) expect(canonicalWin32(canonicalWin32(input))).toBe(canonicalWin32(input));
  });
});

describe('canonicalDarwin (injected realpath, runs on every OS)', () => {
  const fake = (map: Record<string, string>) => (p: string): string => {
    for (const [from, to] of Object.entries(map)) if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length);
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  it('/var and /private/var compare equal', () => {
    const rp = fake({ '/var': '/private/var', '/private': '/private' });
    expect(mac.canonicalDarwin('/var/folders/ab/T/x', rp)).toBe('/private/var/folders/ab/T/x');
    expect(mac.canonicalDarwin('/private/var/folders/ab/T/x', rp)).toBe('/private/var/folders/ab/T/x');
  });
  it('resolves the deepest existing ancestor for a path that does not exist yet', () => {
    const rp = fake({ '/var': '/private/var', '/private': '/private' });
    expect(mac.canonicalDarwin('/var/new/dir/', rp)).toBe('/private/var/new/dir');
  });
  it('returns the normalised input when nothing exists', () => {
    expect(mac.canonicalDarwin('/nope/a/../b', () => { throw new Error('ENOENT'); })).toBe('/nope/b');
  });
});

describe('home directories', () => {
  it('STRATEGOS_HOME and CLAUDE_CONFIG_DIR override, defaults sit under home (win32)', () => {
    expect(strategosHome({ STRATEGOS_HOME: 'D:\\sh' }, 'C:\\Users\\u')).toBe('D:\\sh');
    expect(strategosHome({}, 'C:\\Users\\u')).toBe('C:\\Users\\u\\.strategos');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'D:\\cc' }, 'C:\\Users\\u')).toBe('D:\\cc');
    expect(claudeConfigDir({}, 'C:\\Users\\u')).toBe('C:\\Users\\u\\.claude');
  });
  it('same on darwin', () => {
    expect(mac.strategosHome({ STRATEGOS_HOME: '/tmp/sh' }, '/Users/u')).toBe('/tmp/sh');
    expect(mac.strategosHome({}, '/Users/u')).toBe('/Users/u/.strategos');
    expect(mac.claudeConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/cc' }, '/Users/u')).toBe('/tmp/cc');
    expect(mac.claudeConfigDir({}, '/Users/u')).toBe('/Users/u/.claude');
  });
});

describe('projectDirName', () => {
  it('encodes non-alphanumerics as "-" [ran against ~/.claude/projects]', () => {
    expect(projectDirName('C:\\Users\\Owner.PC-EXAMPLE')).toBe('C--Users-Owner-PC-EXAMPLE');
    expect(projectDirName('C:\\dev\\Claude Code Mods')).toBe('C--dev-Claude-Code-Mods');
    expect(projectDirName('/Users/amel/dev/my_app')).toBe('-Users-amel-dev-my-app');
  });
  it('names over 200 characters are truncated to 200 and get "-<hash>" appended [hash algorithm unverified]', () => {
    const long = '/Users/amel/' + 'a'.repeat(300);
    const name = projectDirName(long);
    expect(name.startsWith(projectDirPrefix(long))).toBe(true);
    expect(name.length).toBeGreaterThan(MAX_PROJECT_DIR_LEN);
    expect(name.slice(0, MAX_PROJECT_DIR_LEN)).toBe(projectDirPrefix(long));
    expect(name[MAX_PROJECT_DIR_LEN]).toBe('-');
    expect(name.slice(MAX_PROJECT_DIR_LEN + 1)).toBe(javaStyleHash(long));
  });
  it('exactly 200 characters is not hashed', () => {
    const s = 'x'.repeat(200);
    expect(projectDirName(s)).toBe(s);
  });
});

describe('canonicalWin32Real', () => {
  const fake = (map: Record<string, string>) => (p: string): string => {
    for (const [from, to] of Object.entries(map)) if (p.toLowerCase() === from.toLowerCase() || p.toLowerCase().startsWith(from.toLowerCase() + '\\')) return to + p.slice(from.length);
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  it('expands an existing prefix and appends the missing rest (injected realpath, every OS)', () => {
    const rp = fake({ 'C:\\Users\\OWNER~1.PCE': 'C:\\Users\\Owner.PC-EXAMPLE', 'C:\\Users': 'C:\\Users', 'C:\\': 'C:\\' });
    expect(canonicalWin32Real('c:/Users/OWNER~1.PCE/new/dir/', rp)).toBe('C:\\Users\\Owner.PC-EXAMPLE\\new\\dir');
    expect(canonicalWin32Real('C:\\Users\\Owner.PC-EXAMPLE\\new\\dir', rp)).toBe('C:\\Users\\Owner.PC-EXAMPLE\\new\\dir');
  });
  it('falls back to the text form when nothing exists, keeping verbatim/UNC handling', () => {
    const none = (): string => { throw new Error('ENOENT'); };
    expect(canonicalWin32Real('\\\\?\\c:\\a\\..\\b', none)).toBe('C:\\b');
    expect(canonicalWin32Real('\\\\?\\UNC\\srv\\share\\x', none)).toBe('\\\\srv\\share\\x');
  });

  it.runIf(process.platform === 'win32')('an 8.3 short path and its long form give the same canonical path (real filesystem)', (ctx) => {
    const base = mkdtempSync(join(realpathSync.native(tmpdir()), 'strategos-canon-'));
    try {
      const long = join(base, 'A Long Directory Name');
      mkdirSync(long);
      let short = '';
      try {
        // verbatim arguments: Node's default quoting would mangle the inner quotes for cmd
        short = (spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout ?? '').trim();
      } catch { /* handled below */ }
      if (!short || short.toLowerCase() === long.toLowerCase() || !short.includes('~')) {
        console.warn('8.3 short names are disabled on this volume: skipping the real-filesystem short-name test');
        ctx.skip();
        return;
      }
      expect(canonicalWin32Real(short)).toBe(canonicalWin32Real(long));
      expect(canonicalWin32Real(short)).toBe(canonicalWin32(realpathSync.native(long)));
      // a not-yet-existing child under the short form resolves through the existing parent
      expect(canonicalWin32Real(join(short, 'new', 'x'))).toBe(canonicalWin32Real(join(long, 'new', 'x')));
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
