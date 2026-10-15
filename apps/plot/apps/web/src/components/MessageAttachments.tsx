'use client';

import { useTranslations } from 'next-intl';
import { assetSrc } from '@/lib/assets';
import type { ChatAttachment } from '@/lib/types';
import { ChatImage } from './ChatImage';
import { Icon } from './Icon';
import { cx } from './ui';

const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** A SillyTavern file a message came with (`text/plain`, under its own name), not a picture. */
const isFile = (attachment: ChatAttachment): boolean => attachment.mime === 'text/plain';

/**
 * The images a turn was sent with, above its text.
 *
 * One fills the bubble; two or more go into a pair of columns, which is what
 * keeps four pictures from turning one turn into a page of scrolling. Each is a
 * `ChatImage`, so the box is reserved from the measurement the composer took and
 * a click opens the same lightbox the message's own images open in — and
 * `data-image-group` is what makes the set of them one group to walk through.
 *
 * A file a SillyTavern message brought — its text, which the prompt reads ahead
 * of the message — is a chip with its name that opens the text, as ST lists a
 * message's files above it.
 */
export function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  const t = useTranslations('chat');
  const pictures = attachments.filter((attachment) => !isFile(attachment));
  const files = attachments.filter(isFile);
  if (attachments.length === 0) return null;
  return (
    <div className="mb-1.5 space-y-1.5">
      {files.length > 0 ? (
        <div data-testid="message-files" className="flex flex-wrap gap-1.5">
          {files.map((file) => (
            <a
              key={file.id}
              href={file.url}
              target="_blank"
              rel="noopener"
              aria-label={t('openAttachedFile', { name: file.name ?? '' })}
              className={cx(
                'inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs text-fg hover:bg-raised',
                FOCUS_RING,
              )}
            >
              <Icon name="attach" width={14} height={14} className="shrink-0 text-muted" />
              <span className="truncate">{file.name}</span>
            </a>
          ))}
        </div>
      ) : null}
      {pictures.length > 0 ? (
        <div
          data-image-group=""
          data-testid="message-attachments"
          className={cx('grid gap-1.5', pictures.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}
        >
          {pictures.map((attachment) => (
            // No alt text to give: the reader attached their own picture and never
            // described it, and inventing a description would be worse than none.
            <ChatImage key={attachment.id} src={assetSrc(attachment)} alt="" />
          ))}
        </div>
      ) : null}
    </div>
  );
}
