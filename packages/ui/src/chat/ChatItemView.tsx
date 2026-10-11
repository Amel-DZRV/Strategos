// One ChatItem as a card (design screenshots 02 and 03): user bubble, assistant markdown, collapsed tool card with an
// expandable result or coloured diff, collapsible sub-agent thread, thin separators for compact / interrupted / marker.
import { signal } from '@preact/signals';
import type { ChatItem } from '@strategos/shared';
import { renderMarkdown } from './markdown.ts';

type ToolItem = Extract<ChatItem, { k: 'tool' }>;
type SubagentItem = Extract<ChatItem, { k: 'subagent' }>;

/** Which cards are open, by item id. Module level so a card keeps its state when the window scrolls it out and back. */
const openIds = signal<ReadonlySet<string>>(new Set());
export function toggleOpen(id: string): void {
  const next = new Set(openIds.value);
  if (!next.delete(id)) next.add(id);
  openIds.value = next;
}
export function resetOpen(): void { openIds.value = new Set(); }

const MAX_RESULT = 20_000;
const clip = (s: string): { text: string; cut: boolean } => (s.length > MAX_RESULT ? { text: s.slice(0, MAX_RESULT), cut: true } : { text: s, cut: false });

/** A unified diff, one coloured line each. The colour is never the only cue: the +/- sign stays in the text. */
export function DiffView({ diff }: { diff: string }) {
  const { text, cut } = clip(diff);
  return (
    <pre class="diff mono" aria-label="Diff">
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'dh'
          : line.startsWith('@@') ? 'dk' : line.startsWith('+') ? 'da' : line.startsWith('-') ? 'dd' : 'dc';
        return <span key={i} class={`dl ${cls}`}>{line}{'\n'}</span>;
      })}
      {cut ? <span class="dl dc">… cut at {MAX_RESULT} characters</span> : null}
    </pre>
  );
}

function ToolCard({ item }: { item: ToolItem }) {
  const open = openIds.value.has(item.id);
  const body = item.diff !== undefined && item.diff !== '' ? 'diff' : item.result !== undefined && item.result !== '' ? 'result' : null;
  const state = item.ok === undefined ? 'running' : item.ok ? 'ok' : 'failed';
  return (
    <div class={`citem tool ${state} ${open ? 'open' : ''}`} data-k="tool">
      <button
        type="button" class="thead" aria-expanded={open} disabled={body === null}
        onClick={() => toggleOpen(item.id)}
      >
        <b class="tn">{item.tool}</b>
        <span class="ts mono">{item.summary}</span>
        <span class={`tstate ${state}`}>{state === 'running' ? 'RUNNING' : state === 'ok' ? '✓' : 'FAILED'}</span>
      </button>
      {open && body === 'diff' ? <DiffView diff={item.diff!} /> : null}
      {open && body === 'result' ? <ResultView text={item.result!} /> : null}
    </div>
  );
}

function ResultView({ text }: { text: string }) {
  const { text: t, cut } = clip(text);
  return <pre class="result mono" aria-label="Result">{t}{cut ? `\n… cut at ${MAX_RESULT} characters` : ''}</pre>;
}

function SubagentThread({ item }: { item: SubagentItem }) {
  const open = openIds.value.has(item.id);
  return (
    <div class={`citem subagent ${open ? 'open' : ''}`} data-k="subagent">
      <button type="button" class="thead" aria-expanded={open} onClick={() => toggleOpen(item.id)}>
        <b class="tn">Sub-agent</b>
        <span class="ts">{item.brief}</span>
        <span class="tstate">{item.items.length} {item.items.length === 1 ? 'step' : 'steps'}</span>
      </button>
      {open ? (
        <div class="thread">
          {item.items.map((c) => <ChatItemView key={c.id} item={c} />)}
        </div>
      ) : null}
    </div>
  );
}

const MARKER_TEXT = { clear: 'Conversation cleared', resume: 'Resumed', fork: 'Forked from an earlier session', unknown: 'Conversation history changed' } as const;

function time(at: number | undefined): string | undefined {
  return at === undefined ? undefined : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.k) {
    case 'user':
      return <div class="citem user" data-k="user" title={time(item.at)}>{item.text}</div>;
    case 'assistant':
      // renderMarkdown has HTML disabled: model text can never become elements.
      return <div class="citem assistant md" data-k="assistant" title={time(item.at)} dangerouslySetInnerHTML={{ __html: renderMarkdown(item.md) }} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'subagent':
      return <SubagentThread item={item} />;
    case 'compact':
      return <div class="citem sep" data-k="compact" role="separator"><span>Context compacted</span></div>;
    case 'interrupted':
      return <div class="citem sep warn" data-k="interrupted" role="separator"><span>Interrupted</span></div>;
    case 'marker':
      return <div class="citem sep" data-k="marker" role="separator"><span>{MARKER_TEXT[item.marker]}</span></div>;
  }
}
