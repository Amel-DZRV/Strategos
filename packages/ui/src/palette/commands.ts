// The command palette's list (4.09): every key action from the shared registry, plus actions that only have buttons
// (slash commands, batch approve, notifications, view switches). Disabled commands stay listed, greyed, so the palette
// teaches what exists.
import { canSendSlash, sendSlash } from '../drawer/ContextActions.tsx';
import { canPerform, perform } from '../keys/actions.ts';
import { KEY_ACTIONS, type ActionId } from '../keys/keymap.ts';
import { currentLowRisk } from '../features/lowrisk.ts';
import { enableNotifications, permission } from '../notify/notifications.tsx';
import { store } from '../state/store.ts';
import { lowRiskOpen, openDrawer, selectedId, view } from '../state/ui.ts';

export interface PaletteCommand {
  id: string;
  label: string;
  /** Key hint shown on the right. */
  keys?: string;
  /** The key action this command stands for, when it is one. */
  action?: ActionId;
  enabled(): boolean;
  run(): void;
}

const selected = () => (selectedId.value ? store.sessions.value.get(selectedId.value) : undefined);

function keyCommands(): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  for (const a of KEY_ACTIONS) {
    if (a.id === 'option') {
      for (let n = 1; n <= 9; n++) {
        out.push({
          id: `option:${n}`, action: 'option', label: `Answer with option ${n}`, keys: String(n),
          enabled: () => canPerform('option', { option: n }), run: () => { perform('option', { option: n }); },
        });
      }
      continue;
    }
    out.push({ id: a.id, action: a.id, label: a.label, keys: a.show, enabled: () => canPerform(a.id), run: () => { perform(a.id); } });
  }
  return out;
}

const slash = (id: string, label: string, cmd: Parameters<typeof sendSlash>[1], needsMod = false): PaletteCommand => ({
  id, label,
  enabled: () => {
    const s = selected();
    return !!s && canSendSlash(s) && (!needsMod || store.prefs.value.mods?.autoHandoff === true);
  },
  run: () => { const s = selected(); if (s) void sendSlash(s.strategosId, cmd); },
});

function extraCommands(): PaletteCommand[] {
  return [
    {
      id: 'lowrisk', label: 'Approve all low-risk requests…', enabled: () => currentLowRisk().length > 0, run: () => { lowRiskOpen.value = true; },
    },
    slash('compact', 'Compact the selected session (/compact)', '/compact'),
    slash('handoff', 'Hand off the selected session (/handoff-now)', '/handoff-now', true),
    slash('keepwarm60', 'Keep cache warm for 60 minutes', '/keepwarm 60m'),
    slash('keepwarm90', 'Keep cache warm for 90 minutes', '/keepwarm 90m'),
    slash('keepwarm2h', 'Keep cache warm for 2 hours', '/keepwarm 2h'),
    {
      id: 'chat', label: 'Show the chat view of the selected session', enabled: () => selected() !== undefined,
      run: () => { const s = selected(); if (s) openDrawer(s.strategosId, 'chat'); },
    },
    {
      id: 'terminal-view', label: 'Show the terminal of the selected session', enabled: () => selected() !== undefined,
      run: () => { const s = selected(); if (s) openDrawer(s.strategosId, 'term'); },
    },
    { id: 'view-map', label: 'Show the Map', enabled: () => view.value !== 'map', run: () => { view.value = 'map'; } },
    { id: 'view-list', label: 'Show the session list', enabled: () => view.value !== 'list', run: () => { view.value = 'list'; } },
    { id: 'notifications', label: 'Enable desktop notifications', enabled: () => permission.value === 'default', run: () => { void enableNotifications(); } },
  ];
}

export function paletteCommands(): PaletteCommand[] {
  return [...keyCommands(), ...extraCommands()];
}
