// Windowed list with measured row heights, for transcripts of thousands of items (5.02). Only the rows near the viewport
// exist in the DOM; spacers stand in for the rest. The list sticks to the bottom only while it already is at the bottom.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

const ESTIMATE = 84;
const OVERSCAN_PX = 600;
const NEAR_BOTTOM = 48;

export interface VirtualListProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T) => JSX.Element;
  /** Rendered after the list inside the scroller (pending card, activity line). */
  footer?: ComponentChildren;
  /** Rendered before the list (the "older history was left out" note). */
  header?: ComponentChildren;
  class?: string;
  label?: string;
}

/** First index whose bottom edge is below `y`, given row tops. */
export function firstVisible(tops: readonly number[], total: number, y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  void total;
  return Math.max(0, lo);
}

export function VirtualList<T>({ items, keyOf, render, footer, header, class: cls, label }: VirtualListProps<T>) {
  const box = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const atBottom = useRef(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [, setTick] = useState(0);

  // Row tops from measured (or estimated) heights.
  const tops: number[] = new Array<number>(items.length);
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    tops[i] = total;
    total += heights.current.get(keyOf(items[i]!)) ?? ESTIMATE;
  }
  const vh = viewH > 0 ? viewH : 600; // not laid out yet (hidden tab, test DOM)
  const start = items.length === 0 ? 0 : Math.max(0, firstVisible(tops, total, scrollTop - OVERSCAN_PX));
  let end = start;
  while (end < items.length && tops[end]! < scrollTop + vh + OVERSCAN_PX) end++;
  if (viewH === 0) end = Math.min(items.length, Math.max(end, start + 40)); // generous when we cannot measure
  const before = items.length === 0 ? 0 : tops[start]!;
  const after = end < items.length ? total - tops[end]! : 0;

  // Measure what is rendered; re-render once if any height differs from the estimate.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let changed = false;
    for (const row of el.querySelectorAll<HTMLElement>(':scope > .vrows > [data-key]')) {
      const h = row.offsetHeight;
      const k = row.dataset['key']!;
      if (h > 0 && Math.abs((heights.current.get(k) ?? ESTIMATE) - h) > 1) { heights.current.set(k, h); changed = true; }
    }
    if (changed) setTick((n) => n + 1);
    else if (atBottom.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    setViewH(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { setViewH(el.clientHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const raf = useRef(0);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (box.current) setScrollTop(box.current.scrollTop);
    });
  };

  return (
    <div ref={box} class={`vlist ${cls ?? ''}`} onScroll={onScroll} role="log" aria-label={label} aria-live="off" tabIndex={0}>
      {header}
      <div class="vrows" style={{ paddingTop: `${before}px`, paddingBottom: `${after}px` }}>
        {items.slice(start, end).map((it) => <div key={keyOf(it)} data-key={keyOf(it)} class="vrow">{render(it)}</div>)}
      </div>
      {footer}
    </div>
  );
}
