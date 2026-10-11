// Notification policy (tasks 2.09 and 4.05). Ported idea: Bot Crossing's chimeForNewWaiting ("chime on a NEW waiting session,
// not on every poll").
//
// The reducer raises a `notify` effect when a session ENTERS a needs-you status (or finishes, or fails). This decides whether
// that effect becomes a published `notify` event:
//
//   - transition only      the same (session, kind, request) is announced once; leaving the status and coming back is new
//   - none at startup      until arm() is called (the daemon arms a moment after it has recovered and listened), and
//                          nothing is ever raised by a new WebSocket connection or a snapshot: connecting is not a transition
//   - at most 1 per 2.5 s  the rest wait and go out together as one summary notification ("3 sessions need you")
//   - escalation           a session still waiting for a permission or an answer gets a second notification (kind
//                          'escalate') after each of `thresholds.escalateMinutes` (5 and 15 by default)
//   - never for the one you are looking at   the UI says which session it shows (`view.focus`, `pty.focus`)
//   - the person's switches   notifications.{enabled,onPermission,onQuestion,onErrored,onDone,escalate}
//
// It only decides; it never touches a session. `publish` is whatever sends the event.
import type { NotificationPrefs, RiskClass } from '@strategos/shared';

export type NotifyKind = 'permission' | 'question' | 'errored' | 'done' | 'escalate';

export interface NotifyInput {
  kind: Exclude<NotifyKind, 'escalate'>;
  title: string;
  body: string;
  requestId?: string;
  risk?: RiskClass[];
}

export interface NotifyOut {
  kind: NotifyKind;
  strategosId: string;
  title: string;
  body: string;
  risk?: RiskClass[];
  requestId?: string;
}

export type Outcome = 'published' | 'queued' | 'suppressed';

export interface NotifyPolicyOptions {
  publish: (n: NotifyOut) => void;
  prefs: () => NotificationPrefs;
  /** Minutes of waiting after which to escalate. Default [5, 15]. */
  escalateMinutes?: () => readonly number[];
  now?: () => number;
  /** Default 2500. */
  minGapMs?: number;
  /** Start armed (tests). Default false: call arm(). */
  armed?: boolean;
  onError?: (err: unknown) => void;
}

export interface NotifyPolicy {
  /** A `notify` effect of the reducer for session `sid`. */
  offer(sid: string, n: NotifyInput): Outcome;
  /** The session's new status, BEFORE offer() for the effects of the same step. */
  setStatus(sid: string, status: string): void;
  /** One UI connection says which session it is showing (null: none). */
  setFocus(connId: string, sid: string | null): void;
  dropConnection(connId: string): void;
  /** Allow notifications, now or after `afterMs`. */
  arm(afterMs?: number): void;
  readonly armed: boolean;
  forget(sid: string): void;
  dispose(): void;
}

const PRIORITY: readonly NotifyKind[] = ['permission', 'question', 'errored', 'done', 'escalate'];
const isWaiting = (status: string | undefined): boolean => status === 'permission' || status === 'question';

interface Waiting {
  input: NotifyInput;
  timers: NodeJS.Timeout[];
}

export function createNotifyPolicy(o: NotifyPolicyOptions): NotifyPolicy {
  const now = o.now ?? Date.now;
  const gap = o.minGapMs ?? 2500;
  const onError = o.onError ?? ((): void => undefined);
  let armed = o.armed ?? false;
  let armTimer: NodeJS.Timeout | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let lastPublishAt = -Infinity;
  let queue: NotifyOut[] = [];
  const status = new Map<string, string>();
  const lastKey = new Map<string, string>();
  const waiting = new Map<string, Waiting>();
  const focus = new Map<string, string>(); // connId -> sid

  const viewed = (sid: string): boolean => {
    for (const s of focus.values()) if (s === sid) return true;
    return false;
  };

  const kindEnabled = (k: NotifyInput['kind']): boolean => {
    const p = o.prefs();
    if (!p.enabled) return false;
    switch (k) {
      case 'permission': return p.onPermission;
      case 'question': return p.onQuestion;
      case 'errored': return p.onErrored;
      case 'done': return p.onDone;
    }
  };

  function send(n: NotifyOut): void {
    try {
      o.publish(n);
    } catch (err) {
      onError(err);
    }
  }

  /** Is this queued notification still true? A permission that was answered while it waited is not worth saying. */
  const stillTrue = (n: NotifyOut): boolean =>
    !viewed(n.strategosId) && (n.kind === 'permission' || n.kind === 'question' || n.kind === 'escalate' ? isWaiting(status.get(n.strategosId)) : true);

  function flush(): void {
    flushTimer = undefined;
    // one entry per session: the latest
    const bySid = new Map<string, NotifyOut>();
    for (const n of queue) if (stillTrue(n)) bySid.set(n.strategosId, n);
    queue = [];
    const items = [...bySid.values()];
    if (items.length === 0) return;
    lastPublishAt = now();
    if (items.length === 1) { send(items[0]!); return; }
    items.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
    const first = items[0]!;
    send({
      kind: first.kind,
      strategosId: first.strategosId,
      title: `${items.length} sessions need you`,
      body: items.slice(0, 5).map((i) => i.title).join(', ') + (items.length > 5 ? ` and ${items.length - 5} more` : ''),
    });
  }

  function emit(n: NotifyOut): Outcome {
    const t = now();
    if (queue.length === 0 && t - lastPublishAt >= gap) {
      lastPublishAt = t;
      send(n);
      return 'published';
    }
    queue.push(n);
    if (flushTimer === undefined) {
      flushTimer = setTimeout(flush, Math.max(0, lastPublishAt + gap - t));
      flushTimer.unref();
    }
    return 'queued';
  }

  function clearWaiting(sid: string): void {
    const w = waiting.get(sid);
    if (w === undefined) return;
    for (const t of w.timers) clearTimeout(t);
    waiting.delete(sid);
  }

  function escalate(sid: string, minutes: number): void {
    const w = waiting.get(sid);
    if (w === undefined || !armed || !isWaiting(status.get(sid))) return;
    const p = o.prefs();
    if (!p.enabled || !p.escalate || !kindEnabled(w.input.kind) || viewed(sid)) return;
    emit({
      kind: 'escalate',
      strategosId: sid,
      title: `Still waiting: ${w.input.title}`,
      body: `${minutes} min. ${w.input.body}`,
      ...(w.input.risk === undefined || w.input.risk.length === 0 ? {} : { risk: w.input.risk }),
      ...(w.input.requestId === undefined ? {} : { requestId: w.input.requestId }),
    });
  }

  function startWaiting(sid: string, n: NotifyInput): void {
    clearWaiting(sid);
    const timers: NodeJS.Timeout[] = [];
    for (const m of [...(o.escalateMinutes?.() ?? [5, 15])].filter((x) => x > 0).sort((a, b) => a - b)) {
      const t = setTimeout(() => { try { escalate(sid, m); } catch (err) { onError(err); } }, m * 60_000);
      t.unref();
      timers.push(t);
    }
    waiting.set(sid, { input: n, timers });
  }

  return {
    get armed() { return armed; },

    offer(sid, n) {
      const key = `${n.kind}:${n.requestId ?? ''}`;
      if (!armed) { lastKey.set(sid, key); return 'suppressed'; }
      if (!kindEnabled(n.kind)) return 'suppressed';
      if (lastKey.get(sid) === key) return 'suppressed'; // already announced: not a new transition
      lastKey.set(sid, key);
      if (n.kind === 'permission' || n.kind === 'question') startWaiting(sid, n);
      if (viewed(sid)) return 'suppressed';
      return emit({
        kind: n.kind, strategosId: sid, title: n.title, body: n.body,
        ...(n.risk === undefined || n.risk.length === 0 ? {} : { risk: n.risk }),
        ...(n.requestId === undefined ? {} : { requestId: n.requestId }),
      });
    },

    setStatus(sid, st) {
      const prev = status.get(sid);
      status.set(sid, st);
      if (prev !== st) lastKey.delete(sid);
      if (!isWaiting(st)) clearWaiting(sid);
    },

    setFocus(connId, sid) {
      if (sid === null) focus.delete(connId);
      else focus.set(connId, sid);
    },
    dropConnection(connId) {
      focus.delete(connId);
    },

    arm(afterMs = 0) {
      if (afterMs <= 0) { armed = true; return; }
      armTimer ??= setTimeout(() => { armed = true; armTimer = undefined; }, afterMs);
      armTimer.unref();
    },

    forget(sid) {
      clearWaiting(sid);
      status.delete(sid);
      lastKey.delete(sid);
      queue = queue.filter((q) => q.strategosId !== sid);
    },

    dispose() {
      for (const sid of [...waiting.keys()]) clearWaiting(sid);
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      if (armTimer !== undefined) clearTimeout(armTimer);
      flushTimer = undefined;
      armTimer = undefined;
      queue = [];
    },
  };
}

