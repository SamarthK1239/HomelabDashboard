import type { CollectorMeta, CollectorResult } from '../../types';

/**
 * The props every collector card receives.
 *
 * `result` is the collector's entry from `/api/snapshot`; `meta` is its entry
 * from `/api/meta` (static facts such as hardware names, discovered once at
 * startup) and may be absent; `refreshSeconds` is the dashboard's current poll
 * cadence, useful for sizing history windows.
 */
export interface CardProps {
  result: CollectorResult;
  meta?: CollectorMeta;
  refreshSeconds: number;
}
