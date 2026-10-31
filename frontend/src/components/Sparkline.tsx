import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './sparkline.css';

export interface SparklineProps {
  /** Epoch seconds, ascending. */
  timestamps: readonly number[];
  /** One value per timestamp; `null` renders as a gap. */
  values: readonly (number | null)[];
  /** Stroke colour; defaults to the theme accent. */
  color?: string;
  height?: number;
  /** Unit suffix, used for the accessible label and the tooltip (`%`, `°C`). */
  unit?: string;
  /** Optional y-axis clamps, e.g. `min={0} max={100}` for percentages. */
  min?: number;
  max?: number;
  /** Translucent area under the line. Defaults to true. */
  fill?: boolean;
  label?: string;
  className?: string;
  /**
   * Show a crosshair and a value tooltip on hover. Every interactive chart
   * sharing a `syncKey` moves together, so hovering one reads the same instant
   * on all of them.
   */
  interactive?: boolean;
  syncKey?: string;
  /** Detail mode: axes, gridlines and a taller plot for the detail sheet. */
  detail?: boolean;
  /** Overrides the default tooltip number formatting. */
  formatValue?: (value: number) => string;
}

const DEFAULT_HEIGHT = 44;
const DEFAULT_COLOR = 'var(--accent-solid)';

/**
 * Cursor synchronisation groups, created lazily and shared across every
 * Sparkline using the same key. uPlot requires the *same* sync object on each
 * chart, so they are cached here rather than created per component.
 */
const syncGroups = new Map<string, uPlot.SyncPubSub>();

function syncFor(key: string): uPlot.SyncPubSub {
  let group = syncGroups.get(key);
  if (!group) {
    group = uPlot.sync(key);
    syncGroups.set(key, group);
  }
  return group;
}

/** Resolve a CSS custom property to a literal colour for canvas drawing. */
function resolveColor(color: string, element: Element | null): string {
  const match = /^var\((--[\w-]+)\)$/.exec(color.trim());
  if (!match || !element) return color;
  const resolved = getComputedStyle(element).getPropertyValue(match[1]).trim();
  return resolved || '#7aa2f7';
}

/**
 * Canvas cannot read a CSS custom property, and the theme is expressed almost
 * entirely in them. Colours are therefore resolved at build time against the
 * live element — which also means a theme switch has to rebuild the chart, and
 * `themeTick` below is what forces that.
 */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const int = Number.parseInt(hex[1], 16);
    return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (rgb) return `rgba(${rgb[1].split('/')[0].trim()}, ${alpha})`;
  // oklch() and friends: color-mix keeps this correct without parsing.
  return `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

/** Re-render charts when the document theme changes. */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setTick((value) => value + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return tick;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * A minimal uPlot line chart.
 *
 * uPlot is imperative: the chart is constructed once, fed new data with
 * `setData`, resized from a `ResizeObserver`, and destroyed on unmount.
 * Rebuilding it on every render would thrash the canvas and lose the scales.
 */
export function Sparkline({
  timestamps,
  values,
  color = DEFAULT_COLOR,
  height = DEFAULT_HEIGHT,
  unit,
  min,
  max,
  fill = true,
  label,
  className,
  interactive = true,
  syncKey = 'dashboard',
  detail = false,
  formatValue,
}: SparklineProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const themeTick = useThemeTick();

  const [hover, setHover] = useState<{ left: number; value: number; time: number } | null>(null);

  const data = useMemo<uPlot.AlignedData>(() => {
    const length = Math.min(timestamps.length, values.length);
    const xs = new Array<number>(length);
    const ys = new Array<number | null>(length);
    for (let i = 0; i < length; i += 1) {
      xs[i] = timestamps[i];
      const value = values[i];
      ys[i] = typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    return [xs, ys];
  }, [timestamps, values]);

  const dataRef = useRef<uPlot.AlignedData>(data);
  const plottable = data[0].length >= 2;

  // Create / destroy. Deps are only the options that shape the chart, so
  // ordinary data updates never tear it down.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !plottable) return;

    const stroke = resolveColor(color, container);
    const axisColor = resolveColor('var(--fg-tertiary)', container);
    const gridColor = resolveColor('var(--line-subtle)', container);

    const options: uPlot.Options = {
      width: Math.max(1, Math.round(container.clientWidth || 240)),
      height,
      class: 'sparkline-plot',
      legend: { show: false },
      cursor: interactive
        ? {
            show: true,
            x: true,
            y: false,
            points: { show: true, size: 6 },
            // Charts sharing a key move together, so one hover reads the same
            // instant across every card on the page.
            sync: { key: syncKey, setSeries: false },
          }
        : { show: false },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      padding: detail ? [8, 8, 0, 0] : [4, 1, 2, 1],
      scales: {
        x: { time: true },
        y: {
          range: (_self, dataMin, dataMax) => {
            const lo = Number.isFinite(dataMin) ? dataMin : 0;
            const hi = Number.isFinite(dataMax) ? dataMax : 1;
            let low = min ?? lo;
            let high = max ?? hi;
            if (!(high > low)) {
              const pad = Math.max(Math.abs(high) * 0.1, 1);
              low = min ?? low - pad;
              high = max ?? high + pad;
            } else if (min === undefined && max === undefined) {
              const pad = (high - low) * 0.08;
              low -= pad;
              high += pad;
            }
            return [low, high];
          },
        },
      },
      axes: detail
        ? [
            {
              stroke: axisColor,
              grid: { stroke: gridColor, width: 1 },
              ticks: { stroke: gridColor, width: 1 },
              size: 32,
              font: '11px system-ui, sans-serif',
            },
            {
              stroke: axisColor,
              grid: { stroke: gridColor, width: 1 },
              ticks: { stroke: gridColor, width: 1 },
              size: 44,
              font: '11px system-ui, sans-serif',
            },
          ]
        : [{ show: false }, { show: false }],
      series: [
        {},
        {
          stroke,
          width: detail ? 2 : 1.75,
          fill: fill ? withAlpha(stroke, 0.16) : undefined,
          points: { show: false },
          spanGaps: false,
        },
      ],
      hooks: interactive
        ? {
            setCursor: [
              (self) => {
                const index = self.cursor.idx;
                const left = self.cursor.left ?? -1;
                if (index === null || index === undefined || left < 0) {
                  setHover(null);
                  return;
                }
                const ys = self.data[1] as (number | null)[];
                const value = ys[index];
                if (typeof value !== 'number') {
                  setHover(null);
                  return;
                }
                setHover({ left, value, time: (self.data[0] as number[])[index] });
              },
            ],
          }
        : undefined,
    };

    const plot = new uPlot(options, dataRef.current, container);
    plotRef.current = plot;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) plot.setSize({ width: Math.round(width), height });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
      setHover(null);
    };
    // `syncFor` is referenced via the options object; keep it out of deps.
  }, [color, detail, fill, height, interactive, max, min, plottable, syncKey, themeTick]);

  // uPlot resolves `cursor.sync.key` to a group internally; priming the cache
  // here keeps every chart on the page in the same group object.
  useEffect(() => {
    if (interactive) syncFor(syncKey);
  }, [interactive, syncKey]);

  // Data updates: hand the new arrays to the existing chart.
  useEffect(() => {
    dataRef.current = data;
    plotRef.current?.setData(data);
  }, [data]);

  const stats = useMemo(() => {
    const ys = data[1] as (number | null)[];
    let last: number | null = null;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < ys.length; i += 1) {
      const value = ys[i];
      if (typeof value !== 'number') continue;
      last = value;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    return {
      last,
      min: Number.isFinite(lo) ? lo : null,
      max: Number.isFinite(hi) ? hi : null,
    };
  }, [data]);

  /*
   * A bounded chart (0-100%, say) keeps its full axis even when the series
   * sits near one edge, so shapes stay comparable between cards. That leaves a
   * large empty region which, unmarked, reads as missing data rather than as
   * headroom — the rules below frame it as a scale.
   */
  const bounded = min !== undefined && max !== undefined;
  const classes = [
    'sparkline',
    detail ? 'sparkline--detail' : null,
    bounded && !detail ? 'sparkline--bounded' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if (!plottable) {
    return (
      <div className={`${classes} sparkline--empty`} style={{ height }} aria-hidden="true">
        <span>collecting…</span>
      </div>
    );
  }

  const format = formatValue ?? ((value: number) => `${value.toFixed(1)}${unit ?? ''}`);

  /*
   * The accessible name carries the shape of the series, not just the last
   * point: a screen-reader user gets "latest 42%, ranging 11% to 97%" rather
   * than an image they cannot interpret at all.
   */
  const ariaLabel =
    label ??
    (stats.last === null
      ? 'history chart'
      : stats.min !== null && stats.max !== null
        ? `history chart, latest ${format(stats.last)}, ranging ${format(stats.min)} to ${format(stats.max)}`
        : `history chart, latest ${format(stats.last)}`);

  return (
    <div className={classes} style={{ height }}>
      <div ref={containerRef} style={{ height }} role="img" aria-label={ariaLabel} />
      {hover ? (
        <span className="spark-tip" style={{ left: hover.left }} aria-hidden="true">
          {format(hover.value)}
          <span className="spark-tip__time">{timeFormatter.format(hover.time * 1000)}</span>
        </span>
      ) : null}
    </div>
  );
}

export default Sparkline;
