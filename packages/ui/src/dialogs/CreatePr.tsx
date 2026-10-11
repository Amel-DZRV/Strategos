import { useEffect, useRef, useState } from 'preact/hooks';
import type { ReviewData, SessionRecord } from '@strategos/shared';
import { send } from '../state/commands.ts';

/** The PR body we offer: what the session last said, then the size of the change. The owner edits it before sending. */
export function defaultPrBody(s: SessionRecord, review: ReviewData | undefined): string {
  const parts: string[] = [];
  const last = s.last?.trim();
  if (last) parts.push(last);
  const st = review?.stat ?? s.git?.diffStat;
  if (st) parts.push(`Changes: ${st.files} ${st.files === 1 ? 'file' : 'files'}, +${st.add} −${st.del}`);
  return parts.join('\n\n');
}

export function CreatePrDialog({ session, review, onClose }: { session: SessionRecord; review: ReviewData | undefined; onClose: () => void }) {
  const [title, setTitle] = useState(session.displayName);
  const [body, setBody] = useState(() => defaultPrBody(session, review));
  const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (title.trim() === '') { setError('Give the pull request a title.'); return; }
    setBusy(true);
    setError('');
    try {
      await send({ c: 'pr.create', strategosId: session.strategosId, title: title.trim(), body, draft }, { timeoutMs: 120_000 });
      onClose(); // the link appears in the review pane from the session record the daemon updates
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}>
      <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="pr-title" aria-busy={busy} onSubmit={(e) => void submit(e)}>
        <h2 id="pr-title">Create {draft ? 'draft ' : ''}pull request</h2>
        <p class="muted">Pushes <span class="mono">{session.git?.branch ?? session.worktree?.branch ?? session.branch ?? 'the branch'}</span> and opens the pull request with the GitHub CLI.</p>
        <label>
          Title
          <input ref={first} type="text" value={title} disabled={busy} onInput={(e) => setTitle(e.currentTarget.value)} />
        </label>
        <label>
          Description
          <textarea rows={8} value={body} disabled={busy} onInput={(e) => setBody(e.currentTarget.value)} />
        </label>
        <label class="check">
          <input type="checkbox" checked={draft} disabled={busy} onChange={(e) => setDraft(e.currentTarget.checked)} />
          Open as a draft
        </label>
        {busy ? <p class="working" role="status"><span class="spinner" aria-hidden="true" /> Pushing and creating the pull request. This can take a few seconds.</p> : null}
        {error ? <p class="error" role="alert">{error}</p> : null}
        <div class="actions end">
          <button type="button" class="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" class="btn primary" disabled={busy}>{busy ? 'Creating…' : draft ? 'Create draft PR' : 'Create PR'}</button>
        </div>
      </form>
    </div>
  );
}
