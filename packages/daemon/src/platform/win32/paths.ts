import { homedir } from 'node:os';
import { win32 } from 'node:path';

type Env = Record<string, string | undefined>;

export function strategosHome(env: Env = process.env, home: string = homedir()): string {
  const o = env['STRATEGOS_HOME'];
  return o ? win32.resolve(o) : win32.join(home, '.strategos');
}

export function claudeConfigDir(env: Env = process.env, home: string = homedir()): string {
  const o = env['CLAUDE_CONFIG_DIR'];
  return o ? win32.resolve(o) : win32.join(home, '.claude');
}

/**
 * Pure canonical form of a Windows path (no filesystem access, so it also works for paths that do not exist yet):
 * - "/" becomes "\", duplicate separators collapse, "." and ".." resolve, trailing separator dropped (except a root).
 * - Drive letter is upper-cased. The rest keeps its case (Windows is case-insensitive, so compare with a lower-cased copy if needed).
 * - Verbatim prefixes are unwrapped without confusing the two kinds: `\\?\C:\x` -> `C:\x`, `\\?\UNC\srv\share\x` -> `\\srv\share\x`.
 *   The UNC kind is never turned into a drive path or into a path starting `UNC\`, so the two stay distinct.
 * - `\\.\` device paths and `\\?\Volume{...}` are kept as written.
 */
export function canonicalWin32(p: string): string {
  let s = p.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(s)) s = '\\\\' + s.slice(8);
  else if (/^\\\\\?\\[a-z]:(\\|$)/i.test(s)) s = s.slice(4);
  s = win32.normalize(s);
  s = s.replace(/^([a-z]):/, (_m, d: string) => d.toUpperCase() + ':');
  const root = win32.parse(s).root;
  while (s.length > root.length && s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}
