import { Card } from '../Card';
import {
  EM_DASH,
  formatDuration,
  formatNumber,
  formatTimestamp,
  isFiniteNumber,
  isPlainObject,
} from '../../format';
import type { CardProps } from './types';
import './system-cards.css';

function num(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

export function UptimeCard({ result, meta }: CardProps) {
  const data = result.data ?? {};

  const uptimeSeconds = num(data.uptime_seconds);
  const uptimeHuman = str(data.uptime_human) ?? (uptimeSeconds === null ? null : formatDuration(uptimeSeconds));
  const bootTime = num(data.boot_time) ?? num(meta?.boot_time);

  const load = isPlainObject(data.load_average) ? data.load_average : {};

  const rebootRequired = data.reboot_required === true;
  const rebootPackages = readStrings(data.reboot_required_packages);

  const userCount = num(data.user_count);
  const users = readStrings(data.users);

  const hostname = str(meta?.hostname);
  const kernel = str(meta?.kernel);

  const subtitle = [hostname, kernel].filter(Boolean).join(' · ') || undefined;

  return (
    <Card
      title="Uptime"
      result={result}
      subtitle={subtitle}
      footer={bootTime !== null ? `booted ${formatTimestamp(bootTime)}` : undefined}
    >
      <div className="sys-stack">
        <div className="sys-hero">
          <div className="sys-hero__main">
            <span
              className="sys-hero__value sys-hero__value--sm"
              title={uptimeSeconds === null ? undefined : `${formatNumber(uptimeSeconds, 0)} seconds`}
            >
              {uptimeHuman ?? EM_DASH}
            </span>
          </div>
          <div className="sys-hero__side">
            <span>since {formatTimestamp(bootTime)}</span>
          </div>
        </div>

        {rebootRequired ? (
          <div className="sys-banner sys-banner--warn" role="status">
            <span className="sys-banner__title">Reboot required</span>
            <span className="sys-banner__body">
              {rebootPackages.length > 0
                ? `A pending upgrade needs a restart to take effect: ${rebootPackages.join(', ')}`
                : 'A pending upgrade needs a restart to take effect.'}
            </span>
          </div>
        ) : null}

        <div className="sys-metrics">
          {(['1m', '5m', '15m'] as const).map((window) => (
            <div className="sys-metric" key={window}>
              <span className="sys-metric__label">load {window}</span>
              <span className="sys-metric__value sys-metric__value--lg">
                {formatNumber(num(load[window]))}
              </span>
            </div>
          ))}
        </div>

        <div className="sys-row">
          <div className="sys-row__meta">
            <span title={users.length > 0 ? users.join(', ') : 'nobody is logged in'}>
              logged in: <b>{userCount === null ? EM_DASH : formatNumber(userCount, 0)}</b>
              {users.length > 0 ? <span className="sys-muted"> ({users.join(', ')})</span> : null}
            </span>
            {!rebootRequired ? <span className="sys-muted">no reboot pending</span> : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

export default UptimeCard;
