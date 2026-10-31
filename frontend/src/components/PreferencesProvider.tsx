import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { PreferencesContext, type PreferencesApi } from '../PreferencesContext';
import {
  autoDensity,
  isNightHour,
  loadPreferences,
  savePreferences,
  type DensityChoice,
  type Preferences,
  type ResolvedDensity,
  type ResolvedTheme,
  type ThemeChoice,
} from '../preferences';

/** Toggle membership of `name` in a list, preserving order of the rest. */
function toggle(list: readonly string[], name: string): string[] {
  return list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name];
}

const THEME_CYCLE: readonly ThemeChoice[] = ['auto', 'dark', 'light'];

/** Re-evaluate night dimming this often. A minute is well inside tolerance. */
const NIGHT_CHECK_MS = 60_000;

/**
 * Owns user preferences and keeps the document in sync with them.
 *
 * The provider is the only place that writes `data-theme` / `data-density` on
 * `<html>`; every component reacts to tokens rather than to the preference
 * itself, so a new themed surface needs no wiring here.
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences);

  // --- resolve `auto` theme -------------------------------------------------

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark',
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? 'light' : 'dark');
    query.addEventListener('change', onChange);
    setSystemTheme(query.matches ? 'light' : 'dark');
    return () => query.removeEventListener('change', onChange);
  }, []);

  const theme: ResolvedTheme = prefs.theme === 'auto' ? systemTheme : prefs.theme;

  // --- resolve `auto` density ----------------------------------------------

  const [viewport, setViewport] = useState(() => ({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
    coarse:
      typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  }));

  useEffect(() => {
    const pointerQuery = window.matchMedia('(pointer: coarse)');
    const read = () =>
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight,
        coarse: pointerQuery.matches,
      });
    read();
    window.addEventListener('resize', read, { passive: true });
    pointerQuery.addEventListener('change', read);
    return () => {
      window.removeEventListener('resize', read);
      pointerQuery.removeEventListener('change', read);
    };
  }, []);

  const density: ResolvedDensity =
    prefs.density === 'auto'
      ? autoDensity(viewport.width, viewport.coarse, viewport.height)
      : prefs.density;

  // --- night dimming --------------------------------------------------------

  const [hour, setHour] = useState(() => new Date().getHours());

  useEffect(() => {
    if (!prefs.nightDim) return;
    const id = window.setInterval(() => setHour(new Date().getHours()), NIGHT_CHECK_MS);
    setHour(new Date().getHours());
    return () => window.clearInterval(id);
  }, [prefs.nightDim]);

  const dimmed = prefs.nightDim && isNightHour(hour, prefs.nightFrom, prefs.nightTo);

  // --- apply to the document ------------------------------------------------

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.density = density;
    root.dataset.dimmed = dimmed ? 'true' : 'false';

    // Keep the browser UI (phone address bar, PWA status bar) in step with the
    // page rather than stuck on whatever index.html shipped with.
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) {
      meta.content = getComputedStyle(root).getPropertyValue('--bg-base').trim() || meta.content;
    }
  }, [theme, density, dimmed]);

  useEffect(() => {
    savePreferences(prefs);
  }, [prefs]);

  // --- api ------------------------------------------------------------------

  const update = useCallback((patch: Partial<Preferences>) => {
    setPrefs((current) => ({ ...current, ...patch }));
  }, []);

  const api = useMemo<PreferencesApi>(
    () => ({
      prefs,
      theme,
      density,
      dimmed,
      update,
      setTheme: (choice: ThemeChoice) => update({ theme: choice }),
      setDensity: (choice: DensityChoice) => update({ density: choice }),
      cycleTheme: () =>
        setPrefs((current) => ({
          ...current,
          theme: THEME_CYCLE[(THEME_CYCLE.indexOf(current.theme) + 1) % THEME_CYCLE.length],
        })),
      togglePinned: (name: string) =>
        setPrefs((current) => ({ ...current, pinned: toggle(current.pinned, name) })),
      toggleHidden: (name: string) =>
        setPrefs((current) => ({ ...current, hidden: toggle(current.hidden, name) })),
      setOrder: (order: string[]) => update({ order }),
      resetLayout: () => update({ pinned: [], hidden: [], order: [] }),
    }),
    [prefs, theme, density, dimmed, update],
  );

  return <PreferencesContext.Provider value={api}>{children}</PreferencesContext.Provider>;
}

export default PreferencesProvider;
