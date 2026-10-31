import { useEffect, useState } from 'react';

import { fetchJson, isAbortError } from '../api';
import type { HistoryKeys } from '../types';

/**
 * The set of metrics the backend is currently recording.
 *
 * Fetched once per activation rather than polled: the key set only changes
 * when a collector is added, removed or starts failing, which is rare enough
 * that a poll would be pure overhead. `enabled` lets the detail sheet avoid
 * paying for it until it is actually opened.
 */
export function useMetricKeys(enabled = true): string[] {
  const [keys, setKeys] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const payload = await fetchJson<HistoryKeys>('/api/history/keys', controller.signal);
        if (!controller.signal.aborted) setKeys(payload.keys ?? []);
      } catch (cause) {
        // A missing key list degrades to "no charts", never to a broken sheet.
        if (!isAbortError(cause)) setKeys([]);
      }
    })();
    return () => controller.abort();
  }, [enabled]);

  return keys;
}
