import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { errorMessage, fetchJson, isAbortError } from '../api';
import type { HistorySeries } from '../types';
import { usePageVisible } from './usePageVisible';

export interface UseHistoryOptions {
  /** Dashboard refresh cadence; history polls at this rate, floored at 5s. */
  refreshSeconds?: number;
  /** Seconds of history to request. Defaults to the backend's window. */
  windowSeconds?: number;
  /** Set false to stop polling (e.g. a collapsed card). */
  enabled?: boolean;
}

export interface UseHistoryResult {
  /** Epoch seconds, ascending. Empty until the backend has a few samples. */
  timestamps: number[];
  values: number[];
  /** True once at least two points exist, i.e. something is plottable. */
  hasData: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const EMPTY: number[] = [];

/**
 * Fetches one history series (`cpu.usage`, `gpu.gpu0_temp`, ...).
 *
 * The store is in-memory and starts empty, so an empty series is the normal
 * state for the first few seconds after a restart — never an error.
 */
export function useHistory(metric: string | null, options: UseHistoryOptions = {}): UseHistoryResult {
  const { refreshSeconds = 5, windowSeconds, enabled = true } = options;

  const [series, setSeries] = useState<HistorySeries | null>(null);
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

  // History moves slower than the snapshot; polling it faster than every five
  // seconds just burns requests for points that do not exist yet.
  const pollSeconds = Math.max(5, refreshSeconds);

  const fetchSeries = useCallback(async () => {
    if (!metric || inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    try {
      const params = new URLSearchParams({ metric });
      if (windowSeconds && Number.isFinite(windowSeconds)) {
        params.set('window', String(Math.max(1, Math.round(windowSeconds))));
      }
      const next = await fetchJson<HistorySeries>(`/api/history?${params.toString()}`, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
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
  }, [metric, windowSeconds]);

  const cancelInFlight = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    if (mounted.current) setLoading(false);
  }, []);

  useEffect(() => {
    if (!metric || !enabled || !visible) {
      cancelInFlight();
      return;
    }
    void fetchSeries();
    const timer = window.setInterval(() => void fetchSeries(), pollSeconds * 1000);
    return () => {
      window.clearInterval(timer);
      cancelInFlight();
    };
  }, [cancelInFlight, enabled, fetchSeries, metric, pollSeconds, visible]);

  // A truncated response (or a mid-write read) must not desync the two arrays.
  const { timestamps, values } = useMemo(() => {
    const rawTimestamps = Array.isArray(series?.timestamps) ? series.timestamps : EMPTY;
    const rawValues = Array.isArray(series?.values) ? series.values : EMPTY;
    const length = Math.min(rawTimestamps.length, rawValues.length);
    if (length === rawTimestamps.length && length === rawValues.length) {
      return { timestamps: rawTimestamps, values: rawValues };
    }
    return { timestamps: rawTimestamps.slice(0, length), values: rawValues.slice(0, length) };
  }, [series]);

  const refresh = useCallback(() => {
    void fetchSeries();
  }, [fetchSeries]);

  return {
    timestamps,
    values,
    hasData: timestamps.length >= 2,
    loading,
    error,
    refresh,
  };
}
