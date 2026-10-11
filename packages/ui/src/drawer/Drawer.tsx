import type { SessionRecord } from '@strategos/shared';
import { branchOf, ctxColour, ctxPct, fmtWait, money, repoName, statusInfo, waitingMs } from '../format.ts';
import { now } from '../state/clock.ts';
import { drawerTab, type DrawerTab } from '../state/ui.ts';
import { PendingCard } from './PendingCard.tsx';
import { TerminalPane } from './TerminalPane.tsx';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'term', label: 'Terminal' },
  { id: 'chat', label: 'Chat' },
  { id: 'review', label: 'Review' },
];

export function DrawerHeader({ s }: { s: SessionRecord }) {
  const st = statusInfo(s.status);
  const pct = ctxPct(s);
  const waiting = s.waitingSince !== undefined || s.status === 'permission' || s.status === 'question';
  return (
    <header class="drawer-head" style={`--stc:${st.colour}`}>
      <span class="g" aria-hidden="true">{st.glyph}</span>
      <div class="titles">
        <h2>{s.displayName}</h2>
        <div class="sub mono">{repoName(s)}{branchOf(s) ? ` · ${branchOf(s)}` : ''}</div>
      </div>
      <dl class="facts">
        <div><dt>Status</dt><dd>{st.label}{waiting ? ` · ${fmtWait(waitingMs(s, now.value))}` : ''}</dd></div>
        <div>
          <dt>Context</dt>
          <dd>
            {pct === null ? 'unknown' : (
              <>
                <span class="bar" aria-hidden="true"><i style={{ width: `${pct}%`, background: ctxColour(pct) }} /></span> {pct}%
              </>
            )}
          </dd>
        </div>
        <div><dt>Cost</dt><dd class="mono">{money(s.cost.lineageUsd)}</dd></div>
      </dl>
      {s.last ? <p class="last" title={s.last}>{s.last}</p> : null}
    </header>
  );
}

export interface DrawerProps {
  session: SessionRecord;
  onClose: () => void;
  onLeaveTerminal?: () => void;
}

export function Drawer({ session, onClose, onLeaveTerminal }: DrawerProps) {
  const tab = drawerTab.value;
  const live = session.status !== 'stopped' && session.status !== 'parked' && session.status !== 'open_elsewhere';
  return (
    <aside class="drawer" aria-label={`Session ${session.displayName}`}>
      <div class="drawer-top">
        <DrawerHeader s={session} />
        <button type="button" class="btn icon" aria-label="Close drawer" title="Close (Esc)" onClick={onClose}>×</button>
      </div>
      {session.pending ? <PendingCard session={session} onOpenTerminal={() => { drawerTab.value = 'term'; }} /> : null}
      <div class="tabs" role="tablist" aria-label="Session views">
        {TABS.map((t) => (
          <button
            key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`}
            class={tab === t.id ? 'on' : ''} onClick={() => { drawerTab.value = t.id; }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* All panels stay mounted; only the visible one shows. The terminal must keep its xterm and scrollback. */}
      <div id="panel-term" role="tabpanel" aria-labelledby="tab-term" hidden={tab !== 'term'} class="panel">
        {live ? <TerminalPane key={session.strategosId} strategosId={session.strategosId} onLeave={onLeaveTerminal} /> : (
          <p class="placeholder">This session is not running. Resume it to use its terminal.</p>
        )}
      </div>
      <div id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" hidden={tab !== 'chat'} class="panel">
        <p class="placeholder">The chat view comes in a later milestone (M5).</p>
      </div>
      <div id="panel-review" role="tabpanel" aria-labelledby="tab-review" hidden={tab !== 'review'} class="panel">
        <p class="placeholder">The review view comes in a later milestone (M6).</p>
      </div>
    </aside>
  );
}
