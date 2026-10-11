import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../state/commands.ts';
import { store } from '../state/store.ts';
import { stopTarget } from '../state/ui.ts';

export function ConfirmStopDialog({ id }: { id: string }) {
  const s = store.sessions.value.get(id);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => { ok.current?.focus(); }, []);
  if (!s) return null;
  const close = () => { stopTarget.value = null; };
  const stop = async () => {
    setBusy(true);
    try {
      await send({ c: 'session.stop', strategosId: id });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div class="scrim" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="cs-title" aria-describedby="cs-body">
        <h2 id="cs-title">Stop “{s.displayName}”?</h2>
        <p id="cs-body">Claude Code for this session will exit. Work in progress stops, but you can resume the session later and its history is kept.</p>
        {error ? <p class="error" role="alert">{error}</p> : null}
        <div class="actions end">
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button ref={ok} type="button" class="btn danger" disabled={busy} onClick={() => void stop()}>Stop session</button>
        </div>
      </div>
    </div>
  );
}
