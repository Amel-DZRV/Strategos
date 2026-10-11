// Client-side mirror of the daemon's state. The daemon is authoritative; this only applies what it sends.
// Plan D5: snapshot(seq) then ordered deltas. A gap in seq is reported to the caller, which asks for a resync.
import { batch, computed, signal } from '@preact/signals';
import {
  compareNeedsYou, isNeedsYou,
  type DaemonEvent, type DigestData, type Initiative, type PlanetInfo, type SessionRecord, type UiPrefs, type Usage,
} from '@strategos/shared';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'unpaired' | 'incompatible';

export interface HelloInfo {
  daemonVersion: string;
  claudeVersion: string;
  testedRange: string;
  inRange: boolean;
}

/** What applyEvent decided: 'gap' means the caller must send a resync; 'stale' means the event was a repeat. */
export type ApplyResult = 'applied' | 'gap' | 'stale' | 'ignored';

export type NotifyEvent = Extract<DaemonEvent, { t: 'notify' }>;
export interface Suggestion { id: string; kind: 'initiative' | 'park'; text: string; strategosIds: string[] }

export const DEFAULT_PREFS: UiPrefs = {
  groupBy: 'repo',
  notifications: { enabled: true, sound: true, onPermission: true, onQuestion: true, onErrored: true, onDone: false, escalate: true },
  keymap: {},
};

/** Rows: needs-you first (rank, then oldest wait), then everything else in creation order. */
export function sortRows(a: SessionRecord, b: SessionRecord): number {
  const na = isNeedsYou(a);
  const nb = isNeedsYou(b);
  if (na || nb) return compareNeedsYou(a, b);
  return a.createdAt - b.createdAt;
}

export function createStore() {
  const sessions = signal<ReadonlyMap<string, SessionRecord>>(new Map());
  const planets = signal<PlanetInfo[]>([]);
  const initiatives = signal<Initiative[]>([]);
  const usage = signal<Usage | undefined>(undefined);
  const prefs = signal<UiPrefs>(DEFAULT_PREFS);
  const resources = signal<{ totalMb: number; cpuPct: number } | undefined>(undefined);
  const connection = signal<ConnStatus>('connecting');
  const hello = signal<HelloInfo | undefined>(undefined);
  const digestToday = signal<DigestData | undefined>(undefined);
  /** Text for the polite live region: set when a session newly needs the owner. */
  const announcement = signal('');
  /** True once a snapshot has arrived on the current connection. */
  const synced = signal(false);
  /** Suggestions from the daemon (a park nudge, an initiative match) until the owner answers or dismisses them. */
  const suggestions = signal<readonly Suggestion[]>([]);
  const notifyListeners = new Set<(ev: NotifyEvent) => void>();
  let lastSeq: number | null = null;

  const sorted = computed(() => [...sessions.value.values()].filter((s) => !s.archived).sort(sortRows));
  const needsYou = computed(() => sorted.value.filter(isNeedsYou));

  function announceIfNew(prev: SessionRecord | undefined, next: SessionRecord): void {
    if (!isNeedsYou(next)) return;
    if (prev && isNeedsYou(prev) && prev.status === next.status) return;
    const what = next.status === 'permission' ? 'needs permission'
      : next.status === 'question' ? 'has a question'
        : next.status === 'errored' ? 'hit an error'
          : next.status === 'done' ? 'is done'
            : next.status === 'trust_pending' ? 'is waiting for folder trust'
              : 'was interrupted';
    announcement.value = `${next.displayName} ${what}`;
  }

  function upsert(rec: SessionRecord): void {
    const prev = sessions.value.get(rec.strategosId);
    const next = new Map(sessions.value);
    next.set(rec.strategosId, rec);
    sessions.value = next;
    announceIfNew(prev, rec);
  }

  function applySnapshot(ev: Extract<DaemonEvent, { t: 'snapshot' }>): void {
    batch(() => {
      sessions.value = new Map(ev.sessions.map((s) => [s.strategosId, s]));
      planets.value = ev.planets;
      initiatives.value = ev.initiatives;
      usage.value = ev.usage;
      prefs.value = ev.prefs;
      lastSeq = ev.seq;
      synced.value = true;
    });
  }

  function applyEvent(ev: DaemonEvent): ApplyResult {
    switch (ev.t) {
      case 'hello':
        hello.value = { daemonVersion: ev.daemonVersion, claudeVersion: ev.claudeVersion, testedRange: ev.testedRange, inRange: ev.inRange };
        return 'applied';
      case 'snapshot':
        applySnapshot(ev);
        return 'applied';
      case 'digest':
        digestToday.value = ev.digest;
        return 'applied';
      case 'session.upsert': case 'session.removed': case 'planets': case 'initiatives': case 'usage': case 'resources':
      case 'notify': case 'suggestion':
        break;
      default:
        return 'ignored'; // channel events and acks are handled by the connection
    }
    if (lastSeq === null) return 'ignored'; // deltas before the first snapshot cannot be placed
    if (ev.seq <= lastSeq) return 'stale';
    if (ev.seq !== lastSeq + 1) return 'gap';
    lastSeq = ev.seq;
    batch(() => {
      switch (ev.t) {
        case 'session.upsert': upsert(ev.session); break;
        case 'session.removed': {
          const next = new Map(sessions.value);
          next.delete(ev.strategosId);
          sessions.value = next;
          break;
        }
        case 'planets': planets.value = ev.planets; break;
        case 'initiatives': initiatives.value = ev.initiatives; break;
        case 'usage': usage.value = ev.usage; break;
        case 'resources': resources.value = { totalMb: ev.totalMb, cpuPct: ev.cpuPct }; break;
        case 'suggestion':
          suggestions.value = [...suggestions.value.filter((x) => x.id !== ev.id), { id: ev.id, kind: ev.kind, text: ev.text, strategosIds: ev.strategosIds }];
          break;
        case 'notify':
          // Only a live delta reaches here: a snapshot or a resync never raises a notification.
          for (const fn of [...notifyListeners]) fn(ev);
          break;
        default: break;
      }
    });
    return 'applied';
  }

  /** The socket dropped: keep showing the last state, but a new connection starts with a new snapshot and seq. */
  function markDisconnected(): void {
    lastSeq = null;
    synced.value = false;
  }

  function onNotify(fn: (ev: NotifyEvent) => void): () => void {
    notifyListeners.add(fn);
    return () => { notifyListeners.delete(fn); };
  }

  function removeSuggestion(id: string): void {
    suggestions.value = suggestions.value.filter((x) => x.id !== id);
  }

  return {
    suggestions, onNotify, removeSuggestion,
    sessions, planets, initiatives, usage, prefs, resources, connection, hello, digestToday, announcement, synced,
    sorted, needsYou,
    applyEvent, markDisconnected,
    get lastSeq() { return lastSeq; },
  };
}

export type Store = ReturnType<typeof createStore>;

export const store = createStore();
