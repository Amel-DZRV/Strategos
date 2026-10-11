// Reply box (5.04). Enabled only where the daemon will take a reply: done, seen, interrupted, or a question that is not
// held (it is answered in the terminal). The daemon also refuses while the terminal has half-typed input; its reason is
// shown as it comes. Enter sends, Shift+Enter makes a new line.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionRecord } from '@strategos/shared';
import { send } from '../state/commands.ts';
import { replyFocusTick } from '../state/ui.ts';

export interface ReplyGate { ok: boolean; hint: string }

export function replyGate(s: SessionRecord): ReplyGate {
  switch (s.status) {
    case 'done': case 'seen': case 'interrupted':
      return { ok: true, hint: '' };
    case 'question':
      return s.pending && !s.pending.held
        ? { ok: true, hint: '' }
        : { ok: false, hint: 'Answer the question above, or in the terminal.' };
    case 'permission':
      return { ok: false, hint: 'Waiting for your decision above.' };
    case 'working': case 'starting':
      return { ok: false, hint: 'Claude is working. You can reply when it stops.' };
    case 'stopped': case 'parked': case 'errored': case 'open_elsewhere':
      return { ok: false, hint: 'This session is not running.' };
    default:
      return { ok: false, hint: 'Not ready for a reply yet.' };
  }
}

export function ReplyBox({ session, active = true }: { session: SessionRecord; active?: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const gate = replyGate(session);
  const tick = replyFocusTick.value;

  useEffect(() => {
    if (tick > 0 && active) area.current?.focus();
  }, [tick, active]);

  const submit = async () => {
    const body = text.trim();
    if (!gate.ok || busy || body === '') return;
    setBusy(true);
    setError('');
    try {
      await send({ c: 'reply.send', strategosId: session.strategosId, text: body });
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); // the daemon's reason, e.g. half-typed input in the terminal
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="reply" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div class="replyrow">
        <textarea
          ref={area} rows={1} value={text} disabled={!gate.ok} aria-label="Reply to this session" aria-keyshortcuts="r"
          placeholder={gate.ok ? 'Reply to this session' : gate.hint}
          onInput={(e) => { setText(e.currentTarget.value); if (error) setError(''); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <button type="submit" class="btn" disabled={!gate.ok || busy || text.trim() === ''}>Send</button>
      </div>
      {error ? <p class="error" role="alert">{error}</p> : null}
      {!gate.ok ? <p class="hint">{gate.hint}</p> : null}
    </form>
  );
}
