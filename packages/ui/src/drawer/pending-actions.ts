// Actions on a held request, shared by the session rows, the pending card and the keyboard (plan 2.07).
// D21: when inputSummary was cut at 400 chars, Approve first expands the full input instead of approving.
import { signal } from '@preact/signals';
import type { SessionRecord } from '@strategos/shared';
import { onChannel, send } from '../state/commands.ts';
import { errorNotice, openDrawer } from '../state/ui.ts';

/** requestIds whose full input the owner has been shown. Approving a truncated request needs the id in here. */
export const expanded = signal<ReadonlySet<string>>(new Set());
/** Full tool input by requestId, as delivered by the daemon's `pending.full` reply. */
export const fullInput = signal<Readonly<Record<string, string>>>({});
const loading = new Set<string>();

export function needsExpand(s: SessionRecord): boolean {
  const p = s.pending;
  return !!p && p.kind === 'permission' && p.inputTruncated && !expanded.value.has(p.requestId);
}

export function setFullInput(requestId: string, input: string): void {
  fullInput.value = { ...fullInput.value, [requestId]: input };
  expanded.value = new Set(expanded.value).add(requestId);
}

/** Ask the daemon for the full input. Approve stays blocked until this succeeds. */
export async function expandFull(s: SessionRecord): Promise<void> {
  const p = s.pending;
  if (!p || loading.has(p.requestId)) return;
  loading.add(p.requestId);
  // Listen before asking: the daemon answers with a pending.full event and then the ack, and the card may mount late.
  const off = onChannel((ev) => {
    if (ev.t === 'pending.full' && ev.requestId === p.requestId) setFullInput(ev.requestId, typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input, null, 2));
  });
  try {
    await send({ c: 'pending.full', strategosId: s.strategosId, requestId: p.requestId });
    expanded.value = new Set(expanded.value).add(p.requestId);
  } catch (e) {
    errorNotice.value = `Could not load the full input: ${e instanceof Error ? e.message : String(e)}. Answer in the terminal instead.`;
  } finally {
    setTimeout(off, 3000); // the event normally precedes the ack; tolerate it arriving just after
    loading.delete(p.requestId);
  }
}

async function run(what: string, cmd: Parameters<typeof send>[0]): Promise<boolean> {
  try {
    await send(cmd);
    return true;
  } catch (e) {
    errorNotice.value = `${what} failed: ${e instanceof Error ? e.message : String(e)}`;
    return false;
  }
}

/** Approve. For a truncated input this opens the full card and does not approve. */
export async function approve(s: SessionRecord): Promise<'approved' | 'expand' | 'failed' | 'none'> {
  const p = s.pending;
  if (!p || p.kind !== 'permission' || !p.held) return 'none';
  if (needsExpand(s)) {
    openDrawer(s.strategosId);
    await expandFull(s);
    return 'expand';
  }
  return (await run('Approve', { c: 'perm.decide', strategosId: s.strategosId, requestId: p.requestId, decision: 'allow' })) ? 'approved' : 'failed';
}

export async function deny(s: SessionRecord, message?: string): Promise<boolean> {
  const p = s.pending;
  if (!p || p.kind !== 'permission' || !p.held) return false;
  const m = message?.trim();
  return run('Deny', {
    c: 'perm.decide', strategosId: s.strategosId, requestId: p.requestId, decision: 'deny', ...(m ? { message: m } : {}),
  });
}

/** Always allow: only when the daemon offered suggestions. D21 applies here too. */
export async function always(s: SessionRecord, suggestionIndex = 0): Promise<boolean> {
  const p = s.pending;
  if (!p || p.kind !== 'permission' || !p.held || !p.suggestions?.length) return false;
  if (needsExpand(s)) {
    openDrawer(s.strategosId);
    await expandFull(s);
    return false;
  }
  return run('Always allow', {
    c: 'perm.decide', strategosId: s.strategosId, requestId: p.requestId, decision: 'always', suggestionIndex,
  });
}

export function answerQuestion(s: SessionRecord, answers: Record<string, string>): Promise<boolean> {
  const p = s.pending;
  if (!p || p.kind !== 'question' || !p.held) return Promise.resolve(false);
  return run('Answer', { c: 'question.answer', strategosId: s.strategosId, requestId: p.requestId, answers });
}

/** "Answer in terminal": the daemon releases the held hook so the real dialog shows (D13). */
export function release(s: SessionRecord): Promise<boolean> {
  const p = s.pending;
  if (!p) return Promise.resolve(false);
  return run('Release', { c: 'perm.release', strategosId: s.strategosId, requestId: p.requestId });
}
