// `npm run dist:win` / `dist:mac`: build the UI, the shell and the daemon payload, then run electron-builder (unsigned).
//   node scripts/dist.ts --win | --mac [--dir]     (--dir: unpacked app only, no installer; quick check)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload, buildShell } from './build.ts';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(pkg, '..', '..');
const args = process.argv.slice(2);

const ui = spawnSync('npm', ['run', 'build', '-w', '@strategos/ui'], { cwd: repo, stdio: 'inherit', shell: true });
if (ui.status !== 0) process.exit(ui.status ?? 1);
await buildShell();
await buildPayload();

const target = args.includes('--mac') ? '--mac' : '--win';
const bin = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
if (!existsSync(bin)) throw new Error('electron-builder is not installed (npm install)');
const r = spawnSync(`"${bin}"`, [target, '--publish', 'never', '--config', 'electron-builder.yml', ...(args.includes('--dir') ? ['--dir'] : [])], {
  cwd: pkg, stdio: 'inherit', shell: true, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
process.exit(r.status ?? 1);
