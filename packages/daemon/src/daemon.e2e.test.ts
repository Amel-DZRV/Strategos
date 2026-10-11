// End to end (task 1.10 / 1.15): a real daemon, real WebSocket client, real node-pty, `node tools/fake-claude.ts` as claude.
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listing } from '../../../tools/fake-claude-home.ts';
import { rmTree } from '../../../tools/tmp-fs.ts';
import { DaemonStartError, startDaemon } from './daemon.ts';
import { defaultConfig } from './config.ts';
import { inside, startRig, FAKE_CLAUDE, FAST_TIMING, makeRepo, type Rig } from './daemon.testkit.ts';
import { http } from './server/testkit.ts';
import { cliSecretPath } from './home-files.ts';

const T = 60_000;
const rigs: Rig[] = [];
const kids: ChildProcess[] = [];
async function rig(o: Parameters<typeof startRig>[0] = {}): Promise<Rig> {
  const r = await startRig(o);
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const k of kids.splice(0)) k.kill();
  for (const r of rigs.splice(0)) await r.close().catch(() => undefined);
});

describe('three sessions, permission walk-through, never writing the Claude dir', () => {
  it('start 3; one goes permission -> perm.decide allow -> done; ring slots; planets; audit; Claude dir untouched', async () => {
    const r = await rig();
    const before = listing(r.claudeHome.root);
    const ui = await r.ui();
    expect(ui.hello).toMatchObject({ protocol: 1, inRange: true, testedRange: '2.1.292' });

    r.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
    const a = await ui.start('A', r.repo, 'one');
    const b = await ui.start('B', r.repo, 'two');
    r.env['FAKE_CLAUDE_SCRIPT'] = 'permission';
    const c = await ui.start('C', r.repo, 'run it');

    await ui.waitStatus(a.strategosId, 'done');
    await ui.waitStatus(b.strategosId, 'done');
    expect(ui.of(a.strategosId).last).toContain('Fake reply to: one');
    const held = await ui.waitStatus(c.strategosId, 'permission');
    expect(held.pending).toMatchObject({ held: true, toolName: 'Bash', inputSummary: 'rm -rf /' });

    const ok = await ui.cmd({ c: 'perm.decide', strategosId: c.strategosId, requestId: held.pending!.requestId, decision: 'allow' });
    expect(ok).toEqual({ ok: true });
    await ui.waitStatus(c.strategosId, 'done');

    expect([a, b, c].map((s) => ui.of(s.strategosId).ringSlot).sort()).toEqual([0, 1, 2]);
    expect(new Set([a, b, c].map((s) => s.planetKey)).size).toBe(1);
    expect(ui.of(a.strategosId).planetKey.toLowerCase()).toContain('.git');
    const resync = await ui.cmd({ c: 'resync' });
    expect(resync.ok).toBe(true);
    expect(ui.snapshot!.planets).toHaveLength(1);
    expect(ui.snapshot!.planets[0]!.label).toBe(path.basename(r.repo));

    await ui.until(() => { try { return readFileSync(path.join(r.home, 'audit.jsonl'), 'utf8').includes('"allow"'); } catch { return false; } }, 5000, 'audit line');
    const line = readFileSync(path.join(r.home, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e['decision'] === 'allow')!;
    expect(line).toMatchObject({ sid: c.strategosId, tool: 'Bash', via: 'drawer' });
    expect(typeof line['connId']).toBe('string');

    // the hook token never reaches a file
    const settings = readFileSync(path.join(r.home, 'run', `${a.strategosId}.settings.json`), 'utf8');
    expect(settings).not.toMatch(/[0-9a-f]{64}/);
    const info = readFileSync(path.join(r.home, 'daemon.json'), 'utf8');
    expect(JSON.parse(info)).toMatchObject({ pid: process.pid, port: r.daemon.port });
    expect(info).not.toMatch(/token|secret/i);

    // Exit criterion: nothing of the daemon's was written under CLAUDE_CONFIG_DIR. fake-claude itself writes there
    // (transcripts and sessions/<pid>.json), so compare shapes, and check every path safe-fs was asked to touch.
    expect(r.writes.length).toBeGreaterThan(5);
    expect(r.writes.filter((w) => inside(w, r.claudeHome.root))).toEqual([]);
    const added = listing(r.claudeHome.root).filter((l) => !before.includes(l));
    for (const l of added) expect(l).toMatch(/^(d (projects|sessions)(\/[^/]+)?|f projects\/[^/]+\/[0-9a-f-]+\.jsonl .*|f sessions\/\d+\.json .*)$/);
  }, T);

  it('stop, then resume reaches done again with the same Claude id; park is parked and resumable', async () => {
    const r = await rig();
    const ui = await r.ui();
    r.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
    const s = await ui.start('S', r.repo, 'hello');
    await ui.waitStatus(s.strategosId, 'done');
    const claudeId = ui.of(s.strategosId).currentSessionId;

    expect((await ui.cmd({ c: 'session.stop', strategosId: s.strategosId })).ok).toBe(true);
    const stopped = await ui.waitStatus(s.strategosId, 'stopped');
    await ui.until(() => ui.of(s.strategosId).pty === undefined, 5000, 'pty gone');
    expect(stopped.statusSource === 'pty' || stopped.statusSource === 'hook').toBe(true);

    expect((await ui.cmd({ c: 'session.resume', strategosId: s.strategosId })).ok).toBe(true);
    await ui.waitStatus(s.strategosId, 'done');
    expect(ui.of(s.strategosId).currentSessionId).toBe(claudeId);
    expect(ui.of(s.strategosId).claudeSessionIds).toEqual([claudeId]);

    await ui.cmd({ c: 'session.park', strategosId: s.strategosId });
    await ui.waitStatus(s.strategosId, 'parked');
    expect((await ui.cmd({ c: 'session.resume', strategosId: s.strategosId })).ok).toBe(true);
    await ui.waitStatus(s.strategosId, 'done');

    // double resume is refused
    const again = await ui.cmd({ c: 'session.resume', strategosId: s.strategosId });
    expect(again.ok).toBe(false);
    // forget removes it and frees the slot
    await ui.cmd({ c: 'session.forget', strategosId: s.strategosId });
    await ui.until(() => !ui.sessions.has(s.strategosId), 15_000, 'removed');
  }, T);
});

describe('restart recovery', () => {
  it('a state.json written by a daemon that died: sessions come back stopped and resumable; a foreign live owner blocks resume', async () => {
    const r1 = await rig();
    const ui1 = await r1.ui();
    r1.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
    const a = await ui1.start('A', r1.repo, 'one');
    const b = await ui1.start('B', r1.repo, 'two');
    await ui1.waitStatus(a.strategosId, 'done');
    await ui1.waitStatus(b.strategosId, 'done');
    // wait for the debounced write, then copy it away: this is what a crashed daemon leaves behind
    const stateFile = path.join(r1.home, 'state.json');
    await ui1.until(() => { try { const j = JSON.parse(readFileSync(stateFile, 'utf8')) as { sessions: { status: string }[] }; return j.sessions.length === 2 && j.sessions.every((s) => s.status === 'done'); } catch { return false; } }, 8000, 'state.json');
    const home2 = path.join(r1.root, 'home2');
    mkdirSync(home2, { recursive: true });
    copyFileSync(stateFile, path.join(home2, 'state.json'));
    const claudeIdA = ui1.of(a.strategosId).currentSessionId;
    // the old processes must be gone before the "new daemon" starts (after a real crash they are)
    await r1.daemon.shutdown();

    const r2 = await rig({ home: home2, claudeHome: r1.claudeHome, repo: r1.repo });
    const ui2 = await r2.ui();
    expect(ui2.sessions.size).toBe(2);
    for (const s of ui2.sessions.values()) {
      expect(s.status).toBe('stopped');
      expect(s.statusSource).toBe('daemon');
      expect(s.pty).toBeUndefined();
    }
    // a foreign process owns conversation A: resume refuses (single writer)
    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    kids.push(foreign);
    const sf = r1.claudeHome.addSessionFile({ pid: foreign.pid!, sessionId: claudeIdA, cwd: ui2.of(a.strategosId).cwd, status: 'idle' });
    const refused = await ui2.cmd({ c: 'session.resume', strategosId: a.strategosId });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/Another Claude process/);
    foreign.kill();
    rmTree(sf);

    r2.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
    expect((await ui2.cmd({ c: 'session.resumeAll' })).ok).toBe(true);
    await ui2.waitStatus(a.strategosId, 'done');
    await ui2.waitStatus(b.strategosId, 'done');
  }, T);

  it('daemon.lock: a live holder refuses a second daemon (exit with a message), a stale one is replaced', async () => {
    const r = await rig();
    const home = r.home;
    // same process id counts as ours; use a foreign live process
    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    kids.push(foreign);
    const { getPlatform } = await import('./platform/index.ts');
    const start = await getPlatform().proc.startTime(foreign.pid!);
    // replace our own lock file by the foreign holder's
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(home, 'daemon.lock'), JSON.stringify({ pid: foreign.pid, ...(start === null ? {} : { procStart: start }) }));
    const second = path.join(r.root, 'other-claude');
    await expect(startDaemon({ home, claudeConfigDir: second, config: defaultConfig(0), claude: { error: 'x' }, staticDir: null })).rejects.toBeInstanceOf(DaemonStartError);
    foreign.kill();
    await new Promise((res) => foreign.once('exit', res));
    const ok = await startDaemon({ home, claudeConfigDir: second, config: defaultConfig(0), claude: { error: 'x' }, staticDir: null });
    await ok.shutdown();
  }, T);
});

describe('sending text and the terminal', () => {
  it('reply refused while input is typed in the terminal, and while busy; then accepted', async () => {
    const r = await rig();
    const ui = await r.ui();
    r.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
    const s = await ui.start('R', r.repo, 'first');
    await ui.waitStatus(s.strategosId, 'done');

    await ui.cmd({ c: 'pty.input', strategosId: s.strategosId, data: 'abc' });
    await ui.until(() => ui.of(s.strategosId).pty?.dirtyInput === true, 5000, 'dirtyInput');
    const refused = await ui.cmd({ c: 'reply.send', strategosId: s.strategosId, text: 'second' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toMatch(/dirty_input/);
    const slash = await ui.cmd({ c: 'slash.send', strategosId: s.strategosId, cmd: '/compact' });
    expect(slash.ok).toBe(false);

    await ui.cmd({ c: 'pty.input', strategosId: s.strategosId, data: '\x03' }); // Ctrl+C clears the prompt
    await ui.until(() => ui.of(s.strategosId).pty?.dirtyInput === false, 5000, 'clean');
    const sent = await ui.cmd({ c: 'reply.send', strategosId: s.strategosId, text: 'second' });
    expect(sent.ok).toBe(true);
    await ui.until(() => (ui.of(s.strategosId).last ?? '').includes('second'), 15_000, 'second reply');
    await ui.waitStatus(s.strategosId, 'done');

    // busy: a held permission request
    r.env['FAKE_CLAUDE_SCRIPT'] = 'permission';
    const p = await ui.start('P', r.repo, 'go');
    await ui.waitStatus(p.strategosId, 'permission');
    const busy = await ui.cmd({ c: 'reply.send', strategosId: p.strategosId, text: 'x' });
    expect(busy.ok).toBe(false);
    expect(busy.error).toMatch(/busy/);

    // pending.full (D21) answers with an event carrying the whole input
    const reqId = ui.of(p.strategosId).pending!.requestId;
    expect((await ui.cmd({ c: 'pending.full', strategosId: p.strategosId, requestId: reqId })).ok).toBe(true);
    const full = ui.events.find((e) => e.t === 'pending.full');
    expect(full).toMatchObject({ t: 'pending.full', requestId: reqId, toolName: 'Bash', input: { command: 'rm -rf /' } });

    // D13: focusing the terminal releases the held request; it is then answered in the terminal
    expect((await ui.cmd({ c: 'pty.focus', strategosId: p.strategosId })).ok).toBe(true);
    await ui.until(() => ui.of(p.strategosId).pending?.held === false, 5000, 'released');
    expect(ui.of(p.strategosId).status).toBe('permission');
    await ui.cmd({ c: 'pty.input', strategosId: p.strategosId, data: '1' });
    await ui.waitStatus(p.strategosId, 'done');
  }, T);

  it('pty.subscribe sends the scrollback first, then streams data', async () => {
    const r = await rig();
    const ui = await r.ui();
    r.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
    const s = await ui.start('V', r.repo, 'hi');
    await ui.waitStatus(s.strategosId, 'done');

    const ui2 = await r.ui();
    const mark = ui2.events.length;
    expect((await ui2.cmd({ c: 'pty.subscribe', strategosId: s.strategosId, cols: 100, rows: 30 })).ok).toBe(true);
    const seen = ui2.events.slice(mark);
    const replayAt = seen.findIndex((e) => e.t === 'pty.replay');
    const ackAt = seen.findIndex((e) => e.t === 'ack');
    expect(replayAt).toBeGreaterThanOrEqual(0);
    expect(replayAt).toBeLessThan(ackAt);
    const replay = seen[replayAt] as { data: string };
    expect(replay.data).toContain('Claude Code (fake)');
    expect(replay.data).toContain('Fake reply to: hi');

    await ui.cmd({ c: 'reply.send', strategosId: s.strategosId, text: 'streamed' });
    await ui2.until(() => ui2.events.some((e) => e.t === 'pty.data' && e.data.includes('Fake reply to: streamed')), 15_000, 'pty.data');
    // unsubscribed clients get nothing more
    await ui2.cmd({ c: 'pty.unsubscribe', strategosId: s.strategosId });
    const n = ui2.events.filter((e) => e.t === 'pty.data').length;
    await ui.waitStatus(s.strategosId, 'done');
    await ui.cmd({ c: 'reply.send', strategosId: s.strategosId, text: 'quiet' });
    await ui.until(() => (ui.of(s.strategosId).last ?? '').includes('quiet'), 15_000, 'quiet reply');
    expect(ui2.events.filter((e) => e.t === 'pty.data').length).toBe(n);
  }, T);
});

describe('version guard and missing Claude', () => {
  it('out of range: hello.inRange=false and a banner flag in the snapshot; the daemon runs', async () => {
    const r = await rig({ daemon: { claude: { exe: process.execPath, prefixArgs: [FAKE_CLAUDE], version: '2.9.1 (Claude Code)' } } });
    const ui = await r.ui();
    expect(ui.hello).toMatchObject({ inRange: false, claudeVersion: '2.9.1 (Claude Code)', testedRange: '2.1.292' });
    expect(ui.snapshot!.prefs.claudeVersionOutOfRange).toBe(true);
    expect(ui.snapshot!.repos).toEqual([]);
  }, T);

  it('Claude not found: daemon starts, start fails with the reason', async () => {
    const r = await rig({ daemon: { claude: { error: 'no claude here' } } });
    const ui = await r.ui();
    expect(ui.hello?.inRange).toBe(false);
    const a = await ui.cmd({ c: 'session.start', repoPath: r.repo });
    expect(a).toEqual({ ok: false, error: 'no claude here' });
    expect(ui.sessions.size).toBe(0);
  }, T);

  it('digest.get answers with waiting time', async () => {
    const r = await rig();
    const ui = await r.ui();
    r.env['FAKE_CLAUDE_SCRIPT'] = 'plain';
    const s = await ui.start('D', r.repo, 'x');
    await ui.waitStatus(s.strategosId, 'done');
    await new Promise((res) => setTimeout(res, 300));
    await ui.cmd({ c: 'digest.get', since: Date.now() - 3_600_000 });
    const d = ui.events.find((e) => e.t === 'digest');
    expect(d).toBeDefined();
    expect((d as { digest: { totals: { waitingMs: number } } }).digest.totals.waitingMs).toBeGreaterThan(100);
  }, T);
});

describe('control routes (the CLI)', () => {
  it('pair needs the secret and no Origin; status lists sessions; shutdown calls back', async () => {
    let asked = 0;
    const r = await rig({ daemon: { onShutdownRequested: () => { asked++; } } });
    const port = r.daemon.port;
    const secret = readFileSync(cliSecretPath(r.home), 'utf8').trim();
    const post = (name: string, headers: Record<string, string>) => http(port, { method: 'POST', path: `/control/${name}`, headers, body: '{}' });
    expect((await post('pair', {})).status).toBe(401);
    expect((await post('pair', { 'X-Strategos-Control': 'wrong' })).status).toBe(401);
    expect((await post('pair', { 'X-Strategos-Control': secret, Origin: `http://127.0.0.1:${port}` })).status).toBe(403);
    expect((await http(port, { method: 'GET', path: '/control/pair', headers: { 'X-Strategos-Control': secret } })).status).toBe(405);
    expect((await http(port, { method: 'POST', path: '/control/pair', headers: { 'X-Strategos-Control': secret, Host: 'evil.example' }, body: '{}' })).status).toBe(421);
    const pair = await post('pair', { 'X-Strategos-Control': secret });
    expect(pair.status).toBe(200);
    const url = (JSON.parse(pair.body.toString()) as { url: string }).url;
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=[A-Za-z0-9_-]{43}$`));
    const st = await post('status', { 'X-Strategos-Control': secret });
    expect(JSON.parse(st.body.toString())).toMatchObject({ pid: process.pid, port, sessions: [] });
    expect((await post('shutdown', { 'X-Strategos-Control': secret })).status).toBe(202);
    await new Promise((res) => setTimeout(res, 50));
    expect(asked).toBe(1);
    expect((await post('nope', { 'X-Strategos-Control': secret })).status).toBe(404);
  }, T);
});

void FAST_TIMING;
void makeRepo;
