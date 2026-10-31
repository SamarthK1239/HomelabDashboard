/**
 * Derives the glance layer from a snapshot.
 *
 * The dashboard's single biggest shortcoming was that answering "is anything
 * wrong?" required reading nine cards. This module reduces a snapshot to two
 * much smaller things:
 *
 *   - a handful of KPIs, the numbers worth seeing before any card is read;
 *   - an attention list, naming exactly what is degraded and why.
 *
 * It is deliberately defensive. Collector payloads are untyped by contract and
 * any field may legitimately be `null` (a first-sample delta, absent hardware,
 * a failed probe), so every reader below narrows before it trusts, and a
 * missing reading yields `null` — never a fabricated zero.
 */

import { isFiniteNumber, isPlainObject } from './format';
import { STATUS_SEVERITY, type CollectorResult, type Snapshot, type Status } from './types';

export interface Kpi {
  /** Stable key for React and for the command palette. */
  id: string;
  /** Collector to focus when this KPI is activated. */
  collector: string;
  label: string;
  /** The reading, or `null` when it is genuinely unavailable. */
  value: number | null;
  /** Renders the reading for display. */
  format: (value: number) => string;
  /** Short qualifier under the value ("of 128 GiB", "2 of 2 healthy"). */
  detail?: string;
  status: Status;
  /** 0–100 for a ratio-shaped KPI, `null` when the value is not a fraction. */
  fraction: number | null;
  /** `/api/history` metric backing the micro-sparkline, when one exists. */
  metric?: string;
}

export interface AttentionItem {
  collector: string;
  title: string;
  /** Plain-language explanation of what is wrong. */
  reason: string;
  status: Status;
}

function data(result: CollectorResult | undefined): Record<string, unknown> {
  return isPlainObject(result?.data) ? result.data : {};
}

function num(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

/** Threshold helper for KPI colouring. The backend still owns card status. */
function levelFromPercent(percent: number | null, warn: number, critical: number): Status {
  if (percent === null) return 'unknown';
  if (percent >= critical) return 'critical';
  if (percent >= warn) return 'warn';
  return 'ok';
}

const percent = (value: number) => `${value.toFixed(value >= 99.95 ? 0 : 1)}%`;
const watts = (value: number) => `${Math.round(value)} W`;
const count = (value: number) => String(Math.round(value));
const degrees = (value: number) => `${Math.round(value)}°`;

/* -------------------------------------------------------------------------- */
/*                                    KPIs                                    */
/* -------------------------------------------------------------------------- */

function cpuKpi(result: CollectorResult): Kpi {
  const d = data(result);
  const value = num(d.percent);
  const cores = num(d.logical_cores);
  return {
    id: 'cpu',
    collector: 'cpu',
    label: 'CPU',
    value,
    format: percent,
    detail: cores !== null ? `${cores} threads` : undefined,
    status: levelFromPercent(value, 70, 90),
    fraction: value,
    metric: 'cpu.usage',
  };
}

function memoryKpi(result: CollectorResult): Kpi {
  const d = data(result);
  const value = num(d.percent);
  const total = num(d.total);
  return {
    id: 'memory',
    collector: 'memory',
    label: 'Memory',
    value,
    format: percent,
    detail: total !== null ? `of ${(total / 1024 ** 3).toFixed(0)} GiB` : undefined,
    status: levelFromPercent(value, 80, 92),
    fraction: value,
    metric: 'memory.percent',
  };
}

/**
 * GPUs report several numbers that could each claim the headline. Temperature
 * is chosen because on an inference box VRAM sits pinned near 100% by design
 * (llama.cpp preallocates its KV cache) and utilisation swings between 0 and
 * 100 every second — neither is news. Heat is.
 */
function gpuKpi(result: CollectorResult): Kpi | null {
  const d = data(result);
  const gpus = Array.isArray(d.gpus) ? d.gpus.filter(isPlainObject) : [];
  if (gpus.length === 0) return null;

  let hottest: number | null = null;
  let hottestIndex: number | null = null;
  for (const gpu of gpus) {
    const temp = num(gpu.temperature_c);
    if (temp !== null && (hottest === null || temp > hottest)) {
      hottest = temp;
      hottestIndex = num(gpu.index);
    }
  }

  return {
    id: 'gpu',
    collector: 'gpu',
    label: gpus.length > 1 ? 'Hottest GPU' : 'GPU',
    value: hottest,
    format: degrees,
    detail:
      gpus.length > 1 && hottestIndex !== null
        ? `GPU ${hottestIndex} of ${gpus.length}`
        : undefined,
    status: levelFromPercent(hottest, 80, 88),
    fraction: hottest === null ? null : Math.min(100, (hottest / 100) * 100),
    metric: hottestIndex === null ? undefined : `gpu.gpu${hottestIndex}_temp`,
  };
}

function powerKpi(result: CollectorResult): Kpi {
  const d = data(result);
  const value = num(d.total_watts);
  const sources = Array.isArray(d.unavailable) ? d.unavailable.length : 0;
  return {
    id: 'power',
    collector: 'power',
    label: 'Power',
    value,
    format: watts,
    // The power total is an explicit estimate; say so here too rather than
    // letting the glance layer imply a measurement it is not.
    detail: sources > 0 ? `estimate · ${sources} source${sources === 1 ? '' : 's'} missing` : 'estimate',
    status: result.status,
    fraction: null,
    metric: 'power.total_watts',
  };
}

function diskKpi(result: CollectorResult): Kpi | null {
  const d = data(result);
  const mounts = Array.isArray(d.mounts) ? d.mounts.filter(isPlainObject) : [];
  if (mounts.length === 0) return null;

  let worst: number | null = null;
  let worstMount: string | null = null;
  let worstKey: string | null = null;
  for (const mount of mounts) {
    const used = num(mount.percent);
    if (used !== null && (worst === null || used > worst)) {
      worst = used;
      worstMount = typeof mount.mountpoint === 'string' ? mount.mountpoint : null;
      worstKey = typeof mount.key === 'string' ? mount.key : null;
    }
  }

  return {
    id: 'disk',
    collector: 'disk',
    label: mounts.length > 1 ? 'Fullest disk' : 'Disk',
    value: worst,
    format: percent,
    detail: worstMount ?? undefined,
    status: levelFromPercent(worst, 85, 93),
    fraction: worst,
    metric: worstKey ? `disk.${worstKey}` : undefined,
  };
}

function dockerKpi(result: CollectorResult): Kpi | null {
  const d = data(result);
  const summary = isPlainObject(d.summary) ? d.summary : null;
  if (!summary) return null;
  const running = num(summary.running);
  const total = num(summary.total);
  const unhealthy = num(summary.unhealthy) ?? 0;
  const restarting = num(summary.restarting) ?? 0;
  return {
    id: 'docker',
    collector: 'docker',
    label: 'Containers',
    value: running,
    format: count,
    detail: total !== null ? `of ${total} running` : undefined,
    /*
     * A stopped container is usually deliberate, so `exited` is deliberately
     * NOT an escalation: the backend's collector already decides whether this
     * host's container set is healthy, and a KPI that turned amber whenever
     * anything was stopped would contradict the verdict directly above it.
     * Only genuine distress — failing health checks, restart loops — overrides
     * the collector's own judgement.
     */
    status: unhealthy > 0 ? 'critical' : restarting > 0 ? 'warn' : result.status,
    fraction: running !== null && total ? (running / total) * 100 : null,
    metric: 'docker.running',
  };
}

function updatesKpi(result: CollectorResult): Kpi | null {
  const d = data(result);
  const total = num(d.total);
  if (total === null) return null;
  const security = num(d.security) ?? 0;
  return {
    id: 'updates',
    collector: 'updates',
    label: 'Updates',
    value: total,
    format: count,
    detail: security > 0 ? `${security} security` : 'pending',
    status: result.status,
    fraction: null,
    metric: 'updates.total',
  };
}

function llamaKpi(result: CollectorResult): Kpi | null {
  const d = data(result);
  const busy = num(d.busy_slots);
  const total = num(d.total_slots);
  if (busy === null && total === null) return null;
  return {
    id: 'llama',
    collector: 'llama',
    label: 'Inference',
    value: busy,
    format: count,
    detail: total !== null ? `of ${total} slots busy` : undefined,
    status: result.status,
    fraction: busy !== null && total ? (busy / total) * 100 : null,
    metric: 'llama.busy_slots',
  };
}

const KPI_BUILDERS: Record<string, (result: CollectorResult) => Kpi | null> = {
  cpu: cpuKpi,
  memory: memoryKpi,
  gpu: gpuKpi,
  power: powerKpi,
  disk: diskKpi,
  docker: dockerKpi,
  llama: llamaKpi,
  updates: updatesKpi,
};

/**
 * Preferred headline order. Anything degraded is promoted ahead of this, so a
 * problem is always in the first few slots regardless of its normal rank.
 */
const KPI_ORDER: readonly string[] = [
  'cpu',
  'memory',
  'gpu',
  'power',
  'disk',
  'llama',
  'docker',
  'updates',
];

export const MAX_KPIS = 6;

export function deriveKpis(snapshot: Snapshot | null, limit = MAX_KPIS): Kpi[] {
  if (!snapshot) return [];
  const built: Kpi[] = [];
  for (const name of KPI_ORDER) {
    const result = snapshot.collectors[name];
    if (!result) continue;
    const kpi = KPI_BUILDERS[name]?.(result);
    if (kpi) built.push(kpi);
  }

  // Promote problems. A healthy KPI that is normally first is less useful than
  // a critical one that is normally last.
  built.sort((a, b) => STATUS_SEVERITY[b.status] - STATUS_SEVERITY[a.status]);
  return built.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/*                                 Attention                                  */
/* -------------------------------------------------------------------------- */

/**
 * Turn a degraded collector into one sentence a human can act on.
 *
 * Where a collector exposes the reason itself (power's unavailable sources,
 * updates' stale cache) that reason is used verbatim, because the backend knows
 * why it is unhappy and the frontend should not re-derive a worse guess.
 */
function reasonFor(name: string, result: CollectorResult): string {
  if (result.error) return result.error;
  const d = data(result);

  switch (name) {
    case 'cpu': {
      const value = num(d.percent);
      return value === null ? 'utilisation unavailable' : `${percent(value)} utilised`;
    }
    case 'memory': {
      const value = num(d.percent);
      const swap = num(isPlainObject(d.swap) ? d.swap.percent : null);
      const parts: string[] = [];
      if (value !== null) parts.push(`${percent(value)} used`);
      if (swap !== null && swap > 0) parts.push(`swap ${percent(swap)}`);
      return parts.join(' · ') || 'memory readings unavailable';
    }
    case 'disk': {
      const mounts = Array.isArray(d.mounts) ? d.mounts.filter(isPlainObject) : [];
      const full = mounts
        .map((mount) => ({ at: mount.mountpoint, used: num(mount.percent) }))
        .filter((entry) => entry.used !== null && entry.used >= 85)
        .sort((a, b) => (b.used ?? 0) - (a.used ?? 0));
      if (full.length === 0) return 'disk status degraded';
      const worst = full[0];
      const extra = full.length > 1 ? ` (+${full.length - 1} more)` : '';
      return `${worst.at ?? 'mount'} is ${percent(worst.used ?? 0)} full${extra}`;
    }
    case 'gpu': {
      const gpus = Array.isArray(d.gpus) ? d.gpus.filter(isPlainObject) : [];
      const throttled = gpus.filter((gpu) => gpu.throttled === true);
      if (throttled.length > 0) {
        const reasons = throttled
          .flatMap((gpu) => (Array.isArray(gpu.throttle_reasons) ? gpu.throttle_reasons : []))
          .filter((entry): entry is string => typeof entry === 'string');
        return `${throttled.length} GPU${throttled.length === 1 ? '' : 's'} throttling${
          reasons.length > 0 ? `: ${[...new Set(reasons)].join(', ')}` : ''
        }`;
      }
      const hottest = gpus.reduce<number | null>((max, gpu) => {
        const temp = num(gpu.temperature_c);
        return temp !== null && (max === null || temp > max) ? temp : max;
      }, null);
      return hottest === null ? 'GPU status degraded' : `hottest device at ${degrees(hottest)}C`;
    }
    case 'docker': {
      const summary = isPlainObject(d.summary) ? d.summary : {};
      const unhealthy = num(summary.unhealthy) ?? 0;
      const exited = num(summary.exited) ?? 0;
      const restarting = num(summary.restarting) ?? 0;
      const parts: string[] = [];
      if (unhealthy > 0) parts.push(`${unhealthy} unhealthy`);
      if (restarting > 0) parts.push(`${restarting} restarting`);
      if (exited > 0) parts.push(`${exited} exited`);
      return parts.join(' · ') || 'container status degraded';
    }
    case 'llama': {
      const health = isPlainObject(d.health) ? d.health : {};
      if (health.reachable === false) return 'llama.cpp HTTP endpoint unreachable';
      if (health.healthy === false) {
        return typeof health.reason === 'string' ? health.reason : 'llama.cpp reports unhealthy';
      }
      const container = isPlainObject(d.container) ? d.container : {};
      if (container.running === false) return 'llama.cpp container is not running';
      return 'inference service degraded';
    }
    case 'power': {
      const missing = Array.isArray(d.unavailable) ? d.unavailable.filter(isPlainObject) : [];
      if (missing.length === 0) return 'power estimate degraded';
      const names = missing
        .map((entry) => (typeof entry.component === 'string' ? entry.component : null))
        .filter((entry): entry is string => entry !== null);
      return `estimate excludes ${names.join(', ') || `${missing.length} source(s)`}`;
    }
    case 'updates': {
      // The apt cache age is the whole point of this card's warning; leading
      // with the counts would bury it.
      if (d.cache_stale === true) {
        const age = typeof d.cache_age_human === 'string' ? d.cache_age_human : 'unknown age';
        return `apt cache is ${age} old — counts may be meaningless`;
      }
      const security = num(d.security) ?? 0;
      const total = num(d.total) ?? 0;
      if (security > 0) return `${security} security update${security === 1 ? '' : 's'} pending`;
      if (d.reboot_required === true) return 'reboot required';
      return `${total} update${total === 1 ? '' : 's'} pending`;
    }
    case 'uptime':
      return d.reboot_required === true ? 'reboot required' : 'uptime status degraded';
    default:
      return 'reported a degraded status';
  }
}

/**
 * Everything currently not OK, worst first.
 *
 * `unknown` is included: a collector that has never produced a reading is a
 * real gap in coverage, and silently omitting it would be the same lie the
 * rest of this application works hard to avoid.
 */
export function deriveAttention(
  snapshot: Snapshot | null,
  titles: Record<string, string> | undefined,
): AttentionItem[] {
  if (!snapshot) return [];
  const items: AttentionItem[] = [];
  for (const [name, result] of Object.entries(snapshot.collectors)) {
    if (result.status === 'ok') continue;
    items.push({
      collector: name,
      title: titles?.[name] ?? name,
      reason: reasonFor(name, result),
      status: result.status,
    });
  }
  items.sort((a, b) => STATUS_SEVERITY[b.status] - STATUS_SEVERITY[a.status]);
  return items;
}

/** Count collectors by status, for the summary bar's tally. */
export function countByStatus(snapshot: Snapshot | null): Record<Status, number> {
  const tally: Record<Status, number> = { ok: 0, warn: 0, critical: 0, unknown: 0 };
  if (!snapshot) return tally;
  for (const result of Object.values(snapshot.collectors)) tally[result.status] += 1;
  return tally;
}
