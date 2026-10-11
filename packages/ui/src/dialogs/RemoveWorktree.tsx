// Remove the worktree folder of a stopped session (6.02). The daemon refuses when work would be lost; the refusal is
// shown here and the owner has to type the branch name before the same command is sent again with confirmText.
import type { SessionRecord } from '@strategos/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { canStop } from '../format.ts';
import { parseRemovalRefusal, type RemovalRefusal } from '../features/worktree.ts';
import { send } from '../state/commands.ts';
import { store } from '../state/store.ts';
import { removeWorktreeTarget } from '../state/ui.ts';

/** Whether "Remove worktree" applies: the session has a worktree and nothing is running in it. */
export function canRemoveWorktree(s: SessionRecord | undefined): boolean {
  return s !== undefined && s.worktree !== undefined && !canStop(s);
}

export function RemoveWorktreeDialog({ id }: { id: string }) {
  const s = store.sessions.value.get(id);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [refusal, setRefusal] = useState<RemovalRefusal | undefined>(undefined);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, [refusal]);
  if (!s?.worktree) return null;
  const wt = s.worktree;
  const close = () => { removeWorktreeTarget.value = null; };

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await send({ c: 'worktree.remove', strategosId: id, deleteBranch, ...(refusal === undefined ? {} : { confirmText: typed }) });
      close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const r = parseRemovalRefusal(msg);
      if (r !== undefined) { setRefusal(r); setTyped(''); } else setError(msg);
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <form class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="rw-title" onSubmit={(e) => { e.preventDefault(); if (refusal === undefined || typed === refusal.confirmText) void run(); }}>
        <h2 id="rw-title">Remove the worktree of “{s.displayName}”?</h2>
        <p class="mono muted">{wt.path}</p>
        <p>The folder is deleted. The session stays in the list as history but can no longer be resumed.</p>
        {refusal === undefined ? (
          <label class="check">
            <input ref={first} type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.currentTarget.checked)} />
            Also delete the branch <span class="mono">{wt.branch}</span>
          </label>
        ) : (
          <>
            <p class="warn" role="alert">This would lose: {refusal.details}.</p>
            <label>
              To go ahead, type <b class="mono">{refusal.confirmText}</b>
              <input ref={first} type="text" value={typed} autocomplete="off" aria-label="Type the branch name to confirm" onInput={(e) => setTyped(e.currentTarget.value)} />
            </label>
          </>
        )}
        {error ? <p class="error" role="alert">{error}</p> : null}
        <div class="actions end">
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button type="submit" class="btn danger" disabled={busy || (refusal !== undefined && typed !== refusal.confirmText)}>
            {refusal === undefined ? 'Remove worktree' : 'Remove anyway'}
          </button>
        </div>
      </form>
    </div>
  );
}
