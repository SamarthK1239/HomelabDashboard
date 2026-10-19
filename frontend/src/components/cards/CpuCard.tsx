import { Card } from '../Card';
import { Sparkline } from '../Sparkline';
import { useHistory } from '../../hooks/useHistory';
import {
  EM_DASH,
  formatNumber,
  formatPercent,
  isFiniteNumber,
  isPlainObject,
} from '../../format';
import type { CardProps } from './types';
import './system-cards.css';

interface CpuSocket {
  id: number | null;
  logicalCores: number | null;
  physicalCores: number | null;
  percent: number | null;
  frequencyMhz: number | null;
  temperatureC: number | null;
}

/** Warn/critical cut-offs used purely for colouring; the backend owns status. */
const BUSY_PERCENT = 50;
const SATURATED_PERCENT = 85;

function num(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function levelFor(percent: number | null): 'ok' | 'warn' | 'critical' | 'unknown' {
  if (percent === null) return 'unknown';
  if (percent >= SATURATED_PERCENT) return 'critical';
  if (percent >= BUSY_PERCENT) return 'warn';
  return 'ok';
}

function readSockets(value: unknown): CpuSocket[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((entry) => ({
    id: num(entry.id),
    logicalCores: num(entry.logical_cores),
    physicalCores: num(entry.physical_cores),
    percent: num(entry.percent),
    frequencyMhz: num(entry.frequency_mhz),
    temperatureC: num(entry.temperature_c),
  }));
}

function readPerCore(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => (isFiniteNumber(entry) ? entry : Number.NaN));
}

/**
 * Logical CPU index -> position in `sockets`, or `null` when it cannot be
 * established.
 *
 * The payload reports per-socket rollups and a flat `per_core` array but no
 * explicit core-to-socket mapping, and Linux CPU enumeration is not consistent
 * across machines (this box interleaves SMT sibling blocks; others number
 * sockets contiguously). Rather than guess, candidate layouts are scored
 * against the socket averages the backend already computed and the best match
 * is only accepted if it actually reproduces them. A wrong grouping would be
 * worse than none, so an unverifiable mapping falls back to one flat grid.
 */
function resolveCoreSockets(perCore: readonly number[], sockets: readonly CpuSocket[]): number[] | null {
  const socketCount = sockets.length;
  if (socketCount < 2 || perCore.length === 0) return null;

  const totalLogical = sockets.reduce((sum, socket) => sum + (socket.logicalCores ?? 0), 0);
  if (totalLogical !== perCore.length) return null;

  const candidates: number[][] = [];

  // Blocks of physical cores cycling through sockets (SMT siblings appear as a
  // second pass over the same sockets) — the common x86 enumeration.
  const blockSize = sockets[0].physicalCores;
  if (blockSize !== null && blockSize > 0) {
    candidates.push(
      Array.from({ length: perCore.length }, (_, cpu) => Math.floor(cpu / blockSize) % socketCount),
    );
  }

  // One contiguous run of logical CPUs per socket.
  const contiguous: number[] = [];
  sockets.forEach((socket, index) => {
    for (let i = 0; i < (socket.logicalCores ?? 0); i += 1) contiguous.push(index);
  });
  if (contiguous.length === perCore.length) candidates.push(contiguous);

  // Strict round-robin.
  candidates.push(Array.from({ length: perCore.length }, (_, cpu) => cpu % socketCount));

  const checkable = sockets
    .map((socket, index) => ({ index, percent: socket.percent }))
    .filter((entry): entry is { index: number; percent: number } => entry.percent !== null);
  if (checkable.length === 0) return null;

  let best: { assignment: number[]; error: number } | null = null;
  for (const assignment of candidates) {
    const sums = new Array<number>(socketCount).fill(0);
    const counts = new Array<number>(socketCount).fill(0);
    for (let cpu = 0; cpu < perCore.length; cpu += 1) {
      const value = perCore[cpu];
      if (!Number.isFinite(value)) continue;
      sums[assignment[cpu]] += value;
      counts[assignment[cpu]] += 1;
    }
    let error = 0;
    let usable = true;
    for (const { index, percent } of checkable) {
      if (counts[index] === 0) {
        usable = false;
        break;
      }
      error = Math.max(error, Math.abs(sums[index] / counts[index] - percent));
    }
    // Per-core readings are rounded to 0.1 and the socket average to 0.01, so
    // a correct mapping still drifts by a hair.
    if (!usable || error > 0.06) continue;
    if (best === null || error < best.error) best = { assignment, error };
  }

  return best?.assignment ?? null;
}

/** Cool neutral -> ok -> warn -> critical, mixed from the theme's own colours. */
function heatColor(percent: number | null): string {
  if (percent === null) return 'var(--surface-3)';
  const clamped = Math.min(100, Math.max(0, percent));
  if (clamped <= BUSY_PERCENT) {
    const mix = Math.round((clamped / BUSY_PERCENT) * 100);
    return `color-mix(in srgb, var(--status-ok) ${mix}%, var(--surface-3))`;
  }
  if (clamped <= SATURATED_PERCENT) {
    const mix = Math.round(((clamped - BUSY_PERCENT) / (SATURATED_PERCENT - BUSY_PERCENT)) * 100);
    return `color-mix(in srgb, var(--status-warn) ${mix}%, var(--status-ok))`;
  }
  const mix = Math.round(((clamped - SATURATED_PERCENT) / (100 - SATURATED_PERCENT)) * 100);
  return `color-mix(in srgb, var(--status-critical) ${mix}%, var(--status-warn))`;
}

function heatLevel(percent: number | null): 'unknown' | 'idle' | 'busy' | 'saturated' {
  if (percent === null) return 'unknown';
  if (percent >= SATURATED_PERCENT) return 'saturated';
  if (percent >= BUSY_PERCENT) return 'busy';
  return 'idle';
}

function CoreCell({ cpu, percent }: { cpu: number; percent: number | null }) {
  const label =
    percent === null ? `CPU ${cpu}: no reading yet` : `CPU ${cpu}: ${formatPercent(percent)}`;
  return (
    <li
      className="sys-heat__cell"
      data-level={heatLevel(percent)}
      style={{ backgroundColor: heatColor(percent) }}
      title={label}
      aria-label={label}
    />
  );
}

function formatMhz(value: number | null): string {
  return value === null ? EM_DASH : `${formatNumber(value, 0)} MHz`;
}

function formatTemp(value: number | null): string {
  return value === null ? EM_DASH : `${formatNumber(value, 1)}°C`;
}

export function CpuCard({ result, meta, refreshSeconds }: CardProps) {
  const data = result.data ?? {};
  const history = useHistory('cpu.usage', { refreshSeconds });

  const priming = data.priming === true;
  const percent = num(data.percent);
  const perCore = readPerCore(data.per_core);
  const sockets = readSockets(data.sockets);

  const logicalCores = num(data.logical_cores) ?? num(meta?.logical_cores);
  const physicalCores = num(data.physical_cores) ?? num(meta?.physical_cores);
  const model = typeof data.model === 'string' ? data.model : null;

  const load = isPlainObject(data.load_average) ? data.load_average : {};
  const loadPercent = isPlainObject(data.load_percent) ? data.load_percent : {};
  const frequency = isPlainObject(data.frequency_mhz) ? data.frequency_mhz : {};
  const hottest = num(data.package_temp_max_c);

  const coreSockets = perCore ? resolveCoreSockets(perCore, sockets) : null;
  // Keep the grid at full size while priming so the card does not jump once
  // the first real delta lands.
  const cellCount = perCore?.length ?? logicalCores ?? 0;
  const cellPercent = (cpu: number): number | null => {
    const value = perCore?.[cpu];
    return isFiniteNumber(value) ? value : null;
  };

  const subtitle = model
    ? `${model}${sockets.length > 0 ? ` · ${sockets.length} sockets` : ''}`
    : sockets.length > 0
      ? `${sockets.length} sockets`
      : undefined;

  const footer =
    physicalCores !== null && logicalCores !== null
      ? `${formatNumber(physicalCores, 0)} cores / ${formatNumber(logicalCores, 0)} threads`
      : undefined;

  const groups: { key: string; label: string; percent: number | null; cpus: number[] }[] =
    coreSockets && cellCount === coreSockets.length
      ? sockets.map((socket, index) => ({
          key: `socket-${socket.id ?? index}`,
          label: `Socket ${socket.id ?? index}`,
          percent: socket.percent,
          cpus: coreSockets.reduce<number[]>((acc, assigned, cpu) => {
            if (assigned === index) acc.push(cpu);
            return acc;
          }, []),
        }))
      : [
          {
            key: 'all',
            label: 'All logical CPUs',
            percent,
            cpus: Array.from({ length: cellCount }, (_, cpu) => cpu),
          },
        ];

  return (
    <Card title="CPU" result={result} subtitle={subtitle} footer={footer}>
      <div className="sys-stack">
        {priming || percent === null ? (
          <div className="sys-measuring" role="status">
            <span>measuring…</span>
            <span className="sys-note">
              utilisation is a delta between samples; the first reading is not available yet
            </span>
          </div>
        ) : (
          <div className="sys-hero">
            <div className="sys-hero__main">
              <span className="sys-hero__value" data-level={levelFor(percent)}>
                {formatPercent(percent)}
              </span>
              <span className="sys-hero__unit">busy</span>
            </div>
            <div className="sys-hero__side">
              <span title="aggregate clock across all logical CPUs">
                {formatMhz(num(frequency.current))}
                {num(frequency.max) !== null ? (
                  <span className="sys-muted"> / {formatMhz(num(frequency.max))}</span>
                ) : null}
              </span>
              <span title="hottest package temperature">{formatTemp(hottest)} pkg</span>
            </div>
          </div>
        )}

        <Sparkline
          className="sys-spark"
          timestamps={history.timestamps}
          values={history.values}
          min={0}
          max={100}
          unit="%"
          height={46}
          label="CPU utilisation history"
        />

        <div className="sys-metrics">
          {(['1m', '5m', '15m'] as const).map((window) => {
            const normalized = num(loadPercent[window]);
            const raw = num(load[window]);
            return (
              <div className="sys-metric" key={window}>
                <span className="sys-metric__label">load {window}</span>
                <span
                  className="sys-metric__value sys-metric__value--lg"
                  data-level={levelFor(normalized)}
                  title={`load average ${window}: ${formatNumber(raw)} runnable, ${formatPercent(
                    normalized,
                  )} of ${formatNumber(logicalCores, 0)} logical CPUs`}
                >
                  {formatPercent(normalized)}
                </span>
                <span className="sys-metric__sub">raw {formatNumber(raw)}</span>
              </div>
            );
          })}
        </div>

        {sockets.length > 0 ? (
          <section className="sys-section">
            <h3 className="sys-section__title">Per socket</h3>
            <div className="sys-rows">
              {sockets.map((socket, index) => {
                const id = socket.id ?? index;
                return (
                  <div className="sys-row" key={`socket-row-${id}`}>
                    <div className="sys-row__head">
                      <span className="sys-row__name">Socket {id}</span>
                      <span className="sys-row__percent" data-level={levelFor(socket.percent)}>
                        {formatPercent(socket.percent)}
                      </span>
                    </div>
                    <div
                      className="sys-bar sys-bar--thin"
                      role="img"
                      aria-label={`socket ${id} utilisation ${formatPercent(socket.percent)}`}
                    >
                      <span
                        className="sys-bar__fill"
                        data-level={levelFor(socket.percent)}
                        style={{ width: `${Math.min(100, Math.max(0, socket.percent ?? 0))}%` }}
                      />
                    </div>
                    <div className="sys-row__meta">
                      <span>
                        <b>{formatMhz(socket.frequencyMhz)}</b>
                      </span>
                      <span>
                        <b>{formatTemp(socket.temperatureC)}</b> pkg
                      </span>
                      <span>
                        {formatNumber(socket.physicalCores, 0)}c /{' '}
                        {formatNumber(socket.logicalCores, 0)}t
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {cellCount > 0 ? (
          <section className="sys-section">
            <h3 className="sys-section__title">
              <span>Logical cores</span>
              <span className="sys-section__title-note">
                {formatNumber(cellCount, 0)} threads
                {groups.length > 1 ? ', grouped by socket' : ''}
              </span>
            </h3>
            <div className="sys-heat">
              {groups.map((group) => (
                <div className="sys-heat__group" key={group.key}>
                  {groups.length > 1 ? (
                    <div className="sys-heat__group-label">
                      <span>{group.label}</span>
                      <b>{formatPercent(group.percent)}</b>
                    </div>
                  ) : null}
                  <ul className="sys-heat__grid">
                    {group.cpus.map((cpu) => (
                      <CoreCell key={cpu} cpu={cpu} percent={cellPercent(cpu)} />
                    ))}
                  </ul>
                </div>
              ))}
              <div className="sys-heat__legend">
                <span>idle</span>
                <span className="sys-heat__ramp" aria-hidden="true" />
                <span>saturated</span>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </Card>
  );
}

export default CpuCard;
