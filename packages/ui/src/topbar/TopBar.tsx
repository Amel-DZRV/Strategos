import { isNeedsYou, type SessionRecord } from '@strategos/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmtWait, money, startOfLocalDay, waitingMs } from '../format.ts';
import { now } from '../state/clock.ts';
import { fire } from '../state/commands.ts';
import { focusInitiativeChip } from '../map/model.ts';
import { groupBy, initiativeDialog, missionOpen, newSessionOpen, paletteOpen, setGroupBy, view } from '../state/ui.ts';
import { store, type ConnStatus } from '../state/store.ts';
import { paletteLabel } from '../keys/keymap.ts';
import { enableNotifications, permission } from '../notify/notifications.tsx';
import { UsageGauge } from './UsageGauge.tsx';

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

/** The quiet "⋯" menu: everything that is not the state of the work (view, grouping, notifications, palette, initiatives). */
export function MoreMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  const grouped = groupBy.value;
  return (
    <div class="more" ref={root} onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}>
      <button
        type="button" class="quiet small" aria-haspopup="menu" aria-expanded={open} aria-label="More" title="View, grouping, notifications, command palette"
        onClick={() => setOpen(!open)}
      >⋯</button>
      {open ? (
        <div class="menu" role="menu" aria-label="More">
          <button type="button" role="menuitemradio" aria-checked={view.value === 'map'} onClick={pick(() => { view.value = 'map'; })}>Map</button>
          <button type="button" role="menuitemradio" aria-checked={view.value === 'list'} aria-keyshortcuts="Shift+L" onClick={pick(() => { view.value = 'list'; })}>List <kbd>Shift+L</kbd></button>
          <hr />
          <button
            type="button" role="menuitem" aria-keyshortcuts="g"
            onClick={pick(() => {
              const next = grouped === 'repo' ? 'initiative' : 'repo';
              setGroupBy(next);
              fire({ c: 'prefs.set', prefs: { groupBy: next } });
            })}
          >Group by {grouped === 'repo' ? 'initiative' : 'repo'} <kbd>g</kbd></button>
          {permission.value === 'default' && store.prefs.value.notifications.enabled ? (
            <button type="button" role="menuitem" onClick={pick(() => { void enableNotifications(); })}>Enable notifications</button>
          ) : null}
          <hr />
          <button type="button" role="menuitem" aria-keyshortcuts="Control+K Meta+K" onClick={pick(() => { paletteOpen.value = true; })}>Command palette <kbd>{paletteLabel()}</kbd></button>
          <button type="button" role="menuitem" onClick={pick(() => { initiativeDialog.value = {}; })}>New initiative…</button>
          <button type="button" role="menuitem" onClick={pick(() => { missionOpen.value = true; })}>Start a mission…</button>
        </div>
      ) : null}
    </div>
  );
}

export function TopBar() {
  const nowMs = now.value;
  const c = computeCounts(store.sessions.value.values(), nowMs);
  const total = [...store.sessions.value.values()].reduce((a, s) => a + s.cost.lineageUsd, 0);
  const conn = store.connection.value;
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
      <UsageGauge />
      {store.initiatives.value.filter((i) => !i.archived).map((i) => (
        <button
          key={i.id} type="button" class="ichip" style={`--ic:${i.colour}`} title={`Initiative: ${i.name} (click to edit)`}
          onClick={() => { initiativeDialog.value = { id: i.id }; }}
          onMouseEnter={() => { focusInitiativeChip.value = i.id; }} onMouseLeave={() => { focusInitiativeChip.value = null; }}
          onFocus={() => { focusInitiativeChip.value = i.id; }} onBlur={() => { focusInitiativeChip.value = null; }}
        >{i.name}</button>
      ))}
      <span class="sp" />
      {conn !== 'open' ? <span class={`conn ${conn}`} role="status">{CONN_TEXT[conn]}</span> : <span class="sr-only" role="status">{CONN_TEXT[conn]}</span>}
      <span class="m spend" title={today ? 'Spend today, from the daemon log' : 'Spend across all sessions'}>Spend today <b class="mono">{money(spend)}</b></span>
      <button type="button" class="quiet small" aria-keyshortcuts="c" title="New session (c)" onClick={() => { newSessionOpen.value = true; }}>New session</button>
      <MoreMenu />
    </header>
  );
}
