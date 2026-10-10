/**
 * The server half of moving a library over from another app (SillyTavern): which
 * of the files a reader holds are already here, and their chats brought in as
 * conversations (see docs/ARCHITECTURE.md §5 챗 트리, §10).
 *
 * The browser reads the backup and does the converting — the speech protocol,
 * which version a swipe was on, what each file's hash is — so what arrives here
 * is a conversation in our terms, in batches small enough for the JSON limit.
 * Cards come in through the ordinary card imports; only the chats need routes of
 * their own.
 */
import type { ImportedChatMessage } from '@shizue/core';
import { characters, chats, messages, plots, type NewMessage } from '@shizue/db';
import { listEnabledModels } from '@shizue/llm';
import { and, asc, count, eq, inArray, max, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AppDeps, AppEnv, Tx } from '../deps.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { enqueueJob } from '../jobs.js';
import { memoryChannel, overSummaryThreshold } from '../memory.js';
import { attachedNoteIds } from '../notes.js';
import { loadOwnedPlot } from '../plots.js';
import { rebased } from '../relationship.js';
import { buildPath } from '../tree.js';
import { isUuid, optionalBoolean, optionalString, readJsonBody, requireString, requireUuidParam } from '../util.js';
import { resolvePersona, toChatJson } from './chats.js';

/** Hashes one lookup may ask about — a whole backup's cards and chats in a request or two. */
const MAX_LOOKUP_HASHES = 1000;
/** Messages one import request carries; the browser keeps a batch under 4MB as well. */
export const MAX_IMPORT_BATCH_MESSAGES = 500;
/** Versions one imported message may carry — SillyTavern's swipes. */
export const MAX_IMPORT_VERSIONS = 20;
/** One version's length. A turn, however long-winded, not a book. */
export const MAX_IMPORT_VERSION_LENGTH = 100_000;
/**
 * Rows an imported chat may hold, every version counted — the number that decides
 * what the chat costs to store and to load, whichever version the branch is on.
 */
export const MAX_IMPORTED_ROWS = 20_000;
/** Rows per insert statement: 500 messages of 20 versions would pass Postgres' parameter limit in one. */
const INSERT_CHUNK_ROWS = 1_000;
/** The upload's own name as the record keeps it, as the card imports cut it. */
const MAX_IMPORT_FILE_NAME_LENGTH = 255;
/** A chat title from a file name; the chat list shows one line of it. */
const MAX_IMPORT_TITLE_LENGTH = 255;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A validated message, its time read once. */
interface ParsedMessage extends Omit<ImportedChatMessage, 'createdAt'> {
  at?: number;
}

const isSha256 = (value: unknown): value is string => typeof value === 'string' && SHA256_HEX.test(value);

/**
 * The batch a request carries, checked whole before anything is written: a
 * half-written batch is a conversation with a hole in it that the next batch
 * would continue past.
 */
function requireImportedMessages(body: Record<string, unknown>): ParsedMessage[] {
  const value = body['messages'];
  if (!Array.isArray(value)) throw badRequest('invalid_request', 'messages must be an array');
  if (value.length > MAX_IMPORT_BATCH_MESSAGES) {
    throw badRequest('invalid_request', `An import request carries at most ${MAX_IMPORT_BATCH_MESSAGES} messages`);
  }
  return value.map((entry, index) => {
    const where = `messages[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw badRequest('invalid_request', `${where} must be an object`);
    }
    const message = entry as Record<string, unknown>;
    const role = message['role'];
    if (role !== 'user' && role !== 'assistant') {
      throw badRequest('invalid_request', `${where}.role must be "user" or "assistant"`);
    }
    const versions = message['versions'];
    if (
      !Array.isArray(versions) ||
      versions.length < 1 ||
      versions.length > MAX_IMPORT_VERSIONS ||
      versions.some((text) => typeof text !== 'string' || text.length > MAX_IMPORT_VERSION_LENGTH)
    ) {
      throw badRequest(
        'invalid_request',
        `${where}.versions must be 1 to ${MAX_IMPORT_VERSIONS} strings of at most ${MAX_IMPORT_VERSION_LENGTH} characters`,
      );
    }
    const selected = message['selected'];
    if (typeof selected !== 'number' || !Number.isInteger(selected) || selected < 0 || selected >= versions.length) {
      throw badRequest('invalid_request', `${where}.selected must index one of its versions`);
    }
    const createdAt = message['createdAt'];
    let at: number | undefined;
    if (createdAt !== undefined) {
      at = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
      if (Number.isNaN(at)) throw badRequest('invalid_request', `${where}.createdAt must be an ISO 8601 time`);
    }
    return { role, versions: versions as string[], selected, ...(at === undefined ? {} : { at }) };
  });
}

const rowsOf = (batch: ParsedMessage[]): number =>
  batch.reduce((sum, message) => sum + message.versions.length, 0);

function requireRoom(stored: number, batch: ParsedMessage[]): void {
  if (stored + rowsOf(batch) > MAX_IMPORTED_ROWS) {
    throw badRequest('message_limit', `An imported chat holds at most ${MAX_IMPORTED_ROWS} messages, every version counted`);
  }
}

/**
 * Hangs a batch under `parentId` — the head, which is the selected path's tail —
 * and answers the new head.
 *
 * The conversation is linear: every version of a message becomes a sibling under
 * the selected version of the one before (the first message's are parent-null
 * roots, like a plot's openings), and it goes on from the selected one. The
 * selected version is stamped **last** of its siblings: `deepestLeaf` follows the
 * newest child at every level, so a reader who swipes away and back lands on the
 * conversation as the source left it rather than on whichever version came last.
 * The other versions keep their order in front of it.
 *
 * `created_at` is strictly increasing across the whole chat, since siblings and
 * the tree read order by it: a message keeps the time its source recorded where
 * that is later than everything before it, and is otherwise one millisecond past
 * it — as is every version after the first. `latest` is the chat's newest stamp so
 * far, so a batch continues where the one before it stopped.
 */
async function appendImported(
  tx: Tx,
  chatId: string,
  parentId: string | null,
  latest: Date | null,
  batch: ParsedMessage[],
): Promise<string | null> {
  const rows: NewMessage[] = [];
  let parent = parentId;
  let previous = latest?.getTime() ?? null;
  for (const message of batch) {
    const order = message.versions.map((_, index) => index).filter((index) => index !== message.selected);
    order.push(message.selected);
    order.forEach((version, position) => {
      const stamp =
        previous === null
          ? (message.at ?? Date.now())
          : position === 0 && message.at !== undefined && message.at > previous
            ? message.at
            : previous + 1;
      previous = stamp;
      rows.push({
        // Minted here so the next message can be chained before any of it is written.
        id: randomUUID(),
        chatId,
        parentId: parent,
        role: message.role,
        content: message.versions[version]!,
        createdAt: new Date(stamp),
      });
    });
    parent = rows[rows.length - 1]!.id!;
  }
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
    await tx.insert(messages).values(rows.slice(start, start + INSERT_CHUNK_ROWS));
  }
  return parent;
}

/** The chat a batch or the completion writes to: the caller's, locked, still importing. */
async function lockImportingChat(tx: Tx, id: string, userId: string) {
  const [chat] = await tx
    .select()
    .from(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .for('update');
  if (!chat) throw notFound('Chat not found');
  if (!chat.importing) throw new ApiError(409, 'chat_not_importing', 'This chat has finished importing');
  return chat;
}

/**
 * The model an imported chat starts on: the first the reader's account offers,
 * the same one the start-chat panel selects first. The file names none we have.
 */
async function defaultModel(deps: AppDeps, userId: string): Promise<string> {
  const [model] = await listEnabledModels(deps.env, deps.chatgpt?.accounts.forUser(userId));
  if (!model) throw badRequest('model_unavailable', 'No chat model is available');
  return model.id;
}

/** `POST /api/imports/lookup` — which of a backup's files are already here. */
export function importRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * The caller's own members and chats whose import record carries one of these
   * hashes. Only their own: someone else's library is not a thing a backup can
   * be checked against. A chat still importing is reported as such — the wizard
   * restarts it rather than treating the file as done.
   */
  app.post('/lookup', async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const value = body['sha256'];
    if (!Array.isArray(value) || value.length > MAX_LOOKUP_HASHES || !value.every(isSha256)) {
      throw badRequest(
        'invalid_request',
        `sha256 must be an array of at most ${MAX_LOOKUP_HASHES} lowercase hex SHA-256 digests`,
      );
    }
    const hashes = [...new Set(value)];
    if (hashes.length === 0) return c.json({ characters: [], chats: [] });

    const memberHash = sql<string>`${characters.importedFrom}->>'sha256'`;
    const members = await deps.db
      .select({ sha256: memberHash, plotId: characters.plotId, characterId: characters.id })
      .from(characters)
      .innerJoin(plots, eq(characters.plotId, plots.id))
      .where(and(eq(plots.ownerId, userId), inArray(memberHash, hashes)));
    const chatHash = sql<string>`${chats.importedFrom}->>'sha256'`;
    const imported = await deps.db
      .select({ sha256: chatHash, chatId: chats.id, importing: chats.importing })
      .from(chats)
      .where(and(eq(chats.userId, userId), inArray(chatHash, hashes)));
    return c.json({ characters: members, chats: imported });
  });

  return app;
}

/**
 * `POST /api/chats/import` and its batches. Mounted beside the chat router: the
 * chat these build is an ordinary chat once it is complete, and until then the
 * chat router refuses every write to it (`loadWritableChat`).
 */
export function chatImportRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * A new chat on one of the caller's own plots, holding the first batch. Created
   * as `POST /api/chats` creates one, minus the plot's openings: the conversation
   * brings its own. It stays `importing` — writable only by the batches — until
   * the completion.
   *
   * The file's hash is what a second run recognizes it by. A finished chat from
   * the same file is a 409 that names it; an unfinished one is what an import
   * that died part-way left behind, so it is deleted and this run starts over.
   */
  app.post('/import', async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const plotId = requireString(body, 'plotId');
    const fileName = requireString(body, 'fileName').trim().slice(0, MAX_IMPORT_FILE_NAME_LENGTH);
    if (!fileName) throw badRequest('invalid_request', 'fileName must not be empty');
    const sha256 = body['sha256'];
    if (!isSha256(sha256)) throw badRequest('invalid_request', 'sha256 must be a lowercase hex SHA-256 digest');
    const title = optionalString(body, 'title')?.trim().slice(0, MAX_IMPORT_TITLE_LENGTH);
    const batch = requireImportedMessages(body);
    requireRoom(0, batch);

    if (!isUuid(plotId)) throw notFound('Plot not found');
    const plot = await loadOwnedPlot(deps, plotId, userId);
    const persona = await resolvePersona(deps, userId, body['personaId']);
    const model = await defaultModel(deps, userId);

    const result = await deps.db.transaction(async (tx) => {
      // Two runs of the same file at once would each find nothing to replace and
      // both finish: one at a time per reader and file.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`chat-import:${userId}:${sha256}`}))`);
      const earlier = await tx
        .select({ id: chats.id, importing: chats.importing })
        .from(chats)
        .where(and(eq(chats.userId, userId), sql`${chats.importedFrom}->>'sha256' = ${sha256}`));
      const finished = earlier.find((chat) => !chat.importing);
      if (finished) return { conflict: finished.id };
      // An importing chat cannot have attachments, so the rows are all there is.
      if (earlier.length > 0) {
        await tx.delete(chats).where(inArray(chats.id, earlier.map((chat) => chat.id)));
      }

      const [created] = await tx
        .insert(chats)
        .values({
          userId,
          plotId,
          personaId: persona?.id ?? null,
          title: title || plot.name,
          model,
          importing: true,
          importedFrom: { fileName, sha256, importedAt: new Date().toISOString() },
        })
        .returning();
      const head = await appendImported(tx, created!.id, null, null, batch);
      const [chat] = await tx
        .update(chats)
        .set({ headMessageId: head })
        .where(eq(chats.id, created!.id))
        .returning();
      return { chat: chat! };
    });

    if ('conflict' in result) {
      return c.json(
        { error: 'This chat file has already been imported', code: 'already_imported', chatId: result.conflict },
        409,
      );
    }
    // Nothing can have attached a note to a chat that did not exist a moment ago.
    return c.json({ chat: toChatJson(result.chat, []), inserted: rowsOf(batch) }, 201);
  });

  /**
   * The next batch, continuing from the head. The chat row is locked for the
   * whole of it, so two batches in flight at once land one after the other rather
   * than both under the same parent.
   */
  app.post('/:id/import', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const batch = requireImportedMessages(await readJsonBody(c));

    const result = await deps.db.transaction(async (tx) => {
      const chat = await lockImportingChat(tx, id, userId);
      const [stored] = await tx
        .select({ rows: count(), latest: max(messages.createdAt) })
        .from(messages)
        .where(eq(messages.chatId, id));
      const rows = stored?.rows ?? 0;
      requireRoom(rows, batch);
      const head = await appendImported(tx, id, chat.headMessageId, stored?.latest ?? null, batch);
      await tx.update(chats).set({ headMessageId: head, updatedAt: new Date() }).where(eq(chats.id, id));
      return { inserted: rowsOf(batch), total: rows + rowsOf(batch) };
    });
    return c.json(result);
  });

  /**
   * The import is done: the chat becomes an ordinary one.
   *
   * The relationship extractor counts assistant turns past its last attempt, and
   * an imported history would read as hundreds of turns overdue — so its cursor is
   * set to where the history ends, and the stats start moving with the reader's
   * own turns. The history itself is only summarized when the reader asks for it
   * (`backfillMemory`) and it is long enough to need it: the `memory_backfill` job
   * is queued in this transaction and folds it a chunk at a time on the owner's
   * account. Over the threshold with no memory channel to fold it with, nothing is
   * queued and the answer says so.
   */
  app.post('/:id/import/complete', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const backfill = optionalBoolean(await readJsonBody(c), 'backfillMemory') === true;
    // Before the lock: resolving the channel may read the owner's model catalog.
    const channel = backfill ? await memoryChannel(deps, userId) : null;

    const { chat, memoryBackfill } = await deps.db.transaction(async (tx) => {
      const locked = await lockImportingChat(tx, id, userId);
      const all = await tx
        .select()
        .from(messages)
        .where(eq(messages.chatId, id))
        .orderBy(asc(messages.createdAt));
      const path = buildPath(all, locked.headMessageId);
      const depth = path.filter((message) => message.role === 'assistant').length;
      const memoryBackfill: 'queued' | 'not_needed' | 'unavailable' =
        !backfill || !overSummaryThreshold(locked, path) ? 'not_needed' : channel ? 'queued' : 'unavailable';

      const [row] = await tx
        .update(chats)
        .set({ importing: false, relationship: rebased(locked.relationship, depth), updatedAt: new Date() })
        .where(eq(chats.id, id))
        .returning();
      if (memoryBackfill === 'queued') await enqueueJob(tx, 'memory_backfill', { chatId: id });
      return { chat: row!, memoryBackfill };
    });
    return c.json({ chat: toChatJson(chat, await attachedNoteIds(deps, chat.id)), memoryBackfill });
  });

  return app;
}
