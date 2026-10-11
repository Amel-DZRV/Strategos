// Read-only snapshot of a Claude config dir for the "real ~/.claude assertion" (plan section 9):
//   node tools/snapshot-claude-dir.ts [dir] > before.json   ...run the acceptance script...   node tools/snapshot-claude-dir.ts [dir] > after.json
// settings.json / settings.local.json hashes must be equal; the top-level listing shows what appeared or vanished.
// This file only reads.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ClaudeDirSnapshot {
  dir: string;
  /** SHA-256 hex of the file, or null when it does not exist */
  settingsJson: string | null;
  settingsLocalJson: string | null;
  /** Top-level entry names with "/" suffix for directories, sorted */
  topLevel: string[];
}

function sha256File(path: string): string | null {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export function defaultClaudeDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
}

export function snapshotClaudeDir(dir: string = defaultClaudeDir()): ClaudeDirSnapshot {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const topLevel = names.map((n) => (lstatSync(join(dir, n)).isDirectory() ? `${n}/` : n)).sort();
  return { dir, settingsJson: sha256File(join(dir, 'settings.json')), settingsLocalJson: sha256File(join(dir, 'settings.local.json')), topLevel };
}

/** Throws when either settings file changed. Listing differences are returned, not thrown (Claude itself writes there). */
export function compareSnapshots(before: ClaudeDirSnapshot, after: ClaudeDirSnapshot): { added: string[]; removed: string[] } {
  if (before.settingsJson !== after.settingsJson) throw new Error('settings.json changed');
  if (before.settingsLocalJson !== after.settingsLocalJson) throw new Error('settings.local.json changed');
  return {
    added: after.topLevel.filter((n) => !before.topLevel.includes(n)),
    removed: before.topLevel.filter((n) => !after.topLevel.includes(n)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(snapshotClaudeDir(process.argv[2]), null, 2) + '\n');
}
