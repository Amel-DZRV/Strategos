// The chat tab of the drawer (5.02 to 5.04): the session read as a conversation, an activity line, the pending card
// inline, and the reply box. The terminal tab stays mounted next to it, so switching loses nothing.
import { useEffect } from 'preact/hooks';
import type { ChatItem, SessionRecord } from '@strategos/shared';
import { PendingCard } from '../drawer/PendingCard.tsx';
import { drawerTab } from '../state/ui.ts';
import { ChatItemView } from './ChatItemView.tsx';
import { dropFeed, feedOf, followChat } from './feed.ts';
import { ReplyBox } from './ReplyBox.tsx';
import { VirtualList } from './VirtualList.tsx';

export function activityText(s: SessionRecord): string | null {
  if (s.status !== 'working' && s.status !== 'starting') return null;
  if (!s.now) return s.status === 'starting' ? 'Starting…' : 'Working…';
  return `Running ${s.now.tool}${s.now.summary ? `: ${s.now.summary}` : ''}…`;
}

const keyOf = (i: ChatItem) => i.id;
const render = (i: ChatItem) => <ChatItemView item={i} />;

export function ChatPane({ session, active }: { session: SessionRecord; active: boolean }) {
  const id = session.strategosId;
  // Follow the feed only while the tab is showing; the list stays in memory so coming back is instant, then refreshes.
  useEffect(() => (active ? followChat(id) : undefined), [id, active]);
  useEffect(() => () => dropFeed(id), [id]);

  const feed = feedOf(id);
  const activity = activityText(session);
  const empty = feed.items.length === 0;

  return (
    <div class="chat">
      <VirtualList
        class="chatlist" label="Conversation" items={feed.items} keyOf={keyOf} render={render}
        header={feed.truncatedBefore > 0 ? <p class="chatnote">{feed.truncatedBefore} earlier items are not shown.</p> : undefined}
        footer={(
          <div class="chatfoot">
            {empty ? <p class="chatnote">{feed.rev === 0 ? 'Loading the conversation…' : 'No messages yet.'}</p> : null}
            {session.pending ? (
              <PendingCard session={session} onOpenTerminal={() => { drawerTab.value = 'term'; }} />
            ) : null}
            {activity ? <p class="activity mono" role="status" data-testid="activity"><span class="dot" aria-hidden="true" /> {activity}</p> : null}
          </div>
        )}
      />
      <ReplyBox session={session} active={active} />
    </div>
  );
}
