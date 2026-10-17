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
import {
  coerceAuthorNoteSettings,
  replyLengthTokens,
  type ImportedChatMessage,
  type ImportedMessageExtra,
} from '@shizue/core';
import { characters, chatAttachments, chats, messages, plots, type NewMessage } from '@shizue/db';
import { listEnabledModels } from '@shizue/llm';
import { and, asc, count, eq, inArray, isNotNull, isNull, max, min, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  saveAttachment,
  saveTextAttachment,
  toAttachmentJson,
} from '../attachments.js';
import type { AppDeps, AppEnv, Tx } from '../deps.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { RATE_LIMITS, rateLimit } from '../rateLimit.js';
import { acquireChatSlot, rejectBusyChat, releaseChatSlot } from '../generation.js';
import { enqueueJob } from '../jobs.js';
import { memoryChannel, summaryDue } from '../memory.js';
import { attachedNoteIds } from '../notes.js';
import { loadMembers } from '../hub.js';
import { loadOwnedPlot } from '../plots.js';
import { deleteQuietly } from '../storage.js';
import { optionalVariableDelta, storableDelta } from '../scriptState.js';
import { buildPath } from '../tree.js';
import { isUuid, optionalBoolean, optionalString, readJsonBody, requireString, requireUuidParam } from '../util.js';
import { optionalSettings, resolvePersona, toChatJson } from './chats.js';

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
/**
 * The author's note an imported chat brings. The chat's own note has no cap of
 * its own (`PATCH /api/chats/:id`); this is one turn's length, which no note
 * written to steer a scene comes near.
 */
export const MAX_IMPORT_NOTE_LENGTH = MAX_IMPORT_VERSION_LENGTH;

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
    const speakerId = message['speakerId'];
    if (speakerId !== undefined && (role !== 'assistant' || typeof speakerId !== 'string' || !isUuid(speakerId))) {
      throw badRequest('invalid_request', `${where}.speakerId must be a member id, on an assistant message`);
    }
    const hidden = message['hidden'];
    if (hidden !== undefined && typeof hidden !== 'boolean') {
      throw badRequest('invalid_request', `${where}.hidden must be a boolean`);
    }
    const extras = requireExtras(message['extras'], versions.length, where);
    return {
      role,
      versions: versions as string[],
      selected,
      ...(at === undefined ? {} : { at }),
      ...(speakerId === undefined ? {} : { speakerId: speakerId as string }),
      ...(hidden ? { hidden: true } : {}),
      ...(extras ? { extras } : {}),
    };
  });
}

/** The fields of a version's extra (`ImportedMessageExtra`), each a string a version's length at most. */
const EXTRA_FIELDS = ['displayText', 'reasoning', 'bias'] as const;

/**
 * What SillyTavern kept beside each version, parallel to them: an object of the
 * three fields or null. U+0000 is refused, as Postgres cannot store it.
 */
function requireExtras(value: unknown, count: number, where: string): (ImportedMessageExtra | null)[] | undefined {
  if (value === undefined) return undefined;
  const invalid = (): never => {
    throw badRequest(
      'invalid_request',
      `${where}.extras must be one null or object of ${EXTRA_FIELDS.join(', ')} per version, each a string of at most ${MAX_IMPORT_VERSION_LENGTH} characters without U+0000`,
    );
  };
  if (!Array.isArray(value) || value.length !== count) return invalid();
  return value.map((extra): ImportedMessageExtra | null => {
    if (extra === null) return null;
    if (typeof extra !== 'object' || Array.isArray(extra)) return invalid();
    const kept: ImportedMessageExtra = {};
    for (const [key, text] of Object.entries(extra as Record<string, unknown>)) {
      if (!(EXTRA_FIELDS as readonly string[]).includes(key)) return invalid();
      if (typeof text !== 'string' || text.length > MAX_IMPORT_VERSION_LENGTH || text.includes('\u0000')) {
        return invalid();
      }
      kept[key as (typeof EXTRA_FIELDS)[number]] = text;
    }
    return kept;
  });
}

/**
 * The speakers a batch names, held to the plot's roster: a group chat comes
 * into a work of two or more members, and each reply is said by one of them
 * (400 `invalid_request` otherwise). A batch naming none asks nothing.
 */
async function requireSpeakers(tx: Tx, plotId: string, batch: ParsedMessage[]): Promise<void> {
  const named = batch.flatMap((message) => (message.speakerId === undefined ? [] : [message.speakerId]));
  if (named.length === 0) return;
  const roster = new Set((await loadMembers(tx, plotId)).map((member) => member.id));
  if (roster.size < 2) throw badRequest('invalid_request', 'speakerId is only for a work of two or more members');
  if (named.some((id) => !roster.has(id))) throw badRequest('invalid_request', 'speakerId must name a member of the plot');
}

const rowsOf = (batch: ParsedMessage[]): number =>
  batch.reduce((sum, message) => sum + message.versions.length, 0);

function requireRoom(stored: number, batch: ParsedMessage[]): void {
  if (stored + rowsOf(batch) > MAX_IMPORTED_ROWS) {
    throw badRequest('message_limit', `An imported chat holds at most ${MAX_IMPORTED_ROWS} messages, every version counted`);
  }
}

/** A version's extra as the message's columns, each only where it has one. */
const extraColumns = (extra: ImportedMessageExtra | null | undefined): Partial<NewMessage> =>
  extra
    ? {
        ...(extra.displayText !== undefined ? { displayText: extra.displayText } : {}),
        ...(extra.reasoning !== undefined ? { reasoning: extra.reasoning } : {}),
        ...(extra.bias !== undefined ? { bias: extra.bias } : {}),
      }
    : {};

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
 *
 * A branch (`before`) is the exception: its first message joins siblings already
 * there, and is stamped just before the oldest of them, so the conversation the
 * head is on stays the newest child and a swipe away and back still lands on it.
 * What follows in the branch goes on from there.
 *
 * Answers the new head, and each message's rows by version, in the batch's order.
 */
async function appendImported(
  tx: Tx,
  chatId: string,
  parentId: string | null,
  latest: Date | null,
  batch: ParsedMessage[],
  { before }: { before?: number } = {},
): Promise<{ head: string | null; ids: string[][] }> {
  const rows: NewMessage[] = [];
  const ids: string[][] = [];
  let parent = parentId;
  let previous = before !== undefined ? before - (batch[0]?.versions.length ?? 0) - 1 : (latest?.getTime() ?? null);
  batch.forEach((message, at) => {
    const order = message.versions.map((_, index) => index).filter((index) => index !== message.selected);
    order.push(message.selected);
    const versionIds: string[] = [];
    order.forEach((version, position) => {
      const stamp =
        previous === null
          ? (message.at ?? Date.now())
          : position === 0 && message.at !== undefined && message.at > previous && !(before !== undefined && at === 0)
            ? message.at
            : previous + 1;
      previous = stamp;
      // Minted here so the next message can be chained before any of it is written.
      const id = randomUUID();
      versionIds[version] = id;
      rows.push({
        id,
        chatId,
        parentId: parent,
        role: message.role,
        content: message.versions[version]!,
        // Every version is the same member's reply; each is a round of its own.
        ...(message.speakerId !== undefined ? { speakerMemberId: message.speakerId } : {}),
        // What the source kept out of the prompt (SillyTavern's `is_system`), every version.
        ...(message.hidden ? { hiddenFromPrompt: true } : {}),
        // …and what it kept beside this version: the text shown in its place, the reasoning, the bias.
        ...extraColumns(message.extras?.[version]),
        createdAt: new Date(stamp),
      });
    });
    ids.push(versionIds);
    parent = rows[rows.length - 1]!.id!;
  });
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
    await tx.insert(messages).values(rows.slice(start, start + INSERT_CHUNK_ROWS));
  }
  return { head: parent, ids };
}

/** A branch file as the chat records it (`importedFrom.branches`), and a batch names it. */
interface BranchFile {
  fileName: string;
  sha256: string;
}

/**
 * Where a batch of a SillyTavern branch or checkpoint goes (`branch` on
 * `POST /api/chats/:id/import`): under `parentId` — a message of this chat, or
 * null for a new opening — rather than the head, which it leaves where it is.
 * The last batch of a branch names its file, which the chat then records.
 */
function optionalBranch(body: Record<string, unknown>): { parentId: string | null; file?: BranchFile } | undefined {
  const value = body['branch'];
  if (value === undefined) return undefined;
  const invalid = (): never => {
    throw badRequest(
      'invalid_request',
      'branch must be { parentId: a message id or null, file?: { fileName, sha256 } }',
    );
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  const parentId = raw['parentId'];
  if (parentId !== null && (typeof parentId !== 'string' || !isUuid(parentId))) return invalid();
  const file = raw['file'];
  if (file === undefined) return { parentId: parentId as string | null };
  if (file === null || typeof file !== 'object' || Array.isArray(file)) return invalid();
  const fileName = (file as Record<string, unknown>)['fileName'];
  const sha256 = (file as Record<string, unknown>)['sha256'];
  if (typeof fileName !== 'string' || !fileName.trim() || !isSha256(sha256)) return invalid();
  return {
    parentId: parentId as string | null,
    file: { fileName: fileName.trim().slice(0, MAX_IMPORT_FILE_NAME_LENGTH), sha256 },
  };
}

/**
 * Where a branch batch hangs (`POST /api/chats/:id/import` with `branch`): the
 * oldest stamp of the messages already under `parentId` — the first message
 * goes in before them — or, where there are none, the parent's own stamp to go
 * on from. A parent that is not this chat's message is a 400.
 */
async function branchPlace(
  tx: Tx,
  chatId: string,
  parentId: string | null,
): Promise<{ before?: number; latest: Date | null }> {
  let latest: Date | null = null;
  if (parentId !== null) {
    const [parent] = await tx
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.id, parentId)))
      .limit(1);
    if (!parent) throw badRequest('invalid_request', 'branch.parentId must be a message of this chat');
    latest = parent.createdAt;
  }
  const [siblings] = await tx
    .select({ oldest: min(messages.createdAt) })
    .from(messages)
    .where(
      and(eq(messages.chatId, chatId), parentId === null ? isNull(messages.parentId) : eq(messages.parentId, parentId)),
    );
  return siblings?.oldest ? { before: siblings.oldest.getTime(), latest } : { latest };
}

/**
 * The chat a batch or the completion writes to: the caller's, locked, still
 * importing — or, for a SillyTavern branch (`finished`), one an earlier import
 * made and finished, which a branch file of it brought in a later run is hung
 * onto (`importedFrom`).
 */
async function lockImportingChat(tx: Tx, id: string, userId: string, { finished = false }: { finished?: boolean } = {}) {
  const [chat] = await tx
    .select()
    .from(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .for('update');
  if (!chat) throw notFound('Chat not found');
  if (!chat.importing && !(finished && chat.importedFrom)) {
    throw new ApiError(409, 'chat_not_importing', 'This chat has finished importing');
  }
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
   *
   * With `chatFiles` — file names — the chats an earlier run made of a file of
   * that name, or hung a branch file of that name onto (`named`, with their
   * plots): where a SillyTavern branch whose `main_chat` names a file this run
   * does not bring goes.
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
    const files = body['chatFiles'];
    if (
      files !== undefined &&
      (!Array.isArray(files) ||
        files.length > MAX_LOOKUP_HASHES ||
        !files.every((name) => typeof name === 'string' && name.length > 0 && name.length <= MAX_IMPORT_FILE_NAME_LENGTH))
    ) {
      throw badRequest('invalid_request', `chatFiles must be an array of at most ${MAX_LOOKUP_HASHES} file names`);
    }
    const named = Array.isArray(files) ? await chatsNamed(userId, new Set(files as string[])) : undefined;
    const hashes = [...new Set(value)];
    if (hashes.length === 0) return c.json({ characters: [], chats: [], ...(named ? { named } : {}) });

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
    // A branch or checkpoint file is the chat it went into (`importedFrom.branches`).
    const wanted = new Set(hashes);
    const branched = await deps.db
      .select({ chatId: chats.id, importing: chats.importing, importedFrom: chats.importedFrom })
      .from(chats)
      .where(and(eq(chats.userId, userId), isNotNull(sql`${chats.importedFrom}->'branches'`)));
    for (const chat of branched) {
      for (const branch of chat.importedFrom?.branches ?? []) {
        if (wanted.has(branch.sha256)) imported.push({ sha256: branch.sha256, chatId: chat.chatId, importing: chat.importing });
      }
    }
    return c.json({ characters: members, chats: imported, ...(named ? { named } : {}) });
  });

  /** The caller's chats an import made of a file of one of these names, or hung a branch file of one onto. */
  async function chatsNamed(
    userId: string,
    names: ReadonlySet<string>,
  ): Promise<{ fileName: string; chatId: string; plotId: string; importing: boolean }[]> {
    if (names.size === 0) return [];
    const imported = await deps.db
      .select({ chatId: chats.id, plotId: chats.plotId, importing: chats.importing, importedFrom: chats.importedFrom })
      .from(chats)
      .where(and(eq(chats.userId, userId), isNotNull(chats.importedFrom)));
    return imported.flatMap((chat) =>
      [chat.importedFrom?.fileName, ...(chat.importedFrom?.branches ?? []).map((branch) => branch.fileName)]
        .filter((name): name is string => name !== undefined && names.has(name))
        .map((fileName) => ({ fileName, chatId: chat.chatId, plotId: chat.plotId, importing: chat.importing })),
    );
  }

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
  app.post('/import', rateLimit(deps, RATE_LIMITS.chatImport), async (c) => {
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
      // The pictures and files it had brought go with it: the rows by the
      // cascade, the bytes once the transaction is done.
      let leftover: string[] = [];
      if (earlier.length > 0) {
        const ids = earlier.map((chat) => chat.id);
        leftover = (
          await tx.select({ path: chatAttachments.path }).from(chatAttachments).where(inArray(chatAttachments.chatId, ids))
        ).map((row) => row.path);
        await tx.delete(chats).where(inArray(chats.id, ids));
      }
      await requireSpeakers(tx, plotId, batch);

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
      const { head, ids } = await appendImported(tx, created!.id, null, null, batch);
      const [chat] = await tx
        .update(chats)
        .set({ headMessageId: head })
        .where(eq(chats.id, created!.id))
        .returning();
      return { chat: chat!, ids, leftover };
    });

    if ('conflict' in result) {
      return c.json(
        { error: 'This chat file has already been imported', code: 'already_imported', chatId: result.conflict },
        409,
      );
    }
    for (const path of result.leftover) await deleteQuietly(deps.storage, path);
    // Nothing can have attached a note to a chat that did not exist a moment ago.
    return c.json({ chat: toChatJson(result.chat, []), inserted: rowsOf(batch), ids: result.ids }, 201);
  });

  /**
   * The next batch, continuing from the head. The chat row is locked for the
   * whole of it, so two batches in flight at once land one after the other rather
   * than both under the same parent. Answers each message's rows by version
   * (`ids`) and where the batch ends (`tail`).
   *
   * With `branch` (`optionalBranch`) the batch is a SillyTavern branch or
   * checkpoint of the conversation — a chat file whose `chat_metadata.main_chat`
   * names the one this chat was made from — and hangs under `branch.parentId`,
   * where its messages part from that conversation, as a swipe does: its first
   * message joins the siblings there before them (`appendImported`), and the head
   * stays where it is. A branch's later batches hang under the tail the one before
   * it answered. Its last batch names its file, which the chat records in
   * `importedFrom.branches`, so the lookup finds it as this chat. A branch may
   * also go onto a chat an earlier run made and finished — its file came in a
   * later run (`GET /:id/import/tree` says where it parts) — under the chat's
   * generation slot, as the reader may be playing it (429 meanwhile).
   */
  app.post('/:id/import', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const batch = requireImportedMessages(body);
    const branch = optionalBranch(body);
    // A branch onto a chat an earlier run finished: the reader may be playing it,
    // so the batch waits for no turn and no turn for it — the generation slot.
    const [current] = await deps.db
      .select({ importing: chats.importing })
      .from(chats)
      .where(and(eq(chats.id, id), eq(chats.userId, userId)))
      .limit(1);
    if (!current) throw notFound('Chat not found');
    const live = branch !== undefined && !current.importing;
    if (live && !(await acquireChatSlot(deps, id, userId))) await rejectBusyChat(deps, id, userId);
    try {
      return c.json(await appendBatch(id, userId, batch, branch));
    } finally {
      if (live) await releaseChatSlot(deps, id);
    }
  });

  /**
   * A picture or a file a SillyTavern message carried (`ImportedAttachments`), onto
   * the row it came in as (`messageId`, one of the ids a batch answered): a
   * picture (`kind` `image`) with the bytes sniffed, never believed — and a
   * file (`kind` `file`) as UTF-8 text under its `name`, which the prompt folds
   * into the turn as ST does (`withFileTexts`). Each under
   * `MAX_ATTACHMENT_BYTES`, and at most `MAX_ATTACHMENTS_PER_MESSAGE` on
   * a message. The chat must be one a batch may still write: the caller's, still
   * importing — or finished, where a branch of a later run is hung on it.
   */
  app.post('/:id/import/attachments', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw badRequest('invalid_request', 'Expected multipart/form-data with a file field');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('invalid_request', 'file field is required');
    const messageId = form.get('messageId');
    if (typeof messageId !== 'string' || !isUuid(messageId)) {
      throw badRequest('invalid_request', 'messageId must be a message id');
    }
    const kind = form.get('kind') ?? 'image';
    if (kind !== 'image' && kind !== 'file') throw badRequest('invalid_request', 'kind must be "image" or "file"');
    const rawName = form.get('name');
    const name = kind === 'file' ? (typeof rawName === 'string' ? rawName.trim() : '').slice(0, MAX_IMPORT_FILE_NAME_LENGTH) || 'file.txt' : null;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw badRequest('attachment_too_large', `An attachment may be at most ${MAX_ATTACHMENT_BYTES} bytes`);
    }

    const attachmentId = randomUUID();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored =
      kind === 'image'
        ? await saveAttachment(deps.storage, attachmentId, bytes)
        : await saveTextAttachment(deps.storage, attachmentId, bytes);
    if (!stored) throw badRequest('invalid_attachment', kind === 'image' ? 'Unsupported image file' : 'Not UTF-8 text');
    try {
      const row = await deps.db.transaction(async (tx) => {
        await lockImportingChat(tx, id, userId, { finished: true });
        const [message] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.id, messageId), eq(messages.chatId, id)))
          .limit(1);
        if (!message) throw badRequest('invalid_request', 'messageId must be a message of this chat');
        const [held] = await tx
          .select({ total: count() })
          .from(chatAttachments)
          .where(eq(chatAttachments.messageId, messageId));
        if ((held?.total ?? 0) >= MAX_ATTACHMENTS_PER_MESSAGE) {
          throw badRequest('attachment_limit', `A message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
        }
        const [inserted] = await tx
          .insert(chatAttachments)
          .values({ id: attachmentId, chatId: id, messageId, path: stored.key, mime: stored.mime, name })
          .returning();
        return inserted!;
      });
      return c.json(toAttachmentJson(row), 201);
    } catch (error) {
      // No row names the bytes, and nothing else ever would.
      await deleteQuietly(deps.storage, stored.key);
      throw error;
    }
  });

  /**
   * The chat as an earlier import left it and the reader has played it since,
   * for a SillyTavern branch or checkpoint file brought in a later run to find
   * where it parts from it (the web's `forkInTree`): every message of the chat,
   * its place in the tree, who says it, and its text's SHA-256 rather than the
   * text. The caller's own chats, and only ones an import made.
   */
  app.get('/:id/import/tree', async (c) => {
    const id = requireUuidParam(c);
    const [chat] = await deps.db
      .select({ importedFrom: chats.importedFrom })
      .from(chats)
      .where(and(eq(chats.id, id), eq(chats.userId, c.get('userId'))))
      .limit(1);
    if (!chat?.importedFrom) throw notFound('Chat not found');
    const rows = await deps.db
      .select({
        id: messages.id,
        parentId: messages.parentId,
        role: messages.role,
        speakerId: messages.speakerMemberId,
        sha256: sql<string>`encode(sha256(convert_to(${messages.content}, 'UTF8')), 'hex')`,
      })
      .from(messages)
      .where(eq(messages.chatId, id))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    return c.json({ messages: rows });
  });

  async function appendBatch(
    id: string,
    userId: string,
    batch: ReturnType<typeof requireImportedMessages>,
    branch: ReturnType<typeof optionalBranch>,
  ) {
    return deps.db.transaction(async (tx) => {
      const chat = await lockImportingChat(tx, id, userId, { finished: branch !== undefined });
      const [stored] = await tx
        .select({ rows: count(), latest: max(messages.createdAt) })
        .from(messages)
        .where(eq(messages.chatId, id));
      const rows = stored?.rows ?? 0;
      requireRoom(rows, batch);
      await requireSpeakers(tx, chat.plotId, batch);
      if (!branch) {
        const { head, ids } = await appendImported(tx, id, chat.headMessageId, stored?.latest ?? null, batch);
        await tx.update(chats).set({ headMessageId: head, updatedAt: new Date() }).where(eq(chats.id, id));
        return { inserted: rowsOf(batch), total: rows + rowsOf(batch), ids, tail: head };
      }
      const placed = await branchPlace(tx, id, branch.parentId);
      const { head, ids } = await appendImported(tx, id, branch.parentId, placed.latest, batch, placed);
      if (branch.file) {
        const known = chat.importedFrom?.branches ?? [];
        const branches = [...known.filter((one) => one.sha256 !== branch.file!.sha256), branch.file];
        if (chat.importedFrom) {
          await tx
            .update(chats)
            .set({ importedFrom: { ...chat.importedFrom, branches }, updatedAt: new Date() })
            .where(eq(chats.id, id));
        }
      }
      return { inserted: rowsOf(batch), total: rows + rowsOf(batch), ids, tail: head };
    });
  }

  /**
   * The import is done: the chat becomes an ordinary one.
   *
   * The history is only summarized when the reader asks for it
   * (`backfillMemory`) and it is long enough to need it: the `memory_backfill` job
   * is queued in this transaction and summarizes it a batch at a time on the
   * owner's account. Too long with no memory channel to summarize it with,
   * nothing is queued and the answer says so.
   *
   * What the source kept for the chat as a whole rather than for any one message
   * comes here, once the messages are all in:
   * - `variables`, the chat's variables as the source left them, become the
   *   `variable_delta` of every root — each version of the first message — so the
   *   fold starts every branch, and every swipe of the opening, from them. Held
   *   to the limits any delta is (`checkVariableDelta`); the browser leaves out
   *   what would not pass before it sends.
   * - `note`, the chat's author's note, becomes the chat's own note.
   * - `noteSettings`, where and how often the source put that note in (its depth,
   *   frequency and role, `AuthorNoteSettings`), become the chat's own, read as
   *   the settings PATCH reads them: anything but an object (or null) is refused,
   *   the rest coerced into range by `coerceAuthorNoteSettings`.
   */
  app.post('/:id/import/complete', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const backfill = optionalBoolean(body, 'backfillMemory') === true;
    const variables = optionalVariableDelta(body, 'variables');
    const note = optionalString(body, 'note');
    // U+0000 is refused for the reason a delta refuses it: Postgres cannot store it.
    if (note !== undefined && (note.length > MAX_IMPORT_NOTE_LENGTH || note.includes('\u0000'))) {
      throw badRequest('invalid_request', `note must be at most ${MAX_IMPORT_NOTE_LENGTH} characters, without U+0000`);
    }
    const noteSettings = optionalSettings(body, 'noteSettings', coerceAuthorNoteSettings);
    // Before the lock: resolving the channel may read the owner's model catalog.
    // The chat has no auxiliary model of its own yet — the settings route takes
    // no writes while the import runs — and a pick would not change the answer
    // anyway: what is asked is whether the owner has any model to fold with.
    const channel = backfill ? await memoryChannel(deps, { userId, subModel: null }) : null;

    const { chat, memoryBackfill } = await deps.db.transaction(async (tx) => {
      const locked = await lockImportingChat(tx, id, userId);
      if (variables) {
        await tx
          .update(messages)
          .set({ variableDelta: storableDelta(variables) })
          .where(and(eq(messages.chatId, id), isNull(messages.parentId)));
      }
      const all = await tx
        .select()
        .from(messages)
        .where(eq(messages.chatId, id))
        .orderBy(asc(messages.createdAt));
      const path = buildPath(all, locked.headMessageId);
      // An importing chat has no summaries yet: nothing generates on it.
      const due = async (): Promise<boolean> => {
        const [plot] = await tx.select({ style: plots.style }).from(plots).where(eq(plots.id, locked.plotId)).limit(1);
        return summaryDue(locked, path, [], replyLengthTokens(plot?.style?.replyLength));
      };
      const memoryBackfill: 'queued' | 'not_needed' | 'unavailable' =
        !backfill || !(await due()) ? 'not_needed' : channel ? 'queued' : 'unavailable';

      const [row] = await tx
        .update(chats)
        .set({
          importing: false,
          ...(note !== undefined ? { note } : {}),
          ...(noteSettings !== undefined ? { noteSettings } : {}),
          updatedAt: new Date(),
        })
        .where(eq(chats.id, id))
        .returning();
      if (memoryBackfill === 'queued') await enqueueJob(tx, 'memory_backfill', { chatId: id });
      return { chat: row!, memoryBackfill };
    });
    return c.json({ chat: toChatJson(chat, await attachedNoteIds(deps, chat.id)), memoryBackfill });
  });

  return app;
}
