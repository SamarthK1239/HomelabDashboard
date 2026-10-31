import { useCallback, useEffect, useState } from 'react';

/**
 * Fallback vertical gutter if the gutter cannot be measured.
 */
const FALLBACK_GAP = 16;

/**
 * Fallback masonry row height. Cards are snapped to a whole number of these,
 * so it is the worst-case vertical rounding error per card: small enough to be
 * invisible, large enough that the browser is not tracking thousands of
 * implicit grid rows.
 */
const FALLBACK_ROW = 4;

/** Class that switches the grid from uniform rows to a fine masonry pitch. */
const MASONRY_CLASS = 'grid--masonry';

function pixels(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function columnCount(styles: CSSStyleDeclaration): number {
  const columns = styles.getPropertyValue('grid-template-columns').trim();
  return columns === '' || columns === 'none' ? 1 : columns.split(/\s+/).length;
}

/**
 * Packs a CSS grid like a masonry wall.
 *
 * Cards carry very different amounts of information on purpose — a GPU card
 * has far more to say than an uptime card — but a plain grid gives every card
 * in a row the height of the tallest one, leaving dead space under the short
 * ones. CSS has no shipping answer for this yet (`grid-template-rows: masonry`
 * is still behind a flag), so the grid is given a fine row pitch and each card
 * is told how many of those rows it occupies. Cards then stack directly under
 * their neighbour instead of under the tallest card in their row.
 *
 * DOM order is untouched, so reading order and keyboard focus order still
 * match the collector ordering in the registry. The masonry class is applied
 * from here rather than in the stylesheet so that the grid falls back to plain
 * uniform rows — spaced, just not packed — if this never runs.
 *
 * Returns a callback ref to attach to the grid container.
 */
export function useMasonry<T extends HTMLElement>() {
  // A callback ref rather than `useRef`: the grid is not in the DOM on first
  // render (the loading skeleton is), so an effect keyed on mount alone would
  // run once against nothing and never see the real grid.
  const [grid, setGrid] = useState<T | null>(null);
  const ref = useCallback((node: T | null) => setGrid(node), []);

  useEffect(() => {
    if (!grid || typeof ResizeObserver === 'undefined') return;

    let frame = 0;

    const layout = () => {
      frame = 0;
      const styles = window.getComputedStyle(grid);
      const children = Array.from(grid.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      );

      // A single-column grid is already perfectly packed, and the fine row
      // pitch would only collapse the cards on top of each other.
      if (columnCount(styles) <= 1) {
        grid.classList.remove(MASONRY_CLASS);
        for (const child of children) child.style.removeProperty('grid-row-end');
        return;
      }

      grid.classList.add(MASONRY_CLASS);
      if (children.length === 0) return;

      // The gutter is read back from the margin the stylesheet actually
      // applied, not from `--masonry-gap` directly. Unregistered custom
      // properties are not resolved to absolute units by `getComputedStyle` --
      // a `1.5rem` gutter comes back as the literal string "1.5rem", which
      // `parseFloat` happily reads as 1.5 *pixels*, collapsing the vertical
      // gutter to nothing. `margin-bottom` is a real property and is always
      // computed to px, so this cannot drift from the CSS again.
      const gap = pixels(window.getComputedStyle(children[0]).marginBottom, FALLBACK_GAP);
      // Authored in px precisely so that it survives the same round trip.
      const row = pixels(styles.getPropertyValue('--masonry-row'), FALLBACK_ROW);

      for (const child of children) {
        // The grid is `align-items: start`, so a card's box is always its own
        // content height regardless of how many rows it currently spans. That
        // keeps this measurement stable and the observer from feeding itself.
        const height = child.getBoundingClientRect().height;
        const span = Math.max(1, Math.ceil((height + gap) / row));
        child.style.gridRowEnd = `span ${span}`;
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(layout);
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(grid);

    const observed = new Set<Element>();
    const syncChildren = () => {
      for (const child of Array.from(grid.children)) {
        if (!observed.has(child)) {
          observer.observe(child);
          observed.add(child);
        }
      }
      for (const child of observed) {
        if (child.parentElement !== grid) {
          observer.unobserve(child);
          observed.delete(child);
        }
      }
      schedule();
    };

    syncChildren();

    // Cards come and go as collectors appear, disappear or start erroring.
    const mutations = new MutationObserver(syncChildren);
    mutations.observe(grid, { childList: true });

    // Web fonts land after first paint and change every card's height.
    void document.fonts?.ready.then(schedule).catch(() => undefined);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      mutations.disconnect();
      observer.disconnect();
      grid.classList.remove(MASONRY_CLASS);
    };
  }, [grid]);

  return ref;
}
