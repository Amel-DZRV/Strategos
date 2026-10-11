import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getPlatform } from './index.ts';
import { descendantsFromPs } from './darwin/process.ts';
import * as win from './win32/process.ts';
import * as mac from './darwin/process.ts';

/** level1 -> level2 -> level3, each a separate node process printing "pid:<n>" through the inherited stdout chain. */
const TREE_SCRIPT = [
  `const { spawn } = require('node:child_process');`,
  `const d = Number(process.argv[1]);`,
  `console.log('pid:' + process.pid);`,
  `if (d < 3) spawn(process.execPath, ['-e', process.argv[2], String(d + 1), process.argv[2]], { stdio: ['ignore', 'inherit', 'inherit'] });`,
  `setInterval(() => {}, 1000);`,
].join('\n');

function spawnRoot(): ChildProcess {
  return spawn(process.execPath, ['-e', TREE_SCRIPT, '1', TREE_SCRIPT], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
}

async function startTree(): Promise<{ root: ChildProcess; pids: number[] }> {
  let root: ChildProcess;
  try { root = spawnRoot(); } catch { await new Promise((r) => setTimeout(r, 500)); root = spawnRoot(); } // Windows occasionally answers EPERM under load
  const pids: number[] = [];
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`tree did not start: ${pids}`)), 15_000);
    createInterface({ input: root.stdout! }).on('line', (l) => {
      const m = /^pid:(\d+)/.exec(l);
      if (m) pids.push(Number(m[1]));
      if (pids.length === 3) { clearTimeout(t); resolve(); }
    });
  });
  return { root, pids };
}

const gone = async (pid: number, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  const proc = getPlatform().proc;
  while (Date.now() < end) {
    if (!(await proc.isAlive(pid))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

describe('proc on this OS (getPlatform)', () => {
  const proc = getPlatform().proc;

  it('startTime / isAlive: own pid is alive; a wrong start time is a different process; a dead pid is not alive', async () => {
    const st = await proc.startTime(process.pid);
    expect(st).toBeTruthy();
    expect(await proc.isAlive(process.pid)).toBe(true);
    expect(await proc.isAlive(process.pid, st!)).toBe(true);
    expect(await proc.isAlive(process.pid, 'not-the-start-time')).toBe(false);
    expect(await proc.isAlive(2 ** 30 + 12345)).toBe(false);
    expect(await proc.startTime(2 ** 30 + 12345)).toBeNull();
  }, 60_000);

  it('killTree removes a 3-level node tree (node -> node -> node)', async () => {
    const { root, pids } = await startTree();
    expect(new Set(pids).size).toBe(3);
    for (const p of pids) expect(await proc.isAlive(p)).toBe(true);
    await proc.killTree(root.pid!);
    for (const p of pids) expect(await gone(p), `pid ${p} should be gone`).toBe(true);
  }, 60_000);

  it('killTree on a pid that is already gone does not throw', async () => {
    const { root, pids } = await startTree();
    await proc.killTree(root.pid!);
    for (const p of pids) await gone(p);
    await expect(proc.killTree(root.pid!)).resolves.toBeUndefined();
  }, 60_000);

  it('rejects an invalid pid', async () => {
    await expect(proc.killTree(-1)).rejects.toThrow();
    await expect(proc.killTree(0)).rejects.toThrow();
    expect(await proc.isAlive(NaN)).toBe(false);
  });
});

describe('darwin process helpers (pure)', () => {
  const ps = ['    1     0', '  100     1', '  200   100', '  201   100', '  300   200', '  999     1', ''].join('\n');
  it('descendantsFromPs lists children before parents and ignores unrelated processes', () => {
    const d = descendantsFromPs(ps, 100);
    expect(new Set(d)).toEqual(new Set([200, 201, 300]));
    expect(d.indexOf(300)).toBeLessThan(d.indexOf(200));
    expect(descendantsFromPs(ps, 999)).toEqual([]);
  });
  it('survives a cyclic table', () => {
    expect(descendantsFromPs('1 2\n2 1\n', 1)).toEqual([2]);
  });
});

describe.runIf(process.platform === 'win32')('win32 process (real, Windows only)', () => {
  it('startTime is a FILETIME (same unit as sessions/<pid>.json procStart)', async () => {
    const st = await win.startTime(process.pid);
    expect(st).toMatch(/^1[3-9]\d{16}$/);
  }, 30_000);
});

describe.runIf(process.platform === 'darwin')('darwin process (real, macOS only)', () => {
  it('startTime is the ps lstart string', async () => {
    expect(await mac.startTime(process.pid)).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$/);
  });
});
