import { Card } from '../Card';
import { StatusBadge } from '../StatusBadge';
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  isFiniteNumber,
  isPlainObject,
  truncate,
} from '../../format';
import type { Status } from '../../types';
import type { CardProps } from './types';
import './ai-cards.css';

/* ------------------------------ narrowing -------------------------------- */

type Dict = Record<string, unknown>;

function record(value: unknown): Dict {
  return isPlainObject(value) ? value : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface ContainerView {
  key: string;
  name: string;
  image: string | null;
  state: string;
  health: string | null;
  uptime: number | null;
  restarts: number | null;
  exitCode: number | null;
  ports: string[];
  cpuPercent: number | null;
  memoryUsed: number | null;
  memoryPercent: number | null;
  hasStats: boolean;
}

function toContainerView(entry: unknown, position: number): ContainerView {
  const container = record(entry);
  const stats = record(container.stats);
  const hasStats = isPlainObject(container.stats);
  const id = text(container.id);

  return {
    key: id ?? `container-${position}`,
    name: text(container.name) ?? id ?? `container ${position}`,
    image: text(container.image),
    state: text(container.state) ?? 'unknown',
    health: text(container.health),
    uptime: num(container.uptime_seconds),
    restarts: num(container.restart_count),
    exitCode: num(container.exit_code),
    ports: list(container.ports)
      .map((port) => text(port))
      .filter((port): port is string => port !== null),
    cpuPercent: hasStats ? num(stats.cpu_percent) : null,
    memoryUsed: hasStats ? num(stats.memory_used_bytes) : null,
    memoryPercent: hasStats ? num(stats.memory_percent) : null,
    hasStats,
  };
}

/** Running first, then alphabetically — the wall-monitor reading order. */
const STATE_RANK: Record<string, number> = {
  running: 0,
  restarting: 1,
  paused: 2,
  created: 3,
  removing: 4,
  exited: 5,
  dead: 6,
};

function stateRank(state: string): number {
  return STATE_RANK[state.toLowerCase()] ?? 4;
}

function healthStatus(container: ContainerView): Status {
  if (container.health === 'healthy') return 'ok';
  if (container.health === 'unhealthy') return 'critical';
  if (container.health === 'starting') return 'warn';
  if (container.state === 'running') return 'ok';
  if (container.state === 'restarting' || container.state === 'dead') return 'critical';
  // A container that exited cleanly is a finished job, not a failure.
  if (container.exitCode !== null && container.exitCode !== 0) return 'warn';
  return 'unknown';
}

function stateLabel(container: ContainerView): string {
  if (container.state === 'exited' && container.exitCode !== null) {
    return `exited (${container.exitCode})`;
  }
  return container.state;
}

function ContainerRow({ container }: { container: ContainerView }) {
  const quiet = container.state === 'exited' && container.exitCode === 0;
  const status = healthStatus(container);
  const state = stateLabel(container);
  const badgeLabel = container.health ?? state;
  const classes = ['ai-dk-row', quiet ? 'ai-dk-row--quiet' : null].filter(Boolean).join(' ');

  return (
    <li className={classes} data-status={status}>
      <div className="ai-dk-head">
        <span className="ai-dk-name" title={container.name}>
          {truncate(container.name, 28)}
        </span>
        {badgeLabel !== state ? <span className="ai-dk-state">{state}</span> : null}
        <StatusBadge
          status={status}
          label={badgeLabel}
          title={`${container.state}${container.health ? ` · ${container.health}` : ''}`}
        />
      </div>

      {container.image ? (
        <p className="ai-dk-image" title={container.image}>
          {truncate(container.image, 44)}
        </p>
      ) : null}

      <dl className="ai-grid ai-grid--tight ai-dk-metrics">
        <div className="ai-cell">
          <dt className="ai-label">Uptime</dt>
          <dd className="ai-value">{formatDuration(container.uptime)}</dd>
        </div>
        <div className="ai-cell">
          <dt className="ai-label">CPU</dt>
          <dd className="ai-value" title={container.hasStats ? undefined : 'stats unavailable'}>
            {formatPercent(container.cpuPercent)}
          </dd>
        </div>
        <div className="ai-cell">
          <dt className="ai-label">Memory</dt>
          <dd className="ai-value" title={container.hasStats ? undefined : 'stats unavailable'}>
            {formatBytes(container.memoryUsed)}
            {container.memoryPercent !== null ? (
              <span className="ai-sub"> · {formatPercent(container.memoryPercent)}</span>
            ) : null}
          </dd>
        </div>
        <div className="ai-cell">
          <dt className="ai-label">Restarts</dt>
          <dd className={(container.restarts ?? 0) > 0 ? 'ai-value ai-value--warn' : 'ai-value'}>
            {formatNumber(container.restarts, 0)}
          </dd>
        </div>
      </dl>

      {container.ports.length > 0 ? (
        <ul className="ai-ports" aria-label={`published ports for ${container.name}`}>
          {container.ports.map((port) => (
            <li className="ai-chip ai-chip--muted" key={port} title={port}>
              {truncate(port, 24)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function DockerCard({ result }: CardProps) {
  const data = record(result.data);
  const containers = list(data.containers)
    .map(toContainerView)
    .sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.name.localeCompare(b.name));

  const summary = record(data.summary);
  const total = num(summary.total) ?? containers.length;
  const running = num(summary.running) ?? containers.filter((c) => c.state === 'running').length;
  const exited = num(summary.exited) ?? containers.filter((c) => c.state === 'exited').length;
  const unhealthy = num(summary.unhealthy) ?? containers.filter((c) => c.health === 'unhealthy').length;
  const restarting = num(summary.restarting) ?? 0;

  const chips: { label: string; value: number | null; tone: 'ok' | 'muted' | 'warn' | 'critical' }[] = [
    { label: 'total', value: total, tone: 'muted' },
    { label: 'running', value: running, tone: 'ok' },
    { label: 'exited', value: exited, tone: 'muted' },
    { label: 'unhealthy', value: unhealthy, tone: unhealthy > 0 ? 'critical' : 'muted' },
  ];
  if (restarting > 0) chips.push({ label: 'restarting', value: restarting, tone: 'warn' });

  return (
    <Card
      title="Containers"
      result={result}
      subtitle={`${formatNumber(running, 0)} of ${formatNumber(total, 0)} running`}
      footer={data.stats_enabled === false ? 'per-container stats disabled' : null}
    >
      <div className="ai-stack">
        <ul className="ai-dk-summary" aria-label="container counts">
          {chips.map((chip) => (
            <li className="ai-count" key={chip.label} data-tone={chip.tone}>
              <span className="ai-count__value">{formatNumber(chip.value, 0)}</span>
              <span className="ai-count__label">{chip.label}</span>
            </li>
          ))}
        </ul>

        {containers.length === 0 ? (
          <p className="ai-note ai-note--muted">no containers</p>
        ) : (
          <ul className="ai-dk-list">
            {containers.map((container) => (
              <ContainerRow key={container.key} container={container} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export default DockerCard;
