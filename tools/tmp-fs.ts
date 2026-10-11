// Test-only filesystem helpers. The daemon package forbids fs writes outside safe-fs.ts (eslint), including in its tests,
// so tests that need temp files import these (tools/ is outside that rule).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function mkTmp(prefix = 'strategos-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeText(path: string, content: string, mode?: number): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
  return path;
}

export function appendText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, content);
}

export function rmTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
