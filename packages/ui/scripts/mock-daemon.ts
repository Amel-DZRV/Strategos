// A stand-in daemon for UI development: speaks protocol v1 (hello, snapshot(seq), deltas, acks, pty channel) with fake
// sessions, one of them waiting on a permission. Run: npm run mock -w @strategos/ui   (see packages/ui/README.md)
//
// It does NOT enforce Origin or real pairing: any code at POST /api/pair gets a cookie. It exists to see the UI move.
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DaemonEvent, SessionRecord, Status, UiPrefs } from '@strategos/shared';

const PORT = Number(process.env['MOCK_PORT'] ?? 47800);
const COOKIE = 'strategos_session=mock-session';

const prefs: UiPrefs = {
  groupBy: 'repo',
  notifications: { enabled: true, sound: true, onPermission: true, onQuestion: true, onErrored: true, onDone: false, escalate: true },
  keymap: {},
};

const t0 = Date.now();
const min = 60_000;

function rec(o: Partial<SessionRecord> & { strategosId: string; displayName: string; repo: string; status: Status }): SessionRecord {
  const { repo, ...rest } = o as Partial<SessionRecord> & { repo: string };
  return {
    schema: 1, name: o.displayName, claudeSessionIds: ['c-' + o.strategosId], currentSessionId: 'c-' + o.strategosId,
    transcriptOffset: 0, repoRoot: `C:\\dev\\${repo}`, planetKey: repo, cwd: `C:\\dev\\${repo}`,
    launch: { addDirs: [], extraArgs: [] }, statusSource: 'hook', statusSince: t0 - 5 * min, ringSlot: 0, ringSlotByGroup: {},
    cost: { lineageUsd: 0, byClaudeSession: {} },
    flags: { conflicts: [], contractChanged: [], guardDenials: 0 }, subagents: [],
    createdAt: t0 - 60 * min, updatedAt: t0, lastActivityAt: t0, archived: false, view: 'term',
    ...rest,
  } as SessionRecord;
}

const sessions = new Map<string, SessionRecord>();
for (const s of [
  rec({
    strategosId: 's1', displayName: 'Wire the ConPTY host', repo: 'strategos-app', branch: 'feat/pty-host', status: 'permission',
    waitingSince: t0 - 2 * min, ctx: { pct: 71, at: t0, source: 'statusline' }, cost: { lineageUsd: 3.42, byClaudeSession: {} },
    last: 'I need to build to check the PTY bindings compile.',
    pending: {
      requestId: 'r1', kind: 'permission', held: true, toolName: 'Bash', inputSummary: 'cargo build --release', inputTruncated: false,
      risk: ['run'], suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cargo build:*' }], behavior: 'allow', destination: 'localSettings' }],
      since: t0 - 2 * min,
    },
  }),
  rec({
    strategosId: 's2', displayName: 'Onboarding flow', repo: 'mobile-app', branch: 'feat/onboarding', status: 'permission',
    waitingSince: t0 - 14 * min, ctx: { pct: 88, at: t0, source: 'statusline' }, cost: { lineageUsd: 5.6, byClaudeSession: {} },
    last: 'The animation needs react-native-reanimated.',
    pending: {
      requestId: 'r2', kind: 'permission', held: true, toolName: 'Bash', inputTruncated: true, risk: ['network', 'run'], since: t0 - 14 * min,
      inputSummary: 'npm install react-native-reanimated react-native-gesture-handler react-native-screens react-native-safe-area-context && npx pod-install ios && node scripts/postinstall-native-config.js --platform ios --platform android --verbose --force --write-lockfile --ignore-engines',
    },
  }),
  rec({
    strategosId: 's3', displayName: 'Rate limit middleware', repo: 'api-gateway', branch: 'feat/rate-limit', status: 'question',
    waitingSince: t0 - 4 * min, ctx: { pct: 63, at: t0, source: 'statusline' }, cost: { lineageUsd: 2.15, byClaudeSession: {} },
    last: 'Should the limit apply per API key or per IP address?',
    pending: {
      requestId: 'r3', kind: 'question', held: true, toolName: 'AskUserQuestion', inputSummary: 'Per API key or per IP?', inputTruncated: false, risk: [], since: t0 - 4 * min,
      questions: [{ question: 'Should the limit apply per API key or per IP address?', header: 'Scope', options: [{ label: 'Per API key', description: 'Fairer for shared offices' }, { label: 'Per IP address', description: 'Simpler, blocks anonymous floods' }] }],
    },
  }),
  rec({
    strategosId: 's4', displayName: 'Fix hook race', repo: 'strategos-app', branch: 'fix/hook-race', status: 'working',
    ctx: { pct: 38, at: t0, source: 'statusline' }, cost: { lineageUsd: 1.1, byClaudeSession: {} },
    now: { tool: 'Edit', summary: 'src/hooks.rs', since: t0 }, last: 'Switching the status writer to atomic renames.',
  }),
  rec({
    strategosId: 's5', displayName: 'Search page', repo: 'docs-site', branch: 'feat/search', status: 'working',
    ctx: { pct: 47, at: t0, source: 'statusline' }, cost: { lineageUsd: 1.32, byClaudeSession: {} },
    now: { tool: 'Write', summary: 'components/Search.tsx', since: t0 }, last: 'Building the search results list.',
  }),
  rec({
    strategosId: 's6', displayName: 'Review PR 41', repo: 'strategos-app', branch: 'main', status: 'done',
    doneAt: t0 - 9 * min, statusSince: t0 - 9 * min, ctx: { pct: 55, at: t0, source: 'statusline' }, cost: { lineageUsd: 0.87, byClaudeSession: {} },
    last: 'Review finished: two minor issues in the diff.',
  }),
  rec({
    strategosId: 's7', displayName: 'Dependency bumps', repo: 'mobile-app', branch: 'chore/deps', status: 'stopped',
    statusSince: t0 - 41 * min, ctx: { pct: 12, at: t0, source: 'statusline' }, cost: { lineageUsd: 0.21, byClaudeSession: {} }, last: 'Stopped by you.',
  }),
]) sessions.set(s.strategosId, s);

// --- Map scene (M3): four planets, ten-plus sessions in every status, marks and subagents ------------------------------
const patch = (id: string, p: Partial<SessionRecord>) => sessions.set(id, { ...sessions.get(id)!, ...p } as SessionRecord);
patch('s1', {
  createdAt: t0 - 90 * min, initiativeId: 'i-auth', git: { branch: 'feat/pty-host', ahead: 3, behind: 0, dirty: true, at: t0 },
  cache: { warm: true, expiresAt: t0 + 3 * min, source: 'statusline' },
});
patch('s2', { createdAt: t0 - 80 * min, git: { branch: 'feat/onboarding', ahead: 1, behind: 2, dirty: true, at: t0 } });
patch('s3', { createdAt: t0 - 70 * min, initiativeId: 'i-auth' });
patch('s4', {
  createdAt: t0 - 60 * min, initiativeId: 'i-release',
  subagents: [{ agentId: 'a1', type: 'Explore', running: true, startedAt: t0 - 2 * min }, { agentId: 'a2', type: 'general-purpose', running: true, startedAt: t0 - min }],
  cache: { warm: true, expiresAt: t0 + 40 * min, source: 'statusline' },
});
patch('s5', {
  createdAt: t0 - 50 * min, initiativeId: 'i-auth', pr: { number: 12, url: 'https://example.invalid/pr/12', state: 'OPEN', ci: 'pending', at: t0 },
});
patch('s6', { createdAt: t0 - 45 * min, pr: { number: 41, url: 'https://example.invalid/pr/41', state: 'OPEN', ci: 'pass', at: t0 } });
patch('s7', { createdAt: t0 - 40 * min });
for (const s of [
  rec({
    strategosId: 's8', displayName: 'CORS headers', repo: 'api-gateway', branch: 'fix/cors', status: 'working', createdAt: t0 - 35 * min, initiativeId: 'i-release',
    statusSource: 'transcript', ctx: { pct: 24, at: t0, source: 'statusline' }, cost: { lineageUsd: 0.43, byClaudeSession: {} },
    now: { tool: 'Read', summary: 'test/cors.spec.ts', since: t0 }, last: 'Running the failing spec to see the exact error.',
    flags: { conflicts: [], contractChanged: [], guardDenials: 0, stuck: { reason: 'repeat', since: t0 - 6 * min } }, cache: { warm: false, source: 'statusline' },
  }),

  rec({
    strategosId: 's9', displayName: 'Webhook retries', repo: 'api-gateway', branch: 'fix/webhook-retry', status: 'errored', createdAt: t0 - 30 * min, initiativeId: 'i-release',
    statusSince: t0 - 7 * min, waitingSince: t0 - 7 * min, ctx: { pct: 45, at: t0, source: 'statusline' }, cost: { lineageUsd: 0.74, byClaudeSession: {} },
    last: 'API Error: 529 overloaded. The turn stopped.', flags: { conflicts: [{ file: 'src/queue.ts', other: 's8', at: t0 }], contractChanged: [], guardDenials: 0 },
  }),
  rec({
    strategosId: 's10', displayName: 'Changelog draft', repo: 'docs-site', branch: 'docs/changelog', status: 'seen', createdAt: t0 - 25 * min,
    doneAt: t0 - 30 * min, seenAt: t0 - 20 * min, statusSince: t0 - 30 * min, ctx: { pct: 31, at: t0, source: 'statusline' }, cost: { lineageUsd: 0.38, byClaudeSession: {} },
    pr: { number: 9, url: 'https://example.invalid/pr/9', state: 'MERGED', ci: 'pass', at: t0 }, last: 'Changelog merged.',
  }),
  rec({
    strategosId: 's11', displayName: 'Migrate to Vite 8', repo: 'strategos-app', branch: 'chore/vite8', status: 'interrupted', createdAt: t0 - 20 * min,
    statusSince: t0 - 3 * min, waitingSince: t0 - 3 * min, ctx: { pct: null, at: t0, source: 'transcript' }, cost: { lineageUsd: 0.5, byClaudeSession: {} }, last: 'Interrupted by you.',
  }),
]) sessions.set(s.strategosId, s);

interface MockPlanet { planetKey: string; label: string; colour: string; cell: { col: number; row: number }; pinned: boolean; folded: boolean }
let planets: MockPlanet[] = [
  { planetKey: 'strategos-app', label: 'strategos-app', colour: '#3a4c8a', cell: { col: 0, row: 0 }, pinned: false, folded: false },
  { planetKey: 'api-gateway', label: 'api-gateway', colour: '#5a3f7a', cell: { col: 1, row: 0 }, pinned: false, folded: false },
  { planetKey: 'mobile-app', label: 'mobile-app', colour: '#2f6a6a', cell: { col: 0, row: 1 }, pinned: false, folded: false },
  { planetKey: 'docs-site', label: 'docs-site', colour: '#7a5a3a', cell: { col: 1, row: 1 }, pinned: false, folded: false },
];
const initiatives = [
  { id: 'i-auth', name: 'Auth overhaul', colour: '#7b93ff', createdAt: t0, contractFiles: [], archived: false },
  { id: 'i-release', name: 'Release 2.4', colour: '#35e0c8', createdAt: t0, contractFiles: [], archived: false },
];

let seq = 0;
const conns = new Set<WebSocket>();
const subs = new Map<WebSocket, Set<string>>();
const out = (ws: WebSocket, ev: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev)); };

function publish(delta: Record<string, unknown>): void {
  seq++;
  for (const ws of conns) out(ws, { ...delta, seq });
}
function upsert(id: string, patch: Partial<SessionRecord>): void {
  const cur = sessions.get(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: Date.now() } as SessionRecord;
  if ('pending' in patch && patch.pending === undefined) delete next.pending;
  sessions.set(id, next);
  publish({ t: 'session.upsert', session: next });
}
const snapshot = (): DaemonEvent => ({ t: 'snapshot', seq, sessions: [...sessions.values()], planets, initiatives, prefs });

// --- fake terminals -------------------------------------------------------------------------------------------
const PROMPT = '\x1b[38;5;75m>\x1b[0m ';
const screens = new Map<string, string>();
const banner = (s: SessionRecord) =>
  `\x1b[1mClaude Code\x1b[0m (mock)  ${s.displayName}\r\n\x1b[2m${s.repoRoot}\x1b[0m\r\n\r\n` +
  `${s.last ?? ''}\r\n\r\n${s.pending ? `\x1b[33m? Do you want to proceed?\x1b[0m\r\n  1. Yes\r\n  2. No\r\n\r\n` : ''}${PROMPT}`;
function screenOf(id: string): string {
  let sc = screens.get(id);
  if (sc === undefined) {
    sc = banner(sessions.get(id)!);
    screens.set(id, sc);
  }
  return sc;
}
function ptyBroadcast(id: string, data: string): void {
  screens.set(id, screenOf(id) + data);
  for (const [ws, ch] of subs) if (ch.has('pty:' + id)) out(ws, { t: 'pty.data', strategosId: id, data });
}

// --- commands ---------------------------------------------------------------------------------------------------
type Cmd = { id: string; c: string; strategosId?: string; requestId?: string; [k: string]: unknown };
function handle(ws: WebSocket, m: Cmd): string | void {
  const id = m.strategosId;
  switch (m.c) {
    case 'resync': out(ws, snapshot()); return;
    case 'pty.subscribe':
      if (!id || !sessions.has(id)) return 'unknown session';
      if (!subs.has(ws)) subs.set(ws, new Set());
      subs.get(ws)!.add('pty:' + id);
      out(ws, { t: 'pty.replay', strategosId: id, data: screenOf(id) });
      return;
    case 'pty.unsubscribe': if (id) subs.get(ws)?.delete('pty:' + id); return;
    case 'pty.input': {
      if (!id) return 'no id';
      const data = String(m['data'] ?? '');
      ptyBroadcast(id, data === '\r' ? `\r\n\x1b[2m(mock claude heard you)\x1b[0m\r\n${PROMPT}` : data === '\x7f' ? '\b \b' : data);
      return;
    }
    case 'pty.resize': case 'pty.focus': return;
    case 'layout.setPlanetCell': {
      const key = String(m['planetKey']);
      planets = planets.map((p) => (p.planetKey === key ? { ...p, cell: { col: Number(m['col']), row: Number(m['row']) }, pinned: true } : p));
      publish({ t: 'planets', planets });
      return;
    }
    case 'prefs.set': Object.assign(prefs, m['prefs']); return;
    case 'session.start': {
      const n = sessions.size + 1;
      const repo = String(m['repoPath'] ?? 'repo');
      const sid = 's' + n;
      sessions.set(sid, rec({ strategosId: sid, displayName: String(m['name'] || `Session ${n}`), repo: repo.split(/[\\/]/).pop() ?? repo, repoRoot: repo, status: 'starting', last: String(m['firstPrompt'] ?? ''), statusSince: Date.now(), createdAt: Date.now() }));
      publish({ t: 'session.upsert', session: sessions.get(sid) });
      setTimeout(() => upsert(sid, { status: 'working', statusSince: Date.now(), now: { tool: 'Read', summary: 'README.md', since: Date.now() } }), 1500);
      return;
    }
    case 'session.stop': if (id) { upsert(id, { status: 'stopped', statusSince: Date.now(), pending: undefined, now: undefined }); } return;
    case 'session.resume': if (id) { upsert(id, { status: 'working', statusSince: Date.now() }); } return;
    case 'session.seen': if (id) upsert(id, { seenAt: Date.now() }); return;
    case 'perm.decide': {
      const s = id ? sessions.get(id) : undefined;
      if (!id || s?.pending?.requestId !== m.requestId) return 'no such pending request';
      const allowed = m['decision'] !== 'deny';
      ptyBroadcast(id, `\r\n\x1b[2m[${allowed ? 'approved' : 'denied'} from Strategos]\x1b[0m\r\n${PROMPT}`);
      upsert(id, { status: 'working', statusSince: Date.now(), waitingSince: undefined, pending: undefined, last: allowed ? 'Running the approved command.' : 'Understood, I will not run that.' });
      return;
    }
    case 'perm.release': {
      const s = id ? sessions.get(id) : undefined;
      if (!id || !s?.pending) return 'no such pending request';
      upsert(id, { pending: { ...s.pending, held: false } });
      return;
    }
    case 'question.answer': {
      const s = id ? sessions.get(id) : undefined;
      if (!id || s?.pending?.requestId !== m.requestId) return 'no such pending request';
      upsert(id, { status: 'working', statusSince: Date.now(), waitingSince: undefined, pending: undefined, last: 'Thanks, applying that choice.' });
      return;
    }
    case 'pending.full': { // invented, see README "Daemon requests"
      const s = id ? sessions.get(id) : undefined;
      if (!id || !s?.pending) return 'no such pending request';
      out(ws, { t: 'pending.full', strategosId: id, requestId: m.requestId, input: s.pending.inputSummary + '\n# ...rest of the command, shown in full\necho "done"' });
      return;
    }
    case 'digest.get': {
      const list = [...sessions.values()];
      out(ws, {
        t: 'digest', since: Number(m['since'] ?? 0),
        digest: { since: Number(m['since'] ?? 0), until: Date.now(), sessions: [], totals: { costUsd: list.reduce((a, s) => a + s.cost.lineageUsd, 0), waitingMs: 37 * min, decisions: 5, guardDenials: 0 } },
      });
      return;
    }
    default: return;
  }
}

// --- server -------------------------------------------------------------------------------------------------------
const hasCookie = (req: IncomingMessage) => (req.headers.cookie ?? '').includes(COOKIE);
const server = createServer((req, res) => {
  if (req.url === '/api/pair' && req.method === 'POST') {
    req.resume();
    req.on('end', () => { res.writeHead(204, { 'Set-Cookie': `${COOKIE}; Path=/; HttpOnly; SameSite=Strict` }).end(); });
    return;
  }
  if (req.url === '/api/session') { res.writeHead(hasCookie(req) ? 200 : 401, { 'Content-Type': 'application/json' }).end('{"ok":true}'); return; }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !hasCookie(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    conns.add(ws);
    out(ws, { t: 'hello', protocol: 1, daemonVersion: 'mock', claudeVersion: '2.1.292', testedRange: '2.1.x', inRange: true });
    out(ws, snapshot());
    ws.on('close', () => { conns.delete(ws); subs.delete(ws); });
    ws.on('message', (raw) => {
      let m: Cmd;
      try { m = JSON.parse(String(raw)) as Cmd; } catch { return; }
      const err = handle(ws, m);
      out(ws, err ? { t: 'ack', id: m.id, ok: false, error: err } : { t: 'ack', id: m.id, ok: true });
    });
  });
});

// Slow drift so the rows visibly move: context grows, cost creeps, terminal output ticks.
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.status !== 'working') continue;
    const pct = Math.min(95, (s.ctx?.pct ?? 20) + 1);
    upsert(s.strategosId, { ctx: { pct, at: Date.now(), source: 'statusline' }, cost: { lineageUsd: +(s.cost.lineageUsd + 0.03).toFixed(2), byClaudeSession: {} } });
    ptyBroadcast(s.strategosId, `\x1b[2m· ${s.now?.tool ?? 'Working'} ${s.now?.summary ?? ''}…\x1b[0m\r\n`);
  }
}, 5000);

// A short play every 12 s so the Map can be watched for stability: a session finishes, a new one arrives and asks for
// permission, then it stops and goes away. Nothing else on the Map should move while this happens. MOCK_PLAY=0 turns it off.
const steps: (() => void)[] = [
  () => upsert('s4', { status: 'done', statusSince: Date.now(), doneAt: Date.now(), seenAt: undefined, subagents: [], last: 'Atomic rename landed, tests pass.' }),
  () => {
    sessions.set('sx1', rec({
      strategosId: 'sx1', displayName: 'Hotfix: login redirect', repo: 'api-gateway', branch: 'hotfix/login', status: 'working', createdAt: Date.now(), statusSince: Date.now(),
      ctx: { pct: 9, at: Date.now(), source: 'statusline' }, cost: { lineageUsd: 0.04, byClaudeSession: {} }, now: { tool: 'Grep', summary: 'redirect', since: Date.now() }, last: 'Looking for the redirect.',
    }));
    publish({ t: 'session.upsert', session: sessions.get('sx1') });
  },
  () => upsert('sx1', {
    status: 'permission', statusSince: Date.now(), waitingSince: Date.now(), last: 'I want to edit the redirect handler.',
    pending: { requestId: 'rx1', kind: 'permission', held: true, toolName: 'Edit', inputSummary: 'src/auth/redirect.ts', inputTruncated: false, risk: ['write'], since: Date.now() },
  }),
  () => upsert('s4', { status: 'working', statusSince: Date.now(), doneAt: undefined, now: { tool: 'Edit', summary: 'src/hooks.rs', since: Date.now() }, last: 'Next: the second writer.' }),
  () => upsert('sx1', { status: 'stopped', statusSince: Date.now(), waitingSince: undefined, pending: undefined, now: undefined, last: 'Stopped by you.' }),
  () => {
    sessions.delete('sx1');
    publish({ t: 'session.removed', strategosId: 'sx1' });
  },
];
let step = 0;
if (process.env['MOCK_PLAY'] !== '0') setInterval(() => { steps[step++ % steps.length]!(); }, 12_000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock daemon on http://127.0.0.1:${PORT}  (pair with any code, e.g. http://localhost:5173/#pair=mock)`);
});
