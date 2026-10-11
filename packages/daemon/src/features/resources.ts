// Resource view (task 8.02, risk R11): memory and CPU of every live session's process TREE (the pty's pid and all of its
// descendants), written to SessionRecord.resource, plus one daemon-wide total published as `{ t: 'resources' }`.
//
// The sampler (platform.proc.sample) is one persistent PowerShell loop on Windows (about 89 MB, one `ps` per tick on
// macOS). It runs only while at least one session has a process; with none, the iterator is returned, which kills the
// child. Starting and stopping follows `manager.onChange`.
import type { ProcSample, SessionRecord } from '@strategos/shared';
import type { Platform } from '../platform/index.ts';

export interface ResourceMonitorDeps {
  platform: Pick<Platform, 'proc'>;
  manager: {
    list(): SessionRecord[];
    update(id: string, p: Partial<SessionRecord>): SessionRecord | undefined;
    onChange(cb: (s: SessionRecord) => void): () => void;
  };
  hub: { publish(ev: { t: 'resources'; totalMb: number; cpuPct: number }): void };
  onError?: (what: string, err: unknown) => void;
  now?: () => number;
}

export interface ResourceMonitor {
  /** Start following the manager. Sampling begins when the first session has a process. */
  start(): void;
  /** Stop following and stop sampling. */
  stop(): void;
  /** Whether the sampler is running right now. */
  readonly sampling: boolean;
  /** The latest published total. */
  readonly total: { totalMb: number; cpuPct: number };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** pid + descendants of `root` in one sample. A cycle or absurd depth (pid reuse in the snapshot) cannot loop forever. */
export function processTree(root: number, samples: readonly ProcSample[]): ProcSample[] {
  const byParent = new Map<number, ProcSample[]>();
  const byPid = new Map<number, ProcSample>();
  for (const s of samples) {
    byPid.set(s.pid, s);
    const list = byParent.get(s.ppid);
    if (list === undefined) byParent.set(s.ppid, [s]);
    else list.push(s);
  }
  const rootSample = byPid.get(root);
  if (rootSample === undefined) return [];
  const out: ProcSample[] = [];
  const seen = new Set<number>([root]);
  const queue: ProcSample[] = [rootSample];
  while (queue.length > 0 && out.length < 4096) {
    const cur = queue.shift()!;
    out.push(cur);
    for (const child of byParent.get(cur.pid) ?? []) {
      if (seen.has(child.pid) || child.pid === cur.pid) continue;
      seen.add(child.pid);
      queue.push(child);
    }
  }
  return out;
}

export function sumTree(tree: readonly ProcSample[]): { workingSetMb: number; privateMb: number; cpuPct: number } {
  let ws = 0;
  let pv = 0;
  let cpu = 0;
  for (const p of tree) { ws += p.workingSetMb; pv += p.privateMb; cpu += p.cpuPct; }
  return { workingSetMb: round1(ws), privateMb: round1(pv), cpuPct: round1(cpu) };
}

export function createResourceMonitor(deps: ResourceMonitorDeps): ResourceMonitor {
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? (() => undefined);
  let unsub: (() => void) | undefined;
  let it: AsyncIterator<ProcSample[]> | undefined; // set while the sampler runs
  let gen = 0; // bumped on every start and stop: a late sample of an older run is ignored
  let total = { totalMb: 0, cpuPct: 0 };
  let published = false;

  const live = (): SessionRecord[] => deps.manager.list().filter((s) => s.pty !== undefined);

  function apply(samples: ProcSample[]): void {
    const t = now();
    let totalMb = 0;
    let cpuPct = 0;
    for (const s of live()) {
      const pid = s.pty!.pid;
      const tree = processTree(pid, samples);
      if (tree.length === 0) continue;
      const sum = sumTree(tree);
      totalMb += sum.workingSetMb;
      cpuPct += sum.cpuPct;
      deps.manager.update(s.strategosId, {
        resource: { pid, procStart: tree[0]!.startTime ?? '', treeWorkingSetMb: sum.workingSetMb, treePrivateMb: sum.privateMb, cpuPct: sum.cpuPct, at: t },
      });
    }
    total = { totalMb: round1(totalMb), cpuPct: round1(cpuPct) };
    published = true;
    deps.hub.publish({ t: 'resources', ...total });
  }

  async function loop(iter: AsyncIterator<ProcSample[]>, mine: number): Promise<void> {
    try {
      for (;;) {
        const r = await iter.next();
        if (r.done === true || mine !== gen) break;
        apply(r.value);
      }
    } catch (err) {
      if (mine === gen) onError('resource sampler', err);
    } finally {
      if (mine === gen) it = undefined; // the sampler ended by itself; the next change starts it again
      void Promise.resolve(iter.return?.(undefined)).catch(() => undefined);
    }
  }

  function startSampling(): void {
    if (it !== undefined) return;
    const iter = deps.platform.proc.sample()[Symbol.asyncIterator]();
    it = iter;
    void loop(iter, ++gen);
  }

  function stopSampling(): void {
    gen++;
    const iter = it;
    it = undefined;
    void Promise.resolve(iter?.return?.(undefined)).catch(() => undefined); // the sampler kills its PowerShell child
    for (const s of deps.manager.list()) if (s.resource !== undefined) deps.manager.update(s.strategosId, { resource: undefined });
    if (published && (total.totalMb !== 0 || total.cpuPct !== 0)) {
      total = { totalMb: 0, cpuPct: 0 };
      deps.hub.publish({ t: 'resources', ...total });
    }
  }

  function reconcile(): void {
    if (live().length > 0) startSampling();
    else if (it !== undefined) stopSampling();
  }

  return {
    start() {
      if (unsub !== undefined) return;
      unsub = deps.manager.onChange(() => { reconcile(); });
      reconcile();
    },
    stop() {
      unsub?.();
      unsub = undefined;
      if (it !== undefined) stopSampling();
    },
    get sampling() { return it !== undefined; },
    get total() { return total; },
  };
}
