import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';

type Env = Record<string, string | undefined>;

export function strategosHome(env: Env = process.env, home: string = homedir()): string {
  const o = env['STRATEGOS_HOME'];
  return o ? posix.resolve(o) : posix.join(home, '.strategos');
}

export function claudeConfigDir(env: Env = process.env, home: string = homedir()): string {
  const o = env['CLAUDE_CONFIG_DIR'];
  return o ? posix.resolve(o) : posix.join(home, '.claude');
}

/**
 * macOS canonical form: `realpath` (so /var/folders/... and /private/var/folders/... compare equal, symlinked checkouts resolve).
 * For a path that does not exist yet, the deepest existing ancestor is resolved and the remainder appended.
 * `realpath` is injectable so the logic is unit-testable on any OS.
 */
export function canonicalDarwin(p: string, realpath: (p: string) => string = (x) => realpathSync.native(x)): string {
  const abs = posix.normalize(p.length > 1 ? p.replace(/\/+$/, '') : p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpath(cur);
      return rest.length ? posix.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = posix.dirname(cur);
      if (parent === cur) return abs;
      rest.push(posix.basename(cur));
      cur = parent;
    }
  }
}
