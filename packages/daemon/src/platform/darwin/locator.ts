import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import type { LocateResult } from '../types.ts';
import { defaultDeps, pickClaude, type Candidate, type LocatorDeps } from '../common/locate.ts';

export function darwinDeps(env: NodeJS.ProcessEnv = process.env): LocatorDeps {
  return { ...defaultDeps(env), realpath: (p) => { try { return realpathSync.native(p); } catch { return p; } } };
}

/** Order: config.claudePath, ~/.local/bin/claude, PATH, then common npm-global prefixes. Anything inside a .app bundle is refused. */
export async function locateClaudeDarwin(cfg: { claudePath?: string }, deps: LocatorDeps = darwinDeps()): Promise<LocateResult> {
  const env = deps.env;
  const file = (p: string): Candidate => ({ label: p, resolve: () => (deps.isFile(p) ? p : null) });
  if (cfg.claudePath) return pickClaude([], deps, file(cfg.claudePath));
  const home = env['HOME'] || homedir();
  const candidates: Candidate[] = [file(posix.join(home, '.local', 'bin', 'claude'))];
  for (const dir of (env['PATH'] || '').split(':').filter(Boolean)) candidates.push(file(posix.join(dir, 'claude')));
  const npmPrefix = env['npm_config_prefix'];
  for (const dir of [npmPrefix ? posix.join(npmPrefix, 'bin') : '', '/opt/homebrew/bin', '/usr/local/bin', posix.join(home, '.npm-global', 'bin')]) {
    if (dir) candidates.push(file(posix.join(dir, 'claude')));
  }
  const seen = new Set<string>();
  return pickClaude(candidates.filter((c) => (seen.has(c.label) ? false : (seen.add(c.label), true))), deps);
}
