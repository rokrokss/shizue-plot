'use client';

import { useTranslations } from 'next-intl';
import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { Button } from './ui';

/**
 * A panel that comes up from the bottom edge, for the controls a narrow screen
 * has no room to keep in view. Mounted only while it is open, so the portal
 * always has a body to go into, and modal in the same way the lightbox is: the
 * backdrop closes it, Escape closes it, and Tab stays inside it.
 *
 * The bottom padding clears the phone's home indicator; the height is capped so
 * a long panel scrolls rather than covering the whole conversation.
 */
export function BottomSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const common = useTranslations('common');
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, onClose);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-fg/35 backdrop-blur-sm"
      // The backdrop is everything the sheet is not; a click in it closes.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="bottom-sheet"
        tabIndex={-1}
        className="max-h-[80dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-line bg-raised px-5 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] focus:outline-none"
      >
        <div className="flex items-center justify-between gap-3 pb-4">
          <h2 className="text-sm font-medium text-fg">{title}</h2>
          <Button size="sm" variant="ghost" aria-label={common('close')} onClick={onClose}>
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
