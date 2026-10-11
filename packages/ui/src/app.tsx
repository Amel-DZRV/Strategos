import { useEffect } from 'preact/hooks';
import { ConfirmStopDialog } from './dialogs/ConfirmStop.tsx';
import { NewSessionDialog } from './dialogs/NewSession.tsx';
import { Drawer } from './drawer/Drawer.tsx';
import { handleKey, focusRow } from './keys/global-keys.ts';
import { NeedsStrip, SessionRows } from './rows/SessionRows.tsx';
import { shell, titleFor } from './shell-bridge.ts';
import { startClock } from './state/clock.ts';
import { store } from './state/store.ts';
import { closeDrawer, drawerOpen, errorNotice, newSessionOpen, selectedId, stopTarget } from './state/ui.ts';
import { TopBar } from './topbar/TopBar.tsx';

export function App() {
  const sel = selectedId.value ? store.sessions.value.get(selectedId.value) : undefined;
  const open = drawerOpen.value && sel !== undefined;
  const needs = store.needsYou.value.length;

  useEffect(() => startClock(), []);
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
    <div class={`app ${open ? 'with-drawer' : ''}`}>
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
      <NeedsStrip />
      <div class="body">
        <main id="sessions" class="main" tabIndex={-1}>
          <SessionRows />
        </main>
        {open && sel ? (
          <Drawer
            session={sel}
            onClose={() => { closeDrawer(); focusRow(sel.strategosId); }}
            onLeaveTerminal={() => focusRow(sel.strategosId)}
          />
        ) : null}
      </div>
      {/* Polite live region: new needs-you items are announced without stealing focus. */}
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{store.announcement.value}</div>
      {newSessionOpen.value ? <NewSessionDialog /> : null}
      {stopTarget.value !== null ? <ConfirmStopDialog id={stopTarget.value} /> : null}
    </div>
  );
}
