// Test helpers: real temporary git repositories (never the user's). Not product code.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { mkTmp, writeText } from '../../../../tools/tmp-fs.ts';

export function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export function write(repo: string, rel: string, text: string): void {
  writeText(path.join(repo, rel), text);
}

/** Long-form temp dir (Windows hands out 8.3 short names; git reports long ones, and the daemon's canonical() does not touch the disk). */
const tmpLong = (prefix: string): string => realpathSync.native(mkTmp(prefix));

/** A repository on branch `main` with one commit. */
export function makeRepo(name = 'proj'): string {
  const dir = path.join(tmpLong('strategos-git-'), name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { windowsHide: true });
  write(dir, 'README.md', 'hello\n');
  write(dir, 'src/a.txt', 'one\ntwo\nthree\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** A bare "remote" plus a clone with `main` pushed and tracking. Nothing ever leaves the temp folder. */
export function makeRepoWithRemote(): { repo: string; remote: string } {
  const base = tmpLong('strategos-git-remote-');
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { windowsHide: true });
  const repo = path.join(base, 'clone');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  write(repo, 'README.md', 'hello\n');
  write(repo, 'src/a.txt', 'one\ntwo\nthree\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'initial');
  g(repo, 'remote', 'add', 'origin', remote);
  g(repo, 'push', '-q', '-u', 'origin', 'main');
  return { repo, remote };
}
