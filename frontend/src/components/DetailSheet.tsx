import { useCallback, useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';

import { formatAge, humanizeKey, isPlainObject } from '../format';
import { useHistoryBatch } from '../hooks/useHistoryBatch';
import { useMetricKeys } from '../hooks/useMetricKeys';
import type { CollectorResult } from '../types';
import { CollectorData, DETAIL_LIMITS } from './GenericCard';
import { Sparkline } from './Sparkline';
import { StatusBadge } from './StatusBadge';
import { CollectorIcon } from './icons';
import './detail-sheet.css';

export interface DetailSheetProps {
  /** Collector name, or `null` when the sheet is closed. */
  name: string | null;
  result: CollectorResult | null;
  title: string;
  refreshSeconds: number;
  windowSeconds?: number;
  onClose: () => void;
}

/** Percentage-shaped metrics get a fixed 0–100 axis so shapes stay comparable. */
function axisFor(metric: string): { min?: number; max?: number; unit?: string } {
  // `cpu.socket0` and `gpu0_mem_percent` are both percentages, but only one of
  // them says so in its name. Without the socket case the chart renders an
  // unlabelled "1.6" on an auto-scaled axis beside an explicit "1.2%", which
  // invites exactly the wrong comparison.
  if (/(percent|usage|util|socket\d)/.test(metric)) return { min: 0, max: 100, unit: '%' };
  if (/temp/.test(metric)) return { unit: '°C' };
  if (/watts/.test(metric)) return { unit: ' W' };
  if (/latency|_ms$/.test(metric)) return { unit: ' ms' };
  return {};
}

/**
 * The drill-down layer.
 *
 * Cards answer "what is it now"; this answers "what has it been doing, and
 * what else does this collector know". Built on the native `<dialog>` element
 * so focus trapping, the top layer, inertness of the page behind it and
 * Escape-to-close come from the platform rather than from a library.
 */
export function DetailSheet({
  name,
  result,
  title,
  refreshSeconds,
  windowSeconds,
  onClose,
}: DetailSheetProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const open = Boolean(name && result);

  // `showModal()` is imperative and throws if called on an already-open
  // dialog, so the open state is reconciled rather than mirrored.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const handleClose = useCallback(() => onClose(), [onClose]);

  const allKeys = useMetricKeys(open);
  const metrics = useMemo(
    () => (name ? allKeys.filter((key) => key.startsWith(`${name}.`)) : []),
    [allKeys, name],
  );

  const { series } = useHistoryBatch(metrics, {
    refreshSeconds,
    windowSeconds,
    enabled: open,
  });

  const data = isPlainObject(result?.data) ? result.data : {};

  return (
    <dialog
      ref={dialogRef}
      className="sheet"
      onClose={handleClose}
      // Clicking the backdrop targets the dialog itself, never a child.
      onClick={(event) => {
        if (event.target === dialogRef.current) handleClose();
      }}
      aria-label={`${title} details`}
    >
      {open && result ? (
        <div className="sheet__panel">
          <header className="sheet__head">
            <span className="sheet__icon" data-status={result.status} aria-hidden="true">
              <CollectorIcon name={name ?? ''} size={18} />
            </span>
            <div className="sheet__titles">
              <h2 className="sheet__title">{title || humanizeKey(result.name)}</h2>
              <p className="sheet__sub">
                <StatusBadge status={result.status} size="sm" />
                {result.age_seconds !== null && result.age_seconds !== undefined ? (
                  <span>sampled {formatAge(result.age_seconds)} ago</span>
                ) : null}
                {result.duration_ms !== null && result.duration_ms !== undefined ? (
                  <span>collected in {Math.round(result.duration_ms)} ms</span>
                ) : null}
              </p>
            </div>
            <button type="button" className="btn btn--icon" onClick={handleClose} title="Close (Esc)">
              <X size={16} />
              <span className="sr-only">Close</span>
            </button>
          </header>

          {result.error ? (
            <p className="sheet__error" role="alert">
              {result.error}
            </p>
          ) : null}

          <div className="sheet__body">
            {metrics.length > 0 ? (
              <section className="sheet__section">
                <h3 className="t-label sheet__section-title">
                  History{windowSeconds ? ` · last ${formatAge(windowSeconds)}` : ''}
                </h3>
                <div className="sheet__charts">
                  {metrics.map((metric) => {
                    const entry = series[metric];
                    const axis = axisFor(metric);
                    const short = metric.slice(metric.indexOf('.') + 1);
                    const last = entry?.values.at(-1);
                    return (
                      <figure className="sheet__chart" key={metric}>
                        <figcaption className="sheet__chart-head">
                          <span className="sheet__chart-name">{humanizeKey(short)}</span>
                          <span className="sheet__chart-value t-numeric">
                            {typeof last === 'number'
                              ? `${last.toFixed(1)}${axis.unit ?? ''}`
                              : '—'}
                          </span>
                        </figcaption>
                        <Sparkline
                          timestamps={entry?.timestamps ?? []}
                          values={entry?.values ?? []}
                          height={96}
                          detail
                          min={axis.min}
                          max={axis.max}
                          unit={axis.unit}
                          syncKey="detail"
                          label={`${humanizeKey(short)} history`}
                        />
                      </figure>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <section className="sheet__section">
              <h3 className="t-label sheet__section-title">Full payload</h3>
              <CollectorData data={data} path={[result.name]} limits={DETAIL_LIMITS} />
            </section>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

export default DetailSheet;
