// The drawer's Review tab (6.03): what the session changed against its base, notes to send back, ask-to-commit, and a draft PR.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html as diffHtml, parse as parseDiff } from 'diff2html';
import type { ColorSchemeType, OutputFormatType } from 'diff2html/lib/types';
import 'diff2html/bundles/css/diff2html.min.css';
import { ASK_TO_COMMIT_TEXT, type ReviewData, type ReviewFile, type SessionRecord } from '@strategos/shared';
import { CreatePrDialog } from '../dialogs/CreatePr.tsx';
import { fmtWait } from '../format.ts';
import { now } from '../state/clock.ts';
import { onChannel, send } from '../state/commands.ts';
import { store } from '../state/store.ts';
import { shell } from '../shell-bridge.ts';

/** The last observed test run, in words. Never says "passing" unless a run was observed and it passed. */
export function testLine(s: SessionRecord, nowMs: number): string {
  const t = s.flags.lastTest;
  if (!t) return 'Tests: not run';
  const ago = `${fmtWait(Math.max(0, nowMs - t.at))} ago`;
  if (t.ok === true) return `Tests: ${t.command} — passed ${ago}`;
  if (t.ok === false) return `Tests: ${t.command} — failed ${ago}`;
  return `Tests: ${t.command} — ran ${ago}, result unknown`;
}

const STATUS_MARK: Record<ReviewFile['status'], { mark: string; label: string }> = {
  added: { mark: 'A', label: 'added' },
  modified: { mark: 'M', label: 'modified' },
  deleted: { mark: 'D', label: 'deleted' },
  renamed: { mark: 'R', label: 'renamed' },
  untracked: { mark: 'U', label: 'untracked' },
  other: { mark: '·', label: 'changed' },
};

/**
 * diff2html escapes file names and code. This is a second line: the finished markup is parsed and anything active
 * (scripts, frames, event handlers, javascript: links) is removed before it is put on the page.
 */
export function sanitizeDiffHtml(markup: string): string {
  const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
  for (const el of Array.from(doc.body.querySelectorAll('script, iframe, object, embed, link, meta, style, base, form'))) el.remove();
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*(javascript|data|vbscript):/i.test(a.value))) el.removeAttribute(a.name);
    }
  }
  return doc.body.innerHTML;
}

export interface RenderedDiff { markup: string; fileCount: number }

export function renderDiff(diff: string, sideBySide: boolean): RenderedDiff {
  const files = parseDiff(diff);
  const markup = diffHtml(files, {
    drawFileList: false,
    outputFormat: (sideBySide ? 'side-by-side' : 'line-by-line') as OutputFormatType,
    colorScheme: 'dark' as ColorSchemeType,
    matching: 'lines' as never,
  });
  return { markup: sanitizeDiffHtml(markup), fileCount: files.length };
}

export function DiffView({ diff, sideBySide, onCount }: { diff: string; sideBySide: boolean; onCount?: (n: number) => void }) {
  const r = useMemo(() => renderDiff(diff, sideBySide), [diff, sideBySide]);
  useEffect(() => { onCount?.(r.fileCount); }, [r.fileCount]);
  return <div class="diff-wrap" dangerouslySetInnerHTML={{ __html: r.markup }} />;
}

const cache = new Map<string, ReviewData>();
/** For tests. */
export function resetReviewCache(): void { cache.clear(); }

export interface ReviewPaneProps { session: SessionRecord; active: boolean }

export function ReviewPane({ session, active }: ReviewPaneProps) {
  const id = session.strategosId;
  const [review, setReview] = useState<ReviewData | undefined>(cache.get(id));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [side, setSide] = useState(false);
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [shownFiles, setShownFiles] = useState<number | undefined>(undefined);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => onChannel((ev) => {
    if (ev.t === 'review' && ev.strategosId === id) {
      cache.set(id, ev.review);
      setReview(ev.review);
      setLoading(false);
    }
  }), [id]);

  const refresh = () => {
    setLoading(true);
    setError('');
    send({ c: 'review.get', strategosId: id }).catch((e: unknown) => {
      setLoading(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  useEffect(() => { if (active) refresh(); }, [active, id]);

  const act = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMsg('');
    setError('');
    try {
      await fn();
      setMsg(done);
    } catch (e) {
      setError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const live = session.status !== 'stopped' && session.status !== 'parked' && session.status !== 'open_elsewhere';
  const ghDown = store.gh.value.needsLogin;
  const files = review?.files ?? [];
  const truncated = review !== undefined && ((review as ReviewData & { truncated?: boolean }).truncated === true || (shownFiles !== undefined && shownFiles < files.length));

  const jump = (f: ReviewFile) => {
    for (const el of Array.from(wrap.current?.querySelectorAll('.d2h-file-name') ?? [])) {
      if ((el.textContent ?? '').includes(f.path)) { el.scrollIntoView?.({ block: 'start' }); return; }
    }
  };

  return (
    <div class="review" ref={wrap}>
      {ghDown ? (
        <div class="banner gh" role="note">
          GitHub CLI needs a login: run <code>gh auth login</code> in a terminal. Pull requests cannot be created until then.{store.gh.value.message ? ` (${store.gh.value.message})` : ''}
        </div>
      ) : null}
      <div class="review-bar">
        <span class="mono muted" title="Compared with the merge-base of the base branch">
          {review ? `${review.head} vs ${review.base}` : 'Not loaded'}
        </span>
        <span class="sp" />
        {review ? <span class="mono"><span class="add">+{review.stat.add}</span> <span class="del">−{review.stat.del}</span> · {review.stat.files} {review.stat.files === 1 ? 'file' : 'files'}</span> : null}
        <button type="button" class="btn" aria-pressed={side} onClick={() => setSide(!side)} title="Side-by-side or inline diff">{side ? 'Side by side' : 'Inline'}</button>
        <button type="button" class="btn" onClick={refresh} disabled={loading} aria-label="Refresh the review">{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      <p class="testline mono" data-testid="testline">{testLine(session, now.value)}</p>
      {error ? <p class="error pad" role="alert">{error}</p> : null}
      {msg ? <p class="ok pad" role="status">{msg}</p> : null}
      <div class="review-scroll">
        {review === undefined ? (
          <p class="placeholder">{loading ? 'Loading the changes…' : 'No review data yet.'}</p>
        ) : files.length === 0 ? (
          <p class="placeholder">No changes against {review.base}.</p>
        ) : (
          <>
            <ul class="filelist" aria-label="Changed files">
              {files.map((f) => (
                <li key={f.path}>
                  <button type="button" class="file" onClick={() => jump(f)} title={`${STATUS_MARK[f.status].label}: ${f.path}`}>
                    <span class={`st st-${f.status}`} aria-label={STATUS_MARK[f.status].label}>{STATUS_MARK[f.status].mark}</span>
                    <span class="path mono">{f.path}</span>
                    <span class="nums mono"><span class="add">+{f.add}</span> <span class="del">−{f.del}</span></span>
                  </button>
                </li>
              ))}
            </ul>
            {truncated ? <p class="warn pad" role="note">The diff was cut at its size limit, so some files or lines are not shown. The file list above is complete.</p> : null}
            <DiffView diff={review.diff} sideBySide={side} onCount={setShownFiles} />
          </>
        )}
      </div>
      <div class="review-foot">
        {session.pr ? (
          <p class="prline">
            <button type="button" class="btn link" onClick={() => shell.openExternal(session.pr!.url)}>Pull request #{session.pr.number}</button>
            <span class="muted mono"> {session.pr.state.toLowerCase()}{session.pr.ci !== 'none' ? ` · CI ${session.pr.ci}` : ''}{session.pr.review ? ` · ${session.pr.review}` : ''}</span>
          </p>
        ) : null}
        <label class="notes">
          <span class="sr-only">Notes to send back</span>
          <textarea rows={2} placeholder="Notes for the session: what to change before this is ready" value={notes} onInput={(e) => setNotes(e.currentTarget.value)} />
        </label>
        <div class="actions">
          <button
            type="button" class="btn primary" disabled={busy || !live || notes.trim() === ''}
            title={live ? 'Sends your notes to the session as one message' : 'The session is not running'}
            onClick={() => void act('Send back', async () => { await send({ c: 'review.sendBack', strategosId: id, text: notes.trim() }); setNotes(''); }, 'Notes sent to the session.')}
          >Send back with notes</button>
          <button
            type="button" class="btn" disabled={busy || !live}
            title={live ? 'Asks the session to commit its work' : 'The session is not running'}
            onClick={() => void act('Ask to commit', () => send({ c: 'reply.send', strategosId: id, text: ASK_TO_COMMIT_TEXT }), 'Asked the session to commit.')}
          >Ask to commit</button>
          {!session.pr ? (
            <button
              type="button" class="btn" disabled={busy || ghDown} title={ghDown ? 'Log in to the GitHub CLI first (gh auth login)' : 'Push the branch and open a draft pull request'}
              onClick={() => setPrOpen(true)}
            >Create draft PR</button>
          ) : null}
        </div>
      </div>
      {prOpen ? <CreatePrDialog session={session} review={review} onClose={() => setPrOpen(false)} /> : null}
    </div>
  );
}
