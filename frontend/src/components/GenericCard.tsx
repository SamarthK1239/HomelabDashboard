import type { ReactNode } from 'react';

import {
  EM_DASH,
  formatByKey,
  formatNumber,
  humanizeKey,
  isFiniteNumber,
  isPlainObject,
  truncate,
} from '../format';
import { Card } from './Card';
import type { CardProps } from './cards/types';

/** How deep to recurse before collapsing an object into a summary. */
const MAX_DEPTH = 3;
/** How many entries of an object array to render in full. */
const MAX_ITEMS = 6;
/** Above this, a primitive array is summarised rather than listed. */
const MAX_INLINE_VALUES = 10;

export interface GenericCardProps extends CardProps {
  /** Card heading; defaults to a humanised collector name. */
  title?: string;
}

function labelForItem(item: Record<string, unknown>, index: number): string {
  for (const key of ['name', 'mountpoint', 'device', 'label', 'title', 'key', 'id', 'index']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim() !== '') return truncate(value, 48);
    if (isFiniteNumber(value)) return `${humanizeKey(key)} ${formatNumber(value)}`;
  }
  return `#${index + 1}`;
}

/** Longer numeric arrays (88 per-core samples, say) become a one-line digest. */
function numericSummary(key: string, values: number[], path: readonly string[]): string {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  const fmt = (value: number) => formatByKey(key, value, path);
  return `${values.length} values · min ${fmt(min)} · avg ${fmt(sum / values.length)} · max ${fmt(max)}`;
}

/**
 * Drop `x_human` / `x_iso` when the machine-readable sibling is present: the
 * formatters already render `uptime_seconds` as "11d 18h", so showing
 * `uptime_human` too is just a duplicate row.
 */
function dropRedundantKeys(keys: readonly string[]): Set<string> {
  const present = new Set(keys);
  const redundant = new Set<string>();
  for (const key of keys) {
    const match = /^(.*)_(human|iso|text|pretty)$/.exec(key);
    if (!match) continue;
    const base = match[1];
    if (present.has(base) || present.has(`${base}_seconds`) || present.has(`${base}_bytes`)) {
      redundant.add(key);
    }
  }
  return redundant;
}

function ScalarRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  const empty = value === EM_DASH;
  return (
    <div className="kv-row">
      <dt className="kv-key">{label}</dt>
      <dd className={`kv-value${empty || muted ? ' kv-value--muted' : ''}`} title={value}>
        {truncate(value, 160)}
      </dd>
    </div>
  );
}

function GroupRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv-group">
      <dt className="kv-group-key">{label}</dt>
      <dd className="kv-group-body">{children}</dd>
    </div>
  );
}

/** Keys consumed by an item heading, so they are not repeated in its body. */
const ITEM_TITLE_KEYS = new Set(['name', 'mountpoint', 'key']);

function ArrayRow({
  name,
  items,
  depth,
  path,
}: {
  name: string;
  items: unknown[];
  depth: number;
  path: readonly string[];
}) {
  const label = humanizeKey(name);

  if (items.length === 0) {
    return <ScalarRow label={label} value="none" muted />;
  }

  const allPrimitive = items.every((item) => !isPlainObject(item) && !Array.isArray(item));
  if (allPrimitive) {
    const numbers = items.filter(isFiniteNumber);
    if (numbers.length === items.length && items.length > MAX_INLINE_VALUES) {
      return <ScalarRow label={label} value={numericSummary(name, numbers, path)} />;
    }
    const shown = items.slice(0, MAX_INLINE_VALUES);
    const rest = items.length - shown.length;
    return (
      <div className="kv-row">
        <dt className="kv-key">{label}</dt>
        <dd className="kv-value kv-chips">
          {shown.map((item, index) => (
            <span className="kv-chip" key={index}>
              {formatByKey(name, item, path)}
            </span>
          ))}
          {rest > 0 ? <span className="kv-chip kv-chip--more">+{rest} more</span> : null}
        </dd>
      </div>
    );
  }

  if (depth >= MAX_DEPTH) {
    return <ScalarRow label={label} value={`${items.length} items`} muted />;
  }

  const childPath = [...path, name];
  const shown = items.slice(0, MAX_ITEMS);
  const rest = items.length - shown.length;
  return (
    <GroupRow label={`${label} (${items.length})`}>
      <ul className="kv-items">
        {shown.map((item, index) => (
          <li className="kv-item" key={index}>
            {isPlainObject(item) ? (
              <>
                <p className="kv-item-title">{labelForItem(item, index)}</p>
                <ObjectRows
                  value={item}
                  depth={depth + 1}
                  path={childPath}
                  skipKeys={ITEM_TITLE_KEYS}
                />
              </>
            ) : Array.isArray(item) ? (
              <p className="kv-item-title">{`${item.length} values`}</p>
            ) : (
              <p className="kv-item-title">{formatByKey(name, item, path)}</p>
            )}
          </li>
        ))}
        {rest > 0 ? <li className="kv-item kv-item--more">+{rest} more</li> : null}
      </ul>
    </GroupRow>
  );
}

function Row({
  name,
  value,
  depth,
  path,
}: {
  name: string;
  value: unknown;
  depth: number;
  path: readonly string[];
}) {
  const label = humanizeKey(name);

  if (Array.isArray(value)) {
    return <ArrayRow name={name} items={value} depth={depth} path={path} />;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return <ScalarRow label={label} value="none" muted />;
    if (depth >= MAX_DEPTH) {
      return <ScalarRow label={label} value={`${keys.length} fields`} muted />;
    }
    return (
      <GroupRow label={label}>
        <ObjectRows value={value} depth={depth + 1} path={[...path, name]} />
      </GroupRow>
    );
  }

  return (
    <ScalarRow
      label={label}
      value={formatByKey(name, value, path)}
      muted={typeof value === 'boolean' && !value}
    />
  );
}

function ObjectRows({
  value,
  depth,
  path,
  skipKeys,
}: {
  value: Record<string, unknown>;
  depth: number;
  path: readonly string[];
  skipKeys?: ReadonlySet<string>;
}) {
  const allKeys = Object.keys(value);
  const redundant = dropRedundantKeys(allKeys);
  const entries = Object.entries(value).filter(
    ([key]) => !skipKeys?.has(key) && !redundant.has(key),
  );
  if (entries.length === 0) return null;
  // Scalars first: the headline numbers should not be pushed below a long
  // nested block such as a container list.
  entries.sort(([, a], [, b]) => {
    const rank = (item: unknown) => (isPlainObject(item) || Array.isArray(item) ? 1 : 0);
    return rank(a) - rank(b);
  });
  return (
    <dl className="kv" data-depth={depth}>
      {entries.map(([key, item]) => (
        <Row key={key} name={key} value={item} depth={depth} path={path} />
      ))}
    </dl>
  );
}

/**
 * Fallback card: renders any collector's `data` as readable key/value rows.
 *
 * This is what makes the dashboard self-extending — a collector added to the
 * backend shows up here with real, formatted data immediately, long before
 * anyone writes a bespoke card for it. Keys (and the keys they are nested
 * under) act as unit hints, nested objects recurse a few levels, object arrays
 * become labelled sub-blocks, and long numeric arrays collapse to a
 * min/avg/max digest.
 */
export function GenericCard({ result, title }: GenericCardProps) {
  const data = isPlainObject(result.data) ? result.data : {};
  const empty = Object.keys(data).length === 0;

  return (
    <Card title={title ?? humanizeKey(result.name)} result={result}>
      {empty ? (
        <p className="card__empty">
          {result.error ? 'No data from this collector.' : 'Waiting for the first sample…'}
        </p>
      ) : (
        <ObjectRows value={data} depth={0} path={[result.name]} />
      )}
    </Card>
  );
}

export default GenericCard;
