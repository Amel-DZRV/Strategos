import { isNeedsYou, type SessionRecord } from '@strategos/shared';
import { useEffect } from 'preact/hooks';
import { fmtWait, money, startOfLocalDay, waitingMs } from '../format.ts';
import { now } from '../state/clock.ts';
import { fire } from '../state/commands.ts';
import { newSessionOpen } from '../state/ui.ts';
import { store, type ConnStatus } from '../state/store.ts';

const CONN_TEXT: Record<ConnStatus, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Daemon unreachable, reconnecting…',
  unpaired: 'Not paired. Open Strategos from its launcher.',
  incompatible: 'Version mismatch with the daemon. Reload after updating.',
};

export interface Counts {
  needs: number;
  working: number;
  done: number;
  stopped: number;
  /** Sum of how long the needs-you items have been waiting, right now. */
  waitingNowMs: number;
  oldestMs: number;
}

export function computeCounts(sessions: Iterable<SessionRecord>, nowMs: number): Counts {
  const c: Counts = { needs: 0, working: 0, done: 0, stopped: 0, waitingNowMs: 0, oldestMs: 0 };
  for (const s of sessions) {
    if (s.archived) continue;
    if (isNeedsYou(s)) {
      c.needs++;
      const w = waitingMs(s, nowMs);
      c.waitingNowMs += w;
      c.oldestMs = Math.max(c.oldestMs, w);
    }
    if (s.status === 'working' || s.status === 'starting') c.working++;
    else if (s.status === 'done' && !isNeedsYou(s)) c.done++;
    else if (s.status === 'stopped' || s.status === 'parked') c.stopped++;
  }
  return c;
}

/** Waiting today = what the daemon's event log says was already waited today (digest) plus nothing we guess. */
export function waitingToday(digestWaitingMs: number | undefined): string {
  return digestWaitingMs === undefined ? '–' : fmtWait(digestWaitingMs);
}

export function TopBar() {
  const nowMs = now.value;
  const c = computeCounts(store.sessions.value.values(), nowMs);
  const total = [...store.sessions.value.values()].reduce((a, s) => a + s.cost.lineageUsd, 0);
  const conn = store.connection.value;
  const usage = store.usage.value;
  const today = store.digestToday.value;

  // Ask the daemon for today's totals once connected, then every minute. (digest.get is a protocol command.)
  const synced = store.synced.value;
  useEffect(() => {
    if (!synced) return;
    const ask = () => fire({ c: 'digest.get', since: startOfLocalDay(Date.now()) });
    ask();
    const t = setInterval(ask, 60_000);
    return () => clearInterval(t);
  }, [synced]);

  return (
    <header class="sumbar">
      <h1 class="brand">Strategos</h1>
      <span class={`need ${c.needs === 0 ? 'none' : ''}`} aria-label={`${c.needs} need you`}>◆ {c.needs} need{c.needs === 1 ? 's' : ''} you</span>
      <span class="m"><b class="tint-work">{c.working}</b> working</span>
      <span class="m"><b class="tint-ready">{c.done}</b> done</span>
      <span class="m"><b>{c.stopped}</b> stopped</span>
      <span class="m waiting" title="Time owners spent waiting: right now (sum over what needs you) and today (daemon log)">
        Waiting now <b>{c.needs === 0 ? '0m' : fmtWait(c.waitingNowMs)}</b>
        {c.needs > 1 ? <small> (oldest {fmtWait(c.oldestMs)})</small> : null}
        {' · '}today <b>{waitingToday(today?.totals.waitingMs)}</b>
      </span>
      {usage?.fiveHour ? <span class="m">5h <b>{Math.round(usage.fiveHour.pct)}%</b></span> : null}
      {usage?.sevenDay ? <span class="m">7d <b>{Math.round(usage.sevenDay.pct)}%</b></span> : null}
      <span class="sp" />
      <span class="m">Spend <b class="mono">{money(total)}</b></span>
      <span class={`conn ${conn}`} role="status">{CONN_TEXT[conn]}</span>
      <button type="button" class="btn primary" aria-keyshortcuts="c" onClick={() => { newSessionOpen.value = true; }}>New session</button>
    </header>
  );
}
