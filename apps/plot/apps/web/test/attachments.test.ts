/**
 * The composer's thumbnail strip, as a state machine.
 *
 * Every rule the reader can run into lives here — four at a time, 8MB each, and
 * nothing sent while one is still going up — so the page only has to wire it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptFiles,
  isUploading,
  markFailed,
  markRetrying,
  markUploaded,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_MB,
  removeChip,
  uploadedIds,
  type AttachmentChip,
} from '../src/lib/attachments';
import type { ChatAttachment } from '../src/lib/types';

/** Object URLs are the browser's; the strip only ever holds and revokes them. */
const created: string[] = [];
beforeEach(() => {
  created.length = 0;
  let next = 0;
  vi.stubGlobal('URL', {
    createObjectURL: () => {
      const url = `blob:${(next += 1)}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: () => undefined,
  });
});

const image = (name: string, bytes = 10, type = 'image/png'): File =>
  new File([new Uint8Array(bytes)], name, { type });

let keys = 0;
const makeKey = (): string => `k${(keys += 1)}`;

const stored = (id: string): ChatAttachment => ({
  id,
  url: `/api/chats/c1/attachments/${id}`,
  mime: 'image/png',
  width: 800,
  height: 600,
  thumbhash: 'HBkSHYSIeHiPiHh8eJd4h4eAeIhw==',
});

describe('acceptFiles', () => {
  it('takes images, in the order they were picked, each waiting to go up', () => {
    const { chips, refusal } = acceptFiles([], [image('a.png'), image('b.png')], makeKey);
    expect(refusal).toBeNull();
    expect(chips.map((chip) => chip.name)).toEqual(['a.png', 'b.png']);
    expect(chips.every((chip) => chip.status === 'uploading')).toBe(true);
    expect(chips.map((chip) => chip.preview)).toEqual(created);
  });

  it('adds to what is already there rather than replacing it', () => {
    const first = acceptFiles([], [image('a.png')], makeKey).chips;
    expect(acceptFiles(first, [image('b.png')], makeKey).chips.map((c) => c.name)).toEqual([
      'a.png',
      'b.png',
    ]);
  });

  it('ignores what is not an image, without a word about it', () => {
    const { chips, refusal } = acceptFiles(
      [],
      [new File(['plain'], 'note.txt', { type: 'text/plain' }), image('a.png')],
      makeKey,
    );
    expect(chips.map((chip) => chip.name)).toEqual(['a.png']);
    expect(refusal).toBeNull();
  });

  it('stops at four and says so, keeping the ones that fit', () => {
    const four = acceptFiles([], [1, 2, 3, 4].map((n) => image(`${n}.png`)), makeKey).chips;
    expect(four).toHaveLength(MAX_ATTACHMENTS);

    const { chips, refusal } = acceptFiles(four, [image('5.png'), image('6.png')], makeKey);
    expect(chips).toEqual(four);
    expect(refusal).toEqual({ key: 'attachLimit', max: MAX_ATTACHMENTS });

    // Room for one of the two: it is taken, and the cap is still reported.
    const three = four.slice(0, 3);
    const partial = acceptFiles(three, [image('4.png'), image('5.png')], makeKey);
    expect(partial.chips).toHaveLength(4);
    expect(partial.refusal).toEqual({ key: 'attachLimit', max: MAX_ATTACHMENTS });
  });

  it('refuses an image over the size cap and says which limit it was', () => {
    const huge = image('huge.png', MAX_ATTACHMENT_MB * 1024 * 1024 + 1);
    const { chips, refusal } = acceptFiles([], [huge, image('a.png')], makeKey);
    expect(chips.map((chip) => chip.name)).toEqual(['a.png']);
    expect(refusal).toEqual({ key: 'attachTooLarge', max: MAX_ATTACHMENT_MB });
  });

  it('reports the size before the cap when a pick trips both', () => {
    const four = acceptFiles([], [1, 2, 3, 4].map((n) => image(`${n}.png`)), makeKey).chips;
    const { refusal } = acceptFiles(
      four,
      [image('huge.png', MAX_ATTACHMENT_MB * 1024 * 1024 + 1), image('5.png')],
      makeKey,
    );
    expect(refusal).toEqual({ key: 'attachTooLarge', max: MAX_ATTACHMENT_MB });
  });
});

describe('chip transitions', () => {
  const start = (): AttachmentChip[] =>
    acceptFiles([], [image('a.png'), image('b.png')], makeKey).chips;

  it('holds the send until every upload has landed', () => {
    const chips = start();
    expect(isUploading(chips)).toBe(true);
    expect(uploadedIds(chips)).toEqual([]);

    const half = markUploaded(chips, chips[0]!.key, stored('a1'));
    expect(isUploading(half)).toBe(true);
    expect(uploadedIds(half)).toEqual(['a1']);

    const both = markUploaded(half, chips[1]!.key, stored('a2'));
    expect(isUploading(both)).toBe(false);
    expect(uploadedIds(both)).toEqual(['a1', 'a2']);
  });

  it('lets a failed upload be retried, or dropped so the send can go', () => {
    const chips = markUploaded(start(), '', stored('none'));
    const failed = markFailed(chips, chips[1]!.key);
    expect(failed[1]!.status).toBe('failed');
    // A failure does not wedge the composer shut, but the unfinished one does.
    expect(isUploading(markUploaded(failed, failed[0]!.key, stored('a1')))).toBe(false);

    const retrying = markRetrying(failed, failed[1]!.key);
    expect(retrying[1]!.status).toBe('uploading');
    // The file is still in hand, which is what makes a retry possible at all.
    expect(retrying[1]!.file).toBe(failed[1]!.file);

    const dropped = removeChip(retrying, retrying[1]!.key);
    expect(dropped.map((chip) => chip.key)).toEqual([retrying[0]!.key]);
  });

  it('leaves the other chips alone on every transition', () => {
    const chips = start();
    const next = markUploaded(chips, chips[0]!.key, stored('a1'));
    expect(next[1]).toBe(chips[1]);
  });
});
