import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@strategos/shared';
import type { StrategosServer } from './http.ts';
import { Client, pairCookie, startServer } from './testkit.ts';

let srv: StrategosServer;
let cookie: string;
const clients: Client[] = [];
beforeEach(async () => {
  srv = await startServer();
  cookie = await pairCookie(srv);
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await srv.close();
});
const connect = async () => {
  const c = await Client.connect(srv, cookie);
  clients.push(c);
  return c;
};
const isAck = (id: string) => (e: DaemonEvent) => e.t === 'ack' && e.id === id;

describe('ws hub', () => {
  it('sends hello, then snapshot with the current seq', async () => {
    srv.hub.setHelloProvider(() => ({ daemonVersion: '9.9.9', claudeVersion: '2.1.292', testedRange: '2.1.x', inRange: true }));
    srv.hub.publish({ t: 'resources', totalMb: 1, cpuPct: 1 });
    srv.hub.publish({ t: 'resources', totalMb: 2, cpuPct: 2 });
    const c = await connect();
    const snap = await c.next((e) => e.t === 'snapshot');
    expect(c.inbox[0]).toEqual({ t: 'hello', protocol: 1, daemonVersion: '9.9.9', claudeVersion: '2.1.292', testedRange: '2.1.x', inRange: true });
    expect(c.inbox[1]).toBe(snap);
    expect(snap).toMatchObject({ t: 'snapshot', seq: 2, sessions: [], planets: [], initiatives: [] });
  });

  it('broadcasts deltas with increasing seq to every client', async () => {
    const a = await connect();
    const b = await connect();
    await a.next((e) => e.t === 'snapshot');
    await b.next((e) => e.t === 'snapshot');
    const s1 = srv.hub.publish({ t: 'usage', usage: { at: 1 } });
    const s2 = srv.hub.publish({ t: 'session.removed', strategosId: 'x' });
    expect([s1, s2]).toEqual([1, 2]);
    for (const c of [a, b]) {
      const e2 = await c.next((e) => 'seq' in e && e.seq === 2);
      expect(e2).toEqual({ t: 'session.removed', strategosId: 'x', seq: 2 });
      const seqs = c.inbox.filter((e) => 'seq' in e).map((e) => (e as { seq: number }).seq);
      expect(seqs).toEqual([0, 1, 2]);
    }
  });

  it('routes a command to its handler and acks after the handler finished (deltas first)', async () => {
    const seen: string[] = [];
    srv.hub.registerCommand('session.stop', async (cmd) => {
      seen.push(cmd.strategosId);
      srv.hub.publish({ t: 'session.removed', strategosId: cmd.strategosId });
    });
    const c = await connect();
    await c.next((e) => e.t === 'snapshot');
    c.send({ id: 'c1', c: 'session.stop', strategosId: 's1' });
    const ack = await c.next(isAck('c1'));
    expect(ack).toEqual({ t: 'ack', id: 'c1', ok: true });
    expect(seen).toEqual(['s1']);
    const order = c.inbox.map((e) => e.t);
    expect(order.indexOf('session.removed')).toBeLessThan(order.indexOf('ack'));
  });

  it('answers every command with an ack: errors, thrown errors, unknown and invalid commands', async () => {
    srv.hub.registerCommand('session.park', () => ({ ok: false, error: 'cannot park' }));
    srv.hub.registerCommand('session.resume', () => { throw new Error('boom'); });
    const c = await connect();
    c.send({ id: 'a', c: 'session.park', strategosId: 's' });
    c.send({ id: 'b', c: 'session.resume', strategosId: 's' });
    c.send({ id: 'c', c: 'session.forget', strategosId: 's' });
    c.send({ id: 'd', c: 'no.such.command' });
    c.send({ id: 'e', c: 'pty.resize', strategosId: 's', cols: 0, rows: 5 });
    c.send('not json');
    expect(await c.next(isAck('a'))).toEqual({ t: 'ack', id: 'a', ok: false, error: 'cannot park' });
    expect(await c.next(isAck('b'))).toEqual({ t: 'ack', id: 'b', ok: false, error: 'boom' });
    expect(await c.next(isAck('c'))).toMatchObject({ ok: false, error: expect.stringContaining('not implemented') });
    expect(await c.next(isAck('d'))).toMatchObject({ ok: false, error: 'unknown command' });
    expect(await c.next(isAck('e'))).toMatchObject({ ok: false, error: expect.stringContaining('cols and rows') });
    expect(await c.next(isAck(''))).toMatchObject({ ok: false, error: expect.stringContaining('JSON') });
  });

  it('acks arrive in command order even when handlers take different times', async () => {
    srv.hub.registerCommand('session.stop', async () => { await new Promise((r) => setTimeout(r, 40)); });
    srv.hub.registerCommand('session.park', () => undefined);
    const c = await connect();
    c.send({ id: '1', c: 'session.stop', strategosId: 's' });
    c.send({ id: '2', c: 'session.park', strategosId: 's' });
    await c.next(isAck('2'));
    expect(c.inbox.filter((e) => e.t === 'ack').map((e) => (e as { id: string }).id)).toEqual(['1', '2']);
  });

  it('resync sends a fresh snapshot with the current seq, then the ack', async () => {
    srv.hub.setSnapshotProvider(() => ({
      sessions: [], planets: [{ planetKey: 'p', label: 'P', colour: '#fff', cell: { col: 0, row: 0 }, pinned: false, folded: false }],
      initiatives: [], prefs: { groupBy: 'repo', notifications: { enabled: true, sound: true, onPermission: true, onQuestion: true, onErrored: true, onDone: false, escalate: true }, keymap: {} },
    }));
    const c = await connect();
    await c.next((e) => e.t === 'snapshot');
    srv.hub.publish({ t: 'resources', totalMb: 1, cpuPct: 1 });
    srv.hub.publish({ t: 'resources', totalMb: 2, cpuPct: 2 });
    c.send({ id: 'r1', c: 'resync' });
    await c.next(isAck('r1'));
    const snaps = c.inbox.filter((e) => e.t === 'snapshot');
    expect(snaps).toHaveLength(2);
    expect(snaps[1]).toMatchObject({ seq: 2, planets: [{ planetKey: 'p' }] });
    expect(c.inbox.map((e) => e.t).lastIndexOf('snapshot')).toBeLessThan(c.inbox.map((e) => e.t).lastIndexOf('ack'));
  });

  it('per-subscription channels carry no seq and reach only subscribers', async () => {
    srv.hub.registerCommand('pty.subscribe', (cmd, ctx) => {
      ctx.subscribe(`pty:${cmd.strategosId}`);
      ctx.send({ t: 'pty.replay', strategosId: cmd.strategosId, data: 'old' });
    });
    srv.hub.registerCommand('pty.unsubscribe', (cmd, ctx) => { ctx.unsubscribe(`pty:${cmd.strategosId}`); });
    const a = await connect();
    const b = await connect();
    await b.next((e) => e.t === 'snapshot');
    a.send({ id: 's', c: 'pty.subscribe', strategosId: 'x', cols: 80, rows: 24 });
    await a.next(isAck('s'));
    expect(a.inbox.find((e) => e.t === 'pty.replay')).toEqual({ t: 'pty.replay', strategosId: 'x', data: 'old' });
    const before = srv.hub.seq;
    expect(srv.hub.publishTo('pty:x', { t: 'pty.data', strategosId: 'x', data: 'hello' })).toBe(1);
    expect(await a.next((e) => e.t === 'pty.data')).toEqual({ t: 'pty.data', strategosId: 'x', data: 'hello' });
    expect(srv.hub.seq).toBe(before);
    expect(b.inbox.some((e) => e.t === 'pty.data')).toBe(false);
    a.send({ id: 'u', c: 'pty.unsubscribe', strategosId: 'x' });
    await a.next(isAck('u'));
    expect(srv.hub.publishTo('pty:x', { t: 'pty.data', strategosId: 'x', data: 'again' })).toBe(0);
  });

  it('drops subscriptions and notifies when a connection closes', async () => {
    const gone: string[] = [];
    srv.hub.onDisconnect((id) => gone.push(id));
    srv.hub.registerCommand('chat.subscribe', (cmd, ctx) => { ctx.subscribe(`chat:${cmd.strategosId}`); });
    const a = await connect();
    a.send({ id: 's', c: 'chat.subscribe', strategosId: 'x', from: 0 });
    await a.next(isAck('s'));
    expect(srv.hub.subscriberCount('chat:x')).toBe(1);
    a.close();
    await a.closed();
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.hub.subscriberCount('chat:x')).toBe(0);
    expect(srv.hub.connectionCount).toBe(0);
    expect(gone).toHaveLength(1);
  });

  it('closes a connection that sends a binary frame', async () => {
    const c = await connect();
    c.ws.send(Buffer.from([1, 2, 3]));
    expect(await c.closed()).toBe(1003);
  });
});
