import { describe, expect, it, vi } from 'vitest';
import type { SendResult, SessionRecord } from '@strategos/shared';
import { createReview, SEND_BACK_HEADER } from './review.ts';
import type { Git } from './git.ts';

describe('sendBack', () => {
  const rig = (result: SendResult = { ok: true }) => {
    const sendReply = vi.fn<(id: string, text: string) => Promise<SendResult>>(() => Promise.resolve(result));
    const review = createReview({ manager: { get: () => undefined, sendReply }, git: {} as Git });
    return { review, sendReply };
  };

  it('sends the notes as ONE message through the reply path, multi-line text intact', async () => {
    const { review, sendReply } = rig();
    const r = await review.sendBack('s1', '  1. rename x\n2. add a test  ');
    expect(r).toEqual({ ok: true });
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith('s1', `${SEND_BACK_HEADER}\n\n1. rename x\n2. add a test`);
  });

  it('refuses empty notes without touching the session; passes the reply rules through', async () => {
    const a = rig();
    expect(await a.review.sendBack('s1', ' \n ')).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(a.sendReply).not.toHaveBeenCalled();
    const b = rig({ ok: false, reason: 'busy', message: 'wait' });
    expect(await b.review.sendBack('s1', 'x')).toEqual({ ok: false, reason: 'busy', message: 'wait' });
  });
});

describe('get', () => {
  const rec = (o: Partial<SessionRecord> = {}): SessionRecord => ({ cwd: '/w', ...o } as SessionRecord);

  it('uses the worktree base, else the default base, and totals come from the files', async () => {
    const diffVsBase = vi.fn((_cwd: string, base: string) => Promise.resolve({
      base, head: 'feat', truncated: false, diff: 'd',
      files: [{ path: 'a', add: 2, del: 1, status: 'modified' as const }, { path: 'b', add: 3, del: 0, status: 'added' as const }],
    }));
    const git = { diffVsBase, defaultBase: () => Promise.resolve('origin/main') } as unknown as Git;
    const withBase = createReview({ manager: { get: () => rec({ worktree: { path: '/w', branch: 'feat', base: 'dev', createdByStrategos: true } }), sendReply: vi.fn() }, git });
    expect((await withBase.get('s')).base).toBe('dev');
    const noBase = createReview({ manager: { get: () => rec(), sendReply: vi.fn() }, git });
    const r = await noBase.get('s');
    expect(r).toMatchObject({ base: 'origin/main', head: 'feat', diff: 'd', stat: { files: 2, add: 5, del: 1 } });
  });

  it('says so when there is no session or no base', async () => {
    const none = createReview({ manager: { get: () => undefined, sendReply: vi.fn() }, git: {} as Git });
    await expect(none.get('x')).rejects.toThrow(/no such session/);
    const noBase = createReview({ manager: { get: () => rec(), sendReply: vi.fn() }, git: { defaultBase: () => Promise.resolve(undefined) } as unknown as Git });
    await expect(noBase.get('x')).rejects.toThrow(/No base branch/);
  });
});
