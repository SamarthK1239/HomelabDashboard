import { useCallback, useEffect, useState } from 'react';

/** Extra height left below the last visible row so the next one peeks through. */
const PEEK_PIXELS = 18;

/**
 * Caps a list at the height of its first `maxRows` children and scrolls the
 * rest.
 *
 * The rows this is used for are not a uniform height — a container with
 * published ports is taller than one without — so a fixed pixel ceiling would
 * show two rows in one case and three and a half in another. Measuring the
 * real children keeps "the first three" literally true whatever they contain.
 *
 * The cap is removed entirely when there is nothing to scroll to, so a host
 * running two containers gets a card sized to two containers rather than a
 * short list with a pointless scroll region.
 */
export function useRowLimit<T extends HTMLElement>(maxRows: number) {
  // A callback ref rather than `useRef`: the list is not rendered at all until
  // the first snapshot arrives with something in it, so an effect keyed on
  // mount alone would run once against nothing and never see the real list.
  const [list, setList] = useState<T | null>(null);
  const ref = useCallback((node: T | null) => setList(node), []);

  useEffect(() => {
    if (!list || typeof ResizeObserver === 'undefined') return;

    let frame = 0;

    const apply = () => {
      frame = 0;
      const rows = Array.from(list.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      );

      if (rows.length <= maxRows) {
        list.style.removeProperty('max-height');
        return;
      }

      const gap = Number.parseFloat(window.getComputedStyle(list).rowGap) || 0;
      let height = 0;
      for (let index = 0; index < maxRows; index += 1) {
        height += rows[index].getBoundingClientRect().height;
      }
      height += gap * (maxRows - 1);
      list.style.maxHeight = `${Math.round(height + gap + PEEK_PIXELS)}px`;
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(apply);
    };

    // Observing the list alone is not enough: a row growing a ports chip does
    // not change the (capped) list's own height.
    const observer = new ResizeObserver(schedule);
    const observed = new Set<Element>();
    const syncChildren = () => {
      for (const child of Array.from(list.children)) {
        if (!observed.has(child)) {
          observer.observe(child);
          observed.add(child);
        }
      }
      for (const child of observed) {
        if (child.parentElement !== list) {
          observer.unobserve(child);
          observed.delete(child);
        }
      }
      schedule();
    };

    syncChildren();

    const mutations = new MutationObserver(syncChildren);
    mutations.observe(list, { childList: true });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      mutations.disconnect();
      observer.disconnect();
    };
  }, [list, maxRows]);

  return ref;
}
