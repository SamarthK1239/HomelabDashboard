import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { errorMessage, fetchJson, isAbortError } from '../api';
import type { HistoryBatch, HistorySeries } from '../types';
import { usePageVisible } from './usePageVisible';

export interface UseHistoryBatchOptions {
  /** Dashboard refresh cadence; history polls at this rate, floored at 5s. */
  refreshSeconds?: number;
  /** Seconds of history to request. Defaults to the backend's window. */
  windowSeconds?: number;
  enabled?: boolean;
}

export interface UseHistoryBatchResult {
  /** Series keyed by metric. A metric with no points yet is simply absent. */
  series: Record<string, HistorySeries>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const EMPTY: Record<string, HistorySeries> = {};

/**
 * Fetches several history series in one request.
 *
 * The summary strip wants up to six sparklines and the detail sheet wants a
 * whole collector's worth. Issuing one request per series turned a single
 * glance into six round trips on every poll — wasteful on the wall display and
 * genuinely slow on a phone over Tailscale. `/api/history/batch` answers them
 * together.
 *
 * Metrics are joined into a stable key so that re-ordering the requested list
 * does not restart polling.
 */
export function useHistoryBatch(
  metrics: readonly string[],
  options: UseHistoryBatchOptions = {},
): UseHistoryBatchResult {
  const { refreshSeconds = 5, windowSeconds, enabled = true } = options;

  const [series, setSeries] = useState<Record<string, HistorySeries>>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = usePageVisible();
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const key = useMemo(() => [...new Set(metrics)].sort().join(','), [metrics]);
  const pollSeconds = Math.max(5, refreshSeconds);

  const fetchBatch = useCallback(async () => {
    if (!key || inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    try {
      const params = new URLSearchParams({ metrics: key });
      if (windowSeconds && Number.isFinite(windowSeconds)) {
        params.set('window', String(Math.max(1, Math.round(windowSeconds))));
      }
      const payload = await fetchJson<HistoryBatch>(
        `/api/history/batch?${params.toString()}`,
        controller.signal,
      );
      if (controller.signal.aborted || !mounted.current) return;
      const next: Record<string, HistorySeries> = {};
      for (const entry of payload.series ?? []) {
        if (!entry || typeof entry.metric !== 'string') continue;
        // A truncated response must not desync the two arrays.
        const length = Math.min(entry.timestamps?.length ?? 0, entry.values?.length ?? 0);
        next[entry.metric] = {
          metric: entry.metric,
          timestamps: entry.timestamps.slice(0, length),
          values: entry.values.slice(0, length),
        };
      }
      setSeries(next);
      setError(null);
    } catch (cause) {
      if (isAbortError(cause) || !mounted.current) return;
      setError(errorMessage(cause));
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }, [key, windowSeconds]);

  useEffect(() => {
    if (!key || !enabled || !visible) {
      inFlight.current?.abort();
      inFlight.current = null;
      return;
    }
    void fetchBatch();
    const timer = window.setInterval(() => void fetchBatch(), pollSeconds * 1000);
    return () => {
      window.clearInterval(timer);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [enabled, fetchBatch, key, pollSeconds, visible]);

  const refresh = useCallback(() => {
    void fetchBatch();
  }, [fetchBatch]);

  return { series, loading, error, refresh };
}
