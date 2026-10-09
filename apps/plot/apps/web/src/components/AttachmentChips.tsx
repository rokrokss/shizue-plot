'use client';

import { useTranslations } from 'next-intl';
import type { AttachmentChip } from '@/lib/attachments';
import { Spinner, cx } from './ui';

/**
 * The images waiting to be sent, above the composer.
 *
 * A chip is a thumbnail of the file the reader picked — drawn from the local
 * object URL, so it is on screen before the upload starts — with the upload's
 * state over it: a spinner while it is in flight, a retry once it has failed.
 * Removing one is always available, including while it uploads.
 */
export function AttachmentChips({
  chips,
  onRemove,
  onRetry,
}: {
  chips: AttachmentChip[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  if (chips.length === 0) return null;

  return (
    <div data-testid="attachment-chips" className="flex flex-wrap gap-2 px-5 pt-3">
      {chips.map((chip) => (
        <div
          key={chip.key}
          title={chip.name}
          className={cx(
            'relative size-16 overflow-hidden rounded-lg border bg-surface',
            chip.status === 'failed' ? 'border-danger/50' : 'border-line',
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={chip.preview}
            alt=""
            className={cx(
              'size-full object-cover transition-opacity',
              chip.status === 'done' ? 'opacity-100' : 'opacity-40',
            )}
          />
          {chip.status === 'uploading' ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <Spinner label={t('attachUploading')} />
            </span>
          ) : null}
          {chip.status === 'failed' ? (
            <button
              type="button"
              title={t('attachFailed')}
              onClick={() => onRetry(chip.key)}
              className="absolute inset-0 flex items-center justify-center bg-canvas/70 text-[11px] text-danger hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {common('retry')}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t('attachRemove')}
            title={t('attachRemove')}
            onClick={() => onRemove(chip.key)}
            className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full border border-line bg-canvas/85 text-[10px] text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
