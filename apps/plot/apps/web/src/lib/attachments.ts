/**
 * The composer's thumbnail strip, as data.
 *
 * A chip is one picked image on its way to the server: it exists before the
 * upload starts, survives the upload failing, and is only replaced by the message
 * once the turn is sent. Every transition is a function here rather than a
 * `setState` in the page, because "four at a time, 8MB each, and no sending while
 * one is still in flight" is the whole feature and it is worth testing on its own.
 */

import type { ChatAttachment } from './types';

/** Images one message may carry. Mirrors MAX_ATTACHMENTS_PER_MESSAGE in the API. */
export const MAX_ATTACHMENTS = 4;
/** Per image, in megabytes — the unit both refusal messages are written in. */
export const MAX_ATTACHMENT_MB = 8;
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

export type ChipStatus = 'uploading' | 'done' | 'failed';

export interface AttachmentChip {
  /** Local identity, stable from the moment the file is picked. */
  key: string;
  name: string;
  /** Object URL of the picked file: the thumbnail, before the server has anything. */
  preview: string;
  file: File;
  status: ChipStatus;
  /** The stored row, once the upload landed. */
  attachment?: ChatAttachment;
}

/**
 * Why some of the picked files did not become chips: an i18n key under `chat`
 * and the number the message quotes. Null when everything was taken.
 */
export interface AttachmentRefusal {
  key: 'attachLimit' | 'attachTooLarge';
  max: number;
}

/** Only images, and only ones the browser named as such. */
const isImage = (file: File): boolean => file.type.startsWith('image/');

/**
 * Takes what fits and says what did not.
 *
 * Anything that is not an image is dropped without a word — a paste carries the
 * clipboard's other flavours too, and a drop can be anything at all, so refusing
 * out loud would mean complaining about files the reader never meant to attach.
 * The two real limits do speak up.
 */
export function acceptFiles(
  chips: AttachmentChip[],
  files: File[],
  makeKey: () => string,
): { chips: AttachmentChip[]; refusal: AttachmentRefusal | null } {
  const images = files.filter(isImage);
  const withinSize = images.filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
  const room = Math.max(0, MAX_ATTACHMENTS - chips.length);
  const taken = withinSize.slice(0, room);

  // Size first: a reader who dropped one oversized file is told about the size,
  // not about a cap they never reached.
  const refusal: AttachmentRefusal | null =
    withinSize.length < images.length
      ? { key: 'attachTooLarge', max: MAX_ATTACHMENT_MB }
      : taken.length < withinSize.length
        ? { key: 'attachLimit', max: MAX_ATTACHMENTS }
        : null;

  if (taken.length === 0) return { chips, refusal };
  return {
    chips: [
      ...chips,
      ...taken.map((file) => ({
        key: makeKey(),
        name: file.name,
        preview: URL.createObjectURL(file),
        file,
        status: 'uploading' as const,
      })),
    ],
    refusal,
  };
}

const replace = (
  chips: AttachmentChip[],
  key: string,
  next: (chip: AttachmentChip) => AttachmentChip,
): AttachmentChip[] => chips.map((chip) => (chip.key === key ? next(chip) : chip));

/** The upload landed: the chip now stands for a row the send can name. */
export const markUploaded = (
  chips: AttachmentChip[],
  key: string,
  attachment: ChatAttachment,
): AttachmentChip[] => replace(chips, key, (chip) => ({ ...chip, status: 'done', attachment }));

/** The upload failed: the chip stays, with the retry on it. */
export const markFailed = (chips: AttachmentChip[], key: string): AttachmentChip[] =>
  replace(chips, key, (chip) => ({ ...chip, status: 'failed' }));

/** Trying again with the same file — the chip goes back to where it started. */
export const markRetrying = (chips: AttachmentChip[], key: string): AttachmentChip[] =>
  replace(chips, key, (chip) => ({ ...chip, status: 'uploading' }));

export const removeChip = (chips: AttachmentChip[], key: string): AttachmentChip[] =>
  chips.filter((chip) => chip.key !== key);

/**
 * Whether the composer must hold the send back. A failed chip does not: the
 * reader can drop it and send, and the alternative is a composer wedged shut by
 * an upload that will never succeed.
 */
export const isUploading = (chips: AttachmentChip[]): boolean =>
  chips.some((chip) => chip.status === 'uploading');

/** The ids a send names, in the order the reader picked them. */
export const uploadedIds = (chips: AttachmentChip[]): string[] =>
  chips.flatMap((chip) => (chip.attachment ? [chip.attachment.id] : []));
