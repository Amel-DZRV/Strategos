import { useEffect, useRef, useState } from 'preact/hooks';
import type { Pending, PendingQuestion, SessionRecord } from '@strategos/shared';
import { fmtWait, RISK_LABEL } from '../format.ts';
import { now } from '../state/clock.ts';
import { denyFocusTick } from '../state/ui.ts';
import {
  always, answerQuestion, approve, deny, expandFull, expanded, fullInput, needsExpand, release,
} from './pending-actions.ts';

export function RiskChips({ risk }: { risk: Pending['risk'] }) {
  return (
    <span class="risks">
      {risk.map((r) => (
        <span key={r} class={`chip risk risk-${r}`} title={`Risk: ${r.replace('_', ' ')}`}>{RISK_LABEL[r]}</span>
      ))}
    </span>
  );
}

function QuestionBlock({ q, value, onChange }: { q: PendingQuestion; value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (label: string) => {
    if (q.multiSelect) onChange(value.includes(label) ? value.filter((v) => v !== label) : [...value, label]);
    else onChange([label]);
  };
  return (
    <fieldset class="question">
      <legend>{q.header ? <span class="chip">{q.header}</span> : null} {q.question}</legend>
      <div class="options" role={q.multiSelect ? 'group' : 'radiogroup'}>
        {q.options.map((o) => {
          const on = value.includes(o.label);
          return (
            <button
              type="button" key={o.label} class={`opt ${on ? 'on' : ''}`}
              role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => toggle(o.label)}
            >
              <b>{o.label}</b>
              {o.description ? <small>{o.description}</small> : null}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function QuestionForm({ session, pending }: { session: SessionRecord; pending: Pending }) {
  const questions = pending.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const complete = questions.length > 0 && questions.every((q) => (picked[q.question]?.length ?? 0) > 0);
  const submit = () => {
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = (picked[q.question] ?? []).join(', ');
    void answerQuestion(session, answers);
  };
  if (questions.length === 0) {
    return <p class="muted">{pending.inputSummary}</p>;
  }
  return (
    <div class="qform">
      {questions.map((q) => (
        <QuestionBlock key={q.question} q={q} value={picked[q.question] ?? []} onChange={(v) => setPicked({ ...picked, [q.question]: v })} />
      ))}
      <div class="actions">
        <button type="button" class="btn primary" disabled={!complete} onClick={submit}>Send answer</button>
      </div>
    </div>
  );
}

export function PendingCard({ session, onOpenTerminal }: { session: SessionRecord; onOpenTerminal?: () => void }) {
  const pending = session.pending;
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLInputElement>(null);
  const tick = denyFocusTick.value;

  useEffect(() => {
    if (tick > 0) reasonRef.current?.focus();
  }, [tick]);

  if (!pending) return null;
  const waited = fmtWait(now.value - pending.since);
  const isExpanded = expanded.value.has(pending.requestId);
  const blocked = needsExpand(session);
  const full = fullInput.value[pending.requestId];
  const suggestions = pending.suggestions ?? [];

  return (
    <section class={`pending ${pending.kind}`} aria-label={`${pending.kind === 'permission' ? 'Permission request' : 'Question'} from ${session.displayName}`}>
      <header>
        <b class="tool">{pending.kind === 'permission' ? pending.toolName : 'Question'}</b>
        {pending.kind === 'permission' ? <RiskChips risk={pending.risk} /> : null}
        {pending.agentId ? <span class="chip" title={`Asked by sub-agent ${pending.agentId}`}>sub-agent</span> : null}
        <span class="since mono">waiting {waited}</span>
      </header>

      {pending.kind === 'permission' ? (
        <>
          <pre class="input mono" tabIndex={0} aria-label="Tool input">{isExpanded && full !== undefined ? full : pending.inputSummary}{!isExpanded && pending.inputTruncated ? ' …' : ''}</pre>
          {pending.inputTruncated && !isExpanded ? (
            <p class="warn" role="note">This input was cut short. Approve opens the full input first; nothing is approved until you have seen it.</p>
          ) : null}
          {pending.inputTruncated && isExpanded && full === undefined ? (
            <p class="muted" role="note">Full input: waiting for the daemon to send it.</p>
          ) : null}
        </>
      ) : (
        <QuestionForm session={session} pending={pending} />
      )}

      {!pending.held ? (
        <p class="muted" role="note">Strategos is not holding this one. Answer it in the terminal.</p>
      ) : pending.kind === 'permission' ? (
        <div class="actions">
          <button type="button" class="btn primary" aria-keyshortcuts="a" onClick={() => void approve(session)}>
            {blocked ? 'Approve (show full input)' : 'Approve'}
          </button>
          <input
            ref={reasonRef} class="reason" type="text" placeholder="Reason for Claude (optional)" aria-label="Deny message (optional)"
            value={reason} onInput={(e) => setReason(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void deny(session, reason).then((ok) => { if (ok) setReason(''); });
              if (e.key === 'Escape') e.currentTarget.blur();
            }}
          />
          <button type="button" class="btn danger" aria-keyshortcuts="d" onClick={() => void deny(session, reason)}>Deny</button>
          {suggestions.length > 0 ? suggestions.map((s, i) => (
            <button
              key={i} type="button" class="btn" aria-keyshortcuts={i === 0 ? 'Shift+A' : undefined}
              title={suggestionText(s)} onClick={() => void always(session, i)}
            >
              {suggestions.length > 1 ? `Always (${i + 1})` : 'Always allow'}
            </button>
          )) : null}
          {blocked ? <button type="button" class="btn" onClick={() => void expandFull(session)}>Show full input</button> : null}
        </div>
      ) : null}

      {pending.held ? (
        <div class="actions secondary">
          <button type="button" class="btn link" onClick={() => { void release(session); onOpenTerminal?.(); }}>Answer in terminal</button>
        </div>
      ) : (
        <div class="actions secondary">
          <button type="button" class="btn link" onClick={() => onOpenTerminal?.()}>Open terminal</button>
        </div>
      )}
    </section>
  );
}

function suggestionText(s: unknown): string {
  try {
    return JSON.stringify(s).slice(0, 300);
  } catch {
    return 'permission rule';
  }
}
