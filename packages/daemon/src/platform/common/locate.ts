import { readFileSync, statSync } from 'node:fs';
import type { LocateResult } from '../types.ts';
import { run } from './exec.ts';
import { bundleRefusal } from './bundle.ts';

export type Env = Record<string, string | undefined>;

export interface LocatorDeps {
  env: Env;
  /** true when `p` is an existing regular file */
  isFile(p: string): boolean;
  readFile(p: string): string;
  /** stdout of `<exe> --version`, or null when it could not be run (timeout, non-zero exit, not executable) */
  runVersion(exe: string): Promise<string | null>;
  /** resolves symlinks (darwin); identity on Windows */
  realpath(p: string): string;
}

export function defaultDeps(env: Env = process.env): LocatorDeps {
  return {
    env,
    isFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
    readFile: (p) => readFileSync(p, 'utf8'),
    runVersion: async (exe) => {
      try {
        const r = await run(exe, ['--version'], { timeoutMs: 8000 });
        return r.code === 0 ? r.stdout : null;
      } catch { return null; }
    },
    realpath: (p) => p,
  };
}

/** A candidate yields the executable to run, or a reason it is unusable. */
export type Candidate = { label: string; resolve: () => string | { skip: string } | null };

/**
 * Try candidates in order. A candidate that is missing is skipped silently; one that is refused (bundle) or fails
 * `--version` is remembered so the final error says why. First usable candidate wins.
 * `explicit` candidates (config.claudePath) never fall through to the others.
 */
export async function pickClaude(candidates: Candidate[], deps: LocatorDeps, explicit?: Candidate): Promise<LocateResult> {
  const notes: string[] = [];
  const check = async (c: Candidate): Promise<LocateResult | null> => {
    const r = c.resolve();
    if (r === null) return null;
    if (typeof r === 'object') { notes.push(`${c.label}: ${r.skip}`); return null; }
    const refused = bundleRefusal(r) ?? bundleRefusal(deps.realpath(r));
    if (refused) { notes.push(refused); return null; }
    const out = await deps.runVersion(r);
    const version = out?.split(/\r?\n/)[0]?.trim();
    if (!version || !/\d+\.\d+\.\d+/.test(version)) { notes.push(`${r}: \`--version\` did not give a version`); return null; }
    return { exe: r, version };
  };
  if (explicit) {
    const r = await check(explicit);
    return r ?? { error: notes.length ? notes.join('; ') : `claudePath not found: ${explicit.label}` };
  }
  for (const c of candidates) {
    const r = await check(c);
    if (r) return r;
  }
  return { error: 'claude not found' + (notes.length ? ` (${notes.join('; ')})` : '') };
}
