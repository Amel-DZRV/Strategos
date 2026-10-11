// 8.02 against the real sampler: a real parent -> child process tree, compared with a direct measurement of the same pids.
// Process-spawning, so it lives in the 'proc' vitest project (*.e2e.test.ts).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '@strategos/shared';
import { createWin32Platform, createDarwinPlatform } from '../platform/index.ts';
import { createResourceMonitor } from './resources.ts';

const MB = 1024 * 1024;
const CHILD = `globalThis.keep = Buffer.alloc(${120 * MB}, 7); console.log('child-ready'); setInterval(() => {}, 1e6);`;
const PARENT = `
const { spawn } = require('node:child_process');
globalThis.keep = Buffer.alloc(${120 * MB}, 9);
const c = spawn(process.execPath, ['-e', ${JSON.stringify(CHILD)}], { stdio: ['ignore', 'pipe', 'inherit'] });
c.stdout.once('data', () => { console.log('tree-ready ' + process.pid + ' ' + c.pid); });
setInterval(() => {}, 1e6);`;

const kids: ChildProcess[] = [];
afterEach(() => { for (const k of kids.splice(0)) k.kill(); });

/** Working set of the given pids in MB, measured the plain way: PowerShell Get-Process / ps. */
function direct(pids: number[]): number {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pids.join(',')} | Measure-Object WorkingSet64 -Sum).Sum`], { encoding: 'utf8', windowsHide: true });
    return Number(out.trim()) / MB;
  }
  const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.trim() !== '').reduce((a, l) => a + Number(l.trim()), 0) / 1024;
}

describe('resource monitor with the real sampler', () => {
  it('measures a parent+child tree within 10% of a direct measurement', async () => {
    const platform = process.platform === 'win32' ? createWin32Platform({ sampleIntervalMs: 500 }) : createDarwinPlatform({ sampleIntervalMs: 500 });
    const parent = spawn(process.execPath, ['-e', PARENT], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    kids.push(parent);
    const pids = await new Promise<number[]>((resolve, reject) => {
      let buf = '';
      parent.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = /tree-ready (\d+) (\d+)/.exec(buf);
        if (m !== null) resolve([Number(m[1]), Number(m[2])]);
      });
      parent.once('exit', () => { reject(new Error('the parent exited early')); });
    });
    const [parentPid, childPid] = pids as [number, number];
    expect(parentPid).toBe(parent.pid);

    let rec = { strategosId: 's', status: 'working', pty: { pid: parentPid, cols: 1, rows: 1, dirtyInput: false } } as unknown as SessionRecord;
    const listeners = new Set<(s: SessionRecord) => void>();
    const readings: number[] = [];
    const monitor = createResourceMonitor({
      platform,
      manager: {
        list: () => [rec],
        update: (_id, patch) => {
          rec = { ...rec, ...patch };
          if (patch.resource !== undefined) readings.push(patch.resource.treeWorkingSetMb);
          for (const l of listeners) l(rec);
          return rec;
        },
        onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      },
      hub: { publish: () => undefined },
    });
    monitor.start();
    expect(monitor.sampling).toBe(true);
    try {
      // Wait for the second reading (the first sampler tick may predate the child's allocation) that covers both processes.
      const deadline = Date.now() + 60_000;
      while (!(readings.length >= 2 && readings.at(-1)! > 200)) {
        if (Date.now() > deadline) throw new Error(`no usable reading, got ${JSON.stringify(readings)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const before = direct([parentPid, childPid]);
      const measured = rec.resource!.treeWorkingSetMb;
      const after = direct([parentPid, childPid]);
      const reference = (before + after) / 2;
      expect(measured).toBeGreaterThan(200); // both 120 MB buffers are in there
      expect(Math.abs(measured - reference) / reference).toBeLessThan(0.1);
      expect(rec.resource!.pid).toBe(parentPid);
      expect(rec.resource!.treePrivateMb).toBeGreaterThan(200);
    } finally {
      rec = { ...rec, pty: undefined } as SessionRecord;
      for (const l of listeners) l(rec);
      expect(monitor.sampling).toBe(false); // last session gone: the sampler is stopped
      monitor.stop();
    }
  });
});
