import { describe, expect, it } from 'vitest';
import { canonicalWin32, claudeConfigDir, strategosHome } from './win32/paths.ts';
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
    ['C:\\Users\\Amel.DESKTOP-8UP1MTT\\Mixed Case', 'C:\\Users\\Amel.DESKTOP-8UP1MTT\\Mixed Case'],
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
    expect(projectDirName('C:\\Users\\Amel.DESKTOP-8UP1MTT')).toBe('C--Users-Amel-DESKTOP-8UP1MTT');
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
