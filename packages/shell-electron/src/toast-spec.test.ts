import { describe, expect, it } from 'vitest';
import type { UiNotification } from '@strategos/shared';
import { buildToast, isNotification, MAX_BODY } from './toast-spec.ts';

const base: UiNotification = { kind: 'permission', strategosId: 's1', title: 'api needs permission', body: 'C:\\repo\\src\\a.ts', requestId: 'r1' };

describe('buildToast', () => {
  it('keeps the buttons the UI asked for, in a fixed order, with the path as body', () => {
    const t = buildToast({ ...base, actions: ['open', 'deny', 'approve'] });
    expect(t.actions.map((a) => a.action)).toEqual(['approve', 'deny', 'open']);
    expect(t.actions.map((a) => a.text)).toEqual(['Approve', 'Deny', 'Open']);
    expect(t.body).toBe('C:\\repo\\src\\a.ts');
    expect(t.id).toBe('r1');
    expect(t.requestId).toBe('r1');
  });
  it('shows only Deny and Open when the UI withheld Approve (D20, D21)', () => {
    expect(buildToast({ ...base, actions: ['deny', 'open'] }).actions.map((a) => a.action)).toEqual(['deny', 'open']);
  });
  it('never adds Approve itself, and drops unknown actions', () => {
    expect(buildToast({ ...base }).actions).toEqual([]);
    const t = buildToast({ ...base, actions: ['approve', 'always', 'rm -rf'] as unknown as UiNotification['actions'] });
    expect(t.actions.map((a) => a.action)).toEqual(['approve']);
  });
  it('gives no decision buttons without a request id', () => {
    const noReq: UiNotification = { ...base };
    delete noReq.requestId;
    const t = buildToast({ ...noReq, kind: 'done', actions: ['approve', 'deny', 'open'] });
    expect(t.actions.map((a) => a.action)).toEqual(['open']);
    expect(t.requestId).toBeUndefined();
    expect(t.sticky).toBe(false);
  });
  it('shortens long text and flattens line breaks', () => {
    const t = buildToast({ ...base, body: `line1\nline2 ${'x'.repeat(1000)}`, title: 'a\tb' });
    expect(t.body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(t.body).not.toMatch(/[\r\n]/);
    expect(t.title).toBe('a b');
  });
  it('keeps toasts that wait for a person on screen', () => {
    expect(buildToast({ ...base, kind: 'question', actions: ['open'] }).sticky).toBe(true);
    expect(buildToast({ ...base, actions: ['approve', 'deny', 'open'] }).sticky).toBe(true);
  });
});

describe('isNotification', () => {
  it('accepts what the page sends and rejects junk', () => {
    expect(isNotification(base)).toBe(true);
    for (const bad of [null, 'x', 5, {}, { ...base, strategosId: '' }, { ...base, title: 1 }, { ...base, requestId: 5 }, { ...base, actions: 'approve' }]) {
      expect(isNotification(bad)).toBe(false);
    }
  });
});
