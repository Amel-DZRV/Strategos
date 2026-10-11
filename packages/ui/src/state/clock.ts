// A coarse shared clock so "14m" labels tick without every row owning a timer.
import { signal } from '@preact/signals';

export const now = signal(Date.now());

let timer: ReturnType<typeof setInterval> | undefined;
export function startClock(everyMs = 15_000): () => void {
  now.value = Date.now();
  if (timer !== undefined) clearInterval(timer);
  timer = setInterval(() => { now.value = Date.now(); }, everyMs);
  return () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
}
