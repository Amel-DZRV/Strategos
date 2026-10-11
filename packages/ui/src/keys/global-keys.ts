// Keyboard shortcuts for the Map and the session list (plan section 7). Mouse and keyboard work equally: every key
// here has a button somewhere. The table of keys lives in keymap.ts.
import { always, answerQuestion, approve } from '../drawer/pending-actions.ts';
import { canStop } from '../format.ts';
import { spatialNext } from '../map/model.ts';
import { send, fire } from '../state/commands.ts';
import { store } from '../state/store.ts';
import {
  closeDrawer, denyFocusTick, drawerOpen, drawerTab, errorNotice, groupBy, helpOpen, newSessionOpen, openDrawer, parkTarget,
  selectedId, selectSession, setGroupBy, stopTarget, view,
} from '../state/ui.ts';
import { actionFor } from './keymap.ts';

function typingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t.closest('.xterm')) return true; // in a terminal every key belongs to Claude
  return t.matches('input, textarea, select, [contenteditable="true"]');
}

/** Focus the Map token or the list row of a session. */
export function focusSession(id: string, root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement | SVGElement>('.tok, .row')) if (el.dataset['sid'] === id) { el.focus(); return; }
}
/** Older name, kept for the list view's callers. */
export const focusRow = focusSession;

function select(id: string): void {
  selectSession(id);
  focusSession(id);
}

function move(delta: number, onlyNeeds: boolean): void {
  const list = onlyNeeds ? store.needsYou.value : store.sorted.value;
  if (list.length === 0) return;
  const i = list.findIndex((s) => s.strategosId === selectedId.value);
  const next = list[i === -1 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length]!;
  select(next.strategosId);
}

function arrow(dir: 'left' | 'right' | 'up' | 'down'): void {
  if (view.value === 'list') {
    if (dir === 'down') move(1, false);
    else if (dir === 'up') move(-1, false);
    return;
  }
  const id = spatialNext(selectedId.value, dir);
  if (id) select(id);
}

const fail = (what: string) => (err: unknown) => {
  errorNotice.value = `${what} failed: ${err instanceof Error ? err.message : String(err)}`;
};

export function handleKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (typingTarget(e.target) || newSessionOpen.value || stopTarget.value !== null || parkTarget.value !== null) return;
  const act = actionFor(e.key);
  if (!act) return;
  const s = selectedId.value ? store.sessions.value.get(selectedId.value) : undefined;
  const t = e.target;
  // Movement keys only act while focus is on the page, a token or a row; never while a button, link or dialog has it.
  const onMap = t === document.body || (t instanceof Element && (t.classList.contains('row') || t.classList.contains('tok') || t.closest('.mapbox') !== null));

  switch (act.id) {
    case 'help':
      e.preventDefault();
      helpOpen.value = !helpOpen.value;
      break;
    case 'close':
      if (helpOpen.value) { helpOpen.value = false; break; }
      if (drawerOpen.value) {
        closeDrawer();
        if (selectedId.value) focusSession(selectedId.value);
      }
      break;
    case 'approve':
      if (s?.pending) { e.preventDefault(); void approve(s); }
      break;
    case 'always':
      if (s?.pending) { e.preventDefault(); void always(s); }
      break;
    case 'deny':
      if (s?.pending?.kind === 'permission' && s.pending.held) {
        e.preventDefault();
        openDrawer(s.strategosId);
        denyFocusTick.value++;
      }
      break;
    case 'option': {
      const p = s?.pending;
      if (!s || !p || p.kind !== 'question' || !p.held) break;
      e.preventDefault();
      const q = p.questions?.length === 1 ? p.questions[0] : undefined;
      const opt = q && !q.multiSelect ? q.options[(act.option ?? 1) - 1] : undefined;
      if (q && opt) void answerQuestion(s, { [q.question]: opt.label });
      else openDrawer(s.strategosId); // several questions or multi-select: answer on the card
      break;
    }
    case 'seen':
      if (s) {
        e.preventDefault();
        send({ c: 'session.seen', strategosId: s.strategosId }).catch(fail('Mark seen'));
      }
      break;
    case 'next': case 'prev': // Tab stays the browser's: trapping it would break keyboard navigation
      if (store.needsYou.value.length > 0) { e.preventDefault(); move(act.id === 'prev' ? -1 : 1, true); }
      break;
    case 'left': case 'right': case 'up': case 'down':
      if (onMap) { e.preventDefault(); arrow(act.id); }
      break;
    case 'open':
      if (t === document.body && s) { e.preventDefault(); openDrawer(s.strategosId); }
      break;
    case 'terminal':
      if (s) {
        e.preventDefault();
        if (!drawerOpen.value) openDrawer(s.strategosId, 'term');
        else drawerTab.value = drawerTab.value === 'term' ? 'chat' : 'term';
      }
      break;
    case 'review':
      if (s) { e.preventDefault(); openDrawer(s.strategosId, 'review'); }
      break;
    case 'reply':
      if (s) { e.preventDefault(); openDrawer(s.strategosId, 'chat'); } // the reply box itself arrives with the chat view (M5)
      break;
    case 'new':
      e.preventDefault();
      newSessionOpen.value = true;
      break;
    case 'stop':
      if (s && canStop(s)) { e.preventDefault(); stopTarget.value = s.strategosId; }
      break;
    case 'park':
      if (s && canStop(s)) { e.preventDefault(); parkTarget.value = s.strategosId; }
      break;
    case 'group': {
      e.preventDefault();
      const next = groupBy.value === 'repo' ? 'initiative' : 'repo';
      setGroupBy(next);
      fire({ c: 'prefs.set', prefs: { groupBy: next } });
      break;
    }
    case 'list':
      e.preventDefault();
      view.value = view.value === 'map' ? 'list' : 'map';
      break;
    default:
      break;
  }
}
