import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage, fetchJson, isAbortError } from '../api';
import type { EventLog, StatusEvent } from '../types';
import { usePageVisible } from './usePageVisible';

export interface UseEventsResult {
  events: StatusEvent[];
  error: string | null;
  refresh: () => void;
}

/**
 * Polls `/api/events` for collector status transitions.
 *
 * A snapshot says what is true now; this says what *changed*, which is the
 * question someone walking up to a wall display actually has. The log lives in
 * the backend's ring buffer, so it survives a browser reload but not a service
 * restart — an honest limitation for a monitor with no database.
 *
 * Polled on a slow fixed cadence rather than the dashboard's: transitions are
 * rare, and the drawer is usually closed.
 */
export function useEvents(enabled = true, limit = 50, pollSeconds = 15): UseEventsResult {
  const [events, setEvents] = useState<StatusEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const visible = usePageVisible();
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const payload = await fetchJson<EventLog>(
        `/api/events?limit=${limit}`,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setEvents(Array.isArray(payload.events) ? payload.events : []);
      setError(null);
    } catch (cause) {
      if (!isAbortError(cause)) setError(errorMessage(cause));
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, [limit]);

  useEffect(() => {
    if (!enabled || !visible) return;
    void load();
    const timer = window.setInterval(() => void load(), pollSeconds * 1000);
    return () => {
      window.clearInterval(timer);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [enabled, load, pollSeconds, visible]);

  const refresh = useCallback(() => void load(), [load]);

  return { events, error, refresh };
}
