// Builds a temp CLAUDE_CONFIG_DIR for reconciler / transcript / fake-claude tests (plan section 9 "Fake CLAUDE_CONFIG_DIR harness").
// Layout:  <root>/projects/<enc(cwd)>/<sessionId>.jsonl
//          <root>/projects/<enc(cwd)>/<sessionId>/subagents/<agentId>.jsonl (+ .meta.json)
//          <root>/sessions/<pid>.json
// Tests assert `listing(root)` is identical before and after the code under test ran: the daemon must write nothing here.
import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectDirName } from '../packages/daemon/src/platform/common/project-dir.ts';
import { appendText, mkTmp, mkdirp, rmTree, writeText } from './tmp-fs.ts';

export type TranscriptRecord = Record<string, unknown>;

const VERSION = '2.1.292';

export function userRecord(text: string, o: { sessionId: string; cwd: string; parentUuid?: string | null; timestamp?: string; uuid?: string }): TranscriptRecord {
  return { parentUuid: o.parentUuid ?? null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid: o.uuid ?? randomUUID(), timestamp: o.timestamp ?? new Date().toISOString(), cwd: o.cwd, sessionId: o.sessionId, version: VERSION, userType: 'external' };
}
export function assistantRecord(text: string, o: { sessionId: string; cwd: string; parentUuid?: string | null; timestamp?: string; uuid?: string; stopReason?: string }): TranscriptRecord {
  return { parentUuid: o.parentUuid ?? null, isSidechain: false, type: 'assistant', message: { role: 'assistant', model: 'fake-model', content: [{ type: 'text', text }], stop_reason: o.stopReason ?? 'end_turn' }, uuid: o.uuid ?? randomUUID(), timestamp: o.timestamp ?? new Date().toISOString(), cwd: o.cwd, sessionId: o.sessionId, version: VERSION };
}
export function interruptRecord(o: { sessionId: string; cwd: string; parentUuid?: string | null; forTool?: boolean }): TranscriptRecord {
  return { parentUuid: o.parentUuid ?? null, isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'text', text: o.forTool ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }] }, uuid: randomUUID(), timestamp: new Date().toISOString(), cwd: o.cwd, sessionId: o.sessionId, version: VERSION };
}

export interface AddSessionOptions {
  cwd: string;
  sessionId?: string;
  /** Transcript records; strings are written verbatim (use for partial or corrupt lines). Default: one user + one assistant turn. */
  records?: (TranscriptRecord | string)[];
  /** Also write sessions/<pid>.json */
  pid?: number;
  status?: string;
  waitingFor?: string;
  name?: string;
  startedAt?: number;
}

export interface FakeHome {
  root: string;
  projectsDir: string;
  sessionsDir: string;
  projectDir(cwd: string): string;
  transcriptPath(cwd: string, sessionId: string): string;
  addSession(o: AddSessionOptions): { sessionId: string; transcriptPath: string; sessionFile?: string };
  addSessionFile(o: { pid: number; sessionId: string; cwd: string; status?: string; waitingFor?: string; name?: string; startedAt?: number; procStart?: string }): string;
  addSubagent(o: { cwd: string; sessionId: string; agentId: string; records?: (TranscriptRecord | string)[] }): string;
  appendToTranscript(cwd: string, sessionId: string, records: (TranscriptRecord | string)[]): void;
  cleanup(): void;
}

const lines = (records: (TranscriptRecord | string)[]): string => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r) + '\n')).join('');

export function createFakeClaudeHome(root: string = mkTmp('claude-home-')): FakeHome {
  const projectsDir = mkdirp(join(root, 'projects'));
  const sessionsDir = mkdirp(join(root, 'sessions'));
  const projectDir = (cwd: string): string => join(projectsDir, projectDirName(cwd));
  const transcriptPath = (cwd: string, id: string): string => join(projectDir(cwd), `${id}.jsonl`);

  const home: FakeHome = {
    root, projectsDir, sessionsDir, projectDir, transcriptPath,
    addSessionFile(o) {
      const now = Date.now();
      const file = join(sessionsDir, `${o.pid}.json`);
      writeText(file, JSON.stringify({
        pid: o.pid, sessionId: o.sessionId, cwd: o.cwd, startedAt: o.startedAt ?? now, ...(o.procStart ? { procStart: o.procStart } : {}), version: VERSION,
        kind: 'interactive', entrypoint: 'cli', ...(o.name ? { name: o.name } : {}), updatedAt: now, status: o.status ?? 'idle', statusUpdatedAt: now,
        ...(o.waitingFor ? { waitingFor: o.waitingFor } : {}),
      }));
      return file;
    },
    addSession(o) {
      const sessionId = o.sessionId ?? randomUUID();
      const file = transcriptPath(o.cwd, sessionId);
      const u = userRecord('hello', { sessionId, cwd: o.cwd });
      const records = o.records ?? [u, assistantRecord('hi there', { sessionId, cwd: o.cwd, parentUuid: u['uuid'] as string })];
      writeText(file, lines(records));
      const sessionFile = o.pid !== undefined
        ? home.addSessionFile({ pid: o.pid, sessionId, cwd: o.cwd, ...(o.status ? { status: o.status } : {}), ...(o.waitingFor ? { waitingFor: o.waitingFor } : {}), ...(o.name ? { name: o.name } : {}), ...(o.startedAt ? { startedAt: o.startedAt } : {}) })
        : undefined;
      return { sessionId, transcriptPath: file, ...(sessionFile ? { sessionFile } : {}) };
    },
    addSubagent(o) {
      const dir = join(projectDir(o.cwd), o.sessionId, 'subagents');
      const file = join(dir, `${o.agentId}.jsonl`);
      const recs = o.records ?? [{ ...userRecord('subagent task', { sessionId: o.sessionId, cwd: o.cwd }), isSidechain: true, agentId: o.agentId }];
      writeText(file, lines(recs));
      writeText(join(dir, `${o.agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose' }));
      return file;
    },
    appendToTranscript(cwd, id, records) {
      appendText(transcriptPath(cwd, id), lines(records));
    },
    cleanup() { rmTree(root); },
  };
  return home;
}

/**
 * Deterministic recursive listing: "<kind> <relative/path> <size> <mtimeMs>" per entry, sorted. Equal listings before and
 * after mean nothing was created, removed, resized or touched.
 */
export function listing(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = relative(root, p).split(sep).join('/');
      if (st.isDirectory()) { out.push(`d ${rel}`); walk(p); } else out.push(`f ${rel} ${st.size} ${Math.trunc(st.mtimeMs)}`);
    }
  };
  walk(root);
  return out;
}
