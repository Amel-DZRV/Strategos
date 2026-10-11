// Review data and "Send back with notes" (task 6.03).
//
//   get       the diff of the session's folder against the merge-base with its base (the worktree's base, else origin/HEAD or
//             main/master), files with add/del/status, untracked files included, text capped at 1 MB.
//   sendBack  the person's notes go to the session as ONE user turn through the same path as reply.send (same rules: the
//             session must be live and finished with its turn, nothing half-typed at the prompt).
//   "Ask to commit" is not here: the UI sends reply.send with ASK_TO_COMMIT_TEXT from @strategos/shared.
import type { ReviewData, SendResult } from '@strategos/shared';
import { sumFiles, type Git } from './git.ts';
import type { SessionManager } from '../sessions/manager.ts';

export interface Review {
  get(strategosId: string): Promise<ReviewData>;
  sendBack(strategosId: string, text: string): Promise<SendResult>;
}

export const SEND_BACK_HEADER = 'Review notes from the owner. Please address each point, then tell me when you are done:';

export function createReview(deps: { manager: Pick<SessionManager, 'get' | 'sendReply'>; git: Git; maxDiffBytes?: number }): Review {
  return {
    async get(id) {
      const s = deps.manager.get(id);
      if (s === undefined) throw new Error(`no such session: ${id}`);
      const base = s.worktree?.base ?? (await deps.git.defaultBase(s.cwd));
      if (base === undefined) throw new Error('No base branch found to compare with (looked for origin/HEAD, main and master).');
      const d = await deps.git.diffVsBase(s.cwd, base, deps.maxDiffBytes === undefined ? {} : { maxBytes: deps.maxDiffBytes });
      return { files: d.files, diff: d.diff, base: d.base, head: d.head, stat: sumFiles(d.files) };
    },

    async sendBack(id, text) {
      const notes = text.trim();
      if (notes === '') return { ok: false, reason: 'not_allowed', message: 'Write some notes first.' };
      return deps.manager.sendReply(id, `${SEND_BACK_HEADER}\n\n${notes}`);
    },
  };
}
