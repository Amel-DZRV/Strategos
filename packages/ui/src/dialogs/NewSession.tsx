import { useEffect, useRef, useState } from 'preact/hooks';
import { addExclude, branchFromName, excludeAnswer, queryExcluded, rememberExclude, slugify } from '../features/worktree.ts';
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

/** Repos we can offer: the daemon's list, the ones existing sessions use, then recently typed ones. Free text is always allowed. */
export function repoChoices(): string[] {
  const seen = new Set<string>(store.repos.value);
  for (const s of store.sessions.value.values()) seen.add(s.repoRoot);
  for (const r of loadRecent()) seen.add(r);
  return [...seen];
}

/** The base other worktrees of this repo were cut from, else main. */
export function defaultBase(repo: string): string {
  const r = repo.trim().toLowerCase();
  for (const s of store.sessions.value.values()) if (s.worktree && s.repoRoot.toLowerCase() === r) return s.worktree.base;
  return 'main';
}

export function NewSessionDialog() {
  const [repo, setRepo] = useState('');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [useWt, setUseWt] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const choices = repoChoices();

  useEffect(() => { first.current?.focus(); }, []);

  const effBranch = branch ?? branchFromName(name);
  const effBase = base ?? defaultBase(repo);
  const close = () => { newSessionOpen.value = false; };

  const start = async (repoPath: string) => {
    const wtName = slugify(effBranch.replace(/\//g, '-'));
    await send({
      c: 'session.start', repoPath,
      ...(prompt.trim() ? { firstPrompt: prompt.trim() } : {}),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(useWt ? { worktree: { name: wtName === '' ? effBranch.trim() : wtName, branch: effBranch.trim(), base: effBase.trim() } } : {}),
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
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const repoPath = repo.trim();
    if (repoPath === '') { setError('Enter the repository folder.'); return; }
    if (useWt && (effBranch.trim() === '' || effBase.trim() === '')) { setError('A worktree needs a branch name and a base.'); return; }
    setBusy(true);
    setError('');
    try {
      if (useWt && excludeAnswer(repoPath) === undefined) {
        const excluded = await queryExcluded(repoPath);
        if (excluded === true) rememberExclude(repoPath, 'yes');
        else if (excluded === false) { setAsking(true); setBusy(false); return; }
      }
      await start(repoPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const answer = async (yes: boolean) => {
    const repoPath = repo.trim();
    setBusy(true);
    setError('');
    try {
      if (yes) await addExclude(repoPath);
      rememberExclude(repoPath, yes ? 'yes' : 'no');
      setAsking(false);
      await start(repoPath);
    } catch (err) {
      setAsking(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (asking) {
    return (
      <div class="scrim" onKeyDown={(e) => { if (e.key === 'Escape') setAsking(false); }}>
        <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="ns-ex-title" aria-describedby="ns-ex-body">
          <h2 id="ns-ex-title">Hide worktrees from git status?</h2>
          <p id="ns-ex-body">Hide Strategos worktrees from git status in this repo? (adds <code>.claude/worktrees/</code> to <code>.git/info/exclude</code>)</p>
          <p class="muted">Only this repository's local exclude file changes; nothing is committed. You will not be asked again for this repo.</p>
          {error ? <p class="error" role="alert">{error}</p> : null}
          <div class="actions end">
            <button type="button" class="btn" disabled={busy} onClick={() => void answer(false)}>No, leave git status alone</button>
            <button type="button" class="btn primary" disabled={busy} onClick={() => void answer(true)}>Yes, hide them</button>
          </div>
        </div>
      </div>
    );
  }

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
        <label class="check">
          <input type="checkbox" checked={useWt} onChange={(e) => setUseWt(e.currentTarget.checked)} />
          Work in a new worktree
        </label>
        {useWt ? (
          <div class="two">
            <label>
              Branch
              <input type="text" value={effBranch} placeholder="feature/my-change" onInput={(e) => setBranch(e.currentTarget.value)} />
            </label>
            <label>
              Base
              <input type="text" value={effBase} placeholder="main" onInput={(e) => setBase(e.currentTarget.value)} />
            </label>
          </div>
        ) : null}
        {error ? <p class="error" role="alert">{error}</p> : null}
        <div class="actions end">
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button type="submit" class="btn primary" disabled={busy}>{busy ? 'Starting…' : 'Start session'}</button>
        </div>
      </form>
    </div>
  );
}
