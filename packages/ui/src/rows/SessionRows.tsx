// Look A: one row per session. The temporary home until the Map arrives in M3.
import type { SessionRecord } from '@strategos/shared';
import { isNeedsYou } from '@strategos/shared';
import { approve, deny, needsExpand } from '../drawer/pending-actions.ts';
import { RiskChips } from '../drawer/PendingCard.tsx';
import { branchOf, canResume, canStop, ctxColour, ctxPct, fmtWait, money, repoName, statusInfo, waitingMs } from '../format.ts';
import { now } from '../state/clock.ts';
import { errorNotice, openDrawer, selectedId, selectSession, stopTarget } from '../state/ui.ts';
import { send } from '../state/commands.ts';
import { store } from '../state/store.ts';

export function rowLabel(s: SessionRecord, nowMs: number): string {
  const st = statusInfo(s.status);
  const needs = isNeedsYou(s);
  const parts = [s.displayName, st.label];
  if (needs) parts.push(`waiting ${fmtWait(waitingMs(s, nowMs))}`);
  const pct = ctxPct(s);
  parts.push(pct === null ? 'context unknown' : `context ${pct} percent`);
  return parts.join(', ');
}

async function resume(s: SessionRecord): Promise<void> {
  try {
    await send({ c: 'session.resume', strategosId: s.strategosId });
  } catch (e) {
    errorNotice.value = `Resume failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function SessionRow({ s }: { s: SessionRecord }) {
  const st = statusInfo(s.status);
  const nowMs = now.value;
  const needs = isNeedsYou(s);
  const pct = ctxPct(s);
  const selected = selectedId.value === s.strategosId;
  const p = s.pending;
  const inline = p && p.held && p.kind === 'permission';
  const what = s.now ? `${s.now.tool}: ${s.now.summary}` : null;

  return (
    <div
      class={`row ${selected ? 'on' : ''} ${needs ? 'needs' : ''}`} data-sid={s.strategosId} role="listitem" tabIndex={0}
      style={`--stc:${st.colour}`} aria-label={rowLabel(s, nowMs)} aria-current={selected ? 'true' : undefined}
      onFocus={() => selectSession(s.strategosId)}
      onClick={() => openDrawer(s.strategosId)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDrawer(s.strategosId);
        }
      }}
    >
      <span class="g" title={st.label} aria-hidden="true">{st.glyph}</span>
      <div class="c-name">
        <div class="t">{s.displayName}</div>
        <div class="s mono">{repoName(s)}{branchOf(s) ? ` · ${branchOf(s)}` : ''}</div>
      </div>
      <div class="c-now now mono">
        <span class="stlabel">{st.label}</span>
        {needs ? <span class="wait" title="Time waiting for you"> · {fmtWait(waitingMs(s, nowMs))}</span> : null}
        {what ? <div class="doing">{what}</div> : null}
      </div>
      <div class="c-last last">{s.last ?? ''}</div>
      <div class="c-ctx ctx" title={pct === null ? 'Context unknown' : `Context ${pct}%`}>
        {pct === null ? <span class="dim">–</span> : (
          <>
            <div class="bar"><i style={{ width: `${pct}%`, background: ctxColour(pct) }} /></div>
            <span>{pct}%</span>
          </>
        )}
      </div>
      <div class="c-cost cost mono">{money(s.cost.lineageUsd)}</div>
      <div class="c-act" onClick={(e) => e.stopPropagation()}>
        {canStop(s) ? <button type="button" class="mbtn" onClick={() => { stopTarget.value = s.strategosId; }}>Stop</button> : null}
        {canResume(s) ? <button type="button" class="mbtn" onClick={() => void resume(s)}>Resume</button> : null}
      </div>
      {inline && p ? (
        <div class="inl" onClick={(e) => e.stopPropagation()}>
          <RiskChips risk={p.risk} />
          <code class="mono">{p.toolName}: {p.inputSummary}{p.inputTruncated ? ' …' : ''}</code>
          <button type="button" class="mbtn primary" title={needsExpand(s) ? 'Opens the full input first' : 'Approve (a)'} onClick={() => void approve(s)}>Approve</button>
          <button type="button" class="mbtn danger" title="Deny (d)" onClick={() => void deny(s)}>Deny</button>
        </div>
      ) : p && p.kind === 'question' ? (
        <div class="inl" onClick={(e) => e.stopPropagation()}>
          <span class="q">{p.questions?.[0]?.question ?? p.inputSummary}</span>
          <button type="button" class="mbtn" onClick={() => openDrawer(s.strategosId)}>Answer</button>
        </div>
      ) : null}
    </div>
  );
}

export function NeedsStrip() {
  const list = store.needsYou.value;
  const nowMs = now.value;
  return (
    <div class="strip" aria-label="Needs you">
      <h4>Needs you</h4>
      {list.length === 0 ? <span class="dim">Nothing waiting. All clear.</span> : list.map((s) => {
        const st = statusInfo(s.status);
        return (
          <button
            key={s.strategosId} type="button" class={`nchip ${selectedId.value === s.strategosId ? 'on' : ''}`}
            style={`--stc:${st.colour}`} aria-label={rowLabel(s, nowMs)} onClick={() => openDrawer(s.strategosId)}
          >
            <span class="g" aria-hidden="true">{st.glyph}</span>
            <span>{s.displayName}<br /><small>{repoName(s)} · waiting {fmtWait(waitingMs(s, nowMs))}</small></span>
          </button>
        );
      })}
    </div>
  );
}

export function SessionRows() {
  const list = store.sorted.value;
  return (
    <div class="rows" role="list" aria-label="Sessions">
      <div class="rowhead" aria-hidden="true">
        <span /><span>Session</span><span>Status</span><span>Last message</span><span>Context</span><span class="right">Cost</span><span />
      </div>
      {list.length === 0 ? (
        <div class="empty">
          {store.synced.value ? 'No sessions yet. Press c or use New session to start one.' : 'Waiting for the daemon…'}
        </div>
      ) : list.map((s) => <SessionRow key={s.strategosId} s={s} />)}
    </div>
  );
}
