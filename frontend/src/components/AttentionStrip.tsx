import { useMemo } from 'react';

import { useDashboard } from '../DashboardContext';
import { deriveAttention } from '../summary';
import type { Snapshot } from '../types';
import { CollectorIcon, StatusGlyph } from './icons';
import './attention-strip.css';

export interface AttentionStripProps {
  snapshot: Snapshot | null;
  /** Display titles from `/api/meta`, so rows read like the cards do. */
  titles?: Record<string, string>;
}

/**
 * Names what is wrong, in sentences.
 *
 * A status colour tells you *that* something is degraded; it never tells you
 * what to do about it. Each row here is one degraded collector reduced to a
 * single plain-language clause, and clicking it jumps to the card that has the
 * rest of the story.
 *
 * Renders nothing when everything is healthy — an empty "no problems" panel is
 * permanent furniture that teaches the eye to skip the area where problems
 * will eventually appear.
 */
export function AttentionStrip({ snapshot, titles }: AttentionStripProps) {
  const items = useMemo(() => deriveAttention(snapshot, titles), [snapshot, titles]);
  const { focusCard } = useDashboard();

  if (items.length === 0) return null;

  return (
    <section className="attention" aria-label="Needs attention">
      <h2 className="attention__title t-label">Needs attention</h2>
      <ul className="attention__list">
        {items.map((item) => {
          return (
            <li className="attention__item" data-status={item.status} key={item.collector}>
              <button
                type="button"
                className="attention__button"
                onClick={() => focusCard(item.collector)}
              >
                <span className="attention__glyph" aria-hidden="true">
                  <StatusGlyph status={item.status} size={15} strokeWidth={2.25} />
                </span>
                <span className="attention__body">
                  <span className="attention__name">
                    <CollectorIcon name={item.collector} size={13} />
                    {item.title}
                  </span>
                  <span className="attention__reason">{item.reason}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default AttentionStrip;
