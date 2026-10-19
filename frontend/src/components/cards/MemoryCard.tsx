import { Card } from '../Card';
import { Sparkline } from '../Sparkline';
import { useHistory } from '../../hooks/useHistory';
import {
  EM_DASH,
  formatBytes,
  formatPercent,
  isFiniteNumber,
  isPlainObject,
} from '../../format';
import type { CardProps } from './types';
import './system-cards.css';

interface NumaNode {
  id: number | null;
  total: number | null;
  used: number | null;
  free: number | null;
  cached: number | null;
  usedExcludingCache: number | null;
  percent: number | null;
  percentExcludingCache: number | null;
}

type Level = 'ok' | 'warn' | 'critical' | 'unknown';

function num(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function levelFor(percent: number | null, warn: number, critical: number): Level {
  if (percent === null) return 'unknown';
  if (percent >= critical) return 'critical';
  if (percent >= warn) return 'warn';
  return 'ok';
}

function UsageBar({
  percent,
  level,
  label,
  thin,
}: {
  percent: number | null;
  level: Level;
  label: string;
  thin?: boolean;
}) {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div
      className={thin ? 'sys-bar sys-bar--thin' : 'sys-bar'}
      role="img"
      aria-label={`${label}: ${formatPercent(percent)}`}
      title={`${label}: ${formatPercent(percent)}`}
    >
      <span className="sys-bar__fill" data-level={level} style={{ width: `${width}%` }} />
    </div>
  );
}

function readNumaNodes(value: unknown): NumaNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((entry) => ({
    id: num(entry.id),
    total: num(entry.total),
    used: num(entry.used),
    free: num(entry.free),
    cached: num(entry.cached),
    usedExcludingCache: num(entry.used_excluding_cache),
    percent: num(entry.percent),
    percentExcludingCache: num(entry.percent_excluding_cache),
  }));
}

export function MemoryCard({ result, meta, refreshSeconds }: CardProps) {
  const data = result.data ?? {};
  const history = useHistory('memory.percent', { refreshSeconds });

  const total = num(data.total) ?? num(meta?.total_bytes);
  const used = num(data.used);
  const percent = num(data.percent);
  const available = num(data.available);
  const cached = num(data.cached);
  const buffers = num(data.buffers);
  const shared = num(data.shared);

  const swap = isPlainObject(data.swap) ? data.swap : {};
  const swapTotal = num(swap.total) ?? num(meta?.swap_total_bytes);
  const swapUsed = num(swap.used);
  const swapPercent = num(swap.percent);

  const nodes = readNumaNodes(data.numa_nodes);

  return (
    <Card
      title="Memory"
      result={result}
      subtitle={total !== null ? `${formatBytes(total)} installed` : undefined}
      footer={nodes.length > 0 ? `${nodes.length} NUMA nodes` : undefined}
    >
      <div className="sys-stack">
        <div className="sys-hero">
          <div className="sys-hero__main">
            <span className="sys-hero__value" data-level={levelFor(percent, 80, 92)}>
              {formatPercent(percent)}
            </span>
            <span className="sys-hero__unit">
              {formatBytes(used)} / {formatBytes(total)}
            </span>
          </div>
          <div className="sys-hero__side">
            <span title="memory obtainable without swapping">
              {formatBytes(available)} available
            </span>
          </div>
        </div>

        <UsageBar percent={percent} level={levelFor(percent, 80, 92)} label="Memory used" />

        <Sparkline
          className="sys-spark"
          timestamps={history.timestamps}
          values={history.values}
          min={0}
          max={100}
          unit="%"
          height={46}
          label="Memory utilisation history"
        />

        <div className="sys-metrics">
          <div className="sys-metric">
            <span className="sys-metric__label">available</span>
            <span className="sys-metric__value">{formatBytes(available)}</span>
          </div>
          <div className="sys-metric">
            <span className="sys-metric__label">cached</span>
            <span className="sys-metric__value">{formatBytes(cached)}</span>
          </div>
          <div className="sys-metric">
            <span className="sys-metric__label">buffers</span>
            <span className="sys-metric__value">{formatBytes(buffers)}</span>
          </div>
          <div className="sys-metric">
            <span className="sys-metric__label">shared</span>
            <span className="sys-metric__value">{formatBytes(shared)}</span>
          </div>
        </div>

        <section className="sys-section">
          <h3 className="sys-section__title">
            <span>Swap</span>
            <span className="sys-section__title-note">
              {swapTotal !== null && swapTotal > 0 ? formatBytes(swapTotal) : 'none configured'}
            </span>
          </h3>
          {swapTotal !== null && swapTotal > 0 ? (
            <div className="sys-row">
              <div className="sys-row__head">
                <span className="sys-row__name">{formatBytes(swapUsed)} used</span>
                <span className="sys-row__percent" data-level={levelFor(swapPercent, 25, 50)}>
                  {formatPercent(swapPercent)}
                </span>
              </div>
              <UsageBar
                percent={swapPercent}
                level={levelFor(swapPercent, 25, 50)}
                label="Swap used"
                thin
              />
            </div>
          ) : (
            <p className="sys-note">No swap device, so swap pressure cannot be observed.</p>
          )}
        </section>

        {nodes.length > 0 ? (
          <section className="sys-section">
            <h3 className="sys-section__title">
              <span>Per NUMA node</span>
              <span className="sys-section__title-note">excluding page cache</span>
            </h3>
            <div className="sys-rows">
              {nodes.map((node, index) => {
                const id = node.id ?? index;
                /*
                 * sysfs `MemUsed` counts reclaimable page cache, so a node on
                 * an otherwise idle box reads ~99%. The cache-excluded figure
                 * is what actually indicates pressure, so it is the headline
                 * here and the raw number is kept as secondary context.
                 */
                const headline = node.percentExcludingCache;
                const level = levelFor(headline, 80, 92);
                return (
                  <div className="sys-row" key={`numa-${id}`}>
                    <div className="sys-row__head">
                      <span className="sys-row__name">
                        Node {id}
                        <span className="sys-muted"> · {formatBytes(node.total)}</span>
                      </span>
                      <span
                        className="sys-row__percent"
                        data-level={level}
                        title={`node ${id}: ${formatBytes(
                          node.usedExcludingCache,
                        )} in use excluding page cache`}
                      >
                        {formatPercent(headline)}
                      </span>
                    </div>
                    <UsageBar
                      percent={headline}
                      level={level}
                      label={`NUMA node ${id} used excluding cache`}
                      thin
                    />
                    <div className="sys-row__meta">
                      <span>
                        <b>{formatBytes(node.usedExcludingCache)}</b> anon
                      </span>
                      <span>
                        <b>{formatBytes(node.cached)}</b> cache
                      </span>
                      <span
                        className="sys-muted"
                        title="raw sysfs MemUsed, which counts reclaimable page cache"
                      >
                        raw {node.percent === null ? EM_DASH : formatPercent(node.percent)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </Card>
  );
}

export default MemoryCard;
