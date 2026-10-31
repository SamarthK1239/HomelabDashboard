import { createContext, useContext } from 'react';

import type {
  DensityChoice,
  Preferences,
  ResolvedDensity,
  ResolvedTheme,
  ThemeChoice,
} from './preferences';
import { DEFAULT_PREFERENCES } from './preferences';

export interface PreferencesApi {
  prefs: Preferences;
  /** The theme actually in effect once `auto` has been resolved. */
  theme: ResolvedTheme;
  /** The density actually in effect once `auto` has been resolved. */
  density: ResolvedDensity;
  /** True while the night-dimming window is active. */
  dimmed: boolean;
  setTheme: (choice: ThemeChoice) => void;
  setDensity: (choice: DensityChoice) => void;
  /** Cycle auto -> dark -> light -> auto, for the keyboard shortcut. */
  cycleTheme: () => void;
  update: (patch: Partial<Preferences>) => void;
  /** Pin or unpin a collector; pinned cards sort to the front. */
  togglePinned: (name: string) => void;
  /** Hide or reveal a collector. */
  toggleHidden: (name: string) => void;
  /** Replace the explicit card ordering (drag-and-drop result). */
  setOrder: (order: string[]) => void;
  /** Forget pins, hides and ordering, returning to the registry default. */
  resetLayout: () => void;
}

const NOOP_API: PreferencesApi = {
  prefs: DEFAULT_PREFERENCES,
  theme: 'dark',
  density: 'comfortable',
  dimmed: false,
  setTheme: () => {},
  setDensity: () => {},
  cycleTheme: () => {},
  update: () => {},
  togglePinned: () => {},
  toggleHidden: () => {},
  setOrder: () => {},
  resetLayout: () => {},
};

export const PreferencesContext = createContext<PreferencesApi>(NOOP_API);

export function usePreferences(): PreferencesApi {
  return useContext(PreferencesContext);
}
