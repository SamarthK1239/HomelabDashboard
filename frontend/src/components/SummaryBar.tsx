import { useMemo } from 'react';

import { useDashboard } from '../DashboardContext';
import { useHistoryBatch } from '../hooks/useHistoryBatch';
import { EM_DASH } from '../format';
import { countByStatus, deriveKpis, type Kpi } from '../summary';
import { STATUS_SEVERITY, type Snapshot, type Status } from '../types';
import { AnimatedValue } from './AnimatedValue';
import { CollectorIcon, StatusGlyph } from './icons';
import { Sparkline } from './Sparkline';
import './summary-bar.css';

export interface SummaryBarProps {
  snapshot: Snapshot | null;
  overall: Status;
  /** Dashboard poll cadence, so the KPI sparklines poll no faster. */
  refreshSeconds: number;
  /** History window for the micro-sparklines, in seconds. */
  windowSeconds?: number;
}

/** Headline sentence. Says what is true, not how many things were checked. */
function headline(tally: Record<Status, number>, overall: Status): string {
  if (tally.critical > 0) {
    return `${tally.critical} collector${tally.critical === 1 ? '' : 's'} critical`;
  }
  if (tally.warn > 0) {
    return `${tally.warn} collector${tally.warn === 1 ? '' : 's'} need attention`;
  }
  if (overall === 'unknown' || tally.ok === 0) return 'Waiting for first readings';
  if (tally.unknown > 0) {
    return `${tally.unknown} collector${tally.unknown === 1 ? '' : 's'} not reporting`;
  }
  return 'All systems nominal';
}

function KpiTile({
  kpi,
  timestamps,
  values,
}: {
  kpi: Kpi;
  timestamps: readonly number[];
  values: readonly number[];
}) {
  const { focusCard } = useDashboard();

  return (
    <button
      type="button"
      className="kpi"
      data-status={kpi.status}
      onClick={() => focusCard(kpi.collector)}
      title={`Jump to the ${kpi.label} card`}
    >
      <span className="kpi__head">
        <CollectorIcon name={kpi.collector} size={13} />
        <span className="kpi__label">{kpi.label}</span>
      </span>

      <span className="kpi__value">
        {kpi.value === null ? (
          <span className="kpi__dash">{EM_DASH}</span>
        ) : (
          <AnimatedValue value={kpi.value} format={kpi.format} />
        )}
      </span>

      {kpi.detail ? <span className="kpi__detail">{kpi.detail}</span> : null}

      {/*
        A KPI that is a ratio gets a bar; one that is not (watts, counts) gets
        its sparkline instead. Drawing a bar for an unbounded quantity would
        imply a ceiling that does not exist.
      */}
      {kpi.fraction !== null ? (
        <span className="kpi__bar" aria-hidden="true">
          <span
            className="kpi__bar-fill"
            style={{ width: `${Math.max(0, Math.min(100, kpi.fraction))}%` }}
          />
        </span>
      ) : null}

      {timestamps.length >= 2 ? (
        <Sparkline
          className="kpi__spark"
          timestamps={timestamps}
          values={values}
          height={22}
          color="var(--sev-solid)"
          interactive={false}
          label={`${kpi.label} history`}
        />
      ) : null}
    </button>
  );
}

/**
 * The glance layer.
 *
 * This is the answer to the question the old dashboard could not answer
 * without reading nine cards: *is anything wrong, and what are the numbers
 * that matter?* It states the verdict first, in words, and only then shows the
 * handful of readings worth seeing before any card is read.
 */
export function SummaryBar({
  snapshot,
  overall,
  refreshSeconds,
  windowSeconds,
}: SummaryBarProps) {
  const kpis = useMemo(() => deriveKpis(snapshot), [snapshot]);
  const tally = useMemo(() => countByStatus(snapshot), [snapshot]);

  const metrics = useMemo(
    () => kpis.map((kpi) => kpi.metric).filter((metric): metric is string => Boolean(metric)),
    [kpis],
  );

  // One request for every sparkline in the strip rather than one each.
  const { series } = useHistoryBatch(metrics, { refreshSeconds, windowSeconds });

  const degraded = tally.warn + tally.critical;

  return (
    <section className="summary" data-status={overall} aria-label="System summary">
      <div className="summary__verdict">
        <span className="summary__glyph" aria-hidden="true">
          <StatusGlyph status={overall} size={22} strokeWidth={2.25} />
        </span>
        <div className="summary__text">
          {/* Toasts announce deteriorations, but not recoveries. This polite
              region closes that gap: the one sentence that says whether the
              machine is fine is re-read whenever the answer changes, and only
              then -- the tally beside it is left silent because its digits move
              far too often to narrate. */}
          <p className="summary__headline" aria-live="polite">
            {headline(tally, overall)}
          </p>
          <p className="summary__tally">
            {(['critical', 'warn', 'unknown', 'ok'] as const)
              .filter((status) => tally[status] > 0)
              .sort((a, b) => STATUS_SEVERITY[b] - STATUS_SEVERITY[a])
              .map((status) => (
                <span className="summary__tally-item" data-status={status} key={status}>
                  <span className="summary__tally-dot" aria-hidden="true" />
                  {tally[status]} {status === 'ok' ? 'healthy' : status}
                </span>
              ))}
            {degraded === 0 && tally.ok > 0 ? (
              <span className="summary__tally-note">nothing requires action</span>
            ) : null}
          </p>
        </div>
      </div>

      {kpis.length > 0 ? (
        <div className="summary__kpis">
          {kpis.map((kpi) => {
            const history = kpi.metric ? series[kpi.metric] : undefined;
            return (
              <KpiTile
                key={kpi.id}
                kpi={kpi}
                timestamps={history?.timestamps ?? []}
                values={history?.values ?? []}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

export default SummaryBar;
