// Confirmation for "Approve all low-risk": lists every request (session, tool, path) and sends only those ids.
import { useEffect, useRef, useState } from 'preact/hooks';
import { approveLowRisk, currentLowRisk, type LowRiskItem } from '../features/lowrisk.ts';
import { lowRiskOpen } from '../state/ui.ts';

export function LowRiskDialog() {
  // The list is frozen when the dialog opens: what is confirmed is what is sent, even if more requests arrive meanwhile.
  const [items] = useState<LowRiskItem[]>(() => currentLowRisk());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await approveLowRisk(items);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="scrim" role="presentation" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); lowRiskOpen.value = false; } }}>
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="lr-title">
        <h2 id="lr-title">Approve all low-risk?</h2>
        {done ? (
          <p>Sent. The daemon approves only the requests it still considers low-risk; anything else stays waiting for you.</p>
        ) : items.length === 0 ? (
          <p>Nothing low-risk is waiting any more.</p>
        ) : (
          <>
            <p class="muted">These {items.length === 1 ? 'request' : `${items.length} requests`} only read files or write inside the repository.</p>
            <ul class="lrlist" aria-label="Requests to approve">
              {items.map((i) => (
                <li key={i.requestId}>
                  <span class="who">{i.session}</span>
                  <b>{i.tool}</b>
                  <code>{i.path}</code>
                </li>
              ))}
            </ul>
          </>
        )}
        {error ? <p class="error" role="alert">{error}</p> : null}
        <div class="actions end">
          <button ref={first} type="button" class="btn" onClick={() => { lowRiskOpen.value = false; }}>{done ? 'Close' : 'Cancel'}</button>
          {!done && items.length > 0 ? (
            <button type="button" class="btn primary" disabled={busy} onClick={() => void confirm()}>Approve {items.length}</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
