// `npm run app`: build the UI (once), bundle the shell, start Electron against this checkout.
//   node scripts/run.ts [--smoke [--smoke-shot <png>] [--smoke-out <json>]]  (extra flags go to Electron)
// Electron starts the daemon itself with the system Node if none is running (see src/daemon-launch.ts).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { buildShell } from './build.ts';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(pkg, '..', '..');

if (!existsSync(path.join(repo, 'packages', 'ui', 'dist', 'index.html'))) {
  console.log('Building the UI (first run)...');
  const r = spawnSync('npm', ['run', 'build', '-w', '@strategos/ui'], { cwd: repo, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
await buildShell();

const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE']; // set by some editors' terminals; it would make Electron behave like plain Node
const child = spawn(electron as unknown as string, [pkg, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => { process.exit(code ?? 0); });
