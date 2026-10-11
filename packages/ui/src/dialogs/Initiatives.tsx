// Initiatives (4.10): create / edit (name, colour, contract files), put a session in one (key i), and start a mission (6.06).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Initiative } from '@strategos/shared';
import { send } from '../state/commands.ts';
import { store } from '../state/store.ts';
import { assignTarget, initiativeDialog, missionOpen } from '../state/ui.ts';
import { repoChoices } from './NewSession.tsx';

export const INITIATIVE_COLOURS = ['#74aaff', '#4fcb90', '#f5b83d', '#ff6a5a', '#b48cff', '#5fd0d6', '#f08fc0', '#a8c66c'];

export function newInitiativeId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? c.randomUUID() : `ini-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function nextColour(): string {
  return INITIATIVE_COLOURS[store.initiatives.value.length % INITIATIVE_COLOURS.length]!;
}

const activeInitiatives = (): Initiative[] => store.initiatives.value.filter((i) => !i.archived);

function Swatches({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div class="swatches" role="radiogroup" aria-label="Colour">
      {INITIATIVE_COLOURS.map((c) => (
        <button
          key={c} type="button" role="radio" aria-checked={value.toLowerCase() === c} aria-label={`Colour ${c}`}
          class={`swatch ${value.toLowerCase() === c ? 'on' : ''}`} style={`--sw:${c}`} onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

// --- create / edit -----------------------------------------------------------------------------------------------------
export function InitiativeDialog({ id, assignTo }: { id?: string; assignTo?: string }) {
  const existing = id === undefined ? undefined : store.initiatives.value.find((i) => i.id === id);
  const [name, setName] = useState(existing?.name ?? '');
  const [colour, setColour] = useState(existing?.colour ?? nextColour());
  const [files, setFiles] = useState<{ planetKey: string; relPath: string }[]>(existing?.contractFiles.map((f) => ({ ...f })) ?? []);
  const [archived, setArchived] = useState(existing?.archived ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const planets = store.planets.value;
  useEffect(() => { first.current?.focus(); }, []);
  const close = () => { initiativeDialog.value = null; };

  const setFile = (i: number, patch: Partial<{ planetKey: string; relPath: string }>) =>
    setFiles(files.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const submit = async (e: Event) => {
    e.preventDefault();
    if (name.trim() === '') { setError('Give the initiative a name.'); return; }
    if (!/^#[0-9a-f]{6}$/i.test(colour)) { setError('Pick a colour.'); return; }
    const cleaned = files.map((f) => ({ planetKey: f.planetKey.trim(), relPath: f.relPath.trim() })).filter((f) => f.planetKey !== '' || f.relPath !== '');
    if (cleaned.some((f) => f.planetKey === '' || f.relPath === '')) { setError('Each contract file needs a repository and a path.'); return; }
    const ini: Initiative = {
      id: existing?.id ?? newInitiativeId(), name: name.trim(), colour, createdAt: existing?.createdAt ?? Date.now(), contractFiles: cleaned, archived,
    };
    setBusy(true);
    setError('');
    try {
      await send({ c: 'initiative.upsert', initiative: ini });
      if (assignTo !== undefined) await send({ c: 'initiative.assign', strategosId: assignTo, initiativeId: ini.id });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="in-title" onSubmit={(e) => void submit(e)}>
        <h2 id="in-title">{existing ? 'Edit initiative' : 'New initiative'}</h2>
        <label>
          Name
          <input ref={first} type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <div class="field">
          <span class="lbl">Colour</span>
          <Swatches value={colour} onPick={setColour} />
        </div>
        <fieldset class="contracts">
          <legend>Contract files</legend>
          <p class="muted">Files that sessions of this initiative must agree on (an API schema, shared types). A change to one is flagged on the Map.</p>
          {files.map((f, i) => (
            <div class="crow" key={i}>
              {planets.length > 0 ? (
                <select aria-label={`Repository of contract file ${i + 1}`} value={f.planetKey} onChange={(e) => setFile(i, { planetKey: e.currentTarget.value })}>
                  <option value="">Repository…</option>
                  {planets.map((p) => <option key={p.planetKey} value={p.planetKey}>{p.label}</option>)}
                </select>
              ) : (
                <input type="text" aria-label={`Repository of contract file ${i + 1}`} placeholder="repository" value={f.planetKey} onInput={(e) => setFile(i, { planetKey: e.currentTarget.value })} />
              )}
              <input type="text" aria-label={`Path of contract file ${i + 1}`} placeholder="src/api/schema.ts" value={f.relPath} onInput={(e) => setFile(i, { relPath: e.currentTarget.value })} />
              <button type="button" class="btn icon" aria-label={`Remove contract file ${i + 1}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" class="btn" onClick={() => setFiles([...files, { planetKey: planets.length === 1 ? planets[0]!.planetKey : '', relPath: '' }])}>Add a contract file</button>
        </fieldset>
        {existing ? (
          <label class="check">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.currentTarget.checked)} />
            Archived (hidden from the top bar and from new work)
          </label>
        ) : null}
        {error ? <p class="error" role="alert">{error}</p> : null}
        <div class="actions end">
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button type="submit" class="btn primary" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

// --- put a session in an initiative ------------------------------------------------------------------------------------
export function AssignInitiativeDialog({ id }: { id: string }) {
  const s = store.sessions.value.get(id);
  const list = activeInitiatives();
  const [choice, setChoice] = useState<string>(s?.initiativeId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  if (!s) return null;
  const close = () => { assignTarget.value = null; };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (choice === '__new') {
      assignTarget.value = null;
      initiativeDialog.value = { assignTo: id };
      return;
    }
    setBusy(true);
    setError('');
    try {
      await send({ c: 'initiative.assign', strategosId: id, initiativeId: choice === '' ? null : choice });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="as-title" onSubmit={(e) => void submit(e)}>
        <h2 id="as-title">Initiative for “{s.displayName}”</h2>
        <label>
          Initiative
          <select ref={first} value={choice} onChange={(e) => setChoice(e.currentTarget.value)}>
            <option value="">None</option>
            {list.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            <option value="__new">New initiative…</option>
          </select>
        </label>
        {error ? <p class="error" role="alert">{error}</p> : null}
        <div class="actions end">
          <button type="button" class="btn" onClick={close}>Cancel</button>
          <button type="submit" class="btn primary" disabled={busy}>{choice === '__new' ? 'Continue' : 'Apply'}</button>
        </div>
      </form>
    </div>
  );
}

// --- mission ------------------------------------------------------------------------------------------------------------
interface Row { repoPath: string; branch: string; firstPrompt: string }
const emptyRow = (): Row => ({ repoPath: '', branch: '', firstPrompt: '' });

export function MissionDialog() {
  const list = activeInitiatives();
  const [initiativeId, setInitiativeId] = useState(list[0]?.id ?? '__new');
  const [newName, setNewName] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const first = useRef<HTMLSelectElement>(null);
  const choices = repoChoices();
  useEffect(() => { first.current?.focus(); }, []);
  const close = () => { missionOpen.value = false; };
  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async (e: Event) => {
    e.preventDefault();
    const sessions = rows.map((r) => ({ repoPath: r.repoPath.trim(), branch: r.branch.trim(), firstPrompt: r.firstPrompt.trim() }));
    if (sessions.some((r) => r.repoPath === '' || r.branch === '')) { setError('Each row needs a repository and a branch.'); return; }
    if (initiativeId === '__new' && newName.trim() === '') { setError('Name the new initiative.'); return; }
    setBusy(true);
    setError('');
    try {
      let iid = initiativeId;
      if (iid === '__new') {
        iid = newInitiativeId();
        await send({ c: 'initiative.upsert', initiative: { id: iid, name: newName.trim(), colour: nextColour(), createdAt: Date.now(), contractFiles: [], archived: false } });
      }
      await send({ c: 'mission.start', initiativeId: iid, sessions }, { timeoutMs: 120_000 });
      setDone(`Started ${sessions.length} of ${sessions.length}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err)); // "Started 2 of 3. branch: reason | ..." comes from the daemon
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <form class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="ms-title" onSubmit={(e) => void submit(e)}>
        <h2 id="ms-title">Start a mission</h2>
        <p class="muted">One session per row, each in its own new worktree on its own branch. The first is the lead.</p>
        <label>
          Initiative
          <select ref={first} value={initiativeId} onChange={(e) => setInitiativeId(e.currentTarget.value)}>
            {list.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            <option value="__new">New initiative…</option>
          </select>
        </label>
        {initiativeId === '__new' ? (
          <label>
            New initiative name
            <input type="text" value={newName} onInput={(e) => setNewName(e.currentTarget.value)} />
          </label>
        ) : null}
        <datalist id="ms-repos">{choices.map((c) => <option key={c} value={c} />)}</datalist>
        {rows.map((r, i) => (
          <fieldset class="mrow" key={i}>
            <legend>Session {i + 1}</legend>
            <div class="two">
              <label>
                Repository
                <input type="text" list="ms-repos" value={r.repoPath} onInput={(e) => setRow(i, { repoPath: e.currentTarget.value })} />
              </label>
              <label>
                Branch
                <input type="text" value={r.branch} placeholder="feature/checkout-api" onInput={(e) => setRow(i, { branch: e.currentTarget.value })} />
              </label>
            </div>
            <label>
              First prompt
              <textarea rows={2} value={r.firstPrompt} onInput={(e) => setRow(i, { firstPrompt: e.currentTarget.value })} />
            </label>
            {rows.length > 1 ? <button type="button" class="btn link" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove row</button> : null}
          </fieldset>
        ))}
        <div><button type="button" class="btn" onClick={() => setRows([...rows, emptyRow()])}>Add a session</button></div>
        {done ? <p class="ok" role="status">{done}</p> : null}
        {error ? <p class="error" role="alert">{error}</p> : null}
        <div class="actions end">
          <button type="button" class="btn" onClick={close}>{done ? 'Close' : 'Cancel'}</button>
          {done ? null : <button type="submit" class="btn primary" disabled={busy}>{busy ? 'Starting…' : 'Start mission'}</button>}
        </div>
      </form>
    </div>
  );
}
