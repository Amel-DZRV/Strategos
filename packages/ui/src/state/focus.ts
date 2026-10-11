// Tells the daemon which session this window is showing (`view.focus`), so it raises no notification for it. The drawer
// open or closed, a different selection and a hidden window all change it. The daemon keeps it per connection and a new
// connection starts with none, so each connection is told only when there is something to say.
import { effect } from '@preact/signals';
import { fire } from './commands.ts';
import { store } from './store.ts';
import { drawerOpen, selectedId } from './ui.ts';

const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** The session id the window is looking at right now, or null. */
export function focusedSession(): string | null {
  const id = selectedId.value;
  return drawerOpen.value && id !== null && store.sessions.value.has(id) && !hidden() ? id : null;
}

export function startViewFocus(): () => void {
  let told: string | null = null; // what the daemon holds for this connection
  let wasOpen = false;
  const push = () => {
    if (store.connection.value !== 'open') return;
    const id = focusedSession();
    if (id === told) return;
    told = id;
    fire({ c: 'view.focus', strategosId: id });
  };
  const stop = effect(() => {
    const open = store.connection.value === 'open';
    if (open && !wasOpen) told = null; // a new connection holds nothing
    wasOpen = open;
    push();
  });
  const onVis = () => push();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVis);
  };
}
