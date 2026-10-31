import { Card } from '../Card';
import { Sparkline } from '../Sparkline';
import { useHistory } from '../../hooks/useHistory';
import { EM_DASH, formatNumber, isFiniteNumber, isPlainObject } from '../../format';
import type { CardProps } from './types';
import './system-cards.css';

interface Component {
  key: string;
  label: string;
  category: string;
  source: string;
  watts: number;
}

interface Unavailable {
  source: string;
  component: string;
  reason: string;
}

function num(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readComponents(value: unknown): Component[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).flatMap((entry, index) => {
    const watts = num(entry.watts);
    if (watts === null) return [];
    return [
      {
        key: text(entry.key) ?? `component-${index}`,
        label: text(entry.label) ?? text(entry.key) ?? `component ${index}`,
        category: text(entry.category) ?? 'other',
        source: text(entry.source) ?? 'unknown',
        watts,
      },
    ];
  });
}

function readUnavailable(value: unknown): Unavailable[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((entry, index) => ({
    source: text(entry.source) ?? 'unknown',
    component: text(entry.component) ?? `source ${index}`,
    reason: text(entry.reason) ?? 'unavailable',
  }));
}

function formatWatts(value: number | null): string {
  return value === null ? EM_DASH : `${formatNumber(value, value >= 100 ? 0 : 1)} W`;
}

/** Percent of the total a component accounts for, for the share bars. */
function share(watts: number, total: number | null): number {
  if (total === null || total <= 0) return 0;
  return Math.min(100, Math.max(0, (watts / total) * 100));
}

const CATEGORY_LABELS: Record<string, string> = {
  cpu: 'CPU',
  platform: 'Platform',
  dram: 'DRAM',
  gpu: 'GPU',
  baseline: 'Baseline',
  other: 'Other',
};

export function PowerCard({ result, meta, refreshSeconds }: CardProps) {
  const data = result.data ?? {};
  const history = useHistory('power.total_watts', { refreshSeconds });

  const total = num(data.total_watts);
  const wall = num(data.wall_watts);
  const efficiency = num(data.psu_efficiency) ?? num(meta?.psu_efficiency) ?? 1;
  const components = readComponents(data.components);
  const unavailable = readUnavailable(data.unavailable);
  const measuredSources = num(data.measured_source_count) ?? 0;
  const kwhPerDay = num(data.kwh_per_day);
  const costPerDay = num(data.cost_per_day);
  const costPerMonth = num(data.cost_per_month);
  const currency = text(data.currency) ?? '$';

  const byCategory = isPlainObject(data.by_category) ? data.by_category : {};
  const categories = Object.entries(byCategory)
    .flatMap(([key, value]) => {
      const watts = num(value);
      return watts === null ? [] : [{ key, watts }];
    })
    .sort((a, b) => b.watts - a.watts);

  // The PSU figure is only a separate number when an efficiency was configured.
  const showWall = wall !== null && efficiency > 0 && efficiency < 1;

  return (
    <Card
      title="Power"
      result={result}
      subtitle={
        measuredSources > 0
          ? `${measuredSources} sensor${measuredSources === 1 ? '' : 's'} · estimated total`
          : 'no power sensors readable'
      }
      footer={kwhPerDay !== null ? `${formatNumber(kwhPerDay, 2)} kWh/day` : undefined}
    >
      <div className="sys-stack">
        <div className="sys-hero">
          <div className="sys-hero__main">
            <span className="sys-hero__value">{formatWatts(total)}</span>
            <span className="sys-hero__unit">drawn by sensed components</span>
          </div>
          {showWall ? (
            <div className="sys-hero__side">
              <span title={`component sum divided by a PSU efficiency of ${efficiency}`}>
                ≈{formatWatts(wall)} at the wall
              </span>
            </div>
          ) : null}
        </div>

        <Sparkline
          className="sys-spark"
          timestamps={history.timestamps}
          values={history.values}
          min={0}
          unit="W"
          height={46}
          label="Total system power history"
        />

        {categories.length > 0 ? (
          <div className="sys-metrics">
            {categories.map((entry) => (
              <div className="sys-metric" key={entry.key}>
                <span className="sys-metric__label">
                  {CATEGORY_LABELS[entry.key] ?? entry.key}
                </span>
                <span className="sys-metric__value">{formatWatts(entry.watts)}</span>
              </div>
            ))}
          </div>
        ) : null}

        {components.length > 0 ? (
          <section className="sys-section">
            <h3 className="sys-section__title">
              <span>Per source</span>
              <span className="sys-section__title-note">share of total</span>
            </h3>
            <div className="sys-rows">
              {components.map((component) => (
                <div className="sys-row" key={component.key}>
                  <div className="sys-row__head">
                    <span className="sys-row__name" title={component.label}>
                      {component.label}
                      <span className="sys-muted"> · {component.source}</span>
                    </span>
                    <span className="sys-row__percent">{formatWatts(component.watts)}</span>
                  </div>
                  <div
                    className="sys-bar sys-bar--thin"
                    role="img"
                    aria-label={`${component.label}: ${formatWatts(component.watts)}`}
                  >
                    <span
                      className="sys-bar__fill"
                      data-level="ok"
                      style={{ width: `${share(component.watts, total)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <p className="sys-note">
            No power sensor produced a reading, so there is nothing to total up.
          </p>
        )}

        {costPerDay !== null ? (
          <div className="sys-metrics">
            <div className="sys-metric">
              <span className="sys-metric__label">per day</span>
              <span className="sys-metric__value">
                {currency}
                {formatNumber(costPerDay, 2)}
              </span>
            </div>
            <div className="sys-metric">
              <span className="sys-metric__label">per month</span>
              <span className="sys-metric__value">
                {currency}
                {formatNumber(costPerMonth, 2)}
              </span>
            </div>
          </div>
        ) : null}

        {unavailable.length > 0 ? (
          <section className="sys-section">
            <h3 className="sys-section__title">
              <span>Not counted</span>
              <span className="sys-section__title-note">
                {unavailable.length} source{unavailable.length === 1 ? '' : 's'}
              </span>
            </h3>
            {/*
              Naming what is missing is the point: without it the total looks
              authoritative when it may be excluding both CPU sockets.
            */}
            <ul className="sys-pkglist sys-pkglist--compact">
              {unavailable.map((entry) => (
                <li className="sys-pkg" key={`${entry.source}-${entry.component}`}>
                  <span className="sys-pkg__name" title={entry.reason}>
                    {entry.component}
                  </span>
                  <span className="sys-pkg__versions">{entry.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Card>
  );
}

export default PowerCard;
