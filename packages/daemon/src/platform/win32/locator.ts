import { homedir } from 'node:os';
import { win32 } from 'node:path';
import type { LocateResult } from '../types.ts';
import { defaultDeps, pickClaude, type Candidate, type Env, type LocatorDeps } from '../common/locate.ts';

const REAL_EXE_REL = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];

/**
 * Resolve an npm `.cmd` shim to the real claude.exe. The shim's last command line is
 * `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`.
 * Returns null when the shim does not point at a claude.exe that exists.
 */
export function resolveCmdShim(cmdPath: string, deps: Pick<LocatorDeps, 'isFile' | 'readFile'>): string | null {
  const dir = win32.dirname(cmdPath);
  let text = '';
  try { text = deps.readFile(cmdPath); } catch { /* fall through to the sibling guess */ }
  const m = /"(?:%dp0%|%~dp0)\\?([^"\r\n]*?claude\.exe)"/i.exec(text);
  if (m?.[1]) {
    const target = win32.join(dir, m[1]);
    if (deps.isFile(target)) return target;
  }
  const sibling = win32.join(dir, ...REAL_EXE_REL);
  return deps.isFile(sibling) ? sibling : null;
}

/** One path to a candidate file: .exe is used as is, .cmd/.bat go through the shim parser, anything else is not runnable. */
function fromFile(p: string, deps: LocatorDeps): string | { skip: string } | null {
  if (!deps.isFile(p)) return null;
  const ext = win32.extname(p).toLowerCase();
  if (ext === '.exe') return p;
  if (ext === '.cmd' || ext === '.bat') return resolveCmdShim(p, deps) ?? { skip: `shim ${p} does not point at a claude.exe` };
  return { skip: `${p} is not an .exe or .cmd` };
}

export function pathCandidates(deps: LocatorDeps): Candidate[] {
  const env = deps.env;
  const exts = (env['PATHEXT'] || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const out: Candidate[] = [];
  for (const dir of (env['PATH'] || '').split(';').filter(Boolean)) {
    // V18: `where claude` lists the extensionless sh shim first; PATHEXT order skips it because "claude" has no extension.
    for (const ext of exts) {
      const p = win32.join(dir.replace(/^"|"$/g, ''), 'claude' + ext);
      out.push({ label: p, resolve: () => fromFile(p, deps) });
    }
  }
  return out;
}

export async function locateClaudeWin32(cfg: { claudePath?: string }, deps: LocatorDeps = defaultDeps()): Promise<LocateResult> {
  const env: Env = deps.env;
  if (cfg.claudePath) {
    const p = cfg.claudePath;
    return pickClaude([], deps, { label: p, resolve: () => fromFile(p, deps) });
  }
  const appData = env['APPDATA'];
  const profile = env['USERPROFILE'] || homedir();
  const candidates: Candidate[] = [...pathCandidates(deps)];
  if (appData) {
    const cmd = win32.join(appData, 'npm', 'claude.cmd');
    candidates.push({ label: cmd, resolve: () => fromFile(cmd, deps) });
  }
  const local = win32.join(profile, '.local', 'bin', 'claude.exe');
  candidates.push({ label: local, resolve: () => fromFile(local, deps) });
  return pickClaude(candidates, deps);
}
