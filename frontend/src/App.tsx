import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Activity,
  Contrast,
  LayoutGrid,
  Maximize,
  Minimize,
  Moon,
  RefreshCw,
  RotateCcw,
  Rows3,
  Settings2,
  Sun,
  SunMoon,
} from 'lucide-react';

import { AttentionStrip } from './components/AttentionStrip';
import { DetailSheet } from './components/DetailSheet';
import { EventDrawer } from './components/EventDrawer';
import { GenericCard } from './components/GenericCard';
import { Menu, type MenuItem } from './components/Menu';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { SummaryBar } from './components/SummaryBar';
import { Toasts } from './components/Toasts';
import { cardFor, orderCollectors } from './components/cards/registry';
import { StatusGlyph } from './components/icons';
import { formatAge } from './format';
import { useEvents } from './hooks/useEvents';
import { useFullscreen, useIdleChrome, useScrolled, useWakeLock } from './hooks/useKiosk';
import { useMasonry } from './hooks/useMasonry';
import { REFRESH_CHOICES, useSnapshot } from './hooks/useSnapshot';
import { DashboardContext, type DashboardApi } from './DashboardContext';
import { EventsContext, useLatestEvents } from './EventsContext';
import { MetaContext } from './MetaContext';
import { usePreferences } from './PreferencesContext';
import type { ConnectionState, Meta, Status } from './types';

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  stale: 'Stale',
  disconnected: 'Offline',
};

/** Connection state maps onto the same colour vocabulary as collector status. */
const CONNECTION_STATUS: Record<ConnectionState, Status> = {
  connecting: 'unknown',
  live: 'ok',
  stale: 'warn',
  disconnected: 'critical',
};

/** The hostname lives in the uptime collector's meta; fall back gracefully. */
function hostnameFromMeta(meta: Meta | null): string | null {
  if (!meta?.collectors) return null;
  const direct = meta.collectors.uptime?.hostname;
  if (typeof direct === 'string' && direct.trim() !== '') return direct;
  for (const entry of Object.values(meta.collectors)) {
    const candidate = entry?.hostname;
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}

function kernelFromMeta(meta: Meta | null): string | null {
  const kernel = meta?.collectors?.uptime?.kernel;
  return typeof kernel === 'string' && kernel.trim() !== '' ? kernel : null;
}

function LoadingSkeleton() {
  return (
    <div className="grid" aria-busy="true" aria-label="Loading dashboard">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="card card--skeleton" key={index}>
          <div className="skeleton skeleton--title" />
          <div className="skeleton skeleton--line" />
          <div className="skeleton skeleton--line" />
          <div className="skeleton skeleton--line skeleton--short" />
        </div>
      ))}
    </div>
  );
}

function FatalError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="fatal" role="alert">
      <span className="fatal__icon" aria-hidden="true">
        <Activity size={28} />
      </span>
      <h2 className="fatal__title">Cannot reach the dashboard backend</h2>
      <p className="fatal__body">
        The first request to <code>/api/snapshot</code> failed, so there is nothing to show. The
        backend may not be running.
      </p>
      <code className="fatal__message">{message}</code>
      <button type="button" className="btn btn--primary" onClick={onRetry}>
        <RefreshCw size={14} aria-hidden="true" />
        Try again
      </button>
    </div>
  );
}

function byExplicitOrder(order: readonly string[]) {
  const rank = (name: string) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  return (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * Applies the user's layout preferences to the registry's default order.
 *
 * Pins come first, in the order they were pinned, then everything else in
 * either the user's explicit order or the registry default. Hidden collectors
 * are dropped — except a *critical* one, because a dashboard that conceals a
 * fire in order to honour a preference is worse than one with no preferences
 * at all.
 */
function arrangeCollectors(
  names: readonly string[],
  pinned: readonly string[],
  hidden: readonly string[],
  order: readonly string[],
  critical: ReadonlySet<string>,
): string[] {
  const visible = names.filter((name) => !hidden.includes(name) || critical.has(name));
  const base =
    order.length > 0 ? [...visible].sort(byExplicitOrder(order)) : orderCollectors(visible);
  const isPinned = (name: string) => pinned.includes(name);
  return [
    ...base.filter(isPinned).sort((a, b) => pinned.indexOf(a) - pinned.indexOf(b)),
    ...base.filter((name) => !isPinned(name)),
  ];
}

export function App() {
  const {
    snapshot,
    meta,
    connection,
    error,
    initialLoadFailed,
    secondsSinceUpdate,
    consecutiveFailures,
    refreshSeconds,
    setRefreshSeconds,
    refresh,
    isFetching,
    paused,
  } = useSnapshot();

  const { prefs, theme, density, dimmed, setTheme, setDensity, update, resetLayout, cycleTheme } =
    usePreferences();

  const hostname = hostnameFromMeta(meta);
  const kernel = kernelFromMeta(meta);
  const gridRef = useMasonry<HTMLDivElement>();

  const [detail, setDetail] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [entering, setEntering] = useState(true);

  const [fullscreen, toggleFullscreen] = useFullscreen();
  const wakeHeld = useWakeLock(fullscreen);
  const chromeHidden = useIdleChrome(prefs.autoHideChrome && !detail && !showShortcuts);
  const scrolled = useScrolled();

  // Polled whatever the drawer is doing: cards show when they last changed,
  // which is only useful if the log is already there when a card is read.
  const { events } = useEvents(true);
  const latestEvents = useLatestEvents(events);

  const highlightTimer = useRef(0);

  useEffect(() => {
    document.title = hostname ? `${hostname} · Homelab Dashboard` : 'Homelab Dashboard';
  }, [hostname]);

  // The entrance animation plays once. Leaving the class on would replay it
  // every time the collector list changed, which on a wall panel reads as a
  // glitch rather than a flourish.
  useEffect(() => {
    if (!snapshot) return;
    const timer = window.setTimeout(() => setEntering(false), 1200);
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  const focusCard = useCallback((name: string) => {
    document.getElementById(`card-${name}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
    setHighlighted(name);
    window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlighted(null), 1600);
  }, []);

  useEffect(() => () => window.clearTimeout(highlightTimer.current), []);

  const dashboardApi = useMemo<DashboardApi>(
    () => ({ openDetail: setDetail, highlighted, focusCard }),
    [focusCard, highlighted],
  );

  const criticalNames = useMemo(() => {
    const set = new Set<string>();
    for (const [name, result] of Object.entries(snapshot?.collectors ?? {})) {
      if (result?.status === 'critical') set.add(name);
    }
    return set;
  }, [snapshot]);

  const names = useMemo(
    () =>
      arrangeCollectors(
        Object.keys(snapshot?.collectors ?? {}),
        prefs.pinned,
        prefs.hidden,
        prefs.order,
        criticalNames,
      ),
    [criticalNames, prefs.hidden, prefs.order, prefs.pinned, snapshot],
  );

  const overall: Status = snapshot?.overall_status ?? 'unknown';
  const live = connection === 'live';

  /* ------------------------------ shortcuts ------------------------------ */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // Never steal a keystroke from something the user is typing into.
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      switch (event.key) {
        case 'r':
          event.preventDefault();
          refresh();
          break;
        case 't':
          event.preventDefault();
          cycleTheme();
          break;
        case 'f':
          event.preventDefault();
          toggleFullscreen();
          break;
        case 'd':
          event.preventDefault();
          setDensity(
            density === 'compact'
              ? 'comfortable'
              : density === 'comfortable'
                ? 'ambient'
                : 'compact',
          );
          break;
        case 'e':
          event.preventDefault();
          setShowEvents((open) => !open);
          break;
        case '?':
          event.preventDefault();
          setShowShortcuts((open) => !open);
          break;
        case 'Escape':
          setShowShortcuts(false);
          setShowEvents(false);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cycleTheme, density, refresh, setDensity, toggleFullscreen]);

  /* ------------------------------- menus -------------------------------- */

  const settingsItems = useMemo<readonly (MenuItem | 'separator')[]>(() => {
    const check = (active: boolean) => (active ? '✓' : undefined);
    return [
      {
        id: 'theme-auto',
        label: 'Theme: match system',
        icon: SunMoon,
        hint: check(prefs.theme === 'auto'),
        onSelect: () => setTheme('auto'),
      },
      {
        id: 'theme-dark',
        label: 'Theme: dark',
        icon: Moon,
        hint: check(prefs.theme === 'dark'),
        onSelect: () => setTheme('dark'),
      },
      {
        id: 'theme-light',
        label: 'Theme: light',
        icon: Sun,
        hint: check(prefs.theme === 'light'),
        onSelect: () => setTheme('light'),
      },
      'separator',
      {
        id: 'density-auto',
        label: 'Density: automatic',
        icon: Rows3,
        hint: check(prefs.density === 'auto'),
        onSelect: () => setDensity('auto'),
      },
      {
        id: 'density-compact',
        label: 'Density: compact',
        icon: Rows3,
        hint: check(prefs.density === 'compact'),
        onSelect: () => setDensity('compact'),
      },
      {
        id: 'density-comfortable',
        label: 'Density: comfortable',
        icon: Rows3,
        hint: check(prefs.density === 'comfortable'),
        onSelect: () => setDensity('comfortable'),
      },
      {
        id: 'density-ambient',
        label: 'Density: ambient (wall)',
        icon: LayoutGrid,
        hint: check(prefs.density === 'ambient'),
        onSelect: () => setDensity('ambient'),
      },
      'separator',
      {
        id: 'night-dim',
        label: 'Dim at night',
        icon: Moon,
        hint: prefs.nightDim ? `${prefs.nightFrom}:00–${prefs.nightTo}:00` : 'off',
        onSelect: () => update({ nightDim: !prefs.nightDim }),
      },
      {
        id: 'burn-in',
        label: 'Burn-in guard',
        icon: Contrast,
        hint: prefs.burnInGuard ? 'on' : 'off',
        onSelect: () => update({ burnInGuard: !prefs.burnInGuard }),
      },
      {
        id: 'auto-hide',
        label: 'Hide chrome when idle',
        icon: Minimize,
        hint: prefs.autoHideChrome ? 'on' : 'off',
        onSelect: () => update({ autoHideChrome: !prefs.autoHideChrome }),
      },
      'separator',
      {
        id: 'reset-layout',
        label: 'Reset layout',
        icon: RotateCcw,
        disabled: prefs.pinned.length + prefs.hidden.length + prefs.order.length === 0,
        onSelect: resetLayout,
      },
    ];
  }, [prefs, resetLayout, setDensity, setTheme, update]);

  const appClasses = ['app', `app--${connection}`, chromeHidden ? 'app--chrome-hidden' : null]
    .filter(Boolean)
    .join(' ');

  return (
    <MetaContext.Provider value={meta}>
      <DashboardContext.Provider value={dashboardApi}>
        <EventsContext.Provider value={latestEvents}>
        <div className={appClasses} data-burn-in={prefs.burnInGuard ? 'on' : undefined}>
          <a className="skip-link" href="#content">
            Skip to dashboard
          </a>

          <header className={scrolled ? 'topbar topbar--condensed' : 'topbar'}>
            <div className="topbar__identity">
              <span className="topbar__mark" data-status={overall} aria-hidden="true">
                <StatusGlyph status={overall} size={20} strokeWidth={2.25} />
              </span>
              <div className="topbar__names">
                <h1 className="topbar__host">{hostname ?? 'Homelab Dashboard'}</h1>
                <p className="topbar__sub">
                  {kernel ? <span className="t-ident">{kernel}</span> : null}
                  {names.length > 0 ? (
                    <span>
                      {names.length} collector{names.length === 1 ? '' : 's'}
                    </span>
                  ) : null}
                  {wakeHeld ? <span>screen held awake</span> : null}
                </p>
              </div>
            </div>

            <div className="topbar__state">
              <span
                className={live ? 'conn conn--live' : 'conn'}
                data-status={CONNECTION_STATUS[connection]}
                title={
                  error
                    ? `${consecutiveFailures} failed poll${
                        consecutiveFailures === 1 ? '' : 's'
                      }: ${error}`
                    : 'Receiving updates'
                }
              >
                <span className="conn__dot" aria-hidden="true" />
                {CONNECTION_LABELS[connection]}
              </span>
              <span className={live ? 'topbar__age' : 'topbar__age topbar__age--warn'}>
                {secondsSinceUpdate === null
                  ? 'no data yet'
                  : `updated ${formatAge(secondsSinceUpdate)} ago`}
              </span>
            </div>

            <div className="topbar__controls">
              <label className="segmented" title="Snapshot cadence">
                <span className="sr-only">Refresh interval</span>
                <select
                  className="segmented__select"
                  value={refreshSeconds}
                  onChange={(event) => setRefreshSeconds(Number(event.target.value))}
                >
                  {REFRESH_CHOICES.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}s
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className="btn btn--icon"
                onClick={refresh}
                disabled={isFetching}
                title="Fetch a new snapshot now (R)"
              >
                <RefreshCw size={15} className={isFetching ? 'spin' : undefined} />
                <span className="sr-only">Refresh</span>
              </button>

              <button
                type="button"
                className="btn btn--icon"
                onClick={toggleFullscreen}
                title={fullscreen ? 'Leave fullscreen (F)' : 'Fullscreen kiosk mode (F)'}
              >
                {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
                <span className="sr-only">{fullscreen ? 'Leave fullscreen' : 'Fullscreen'}</span>
              </button>

              <Menu
                items={settingsItems}
                label="Display settings"
                icon={Settings2}
                triggerClassName="btn btn--icon"
              />
            </div>
          </header>

          {paused ? (
            <p className="banner banner--muted">Polling paused — this tab is in the background.</p>
          ) : null}

          {!initialLoadFailed && error && snapshot ? (
            <p className="banner banner--warn" role="status">
              Showing the last known values from {formatAge(secondsSinceUpdate)} ago —{' '}
              {consecutiveFailures} failed poll{consecutiveFailures === 1 ? '' : 's'}: {error}
            </p>
          ) : null}

          <main className="content" id="content">
            {initialLoadFailed ? (
              <FatalError message={error ?? 'Unknown error'} onRetry={refresh} />
            ) : !snapshot ? (
              <LoadingSkeleton />
            ) : names.length === 0 ? (
              <p className="banner banner--muted">
                The backend reported no collectors. Check the service logs and{' '}
                <code>config.toml</code>.
              </p>
            ) : (
              <>
                <SummaryBar
                  snapshot={snapshot}
                  overall={overall}
                  refreshSeconds={refreshSeconds}
                  windowSeconds={meta?.ui?.history_window_seconds}
                />

                <AttentionStrip snapshot={snapshot} titles={meta?.titles} />

                <div className={entering ? 'grid grid--entering' : 'grid'} ref={gridRef}>
                  {names.map((name, index) => {
                    const result = snapshot.collectors[name];
                    if (!result) return null;
                    const Bespoke = cardFor(name);
                    const collectorMeta = meta?.collectors?.[name];
                    // `--enter-index` staggers the entrance animation; the
                    // wrapper exists so masonry can size a slot per card.
                    const style = { '--enter-index': index } as CSSProperties;
                    return (
                      <div className="grid__slot" style={style} key={name}>
                        {Bespoke ? (
                          <Bespoke
                            result={result}
                            meta={collectorMeta}
                            refreshSeconds={refreshSeconds}
                          />
                        ) : (
                          <GenericCard
                            result={result}
                            meta={collectorMeta}
                            refreshSeconds={refreshSeconds}
                            title={meta?.titles?.[name]}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </main>

          <footer className="pagefoot">
            <span>
              Snapshot cadence {refreshSeconds}s
              {meta?.ui?.history_window_seconds
                ? ` · history window ${formatAge(meta.ui.history_window_seconds)}`
                : ''}
              {dimmed ? ' · night dim active' : ''}
              {` · ${theme} · ${density}`}
            </span>
            <span className="pagefoot__hint">
              <button type="button" className="btn btn--subtle" onClick={() => setShowEvents(true)}>
                Recent changes
              </button>
              <button
                type="button"
                className="btn btn--subtle"
                onClick={() => setShowShortcuts(true)}
              >
                Shortcuts <kbd className="kbd">?</kbd>
              </button>
            </span>
          </footer>

          <DetailSheet
            name={detail}
            result={detail ? (snapshot?.collectors[detail] ?? null) : null}
            title={detail ? (meta?.titles?.[detail] ?? detail) : ''}
            refreshSeconds={refreshSeconds}
            windowSeconds={meta?.ui?.history_window_seconds}
            onClose={() => setDetail(null)}
          />

          <EventDrawer open={showEvents} onClose={() => setShowEvents(false)} />
          <ShortcutsOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} />
          <Toasts snapshot={snapshot} titles={meta?.titles} />
        </div>
        </EventsContext.Provider>
      </DashboardContext.Provider>
    </MetaContext.Provider>
  );
}

export default App;
