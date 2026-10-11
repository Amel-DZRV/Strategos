// M6 UI: review pane, PR dialog, new-session worktree, remove worktree, initiatives, mission, top bar menu.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { ASK_TO_COMMIT_TEXT, type ReviewData } from '@strategos/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './test/cleanup.ts';
import { App } from './app.tsx';
import { MissionDialog } from './dialogs/Initiatives.tsx';
import { defaultPrBody } from './dialogs/CreatePr.tsx';
import { DiffView, ReviewPane, renderDiff, resetReviewCache, sanitizeDiffHtml, testLine } from './drawer/ReviewPane.tsx';
import { branchFromName, parseRemovalRefusal, slugify } from './features/worktree.ts';
import { resetMapModel } from './map/model.ts';
import { paletteCommands } from './palette/commands.ts';
import { shell } from './shell-bridge.ts';
import { now } from './state/clock.ts';
import { DEFAULT_PREFS, store } from './state/store.ts';
import { assignTarget, drawerOpen, drawerTab, initiativeDialog, missionOpen, newSessionOpen, removeWorktreeTarget, selectedId, view } from './state/ui.ts';
import { installFakeTransport, type FakeTransport } from './test/fakes.ts';
import { makeSession, T0 } from './test/fixtures.ts';

vi.mock('./drawer/TerminalPane.tsx', () => ({ TerminalPane: ({ strategosId }: { strategosId: string }) => <div data-testid="term">{strategosId}</div> }));

let t: FakeTransport;
const sent = (c?: string) => t.sent.filter((x) => x.c !== 'digest.get' && (c === undefined || x.c === c));
const load = (sessions: ReturnType<typeof makeSession>[], seq = 1) =>
  store.applyEvent({ t: 'snapshot', seq, sessions, planets: [], initiatives: [], prefs: store.prefs.value });
const press = async (key: string, init: KeyboardEventInit = {}) => { await act(() => { fireEvent.keyDown(document.body, { key, ...init }); }); };

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts', 'index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@',
  ' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;', '',
].join('\n');
const review = (over: Partial<ReviewData> = {}): ReviewData => ({
  files: [{ path: 'src/a.ts', add: 1, del: 1, status: 'modified' }], diff: DIFF, base: 'main', head: 'feat/x', stat: { files: 1, add: 1, del: 1 }, ...over,
});

beforeEach(() => {
  t = installFakeTransport();
  now.value = T0 + 5 * 60_000;
  view.value = 'list';
  selectedId.value = null;
  drawerOpen.value = false;
  drawerTab.value = 'term';
  newSessionOpen.value = false;
  removeWorktreeTarget.value = null;
  initiativeDialog.value = null;
  assignTarget.value = null;
  missionOpen.value = false;
  resetMapModel();
  resetReviewCache();
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => {
  vi.restoreAllMocks();
  store.applyEvent({ t: 'snapshot', seq: 0, sessions: [], planets: [], initiatives: [], prefs: DEFAULT_PREFS });
  store.connection.value = 'connecting';
  store.suggestions.value = [];
});

describe('worktree helpers', () => {
  it('slugifies a session name into a branch name', () => {
    expect(slugify('Fix the Login bug!')).toBe('fix-the-login-bug');
    expect(slugify('  --weird__name--  ')).toBe('weird__name');
    expect(branchFromName('')).toBe('');
  });
  it('reads the daemon refusal to remove a worktree', () => {
    const msg = 'Not removed. This would lose: 2 uncommitted change(s): M a.ts; ?? b.txt | 1 commit(s) that exist nowhere else (the branch was never pushed): 4c1d9e2 bump | the branch chore/deps would be deleted. To go ahead, type "chore/deps" to confirm.';
    expect(parseRemovalRefusal(msg)).toEqual({
      details: '2 uncommitted change(s): M a.ts; ?? b.txt | 1 commit(s) that exist nowhere else (the branch was never pushed): 4c1d9e2 bump | the branch chore/deps would be deleted',
      confirmText: 'chore/deps',
    });
    expect(parseRemovalRefusal('Stop the session first: its process is still running in that folder.')).toBeUndefined();
  });
});

describe('test line: never says passing without an observed run', () => {
  const at = T0;
  const s = (lastTest?: { command: string; ok: boolean | null; at: number }) =>
    makeSession({ strategosId: 'a', flags: { conflicts: [], contractChanged: [], guardDenials: 0, ...(lastTest ? { lastTest } : {}) } });
  it('no run -> not run', () => {
    expect(testLine(s(), at)).toBe('Tests: not run');
    expect(/pass/i.test(testLine(s(), at))).toBe(false);
  });
  it('passed and failed carry the command and the age', () => {
    expect(testLine(s({ command: 'npm test', ok: true, at: T0 }), T0 + 3 * 60_000)).toBe('Tests: npm test — passed 3m ago');
    expect(testLine(s({ command: 'npm test', ok: false, at: T0 }), T0 + 3 * 60_000)).toBe('Tests: npm test — failed 3m ago');
  });
  it('a run with an unknown result is not "passed"', () => {
    const line = testLine(s({ command: 'pytest', ok: null, at: T0 }), T0 + 60_000);
    expect(line).toContain('result unknown');
    expect(/passed|passing/i.test(line)).toBe(false);
  });
});

describe('diff rendering', () => {
  it('renders files and lines, in both layouts', () => {
    expect(renderDiff(DIFF, false).fileCount).toBe(1);
    const inline = renderDiff(DIFF, false).markup;
    const side = renderDiff(DIFF, true).markup;
    expect(inline).toContain('d2h-file-wrapper');
    expect(side).toContain('d2h-file-side-diff');
  });
  it('escapes code and file names; the sanitizer removes anything active', () => {
    const evil = [
      'diff --git a/x"><img src=x onerror=alert(1)>.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-ok', '+<script>alert(1)</script><img src=x onerror=alert(2)>', '',
    ].join('\n');
    const { markup } = renderDiff(evil, false);
    const dom = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
    expect(dom.querySelector('script, img, iframe')).toBeNull();
    expect([...dom.body.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => /^on/i.test(a.name)))).toBe(false);
    expect(dom.body.textContent).toContain('<script>alert(1)</script>'); // shown as text, not run
    expect(sanitizeDiffHtml('<div onclick="x()"><a href="javascript:alert(1)">a</a><script>1</script><iframe src="x"></iframe></div>')).toBe('<div><a>a</a></div>');
  });
  it('DiffView reports how many files it drew', () => {
    const onCount = vi.fn();
    render(<DiffView diff={DIFF} sideBySide={false} onCount={onCount} />);
    expect(onCount).toHaveBeenCalledWith(1);
  });
});

describe('review pane (6.03)', () => {
  const sess = (over: Partial<Parameters<typeof makeSession>[0]> = {}) => makeSession({ strategosId: 'a', displayName: 'Checkout API', status: 'done', last: 'Added the endpoint.', ...over });
  const open = async (s = sess()) => {
    render(<ReviewPane session={s} active />);
    await waitFor(() => expect(sent('review.get')).toEqual([{ c: 'review.get', strategosId: 'a' }]));
    return s;
  };

  it('asks for the review when opened and shows files with counts and status', async () => {
    await open();
    await act(() => { t.emit({ t: 'review', strategosId: 'a', review: review() }); });
    const list = screen.getByRole('list', { name: 'Changed files' });
    expect(within(list).getByText('src/a.ts')).toBeTruthy();
    expect(within(list).getByLabelText('modified')).toBeTruthy();
    expect(within(list).getByText('+1')).toBeTruthy();
    expect(within(list).getByText('−1')).toBeTruthy();
    expect(document.querySelector('.d2h-file-wrapper')).toBeTruthy();
    expect(screen.getByText('feat/x vs main')).toBeTruthy();
  });

  it('Refresh asks again; another session\'s review is ignored', async () => {
    await open();
    await act(() => { t.emit({ t: 'review', strategosId: 'zzz', review: review() }); });
    expect(screen.queryByRole('list', { name: 'Changed files' })).toBeNull();
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Refresh the review' })); });
    expect(sent('review.get')).toHaveLength(2);
  });

  it('warns when the diff was cut (flag, or fewer files drawn than listed)', async () => {
    await open();
    await act(() => { t.emit({ t: 'review', strategosId: 'a', review: review({ files: [...review().files, { path: 'src/big.bin', add: 9, del: 0, status: 'added' }], stat: { files: 2, add: 10, del: 1 } }) }); });
    await waitFor(() => expect(screen.getByText(/cut at its size limit/)).toBeTruthy());
    await act(() => { t.emit({ t: 'review', strategosId: 'a', review: { ...review(), truncated: true } as ReviewData }); });
    expect(screen.getByText(/cut at its size limit/)).toBeTruthy();
  });

  it('shows the last observed test run, or "not run"', async () => {
    await open(sess({ flags: { conflicts: [], contractChanged: [], guardDenials: 0, lastTest: { command: 'npm test', ok: true, at: T0 + 2 * 60_000 } } }));
    expect(screen.getByTestId('testline').textContent).toBe('Tests: npm test — passed 3m ago');
  });
  it('says not run when there is no observed run', async () => {
    await open();
    expect(screen.getByTestId('testline').textContent).toBe('Tests: not run');
  });

  it('Send back with notes sends review.sendBack and clears the box', async () => {
    await open();
    const box = screen.getByPlaceholderText(/Notes for the session/);
    const btn = screen.getByRole('button', { name: 'Send back with notes' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.input(box, { target: { value: '  rename the helper  ' } });
    await act(() => { fireEvent.click(btn); });
    expect(sent('review.sendBack')).toEqual([{ c: 'review.sendBack', strategosId: 'a', text: 'rename the helper' }]);
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  it('shows the daemon\'s refusal when the notes cannot be sent', async () => {
    await open();
    fireEvent.input(screen.getByPlaceholderText(/Notes for the session/), { target: { value: 'x' } });
    t.failNext('busy: the session is working');
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Send back with notes' })); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('busy: the session is working'));
  });

  it('Ask to commit sends reply.send with the fixed text', async () => {
    await open();
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Ask to commit' })); });
    expect(sent('reply.send')).toEqual([{ c: 'reply.send', strategosId: 'a', text: ASK_TO_COMMIT_TEXT }]);
  });

  it('Create draft PR: editable title and body (defaults from the session), spinner while waiting, then the link', async () => {
    const s = sess();
    const { rerender } = render(<ReviewPane session={s} active />);
    await act(() => { t.emit({ t: 'review', strategosId: 'a', review: review() }); });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Create draft PR' })); });
    const dlg = screen.getByRole('dialog', { name: /pull request/i });
    const title = within(dlg).getByLabelText('Title') as HTMLInputElement;
    const body = within(dlg).getByLabelText('Description') as HTMLTextAreaElement;
    expect(title.value).toBe('Checkout API');
    expect(body.value).toBe(defaultPrBody(s, review()));
    expect(body.value).toContain('Added the endpoint.');
    expect(body.value).toContain('Changes: 1 file, +1 −1');
    fireEvent.input(title, { target: { value: 'Add checkout endpoint' } });
    fireEvent.input(body, { target: { value: 'Body text' } });

    let release: (() => void) | undefined;
    vi.mocked(t.send).mockImplementationOnce((cmd) => {
      t.sent.push(cmd);
      return new Promise((res) => { release = () => res({ t: 'ack', id: 'x', ok: true }); });
    });
    await act(() => { fireEvent.click(within(dlg).getByRole('button', { name: 'Create draft PR' })); });
    expect(sent('pr.create')).toEqual([{ c: 'pr.create', strategosId: 'a', title: 'Add checkout endpoint', body: 'Body text', draft: true }]);
    expect(within(dlg).getByRole('status').textContent).toContain('Pushing and creating the pull request');
    expect((within(dlg).getByRole('button', { name: 'Creating…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(() => { release?.(); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /pull request/i })).toBeNull());

    // the daemon updates the session record with the PR: the pane shows the link and offers no second PR
    const link = makeSession({ strategosId: 'a', displayName: 'Checkout API', status: 'done', pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'DRAFT', ci: 'pending', at: T0 } });
    rerender(<ReviewPane session={link} active />);
    expect(screen.queryByRole('button', { name: 'Create draft PR' })).toBeNull();
    const open = vi.spyOn(shell, 'openExternal').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Pull request #7' }));
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/7');
  });

  it('a refused PR keeps the dialog open with the reason', async () => {
    await open();
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Create draft PR' })); });
    t.failNext('a pull request already exists for this branch');
    await act(() => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create draft PR' })); });
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('already exists'));
  });

  it('shows a login banner and blocks Create draft PR when gh needs login (snapshot pref, then gh.status)', async () => {
    store.applyEvent({ t: 'snapshot', seq: 1, sessions: [], planets: [], initiatives: [], prefs: { ...DEFAULT_PREFS, ghNeedsLogin: true } });
    render(<ReviewPane session={sess()} active />);
    expect(screen.getByText(/GitHub CLI needs a login/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create draft PR' }) as HTMLButtonElement).disabled).toBe(true);
    await act(() => { store.applyEvent({ t: 'gh.status', seq: 2, needsLogin: false }); });
    expect(screen.queryByText(/GitHub CLI needs a login/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Create draft PR' }) as HTMLButtonElement).disabled).toBe(false);
    await act(() => { store.applyEvent({ t: 'gh.status', seq: 3, needsLogin: true, message: 'not logged in' }); });
    expect(screen.getByText(/not logged in/)).toBeTruthy();
  });

  it('cannot send notes or ask to commit when the session is stopped', async () => {
    await open(sess({ status: 'stopped' }));
    expect((screen.getByRole('button', { name: 'Ask to commit' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('drawer: Review tab', () => {
  it('opens on v and requests the review', async () => {
    render(<App />);
    await act(() => { load([makeSession({ strategosId: 'a', displayName: 'Alpha', status: 'done' })]); });
    selectedId.value = 'a';
    await press('v');
    expect(drawerTab.value).toBe('review');
    await waitFor(() => expect(sent('review.get')).toHaveLength(1));
    expect(document.querySelector('.app.wide')).toBeTruthy();
  });
});

describe('new session with a worktree (6.02)', () => {
  const fill = (repo: string) => {
    fireEvent.input(screen.getByLabelText(/Repository folder/), { target: { value: repo } });
    fireEvent.input(screen.getByLabelText(/Name/), { target: { value: 'Fix the Login bug' } });
  };
  const exclude = async (repo: string, excluded: boolean) => {
    await waitFor(() => expect(sent('worktree.exclude').length).toBeGreaterThan(0));
    await act(() => { t.emit({ t: 'worktree.exclude', repoPath: repo, excluded }); });
  };

  it('default branch comes from the name; base defaults to main; sends session.start with the worktree', async () => {
    render(<App />);
    await press('c');
    localStorage.setItem('strategos.excludeAnswer', JSON.stringify({ 'c:\\dev\\proj': 'no' }));
    fill('C:\\dev\\proj');
    fireEvent.click(screen.getByLabelText('Work in a new worktree'));
    expect((screen.getByLabelText('Branch') as HTMLInputElement).value).toBe('fix-the-login-bug');
    expect((screen.getByLabelText('Base') as HTMLInputElement).value).toBe('main');
    fireEvent.input(screen.getByLabelText('Branch'), { target: { value: 'feature/login-fix' } });
    fireEvent.input(screen.getByLabelText('Base'), { target: { value: 'develop' } });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })); });
    await waitFor(() => expect(sent('session.start')).toHaveLength(1));
    expect(sent('session.start')[0]).toEqual({
      c: 'session.start', repoPath: 'C:\\dev\\proj', name: 'Fix the Login bug', worktree: { name: 'feature-login-fix', branch: 'feature/login-fix', base: 'develop' },
    });
    expect(sent('worktree.exclude')).toEqual([]); // answered "no" before: not asked, not queried
  });

  it('asks once per repo whether to hide worktrees (query add=false, then add=true on yes), and remembers', async () => {
    render(<App />);
    await press('c');
    fill('C:\\dev\\proj');
    fireEvent.click(screen.getByLabelText('Work in a new worktree'));
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })); });
    expect(sent('worktree.exclude')).toEqual([{ c: 'worktree.exclude', repoPath: 'C:\\dev\\proj', add: false }]);
    await exclude('C:\\dev\\proj', false);
    const ask = await screen.findByRole('alertdialog');
    expect(ask.textContent).toContain('Hide Strategos worktrees from git status in this repo?');
    expect(ask.textContent).toContain('.claude/worktrees/');
    expect(sent('session.start')).toEqual([]);
    await act(() => { fireEvent.click(within(ask).getByRole('button', { name: 'Yes, hide them' })); });
    await waitFor(() => expect(sent('session.start')).toHaveLength(1));
    expect(sent('worktree.exclude')).toEqual([
      { c: 'worktree.exclude', repoPath: 'C:\\dev\\proj', add: false },
      { c: 'worktree.exclude', repoPath: 'C:\\dev\\proj', add: true },
    ]);
    expect(JSON.parse(localStorage.getItem('strategos.excludeAnswer') ?? '{}')).toEqual({ 'c:\\dev\\proj': 'yes' });

    // the second session in the same repo: no query, no question
    await waitFor(() => expect(newSessionOpen.value).toBe(false));
    await press('c');
    fill('C:\\dev\\proj');
    fireEvent.click(screen.getByLabelText('Work in a new worktree'));
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })); });
    await waitFor(() => expect(sent('session.start')).toHaveLength(2));
    expect(sent('worktree.exclude')).toHaveLength(2);
  });

  it('answering no remembers it and starts without changing the repo', async () => {
    render(<App />);
    await press('c');
    fill('C:\\dev\\proj');
    fireEvent.click(screen.getByLabelText('Work in a new worktree'));
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })); });
    await exclude('C:\\dev\\proj', false);
    const ask = await screen.findByRole('alertdialog');
    await act(() => { fireEvent.click(within(ask).getByRole('button', { name: /^No/ })); });
    await waitFor(() => expect(sent('session.start')).toHaveLength(1));
    expect(sent('worktree.exclude').filter((c) => c.c === 'worktree.exclude' && c.add)).toEqual([]);
    expect(JSON.parse(localStorage.getItem('strategos.excludeAnswer') ?? '{}')).toEqual({ 'c:\\dev\\proj': 'no' });
  });

  it('does not ask when the repo already excludes worktrees', async () => {
    render(<App />);
    await press('c');
    fill('C:\\dev\\proj');
    fireEvent.click(screen.getByLabelText('Work in a new worktree'));
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })); });
    await exclude('C:\\dev\\proj', true);
    await waitFor(() => expect(sent('session.start')).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a worktree needs a branch and a base', async () => {
    render(<App />);
    await press('c');
    fireEvent.input(screen.getByLabelText(/Repository folder/), { target: { value: 'C:\\dev\\proj' } });
    fireEvent.click(screen.getByLabelText('Work in a new worktree'));
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })); });
    expect(screen.getByRole('alert').textContent).toContain('branch name and a base');
    expect(sent()).toEqual([]);
  });

  it('offers the daemon\'s repos from the snapshot', async () => {
    store.applyEvent({ t: 'snapshot', seq: 1, sessions: [], planets: [], initiatives: [], prefs: DEFAULT_PREFS, repos: ['C:\\dev\\from-daemon'] });
    render(<App />);
    await press('c');
    expect([...document.querySelectorAll('#ns-repos option')].map((o) => (o as HTMLOptionElement).value)).toContain('C:\\dev\\from-daemon');
  });
});

describe('remove worktree (6.02)', () => {
  const stopped = () => makeSession({ strategosId: 'a', displayName: 'Deps', status: 'stopped', worktree: { path: 'C:\\r\\.claude\\worktrees\\deps', branch: 'chore/deps', base: 'main', createdByStrategos: true } });

  it('is offered for a stopped session with a worktree: header button and palette command', async () => {
    render(<App />);
    await act(() => { load([stopped(), makeSession({ strategosId: 'b', status: 'working', worktree: { path: 'p', branch: 'x', base: 'main', createdByStrategos: true } })]); });
    selectedId.value = 'a';
    expect(paletteCommands().find((c) => c.id === 'remove-worktree')!.enabled()).toBe(true);
    selectedId.value = 'b';
    expect(paletteCommands().find((c) => c.id === 'remove-worktree')!.enabled()).toBe(false);
    selectedId.value = 'a';
    drawerOpen.value = true;
    await act(() => { /* render */ });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Remove worktree…' })); });
    expect(screen.getByRole('alertdialog').textContent).toContain('chore/deps');
  });

  it('sends worktree.remove with deleteBranch from the checkbox', async () => {
    render(<App />);
    await act(() => { load([stopped()]); });
    removeWorktreeTarget.value = 'a';
    await act(() => { /* render */ });
    fireEvent.click(screen.getByLabelText(/Also delete the branch/));
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Remove worktree' })); });
    expect(sent('worktree.remove')).toEqual([{ c: 'worktree.remove', strategosId: 'a', deleteBranch: true }]);
    await waitFor(() => expect(removeWorktreeTarget.value).toBeNull());
  });

  it('when the daemon refuses with what would be lost, shows it and needs the branch name typed (confirmText) before resending', async () => {
    render(<App />);
    await act(() => { load([stopped()]); });
    removeWorktreeTarget.value = 'a';
    await act(() => { /* render */ });
    t.failNext('Not removed. This would lose: 2 uncommitted change(s): M a.ts; ?? b.txt | the branch chore/deps would be deleted. To go ahead, type "chore/deps" to confirm.');
    fireEvent.click(screen.getByLabelText(/Also delete the branch/));
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Remove worktree' })); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('2 uncommitted change(s): M a.ts; ?? b.txt'));
    const go = screen.getByRole('button', { name: 'Remove anyway' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    const box = screen.getByLabelText('Type the branch name to confirm');
    fireEvent.input(box, { target: { value: 'chore/dep' } });
    expect(go.disabled).toBe(true);
    fireEvent.input(box, { target: { value: 'chore/deps' } });
    expect(go.disabled).toBe(false);
    await act(() => { fireEvent.click(go); });
    expect(sent('worktree.remove')).toEqual([
      { c: 'worktree.remove', strategosId: 'a', deleteBranch: true },
      { c: 'worktree.remove', strategosId: 'a', deleteBranch: true, confirmText: 'chore/deps' },
    ]);
    await waitFor(() => expect(removeWorktreeTarget.value).toBeNull());
  });

  it('shows any other refusal as it is', async () => {
    render(<App />);
    await act(() => { load([stopped()]); });
    removeWorktreeTarget.value = 'a';
    await act(() => { /* render */ });
    t.failNext('Stop the session first: its process is still running in that folder.');
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Remove worktree' })); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Stop the session first'));
    expect(screen.queryByLabelText('Type the branch name to confirm')).toBeNull();
  });
});

describe('initiatives (4.10)', () => {
  const snap = (initiatives: { id: string; name: string; colour: string; archived?: boolean; contractFiles?: { planetKey: string; relPath: string }[] }[], sessions = [makeSession({ strategosId: 'a', displayName: 'Alpha' })]) =>
    store.applyEvent({
      t: 'snapshot', seq: 1, sessions, prefs: DEFAULT_PREFS,
      planets: [{ planetKey: 'strategos-app', label: 'strategos-app', colour: '#fff', cell: { col: 0, row: 0 }, pinned: false, folded: false }],
      initiatives: initiatives.map((i) => ({ createdAt: T0, contractFiles: [], archived: false, ...i })),
    });

  it('chips appear only when initiatives exist; clicking one edits it', async () => {
    render(<App />);
    expect(document.querySelector('.ichip')).toBeNull();
    await act(() => { snap([{ id: 'i1', name: 'Checkout', colour: '#f5b83d' }]); });
    const chip = screen.getByRole('button', { name: 'Checkout' });
    await act(() => { fireEvent.click(chip); });
    expect(screen.getByRole('dialog', { name: 'Edit initiative' })).toBeTruthy();
  });

  it('creates an initiative with a name, a colour and contract files', async () => {
    render(<App />);
    await act(() => { snap([]); });
    initiativeDialog.value = {};
    await act(() => { /* render */ });
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Checkout' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Colour #4fcb90' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a contract file' }));
    fireEvent.change(screen.getByLabelText('Repository of contract file 1'), { target: { value: 'strategos-app' } });
    fireEvent.input(screen.getByLabelText('Path of contract file 1'), { target: { value: 'src/api/schema.ts' } });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
    const [cmd] = sent('initiative.upsert');
    expect(cmd).toMatchObject({ c: 'initiative.upsert', initiative: { name: 'Checkout', colour: '#4fcb90', archived: false, contractFiles: [{ planetKey: 'strategos-app', relPath: 'src/api/schema.ts' }] } });
    expect((cmd as { initiative: { id: string } }).initiative.id.length).toBeGreaterThan(5);
    await waitFor(() => expect(initiativeDialog.value).toBeNull());
  });

  it('a contract file needs both a repository and a path', async () => {
    render(<App />);
    await act(() => { snap([]); });
    initiativeDialog.value = {};
    await act(() => { /* render */ });
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a contract file' }));
    fireEvent.change(screen.getByLabelText('Repository of contract file 1'), { target: { value: '' } });
    fireEvent.input(screen.getByLabelText('Path of contract file 1'), { target: { value: 'a.ts' } });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
    expect(screen.getByRole('alert').textContent).toContain('repository and a path');
    expect(sent('initiative.upsert')).toEqual([]);
  });

  it('editing keeps the id and the creation time', async () => {
    render(<App />);
    await act(() => { snap([{ id: 'i1', name: 'Checkout', colour: '#f5b83d', contractFiles: [{ planetKey: 'strategos-app', relPath: 'a.ts' }] }]); });
    initiativeDialog.value = { id: 'i1' };
    await act(() => { /* render */ });
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Checkout v2' } });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(sent('initiative.upsert')).toEqual([{
      c: 'initiative.upsert',
      initiative: { id: 'i1', name: 'Checkout v2', colour: '#f5b83d', createdAt: T0, contractFiles: [{ planetKey: 'strategos-app', relPath: 'a.ts' }], archived: false },
    }]);
  });

  it('i opens the picker for the selected session; Apply sends initiative.assign', async () => {
    render(<App />);
    await act(() => { snap([{ id: 'i1', name: 'Checkout', colour: '#f5b83d' }]); });
    selectedId.value = 'a';
    await press('i');
    const dlg = screen.getByRole('dialog', { name: /Initiative for/ });
    fireEvent.change(within(dlg).getByLabelText('Initiative'), { target: { value: 'i1' } });
    await act(() => { fireEvent.click(within(dlg).getByRole('button', { name: 'Apply' })); });
    expect(sent('initiative.assign')).toEqual([{ c: 'initiative.assign', strategosId: 'a', initiativeId: 'i1' }]);
    await waitFor(() => expect(assignTarget.value).toBeNull());
  });

  it('"None" removes the session from its initiative; "New initiative…" creates and assigns', async () => {
    render(<App />);
    await act(() => { snap([{ id: 'i1', name: 'Checkout', colour: '#f5b83d' }], [makeSession({ strategosId: 'a', displayName: 'Alpha', initiativeId: 'i1' })]); });
    assignTarget.value = 'a';
    await act(() => { /* render */ });
    fireEvent.change(screen.getByLabelText('Initiative'), { target: { value: '' } });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Apply' })); });
    expect(sent('initiative.assign')).toEqual([{ c: 'initiative.assign', strategosId: 'a', initiativeId: null }]);
    await waitFor(() => expect(assignTarget.value).toBeNull());

    assignTarget.value = 'a';
    await act(() => { /* render */ });
    fireEvent.change(screen.getByLabelText('Initiative'), { target: { value: '__new' } });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    expect(initiativeDialog.value).toEqual({ assignTo: 'a' });
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Billing' } });
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
    await waitFor(() => expect(sent('initiative.assign')).toHaveLength(2));
    const up = sent('initiative.upsert')[0] as { initiative: { id: string } };
    expect(sent('initiative.assign').at(-1)).toEqual({ c: 'initiative.assign', strategosId: 'a', initiativeId: up.initiative.id });
  });

  it('the palette has assign (key i), new initiative and an edit command per initiative', async () => {
    await act(() => { snap([{ id: 'i1', name: 'Checkout', colour: '#f5b83d' }, { id: 'i2', name: 'Old', colour: '#fff', archived: true }]); });
    const ids = paletteCommands().map((c) => c.id);
    expect(ids).toContain('initiative');
    expect(ids).toContain('new-initiative');
    expect(ids).toContain('edit-initiative:i1');
    expect(ids).not.toContain('edit-initiative:i2');
    expect(ids).toContain('start-mission');
  });
});

describe('mission (6.06)', () => {
  const withInitiatives = () => store.applyEvent({
    t: 'snapshot', seq: 1, sessions: [], planets: [], prefs: DEFAULT_PREFS,
    initiatives: [{ id: 'i1', name: 'Checkout', colour: '#f5b83d', createdAt: T0, contractFiles: [], archived: false }],
  });
  const fillRow = (n: number, repo: string, branch: string, prompt: string) => {
    fireEvent.input(screen.getAllByLabelText('Repository')[n]!, { target: { value: repo } });
    fireEvent.input(screen.getAllByLabelText('Branch')[n]!, { target: { value: branch } });
    fireEvent.input(screen.getAllByLabelText('First prompt')[n]!, { target: { value: prompt } });
  };

  it('starts a mission for an existing initiative and shows "Started N of N"', async () => {
    withInitiatives();
    render(<MissionDialog />);
    fillRow(0, 'C:\\dev\\api', 'feat/api', 'build the API');
    fireEvent.click(screen.getByRole('button', { name: 'Add a session' }));
    fillRow(1, 'C:\\dev\\web', 'feat/web', 'build the UI');
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start mission' })); });
    expect(sent('mission.start')).toEqual([{
      c: 'mission.start', initiativeId: 'i1',
      sessions: [{ repoPath: 'C:\\dev\\api', branch: 'feat/api', firstPrompt: 'build the API' }, { repoPath: 'C:\\dev\\web', branch: 'feat/web', firstPrompt: 'build the UI' }],
    }]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Started 2 of 2.'));
  });

  it('shows the daemon\'s "Started N of M" text when some sessions failed', async () => {
    withInitiatives();
    render(<MissionDialog />);
    fillRow(0, 'C:\\dev\\api', 'feat/api', 'x');
    t.failNext('Started 0 of 1. feat/api: No base branch found in this repository');
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start mission' })); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Started 0 of 1. feat/api: No base branch'));
  });

  it('can create the initiative first', async () => {
    store.applyEvent({ t: 'snapshot', seq: 1, sessions: [], planets: [], prefs: DEFAULT_PREFS, initiatives: [] });
    render(<MissionDialog />);
    fireEvent.input(screen.getByLabelText('New initiative name'), { target: { value: 'Billing' } });
    fillRow(0, 'C:\\dev\\api', 'feat/billing', '');
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start mission' })); });
    await waitFor(() => expect(sent('mission.start')).toHaveLength(1));
    const up = sent('initiative.upsert')[0] as { initiative: { id: string; name: string } };
    expect(up.initiative.name).toBe('Billing');
    expect(sent('mission.start')[0]).toMatchObject({ initiativeId: up.initiative.id });
  });

  it('needs a repository and a branch on every row', async () => {
    withInitiatives();
    render(<MissionDialog />);
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'Start mission' })); });
    expect(screen.getByRole('alert').textContent).toContain('repository and a branch');
    expect(sent('mission.start')).toEqual([]);
  });
});

describe('top bar (6.x tidy)', () => {
  it('keeps the design\'s left and right sides; the extras live in the ⋯ menu', async () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy();
    expect(screen.getByText(/Spend today/)).toBeTruthy();
    expect(screen.getByText(/need you/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Group:/ })).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'More' })); });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: /^Map/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitemradio', { name: /^List/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Group by initiative/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Command palette/ })).toBeTruthy();
    await act(() => { fireEvent.click(within(menu).getByRole('menuitem', { name: /Group by initiative/ })); });
    expect(sent('prefs.set')).toEqual([{ c: 'prefs.set', prefs: { groupBy: 'initiative' } }]);
    expect(screen.queryByRole('menu')).toBeNull(); // picking closes it
  });

  it('Escape closes the menu', async () => {
    render(<App />);
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'More' })); });
    await act(() => { fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the menu starts a mission and a new initiative', async () => {
    render(<App />);
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'More' })); });
    await act(() => { fireEvent.click(screen.getByRole('menuitem', { name: /Start a mission/ })); });
    expect(missionOpen.value).toBe(true);
    await act(() => { fireEvent.click(screen.getByRole('button', { name: 'More' })); });
    await act(() => { fireEvent.click(screen.getByRole('menuitem', { name: /New initiative/ })); });
    expect(initiativeDialog.value).toEqual({});
  });
});

describe('marks and hover card read SessionRecord.pr (4.04)', () => {
  it('shows branch, ahead/behind, dirty, diff stat, PR number, CI and review', async () => {
    view.value = 'map';
    render(<App />);
    await act(() => {
      store.applyEvent({
        t: 'snapshot', seq: 1, planets: [], initiatives: [], prefs: DEFAULT_PREFS,
        sessions: [makeSession({
          strategosId: 'a', displayName: 'Alpha', branch: 'feat/x',
          git: { branch: 'feat/x', ahead: 2, behind: 1, dirty: true, diffStat: { files: 3, add: 20, del: 4 }, at: T0 },
          pr: { number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN', ci: 'fail', review: 'APPROVED', at: T0 },
        })],
      });
    });
    const tok = document.querySelector('.tok[data-sid=a]')!;
    expect(tok.querySelector('.mark-pr')).toBeTruthy();
    expect(tok.querySelector('.mark-ci')?.getAttribute('fill')).toBe('var(--c-approve)');
    await act(() => { fireEvent.mouseEnter(tok); });
    const card = screen.getByRole('tooltip').textContent ?? '';
    expect(card).toContain('feat/x · ↑2 ↓1 · uncommitted changes');
    expect(card).toContain('3 files changed · +20 −4');
    expect(card).toContain('PR #12 open · CI fail · approved');
  });
});

describe('store: gh status and repos', () => {
  it('snapshot sets repos and the gh state; gh.status updates it', () => {
    store.applyEvent({ t: 'snapshot', seq: 1, sessions: [], planets: [], initiatives: [], prefs: { ...DEFAULT_PREFS, ghNeedsLogin: true }, repos: ['a', 'b'] });
    expect(store.repos.value).toEqual(['a', 'b']);
    expect(store.gh.value).toEqual({ needsLogin: true });
    expect(store.applyEvent({ t: 'gh.status', seq: 2, needsLogin: false })).toBe('applied');
    expect(store.gh.value).toEqual({ needsLogin: false });
  });
});
