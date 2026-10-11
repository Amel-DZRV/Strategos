// Test harness for the hooks lane: the REAL server, receiver, registry and reducer wired together, with an in-memory
// session map standing in for the session manager. Not imported by product code.
import type { Effect, MachineInput, SessionRecord } from '@strategos/shared';
import { reduce } from '../sessions/state-machine.ts';
import { makeSession } from '../sessions/state-machine.testkit.ts';
import { createStrategosServer, type StrategosServer } from '../server/http.ts';
import { createAuditLog, type AuditLog } from '../store/audit-log.ts';
import { makeTestEnv, type TestEnv } from '../store/testing.ts';
import { createStatusLineHandler } from '../statusline/ingest.ts';
import { createPendingRegistry, type PendingRegistry } from './pending.ts';
import { createHookReceiver, type GuardVerdict, type HookReceiver } from './receiver.ts';

export interface Harness {
  env: TestEnv;
  server: StrategosServer;
  registry: PendingRegistry;
  receiver: HookReceiver;
  audit: AuditLog;
  sessions: Map<string, SessionRecord>;
  tokens: Map<string, string>;
  /** Every effect any dispatch produced, in order. */
  effects: Effect[];
  errors: { err: unknown; where: string }[];
  guards: { fn: (sid: string, tool: string, input: unknown) => GuardVerdict };
  usage: unknown[];
  addSession(sid: string, over?: Partial<SessionRecord>): { sid: string; token: string };
  dispatch(sid: string, input: MachineInput): Effect[];
  get(sid: string): SessionRecord;
  /** Poll until `pred` holds. */
  until(pred: () => boolean, ms?: number, what?: string): Promise<void>;
  close(): Promise<void>;
}

export async function makeHarness(o: { holdTimeoutSec?: number; releaseMarginSec?: number } = {}): Promise<Harness> {
  const env = await makeTestEnv();
  const audit = createAuditLog({ fs: env.fs, dir: env.home });
  const sessions = new Map<string, SessionRecord>();
  const tokens = new Map<string, string>();
  const effects: Effect[] = [];
  const errors: Harness['errors'] = [];
  const usage: unknown[] = [];
  const guards: Harness['guards'] = { fn: () => ({ deny: false }) };

  const dispatch = (sid: string, input: MachineInput): Effect[] => {
    const s = sessions.get(sid);
    if (s === undefined) return [];
    const r = reduce(s, input, Date.now());
    sessions.set(sid, r.next);
    effects.push(...r.effects);
    return r.effects;
  };
  const registry = createPendingRegistry({
    dispatch, audit, onError: (err) => errors.push({ err, where: 'registry' }),
    ...(o.holdTimeoutSec === undefined ? {} : { holdTimeoutSec: o.holdTimeoutSec }),
    ...(o.releaseMarginSec === undefined ? {} : { releaseMarginSec: o.releaseMarginSec }),
  });
  const receiver = createHookReceiver({
    registry, dispatch, audit,
    checkGuards: (sid, ev) => guards.fn(sid, ev.tool_name ?? '', ev.tool_input),
    onError: (err, where) => errors.push({ err, where }),
  });
  const server = createStrategosServer({ port: 0, tokenFor: (sid) => tokens.get(sid) });
  server.setHookHandler(receiver.handle);
  server.setStatusLineHandler(createStatusLineHandler({ dispatch, onUsage: (_sid, u) => usage.push(u) }));
  await server.listen();

  return {
    env, server, registry, receiver, audit, sessions, tokens, effects, errors, guards, usage, dispatch,
    addSession(sid, over = {}) {
      const token = `tok-${sid}`;
      tokens.set(sid, token);
      sessions.set(sid, makeSession({
        strategosId: sid, status: 'starting', statusSource: 'user', claudeSessionIds: [], currentSessionId: '',
        transcriptPath: undefined, lastActivityAt: Date.now(), ...over,
      }));
      return { sid, token };
    },
    get(sid) {
      const s = sessions.get(sid);
      if (s === undefined) throw new Error(`no session ${sid}`);
      return s;
    },
    async until(pred, ms = 45_000, what = 'condition') {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async close() {
      registry.releaseAll();
      await server.close();
      await audit.idle();
      await env.cleanup();
    },
  };
}
