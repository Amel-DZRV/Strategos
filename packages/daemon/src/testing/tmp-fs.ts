// Test-only filesystem helpers: temp dirs, a tiny fake CLAUDE_CONFIG_DIR, and a read-only directory listing.
// Product code must never import this file. It is the one place under packages/daemon (besides safe-fs.ts)
// that writes, and only inside os.tmpdir(); eslint.config.js exempts packages/daemon/src/testing/**. Lane C's tools/fake-claude-home.ts
// is the richer shared harness; this one exists so reconciler/transcript tests do not depend on it.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

export function makeTmpDir(prefix = 'strategos-test-'): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix))); // long real form (tmpdir can be an 8.3 path)
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

export function writeText(path: string, text: string | Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

export function appendBytes(path: string, data: string | Buffer): void {
  appendFileSync(path, data);
}

export function truncateTo(path: string, size: number): void {
  truncateSync(path, size);
}

/** A stable, content-sensitive listing of everything under `root`: path, size, mtime and a hash of small files. */
export function listing(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      const rel = relative(root, full).replaceAll('\\', '/');
      if (st.isDirectory()) {
        out.push(`${rel}/ dir`);
        walk(full);
      } else {
        const hash = st.size <= 1_000_000 ? createHash('sha1').update(readFileSync(full)).digest('hex') : 'big';
        out.push(`${rel} ${st.size} ${st.mtimeMs} ${hash}`);
      }
    }
  };
  walk(root);
  return out;
}

export interface FakeSessionFile {
  pid: number;
  sessionId: string;
  cwd?: string;
  status?: 'busy' | 'idle' | 'waiting';
  waitingFor?: string;
  statusUpdatedAt?: number;
  [extra: string]: unknown;
}

/** A throwaway CLAUDE_CONFIG_DIR with the layout Claude Code uses: sessions/<pid>.json and projects/<enc>/<id>.jsonl. */
export class FakeClaudeHome {
  readonly root: string;
  constructor() {
    this.root = makeTmpDir('strategos-claude-');
    mkdirSync(join(this.root, 'sessions'), { recursive: true });
    mkdirSync(join(this.root, 'projects'), { recursive: true });
  }
  get sessionsDir(): string {
    return join(this.root, 'sessions');
  }
  addSessionFile(f: FakeSessionFile): string {
    const path = join(this.sessionsDir, `${f.pid}.json`);
    writeFileSync(path, JSON.stringify({ kind: 'interactive', version: '2.1.292', startedAt: 1, updatedAt: 1, cwd: '~/repo', ...f }));
    return path;
  }
  addRawSessionFile(name: string, text: string): string {
    const path = join(this.sessionsDir, name);
    writeFileSync(path, text);
    return path;
  }
  removeSessionFile(pid: number): void {
    rmSync(join(this.sessionsDir, `${pid}.json`), { force: true });
  }
  addTranscript(projectDir: string, sessionId: string, records: unknown[]): string {
    const path = join(this.root, 'projects', projectDir, `${sessionId}.jsonl`);
    writeText(path, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
    return path;
  }
  listing(): string[] {
    return listing(this.root);
  }
  dispose(): void {
    removeDir(this.root);
  }
}
