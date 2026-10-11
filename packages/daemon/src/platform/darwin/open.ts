import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { run } from '../common/exec.ts';
import { chromeAppArgs, spawnDetached, type SpawnDetached } from '../common/open.ts';

const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

export async function openExternal(urlOrPath: string): Promise<void> {
  if (!urlOrPath || urlOrPath.startsWith('-') || /[\r\n\0]/.test(urlOrPath)) throw new Error('bad target');
  const r = await run('/usr/bin/open', [urlOrPath], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`open exited ${r.code}: ${r.stderr.trim()}`);
}

const CHROME_REL = 'Google Chrome.app/Contents/MacOS/Google Chrome';

export function findChrome(exists: (p: string) => boolean = isFile, home: string = homedir()): string | null {
  for (const base of ['/Applications', posix.join(home, 'Applications')]) {
    const p = posix.join(base, CHROME_REL);
    if (exists(p)) return p;
  }
  return null;
}

export async function openAppWindow(url: string, spawnFn: SpawnDetached = spawnDetached, find: () => string | null = () => findChrome()): Promise<void> {
  const args = chromeAppArgs(url);
  const chrome = find();
  if (!chrome) throw new Error('Google Chrome was not found in /Applications');
  spawnFn(chrome, args);
}
