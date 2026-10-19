import type { ReactNode } from 'react';

import { useClock } from '../hooks/useClock';
import { formatAge, isFiniteNumber } from '../format';
import { useCollectorInterval } from '../MetaContext';
import type { CollectorResult, Status } from '../types';
import { StatusBadge } from './StatusBadge';

export interface CardChromeProps {
  title: string;
  /**
   * The collector's snapshot entry. Supplying it fills in status, age, error
   * and duration automatically; the individual props below override it.
   */
  result?: CollectorResult;
  status?: Status;
  /** Epoch seconds of the collector's last sample; drives the age counter. */
  updatedAt?: number | null;
  /** Fallback age when `updatedAt` is unavailable. */
  ageSeconds?: number | null;
  /** Collector name, used to look its interval up for staleness detection. */
  collectorName?: string;
  /** Overrides the interval from `/api/meta`. */
  intervalSeconds?: number | null;
  /** Collector error from the last sample; rendered prominently when set. */
  error?: string | null;
  /** How long the last collection took; surfaced as a footer tooltip. */
  durationMs?: number | null;
  /** Optional subtitle under the title (model name, mount point, ...). */
  subtitle?: ReactNode;
  /** Controls rendered at the right of the header, before the status badge. */
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * How far past its interval a collector may drift before the card is treated
 * as stale. Generous enough to survive one missed tick on a busy box.
 */
function staleThreshold(intervalSeconds: number): number {
  return Math.max(intervalSeconds * 3, intervalSeconds + 10);
}

/**
 * Fallback for collectors with no known cadence (a brand new one that is not
 * in `/api/meta` yet). Five minutes without an update is suspicious whatever
 * the collector does.
 */
const UNKNOWN_INTERVAL_STALE_SECONDS = 300;

/**
 * The chrome every collector card shares: title, status accent, age counter,
 * error state and a stale (dimmed) treatment when a collector stops updating.
 *
 * ```tsx
 * <Card title="CPU" result={result}>
 *   ...body...
 * </Card>
 * ```
 */
export function Card({
  title,
  result,
  status,
  updatedAt,
  ageSeconds,
  collectorName,
  intervalSeconds,
  error,
  durationMs,
  subtitle,
  actions,
  footer,
  children,
  className,
}: CardChromeProps) {
  const now = useClock();

  const effectiveStatus = status ?? result?.status ?? 'unknown';
  const effectiveUpdatedAt = updatedAt ?? result?.updated_at ?? null;
  const effectiveError = error !== undefined ? error : (result?.error ?? null);
  const effectiveDuration = durationMs ?? result?.duration_ms ?? null;
  const name = collectorName ?? result?.name;

  const metaInterval = useCollectorInterval(name);
  const interval = intervalSeconds ?? metaInterval;

  // Prefer a locally computed age: `age_seconds` from the payload freezes when
  // the browser loses the backend, which would hide the fact that it is frozen.
  const age =
    isFiniteNumber(effectiveUpdatedAt) && effectiveUpdatedAt > 0
      ? Math.max(0, now / 1000 - effectiveUpdatedAt)
      : isFiniteNumber(ageSeconds)
        ? ageSeconds
        : isFiniteNumber(result?.age_seconds)
          ? result.age_seconds
          : null;

  const threshold =
    isFiniteNumber(interval) && interval > 0
      ? staleThreshold(interval)
      : UNKNOWN_INTERVAL_STALE_SECONDS;
  const stale = age !== null && age > threshold;
  const neverRan = age === null;

  const classes = [
    'card',
    stale ? 'card--stale' : null,
    effectiveError ? 'card--error' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={classes} data-status={effectiveStatus}>
      <header className="card__header">
        <div className="card__heading">
          <h2 className="card__title">{title}</h2>
          {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
        </div>
        <div className="card__header-right">
          {actions}
          <StatusBadge status={effectiveStatus} />
        </div>
      </header>

      {effectiveError ? (
        <div className="card__error" role="status">
          <span className="card__error-label">Collector failed</span>
          <code className="card__error-message">{effectiveError}</code>
        </div>
      ) : null}

      <div className="card__body">{children}</div>

      <footer className="card__footer">
        <span
          className={stale ? 'card__age card__age--stale' : 'card__age'}
          title={
            isFiniteNumber(effectiveDuration)
              ? `last collection took ${effectiveDuration.toFixed(0)} ms`
              : undefined
          }
        >
          {neverRan
            ? 'never updated'
            : stale
              ? `stale · last update ${formatAge(age)} ago`
              : `updated ${formatAge(age)} ago`}
        </span>
        {footer ? <span className="card__footer-extra">{footer}</span> : null}
      </footer>
    </article>
  );
}

export default Card;
