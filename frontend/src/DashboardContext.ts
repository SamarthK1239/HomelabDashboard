import { createContext, useContext } from 'react';

/**
 * Actions a card may ask the shell to perform.
 *
 * Cards are rendered deep inside the grid and must not reach back into `App`
 * directly; this context is the seam. It stays deliberately small — opening a
 * detail sheet, and knowing whether this card is the one currently being
 * pointed at from the summary bar.
 */
export interface DashboardApi {
  /** Open the detail sheet for a collector. */
  openDetail: (name: string) => void;
  /** Collector currently highlighted (e.g. jumped to from a KPI). */
  highlighted: string | null;
  /** Scroll a collector's card into view and flash it. */
  focusCard: (name: string) => void;
}

const NOOP: DashboardApi = {
  openDetail: () => {},
  highlighted: null,
  focusCard: () => {},
};

export const DashboardContext = createContext<DashboardApi>(NOOP);

export function useDashboard(): DashboardApi {
  return useContext(DashboardContext);
}
