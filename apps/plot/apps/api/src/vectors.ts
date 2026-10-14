/**
 * SillyTavern's Vector Storage on the server embedder (@shizue/core `vectors.ts`,
 * ARCHITECTURE §6 로어북 and §7.3): lore entries activated by meaning, and a
 * chat's earlier messages brought back by meaning. Both are off until asked for —
 * an entry marked `vectorized` or a book under `vectorizeAll`, a chat whose
 * `retrieval` is on — and cost nothing until then.
 *
 * - **Embedding is background work.** A plot's lore is embedded after every
 *   write that can change it (`scheduleLoreEmbedding`), a chat's messages after
 *   every reply (`scheduleMessageEmbedding`), each with the plot's model
 *   (`embedder.modelFor(plot.language)`) and stored with it. A row of another
 *   model, or of text that has since changed, is stale: never compared, and
 *   embedded again — lazily, as HypaV3's summaries are.
 * - **A request searches once** (`searchByMeaning`): the newest turns embedded
 *   as one query (ST's `getQueryText`), then compared with the lore's vectors and
 *   the branch's in pgvector. It waits for the embedder no longer than
 *   `QUERY_EMBED_TIMEOUT_MS`; any failure leaves the turn to its keywords and its
 *   history, and the generation goes on.
 *
 * Everything here swallows its own failures.
 */
import {
  isVectorLoreCandidate,
  RETRIEVAL_DEFAULTS,
  retrievalBlock,
  retrievalChunks,
  retrievalEnabled,
  stripImageMacros,
  transcriptLine,
  VECTOR_LORE,
  vectorQueryText,
  type LoreEntry,
  type LoreSettings,
  type PlotModule,
  type PromptCharacter,
  type ReaderMember,
} from '@shizue/core';
import { characters, chats, loreEntryVectors, messageChunks, messages, plots, type ContentLanguage, type Message } from '@shizue/db';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { AppDeps } from './deps.js';
import type { Embedder, Embedding } from './embedder.js';
import { buildPath, visibleToAi } from './tree.js';

/** How long a request waits to embed its query before it goes on without the search. */
const QUERY_EMBED_TIMEOUT_MS = 3_000;
/**
 * Texts per background embedding call. Small, so a request's query — which waits
 * behind whatever batch the thread is running — is never kept past its deadline.
 */
const BACKGROUND_BATCH = 8;
/** Passes one guarded job runs at most when it is asked again while it runs. */
const MAX_PASSES = 3;

/** The key a text's vectors are stored under: what was embedded, not where it sits. */
export const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** What a generation needs for the search, from its chat and plot (`readerPromptSettings`). */
export interface VectorPlan {
  plotId: string;
  plotLanguage: ContentLanguage;
  /** The chat's retrieval is on (`chats.retrieval`). */
  retrieval: boolean;
}

/** What the search found for one request. */
export interface VectorSearch {
  /** The lore entries to activate by meaning, as `AssemblePromptInput.vectorLore` asks. */
  vectorLore?: (entry: LoreEntry) => boolean;
  /** The found messages in ST's template (`retrievalBlock`). */
  retrievalText?: string;
  /** Their ids: the history leaves them out, as ST takes them out of the chat it sends. */
  retrieved: ReadonlySet<string>;
}

const NOTHING: VectorSearch = { retrieved: new Set() };

/* ------------------------------------------------------------------ guard */

/**
 * Runs `work` in the background, one pass per key at a time. A pass asked for
 * while one runs is not dropped: the running one goes again once it ends, so a
 * save that lands mid-pass is embedded too.
 */
function runGuarded(deps: AppDeps, key: string, work: () => Promise<void>): void {
  if (deps.embeddingVectors.has(key)) {
    deps.embeddingVectors.set(key, 'again');
    return;
  }
  deps.embeddingVectors.set(key, 'running');
  const task = (async () => {
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      deps.embeddingVectors.set(key, 'running');
      await work();
      if (deps.embeddingVectors.get(key) !== 'again') break;
    }
  })()
    .catch((error: unknown) => {
      console.error(`[vectors] ${key} failed`, error);
    })
    .finally(() => deps.embeddingVectors.delete(key));
  deps.onBackgroundTask?.(task, 'vectors');
}

/** Embeds `texts` as documents in calls of `BACKGROUND_BATCH`, or null once the embedder fails. */
async function embedDocuments(
  embedder: Embedder,
  texts: readonly string[],
  plotLanguage: ContentLanguage,
): Promise<Embedding | null> {
  const vectors: number[][] = [];
  let model = '';
  for (let at = 0; at < texts.length; at += BACKGROUND_BATCH) {
    try {
      const embedded = await embedder.embed(texts.slice(at, at + BACKGROUND_BATCH), { plotLanguage, kind: 'document' });
      model = embedded.model;
      vectors.push(...embedded.vectors);
    } catch (error) {
      console.warn('[vectors] embedding failed; it is tried again on the next pass', error);
      return null;
    }
  }
  return { model, vectors };
}

/* ------------------------------------------------------------------- lore */

/**
 * Every lore entry the work holds — its own book, its members' and its
 * modules' — and the book's settings, which are its first member's.
 */
function workLore(
  lorebook: readonly LoreEntry[],
  members: readonly { card: { lorebook: LoreEntry[]; loreSettings: LoreSettings } }[],
  modules: readonly PlotModule[] | undefined,
): { entries: LoreEntry[]; settings: LoreSettings | undefined } {
  return {
    entries: [...lorebook, ...members.flatMap((member) => member.card.lorebook), ...(modules ?? []).flatMap((module) => module.lorebook)],
    settings: members[0]?.card.loreSettings,
  };
}

/** The contents to embed, by hash: each candidate's, once. */
function candidateContents(entries: readonly LoreEntry[], settings: LoreSettings | undefined): Map<string, string> {
  const contents = new Map<string, string>();
  for (const entry of entries) {
    if (isVectorLoreCandidate(entry, settings)) contents.set(textHash(entry.content), entry.content);
  }
  return contents;
}

/**
 * Embeds the plot's lore that activates by meaning and has no vector of the
 * plot's model yet, and lets go of the rows no entry says any more. Called
 * after every write that can change the lore — the plot's book, a member's
 * card, the roster's order (the first member's settings are the book's), a
 * module — and by a request that found an entry without one.
 */
export function scheduleLoreEmbedding(deps: AppDeps, plotId: string): void {
  if (!deps.embedder) return;
  runGuarded(deps, `lore:${plotId}`, () => embedPlotLore(deps, plotId));
}

async function embedPlotLore(deps: AppDeps, plotId: string): Promise<void> {
  const embedder = deps.embedder;
  if (!embedder) return;
  const [plot] = await deps.db
    .select({ language: plots.language, lorebook: plots.lorebook, customUi: plots.customUi })
    .from(plots)
    .where(eq(plots.id, plotId))
    .limit(1);
  const model = plot ? embedder.modelFor(plot.language) : null;
  if (!plot || !model) return;
  const members = await deps.db
    .select({ card: characters.card })
    .from(characters)
    .where(eq(characters.plotId, plotId))
    .orderBy(asc(characters.orderIndex), asc(characters.createdAt));
  const { entries, settings } = workLore(plot.lorebook, members, plot.customUi?.modules);
  const contents = candidateContents(entries, settings);

  // What no entry says any more goes, whatever model made it.
  await deps.db
    .delete(loreEntryVectors)
    .where(
      contents.size > 0
        ? and(eq(loreEntryVectors.plotId, plotId), notInArray(loreEntryVectors.contentHash, [...contents.keys()]))
        : eq(loreEntryVectors.plotId, plotId),
    );
  if (contents.size === 0) return;

  const current = await deps.db
    .select({ hash: loreEntryVectors.contentHash })
    .from(loreEntryVectors)
    .where(and(eq(loreEntryVectors.plotId, plotId), eq(loreEntryVectors.model, model)));
  const done = new Set(current.map((row) => row.hash));
  const pending = [...contents].filter(([hash]) => !done.has(hash));
  if (pending.length === 0) return;

  const embedded = await embedDocuments(
    embedder,
    pending.map(([, content]) => content),
    plot.language,
  );
  if (!embedded) return;
  await deps.db
    .insert(loreEntryVectors)
    .values(
      pending.map(([contentHash, content], at) => ({
        plotId,
        contentHash,
        content,
        model: embedded.model,
        embedding: embedded.vectors[at]!,
      })),
    )
    .onConflictDoUpdate({
      target: [loreEntryVectors.plotId, loreEntryVectors.contentHash],
      set: {
        content: sql`excluded.content`,
        model: sql`excluded.model`,
        embedding: sql`excluded.embedding`,
      },
    });
}

/* --------------------------------------------------------------- messages */

/**
 * Embeds the messages on the chat's branch that have no vectors of its plot's
 * model for their current text, when the chat's retrieval is on — after every
 * reply, and when the reader turns it on. Oldest first, as ST vectorizes, in
 * ST's 400-character chunks; a message hidden from the AI is left out, as ST
 * leaves out `is_system` ones. Each branch's messages are embedded while it is
 * the one being read.
 */
export function scheduleMessageEmbedding(deps: AppDeps, chatId: string): void {
  if (!deps.embedder) return;
  runGuarded(deps, `chat:${chatId}`, () => embedChatMessages(deps, chatId));
}

async function embedChatMessages(deps: AppDeps, chatId: string): Promise<void> {
  const embedder = deps.embedder;
  if (!embedder) return;
  const [chat] = await deps.db
    .select({ retrieval: chats.retrieval, head: chats.headMessageId, language: plots.language })
    .from(chats)
    .innerJoin(plots, eq(chats.plotId, plots.id))
    .where(eq(chats.id, chatId))
    .limit(1);
  const model = chat && retrievalEnabled(chat.retrieval) ? embedder.modelFor(chat.language) : null;
  if (!chat || !model) return;
  const all = await deps.db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.createdAt));
  const path = visibleToAi(buildPath(all, chat.head));
  if (path.length === 0) return;

  const first = await deps.db
    .select({ messageId: messageChunks.messageId, contentHash: messageChunks.contentHash })
    .from(messageChunks)
    .where(
      and(
        inArray(
          messageChunks.messageId,
          path.map((message) => message.id),
        ),
        eq(messageChunks.chunkIndex, 0),
        eq(messageChunks.model, model),
      ),
    );
  const done = new Set(first.map((row) => `${row.messageId}:${row.contentHash}`));
  const pending = path
    .map((message) => ({ message, hash: textHash(message.content), chunks: retrievalChunks(stripImageMacros(message.content)) }))
    .filter(({ message, hash, chunks }) => chunks.length > 0 && !done.has(`${message.id}:${hash}`));

  // A few messages to a call, so no call holds the thread for long.
  for (let at = 0; at < pending.length; ) {
    const batch: typeof pending = [];
    let size = 0;
    while (at < pending.length && (batch.length === 0 || size + pending[at]!.chunks.length <= BACKGROUND_BATCH)) {
      size += pending[at]!.chunks.length;
      batch.push(pending[at]!);
      at += 1;
    }
    const embedded = await embedDocuments(
      embedder,
      batch.flatMap(({ chunks }) => chunks),
      chat.language,
    );
    if (!embedded) return;
    let offset = 0;
    for (const { message, hash, chunks } of batch) {
      const vectors = embedded.vectors.slice(offset, offset + chunks.length);
      offset += chunks.length;
      await deps.db.transaction(async (tx) => {
        // A message edited meanwhile is embedded again on the next pass.
        const [current] = await tx
          .select({ content: messages.content })
          .from(messages)
          .where(eq(messages.id, message.id))
          .for('update');
        if (current?.content !== message.content) return;
        await tx.delete(messageChunks).where(eq(messageChunks.messageId, message.id));
        await tx.insert(messageChunks).values(
          chunks.map((content, chunkIndex) => ({
            messageId: message.id,
            chunkIndex,
            contentHash: hash,
            content,
            model: embedded.model,
            embedding: vectors[chunkIndex]!,
          })),
        );
      });
    }
  }
}

/* ----------------------------------------------------------------- search */

/** pgvector's cosine similarity of a column with a vector. */
const similarity = (column: typeof loreEntryVectors.embedding | typeof messageChunks.embedding, vector: number[]) =>
  sql<number>`1 - (${column} <=> ${JSON.stringify(vector)}::vector)`;

/**
 * The search a request runs before its prompt is put together: one query from
 * the newest turns the model may read, for the lore that activates by meaning
 * and for the chat's earlier messages. Nothing to search — no marked entry, the
 * retrieval off — asks nothing of the embedder. Never throws.
 */
export async function searchByMeaning(
  deps: AppDeps,
  input: {
    vectors: VectorPlan | undefined;
    plot: { lorebook: LoreEntry[]; modules?: readonly PlotModule[] };
    characters: readonly PromptCharacter[];
    /** The whole branch the turn is generated on, as stored. */
    branch: readonly Message[];
    userName: string;
  },
): Promise<VectorSearch> {
  const { vectors, branch } = input;
  const embedder = deps.embedder;
  const model = vectors && embedder ? embedder.modelFor(vectors.plotLanguage) : null;
  if (!vectors || !embedder || !model) return NOTHING;

  // The lore the assembler will read: the work's, the members on the stage's —
  // not the chat's own, which its scripts write — under the first member's settings.
  const onStage = input.characters.filter((member) => !member.absent);
  const { entries } = workLore(input.plot.lorebook, onStage, input.plot.modules);
  const contents = candidateContents(entries, input.characters[0]?.card.loreSettings);

  // ST's `coreChat`: what the model may read. Too short a chat brings nothing
  // back — every message of it is protected.
  const visible = visibleToAi(branch);
  const eligible = vectors.retrieval && visible.length >= RETRIEVAL_DEFAULTS.protect
    ? visible.slice(0, -RETRIEVAL_DEFAULTS.protect)
    : [];
  if (contents.size === 0 && eligible.length === 0) return NOTHING;
  // ST's query counts are one setting for both, so one query serves both.
  const query = vectorQueryText(
    visible.map((message) => stripImageMacros(message.content)),
    Math.max(VECTOR_LORE.query, RETRIEVAL_DEFAULTS.query),
  );
  if (!query) return NOTHING;

  let vector: number[];
  try {
    const embedded = await embedder.embed([query], {
      plotLanguage: vectors.plotLanguage,
      kind: 'query',
      timeoutMs: QUERY_EMBED_TIMEOUT_MS,
    });
    if (embedded.model !== model || !embedded.vectors[0]) return NOTHING;
    vector = embedded.vectors[0];
  } catch (error) {
    console.warn('[vectors] the search could not embed its query; lore by keyword only, no retrieval', error);
    return NOTHING;
  }

  try {
    const [found, retrieval] = await Promise.all([
      contents.size > 0 ? activatedLore(deps, vectors.plotId, model, contents, vector) : null,
      eligible.length > 0 ? retrievedMessages(deps, model, eligible, vector, input) : null,
    ]);
    return {
      ...(found ? { vectorLore: (entry: LoreEntry) => isVectorLoreCandidate(entry, input.characters[0]?.card.loreSettings) && found.has(textHash(entry.content)) } : {}),
      ...(retrieval?.text ? { retrievalText: retrieval.text } : {}),
      retrieved: retrieval?.ids ?? new Set(),
    };
  } catch (error) {
    console.warn('[vectors] the search failed; lore by keyword only, no retrieval', error);
    return NOTHING;
  }
}

/**
 * ST's `activateWorldInfo` over the one book: every candidate's similarity to
 * the query, the `maxEntries` best at or above the threshold. A candidate with
 * no vector of the model yet is not found this time; the plot's lore is
 * embedded again for the next.
 */
async function activatedLore(
  deps: AppDeps,
  plotId: string,
  model: string,
  contents: ReadonlyMap<string, string>,
  vector: number[],
): Promise<Set<string>> {
  const score = similarity(loreEntryVectors.embedding, vector);
  const rows = await deps.db
    .select({ hash: loreEntryVectors.contentHash, score })
    .from(loreEntryVectors)
    .where(
      and(
        eq(loreEntryVectors.plotId, plotId),
        eq(loreEntryVectors.model, model),
        inArray(loreEntryVectors.contentHash, [...contents.keys()]),
      ),
    );
  if (rows.length < contents.size) scheduleLoreEmbedding(deps, plotId);
  return new Set(
    rows
      .map((row) => ({ hash: row.hash, score: Number(row.score) }))
      .sort((a, b) => b.score - a.score)
      .filter((row) => row.score >= VECTOR_LORE.scoreThreshold)
      .slice(0, VECTOR_LORE.maxEntries)
      .map((row) => row.hash),
  );
}

/**
 * ST's `rearrangeChat` over the branch: the `insert` chunks most like the query
 * among the messages it may bring back — on this branch, not hidden, older than
 * the protected tail, their vectors made from the text they still hold — at or
 * above the threshold, each text once, as ST keys messages by their text. Sent
 * least relevant first, so the most relevant stands nearest the turns.
 */
async function retrievedMessages(
  deps: AppDeps,
  model: string,
  eligible: readonly Message[],
  vector: number[],
  input: { characters: readonly PromptCharacter[]; userName: string },
): Promise<{ text: string; ids: Set<string> }> {
  const score = similarity(messageChunks.embedding, vector);
  // Every id and hash is a uuid or hex, so the array literals need no quoting.
  const ids = `{${eligible.map((message) => message.id).join(',')}}`;
  const hashes = `{${eligible.map((message) => textHash(message.content)).join(',')}}`;
  const rows = await deps.db
    .select({ messageId: messageChunks.messageId })
    .from(messageChunks)
    .where(
      and(
        eq(messageChunks.model, model),
        sql`(${messageChunks.messageId}, ${messageChunks.contentHash}) in (select * from unnest(${ids}::uuid[], ${hashes}::text[]))`,
        sql`${score} >= ${RETRIEVAL_DEFAULTS.scoreThreshold}`,
      ),
    )
    .orderBy(desc(score))
    .limit(RETRIEVAL_DEFAULTS.insert);

  // ST finds texts, not messages: each text found, most relevant first, goes in
  // as the earliest message of the branch that says it.
  const byId = new Map(eligible.map((message) => [message.id, message]));
  const texts = [...new Set(rows.flatMap(({ messageId }) => byId.get(messageId)?.content ?? []))];
  const found = texts.map((text) => eligible.find((message) => message.content === text)!);
  if (found.length === 0) return { text: '', ids: new Set() };

  const readers: ReaderMember[] = input.characters.flatMap((member) =>
    member.id
      ? [{ id: member.id, names: [member.name, ...(member.card.nickname?.trim() ? [member.card.nickname.trim()] : [])] }]
      : [],
  );
  const names = new Map(input.characters.flatMap((member) => (member.id ? [[member.id, member.name] as const] : [])));
  const lines = [...found].reverse().map((message) =>
    transcriptLine(
      message,
      input.userName,
      message.speakerMemberId !== null ? names.get(message.speakerMemberId) : undefined,
      readers,
    ),
  );
  return { text: retrievalBlock(lines), ids: new Set(found.map((message) => message.id)) };
}
