// Context-full actions (5.05): when the context window is 70% full or more and the session is idle (done or seen), offer
// Compact, Hand off (only when the auto-handoff mod is installed) and Keepwarm 60m / 90m / 2h. Never mid-turn: the daemon
// refuses slash commands then, and a button that cannot work should not be there.
import type { AllowedSlash, SessionRecord } from '@strategos/shared';
import { ctxPct } from '../format.ts';
import { send } from '../state/commands.ts';
import { store } from '../state/store.ts';
import { errorNotice } from '../state/ui.ts';

export const CTX_OFFER_PCT = 70;

export function canSendSlash(s: SessionRecord): boolean {
  return s.status === 'done' || s.status === 'seen';
}

export function contextActionsVisible(s: SessionRecord): boolean {
  const pct = ctxPct(s);
  return pct !== null && pct >= CTX_OFFER_PCT && canSendSlash(s);
}

export async function sendSlash(id: string, cmd: AllowedSlash): Promise<boolean> {
  try {
    await send({ c: 'slash.send', strategosId: id, cmd });
    return true;
  } catch (e) {
    errorNotice.value = `${cmd} was refused: ${e instanceof Error ? e.message : String(e)}`;
    return false;
  }
}

export function ContextActions({ session }: { session: SessionRecord }) {
  if (!contextActionsVisible(session)) return null;
  const pct = ctxPct(session)!;
  const id = session.strategosId;
  const handoff = store.prefs.value.mods?.autoHandoff === true;
  return (
    <section class={`ctxactions ${pct >= 85 ? 'hot' : ''}`} aria-label="Context is getting full">
      <p class="ctxmsg">Context {pct}% full. Claude is idle, so this is a good moment.</p>
      <div class="ctxbtns">
        <button type="button" class="btn" title="Summarise the conversation to free space (/compact)" onClick={() => void sendSlash(id, '/compact')}>Compact</button>
        {handoff ? (
          <button type="button" class="btn" title="Write a handoff and continue in a fresh session (/handoff-now)" onClick={() => void sendSlash(id, '/handoff-now')}>Hand off</button>
        ) : null}
        <span class="kw" role="group" aria-label="Keep the prompt cache warm">
          <span class="kwl">Keepwarm</span>
          {(['60m', '90m', '2h'] as const).map((d) => (
            <button key={d} type="button" class="btn" title={`Keep the prompt cache warm for ${d} (/keepwarm ${d})`} onClick={() => void sendSlash(id, `/keepwarm ${d}`)}>{d}</button>
          ))}
        </span>
      </div>
    </section>
  );
}
