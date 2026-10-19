import { useEffect, useMemo } from 'react';

import { GenericCard } from './components/GenericCard';
import { StatusBadge } from './components/StatusBadge';
import { cardFor, orderCollectors } from './components/cards/registry';
import { formatAge } from './format';
import { REFRESH_CHOICES, useSnapshot } from './hooks/useSnapshot';
import { MetaContext } from './MetaContext';
import type { ConnectionState, Meta, Status } from './types';

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  stale: 'Stale',
  disconnected: 'Disconnected',
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
      <h2 className="fatal__title">Cannot reach the dashboard backend</h2>
      <p className="fatal__body">
        The first request to <code>/api/snapshot</code> failed, so there is nothing to show. The
        backend may not be running.
      </p>
      <code className="fatal__message">{message}</code>
      <button type="button" className="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
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

  const hostname = hostnameFromMeta(meta);
  const kernel = kernelFromMeta(meta);

  useEffect(() => {
    document.title = hostname ? `${hostname} · Homelab Dashboard` : 'Homelab Dashboard';
  }, [hostname]);

  const names = useMemo(() => orderCollectors(Object.keys(snapshot?.collectors ?? {})), [snapshot]);

  const overall: Status = snapshot?.overall_status ?? 'unknown';
  const live = connection === 'live';

  return (
    <MetaContext.Provider value={meta}>
      <div className={`app app--${connection}`}>
        <header className="topbar">
          <div className="topbar__identity">
            <h1 className="topbar__host">{hostname ?? 'Homelab Dashboard'}</h1>
            <p className="topbar__sub">
              {kernel ? <span className="topbar__kernel">{kernel}</span> : null}
              {names.length > 0 ? (
                <span>
                  {names.length} collector{names.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </p>
          </div>

          <div className="topbar__state">
            <StatusBadge status={overall} size="md" label={`System ${overall}`} />
            <StatusBadge
              status={CONNECTION_STATUS[connection]}
              size="md"
              label={CONNECTION_LABELS[connection]}
              title={
                error
                  ? `${consecutiveFailures} failed poll${consecutiveFailures === 1 ? '' : 's'}: ${error}`
                  : 'Receiving updates'
              }
              className={live ? 'status-badge--pulse' : undefined}
            />
            <span className={live ? 'topbar__age' : 'topbar__age topbar__age--warn'}>
              {secondsSinceUpdate === null
                ? 'no data yet'
                : `updated ${formatAge(secondsSinceUpdate)} ago`}
            </span>
          </div>

          <div className="topbar__controls">
            <label className="field">
              <span className="field__label">Refresh</span>
              <select
                className="select"
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
              className="button"
              onClick={refresh}
              disabled={isFetching}
              title="Fetch a new snapshot now"
            >
              {isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
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

        <main className="content">
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
            <div className="grid">
              {names.map((name) => {
                const result = snapshot.collectors[name];
                if (!result) return null;
                const Bespoke = cardFor(name);
                const collectorMeta = meta?.collectors?.[name];
                if (Bespoke) {
                  return (
                    <Bespoke
                      key={name}
                      result={result}
                      meta={collectorMeta}
                      refreshSeconds={refreshSeconds}
                    />
                  );
                }
                return (
                  <GenericCard
                    key={name}
                    result={result}
                    meta={collectorMeta}
                    refreshSeconds={refreshSeconds}
                    title={meta?.titles?.[name]}
                  />
                );
              })}
            </div>
          )}
        </main>

        <footer className="pagefoot">
          <span>
            Snapshot cadence {refreshSeconds}s
            {meta?.ui?.history_window_seconds
              ? ` · history window ${formatAge(meta.ui.history_window_seconds)}`
              : ''}
          </span>
        </footer>
      </div>
    </MetaContext.Provider>
  );
}

export default App;
