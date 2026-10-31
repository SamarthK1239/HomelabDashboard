import { useAnimatedNumber } from '../hooks/useAnimatedNumber';
import { EM_DASH, isFiniteNumber } from '../format';

export interface AnimatedValueProps {
  /** The reading. `null`/non-finite renders as an em dash and never animates. */
  value: unknown;
  /** Turns the eased number into display text (units, decimals, locale). */
  format: (value: number) => string;
  /** Disable easing for values where intermediate states would be nonsense. */
  animate?: boolean;
  className?: string;
}

/**
 * A number that glides to its new reading.
 *
 * Pairs `useAnimatedNumber` with a formatter so the *displayed* string is
 * produced from the eased value, keeping units and decimal places consistent
 * throughout the transition. The accessible name is the settled value, so a
 * screen reader never announces a half-finished number.
 */
export function AnimatedValue({ value, format, animate = true, className }: AnimatedValueProps) {
  const target = isFiniteNumber(value) ? value : null;
  const eased = useAnimatedNumber(animate ? target : null);
  const shown = animate ? (eased ?? target) : target;

  if (shown === null) {
    return <span className={className}>{EM_DASH}</span>;
  }

  const settled = target === null ? EM_DASH : format(target);
  return (
    <span className={className} aria-label={settled}>
      <span aria-hidden="true">{format(shown)}</span>
    </span>
  );
}

export default AnimatedValue;
