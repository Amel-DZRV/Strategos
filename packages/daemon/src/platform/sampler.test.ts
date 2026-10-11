import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { ProcSample } from './types.ts';
import { CpuTracker, createSampler as createWin, parseTickLine, samplerScript } from './win32/sampler.ts';
import { createSampler as createMac, parsePsSamples } from './darwin/sampler.ts';

describe('win32 sampler helpers (pure)', () => {
  it('parseTickLine accepts the loop output and rejects noise', () => {
    expect(parseTickLine('{"t":5,"r":[{"p":1,"pp":0,"ws":1048576,"pv":2097152,"cpu":0,"st":"1"}]}')).toMatchObject({ t: 5 });
    expect(parseTickLine('garbage')).toBeNull();
    expect(parseTickLine('{"t":"x"}')).toBeNull();
  });
  it('CpuTracker: first tick is 0, then delta of 100ns units over wall time', () => {
    const tr = new CpuTracker();
    const row = (cpu: number) => ({ t: 0, r: [{ p: 7, pp: 1, ws: 10 * 1048576, pv: 4 * 1048576, cpu, st: '123' }] });
    const a = tr.convert({ ...row(0), t: 1000 });
    expect(a[0]).toMatchObject({ pid: 7, ppid: 1, workingSetMb: 10, privateMb: 4, cpuPct: 0, startTime: '123' });
    // 2.5 s of cpu (25_000_000 ticks) in 5 s wall = 50 %
    const b = tr.convert({ ...row(25_000_000), t: 6000 });
    expect(b[0]!.cpuPct).toBe(50);
  });
  it('the script quits when its parent is gone and embeds the interval', () => {
    const s = samplerScript(5000, 4242);
    expect(s).toContain('$parent = 4242');
    expect(s).toContain('Start-Sleep -Milliseconds 5000');
    expect(s).toContain('exit');
  });
});

describe('darwin sampler helpers (pure)', () => {
  it('parsePsSamples reads pid, ppid, rss(KiB), pcpu and lstart', () => {
    const out = '    1     0  10240  0.5 Sat Oct 10 08:00:00 2026\n  321     1   2048 12.3 Sun Oct 11 10:01:02 2026\n\n';
    const r = parsePsSamples(out);
    expect(r).toHaveLength(2);
    expect(r[1]).toEqual({ pid: 321, ppid: 1, workingSetMb: 2, privateMb: 2, cpuPct: 12.3, startTime: 'Sun Oct 11 10:01:02 2026' });
  });
});

describe.runIf(process.platform === 'win32')('win32 sampler (real PowerShell, Windows only)', () => {
  it('emits ticks that include this process, and kills the PowerShell child when the consumer stops', async () => {
    let child: ChildProcess | undefined;
    const sample = createWin({
      intervalMs: 400,
      spawnFn: (script) => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        child = spawn(`${process.env['SystemRoot']}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        return child;
      },
    });
    const ticks: ProcSample[][] = [];
    for await (const t of sample()) {
      ticks.push(t);
      if (ticks.length === 2) break;
    }
    const second = ticks[1]!;
    const me = second.find((s) => s.pid === process.pid);
    expect(me).toBeDefined();
    expect(me!.workingSetMb).toBeGreaterThan(5);
    expect(me!.privateMb).toBeGreaterThan(1);
    expect(me!.cpuPct).toBeGreaterThanOrEqual(0);
    expect(me!.ppid).toBe(process.ppid);
    expect(me!.startTime).toMatch(/^\d{17,18}$/);
    // consumer stopped: the child must be gone
    expect(child).toBeDefined();
    const end = Date.now() + 5000;
    while (child!.exitCode === null && child!.signalCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  }, 60_000);
});

describe.runIf(process.platform === 'darwin')('darwin sampler (real ps, macOS only)', () => {
  it('emits ticks that include this process', async () => {
    const sample = createMac({ intervalMs: 200 });
    for await (const t of sample()) {
      expect(t.find((s) => s.pid === process.pid)).toBeDefined();
      break;
    }
  });
});
