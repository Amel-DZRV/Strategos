// READ ONLY. Usage: node hash-claude-dir.ts <label>
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const label = process.argv[2] ?? 'snap';
const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const sha = (f: string) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null);
const result = {
  label, at: new Date().toISOString(), dir,
  sha256: { 'settings.json': sha(join(dir, 'settings.json')), 'settings.local.json': sha(join(dir, 'settings.local.json')) },
  listing: readdirSync(dir).sort().map((n) => { const s = statSync(join(dir, n)); return { name: n, dir: s.isDirectory(), size: s.isDirectory() ? undefined : s.size }; }),
};
const o = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(o, { recursive: true });
writeFileSync(join(o, `claude-dir-${label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.sha256), result.listing.map((l) => l.name + (l.dir ? '/' : '')).join(' '));
