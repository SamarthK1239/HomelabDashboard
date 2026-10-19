import { createContext, useContext } from 'react';

import type { Meta } from './types';

/**
 * The `/api/meta` payload, shared with every card.
 *
 * Cards use it for static hardware facts and, via `useCollectorInterval`, to
 * know how often their collector is supposed to update — which is what makes a
 * "this card has stopped refreshing" treatment possible.
 */
export const MetaContext = createContext<Meta | null>(null);

export function useMeta(): Meta | null {
  return useContext(MetaContext);
}

/** The configured sampling interval for a collector, in seconds. */
export function useCollectorInterval(name: string | undefined): number | null {
  const meta = useMeta();
  if (!name || !meta) return null;
  const interval = meta.intervals?.[name];
  return typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : null;
}
