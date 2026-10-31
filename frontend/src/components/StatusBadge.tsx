import { StatusGlyph } from './icons';
import { STATUS_LABELS } from '../types';
import type { Status } from '../types';
import './status-badge.css';

export interface StatusBadgeProps {
  status: Status;
  /** Override the default label (e.g. "3 containers down"). */
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  /** `glyph` drops the text and shows only the icon; `bare` drops the pill. */
  variant?: 'pill' | 'glyph' | 'bare';
  /** Suppress the leading glyph when another indicator already carries shape. */
  showIcon?: boolean;
  /** Animate the glyph to signal a live connection. */
  pulse?: boolean;
  title?: string;
  className?: string;
}

const ICON_SIZE: Record<NonNullable<StatusBadgeProps['size']>, number> = {
  sm: 12,
  md: 14,
  lg: 18,
};

/**
 * The canonical status indicator.
 *
 * Colour comes from the `--sev-*` tokens resolved by `data-status`, and shape
 * comes from `StatusGlyph`, so the badge stays legible without colour vision
 * and without reading the label.
 */
export function StatusBadge({
  status,
  label,
  size = 'sm',
  variant = 'pill',
  showIcon = true,
  pulse = false,
  title,
  className,
}: StatusBadgeProps) {
  const text = label ?? STATUS_LABELS[status];
  const classes = [
    'status-badge',
    `status-badge--${size}`,
    `status-badge--${variant}`,
    pulse ? 'status-badge--pulse' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if (variant === 'glyph') {
    return (
      <span className={classes} data-status={status} title={title ?? text}>
        <StatusGlyph status={status} size={ICON_SIZE[size]} strokeWidth={2.25} />
        <span className="sr-only">{text}</span>
      </span>
    );
  }

  return (
    <span className={classes} data-status={status} title={title ?? STATUS_LABELS[status]}>
      {showIcon ? <StatusGlyph status={status} size={ICON_SIZE[size]} strokeWidth={2.25} /> : null}
      <span className="status-badge__label">{text}</span>
    </span>
  );
}

export default StatusBadge;
