import { useEffect, useRef } from 'preact/hooks';
import { KEY_ACTIONS, leaveTerminalLabel } from '../keys/keymap.ts';
import { helpOpen } from '../state/ui.ts';

export function KeyHelpDialog() {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  const done = () => { helpOpen.value = false; };
  return (
    <div class="scrim" onKeyDown={(e) => { if (e.key === 'Escape') done(); }}>
      <div class="dialog keyhelp" role="dialog" aria-modal="true" aria-labelledby="kh-title">
        <h2 id="kh-title">Keys</h2>
        <dl class="keys">
          {KEY_ACTIONS.map((a) => (
            <div key={a.id}><dt><kbd>{a.show}</kbd></dt><dd>{a.label}</dd></div>
          ))}
          <div><dt><kbd>{leaveTerminalLabel()}</kbd></dt><dd>Leave a focused terminal and go back to the map</dd></div>
        </dl>
        <p class="muted">Inside a terminal every key goes to Claude. Every key here also has a button.</p>
        <div class="actions end"><button ref={close} type="button" class="btn" onClick={done}>Close</button></div>
      </div>
    </div>
  );
}
