import { Card } from '../Card';
import {
  EM_DASH,
  formatNumber,
  isFiniteNumber,
  isPlainObject,
  truncate,
} from '../../format';
import type { CardProps } from './types';
import './system-cards.css';

interface UpdatePackage {
  name: string;
  currentVersion: string | null;
  candidateVersion: string | null;
  suite: string | null;
  security: boolean;
  notableKind: string | null;
  notableReason: string | null;
}

interface NotableEntry {
  name: string;
  kind: string | null;
  reason: string | null;
  security: boolean;
}

function num(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readPackages(value: unknown): UpdatePackage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).flatMap((entry) => {
    const name = str(entry.name);
    if (!name) return [];
    return [
      {
        name,
        currentVersion: str(entry.current_version),
        candidateVersion: str(entry.candidate_version),
        suite: str(entry.suite),
        security: entry.security === true,
        notableKind: str(entry.notable_kind),
        notableReason: str(entry.notable_reason),
      },
    ];
  });
}

function readNotable(value: unknown): NotableEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).flatMap((entry) => {
    const name = str(entry.name);
    if (!name) return [];
    return [
      {
        name,
        kind: str(entry.kind),
        reason: str(entry.reason),
        security: entry.security === true,
      },
    ];
  });
}

/** `{ noble: 5, "noble-updates": 22 }` -> sorted, defensively narrowed pairs. */
function readCounts(value: unknown): { key: string; count: number }[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value)
    .flatMap(([key, count]) => (isFiniteNumber(count) ? [{ key, count }] : []))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Group notable packages by the reason they matter, keeping the reason text. */
function groupNotable(entries: readonly NotableEntry[]): {
  kind: string;
  reason: string | null;
  names: string[];
}[] {
  const groups = new Map<string, { kind: string; reason: string | null; names: string[] }>();
  for (const entry of entries) {
    const kind = entry.kind ?? 'other';
    const group = groups.get(kind) ?? { kind, reason: entry.reason, names: [] };
    if (group.reason === null && entry.reason) group.reason = entry.reason;
    group.names.push(entry.name);
    groups.set(kind, group);
  }
  return [...groups.values()];
}

export function UpdatesCard({ result, meta }: CardProps) {
  const data = result.data ?? {};

  const total = num(data.total);
  const security = num(data.security);
  const packages = readPackages(data.packages);
  const packageCount = num(data.package_count);
  const truncated = data.truncated === true;
  const bySuite = readCounts(data.by_suite);
  const notable = groupNotable(readNotable(data.notable));

  const cacheAgeHuman = str(data.cache_age_human);
  const cacheAgeSeconds = num(data.cache_age_seconds);
  const cacheSource = str(data.cache_source);
  const cacheStale = data.cache_stale === true;
  const staleReason = str(data.stale_reason);
  const refreshNote = str(data.refresh_note);
  const aptDailyTimer = str(data.apt_daily_timer);

  const rebootRequired = data.reboot_required === true;
  const method = str(data.method);
  const distro = str(meta?.distro_pretty) ?? str(meta?.distro);

  const hasSecurity = security !== null && security > 0;
  const cacheAgeLabel = cacheAgeHuman ?? (cacheAgeSeconds === null ? 'unknown' : EM_DASH);

  return (
    <Card
      title="System Updates"
      result={result}
      subtitle={distro ?? undefined}
      footer={method ? `via ${method}` : undefined}
    >
      <div className="sys-stack">
        <div className="sys-hero">
          <div className="sys-hero__main">
            <span
              className="sys-hero__value"
              data-level={hasSecurity ? 'critical' : cacheStale ? 'warn' : undefined}
            >
              {total === null ? EM_DASH : formatNumber(total, 0)}
            </span>
            <span className="sys-hero__unit">pending</span>
          </div>
          <div className="sys-hero__side">
            {/*
              The counts come from a cache only root can refresh, so they are
              only as trustworthy as the cache age sitting beside them.
            */}
            <span
              className={cacheStale ? 'sys-chip sys-chip--warn' : 'sys-chip'}
              title={
                cacheSource
                  ? `apt cache age measured from ${cacheSource}`
                  : 'apt cache age could not be measured'
              }
            >
              cache <b>{cacheAgeLabel}</b> old
            </span>
          </div>
        </div>

        <div className="sys-chips">
          {/*
            A green "0 security" would read as reassurance. It is only earned
            when the cache behind the number is actually fresh.
          */}
          <span
            className={
              hasSecurity
                ? 'sys-chip sys-chip--critical'
                : cacheStale
                  ? 'sys-chip'
                  : 'sys-chip sys-chip--ok'
            }
            title={
              hasSecurity
                ? 'security updates are pending; apply these first'
                : cacheStale
                  ? 'no security updates in a stale cache — this is not a clean bill of health'
                  : 'no pending security updates in the cached package lists'
            }
          >
            <b>{security === null ? EM_DASH : formatNumber(security, 0)}</b> security
          </span>
          <span className="sys-chip">
            <b>{num(data.regular) === null ? EM_DASH : formatNumber(data.regular, 0)}</b> regular
          </span>
          {rebootRequired ? (
            <span className="sys-chip sys-chip--warn">reboot required</span>
          ) : null}
        </div>

        {cacheStale ? (
          <div className="sys-banner sys-banner--warn" role="status">
            <span className="sys-banner__title">Update counts may be out of date</span>
            <span className="sys-banner__body">
              {staleReason ??
                'The apt package cache is stale, so these counts cannot be trusted as current.'}
            </span>
          </div>
        ) : null}

        {notable.length > 0 ? (
          <section className="sys-section">
            <h3 className="sys-section__title">
              <span>Notable upgrades</span>
              <span className="sys-section__title-note">read before running apt</span>
            </h3>
            <div className="sys-rows">
              {notable.map((group) => (
                <div className="sys-banner sys-banner--warn" key={group.kind}>
                  <span className="sys-banner__title">
                    {group.kind.replace(/-/g, ' ')} · {group.names.length}
                  </span>
                  {group.reason ? <span className="sys-banner__body">{group.reason}</span> : null}
                  <span className="sys-note" title={group.names.join(', ')}>
                    {truncate(group.names.join(', '), 140)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {bySuite.length > 0 ? (
          <section className="sys-section">
            <h3 className="sys-section__title">By suite</h3>
            <div className="sys-chips">
              {bySuite.map((entry) => (
                <span
                  className={entry.key.includes('security') ? 'sys-chip sys-chip--critical' : 'sys-chip'}
                  key={entry.key}
                >
                  {entry.key} <b>{formatNumber(entry.count, 0)}</b>
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {packages.length > 0 ? (
          <section className="sys-section">
            <h3 className="sys-section__title">
              <span>Upgradable packages</span>
              <span className="sys-section__title-note">
                {truncated && packageCount !== null
                  ? `showing ${formatNumber(packages.length, 0)} of ${formatNumber(packageCount, 0)}`
                  : formatNumber(packages.length, 0)}
              </span>
            </h3>
            <ul className="sys-pkglist" tabIndex={0} aria-label="Upgradable packages">
              {packages.map((pkg) => (
                <li className="sys-pkg" key={pkg.name}>
                  <span className="sys-pkg__name">
                    {pkg.name}
                    {pkg.security ? (
                      <span className="sys-pkg__tag sys-pkg__tag--security" title="security update">
                        sec
                      </span>
                    ) : null}
                    {pkg.notableKind ? (
                      <span
                        className="sys-pkg__tag sys-pkg__tag--notable"
                        title={pkg.notableReason ?? pkg.notableKind}
                      >
                        {pkg.notableKind}
                      </span>
                    ) : null}
                  </span>
                  <span className="sys-pkg__versions">
                    {pkg.currentVersion ?? EM_DASH}
                    <span className="sys-pkg__arrow" aria-label="upgrades to">
                      →
                    </span>
                    {pkg.candidateVersion ?? EM_DASH}
                  </span>
                </li>
              ))}
            </ul>
            {truncated ? (
              <p className="sys-note">
                List truncated by the collector; {packageCount === null ? 'more' : formatNumber(packageCount, 0)}{' '}
                packages are upgradable in total.
              </p>
            ) : null}
          </section>
        ) : total !== null && total > 0 ? (
          <p className="sys-note">Package detail is unavailable for this sample.</p>
        ) : null}

        {refreshNote ? <p className="sys-note">{refreshNote}</p> : null}
        {aptDailyTimer ? (
          <p className="sys-note">
            apt-daily.timer: <b>{aptDailyTimer}</b>
          </p>
        ) : null}
      </div>
    </Card>
  );
}

export default UpdatesCard;
