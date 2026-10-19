/**
 * Shared types for the dashboard API contract.
 *
 * These mirror `backend/store.py` (`Store.snapshot`, `Store.history`),
 * `backend/app.py` (routes) and `backend/collectors/base.py`
 * (`Status`, `CollectorResult.to_dict`). Keep them in sync with the backend:
 * every card component in the UI is typed off this file.
 */

/** Health of a single card, rolled up into the overall system status. */
export type Status = 'ok' | 'warn' | 'critical' | 'unknown';

export const STATUS_VALUES: readonly Status[] = ['ok', 'warn', 'critical', 'unknown'];

/** Human-readable status labels used by badges and headers. */
export const STATUS_LABELS: Record<Status, string> = {
  ok: 'OK',
  warn: 'Warning',
  critical: 'Critical',
  unknown: 'Unknown',
};

/** Severity ordering, matching `Status.severity` on the backend. */
export const STATUS_SEVERITY: Record<Status, number> = {
  ok: 0,
  unknown: 1,
  warn: 2,
  critical: 3,
};

/** Narrow an untrusted value from the wire to a `Status`. */
export function asStatus(value: unknown): Status {
  return typeof value === 'string' && (STATUS_VALUES as readonly string[]).includes(value)
    ? (value as Status)
    : 'unknown';
}

/** Return the most severe of a list of statuses. */
export function worstStatus(statuses: readonly Status[]): Status {
  let worst: Status = 'unknown';
  if (statuses.length === 0) return worst;
  worst = 'ok';
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status;
  }
  return worst;
}

/**
 * A collector's payload. Deliberately untyped at this level: every collector
 * has its own shape, and bespoke cards narrow it themselves. Any value may be
 * `null` — collectors return `null` for readings that are not available yet
 * (first-sample deltas, missing hardware) and the UI must render those as "—".
 */
export type CollectorData = Record<string, unknown>;

/** Static, per-collector facts from `/api/meta` (`collectors[name]`). */
export type CollectorMeta = Record<string, unknown>;

/** One collector's most recent sample, successful or not. */
export interface CollectorResult {
  name: string;
  status: Status;
  data: CollectorData;
  /** Non-null when the most recent collection raised; the card shows it. */
  error: string | null;
  /** Epoch seconds of the last sample; `0` if the collector never ran. */
  updated_at: number;
  /** Seconds since `updated_at`, or `null` if the collector never ran. */
  age_seconds: number | null;
  duration_ms: number | null;
}

/** `GET /api/snapshot` */
export interface Snapshot {
  /** Epoch seconds, server-side, when the snapshot was assembled. */
  timestamp: number;
  overall_status: Status;
  collectors: Record<string, CollectorResult>;
}

/** `meta.ui` */
export interface MetaUi {
  default_refresh_seconds: number;
  history_window_seconds: number;
}

/** `GET /api/meta` */
export interface Meta {
  collectors: Record<string, CollectorMeta>;
  ui: MetaUi;
  /** Per-collector sampling interval in seconds, used for staleness checks. */
  intervals: Record<string, number>;
  /** Human-readable card titles, keyed by collector name. */
  titles: Record<string, string>;
}

/** `GET /api/history?metric=...&window=...` — may legitimately be empty. */
export interface HistorySeries {
  metric: string;
  /** Epoch seconds, ascending. */
  timestamps: number[];
  values: number[];
}

/** `GET /api/history/keys` */
export interface HistoryKeys {
  keys: string[];
}

/** `GET /api/health` */
export interface Health {
  status: string;
  collectors: string[];
}

/**
 * How much we trust what is on screen.
 *
 * - `connecting` — no successful fetch yet.
 * - `live` — the most recent poll succeeded; numbers are current.
 * - `stale` — a poll failed; the displayed data is the last known good.
 * - `disconnected` — several polls in a row failed; treat data as historical.
 */
export type ConnectionState = 'connecting' | 'live' | 'stale' | 'disconnected';
