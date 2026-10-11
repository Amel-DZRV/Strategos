import { useEffect } from 'preact/hooks';
import { ConfirmParkDialog, ConfirmStopDialog } from './dialogs/ConfirmStop.tsx';
import { KeyHelpDialog } from './dialogs/KeyHelp.tsx';
import { LowRiskDialog } from './dialogs/LowRiskDialog.tsx';
import { CommandPalette } from './palette/CommandPalette.tsx';
import { Toasts, useNotifications } from './notify/notifications.tsx';
import { startViewFocus } from './state/focus.ts';
import { SuggestionBanners } from './topbar/UsageGauge.tsx';
import { NewSessionDialog } from './dialogs/NewSession.tsx';
import { AssignInitiativeDialog, InitiativeDialog, MissionDialog } from './dialogs/Initiatives.tsx';
import { RemoveWorktreeDialog } from './dialogs/RemoveWorktree.tsx';
import { Drawer } from './drawer/Drawer.tsx';
import { handleKey, focusRow } from './keys/global-keys.ts';
import { MapView } from './map/MapView.tsx';
import { NeedsStrip } from './map/NeedsStrip.tsx';
import { SessionRows } from './rows/SessionRows.tsx';
import { shell, titleFor } from './shell-bridge.ts';
import { startClock } from './state/clock.ts';
import { store } from './state/store.ts';
import { assignTarget, closeDrawer, drawerOpen, drawerTab, errorNotice, initiativeDialog, missionOpen, removeWorktreeTarget, helpOpen, lowRiskOpen, newSessionOpen, paletteOpen, parkTarget, selectedId, stopTarget, view } from './state/ui.ts';
import { TopBar } from './topbar/TopBar.tsx';

export function App() {
  const sel = selectedId.value ? store.sessions.value.get(selectedId.value) : undefined;
  const open = drawerOpen.value && sel !== undefined;
  const needs = store.needsYou.value.length;

  useEffect(() => startClock(), []);
  useEffect(() => startViewFocus(), []);
  useNotifications();
  useEffect(() => {
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);
  // Title and favicon badge: "(n) Strategos".
  useEffect(() => {
    shell.setBadge(needs);
    if (typeof document !== 'undefined' && document.title !== titleFor(needs)) document.title = titleFor(needs);
  }, [needs]);

  return (
    <div class={`app ${open ? 'with-drawer' : ''} ${open && drawerTab.value === 'review' ? 'wide' : ''}`}>
      <a class="skip" href="#sessions">Skip to sessions</a>
      <TopBar />
      {errorNotice.value ? (
        <div class="banner error" role="alert">
          {errorNotice.value}
          <button type="button" class="btn" onClick={() => { errorNotice.value = ''; }}>Dismiss</button>
        </div>
      ) : null}
      {store.hello.value && !store.hello.value.inRange ? (
        <div class="banner" role="note">
          Claude Code {store.hello.value.claudeVersion} is outside the tested range ({store.hello.value.testedRange}). Status may be less reliable.
        </div>
      ) : null}
      <SuggestionBanners />
      <NeedsStrip />
      <div class="body">
        <main id="sessions" class={`main ${view.value === 'map' ? 'mapmain' : ''}`} tabIndex={-1}>
          {view.value === 'map' ? (
            <>
              <MapView />
              <div class="foot legend"><span>Ring colour: status</span><span>Outer arc: context used</span><span>Pulse: waiting on you</span></div>
            </>
          ) : <SessionRows />}
        </main>
        {open && sel ? (
          <Drawer
            session={sel}
            onClose={() => { closeDrawer(); focusRow(sel.strategosId); }}
            onLeaveTerminal={() => focusRow(sel.strategosId)}
          />
        ) : null}
      </div>
      <div class="foot keyhints" aria-hidden="true">
        <span><kbd>n</kbd> next needing you</span>
        <span><kbd>h</kbd><kbd>j</kbd><kbd>k</kbd><kbd>l</kbd> move</span>
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>a</kbd> approve</span>
        <span><kbd>t</kbd> terminal / chat</span>
        <span><kbd>1</kbd>-<kbd>9</kbd> answer</span>
        <span><kbd>?</kbd> all keys</span>
      </div>
      {/* Polite live region: new needs-you items are announced without stealing focus. */}
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{store.announcement.value}</div>
      <Toasts />
      {helpOpen.value ? <KeyHelpDialog /> : null}
      {paletteOpen.value ? <CommandPalette /> : null}
      {lowRiskOpen.value ? <LowRiskDialog /> : null}
      {parkTarget.value !== null ? <ConfirmParkDialog id={parkTarget.value} /> : null}
      {newSessionOpen.value ? <NewSessionDialog /> : null}
      {stopTarget.value !== null ? <ConfirmStopDialog id={stopTarget.value} /> : null}
      {removeWorktreeTarget.value !== null ? <RemoveWorktreeDialog id={removeWorktreeTarget.value} /> : null}
      {initiativeDialog.value !== null ? <InitiativeDialog {...initiativeDialog.value} /> : null}
      {assignTarget.value !== null ? <AssignInitiativeDialog id={assignTarget.value} /> : null}
      {missionOpen.value ? <MissionDialog /> : null}
    </div>
  );
}
