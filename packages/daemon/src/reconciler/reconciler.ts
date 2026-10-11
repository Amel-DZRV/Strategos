// Reconciler (plan section 4.1, source R and T of section 6). Read-only: it looks at Claude's own files and
// `claude agents --json` and turns what it sees into reducer inputs. It never decides a status itself, and it
// never writes: the state machine applies rules 1 and 2 (inference never clears a pending request, and waits
// 10 s after the last hook).
//
//   tick()            -> Observation[]  from <config>/sessions/*.json (every 3 s) plus the agents CLI (start, 60 s)
//   onDemand(id)      -> Observation | null  forces the agents CLI for one session
//   inferTranscripts()-> level-triggered 'transcript' inputs from the tail of each session's transcript
//   start(...)        -> schedules the two on a timer
//
// open_elsewhere (section 6): an Observation whose Claude id is one of ours, alive, with `ownedByUs: false`. The
// reducer turns that into `open_elsewhere` when the record has no process of its own.

import { stat } from 'node:fs/promises';
import type { MachineInput, Observation } from '@strategos/shared';
import { jsonLines, readTail } from '../transcript/fsutil.ts';
import { classifyTail, type TailVerdict } from '../transcript/parse.ts';
import { type AgentRow, type ExecFn, rowToObservation, runAgentsCli } from './agents-cli.ts';
import { type SessionFile, readSessionsDir } from './sessions-dir.ts';

export interface Reconciler {
  tick(): Promise<Observation[]>;
  onDemand(strategosId: string): Promise<Observation | null>;
}

/** The facts about one of our sessions that the reconciler needs. */
export interface TrackedSession {
  strategosId: string;
  claudeSessionIds: readonly string[];
  currentSessionId: string;
  transcriptPath?: string;
  /** Pid of the process we spawned for it, if any. */
  ptyPid?: number;
  /** False once the record is stopped, parked or open_elsewhere: no transcript inference then. */
  live: boolean;
}

export interface ReconcilerDeps {
  claudeConfigDir: string;
  sessions(): readonly TrackedSession[];
  /** platform.proc.isAlive */
  isAlive(pid: number, procStart?: string): Promise<boolean>;
  /** True if `pid` is a descendant of `ancestorPid` (a shim in front of claude.exe). Optional. */
  isDescendant?(pid: number, ancestorPid: number): Promise<boolean>;
  /** For the agents CLI. Both must be given to enable it. */
  exec?: ExecFn;
  claudeExe?: string;
  agentsIntervalMs?: number;
  now?(): number;
  onError?(err: unknown): void;
}

export interface TranscriptInference {
  strategosId: string;
  input: Extract<MachineInput, { k: 'transcript' }>;
}

const TAIL_BYTES = 256 * 1024;
const TAIL_BYTES_RETRY = 4 * 1024 * 1024;

export class FileReconciler implements Reconciler {
  readonly #d: ReconcilerDeps;
  #lastAgentsAt: number | undefined;
  #agentRows: AgentRow[] = [];
  readonly #verdicts = new Map<string, { mtimeMs: number; size: number; verdict: TailVerdict | undefined }>();

  constructor(deps: ReconcilerDeps) {
    this.#d = deps;
  }

  #now(): number {
    return this.#d.now ? this.#d.now() : Date.now();
  }

  #find(tracked: readonly TrackedSession[], claudeSessionId: string, pid?: number): TrackedSession | undefined {
    return (
      tracked.find((t) => t.currentSessionId === claudeSessionId) ??
      tracked.find((t) => t.claudeSessionIds.includes(claudeSessionId)) ??
      (pid === undefined ? undefined : tracked.find((t) => t.ptyPid === pid))
    );
  }

  async #owned(t: TrackedSession | undefined, pid: number): Promise<boolean> {
    if (t?.ptyPid === undefined) return false;
    if (t.ptyPid === pid) return true;
    return this.#d.isDescendant ? this.#d.isDescendant(pid, t.ptyPid) : false;
  }

  async #fromFile(f: SessionFile, tracked: readonly TrackedSession[]): Promise<Observation | null> {
    const t = this.#find(tracked, f.sessionId, f.pid);
    if (t === undefined) return null; // not one of ours
    return {
      strategosId: t.strategosId,
      claudeSessionId: f.sessionId,
      pid: f.pid,
      procStart: f.procStart,
      alive: await this.#d.isAlive(f.pid, f.procStart),
      ownedByUs: await this.#owned(t, f.pid),
      status: f.status,
      waitingFor: f.waitingFor,
      statusUpdatedAt: f.statusUpdatedAt,
      source: 'sessions_dir',
    };
  }

  async #fromRow(row: AgentRow, tracked: readonly TrackedSession[]): Promise<Observation | null> {
    const t = this.#find(tracked, row.sessionId, row.pid);
    if (t === undefined) return null;
    const alive = row.pid === undefined ? true : await this.#d.isAlive(row.pid);
    const ownedByUs = row.pid === undefined ? false : await this.#owned(t, row.pid);
    return rowToObservation(row, { alive, ownedByUs, strategosId: t.strategosId });
  }

  async #refreshAgents(force: boolean): Promise<void> {
    const { exec, claudeExe } = this.#d;
    if (exec === undefined || claudeExe === undefined) return;
    const now = this.#now();
    const every = this.#d.agentsIntervalMs ?? 60_000;
    if (!force && this.#lastAgentsAt !== undefined && now - this.#lastAgentsAt < every) return;
    this.#lastAgentsAt = now;
    const rows = await runAgentsCli(exec, claudeExe);
    if (rows !== null) this.#agentRows = rows; // a failed run keeps the last good answer
  }

  async tick(): Promise<Observation[]> {
    const tracked = this.#d.sessions();
    const ranAgents = this.#lastAgentsAt;
    await this.#refreshAgents(false);
    const fresh = this.#lastAgentsAt !== ranAgents;
    const out: Observation[] = [];
    const byId = new Map<string, Observation>();
    for (const f of await readSessionsDir(this.#d.claudeConfigDir)) {
      const o = await this.#fromFile(f, tracked);
      if (o) {
        out.push(o);
        byId.set(o.claudeSessionId, o);
      }
    }
    if (fresh) {
      // The CLI is the second opinion: report it where the folder is silent or says something different.
      for (const row of this.#agentRows) {
        const o = await this.#fromRow(row, tracked);
        const mine = o ? byId.get(o.claudeSessionId) : undefined;
        if (o && (mine === undefined || mine.status !== o.status || mine.waitingFor !== o.waitingFor)) out.push(o);
      }
    }
    return out;
  }

  async onDemand(strategosId: string): Promise<Observation | null> {
    const tracked = this.#d.sessions();
    const t = tracked.find((x) => x.strategosId === strategosId);
    if (t === undefined) return null;
    await this.#refreshAgents(true);
    const row = this.#agentRows.find((r) => r.sessionId === t.currentSessionId);
    if (row) return this.#fromRow(row, tracked);
    for (const f of await readSessionsDir(this.#d.claudeConfigDir)) {
      if (f.sessionId === t.currentSessionId) return this.#fromFile(f, tracked);
    }
    return null;
  }

  /**
   * One 'transcript' reducer input per live session whose transcript ends in a decisive record. Level-triggered: the
   * same verdict is returned every call until the file changes, because the reducer drops inferences made less than
   * 10 s after a hook and relies on seeing them again.
   */
  async inferTranscripts(): Promise<TranscriptInference[]> {
    const out: TranscriptInference[] = [];
    for (const t of this.#d.sessions()) {
      if (!t.live || t.transcriptPath === undefined) continue;
      try {
        const st = await stat(t.transcriptPath);
        const hit = this.#verdicts.get(t.transcriptPath);
        let verdict: TailVerdict | undefined;
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
          verdict = hit.verdict;
        } else {
          verdict = classifyTail(jsonLines(await readTail(t.transcriptPath, TAIL_BYTES)));
          if (verdict === undefined && st.size > TAIL_BYTES) {
            verdict = classifyTail(jsonLines(await readTail(t.transcriptPath, TAIL_BYTES_RETRY)));
          }
          this.#verdicts.set(t.transcriptPath, { mtimeMs: st.mtimeMs, size: st.size, verdict });
        }
        if (verdict) {
          out.push({
            strategosId: t.strategosId,
            input: { k: 'transcript', signal: verdict.signal, lastIsQuestion: verdict.lastIsQuestion, at: verdict.at },
          });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.#d.onError?.(err);
      }
    }
    return out;
  }

  /** Poll on a timer (default every 3 s) and hand results to the session manager. Returns a stop function. */
  start(
    handlers: {
      onObservation(o: Observation): void;
      onTranscript(i: TranscriptInference): void;
    },
    intervalMs = 3000,
  ): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const loop = async (): Promise<void> => {
      try {
        const observations = await this.tick();
        const inferences = await this.inferTranscripts();
        if (stopped) return; // stop() was called while we were reading
        for (const o of observations) handlers.onObservation(o);
        for (const i of inferences) handlers.onTranscript(i);
      } catch (err) {
        this.#d.onError?.(err);
      }
      if (!stopped) {
        timer = setTimeout(() => void loop(), intervalMs);
        timer.unref();
      }
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}
