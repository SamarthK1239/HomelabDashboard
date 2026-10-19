import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface SparklineProps {
  /** Epoch seconds, ascending. */
  timestamps: readonly number[];
  /** One value per timestamp; `null` renders as a gap. */
  values: readonly (number | null)[];
  /** Stroke colour; defaults to the theme accent. */
  color?: string;
  height?: number;
  /** Unit suffix, used for the accessible label (e.g. `%`, `°C`). */
  unit?: string;
  /** Optional y-axis clamps, e.g. `min={0} max={100}` for percentages. */
  min?: number;
  max?: number;
  /** Translucent area under the line. Defaults to true. */
  fill?: boolean;
  label?: string;
  className?: string;
}

const DEFAULT_HEIGHT = 44;
const DEFAULT_COLOR = 'var(--accent)';

/** Resolve a CSS custom property to a literal colour for canvas drawing. */
function resolveColor(color: string, element: Element | null): string {
  const match = /^var\((--[\w-]+)\)$/.exec(color.trim());
  if (!match || !element) return color;
  const resolved = getComputedStyle(element).getPropertyValue(match[1]).trim();
  return resolved || '#7aa2f7';
}

function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const int = Number.parseInt(hex[1], 16);
    return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
  }
  const rgb = /^rgb\(([^)]+)\)$/i.exec(color);
  if (rgb) return `rgba(${rgb[1]}, ${alpha})`;
  return color;
}

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
}: SparklineProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

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
    const options: uPlot.Options = {
      width: Math.max(1, Math.round(container.clientWidth || 240)),
      height,
      class: 'sparkline-plot',
      legend: { show: false },
      cursor: { show: false },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      padding: [4, 1, 2, 1],
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
      axes: [
        { show: false },
        { show: false },
      ],
      series: [
        {},
        {
          stroke,
          width: 1.75,
          fill: fill ? withAlpha(stroke, 0.16) : undefined,
          points: { show: false },
          spanGaps: false,
        },
      ],
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
    };
  }, [color, fill, height, max, min, plottable]);

  // Data updates: hand the new arrays to the existing chart.
  useEffect(() => {
    dataRef.current = data;
    plotRef.current?.setData(data);
  }, [data]);

  const lastValue = useMemo(() => {
    const ys = data[1] as (number | null)[];
    for (let i = ys.length - 1; i >= 0; i -= 1) {
      const value = ys[i];
      if (typeof value === 'number') return value;
    }
    return null;
  }, [data]);

  const classes = ['sparkline', className].filter(Boolean).join(' ');

  if (!plottable) {
    return (
      <div className={`${classes} sparkline--empty`} style={{ height }} aria-hidden="true">
        <span>collecting…</span>
      </div>
    );
  }

  const ariaLabel =
    label ??
    (lastValue === null
      ? 'history chart'
      : `history chart, latest ${lastValue.toFixed(1)}${unit ?? ''}`);

  return <div ref={containerRef} className={classes} style={{ height }} role="img" aria-label={ariaLabel} />;
}

export default Sparkline;
