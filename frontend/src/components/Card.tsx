import type { ReactNode } from 'react';
import { Copy, Expand, Eye, EyeOff, Pin, PinOff } from 'lucide-react';

import { useClock } from '../hooks/useClock';
import { formatAge, isFiniteNumber } from '../format';
import { useCollectorInterval } from '../MetaContext';
import { usePreferences } from '../PreferencesContext';
import { useDashboard } from '../DashboardContext';
import { useLatestEvent } from '../EventsContext';
import type { CollectorResult, Status } from '../types';
import { CollectorIcon } from './icons';
import { Menu, type MenuItem } from './Menu';
import { StatusBadge } from './StatusBadge';
import './card.css';

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
 * The chrome every collector card shares: identity icon, title, status glyph,
 * an overflow menu, an age counter, an error state, and an explicit stale
 * treatment when a collector stops updating.
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
  const { prefs, togglePinned, toggleHidden } = usePreferences();
  const { openDetail, highlighted } = useDashboard();

  const effectiveStatus = status ?? result?.status ?? 'unknown';
  const effectiveUpdatedAt = updatedAt ?? result?.updated_at ?? null;
  const effectiveError = error !== undefined ? error : (result?.error ?? null);
  const effectiveDuration = durationMs ?? result?.duration_ms ?? null;
  const name = collectorName ?? result?.name;

  const lastChange = useLatestEvent(name);
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

  const pinned = name ? prefs.pinned.includes(name) : false;

  const classes = [
    'card',
    stale ? 'card--stale' : null,
    effectiveError ? 'card--error' : null,
    pinned ? 'card--pinned' : null,
    name && highlighted === name ? 'card--highlight' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const menuItems: (MenuItem | 'separator')[] = name
    ? [
        {
          id: 'expand',
          label: 'Open details',
          icon: Expand,
          onSelect: () => openDetail(name),
        },
        {
          id: 'pin',
          label: pinned ? 'Unpin card' : 'Pin to front',
          icon: pinned ? PinOff : Pin,
          onSelect: () => togglePinned(name),
        },
        'separator',
        {
          id: 'copy',
          label: 'Copy raw JSON',
          icon: Copy,
          onSelect: () => {
            void navigator.clipboard?.writeText(JSON.stringify(result ?? {}, null, 2));
          },
        },
        {
          id: 'hide',
          label: 'Hide this card',
          icon: prefs.hidden.includes(name) ? Eye : EyeOff,
          onSelect: () => toggleHidden(name),
        },
      ]
    : [];

  return (
    <article
      className={classes}
      data-status={effectiveStatus}
      data-collector={name}
      id={name ? `card-${name}` : undefined}
    >
      {/*
        The whole card is a target for the detail sheet, but making the
        <article> itself a button would swallow the menu and any interactive
        content inside it. An absolutely positioned button underneath the
        content gives a real, focusable, announceable control without
        capturing clicks on the things stacked above it.
      */}
      {name ? (
        <button
          type="button"
          className="card__surface-action"
          onClick={() => openDetail(name)}
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : null}

      <header className="card__header">
        <span className="card__identity" aria-hidden="true">
          <CollectorIcon name={name ?? ''} size={16} />
        </span>

        <div className="card__heading">
          <h2 className="card__title t-truncate">{title}</h2>
          {subtitle ? <p className="card__subtitle t-truncate">{subtitle}</p> : null}
        </div>

        <div className="card__header-right">
          {actions}
          {pinned ? (
            <Pin size={13} className="card__pin" aria-label="Pinned" />
          ) : null}
          <StatusBadge status={effectiveStatus} variant="glyph" size="md" />
          {name ? (
            <Menu items={menuItems} label={`${title} card options`} triggerClassName="card__menu" />
          ) : null}
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
        {/*
          Staleness is stated, not implied. The previous design dimmed and
          desaturated the whole card, which degraded the legibility of exactly
          the numbers someone is trying to assess. Full contrast is kept and
          the card instead wears an explicit, unmissable chip.
        */}
        <span
          className={stale || neverRan ? 'card__age card__age--stale' : 'card__age'}
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
        {/*
          "Updated 4s ago" says the collector is alive; it says nothing about
          whether this card looked like this a minute ago. The last transition
          is the difference between a problem that is new and one that has been
          quietly true all week.
        */}
        {lastChange ? (
          <span
            className="card__changed"
            data-status={lastChange.to}
            title={`${lastChange.from} → ${lastChange.to} at ${new Date(
              lastChange.timestamp * 1000,
            ).toLocaleTimeString()}`}
          >
            {lastChange.to} for {formatAge(Math.max(0, now / 1000 - lastChange.timestamp))}
          </span>
        ) : null}
        {footer ? <span className="card__footer-extra">{footer}</span> : null}
      </footer>
    </article>
  );
}

export default Card;
