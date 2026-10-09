'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { assetHref } from '@/lib/assets';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { Button } from './ui';

export interface LightboxImage {
  src: string;
  alt: string;
}

/** The two arrows; only the side differs. */
const ARROW =
  'absolute top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full ' +
  'border border-line bg-surface/95 text-xl leading-none text-fg backdrop-blur transition-colors ' +
  'hover:border-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * A message's images, full size, over the chat.
 *
 * Mounted only once an image is clicked, so it is always in the browser and the
 * portal always has a body to go into. A message with more than one image is
 * walked either way: the arrow keys, or the pair of buttons over the image —
 * which are part of the panel's own focus cycle like everything else in it.
 */
export function Lightbox({
  images,
  index,
  onClose,
}: {
  images: LightboxImage[];
  /** Which image was clicked. */
  index: number;
  onClose: () => void;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const [at, setAt] = useState(index);
  const panel = useRef<HTMLDivElement>(null);

  // Escape, Tab and the focus that moves in on open and back out on close.
  useFocusTrap(panel, onClose);

  /** One image either way, wrapping at both ends. */
  const step = useCallback(
    (by: -1 | 1): void => setAt((current) => (current + by + images.length) % images.length),
    [images.length],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (images.length < 2) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        step(event.key === 'ArrowLeft' ? -1 : 1);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [images.length, step]);

  const current = images[at];
  if (!current) return null;

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={current.alt}
      data-testid="lightbox"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col overscroll-contain bg-canvas/95 focus:outline-none"
      // The backdrop is everything the panel is not; a click inside it closes.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex items-center justify-end gap-3 p-3">
        {images.length > 1 ? (
          <span className="mr-auto pl-1 text-xs text-muted tabular-nums">
            {at + 1} / {images.length}
          </span>
        ) : null}
        <a
          href={assetHref(current.src)}
          download
          className="rounded-full border border-line px-3 py-1.5 text-xs text-fg transition-colors hover:border-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {t('download')}
        </a>
        <Button size="sm" variant="ghost" aria-label={common('close')} onClick={onClose}>
          ✕
        </Button>
      </div>
      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {/* Over the image rather than beside it: on a phone the image is as wide
            as the panel, and there is no room for a column on either side. */}
        {images.length > 1 ? (
          <>
            <button
              type="button"
              aria-label={t('imagePrev')}
              onClick={() => step(-1)}
              className={ARROW + ' left-3'}
            >
              <span aria-hidden="true">‹</span>
            </button>
            <button
              type="button"
              aria-label={t('imageNext')}
              onClick={() => step(1)}
              className={ARROW + ' right-3'}
            >
              <span aria-hidden="true">›</span>
            </button>
          </>
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={current.src} alt={current.alt} className="max-h-full max-w-full object-contain" />
      </div>
    </div>,
    document.body,
  );
}
