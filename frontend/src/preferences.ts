/**
 * User preferences: theme, density, layout and ambient behaviour.
 *
 * Everything here is *local to the browser*. The backend is read-only by
 * design and has no concept of a user, so preferences live in `localStorage`
 * and are applied to `<html>` as data attributes that the token layer reads.
 *
 * The same storage key is read by the inline bootstrap script in `index.html`
 * before React mounts, which is what prevents a flash of the wrong theme.
 */

export const PREFS_STORAGE_KEY = 'homelab-dashboard:prefs:v1';

export type ThemeChoice = 'auto' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';
export type DensityChoice = 'auto' | 'compact' | 'comfortable' | 'ambient';
export type ResolvedDensity = 'compact' | 'comfortable' | 'ambient';

export interface Preferences {
  theme: ThemeChoice;
  density: DensityChoice;
  /** Collector names shown first, in this order. */
  pinned: string[];
  /** Collector names the user has chosen not to see. */
  hidden: string[];
  /** Explicit ordering overriding the registry default; empty means default. */
  order: string[];
  /** Dim the panel during the configured night hours. */
  nightDim: boolean;
  /** Night window, local hours [start, end); wraps past midnight. */
  nightFrom: number;
  nightTo: number;
  /** Slowly drift the shell to protect an always-on panel. */
  burnInGuard: boolean;
  /** Hide chrome after a period of no input (ambient/kiosk). */
  autoHideChrome: boolean;
  /** Promote a card to the glance layer when its collector goes critical. */
  autoFocusCritical: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'auto',
  density: 'auto',
  pinned: [],
  hidden: [],
  order: [],
  nightDim: false,
  nightFrom: 23,
  nightTo: 7,
  burnInGuard: false,
  autoHideChrome: false,
  autoFocusCritical: true,
};

const THEME_CHOICES: readonly ThemeChoice[] = ['auto', 'dark', 'light'];
const DENSITY_CHOICES: readonly DensityChoice[] = ['auto', 'compact', 'comfortable', 'ambient'];

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((entry): entry is string => typeof entry === 'string');
  return out.length === value.length ? out : out;
}

function asHour(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23
    ? value
    : fallback;
}

/**
 * Parse whatever is in storage into a valid `Preferences`.
 *
 * Deliberately total: a corrupt or half-upgraded blob must never prevent the
 * dashboard from rendering, so every field falls back independently instead of
 * the whole object being discarded.
 */
export function parsePreferences(raw: string | null): Preferences {
  if (!raw) return DEFAULT_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCES;
  const value = parsed as Record<string, unknown>;

  const theme = THEME_CHOICES.includes(value.theme as ThemeChoice)
    ? (value.theme as ThemeChoice)
    : DEFAULT_PREFERENCES.theme;
  const density = DENSITY_CHOICES.includes(value.density as DensityChoice)
    ? (value.density as DensityChoice)
    : DEFAULT_PREFERENCES.density;

  return {
    theme,
    density,
    pinned: asStringArray(value.pinned) ?? DEFAULT_PREFERENCES.pinned,
    hidden: asStringArray(value.hidden) ?? DEFAULT_PREFERENCES.hidden,
    order: asStringArray(value.order) ?? DEFAULT_PREFERENCES.order,
    nightDim: typeof value.nightDim === 'boolean' ? value.nightDim : DEFAULT_PREFERENCES.nightDim,
    nightFrom: asHour(value.nightFrom, DEFAULT_PREFERENCES.nightFrom),
    nightTo: asHour(value.nightTo, DEFAULT_PREFERENCES.nightTo),
    burnInGuard:
      typeof value.burnInGuard === 'boolean' ? value.burnInGuard : DEFAULT_PREFERENCES.burnInGuard,
    autoHideChrome:
      typeof value.autoHideChrome === 'boolean'
        ? value.autoHideChrome
        : DEFAULT_PREFERENCES.autoHideChrome,
    autoFocusCritical:
      typeof value.autoFocusCritical === 'boolean'
        ? value.autoFocusCritical
        : DEFAULT_PREFERENCES.autoFocusCritical,
  };
}

export function loadPreferences(): Preferences {
  try {
    return parsePreferences(localStorage.getItem(PREFS_STORAGE_KEY));
  } catch {
    // Private browsing modes can throw on access rather than return null.
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A dashboard that cannot persist a preference is still a working
    // dashboard; never let quota or a disabled store break the render.
  }
}

/**
 * Pick a density for a viewport when the user has not chosen one.
 *
 * The heuristic encodes the three viewing distances the design targets: a
 * coarse pointer is a phone or tablet held close (compact keeps more on
 * screen), a very wide viewport with a fine pointer is almost certainly the
 * wall-mounted panel (ambient), and everything else is a seated desktop.
 */
export function autoDensity(
  width: number,
  coarsePointer: boolean,
  height = Number.POSITIVE_INFINITY,
): ResolvedDensity {
  if (coarsePointer || width < 640) return 'compact';
  if (width >= 2200 || (width >= 1800 && height >= 1000)) return 'ambient';
  return 'comfortable';
}

/** Is `hour` inside the night window, which may wrap past midnight? */
export function isNightHour(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}
