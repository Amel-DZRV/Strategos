import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../state/commands.ts';
import { store } from '../state/store.ts';
import { newSessionOpen, openDrawer } from '../state/ui.ts';

const RECENT_KEY = 'strategos.recentRepos';

function loadRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
  } catch {
    return [];
  }
}

function saveRecent(path: string): void {
  try {
    const next = [path, ...loadRecent().filter((p) => p !== path)].slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage can be blocked; the dialog works without it
  }
}

/** Repos we can offer: the ones existing sessions use, then recently typed ones. The daemon will supply a real list later. */
export function repoChoices(): string[] {
  const seen = new Set<string>();
  for (const s of store.sessions.value.values()) seen.add(s.repoRoot);
  for (const r of loadRecent()) seen.add(r);
  return [...seen];
}

export function NewSessionDialog() {
  const [repo, setRepo] = useState('');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const choices = repoChoices();

  useEffect(() => { first.current?.focus(); }, []);

  const close = () => { newSessionOpen.value = false; };
  const submit = async (e: Event) => {
    e.preventDefault();
    const repoPath = repo.trim();
    if (repoPath === '') {
      setError('Enter the repository folder.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await send({
        c: 'session.start', repoPath,
        ...(prompt.trim() ? { firstPrompt: prompt.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      saveRecent(repoPath);
      close();
      // The new record arrives as a session.upsert; open the newest one when it does.
      const before = new Set(store.sessions.value.keys());
      const stop = store.sessions.subscribe((m) => {
        for (const [id] of m) {
          if (!before.has(id)) {
            openDrawer(id);
            stop();
            return;
          }
        }
      });
      setTimeout(stop, 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="ns-title" onSubmit={(e) => void submit(e)}>
        <h2 id="ns-title">New session</h2>
        <label>
          Repository folder
          <input ref={first} type="text" list="ns-repos" value={repo} placeholder="C:\dev\my-project" onInput={(e) => setRepo(e.currentTarget.value)} />
          <datalist id="ns-repos">{choices.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <label>
          Name (optional)
          <input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label>
          First prompt (optional)
          <textarea rows={4} value={prompt} onInput={(e) => setPrompt(e.currentTarget.value)} />
        </label>
        {error ? <p class="error" role="alert">{error}</p> : null}
        <div class="actions end">
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button type="submit" class="btn primary" disabled={busy}>{busy ? 'Starting…' : 'Start session'}</button>
        </div>
      </form>
    </div>
  );
}
