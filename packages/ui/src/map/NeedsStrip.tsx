// "Needs you" strip across the top of the Map: everything waiting on the owner, most urgent first (plan section 6
// rule 5), with the waiting time, the risk and the command in full, and inline Approve / Deny. It scrolls sideways
// instead of cutting anything off. Approve follows the D21 rule in pending-actions.ts (a cut-short input opens the
// full card first).
import type { SessionRecord } from '@strategos/shared';
import { approve, deny, needsExpand } from '../drawer/pending-actions.ts';
import { RiskChips } from '../drawer/PendingCard.tsx';
import { fmtWait, repoName, statusInfo, waitingMs } from '../format.ts';
import { now } from '../state/clock.ts';
import { store } from '../state/store.ts';
import { openDrawer, selectedId } from '../state/ui.ts';
import { tokenLabel } from './Token.tsx';

function Chip({ s, nowMs }: { s: SessionRecord; nowMs: number }) {
  const st = statusInfo(s.status);
  const p = s.pending;
  const inline = p !== undefined && p.held && p.kind === 'permission';
  return (
    <div class={`nchip ${selectedId.value === s.strategosId ? 'on' : ''}`} style={`--stc:${st.colour}`} data-sid={s.strategosId} data-status={s.status}>
      <button type="button" class="nsel" aria-label={tokenLabel(s, nowMs)} onClick={() => openDrawer(s.strategosId)}>
        <span class="g" aria-hidden="true">{st.glyph}</span>
        <span class="who">
          {s.displayName}
          <br />
          <small>{repoName(s)} · waiting {fmtWait(waitingMs(s, nowMs))}</small>
        </span>
      </button>
      {p && p.kind === 'permission' ? (
        <>
          <RiskChips risk={p.risk.slice(0, 1)} />
          <code class="cmd mono" title={p.inputSummary}>{p.toolName}: {p.inputSummary}{p.inputTruncated ? ' …' : ''}</code>
        </>
      ) : null}
      {p && p.kind === 'question' ? <span class="q">{p.questions?.[0]?.question ?? p.inputSummary}</span> : null}
      {inline ? (
        <>
          <button type="button" class="mbtn primary" title={needsExpand(s) ? 'Opens the full input first' : 'Approve (a)'} onClick={() => void approve(s)}>Approve</button>
          <button type="button" class="mbtn danger" title="Deny (d)" onClick={() => void deny(s)}>Deny</button>
        </>
      ) : p && p.kind === 'question' ? (
        <button type="button" class="mbtn" onClick={() => openDrawer(s.strategosId)}>Answer</button>
      ) : null}
    </div>
  );
}

export function NeedsStrip() {
  const list = store.needsYou.value;
  const nowMs = now.value;
  return (
    <section class="strip mapstrip" aria-label="Needs you">
      <h4>Needs you</h4>
      {list.length === 0 ? (
        <span class="dim clear">Nothing waiting. All clear.</span>
      ) : (
        <div class="chips">
          {list.map((s) => <Chip key={s.strategosId} s={s} nowMs={nowMs} />)}
        </div>
      )}
    </section>
  );
}
