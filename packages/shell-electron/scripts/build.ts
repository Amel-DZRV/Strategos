// Bundle the shell with esbuild:  dist/main.cjs, dist/preload.cjs, build/icon.png.
// `--daemon` also builds the packaged payload (dist/payload): the daemon as one file plus what it reads at run time.
//   node scripts/build.ts [--daemon]
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, renderAppIcon } from '../src/icon.ts';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(pkg, '..', '..');
const dist = path.join(pkg, 'dist');

export async function buildShell(): Promise<void> {
  mkdirSync(dist, { recursive: true });
  const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] as string[], logLevel: 'warning', sourcemap: false } as const;
  await build({ ...common, entryPoints: [path.join(pkg, 'src', 'main.ts')], outfile: path.join(dist, 'main.cjs') });
  await build({ ...common, entryPoints: [path.join(pkg, 'src', 'preload.ts')], outfile: path.join(dist, 'preload.cjs') });
  // electron-builder takes build/icon.png (512 px) and makes the .ico / .icns from it.
  mkdirSync(path.join(pkg, 'build'), { recursive: true });
  writeFileSync(path.join(pkg, 'build', 'icon.png'), encodePng(renderAppIcon(512)));
}

/** The daemon, bundled, laid out like the repo so its own relative paths (tap.mjs, hook-relay.mjs, ui/dist) still resolve. */
export async function buildPayload(): Promise<void> {
  const root = path.join(dist, 'payload');
  rmSync(root, { recursive: true, force: true });
  const src = path.join(root, 'packages', 'daemon', 'src');
  mkdirSync(path.join(src, 'statusline'), { recursive: true });
  await build({
    entryPoints: [path.join(repo, 'packages', 'daemon', 'src', 'main.ts')],
    outfile: path.join(src, 'main.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning',
    external: ['node-pty', 'bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  cpSync(path.join(repo, 'packages', 'daemon', 'src', 'statusline', 'tap.mjs'), path.join(src, 'statusline', 'tap.mjs'));
  mkdirSync(path.join(root, 'tools'), { recursive: true });
  cpSync(path.join(repo, 'tools', 'hook-relay.mjs'), path.join(root, 'tools', 'hook-relay.mjs'));
  const uiDist = path.join(repo, 'packages', 'ui', 'dist');
  if (!existsSync(uiDist)) throw new Error('packages/ui/dist is missing: run "npm run build -w @strategos/ui" first');
  cpSync(uiDist, path.join(root, 'packages', 'ui', 'dist'), { recursive: true });
  // node-pty is native (N-API prebuilt binaries); copy the package with the prebuilds for the systems we ship.
  const pty = path.join(repo, 'node_modules', 'node-pty');
  const ptyOut = path.join(root, 'node_modules', 'node-pty');
  mkdirSync(ptyOut, { recursive: true });
  for (const f of ['package.json', 'LICENSE', 'lib']) cpSync(path.join(pty, f), path.join(ptyOut, f), { recursive: true });
  mkdirSync(path.join(ptyOut, 'prebuilds'), { recursive: true });
  for (const d of readdirSync(path.join(pty, 'prebuilds'))) {
    cpSync(path.join(pty, 'prebuilds', d), path.join(ptyOut, 'prebuilds', d), {
      recursive: true,
      filter: (p) => !p.endsWith('.pdb'),
    });
  }
}

if (import.meta.main) {
  await buildShell();
  if (process.argv.includes('--daemon')) await buildPayload();
  console.log('shell built' + (process.argv.includes('--daemon') ? ' (with daemon payload)' : ''));
}
