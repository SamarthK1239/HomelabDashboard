import { createContext, useContext, useMemo } from 'react';

import type { StatusEvent } from './types';

/**
 * The most recent status transition for each collector.
 *
 * Derived once in `App` from `/api/events` and shared, so that nine cards
 * asking "when did I last change?" cost one request rather than nine.
 */
export type LatestEvents = Record<string, StatusEvent>;

export const EventsContext = createContext<LatestEvents>({});

export function useLatestEvent(collector: string | undefined): StatusEvent | null {
  const events = useContext(EventsContext);
  return collector ? (events[collector] ?? null) : null;
}

/** Collapse a newest-first event log to one entry per collector. */
export function useLatestEvents(events: readonly StatusEvent[]): LatestEvents {
  return useMemo(() => {
    const latest: LatestEvents = {};
    for (const event of events) {
      if (!(event.collector in latest)) latest[event.collector] = event;
    }
    return latest;
  }, [events]);
}
