import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';

import './menu.css';

export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Shown right-aligned: a shortcut hint or the current value. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuProps {
  items: readonly (MenuItem | 'separator')[];
  /** Accessible name for the trigger button. */
  label: string;
  /** Trigger icon; defaults to the standard overflow glyph. */
  icon?: LucideIcon;
  align?: 'start' | 'end';
  triggerClassName?: string;
  children?: ReactNode;
}

function isItem(entry: MenuItem | 'separator'): entry is MenuItem {
  return entry !== 'separator';
}

/**
 * A small overflow menu with full keyboard support.
 *
 * Hand-rolled rather than pulled from a headless-UI package: the behaviour
 * needed here is narrow (open, roving focus, Escape, click-away, select) and a
 * dependency would cost more than it saves. The pattern follows the WAI-ARIA
 * menu button: `aria-haspopup`/`aria-expanded` on the trigger, `role="menu"`
 * on the list, arrow keys moving a roving `tabindex`.
 */
export function Menu({
  items,
  label,
  icon: Icon = MoreHorizontal,
  align = 'end',
  triggerClassName,
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const selectable = items.filter(isItem).filter((item) => !item.disabled);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Close on click-away and on Escape, from anywhere in the document: a menu
  // left open behind a modal or after a background refresh is a trap.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const first = listRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
    setActive(0);
  }, [open]);

  const move = (delta: number) => {
    const next = (active + delta + selectable.length) % selectable.length;
    setActive(next);
    const nodes = listRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    );
    nodes?.[next]?.focus();
  };

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={['btn', 'btn--icon', 'menu__trigger', triggerClassName]
          .filter(Boolean)
          .join(' ')}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children ?? <Icon size={16} aria-hidden="true" />}
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          ref={listRef}
          className={`menu__list menu__list--${align}`}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              move(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              move(-1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              move(-active);
            } else if (event.key === 'End') {
              event.preventDefault();
              move(selectable.length - 1 - active);
            } else if (event.key === 'Tab') {
              setOpen(false);
            }
          }}
        >
          {items.map((entry, index) =>
            entry === 'separator' ? (
              // eslint-disable-next-line react/no-array-index-key -- separators have no identity
              <div className="menu__separator" role="separator" key={`sep-${index}`} />
            ) : (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={entry.disabled}
                className={`menu__item${entry.danger ? ' menu__item--danger' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  entry.onSelect();
                  close();
                }}
              >
                {entry.icon ? <entry.icon size={15} aria-hidden="true" /> : null}
                <span className="menu__item-label">{entry.label}</span>
                {entry.hint ? <span className="menu__item-hint">{entry.hint}</span> : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

export default Menu;
