import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { errorMessage, fetchJson, isAbortError } from '../api';
import type { ConnectionState, Meta, Snapshot } from '../types';
import { usePageVisible } from './usePageVisible';

/** Refresh intervals offered in the header selector, in seconds. */
export const REFRESH_CHOICES = [1, 2, 5, 10, 30, 60] as const;

export const REFRESH_STORAGE_KEY = 'homelab.refreshSeconds';

/** Used until `/api/meta` answers, and if the stored value is nonsense. */
const FALLBACK_REFRESH_SECONDS = 5;

/** One failed poll means "stale"; this many in a row means "disconnected". */
const DISCONNECTED_AFTER_FAILURES = 3;

function readStoredRefresh(): number | null {
  try {
    const raw = window.localStorage.getItem(REFRESH_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    // Private browsing / disabled storage: fall back to the default.
    return null;
  }
}

function writeStoredRefresh(seconds: number): void {
  try {
    window.localStorage.setItem(REFRESH_STORAGE_KEY, String(seconds));
  } catch {
    // Persistence is a nicety, not a requirement.
  }
}

/** Snap an arbitrary backend default onto the nearest offered choice. */
function nearestChoice(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return FALLBACK_REFRESH_SECONDS;
  return REFRESH_CHOICES.reduce((best, choice) =>
    Math.abs(choice - seconds) < Math.abs(best - seconds) ? choice : best,
  );
}

export interface UseSnapshotResult {
  /** Last known snapshot. Kept on screen while stale, clearly marked as such. */
  snapshot: Snapshot | null;
  meta: Meta | null;
  connection: ConnectionState;
  /** Message from the most recent failed poll, cleared on success. */
  error: string | null;
  /** True while the very first fetch has not yet succeeded and has failed. */
  initialLoadFailed: boolean;
  /** Epoch ms of the last *successful* poll, or `null`. */
  lastUpdatedAt: number | null;
  /** Seconds since the last successful poll, or `null`. Ticks every second. */
  secondsSinceUpdate: number | null;
  consecutiveFailures: number;
  refreshSeconds: number;
  setRefreshSeconds: (seconds: number) => void;
  /** Fetch now, outside the polling cadence. */
  refresh: () => void;
  isFetching: boolean;
  /** True when polling is suspended because the tab is hidden. */
  paused: boolean;
  /** Epoch ms, re-rendered once a second so age counters stay honest. */
  now: number;
}

/**
 * Polls `/api/snapshot` and reports how much the result can be trusted.
 *
 * Deliberate behaviours:
 * - overlapping requests are suppressed, so a slow backend never gets piled on;
 * - in-flight requests are aborted on unmount and when the interval changes;
 * - polling pauses while the tab is hidden and refetches immediately on return;
 * - stale data stays visible but the connection state says it is not live.
 */
export function useSnapshot(): UseSnapshotResult {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const [refreshSeconds, setRefreshSecondsState] = useState<number>(
    () => readStoredRefresh() ?? FALLBACK_REFRESH_SECONDS,
  );
  // Once the user has chosen (or we have seeded from /api/meta) stop seeding.
  const refreshSeeded = useRef(readStoredRefresh() !== null);

  const visible = usePageVisible();

  const inFlight = useRef<AbortController | null>(null);
  const metaLoaded = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const poll = useCallback(async () => {
    // A live request is the overlap guard: a slow backend must never get a
    // pile of queued polls stacked on top of it.
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setIsFetching(true);

    try {
      const snapshotPromise = fetchJson<Snapshot>('/api/snapshot', controller.signal);
      // Meta is static; fetch it alongside the first successful poll and keep
      // retrying on later polls until it lands, so a blip is not permanent.
      const metaPromise = metaLoaded.current
        ? Promise.resolve(null)
        : fetchJson<Meta>('/api/meta', controller.signal).catch((cause: unknown) => {
            if (!isAbortError(cause)) return null;
            throw cause;
          });

      const [nextSnapshot, nextMeta] = await Promise.all([snapshotPromise, metaPromise]);
      if (controller.signal.aborted || !mounted.current) return;

      if (nextMeta) {
        metaLoaded.current = true;
        setMeta(nextMeta);
        if (!refreshSeeded.current) {
          refreshSeeded.current = true;
          setRefreshSecondsState(
            nearestChoice(nextMeta.ui?.default_refresh_seconds ?? FALLBACK_REFRESH_SECONDS),
          );
        }
      }
      setSnapshot(nextSnapshot);
      setLastUpdatedAt(Date.now());
      setNow(Date.now());
      setFailures(0);
      setError(null);
    } catch (cause) {
      if (isAbortError(cause) || !mounted.current) return;
      setFailures((count) => count + 1);
      setError(errorMessage(cause));
    } finally {
      // Only clear if a newer poll has not already taken over the slot.
      if (inFlight.current === controller) {
        inFlight.current = null;
        if (mounted.current) setIsFetching(false);
      }
    }
  }, []);

  /** Abort whatever is in flight and free the slot for the next poll. */
  const cancelInFlight = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    if (mounted.current) setIsFetching(false);
  }, []);

  // Polling loop. Restarts (and aborts anything in flight) when the interval
  // changes or the tab's visibility flips.
  useEffect(() => {
    if (!visible) {
      cancelInFlight();
      return;
    }
    void poll();
    const timer = window.setInterval(() => void poll(), Math.max(1, refreshSeconds) * 1000);
    return () => {
      window.clearInterval(timer);
      cancelInFlight();
    };
  }, [cancelInFlight, poll, refreshSeconds, visible]);

  // Drives the "updated Ns ago" counters without refetching anything.
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible]);

  const setRefreshSeconds = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    refreshSeeded.current = true;
    writeStoredRefresh(seconds);
    setRefreshSecondsState(seconds);
  }, []);

  const refresh = useCallback(() => {
    void poll();
  }, [poll]);

  const connection: ConnectionState = useMemo(() => {
    if (lastUpdatedAt === null) {
      return failures >= DISCONNECTED_AFTER_FAILURES ? 'disconnected' : 'connecting';
    }
    if (failures === 0) return 'live';
    return failures >= DISCONNECTED_AFTER_FAILURES ? 'disconnected' : 'stale';
  }, [failures, lastUpdatedAt]);

  const secondsSinceUpdate = lastUpdatedAt === null ? null : Math.max(0, (now - lastUpdatedAt) / 1000);

  return {
    snapshot,
    meta,
    connection,
    error,
    initialLoadFailed: snapshot === null && error !== null,
    lastUpdatedAt,
    secondsSinceUpdate,
    consecutiveFailures: failures,
    refreshSeconds,
    setRefreshSeconds,
    refresh,
    isFetching,
    paused: !visible,
    now,
  };
}
