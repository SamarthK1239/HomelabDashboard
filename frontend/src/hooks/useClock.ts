import { useEffect, useState } from 'react';

/**
 * A single shared 1Hz clock.
 *
 * Every card shows an age counter; giving each its own interval would mean a
 * dozen timers drifting against each other. One module-level ticker keeps the
 * counters in lockstep and stops entirely while the tab is hidden.
 */
const subscribers = new Set<(now: number) => void>();
let timer: number | null = null;

function tick(): void {
  const now = Date.now();
  for (const notify of subscribers) notify(now);
}

function start(): void {
  if (timer !== null || typeof window === 'undefined') return;
  timer = window.setInterval(tick, 1000);
}

function stop(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stop();
    } else if (subscribers.size > 0) {
      tick();
      start();
    }
  });
}

/** Epoch milliseconds, re-rendering the caller once a second. */
export function useClock(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    subscribers.add(setNow);
    start();
    return () => {
      subscribers.delete(setNow);
      if (subscribers.size === 0) stop();
    };
  }, []);

  return now;
}
