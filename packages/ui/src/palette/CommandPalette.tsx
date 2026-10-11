// Ctrl+K / Cmd+K command palette: type to filter (fuzzy), arrows to move, Enter runs, Esc closes.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { paletteOpen } from '../state/ui.ts';
import { paletteCommands, type PaletteCommand } from './commands.ts';
import { fuzzyFilter } from './fuzzy.ts';

export function CommandPalette() {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // Built once per opening: enabled() is read at render so the list reflects the selection when it was opened.
  const all = useMemo(() => paletteCommands(), []);
  const list = useMemo(() => fuzzyFilter(all, query, (c) => c.label), [all, query]);
  // Enabled commands first among equals would reorder the fuzzy ranking; instead the disabled ones are only greyed.
  const at = Math.min(index, Math.max(0, list.length - 1));

  useEffect(() => { input.current?.focus(); }, []);

  const close = () => { paletteOpen.value = false; };
  const run = (c: PaletteCommand | undefined) => {
    if (!c || !c.enabled()) return;
    close();
    c.run();
  };

  return (
    <div class="scrim top" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input} type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
          aria-activedescendant={list[at] ? `pc-${list[at]!.id}` : undefined}
          placeholder="Type a command" value={query}
          onInput={(e) => { setQuery(e.currentTarget.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(list.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(list[at]); }
          }}
        />
        {list.length === 0 ? <p class="none">No command matches.</p> : (
          <ul id="palette-list" role="listbox" aria-label="Commands">
            {list.map((c, i) => (
              <li
                key={c.id} id={`pc-${c.id}`} role="option" aria-selected={i === at} aria-disabled={!c.enabled()}
                ref={(el) => { if (el && i === at) el.scrollIntoView?.({ block: 'nearest' }); }}
                onMouseMove={() => setIndex(i)} onClick={() => run(c)}
              >
                <span class="lbl">{c.label}</span>
                {c.keys ? <kbd>{c.keys}</kbd> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
