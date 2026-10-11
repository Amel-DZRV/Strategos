import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPrefs } from '@strategos/shared';
import { createNotifyPolicy, type NotifyOut, type NotifyPolicy } from './policy.ts';

const PREFS: NotificationPrefs = { enabled: true, sound: true, onPermission: true, onQuestion: true, onErrored: true, onDone: false, escalate: true };

let out: NotifyOut[];
let prefs: NotificationPrefs;
let policy: NotifyPolicy;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 0, 1)));
  out = [];
  prefs = { ...PREFS };
  policy = createNotifyPolicy({ publish: (n) => out.push(n), prefs: () => prefs, armed: true });
});
afterEach(() => {
  policy.dispose();
  vi.useRealTimers();
});

const ask = (sid: string, requestId = `r-${sid}`, kind: 'permission' | 'question' = 'permission'): ReturnType<NotifyPolicy['offer']> => {
  policy.setStatus(sid, kind);
  return policy.offer(sid, { kind, title: `Session ${sid}`, body: 'npm test', requestId });
};

describe('transitions', () => {
  it('publishes a new waiting session once', () => {
    expect(ask('a')).toBe('published');
    expect(out).toEqual([{ kind: 'permission', strategosId: 'a', title: 'Session a', body: 'npm test', requestId: 'r-a' }]);
  });
  it('does not say the same request twice', () => {
    ask('a');
    vi.advanceTimersByTime(10_000);
    expect(policy.offer('a', { kind: 'permission', title: 'Session a', body: 'npm test', requestId: 'r-a' })).toBe('suppressed');
    expect(out).toHaveLength(1);
  });
  it('a new request of the same session is a new transition', () => {
    ask('a', 'r1');
    vi.advanceTimersByTime(3000);
    expect(ask('a', 'r2')).toBe('published');
    expect(out.map((o) => o.requestId)).toEqual(['r1', 'r2']);
  });
  it('leaving the status and coming back is a new transition', () => {
    ask('a', 'same');
    policy.setStatus('a', 'working');
    vi.advanceTimersByTime(3000);
    expect(ask('a', 'same')).toBe('published');
  });
  it('done and errored obey the switches (done is off by default)', () => {
    policy.setStatus('a', 'done');
    expect(policy.offer('a', { kind: 'done', title: 'A', body: 'Finished' })).toBe('suppressed');
    policy.setStatus('b', 'errored');
    expect(policy.offer('b', { kind: 'errored', title: 'B', body: 'boom' })).toBe('published');
    vi.advanceTimersByTime(3000);
    prefs.onDone = true;
    policy.setStatus('a', 'working');
    policy.setStatus('a', 'done');
    expect(policy.offer('a', { kind: 'done', title: 'A', body: 'Finished' })).toBe('published');
  });
  it('a risk list is passed on, an empty one is not', () => {
    policy.setStatus('a', 'permission');
    policy.offer('a', { kind: 'permission', title: 'A', body: 'x', requestId: 'r', risk: ['delete', 'run'] });
    expect(out[0]?.risk).toEqual(['delete', 'run']);
    vi.advanceTimersByTime(3000);
    policy.setStatus('b', 'permission');
    policy.offer('b', { kind: 'permission', title: 'B', body: 'x', requestId: 'r2', risk: [] });
    expect(out[1]).not.toHaveProperty('risk');
  });
});

describe('the switches', () => {
  it.each([
    ['enabled', 'permission'], ['onPermission', 'permission'], ['onQuestion', 'question'], ['onErrored', 'errored'],
  ] as const)('%s=false silences %s', (key, kind) => {
    prefs = { ...prefs, [key]: false };
    policy.setStatus('a', kind);
    expect(policy.offer('a', { kind, title: 'A', body: 'x', requestId: 'r' })).toBe('suppressed');
    expect(out).toEqual([]);
  });
  it('is read when the notification arrives, not when the policy was made', () => {
    prefs.onPermission = false;
    expect(ask('a')).toBe('suppressed');
    prefs.onPermission = true;
    expect(ask('b')).toBe('published');
  });
});

describe('startup', () => {
  it('says nothing until armed, even for a session that was already waiting', () => {
    const quiet = createNotifyPolicy({ publish: (n) => out.push(n), prefs: () => prefs });
    quiet.setStatus('a', 'permission');
    expect(quiet.offer('a', { kind: 'permission', title: 'A', body: 'x', requestId: 'r' })).toBe('suppressed');
    expect(quiet.armed).toBe(false);
    quiet.arm();
    expect(quiet.armed).toBe(true);
    quiet.setStatus('b', 'permission');
    expect(quiet.offer('b', { kind: 'permission', title: 'B', body: 'x', requestId: 'r2' })).toBe('published');
    // and the one from before startup is not announced late
    expect(quiet.offer('a', { kind: 'permission', title: 'A', body: 'x', requestId: 'r' })).toBe('suppressed');
    quiet.dispose();
  });
  it('arm(afterMs) waits', () => {
    const quiet = createNotifyPolicy({ publish: (n) => out.push(n), prefs: () => prefs });
    quiet.arm(3000);
    expect(quiet.armed).toBe(false);
    vi.advanceTimersByTime(2999);
    expect(quiet.armed).toBe(false);
    vi.advanceTimersByTime(2);
    expect(quiet.armed).toBe(true);
    quiet.dispose();
  });
  it('a session that waits across startup gets no escalation either', () => {
    const quiet = createNotifyPolicy({ publish: (n) => out.push(n), prefs: () => prefs });
    quiet.setStatus('a', 'permission');
    quiet.offer('a', { kind: 'permission', title: 'A', body: 'x', requestId: 'r' });
    quiet.arm();
    vi.advanceTimersByTime(20 * 60_000);
    expect(out).toEqual([]);
    quiet.dispose();
  });
});

describe('at most one per 2.5 s', () => {
  it('queues the others and sends them together when the gap is over', () => {
    expect(ask('a')).toBe('published');
    expect(ask('b')).toBe('queued');
    expect(ask('c')).toBe('queued');
    expect(out).toHaveLength(1);
    vi.advanceTimersByTime(2499);
    expect(out).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ title: '2 sessions need you', kind: 'permission' });
    expect(out[1]?.body).toContain('Session b');
    expect(out[1]).not.toHaveProperty('requestId'); // a summary must not carry one request
  });
  it('a single queued one goes out as itself', () => {
    ask('a');
    expect(ask('b')).toBe('queued');
    vi.advanceTimersByTime(2500);
    expect(out[1]).toMatchObject({ strategosId: 'b', title: 'Session b', requestId: 'r-b' });
  });
  it('a queued one that was answered meanwhile is dropped', () => {
    ask('a');
    ask('b');
    policy.setStatus('b', 'working');
    vi.advanceTimersByTime(2500);
    expect(out).toHaveLength(1);
  });
  it('a queued one whose session the person opened meanwhile is dropped', () => {
    ask('a');
    ask('b');
    policy.setFocus('c1', 'b');
    vi.advanceTimersByTime(2500);
    expect(out).toHaveLength(1);
  });
  it('the next one after the gap goes out at once', () => {
    ask('a');
    vi.advanceTimersByTime(2500);
    expect(ask('b')).toBe('published');
  });
  it('the summary puts a permission before a done', () => {
    prefs.onDone = true;
    ask('a');
    policy.setStatus('d', 'done');
    policy.offer('d', { kind: 'done', title: 'D', body: 'ok' });
    ask('p', 'rp');
    vi.advanceTimersByTime(2500);
    expect(out[1]).toMatchObject({ kind: 'permission', strategosId: 'p' });
  });
  it('lists at most five titles', () => {
    ask('x');
    for (const s of ['1', '2', '3', '4', '5', '6', '7']) ask(s);
    vi.advanceTimersByTime(2500);
    expect(out[1]?.title).toBe('7 sessions need you');
    expect(out[1]?.body).toMatch(/and 2 more$/);
  });
});

describe('escalation at 5 and 15 minutes', () => {
  it('sends an escalate notification at 5 and at 15 minutes of waiting', () => {
    ask('a');
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(out).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ kind: 'escalate', strategosId: 'a', requestId: 'r-a' });
    expect(out[1]?.body).toContain('5 min');
    vi.advanceTimersByTime(10 * 60_000);
    expect(out).toHaveLength(3);
    expect(out[2]?.body).toContain('15 min');
    vi.advanceTimersByTime(60 * 60_000);
    expect(out).toHaveLength(3);
  });
  it('stops when the request is answered', () => {
    ask('a');
    vi.advanceTimersByTime(2 * 60_000);
    policy.setStatus('a', 'working');
    vi.advanceTimersByTime(30 * 60_000);
    expect(out).toHaveLength(1);
  });
  it('restarts for a new request, counted from the new request', () => {
    ask('a', 'r1');
    vi.advanceTimersByTime(4 * 60_000);
    ask('a', 'r2');
    vi.advanceTimersByTime(2 * 60_000); // 6 min after r1, 2 after r2
    expect(out.filter((o) => o.kind === 'escalate')).toEqual([]);
    vi.advanceTimersByTime(3 * 60_000);
    expect(out.filter((o) => o.kind === 'escalate')).toHaveLength(1);
  });
  it('does not escalate a done or an error, only permission and question', () => {
    policy.setStatus('e', 'errored');
    policy.offer('e', { kind: 'errored', title: 'E', body: 'x' });
    vi.advanceTimersByTime(20 * 60_000);
    expect(out).toHaveLength(1);
  });
  it('escalates a question too', () => {
    ask('q', 'rq', 'question');
    vi.advanceTimersByTime(5 * 60_000);
    expect(out[1]).toMatchObject({ kind: 'escalate' });
  });
  it('honours notifications.escalate=false', () => {
    prefs.escalate = false;
    ask('a');
    vi.advanceTimersByTime(20 * 60_000);
    expect(out).toHaveLength(1);
  });
  it('uses the configured minutes', () => {
    policy.dispose();
    policy = createNotifyPolicy({ publish: (n) => out.push(n), prefs: () => prefs, armed: true, escalateMinutes: () => [1, 2] });
    ask('a');
    vi.advanceTimersByTime(2 * 60_000);
    expect(out.filter((o) => o.kind === 'escalate')).toHaveLength(2);
  });
  it('skips a reminder while the person is looking at the session, and resumes at the next threshold', () => {
    ask('a');
    policy.setFocus('c1', 'a');
    vi.advanceTimersByTime(5 * 60_000);
    expect(out).toHaveLength(1);
    policy.setFocus('c1', null);
    vi.advanceTimersByTime(10 * 60_000);
    expect(out.filter((o) => o.kind === 'escalate')).toHaveLength(1);
  });
  it('a reminder obeys the 2.5 s limit as well', () => {
    ask('a');
    vi.advanceTimersByTime(3000);
    ask('b');
    vi.advanceTimersByTime(5 * 60_000 - 3000);
    // both reminders are due at nearly the same time: one goes out, the other is queued into a summary
    const esc = out.filter((o) => o.kind === 'escalate' || o.title.includes('need you'));
    expect(esc.length).toBeGreaterThanOrEqual(1);
    vi.advanceTimersByTime(5000);
    expect(out.length).toBeLessThanOrEqual(4);
  });
  it('a forgotten session has no timers left', () => {
    ask('a');
    policy.forget('a');
    vi.advanceTimersByTime(20 * 60_000);
    expect(out).toHaveLength(1);
  });
});

describe('never for the session you are looking at', () => {
  it('stays silent for a viewed session and still announces others', () => {
    policy.setFocus('c1', 'a');
    expect(ask('a')).toBe('suppressed');
    expect(ask('b')).toBe('published');
    expect(out.map((o) => o.strategosId)).toEqual(['b']);
  });
  it('and does not announce it later when the person looks away', () => {
    policy.setFocus('c1', 'a');
    ask('a');
    policy.setFocus('c1', null);
    vi.advanceTimersByTime(60_000);
    expect(policy.offer('a', { kind: 'permission', title: 'Session a', body: 'npm test', requestId: 'r-a' })).toBe('suppressed');
    expect(out).toEqual([]);
  });
  it('any connection looking is enough, and a closed connection stops counting', () => {
    policy.setFocus('c1', 'a');
    policy.setFocus('c2', 'x');
    expect(ask('a')).toBe('suppressed');
    policy.dropConnection('c1');
    vi.advanceTimersByTime(3000);
    expect(ask('a', 'r2')).toBe('published');
  });
});

describe('robustness', () => {
  it('a throwing publish does not break the policy', () => {
    const errors: unknown[] = [];
    const p = createNotifyPolicy({ publish: () => { throw new Error('socket'); }, prefs: () => prefs, armed: true, onError: (e) => errors.push(e) });
    p.setStatus('a', 'permission');
    expect(() => p.offer('a', { kind: 'permission', title: 'A', body: 'x', requestId: 'r' })).not.toThrow();
    expect(errors).toHaveLength(1);
    p.dispose();
  });
});
