// Keyboard shortcuts for the session list (plan section 7). Mouse and keyboard work equally; every key here has a button.
import { always, approve } from '../drawer/pending-actions.ts';
import { send } from '../state/commands.ts';
import { store } from '../state/store.ts';
import {
  closeDrawer, denyFocusTick, drawerOpen, errorNotice, newSessionOpen, openDrawer, selectedId, selectSession, stopTarget,
} from '../state/ui.ts';

function typingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t.closest('.xterm')) return true; // in a terminal every key belongs to Claude
  return t.matches('input, textarea, select, [contenteditable="true"]');
}

export function focusRow(id: string, root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('.row')) if (el.dataset['sid'] === id) el.focus();
}

function move(delta: number, onlyNeeds: boolean): void {
  const list = onlyNeeds ? store.needsYou.value : store.sorted.value;
  if (list.length === 0) return;
  const i = list.findIndex((s) => s.strategosId === selectedId.value);
  const next = list[i === -1 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length]!;
  selectSession(next.strategosId);
  focusRow(next.strategosId);
}

export function handleKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (typingTarget(e.target) || newSessionOpen.value || stopTarget.value !== null) return;
  const s = selectedId.value ? store.sessions.value.get(selectedId.value) : undefined;
  const onList = e.target === document.body || (e.target instanceof Element && e.target.classList.contains('row'));

  switch (e.key) {
    case 'a':
      if (s?.pending) { e.preventDefault(); void approve(s); }
      break;
    case 'A':
      if (s?.pending) { e.preventDefault(); void always(s); }
      break;
    case 'd':
      if (s?.pending?.kind === 'permission' && s.pending.held) {
        e.preventDefault();
        openDrawer(s.strategosId);
        denyFocusTick.value++;
      }
      break;
    case 'x':
      if (s) {
        e.preventDefault();
        send({ c: 'session.seen', strategosId: s.strategosId }).catch((err: unknown) => {
          errorNotice.value = `Mark seen failed: ${err instanceof Error ? err.message : String(err)}`;
        });
      }
      break;
    case 'n': // Tab stays the browser's: trapping it would break keyboard navigation
      if (store.needsYou.value.length > 0) { e.preventDefault(); move(e.shiftKey ? -1 : 1, true); }
      break;
    case 'j': case 'ArrowDown':
      if (onList) { e.preventDefault(); move(1, false); }
      break;
    case 'k': case 'ArrowUp':
      if (onList) { e.preventDefault(); move(-1, false); }
      break;
    case 'c':
      e.preventDefault();
      newSessionOpen.value = true;
      break;
    case 'Escape':
      if (drawerOpen.value) {
        closeDrawer();
        if (selectedId.value) focusRow(selectedId.value);
      }
      break;
    default:
      break;
  }
}
