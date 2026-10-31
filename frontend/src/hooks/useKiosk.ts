import { useCallback, useEffect, useState } from 'react';

/**
 * Fullscreen, wake lock and idle-chrome behaviour for the wall panel.
 *
 * A dashboard that is mounted on a wall has requirements a dashboard in a tab
 * does not: it must not let the display sleep, it should surrender the browser
 * chrome, and after a while with nobody touching it the page's own chrome is
 * just noise around the data. All three are opt-in and all three degrade
 * silently where the API is missing (Wake Lock, for instance, is absent in
 * Firefox and in any non-secure context).
 */

export interface KioskApi {
  fullscreen: boolean;
  toggleFullscreen: () => void;
  /** True when the page chrome is currently faded out. */
  chromeHidden: boolean;
  /** True when a screen wake lock is actually held. */
  wakeLock: boolean;
}

const IDLE_MS = 20_000;

export function useFullscreen(): [boolean, () => void] {
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement));

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    // Both calls reject when the gesture requirement is unmet or the browser
    // refuses; a failed fullscreen request must never break the dashboard.
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);

  return [fullscreen, toggle];
}

/**
 * Holds a screen wake lock while `enabled`.
 *
 * The lock is released by the browser whenever the document is hidden, so it
 * is re-acquired on visibility change — without that, the panel would go dark
 * the first time anyone switched tabs on it.
 */
export function useWakeLock(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) {
      setHeld(false);
      return;
    }
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void sentinel.release().catch(() => {});
          return;
        }
        setHeld(true);
        sentinel.addEventListener('release', () => setHeld(false));
      } catch {
        setHeld(false);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => {});
      setHeld(false);
    };
  }, [enabled]);

  return held;
}

/** Fades the page chrome after `IDLE_MS` with no pointer or key activity. */
export function useIdleChrome(enabled: boolean): boolean {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setHidden(false);
      return;
    }
    let timer = 0;
    const reset = () => {
      setHidden(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setHidden(true), IDLE_MS);
    };
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const event of events) window.addEventListener(event, reset, { passive: true });
    reset();
    return () => {
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, reset);
    };
  }, [enabled]);

  return hidden;
}

/** True once the window has scrolled past `threshold` pixels. */
export function useScrolled(threshold = 8): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);

  return scrolled;
}
