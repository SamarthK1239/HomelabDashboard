import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

import { useDashboard } from '../DashboardContext';
import { STATUS_SEVERITY, type Snapshot, type Status } from '../types';
import { StatusGlyph } from './icons';
import './toasts.css';

interface Toast {
  id: number;
  collector: string;
  title: string;
  from: Status;
  to: Status;
  detail: string | null;
}

/** How long a toast stays before it dismisses itself. */
const DWELL_MS = 14_000;

/**
 * Announces deteriorations as they happen.
 *
 * On a wall-mounted panel nobody is watching the moment a collector turns
 * critical; they walk past some minutes later and see a red card with no
 * indication of when it went red. A toast makes the *transition* visible for a
 * while, and `role="alert"` means a screen reader hears it immediately.
 *
 * Only deteriorations are announced. Recoveries are good news and good news
 * does not need to interrupt anyone — it is visible in the summary bar and in
 * the event drawer.
 */
export function Toasts({ snapshot, titles }: { snapshot: Snapshot | null; titles?: Record<string, string> }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const previous = useRef<Record<string, Status> | null>(null);
  const nextId = useRef(1);
  const { focusCard } = useDashboard();

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const current: Record<string, Status> = {};
    for (const [name, result] of Object.entries(snapshot.collectors)) {
      current[name] = result.status;
    }

    const before = previous.current;
    previous.current = current;
    // The first snapshot establishes a baseline. Announcing it would fire a
    // toast for every already-degraded collector on every page load.
    if (!before) return;

    const fresh: Toast[] = [];
    for (const [name, status] of Object.entries(current)) {
      const was = before[name];
      if (was === undefined || was === status) continue;
      if (STATUS_SEVERITY[status] <= STATUS_SEVERITY[was]) continue;
      if (status !== 'warn' && status !== 'critical') continue;
      fresh.push({
        id: nextId.current++,
        collector: name,
        title: titles?.[name] ?? name,
        from: was,
        to: status,
        detail: snapshot.collectors[name]?.error ?? null,
      });
    }
    if (fresh.length > 0) {
      // Newest first, and never more than three stacked: a wall of toasts is
      // just a differently shaped wall of red.
      setToasts((existing) => [...fresh, ...existing].slice(0, 3));
    }
  }, [snapshot, titles]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) =>
      window.setTimeout(() => dismiss(toast.id), DWELL_MS),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [dismiss, toasts]);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="region" aria-label="Status alerts">
      {toasts.map((toast) => (
        <div className="toast" data-status={toast.to} key={toast.id} role="alert">
          <span className="toast__glyph">
            <StatusGlyph status={toast.to} size={18} strokeWidth={2.25} />
          </span>
          <div className="toast__body">
            <p className="toast__title">
              {toast.title} is now {toast.to}
            </p>
            {toast.detail ? <p className="toast__detail t-ident">{toast.detail}</p> : null}
            <button
              type="button"
              className="toast__link"
              onClick={() => {
                focusCard(toast.collector);
                dismiss(toast.id);
              }}
            >
              Show the card
            </button>
          </div>
          <button
            type="button"
            className="toast__close"
            onClick={() => dismiss(toast.id)}
            title="Dismiss"
          >
            <X size={14} />
            <span className="sr-only">Dismiss</span>
          </button>
        </div>
      ))}
    </div>
  );
}

export default Toasts;
