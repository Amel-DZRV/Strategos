// Test helpers shared by the store and server tests. Not imported by production code.
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSafeFs, type SafeFs } from '../safe-fs.ts';

export interface TestEnv {
  /** Sandbox root holding both folders below. */
  base: string;
  /** Fake Strategos home (the only allowed root). */
  home: string;
  /** Fake Claude config dir; a sibling of home, so it is outside the allowed roots too. Not created. */
  claudeDir: string;
  fs: SafeFs;
  cleanup(): Promise<void>;
}

export async function makeTestEnv(): Promise<TestEnv> {
  const base = path.join(os.tmpdir(), `strategos-test-${randomUUID()}`);
  const home = path.join(base, 'home');
  const claudeDir = path.join(base, '.claude');
  const sfs = createSafeFs({ claudeDir, roots: [home] });
  // Bootstrapping the sandbox itself: base is allowed for this call only.
  await sfs.mkdirp(home, { allow: [base] });
  return {
    base,
    home,
    claudeDir,
    fs: sfs,
    cleanup: () => sfs.rm(base, { recursive: true, force: true, allow: [base] }),
  };
}
