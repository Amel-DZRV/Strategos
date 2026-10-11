// Test rig for the daemon end-to-end tests: a real daemon (real server, real node-pty) whose `claude` is
// `node tools/fake-claude.ts`, a fake CLAUDE_CONFIG_DIR, and a WebSocket client that behaves like the UI. Not product code.
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { DaemonEvent, SessionRecord, Status, UiCommand } from '@strategos/shared';
import { createFakeClaudeHome, type FakeHome } from '../../../tools/fake-claude-home.ts';
import { mkTmp, rmTree } from '../../../tools/tmp-fs.ts';
import { defaultConfig } from './config.ts';
import { startDaemon, type Daemon, type DaemonOptions } from './daemon.ts';
import type { SafeFs } from './safe-fs.ts';
import { originOf, pairCookie } from './server/testkit.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FAKE_CLAUDE = path.join(ROOT, 'tools', 'fake-claude.ts');

export const FAST_TIMING = {
  readyFallbackMs: 3000, readySettleMs: 20, pasteDelayMs: 40, stopGapMs: 120, stopGraceMs: 4000, tickMs: 200, reconcileMs: 400,
} as const;

export interface Rig {
  root: string;
  home: string;
  claudeHome: FakeHome;
  repo: string;
  env: Record<string, string | undefined>;
  daemon: Daemon;
  /** First argument of every safe-fs call the daemon made. */
  writes: string[];
  clients: UiClient[];
  ui(): Promise<UiClient>;
  close(): Promise<void>;
}

export function makeRepo(name = 'sandbox-repo'): string {
  const dir = path.join(mkTmp('strategos-repo-'), name);
  execFileSync('git', ['init', '-q', dir], { windowsHide: true });
  return dir;
}

function recordingFs(writes: string[]): (fs: SafeFs) => SafeFs {
  return (fs) => new Proxy(fs, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function' || prop === 'check') return v;
      return (...args: unknown[]) => {
        if (typeof args[0] === 'string') writes.push(args[0]);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export async function startRig(o: { home?: string; claudeHome?: FakeHome; repo?: string; daemon?: Partial<DaemonOptions>; env?: Record<string, string | undefined> } = {}): Promise<Rig> {
  const root = mkTmp('strategos-e2e-');
  const home = o.home ?? path.join(root, 'strategos-home');
  const claudeHome = o.claudeHome ?? createFakeClaudeHome(path.join(root, 'claude-home'));
  const repo = o.repo ?? makeRepo();
  const env: Record<string, string | undefined> = {
    ...process.env, CLAUDE_CONFIG_DIR: claudeHome.root, FAKE_CLAUDE_STEP_MS: '5', ...(o.env ?? {}),
  };
  const writes: string[] = [];
  const daemon = await startDaemon({
    home, env, claudeConfigDir: claudeHome.root, config: defaultConfig(0),
    claude: { exe: process.execPath, prefixArgs: [FAKE_CLAUDE], version: '2.1.292' },
    staticDir: null, timing: FAST_TIMING, wrapFs: recordingFs(writes), ...(o.daemon ?? {}),
  });
  const clients: UiClient[] = [];
  const rig: Rig = {
    root, home, claudeHome, repo, env, daemon, writes, clients,
    async ui() {
      const c = await UiClient.connect(daemon);
      clients.push(c);
      return c;
    },
    async close() {
      for (const c of clients) c.close();
      await daemon.shutdown();
      rmTree(root);
    },
  };
  return rig;
}

export class UiClient {
  readonly sessions = new Map<string, SessionRecord>();
  readonly events: DaemonEvent[] = [];
  hello: Extract<DaemonEvent, { t: 'hello' }> | undefined;
  snapshot: Extract<DaemonEvent, { t: 'snapshot' }> | undefined;
  private n = 0;
  private acks = new Map<string, (a: { ok: boolean; error?: string }) => void>();
  readonly ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (d) => {
      const ev = JSON.parse(d.toString()) as DaemonEvent;
      this.events.push(ev);
      if (ev.t === 'hello') this.hello = ev;
      else if (ev.t === 'snapshot') {
        this.snapshot = ev;
        this.sessions.clear();
        for (const s of ev.sessions) this.sessions.set(s.strategosId, s);
      } else if (ev.t === 'session.upsert') this.sessions.set(ev.session.strategosId, ev.session);
      else if (ev.t === 'session.removed') this.sessions.delete(ev.strategosId);
      else if (ev.t === 'ack') this.acks.get(ev.id)?.({ ok: ev.ok, ...(ev.error === undefined ? {} : { error: ev.error }) });
    });
  }

  static async connect(d: Daemon): Promise<UiClient> {
    const cookie = await pairCookie(d.server);
    const ws = new WebSocket(`ws://127.0.0.1:${d.server.port}/ws`, { headers: { Origin: originOf(d.server), Cookie: cookie } });
    const c = new UiClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await c.until(() => c.snapshot !== undefined, 15_000, 'snapshot');
    return c;
  }

  /** Send a command and wait for its ack. */
  cmd(c: DistributiveOmit<UiCommand, 'id'>, timeoutMs = 45_000): Promise<{ ok: boolean; error?: string }> {
    const id = `t${++this.n}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for ${c.c}`)), timeoutMs);
      this.acks.set(id, (a) => { clearTimeout(timer); this.acks.delete(id); resolve(a); });
      this.ws.send(JSON.stringify({ ...c, id }));
    });
  }

  async until(pred: () => boolean, ms = 45_000, what = 'condition'): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  byName(name: string): SessionRecord {
    const s = [...this.sessions.values()].find((x) => x.name === name);
    if (s === undefined) throw new Error(`no session named ${name}; have ${[...this.sessions.values()].map((x) => x.name).join(', ')}`);
    return s;
  }

  /** Start a session and return its record (as first published). */
  async start(name: string, repo: string, firstPrompt?: string, extra: Record<string, unknown> = {}): Promise<SessionRecord> {
    const a = await this.cmd({ c: 'session.start', repoPath: repo, name, ...(firstPrompt === undefined ? {} : { firstPrompt }), ...extra } as never);
    if (!a.ok) throw new Error(`session.start: ${a.error ?? '?'}`);
    await this.until(() => [...this.sessions.values()].some((s) => s.name === name), 5000, `session ${name} to appear`);
    return this.byName(name);
  }

  async waitStatus(id: string, status: Status | Status[], ms = 20_000): Promise<SessionRecord> {
    const want = Array.isArray(status) ? status : [status];
    await this.until(() => { const s = this.sessions.get(id); return s !== undefined && want.includes(s.status); }, ms, `${want.join('|')} for ${id}; now ${this.sessions.get(id)?.status ?? 'missing'}`);
    return this.sessions.get(id)!;
  }

  of(id: string): SessionRecord {
    const s = this.sessions.get(id);
    if (s === undefined) throw new Error(`no session ${id}`);
    return s;
  }

  close(): void {
    this.ws.close();
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
