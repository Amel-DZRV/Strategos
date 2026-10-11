import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ProcSample } from '../types.ts';

/** One raw row as the PowerShell loop prints it. cpu is kernel+user time in 100 ns units; st is a FILETIME string. */
export interface RawRow { p: number; pp: number; ws: number; pv: number; cpu: number; st: string }
export interface RawTick { t: number; r: RawRow[] }

export function parseTickLine(line: string): RawTick | null {
  try {
    const o = JSON.parse(line) as { t?: unknown; r?: unknown };
    if (typeof o.t !== 'number' || !Array.isArray(o.r)) return null;
    return { t: o.t, r: o.r as RawRow[] };
  } catch { return null; }
}

/** Turns raw ticks into ProcSamples. cpuPct is percent of ONE core (can exceed 100); the first tick reports 0. */
export class CpuTracker {
  private prev = new Map<number, { cpu: number; t: number }>();
  convert(tick: RawTick): ProcSample[] {
    const next = new Map<number, { cpu: number; t: number }>();
    const out: ProcSample[] = [];
    for (const r of tick.r) {
      if (typeof r.p !== 'number') continue;
      const before = this.prev.get(r.p);
      let cpuPct = 0;
      if (before && tick.t > before.t && r.cpu >= before.cpu) cpuPct = ((r.cpu - before.cpu) / 1e4 / (tick.t - before.t)) * 100;
      next.set(r.p, { cpu: r.cpu, t: tick.t });
      out.push({
        pid: r.p, ppid: r.pp,
        workingSetMb: Math.round((r.ws / 1048576) * 10) / 10,
        privateMb: Math.round((r.pv / 1048576) * 10) / 10,
        cpuPct: Math.round(cpuPct * 10) / 10,
        startTime: r.st,
      });
    }
    this.prev = next;
    return out;
  }
}

export function samplerScript(intervalMs: number, parentPid: number): string {
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$parent = ${Math.trunc(parentPid)}`,
    `while ($true) {`,
    `  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }`, // never outlive the daemon
    `  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()`,
    `  $rows = @(Get-CimInstance Win32_Process | ForEach-Object {`,
    `    [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; ws = [double]$_.WorkingSetSize; pv = [double]$_.PrivatePageCount;`,
    `      cpu = [double]($_.KernelModeTime + $_.UserModeTime); st = [string]$_.CreationDate.ToFileTimeUtc() } })`,
    `  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject @{ t = $t; r = $rows }))`,
    `  [Console]::Out.Flush()`,
    `  Start-Sleep -Milliseconds ${Math.trunc(intervalMs)}`,
    `}`,
  ].join('\n');
}

export interface SamplerOptions { intervalMs?: number; spawnFn?: (script: string) => ChildProcess }

/** A persistent PowerShell loop per iterator. Breaking out of `for await` (or calling return()) kills the child. */
export function createSampler(opts: SamplerOptions = {}): () => AsyncIterable<ProcSample[]> {
  const intervalMs = opts.intervalMs ?? 5000;
  const spawnFn = opts.spawnFn ?? ((script: string) => {
    const psExe = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return spawn(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  });
  return () => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<ProcSample[]> {
      const child = spawnFn(samplerScript(intervalMs, process.pid));
      const tracker = new CpuTracker();
      let latest: ProcSample[] | null = null;
      let ended = false;
      let wake: (() => void) | null = null;
      const poke = (): void => { const w = wake; wake = null; w?.(); };
      const rl = createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        const tick = parseTickLine(line);
        if (!tick) return;
        latest = tracker.convert(tick); // keep only the newest: a slow consumer must not make memory grow
        poke();
      });
      child.on('exit', () => { ended = true; poke(); });
      child.on('error', () => { ended = true; poke(); });
      try {
        for (;;) {
          if (latest) { const out: ProcSample[] = latest; latest = null; yield out; continue; }
          if (ended) return;
          await new Promise<void>((r) => { wake = r; });
        }
      } finally {
        rl.close();
        if (child.exitCode === null) child.kill();
      }
    },
  });
}
