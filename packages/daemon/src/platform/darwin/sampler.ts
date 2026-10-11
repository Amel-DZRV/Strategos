import type { ProcSample } from '../types.ts';
import { run } from '../common/exec.ts';

/**
 * Parse `ps -A -o pid=,ppid=,rss=,pcpu=,lstart=`. rss is in KiB. macOS has no cheap "private bytes" figure, so privateMb
 * repeats rss (TODO: refine with `footprint`/`vmmap` if the resource panel needs it). pcpu is ps's own figure (percent of one core).
 */
export function parsePsSamples(out: string): ProcSample[] {
  const res: ProcSample[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const mb = Math.round((Number(m[3]) / 1024) * 10) / 10;
    res.push({ pid: Number(m[1]), ppid: Number(m[2]), workingSetMb: mb, privateMb: mb, cpuPct: Number(m[4]), startTime: m[5]!.replace(/\s+/g, ' ') });
  }
  return res;
}

export function createSampler(opts: { intervalMs?: number } = {}): () => AsyncIterable<ProcSample[]> {
  const intervalMs = opts.intervalMs ?? 5000;
  return () => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<ProcSample[]> {
      for (;;) {
        const r = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,rss=,pcpu=,lstart='], { timeoutMs: 10_000 });
        yield parsePsSamples(r.stdout);
        await new Promise((res) => setTimeout(res, intervalMs));
      }
    },
  });
}
