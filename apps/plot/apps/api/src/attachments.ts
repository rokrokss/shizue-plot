import { IMAGE_ATTACHED_PLACEHOLDER, type HistoryMessage } from '@shizue/core';
import { chatAttachments, type ChatAttachment, type Message } from '@shizue/db';
import { supportsVision } from '@shizue/llm';
import { and, asc, count, eq, inArray, isNull, lt } from 'drizzle-orm';
import { detectImageType } from './avatar.js';
import { badRequest } from './errors.js';
import type { AppDeps, Tx } from './deps.js';
import { attachmentKey, readAll, type ObjectStorage } from './storage.js';

/** Per image the reader attaches. Mirrored by the composer, enforced here. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Per message. The composer stops at the same number. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/**
 * Uploads one chat may hold for turns that were never sent. A composer takes four
 * at a time, so this is room for several abandoned drafts and no more: without it
 * a client that uploads and never sends could fill the store one 8MB image at a
 * time, since nothing but a send or an explicit removal ever touches those rows.
 */
export const MAX_UNBOUND_ATTACHMENTS = 16;
/** How long an upload no turn ever claimed is kept before the next one sweeps it. */
export const UNBOUND_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How much base64 the images of one turn may add to a request.
 *
 * Four images at the 8MB cap would be over forty megabytes of text on the wire —
 * enough to be refused by the provider, and paid for either way. The turn keeps
 * as many of its pictures as fit and says that the rest were attached.
 */
export const MAX_INLINE_IMAGE_BYTES = 16 * 1024 * 1024;

/** What a turn says about the `images` it carried but could not show. */
export const withImageNote = (content: string, images: number): string =>
  `${content}\n${Array.from({ length: images }, () => IMAGE_ATTACHED_PLACEHOLDER).join('\n')}`.trim();

/** Same-origin path an attachment is served from; only its owner may read it. */
export const attachmentUrl = (chatId: string, attachmentId: string): string =>
  `/api/chats/${chatId}/attachments/${attachmentId}`;

/** What a client is told about an attachment — never the storage key. */
export const toAttachmentJson = (row: ChatAttachment) => ({
  id: row.id,
  url: attachmentUrl(row.chatId, row.id),
  mime: row.mime,
  /** Intrinsic size and blurred placeholder; null together for an unmeasured one. */
  width: row.width,
  height: row.height,
  thumbhash: row.thumbhash,
});

/**
 * Stores an attachment, under a key built from the row id so no user-supplied
 * name reaches the store. Returns null for bytes that are not a supported image —
 * the sniff is the check, so a `.png` full of anything else never lands.
 *
 * Unlike a plot asset the bytes are not stripped: an attachment is served to
 * exactly one account, its own, and the card-in-a-PNG problem is about images
 * that are handed out.
 */
export async function saveAttachment(
  storage: ObjectStorage,
  attachmentId: string,
  bytes: Uint8Array,
): Promise<{ key: string; mime: string } | null> {
  const type = detectImageType(bytes);
  if (!type) return null;
  const key = attachmentKey(attachmentId, type.ext);
  await storage.put(key, bytes, type.mime);
  return { key, mime: type.mime };
}

/**
 * Clears out this chat's uploads that no turn ever claimed and that are old
 * enough to be nobody's draft any more.
 *
 * There is no sweeper process: a composer closed without sending leaves its
 * thumbnails behind, and the only thing that ever comes back to that chat is the
 * next upload — so the next upload is what pays for them. Rows first, then the
 * objects they pointed at, exactly as a deleted turn does it.
 */
export async function sweepStaleAttachments(
  db: AppDeps['db'] | Tx,
  chatId: string,
): Promise<string[]> {
  const stale = await db
    .delete(chatAttachments)
    .where(
      and(
        eq(chatAttachments.chatId, chatId),
        isNull(chatAttachments.messageId),
        lt(chatAttachments.createdAt, new Date(Date.now() - UNBOUND_ATTACHMENT_TTL_MS)),
      ),
    )
    .returning({ path: chatAttachments.path });
  // The objects are the caller's to delete, after its transaction has committed:
  // rows first, then the bytes they pointed at, exactly as a deleted turn does it.
  return stale.map((row) => row.path);
}

/** How many uploads this chat is holding for a turn that has not been sent. */
export async function countUnboundAttachments(
  db: AppDeps['db'] | Tx,
  chatId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(chatAttachments)
    .where(and(eq(chatAttachments.chatId, chatId), isNull(chatAttachments.messageId)));
  return row?.total ?? 0;
}

/**
 * The attachments of the given messages, by message id, oldest upload first.
 * Nothing to look up for a branch that carries none, which is nearly all of them.
 */
export async function attachmentsByMessage(
  deps: AppDeps,
  messageIds: string[],
): Promise<Map<string, ChatAttachment[]>> {
  const byMessage = new Map<string, ChatAttachment[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await deps.db
    .select()
    .from(chatAttachments)
    .where(inArray(chatAttachments.messageId, messageIds))
    .orderBy(asc(chatAttachments.createdAt), asc(chatAttachments.id));
  for (const row of rows) {
    if (!row.messageId) continue;
    const group = byMessage.get(row.messageId);
    if (group) group.push(row);
    else byMessage.set(row.messageId, [row]);
  }
  return byMessage;
}

/**
 * Claims the uploads a send named, and binds them to the turn it just wrote.
 *
 * Every id has to be one of this chat's own and still unbound: an attachment
 * belongs to one message, and re-sending an id that already has one would let a
 * turn quote another turn's image. Runs in the caller's transaction so a send
 * either takes all of them or none.
 */
export async function bindAttachments(
  tx: Tx,
  chatId: string,
  messageId: string,
  attachmentIds: string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;
  const bound = await tx
    .update(chatAttachments)
    .set({ messageId })
    .where(
      and(
        eq(chatAttachments.chatId, chatId),
        isNull(chatAttachments.messageId),
        inArray(chatAttachments.id, attachmentIds),
      ),
    )
    .returning({ id: chatAttachments.id });
  if (bound.length !== attachmentIds.length) {
    throw badRequest('invalid_attachment', 'attachmentIds must name unsent uploads of this chat');
  }
}

/**
 * Puts the attachments of the turn being answered onto the history entry that
 * stands for it.
 *
 * Only that one turn: an image is worth a thousand tokens whatever the provider
 * charges for it, so re-sending every image the branch ever carried would grow
 * the request without bound. It is the same rule stage directions follow — the
 * ruling on the turn being answered is injected, earlier ones already had their
 * effect — and it means a regenerate of a turn sees exactly what the first
 * attempt saw.
 *
 * `source` must be the array `history` was mapped from, one entry per message.
 * `model` decides whether the bytes are read at all: a model without vision is
 * told the turn carried pictures, and megabytes are never pulled out of the store
 * only for the assembler to drop them again.
 */
export async function withTurnImages(
  deps: AppDeps,
  userId: string,
  model: string,
  source: Message[],
  history: HistoryMessage[],
): Promise<HistoryMessage[]> {
  const at = source.findLastIndex((message) => message.role === 'user');
  if (at < 0 || at >= history.length) return history;
  const attachments = (await attachmentsByMessage(deps, [source[at]!.id])).get(source[at]!.id);
  if (!attachments?.length) return history;
  const noted = (skipped: number): HistoryMessage[] =>
    history.map((entry, index) =>
      index === at ? { ...entry, content: withImageNote(entry.content, skipped) } : entry,
    );
  if (!await supportsVision(model, deps.env, deps.chatgpt?.accounts.forUser(userId))) return noted(attachments.length);

  const { images, skipped } = await attachmentImages(deps, attachments);
  if (images.length === 0) return skipped > 0 ? noted(skipped) : history;
  return history.map((entry, index) =>
    index === at
      ? {
          ...entry,
          ...(skipped > 0 ? { content: withImageNote(entry.content, skipped) } : {}),
          images,
        }
      : entry,
  );
}

/**
 * The images of the turn being answered, as `data:` URLs, and how many of them
 * did not fit.
 *
 * Inlined rather than linked because the serving route is behind the reader's own
 * session: a provider fetching `/api/chats/…/attachments/…` has no cookie and
 * would get a 404, and the local storage driver has no public URL to hand out at
 * all. The bytes are capped at 8MB each and at four per message, and the base64
 * of the whole turn at `MAX_INLINE_IMAGE_BYTES` — measured off the object's size
 * so an image that cannot fit is never read.
 */
export async function attachmentImages(
  deps: AppDeps,
  attachments: ChatAttachment[],
): Promise<{ images: string[]; skipped: number }> {
  const images: string[] = [];
  let skipped = 0;
  let budget = MAX_INLINE_IMAGE_BYTES;
  for (const attachment of attachments) {
    const object = await deps.storage.get(attachment.path);
    // A row whose bytes are gone is simply not shown to the model, exactly as it
    // is not shown to the reader.
    if (!object) continue;
    const encoded = Math.ceil(object.size / 3) * 4;
    if (encoded > budget) {
      // Nothing will read it, so the handle the driver just opened is closed.
      await object.body.cancel();
      skipped += 1;
      continue;
    }
    budget -= encoded;
    const bytes = await readAll(object.body);
    images.push(`data:${attachment.mime};base64,${bytes.toString('base64')}`);
  }
  return { images, skipped };
}
