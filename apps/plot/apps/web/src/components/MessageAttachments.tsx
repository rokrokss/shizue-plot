'use client';

import { assetSrc } from '@/lib/assets';
import type { ChatAttachment } from '@/lib/types';
import { ChatImage } from './ChatImage';
import { cx } from './ui';

/**
 * The images a turn was sent with, above its text.
 *
 * One fills the bubble; two or more go into a pair of columns, which is what
 * keeps four pictures from turning one turn into a page of scrolling. Each is a
 * `ChatImage`, so the box is reserved from the measurement the composer took and
 * a click opens the same lightbox the message's own images open in — and
 * `data-image-group` is what makes the set of them one group to walk through.
 */
export function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div
      data-image-group=""
      data-testid="message-attachments"
      className={cx('mb-1.5 grid gap-1.5', attachments.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}
    >
      {attachments.map((attachment) => (
        // No alt text to give: the reader attached their own picture and never
        // described it, and inventing a description would be worse than none.
        <ChatImage key={attachment.id} src={assetSrc(attachment)} alt="" />
      ))}
    </div>
  );
}
