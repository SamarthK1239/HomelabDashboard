import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

import './shortcuts-overlay.css';

export interface ShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS: readonly { keys: readonly string[]; label: string }[] = [
  { keys: ['R'], label: 'Refresh the snapshot now' },
  { keys: ['T'], label: 'Cycle theme: system → dark → light' },
  { keys: ['D'], label: 'Cycle density: compact → comfortable → ambient' },
  { keys: ['F'], label: 'Fullscreen kiosk mode' },
  { keys: ['E'], label: 'Recent status changes' },
  { keys: ['?'], label: 'This help' },
  { keys: ['Esc'], label: 'Close any panel' },
];

/** A plain list of what the keyboard does. Discoverability, not decoration. */
export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="shortcuts"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      aria-label="Keyboard shortcuts"
    >
      <div className="shortcuts__panel">
        <header className="shortcuts__head">
          <h2 className="shortcuts__title">Keyboard shortcuts</h2>
          <button type="button" className="btn btn--icon" onClick={onClose} title="Close (Esc)">
            <X size={16} />
            <span className="sr-only">Close</span>
          </button>
        </header>
        <dl className="shortcuts__list">
          {SHORTCUTS.map((shortcut) => (
            <div className="shortcuts__row" key={shortcut.label}>
              <dt className="shortcuts__keys">
                {shortcut.keys.map((key) => (
                  <kbd className="kbd" key={key}>
                    {key}
                  </kbd>
                ))}
              </dt>
              <dd className="shortcuts__label">{shortcut.label}</dd>
            </div>
          ))}
        </dl>
        <p className="shortcuts__note">
          Cards can also be pinned, hidden or expanded from their ⋯ menu. Layout, theme and density
          are stored in this browser only — the backend stays read-only.
        </p>
      </div>
    </dialog>
  );
}

export default ShortcutsOverlay;
