'use client';

import { useEffect, type RefObject } from 'react';

/** Everything inside a panel that the Tab key is allowed to stand on. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The keyboard half of what `aria-modal` promises: while the panel is open, Tab
 * cycles its own controls and never reaches the page behind it, Escape closes,
 * focus moves in on open and goes back where it came from on close — a reader
 * who opened the panel with the keyboard is left standing where they were.
 *
 * The panel element has to be focusable itself (`tabIndex={-1}`), because on open
 * it is what takes the focus.
 */
export function useFocusTrap(panel: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const returnTo = document.activeElement;
    panel.current?.focus();
    return () => {
      if (returnTo instanceof HTMLElement) returnTo.focus();
    };
  }, [panel]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (active instanceof Node && !panel.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [panel, onClose]);
}
