import { isNeedsYou, type SessionRecord } from '@strategos/shared';
import { useEffect } from 'preact/hooks';
import { fmtWait, money, startOfLocalDay, waitingMs } from '../format.ts';
import { now } from '../state/clock.ts';
import { fire } from '../state/commands.ts';
import { focusInitiativeChip } from '../map/model.ts';
import { groupBy, newSessionOpen, setGroupBy, view } from '../state/ui.ts';
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

  const waitTip = `Waiting now ${c.needs === 0 ? '0m' : fmtWait(c.waitingNowMs)}${c.needs > 1 ? ` (oldest ${fmtWait(c.oldestMs)})` : ''} · today ${waitingToday(today?.totals.waitingMs)}`;
  const spend = today?.totals.costUsd ?? total;
  return (
    <header class="sumbar">
      <h1 class="brand">Strategos</h1>
      <span class={`need ${c.needs === 0 ? 'none' : ''}`} aria-label={`${c.needs} need you`} title={waitTip}>◆ {c.needs} need{c.needs === 1 ? 's' : ''} you</span>
      <span class="m"><b>{c.working}</b> working</span>
      <span class="m"><b>{c.done}</b> done</span>
      <span class="m"><b>{c.stopped}</b> stopped</span>
      {usage?.fiveHour ? <span class="m">5h <b>{Math.round(usage.fiveHour.pct)}%</b></span> : null}
      {usage?.sevenDay ? <span class="m">7d <b>{Math.round(usage.sevenDay.pct)}%</b></span> : null}
      {store.initiatives.value.filter((i) => !i.archived).map((i) => (
        <button
          key={i.id} type="button" class="ichip" style={`--ic:${i.colour}`} title={`Initiative: ${i.name}`}
          onMouseEnter={() => { focusInitiativeChip.value = i.id; }} onMouseLeave={() => { focusInitiativeChip.value = null; }}
          onFocus={() => { focusInitiativeChip.value = i.id; }} onBlur={() => { focusInitiativeChip.value = null; }}
        >{i.name}</button>
      ))}
      <span class="sp" />
      <button
        type="button" class="quiet" aria-keyshortcuts="g" title="Group planets by repo or by initiative (g)"
        onClick={() => {
          const next = groupBy.value === 'repo' ? 'initiative' : 'repo';
          setGroupBy(next);
          fire({ c: 'prefs.set', prefs: { groupBy: next } });
        }}
      >Group: {groupBy.value === 'repo' ? 'Repo' : 'Initiative'}</button>
      <div class="seg" role="group" aria-label="View">
        <button type="button" class={view.value === 'map' ? 'on' : ''} aria-pressed={view.value === 'map'} onClick={() => { view.value = 'map'; }}>Map</button>
        <button
          type="button" class={view.value === 'list' ? 'on' : ''} aria-pressed={view.value === 'list'} aria-keyshortcuts="Shift+L"
          title="Session list (Shift+L)" onClick={() => { view.value = 'list'; }}
        >List</button>
      </div>
      {conn !== 'open' ? <span class={`conn ${conn}`} role="status">{CONN_TEXT[conn]}</span> : <span class="sr-only" role="status">{CONN_TEXT[conn]}</span>}
      <button type="button" class="quiet" aria-keyshortcuts="c" onClick={() => { newSessionOpen.value = true; }}>New session</button>
      <span class="m spend" title={today ? 'Spend today, from the daemon log' : 'Spend across all sessions'}>Spend today <b class="mono">{money(spend)}</b></span>
    </header>
  );
}
