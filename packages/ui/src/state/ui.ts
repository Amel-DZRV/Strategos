// View state that belongs to this browser tab only (selection, open drawer, dialogs). Never authoritative data.
import { signal } from '@preact/signals';

export type DrawerTab = 'term' | 'chat' | 'review';

export const selectedId = signal<string | null>(null);
export const drawerOpen = signal(false);
export const drawerTab = signal<DrawerTab>('term');
export const newSessionOpen = signal(false);
export const stopTarget = signal<string | null>(null);
/** Bumped by the `d` key: the pending card focuses its optional deny message. */
export const denyFocusTick = signal(0);

/** A visible error from a refused or failed command (role="alert"). */
export const errorNotice = signal('');

export function selectSession(id: string | null): void {
  selectedId.value = id;
}

export function openDrawer(id: string, tab?: DrawerTab): void {
  selectedId.value = id;
  drawerOpen.value = true;
  if (tab) drawerTab.value = tab;
}

export function closeDrawer(): void {
  drawerOpen.value = false;
}
