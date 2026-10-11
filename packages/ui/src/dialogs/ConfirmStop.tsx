import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../state/commands.ts';
import { store } from '../state/store.ts';
import { parkTarget, stopTarget } from '../state/ui.ts';

interface Copy { cmd: 'session.stop' | 'session.park'; title: string; body: string; action: string }

function ConfirmDialog({ id, copy, close }: { id: string; copy: Copy; close: () => void }) {
  const s = store.sessions.value.get(id);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => { ok.current?.focus(); }, []);
  if (!s) return null;
  const run = async () => {
    setBusy(true);
    try {
      await send({ c: copy.cmd, strategosId: id });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div class="scrim" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="cs-title" aria-describedby="cs-body">
        <h2 id="cs-title">{copy.title.replace('{name}', s.displayName)}</h2>
        <p id="cs-body">{copy.body}</p>
        {error ? <p class="error" role="alert">{error}</p> : null}
        <div class="actions end">
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button ref={ok} type="button" class="btn danger" disabled={busy} onClick={() => void run()}>{copy.action}</button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmStopDialog({ id }: { id: string }) {
  return (
    <ConfirmDialog
      id={id} close={() => { stopTarget.value = null; }}
      copy={{
        cmd: 'session.stop', title: 'Stop “{name}”?', action: 'Stop session',
        body: 'Claude Code for this session will exit. Work in progress stops, but you can resume the session later and its history is kept.',
      }}
    />
  );
}

export function ConfirmParkDialog({ id }: { id: string }) {
  return (
    <ConfirmDialog
      id={id} close={() => { parkTarget.value = null; }}
      copy={{
        cmd: 'session.park', title: 'Park “{name}”?', action: 'Park session',
        body: 'Claude Code for this session will exit and the session is set aside, out of the way. You can resume it later and its history is kept.',
      }}
    />
  );
}
