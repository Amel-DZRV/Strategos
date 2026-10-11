// "Needs you" strip across the top of the Map: everything waiting on the owner, most urgent first (plan section 6
// rule 5). Compact chips like the design (glyph, name, "repo . waiting Xm"); choosing one selects the session and
// opens the drawer, where the PendingCard shows the command in full with Approve / Deny (D21 lives there).
import type { SessionRecord } from '@strategos/shared';
import { fmtWait, repoName, statusInfo, waitingMs } from '../format.ts';
import { now } from '../state/clock.ts';
import { store } from '../state/store.ts';
import { lowRiskItems } from '../features/lowrisk.ts';
import { lowRiskOpen, openDrawer, selectedId } from '../state/ui.ts';
import { tokenLabel } from './Token.tsx';

function Chip({ s, nowMs }: { s: SessionRecord; nowMs: number }) {
  const st = statusInfo(s.status);
  const on = selectedId.value === s.strategosId;
  return (
    <button
      type="button" class={`nchip ${on ? 'on' : ''}`} style={`--stc:${st.colour}`} data-sid={s.strategosId} data-status={s.status}
      aria-label={tokenLabel(s, nowMs)} aria-pressed={on} onClick={() => openDrawer(s.strategosId)}
    >
      <span class="g" aria-hidden="true">{st.glyph}</span>
      <span class="who">
        <span class="nm">{s.displayName}</span>
        <small>{repoName(s)} · waiting {fmtWait(waitingMs(s, nowMs))}</small>
      </span>
    </button>
  );
}

export function NeedsStrip() {
  const list = store.needsYou.value;
  const nowMs = now.value;
  const lowRisk = lowRiskItems(list).length;
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
      {lowRisk > 0 ? (
        <button type="button" class="lowrisk" title="Approve every waiting read or in-repo write after a check" onClick={() => { lowRiskOpen.value = true; }}>
          Approve all low-risk ({lowRisk})
        </button>
      ) : null}
    </section>
  );
}
