import { STATUS_LABELS } from '../types';
import type { Status } from '../types';

export interface StatusBadgeProps {
  status: Status;
  /** Override the default label (e.g. "3 containers down"). */
  label?: string;
  size?: 'sm' | 'md';
  /** Hide the leading dot when the badge sits next to another indicator. */
  showDot?: boolean;
  title?: string;
  className?: string;
}

/** Small status pill. Colour comes from `--status-*` custom properties. */
export function StatusBadge({
  status,
  label,
  size = 'sm',
  showDot = true,
  title,
  className,
}: StatusBadgeProps) {
  const classes = ['status-badge', `status-badge--${size}`, className].filter(Boolean).join(' ');
  return (
    <span className={classes} data-status={status} title={title ?? STATUS_LABELS[status]}>
      {showDot ? <span className="status-badge__dot" aria-hidden="true" /> : null}
      <span className="status-badge__label">{label ?? STATUS_LABELS[status]}</span>
    </span>
  );
}

export default StatusBadge;
