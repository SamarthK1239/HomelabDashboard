/**
 * Value formatting shared by the generic card and any bespoke cards.
 *
 * The golden rule: a missing reading renders as `EM_DASH`, never as "NaN",
 * "null", "undefined" or "0". Collectors legitimately return `null` for values
 * that are not available yet, and a zero would be a lie.
 */

export const EM_DASH = '—';

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Format a bare number with a sensible number of decimals for its magnitude. */
export function formatNumber(value: unknown, maxDecimals?: number): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  const abs = Math.abs(value);
  let decimals: number;
  if (maxDecimals !== undefined) decimals = maxDecimals;
  else if (Number.isInteger(value)) decimals = 0;
  else if (abs >= 1000) decimals = 0;
  else if (abs >= 100) decimals = 1;
  else if (abs >= 1) decimals = 2;
  else if (abs >= 0.01) decimals = 3;
  else decimals = 4;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export function formatPercent(value: unknown, decimals = 1): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return `${value.toFixed(value >= 100 || Number.isInteger(value) ? 0 : decimals)}%`;
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] as const;

/** Binary byte sizes: 50448236544 -> "47.0 GiB". */
export function formatBytes(value: unknown): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  const negative = value < 0;
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1024 && unit < BYTE_UNITS.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${negative ? '-' : ''}${amount.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
}

/** Byte rates: formatted like sizes with a `/s` suffix. */
export function formatBytesPerSecond(value: unknown): string {
  const text = formatBytes(value);
  return text === EM_DASH ? text : `${text}/s`;
}

/** Compact duration: 1015283 -> "11d 18h". */
export function formatDuration(seconds: unknown): string {
  if (!isFiniteNumber(seconds)) return EM_DASH;
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m ${total % 60}s`;
}

/** Terse age for "updated Ns ago" indicators. */
export function formatAge(seconds: unknown): string {
  if (!isFiniteNumber(seconds)) return EM_DASH;
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return formatDuration(total);
}

export function formatMilliseconds(value: unknown): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  if (value >= 10000) return formatDuration(value / 1000);
  return `${formatNumber(value, value >= 100 ? 0 : value >= 10 ? 1 : 2)} ms`;
}

/** Epoch seconds (or milliseconds) to a local timestamp. */
export function formatTimestamp(value: unknown): string {
  if (!isFiniteNumber(value) || value <= 0) return EM_DASH;
  const ms = value > 1e12 ? value : value * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return date.toLocaleString();
}

/** `swap_total_bytes` -> "Swap Total". */
export function humanizeKey(key: string): string {
  const cleaned = key
    .replace(/_(bytes|percent|pct|seconds|secs|ms|mhz|watts|celsius|c|iso|human)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  const text = cleaned.length > 0 ? cleaned : key.replace(/[_-]+/g, ' ');
  return text
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

const ACRONYMS = new Set([
  'CPU',
  'GPU',
  'IO',
  'ID',
  'IP',
  'OS',
  'RAM',
  'RX',
  'TX',
  'URL',
  'UUID',
  'API',
  'NUMA',
  'SMART',
  'PCI',
  'VRAM',
  'ECC',
  'TDP',
  'MHZ',
]);

/**
 * Key prefixes that mean "a number of bytes" when they appear on a memory- or
 * disk-shaped object but carry no `_bytes` suffix (`memory.total`,
 * `mounts[].free`, `swap.used`, `numa[].used_excluding_cache`, ...).
 */
const BYTE_LIKE_KEY =
  /^(total|used|free|available|cached|buffers|shared|active|inactive|reclaimable|limit)(_|$)/;

/** Parents whose `total`/`used`/`free` count things, not bytes. */
const NON_BYTE_SCOPES = new Set([
  'inodes',
  'slots',
  'cores',
  'packages',
  'containers',
  'models',
  'users',
  'counts',
  'tokens',
  'updates',
  'processes',
]);

function looksLikeBytes(key: string, value: number, ancestors: readonly string[]): boolean {
  if (!BYTE_LIKE_KEY.test(key)) return false;
  // Byte counters are whole numbers and, in practice, large ones.
  if (!Number.isInteger(value) || Math.abs(value) < 1024 * 1024) return false;
  return !ancestors.some((ancestor) => NON_BYTE_SCOPES.has(ancestor.toLowerCase()));
}

/**
 * Format a scalar using its key (and the keys it is nested under) as a unit
 * hint.
 *
 * Collector payloads consistently suffix their keys (`*_bytes`, `*_percent`,
 * `*_seconds`, `*_ms`, `*_mhz`, `*_watts`), which is enough to render a brand
 * new collector readably without anyone writing a bespoke card for it.
 */
export function formatByKey(key: string, value: unknown, ancestors: readonly string[] = []): string {
  if (value === null || value === undefined || value === '') return EM_DASH;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (!isFiniteNumber(value)) return String(value);

  const name = key.toLowerCase();
  if (/(^|_)(bytes_per_s|bytes_per_sec|bps)$/.test(name)) return formatBytesPerSecond(value);
  if (/bytes$/.test(name)) return formatBytes(value);
  if (/(^|_)(percent|pct)(_|$)/.test(name)) return formatPercent(value);
  if (/(_ms|_millis|latency)$/.test(name)) return formatMilliseconds(value);
  if (/(seconds|_secs?)$/.test(name)) return formatDuration(value);
  if (/(mhz)$/.test(name)) return `${formatNumber(value, 0)} MHz`;
  if (/(watts|_w)$/.test(name)) return `${formatNumber(value, 1)} W`;
  if (/temp/.test(name) && !/template|attempt/.test(name)) return `${formatNumber(value, 1)}°C`;
  if (/(^|_)(updated_at|created_at|started_at|finished_at|boot_time|timestamp|_at|_time)$/.test(name)) {
    return value > 1e9 ? formatTimestamp(value) : formatNumber(value);
  }
  if (looksLikeBytes(name, value, ancestors)) return formatBytes(value);
  return formatNumber(value);
}

/** Clamp a string for display, keeping the start which is usually the useful part. */
export function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
