import { useEffect, useRef, useState } from 'react';

/** Honour the OS "reduce motion" setting, re-evaluated when the user changes it. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    setReduced(query.matches);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export interface AnimatedNumberOptions {
  /** Approximate settle time in milliseconds. */
  duration?: number;
  /**
   * Jumps larger than this fraction of the previous value snap instead of
   * animating. A CPU graph going 4% -> 98% is a real event, not a transition
   * to be smoothed over; animating it would understate how fast it happened.
   */
  snapRatio?: number;
}

const DEFAULT_DURATION = 420;
const DEFAULT_SNAP_RATIO = 4;

/**
 * Ease a numeric reading toward its new value instead of teleporting.
 *
 * Why: between two polls a value is *inferred*, not measured. A hard jump
 * implies the dashboard saw every intermediate state; a short decelerating
 * glide reads honestly as "this moved" while keeping the digits legible. The
 * easing is `easeOutExpo`-ish, so the great majority of the distance is
 * covered immediately and the number is readable almost at once.
 *
 * `null` passes through untouched: a missing reading must never animate from
 * or toward a fabricated zero.
 */
export function useAnimatedNumber(
  target: number | null,
  { duration = DEFAULT_DURATION, snapRatio = DEFAULT_SNAP_RATIO }: AnimatedNumberOptions = {},
): number | null {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState<number | null>(target);
  const frameRef = useRef(0);
  const fromRef = useRef<number | null>(target);

  useEffect(() => {
    if (target === null) {
      setDisplay(null);
      fromRef.current = null;
      return;
    }

    const from = fromRef.current;

    // No previous reading, reduced motion, or a jump big enough to be news:
    // show the truth immediately.
    const magnitude = from === null ? Infinity : Math.abs(target - from);
    const scale = from === null ? 0 : Math.max(Math.abs(from), 1);
    if (reduced || from === null || magnitude / scale > snapRatio) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }

    if (magnitude === 0) return;

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(2, -9 * t);
      const value = from + (target - from) * eased;
      fromRef.current = value;
      setDisplay(t >= 1 ? target : value);
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
      else fromRef.current = target;
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, duration, snapRatio, reduced]);

  return display;
}
