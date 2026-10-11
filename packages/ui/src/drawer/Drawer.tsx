import { useState } from 'preact/hooks';
import type { SessionRecord } from '@strategos/shared';
import { ChatPane } from '../chat/ChatPane.tsx';
import { branchOf, ctxColour, ctxPct, fmtWait, money, repoName, statusInfo, waitingMs } from '../format.ts';
import { now } from '../state/clock.ts';
import { drawerTab, type DrawerTab } from '../state/ui.ts';
import { ContextActions } from './ContextActions.tsx';
import { PendingCard } from './PendingCard.tsx';
import { TerminalPane } from './TerminalPane.tsx';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'term', label: 'Terminal' },
  { id: 'chat', label: 'Chat' },
  { id: 'review', label: 'Review' },
];

/** Status pill text as in the design: glyph and an upper-case phrase; colour is the status colour, never the only cue. */
export function pillText(s: SessionRecord): string {
  const st = statusInfo(s.status);
  const label = s.status === 'permission' ? 'Needs permission' : s.status === 'question' ? 'Needs an answer' : st.label;
  return `${st.glyph} ${label}`;
}

const TERM_NOTE = 'The real Claude Code, so your mods and slash commands work. Switching is instant: both views read the same live session.';
const CHAT_NOTE = 'The same session read as a conversation, with tool calls and approvals as cards. Switching is instant: both views read the same live session.';

export function DrawerHeader({ s }: { s: SessionRecord }) {
  const st = statusInfo(s.status);
  const pct = ctxPct(s);
  const waiting = s.waitingSince !== undefined || s.status === 'permission' || s.status === 'question';
  const branch = branchOf(s);
  return (
    <header class="drawer-head" style={`--stc:${st.colour}`}>
      <h2>{s.displayName}</h2>
      <div class="sub mono">{repoName(s)}{branch ? ` · ${branch}` : ''}</div>
      <div class="facts">
        <span class="pill" title={waiting ? `${st.label} · waiting ${fmtWait(waitingMs(s, now.value))}` : st.label}>{pillText(s)}</span>
        <span class="ctxline mono" title={pct === null ? 'Context unknown' : `Context used: ${pct}%`}>
          ctx{' '}
          {pct === null ? '–' : (
            <>
              <span class="bar" aria-hidden="true"><i style={{ width: `${pct}%`, background: ctxColour(pct) }} /></span> <span class="pct">{pct}%</span>
            </>
          )}
        </span>
        <span class="cost mono" title="Estimated cost of this session and its lineage">{money(s.cost.lineageUsd)}</span>
      </div>
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
  // The chat mounts the first time it is shown and then stays, like the terminal: switching tabs loses nothing.
  const [chatSeen, setChatSeen] = useState(tab === 'chat');
  if (tab === 'chat' && !chatSeen) setChatSeen(true);
  const live = session.status !== 'stopped' && session.status !== 'parked' && session.status !== 'open_elsewhere';
  return (
    <aside class="drawer" aria-label={`Session ${session.displayName}`}>
      <div class="drawer-top">
        <DrawerHeader s={session} />
        <button type="button" class="btn icon" aria-label="Close drawer" title="Close (Esc)" onClick={onClose}>×</button>
      </div>
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
        {chatSeen ? <ChatPane key={session.strategosId} session={session} active={tab === 'chat'} /> : null}
      </div>
      <div id="panel-review" role="tabpanel" aria-labelledby="tab-review" hidden={tab !== 'review'} class="panel">
        <p class="placeholder">The review view comes in a later milestone (M6).</p>
      </div>
      <ContextActions session={session} />
      {session.pending || tab === 'chat' ? (
        <footer class="drawer-foot">
          {/* In the chat view the pending card sits inline in the conversation instead. */}
          {session.pending && tab !== 'chat' ? <PendingCard session={session} onOpenTerminal={() => { drawerTab.value = 'term'; }} /> : null}
          <p class="footnote">{tab === 'chat' ? CHAT_NOTE : TERM_NOTE}</p>
        </footer>
      ) : null}
    </aside>
  );
}
