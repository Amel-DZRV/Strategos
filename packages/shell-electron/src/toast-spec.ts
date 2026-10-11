// What a desktop notification looks like and which buttons it carries. Pure; toasts.ts hands the result to Electron.
//
// The UI decides the buttons (packages/shared/src/d20.ts: Approve only for Read/Edit/Write inside the worktree, never
// Bash, never dotfiles, never cut input). This file only makes sure a request from the page cannot smuggle in more than
// that: unknown actions are dropped, text is shortened, and a notification without a request id gets no decision buttons.
import type { UiNotification } from '@strategos/shared';

export type ToastAction = 'approve' | 'deny' | 'open';

export interface ToastSpec {
  id: string;
  title: string;
  body: string;
  strategosId: string;
  requestId?: string;
  /** In button order. The index Electron reports maps to this list. */
  actions: { action: ToastAction; text: string }[];
  /** A question or an error needs a person: the toast stays until dismissed. */
  sticky: boolean;
}

const LABEL: Record<ToastAction, string> = { approve: 'Approve', deny: 'Deny', open: 'Open' };
const ORDER: readonly ToastAction[] = ['approve', 'deny', 'open'];
export const MAX_TITLE = 100;
export const MAX_BODY = 240;

const clip = (s: unknown, n: number): string => {
  const t = typeof s === 'string' ? s.replace(/[\r\n\t]+/g, ' ').trim() : '';
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export function isNotification(v: unknown): v is UiNotification {
  if (typeof v !== 'object' || v === null) return false;
  const n = v as Record<string, unknown>;
  return typeof n['strategosId'] === 'string' && n['strategosId'] !== '' && typeof n['title'] === 'string' && typeof n['body'] === 'string'
    && typeof n['kind'] === 'string' && (n['requestId'] === undefined || typeof n['requestId'] === 'string')
    && (n['actions'] === undefined || Array.isArray(n['actions']));
}

export function buildToast(n: UiNotification): ToastSpec {
  const requested = new Set<unknown>(n.actions ?? []);
  const hasRequest = typeof n.requestId === 'string' && n.requestId !== '';
  // Approve and Deny need a request to decide; without one only Open is meaningful.
  const actions = ORDER.filter((a) => requested.has(a) && (a === 'open' || hasRequest)).map((a) => ({ action: a, text: LABEL[a] }));
  return {
    id: hasRequest ? n.requestId! : `${n.strategosId}:${n.kind}`,
    title: clip(n.title, MAX_TITLE),
    body: clip(n.body, MAX_BODY),
    strategosId: n.strategosId,
    ...(hasRequest ? { requestId: n.requestId! } : {}),
    actions,
    sticky: n.kind === 'question' || n.kind === 'errored' || n.kind === 'escalate' || actions.some((a) => a.action === 'approve'),
  };
}
