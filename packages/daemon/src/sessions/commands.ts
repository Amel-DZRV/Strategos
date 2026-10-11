// WebSocket commands for the session manager (plan section 5 UiCommand). Each handler validates nothing the protocol
// already validated; it maps a command to a manager call and a failure to `{ ok: false, error }` (an `ack` with ok:false).
import type { SendResult } from '@strategos/shared';
import { approveLowRisk } from '../features/risk.ts';
import type { CommandResult, WsHub } from '../server/ws-hub.ts';
import type { Result } from '../hooks/pending.ts';
import type { SessionManager } from './manager.ts';

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function fromResult(what: string, r: Result): CommandResult {
  return r.ok ? undefined : fail(`${what}: ${r.error}`);
}

function fromSend(r: SendResult): CommandResult {
  return r.ok ? undefined : fail(`${r.reason}${r.message === undefined ? '' : `: ${r.message}`}`);
}

export const ptyChannel = (strategosId: string): string => `pty:${strategosId}`;

/**
 * stop, park and forget are acknowledged when they have started, not when the process is gone: the hub handles one
 * connection's commands one at a time, and a stop can take 5 s. Watch the session's status (session.upsert) for the end.
 */
export function registerSessionCommands(hub: WsHub, m: SessionManager, onError: (what: string, err: unknown) => void = () => undefined): void {
  const background = (what: string, p: Promise<unknown>): void => { p.catch((err: unknown) => onError(what, err)); };
  const known = (id: string): CommandResult => (m.get(id) === undefined ? fail(`no such session: ${id}`) : undefined);

  hub.registerCommand('session.start', async (c) => {
    await m.start({
      repoPath: c.repoPath,
      ...(c.worktree === undefined ? {} : { worktree: c.worktree }),
      ...(c.firstPrompt === undefined ? {} : { firstPrompt: c.firstPrompt }),
      ...(c.name === undefined ? {} : { name: c.name }),
      ...(c.initiativeId === undefined ? {} : { initiativeId: c.initiativeId }),
      ...(c.model === undefined ? {} : { model: c.model }),
      ...(c.permissionMode === undefined ? {} : { permissionMode: c.permissionMode }),
    });
  });
  hub.registerCommand('session.stop', (c) => known(c.strategosId) ?? (background('stop', m.stop(c.strategosId)), undefined));
  hub.registerCommand('session.park', (c) => known(c.strategosId) ?? (background('park', m.park(c.strategosId)), undefined));
  hub.registerCommand('session.resume', async (c) => known(c.strategosId) ?? (await m.resume(c.strategosId), undefined));
  hub.registerCommand('session.forget', (c) => known(c.strategosId) ?? (background('forget', m.forget(c.strategosId)), undefined));
  hub.registerCommand('session.seen', (c) => known(c.strategosId) ?? (m.seen(c.strategosId), undefined));
  hub.registerCommand('session.archive', async (c) => known(c.strategosId) ?? (await m.archive(c.strategosId, c.on), undefined));
  hub.registerCommand('session.resumeAll', async () => {
    const r = await m.resumeAll();
    if (r.failed.length > 0) return fail(`resumed ${r.resumed.length}, failed ${r.failed.length}: ${r.failed.map((f) => f.error).join('; ')}`);
  });

  // ---- terminal ---------------------------------------------------------------
  hub.registerCommand('pty.subscribe', (c, ctx) => {
    const bad = known(c.strategosId);
    if (bad !== undefined) return bad;
    ctx.subscribe(ptyChannel(c.strategosId));
    m.ptyResize(c.strategosId, c.cols, c.rows);
    ctx.send({ t: 'pty.replay', strategosId: c.strategosId, data: m.ptyScrollback(c.strategosId) });
  });
  hub.registerCommand('pty.unsubscribe', (c, ctx) => {
    ctx.unsubscribe(ptyChannel(c.strategosId));
  });
  hub.registerCommand('pty.input', (c) => {
    if (!m.ptyInput(c.strategosId, c.data)) return fail('The session is not running.');
  });
  hub.registerCommand('pty.resize', (c) => {
    if (!m.ptyResize(c.strategosId, c.cols, c.rows)) return fail('The session is not running.');
  });
  hub.registerCommand('pty.focus', (c, ctx) => {
    const bad = known(c.strategosId);
    if (bad !== undefined) return bad;
    m.notifications.setFocus(ctx.connId, c.strategosId); // the terminal pane being focused means this session is being looked at
    m.focus(c.strategosId, ctx.connId); // D13: nothing held is fine
  });
  // Tasks 2.09/4.05: which session this connection shows, so no notification is raised for it. null: none.
  hub.registerCommand('view.focus', (c, ctx) => {
    if (c.strategosId !== null) {
      const bad = known(c.strategosId);
      if (bad !== undefined) return bad;
    }
    m.notifications.setFocus(ctx.connId, c.strategosId);
  });
  hub.onDisconnect((connId) => { m.notifications.dropConnection(connId); });

  // ---- requests -----------------------------------------------------------------
  hub.registerCommand('perm.decide', (c, ctx) => {
    const via = c.via ?? 'drawer';
    const d = c.decision === 'allow' ? { kind: 'allow' as const, via }
      : c.decision === 'deny' ? { kind: 'deny' as const, via, ...(c.message === undefined ? {} : { message: c.message }) }
        : { kind: 'always' as const, via, ...(c.suggestionIndex === undefined ? {} : { suggestionIndex: c.suggestionIndex }) };
    return fromResult('decide', m.decide(c.strategosId, c.requestId, d, { connId: ctx.connId, via }));
  });
  // Task 4.03 / D20 / D21: approve only what features/risk.ts allows, tested on the full input. initiativeId '*' = every
  // session (initiatives do not exist yet). `requestIds` limits it to the list the person confirmed.
  hub.registerCommand('perm.approveLowRisk', (c, ctx) => {
    const r = approveLowRisk(m, c.initiativeId, { connId: ctx.connId, ...(c.requestIds === undefined ? {} : { only: c.requestIds }) });
    if (r.approved.length === 0 && r.skipped > 0) return fail('Nothing could be approved as low risk. Open the requests and decide one by one.');
  });
  hub.registerCommand('perm.release', (c, ctx) =>
    fromResult('release', m.release(c.strategosId, c.requestId, 'user', { connId: ctx.connId })));
  hub.registerCommand('question.answer', (c, ctx) => {
    const via = c.via ?? 'drawer';
    return fromResult('answer', m.decide(c.strategosId, c.requestId, { kind: 'answers', answers: c.answers, via }, { connId: ctx.connId, via }));
  });
  hub.registerCommand('pending.full', (c, ctx) => {
    const f = m.registry.getFull(c.strategosId, c.requestId);
    if (f === undefined) return fail('not_found');
    ctx.send({ t: 'pending.full', strategosId: c.strategosId, requestId: c.requestId, event: f.event, toolName: f.toolName, input: f.toolInput });
  });

  hub.registerCommand('digest.get', (c, ctx) => {
    const since = c.since ?? Date.now() - 86_400_000;
    ctx.send({ t: 'digest', since, digest: m.digest(since) });
  });

  // ---- sending text ---------------------------------------------------------------
  hub.registerCommand('reply.send', async (c) => known(c.strategosId) ?? fromSend(await m.sendReply(c.strategosId, c.text)));
  hub.registerCommand('slash.send', async (c) => known(c.strategosId) ?? fromSend(await m.sendSlash(c.strategosId, c.cmd)));
}
