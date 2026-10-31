import { useEffect, useRef } from 'react';
import { ArrowRight, X } from 'lucide-react';

import { useDashboard } from '../DashboardContext';
import { formatAge, humanizeKey } from '../format';
import { useEvents } from '../hooks/useEvents';
import { StatusBadge } from './StatusBadge';
import { CollectorIcon } from './icons';
import './event-drawer.css';

export interface EventDrawerProps {
  open: boolean;
  onClose: () => void;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * "What changed?" — the question a status light can never answer.
 *
 * Every row is one collector crossing a status boundary, newest first, with
 * the time it happened and the error that accompanied it. Clicking a row jumps
 * to that collector's card.
 */
export function EventDrawer({ open, onClose }: EventDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const { events, error } = useEvents(open);
  const { focusCard } = useDashboard();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const now = Date.now() / 1000;

  return (
    <dialog
      ref={dialogRef}
      className="drawer"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      aria-label="Recent status changes"
    >
      <div className="drawer__panel">
        <header className="drawer__head">
          <h2 className="drawer__title">Recent changes</h2>
          <button type="button" className="btn btn--icon" onClick={onClose} title="Close (Esc)">
            <X size={16} />
            <span className="sr-only">Close</span>
          </button>
        </header>

        <div className="drawer__body">
          {error ? (
            <p className="drawer__empty" role="alert">
              Could not load the event log: {error}
            </p>
          ) : events.length === 0 ? (
            <p className="drawer__empty">
              Nothing has changed status since the backend started. That is the good outcome.
            </p>
          ) : (
            <ol className="drawer__list">
              {events.map((event, index) => {
                return (
                  <li className="drawer__item" data-status={event.to} key={`${event.timestamp}-${index}`}>
                    <button
                      type="button"
                      className="drawer__row"
                      onClick={() => {
                        onClose();
                        focusCard(event.collector);
                      }}
                    >
                      <span className="drawer__when">
                        <span className="t-numeric">
                          {timeFormatter.format(event.timestamp * 1000)}
                        </span>
                        <span className="drawer__ago">
                          {formatAge(Math.max(0, now - event.timestamp))} ago
                        </span>
                      </span>
                      <span className="drawer__what">
                        <span className="drawer__collector">
                          <CollectorIcon name={event.collector} size={13} />
                          {humanizeKey(event.collector)}
                        </span>
                        <span className="drawer__transition">
                          <StatusBadge status={event.from} size="sm" variant="bare" />
                          <ArrowRight size={12} aria-hidden="true" />
                          <StatusBadge status={event.to} size="sm" />
                        </span>
                        {event.error ? (
                          <span className="drawer__reason t-ident">{event.error}</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </dialog>
  );
}

export default EventDrawer;
