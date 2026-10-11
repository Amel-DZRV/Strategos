import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HookMachineInput, MachineInput, SessionRecord, Status } from '@strategos/shared';
import { summarise } from '../hooks/receiver.ts';
import { createStuckDetector, sameStuck, STUCK_LIMITS, type StuckDetector } from './stuck.ts';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/claude/2.1.292/hooks');
const body = (name: string): Record<string, unknown> => (JSON.parse(readFileSync(path.join(FIX, name), 'utf8')) as { body: Record<string, unknown> }).body;

/** The receiver's normalisation, reduced to what the detector reads. */
function fromBody(b: Record<string, unknown>): HookMachineInput {
  const tool = String(b['tool_name']);
  const input = b['tool_input'] as Record<string, unknown> | undefined;
  const toolUseId = typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : undefined;
  const base = toolUseId === undefined ? {} : { toolUseId };
  switch (b['hook_event_name']) {
    case 'PreToolUse': return { event: 'PreToolUse', tool, summary: summarise(tool, input).text, ...base };
    case 'PostToolUse': return { event: 'PostToolUse', tool, ...base };
    case 'PostToolUseFailure': return { event: 'PostToolUseFailure', tool, isInterrupt: b['is_interrupt'] === true, ...base };
    default: throw new Error('unsupported fixture');
  }
}

class Rig {
  d: StuckDetector = createStuckDetector();
  t = 1_000_000;
  status: Status = 'working';
  ctx: SessionRecord['ctx'];
  n = 0;
  feed(input: MachineInput) {
    return this.d.observe(input, { status: this.status, ctx: this.ctx }, this.t);
  }
  hook(h: HookMachineInput) { return this.feed({ k: 'hook', hook: h }); }
  prompt() { return this.hook({ event: 'UserPromptSubmit' }); }
  pre(tool: string, summary: string, id?: string) { return this.hook({ event: 'PreToolUse', tool, summary, toolUseId: id ?? `t${++this.n}` }); }
  post(tool: string, id?: string) { return this.hook({ event: 'PostToolUse', tool, ...(id === undefined ? {} : { toolUseId: id }) }); }
  fail(tool: string, interrupt = false) { return this.hook({ event: 'PostToolUseFailure', tool, isInterrupt: interrupt }); }
  stop() { this.status = 'done'; return this.hook({ event: 'Stop' }); }
  advance(ms: number) { this.t += ms; return this.feed({ k: 'tick' }); }
  statusline(pct: number) { this.ctx = { pct, at: this.t, source: 'statusline' }; return this.feed({ k: 'statusline', ctx: this.ctx }); }
}

describe('repeat', () => {
  it('the same tool and input three times in a row is flagged; a different call clears it', () => {
    const r = new Rig();
    r.prompt();
    expect(r.pre('Read', 'a.ts')).toBeUndefined();
    r.post('Read');
    expect(r.pre('Read', 'a.ts')).toBeUndefined();
    r.post('Read');
    expect(r.pre('Read', 'a.ts')).toMatchObject({ reason: 'repeat', since: r.t });
    r.post('Read');
    expect(r.pre('Read', 'a.ts')?.reason).toBe('repeat'); // the 4th keeps it
    expect(r.pre('Read', 'b.ts')).toBeUndefined();
  });
  it('same tool, different input does not repeat', () => {
    const r = new Rig();
    r.prompt();
    for (const f of ['a', 'b', 'a', 'b', 'a', 'b']) expect(r.pre('Read', f)).toBeUndefined();
  });
  it('the real fixture bodies hash equal when equal (Bash exit 3 three times)', () => {
    const r = new Rig();
    r.prompt();
    const pre = fromBody(body('PreToolUse-Bash.json'));
    let v;
    for (let i = 0; i < 3; i++) v = r.hook(pre);
    expect(v?.reason).toBe('repeat');
  });
  it('a subagent has its own streak', () => {
    const r = new Rig();
    r.prompt();
    r.hook({ event: 'PreToolUse', tool: 'Read', summary: 'x', agentId: 'a1' });
    r.hook({ event: 'PreToolUse', tool: 'Read', summary: 'x' });
    r.hook({ event: 'PreToolUse', tool: 'Read', summary: 'x', agentId: 'a1' });
    expect(r.hook({ event: 'PreToolUse', tool: 'Read', summary: 'x' })).toBeUndefined();
  });
  it('AskUserQuestion is never a loop', () => {
    const r = new Rig();
    r.prompt();
    for (let i = 0; i < 5; i++) expect(r.pre('AskUserQuestion', 'same question')).toBeUndefined();
  });
});

describe('failures', () => {
  it('three failures in a row from the fixture shape; a success resets', () => {
    const r = new Rig();
    r.prompt();
    const f = fromBody(body('PostToolUseFailure-Bash-exit3.json'));
    expect(f).toMatchObject({ event: 'PostToolUseFailure', isInterrupt: false });
    r.pre('Bash', 'a'); expect(r.hook(f)).toBeUndefined();
    r.pre('Bash', 'b'); expect(r.hook(f)).toBeUndefined();
    r.pre('Bash', 'c');
    expect(r.hook(f)?.reason).toBe('failures');
    r.pre('Bash', 'd');
    expect(r.post('Bash')).toBeUndefined();
  });
  it('a success in between keeps the count below three', () => {
    const r = new Rig();
    r.prompt();
    for (const s of ['a', 'b']) { r.pre('Bash', s); r.fail('Bash'); }
    r.pre('Bash', 'c'); r.post('Bash');
    r.pre('Bash', 'd');
    expect(r.fail('Bash')).toBeUndefined();
  });
  it('interrupts (S12) are not failures and wipe the streaks', () => {
    const r = new Rig();
    r.prompt();
    for (const s of ['a', 'b']) { r.pre('Bash', s); r.fail('Bash'); }
    r.pre('Bash', 'c');
    expect(r.fail('Bash', true)).toBeUndefined();
    r.pre('Bash', 'd');
    expect(r.fail('Bash')).toBeUndefined(); // streak restarted
  });
  it('the turn ending clears the flag', () => {
    const r = new Rig();
    r.prompt();
    for (const s of ['a', 'b', 'c']) { r.pre('Bash', s); r.fail('Bash'); }
    expect(r.d.current()?.reason).toBe('failures');
    expect(r.stop()).toBeUndefined();
  });
});

describe('ctx_no_progress', () => {
  it('flags at 90% with ten tool calls and no edit; an Edit clears; below 90% never flags', () => {
    const r = new Rig();
    r.prompt();
    for (let i = 0; i < 10; i++) r.pre('Read', `f${i}`);
    expect(r.d.current()).toBeUndefined();
    expect(r.statusline(89)).toBeUndefined();
    expect(r.statusline(90)?.reason).toBe('ctx_no_progress');
    expect(r.pre('Edit', 'x')).toBeUndefined();
  });
  it('an edit inside the last ten means progress', () => {
    const r = new Rig();
    r.prompt();
    r.statusline(95);
    r.pre('Write', 'w');
    for (let i = 0; i < 9; i++) expect(r.pre('Read', `f${i}`)).toBeUndefined();
    expect(r.pre('Read', 'f9')?.reason).toBe('ctx_no_progress'); // the Write fell out of the window
  });
  it('fewer than ten calls is not enough evidence', () => {
    const r = new Rig();
    r.prompt();
    r.statusline(97);
    for (let i = 0; i < 9; i++) expect(r.pre('Read', `f${i}`)).toBeUndefined();
  });
  it('a compaction clears it', () => {
    const r = new Rig();
    r.prompt();
    for (let i = 0; i < 10; i++) r.pre('Read', `f${i}`);
    r.statusline(93);
    expect(r.d.current()?.reason).toBe('ctx_no_progress');
    expect(r.hook({ event: 'PostCompact' })).toBeUndefined();
  });
});

describe('quiet', () => {
  const MIN = 60_000;
  it('20 minutes of work and 5 minutes without a tool start', () => {
    const r = new Rig();
    r.prompt();
    r.pre('Read', 'a'); r.post('Read');
    expect(r.advance(19 * MIN)).toBeUndefined(); // 19 min, quiet for 19: not yet working 20
    expect(r.advance(2 * MIN)?.reason).toBe('quiet');
    expect(r.pre('Read', 'b')).toBeUndefined(); // any tool start clears it
  });
  it('under 20 minutes of work never flags, however quiet', () => {
    const r = new Rig();
    r.prompt();
    expect(r.advance(19 * MIN)).toBeUndefined();
  });
  it('a recent tool start keeps it quiet-free', () => {
    const r = new Rig();
    r.prompt();
    r.advance(18 * MIN);
    r.pre('Read', 'a'); r.post('Read');
    expect(r.advance(4 * MIN)).toBeUndefined();
    expect(r.advance(2 * MIN)?.reason).toBe('quiet');
  });
  it('a running Bash is excluded until it finishes', () => {
    const r = new Rig();
    r.prompt();
    r.pre('Bash', 'npm run build', 'bash1');
    expect(r.advance(30 * MIN)).toBeUndefined();
    r.post('Bash', 'bash1');
    expect(r.advance(1)).toBeUndefined(); // the 5 minutes count from the end of the Bash
    expect(r.advance(5 * MIN)?.reason).toBe('quiet');
  });
  it('waiting for the person is not quiet, and the clock restarts when work resumes', () => {
    const r = new Rig();
    r.prompt();
    r.pre('Read', 'a'); r.post('Read');
    r.advance(25 * MIN);
    r.d.current(); // flagged by now
    r.status = 'permission';
    expect(r.advance(10 * MIN)).toBeUndefined();
    r.status = 'working';
    expect(r.advance(MIN)).toBeUndefined(); // 1 minute since work resumed
    expect(r.advance(5 * MIN)?.reason).toBe('quiet');
  });
  it('an interrupted or finished turn is not stuck', () => {
    const r = new Rig();
    r.prompt();
    r.advance(30 * MIN);
    r.status = 'interrupted';
    expect(r.feed({ k: 'tick' })).toBeUndefined();
  });
});

describe('flag identity', () => {
  it('keeps `since` while the reason holds and restarts it when the reason changes', () => {
    const r = new Rig();
    r.prompt();
    const first = r.pre('Read', 'a') ?? r.pre('Read', 'a') ?? r.pre('Read', 'a');
    expect(first?.reason).toBe('repeat');
    r.t += 5000;
    const again = r.pre('Read', 'a');
    expect(sameStuck(first, again)).toBe(true);
  });
  it('constants match the plan', () => {
    expect(STUCK_LIMITS).toMatchObject({ repeat: 3, failures: 3, ctxPct: 90, ctxWindow: 10, quietWorkingMs: 1_200_000, quietToolMs: 300_000 });
  });
});

describe('false-positive guard: a normal busy turn', () => {
  it('120 varied tool calls with edits, successes and the odd failure never flag', () => {
    const r = new Rig();
    r.prompt();
    r.statusline(60);
    for (let i = 0; i < 120; i++) {
      const tool = ['Read', 'Grep', 'Edit', 'Bash'][i % 4]!;
      expect(r.pre(tool, `input ${i}`)).toBeUndefined();
      if (i % 17 === 0) expect(r.fail(tool)).toBeUndefined();
      else r.post(tool);
      r.t += 20_000;
    }
  });
});
