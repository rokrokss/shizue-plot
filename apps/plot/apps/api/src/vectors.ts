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
 * - **A reader's own lore is embedded apart** (`scheduleReaderLoreEmbedding`):
 *   what their scripts rewrote of a member's lore, and their library modules'
 *   lore, into rows of theirs (`reader_lore_vectors`) searched beside the
 *   work's — so an entry Lua rewrote is found by meaning too, and a search no
 *   longer asks the work's pass for a vector it can never make.
 * - **Which entries, and how near** (core `vectorLoreSearch`): what the entry
 *   or the book asks for, and — for a Korean reader in the `instruct` mode
 *   over a book without Korean keys — the keyed entries whose Korean aliases
 *   have not landed yet (`loreAliases.ts`), at the bar measured for the model
 *   and the language pair. A long entry is embedded in pieces (`loreChunks`)
 *   and scores its best piece's similarity; a pass sends its pieces shortest
 *   first.
 * - **The aliases are scheduled here too** (`scheduleLoreAliases`), on the
 *   same guard, so a plot's alias pass runs once at a time and its vectors are
 *   brought up to date when it ends.
 *
 * Everything here swallows its own failures.
 */
import {
  isVectorLoreCandidate,
  loreChunks,
  RETRIEVAL_DEFAULTS,
  retrievalBlock,
  retrievalChunks,
  retrievalEnabled,
  stripImageMacros,
  transcriptLine,
  VECTOR_LORE,
  vectorLoreSearch,
  vectorQueryText,
  type LoreEntry,
  type LoreSettings,
  type PlotModule,
  type PromptCharacter,
  type ReaderMember,
  type VectorLoreBar,
} from '@shizue/core';
import { overlaidCard } from '@shizue/core/triggers';
import {
  characters,
  chats,
  loreEntryVectors,
  messageChunks,
  messages,
  plots,
  readerLoreVectors,
  readerModules,
  type ContentLanguage,
  type Message,
} from '@shizue/db';
import { and, asc, desc, eq, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { AppDeps, BackgroundTaskKind } from './deps.js';
import type { Embedder, Embedding } from './embedder.js';
import { aliasPlotLore, loadWorkLore, loreAliasesEnabled, loreAliasesFor } from './loreAliases.js';
import type { AuxiliaryOwner } from './memory.js';
import { loadReaderOverlay } from './scriptState.js';
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
/**
 * One chat in this many logs its lore search's best cosines across languages
 * (`activatedLore`), always the same chats — so the bar can be measured again
 * on real turns, which run longer than the experiment's.
 */
const COSINE_LOG_ONE_IN = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key a text's vectors are stored under: what was embedded, not where it sits. */
export const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** What a generation needs for the search, from its chat and plot (`readerPromptSettings`). */
export interface VectorPlan {
  plotId: string;
  /**
   * The chat's reader, whose own lore — members' lore their scripts rewrote,
   * their modules' — is embedded apart from the work's (`reader_lore_vectors`).
   */
  userId?: string;
  /** The chat, which decides whether its searches are among the logged ones. */
  chatId?: string;
  plotLanguage: ContentLanguage;
  /**
   * The reader's language in the `instruct` mode: the turns are in it, the lore
   * in the plot's. What the aliases and the bar go by. Absent in the other modes.
   */
  conversationLanguage?: ContentLanguage;
  /** The chat's own auxiliary model pick (`chats.sub_model`), for an alias pass its search starts. */
  subModel?: string | null;
  /** The chat's retrieval is on (`chats.retrieval`). */
  retrieval: boolean;
}

/** What the search found for one request. */
export interface VectorSearch {
  /** The lore entries to activate by meaning, as `AssemblePromptInput.vectorLore` asks. */
  vectorLore?: (entry: LoreEntry) => boolean;
  /** The entries' Korean aliases, as `AssemblePromptInput.loreAliases` asks (`loreAliases.ts`). */
  loreAliases?: (entry: LoreEntry) => readonly string[] | undefined;
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
function runGuarded(deps: AppDeps, key: string, work: () => Promise<void>, kind: BackgroundTaskKind = 'vectors'): void {
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
      console.error(`[${kind}] ${key} failed`, error);
    })
    .finally(() => deps.embeddingVectors.delete(key));
  deps.onBackgroundTask?.(task, kind);
}

/**
 * Embeds `texts` as documents in calls of `BACKGROUND_BATCH`, or null once the
 * embedder fails. Lore goes through `embedLore`, which sorts it first.
 */
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

/** The candidates to embed, by the hash of their content: each content once, as its first entry says it. */
function candidateContents(entries: readonly LoreEntry[], candidate: (entry: LoreEntry) => boolean): Map<string, LoreEntry> {
  const contents = new Map<string, LoreEntry>();
  for (const entry of entries) {
    const hash = textHash(entry.content);
    if (candidate(entry) && !contents.has(hash)) contents.set(hash, entry);
  }
  return contents;
}

/** A stored lore vector row, as the passes compare it with what an entry cuts into now. */
interface StoredPiece {
  hash: string;
  chunkIndex: number;
  content: string;
}

/**
 * The candidates whose stored pieces of the model are not the ones they cut
 * into now (`loreChunks`) — none yet, a whole-entry row from before entries
 * were cut, another header — each with the pieces to embed.
 */
function pendingLore(
  contents: ReadonlyMap<string, LoreEntry>,
  stored: readonly StoredPiece[],
): { hash: string; chunks: string[] }[] {
  const held = new Map<string, string[]>();
  for (const row of stored) {
    const pieces = held.get(row.hash) ?? [];
    pieces[row.chunkIndex] = row.content;
    held.set(row.hash, pieces);
  }
  const pending: { hash: string; chunks: string[] }[] = [];
  for (const [hash, entry] of contents) {
    const chunks = loreChunks(entry);
    const pieces = held.get(hash);
    if (pieces?.length === chunks.length && chunks.every((chunk, at) => pieces[at] === chunk)) continue;
    pending.push({ hash, chunks });
  }
  return pending;
}

/** Rows a lore pass writes at a time: each holds a vector, so a book's worth is written in slices. */
const LORE_ROWS_PER_INSERT = 64;

/**
 * The entries a plot's lore passes keep vectors of: what is asked for, and —
 * the work being read in another language — what the search stands in for
 * until the aliases land, as it would for a Korean reader in the `instruct`
 * mode (`vectorLoreSearch`). `book` is everything the search judges the book
 * on; the pass takes the candidates among its own entries.
 */
async function storedCandidates(
  deps: AppDeps,
  plotId: string,
  plotLanguage: ContentLanguage,
  model: string,
  book: readonly LoreEntry[],
  settings: LoreSettings | undefined,
): Promise<{ keep: (entry: LoreEntry) => boolean; asked: (entry: LoreEntry) => boolean }> {
  const asked = (entry: LoreEntry): boolean => isVectorLoreCandidate(entry, settings);
  const reader = plotLanguage === 'ko' ? undefined : ('ko' as const);
  const aliases = reader ? await loreAliasesFor(deps, { plotId, plotLanguage, conversationLanguage: reader }, book) : null;
  const search = vectorLoreSearch({
    model,
    entries: book,
    settings,
    ...(reader ? { crossLanguage: reader } : {}),
    ...(aliases ? { aliased: aliases.aliased } : {}),
  });
  return { keep: search?.candidate ?? asked, asked };
}

/**
 * Embeds the pieces of the pending lore (`pendingLore`) for storage, shortest
 * first so a batch is padded to a neighbour's length rather than the book's
 * longest — and none is longer than a chunk. The rows come back in the order
 * of `pending`, its pieces in order.
 */
async function embedLore(
  embedder: Embedder,
  pending: readonly { hash: string; chunks: string[] }[],
  plotLanguage: ContentLanguage,
): Promise<{ model: string; rows: (StoredPiece & { embedding: number[] })[] } | null> {
  const pieces = pending.flatMap(({ hash, chunks }) => chunks.map((content, chunkIndex) => ({ hash, chunkIndex, content })));
  const texts = pieces.map((piece) => piece.content);
  const order = texts.map((_, at) => at).sort((a, b) => texts[a]!.length - texts[b]!.length);
  const embedded = await embedDocuments(
    embedder,
    order.map((at) => texts[at]!),
    plotLanguage,
  );
  if (!embedded) return null;
  const vectors: number[][] = new Array(texts.length);
  order.forEach((at, position) => {
    vectors[at] = embedded.vectors[position]!;
  });
  return { model: embedded.model, rows: pieces.map((piece, at) => ({ ...piece, embedding: vectors[at]! })) };
}

/**
 * Embeds the plot's lore that activates by meaning and has no vector of the
 * plot's model yet, and lets go of the rows no entry says any more. Called
 * after every write that can change the lore — the plot's book, a member's
 * card, the roster's order (the first member's settings are the book's), a
 * module — by a request that found an entry without one, and when the plot's
 * alias pass ends.
 */
export function scheduleLoreEmbedding(deps: AppDeps, plotId: string): void {
  if (!deps.embedder) return;
  runGuarded(deps, `lore:${plotId}`, () => embedPlotLore(deps, plotId));
}

/**
 * The plot's Korean alias pass (`loreAliases.ts` `aliasPlotLore`) on `owner`'s
 * auxiliary model, one at a time per plot, and its lore vectors brought up to
 * date when it wrote aliases or gave up — what the search stands in for has
 * changed, or waited for it in vain. A pass that is backing off changes nothing.
 */
export function scheduleLoreAliases(deps: AppDeps, plotId: string, owner: AuxiliaryOwner): void {
  if (!loreAliasesEnabled(deps.env)) return;
  runGuarded(
    deps,
    `aliases:${plotId}`,
    async () => {
      const result = await aliasPlotLore(deps, plotId, owner);
      if (result.written > 0 || result.skipped === 'failed' || result.skipped === 'no_model') {
        scheduleLoreEmbedding(deps, plotId);
      }
    },
    'aliases',
  );
}

/**
 * Everything a write that can change a plot's lore starts: its aliases, on its
 * creator's auxiliary model, and its vectors.
 */
export function scheduleLoreUpdate(deps: AppDeps, plotId: string, ownerId: string): void {
  scheduleLoreAliases(deps, plotId, { userId: ownerId, subModel: null });
  scheduleLoreEmbedding(deps, plotId);
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
  const { keep, asked } = await storedCandidates(deps, plotId, plot.language, model, entries, settings);
  const contents = candidateContents(entries, keep);

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
    .select({ hash: loreEntryVectors.contentHash, chunkIndex: loreEntryVectors.chunkIndex, content: loreEntryVectors.content })
    .from(loreEntryVectors)
    .where(and(eq(loreEntryVectors.plotId, plotId), eq(loreEntryVectors.model, model)));
  // While the plot's alias pass runs, what the search stands in for until the
  // aliases land waits for it — the pass asks for this one again as it ends —
  // so an import does not embed what its aliases are about to cover.
  const wanted = deps.embeddingVectors.has(`aliases:${plotId}`) ? candidateContents(entries, asked) : contents;
  const pending = pendingLore(wanted, current);
  if (pending.length === 0) return;

  const embedded = await embedLore(embedder, pending, plot.language);
  if (!embedded) return;
  await deps.db.transaction(async (tx) => {
    // An entry's pieces are replaced whole: a cut of fewer pieces leaves none of the old behind.
    await tx.delete(loreEntryVectors).where(
      and(
        eq(loreEntryVectors.plotId, plotId),
        inArray(
          loreEntryVectors.contentHash,
          pending.map(({ hash }) => hash),
        ),
      ),
    );
    for (let at = 0; at < embedded.rows.length; at += LORE_ROWS_PER_INSERT) {
      await tx
        .insert(loreEntryVectors)
        .values(
          embedded.rows.slice(at, at + LORE_ROWS_PER_INSERT).map((row) => ({
            plotId,
            contentHash: row.hash,
            chunkIndex: row.chunkIndex,
            content: row.content,
            model: embedded.model,
            embedding: row.embedding,
          })),
        )
        .onConflictDoUpdate({
          target: [loreEntryVectors.plotId, loreEntryVectors.contentHash, loreEntryVectors.chunkIndex],
          set: {
            content: sql`excluded.content`,
            model: sql`excluded.model`,
            embedding: sql`excluded.embedding`,
          },
        });
    }
  });
}

/**
 * Embeds the lore one reader's play on the plot holds and the work does not —
 * the members' lore as their scripts rewrote it (`plot_reader_overlays`, Lua's
 * and the triggers' lore edits) and the lore of their library modules on any of
 * their chats with it (`reader_modules`, `chats.modules`) — into rows of theirs
 * alone, and lets go of the rows of theirs no such entry says any more. What the
 * plot's own rows already hold is not embedded again. Asked for by a search
 * that met an entry with no vector (`activatedLore`), which is how a rewrite
 * the scripts made, or a module the reader turned on, comes to be searched.
 */
export function scheduleReaderLoreEmbedding(deps: AppDeps, userId: string, plotId: string): void {
  if (!deps.embedder) return;
  runGuarded(deps, `lore:${plotId}:${userId}`, () => embedReaderLore(deps, userId, plotId));
}

async function embedReaderLore(deps: AppDeps, userId: string, plotId: string): Promise<void> {
  const embedder = deps.embedder;
  if (!embedder) return;
  const [plot] = await deps.db.select({ language: plots.language }).from(plots).where(eq(plots.id, plotId)).limit(1);
  const model = plot ? embedder.modelFor(plot.language) : null;
  if (!plot || !model) return;
  const members = await deps.db
    .select({ id: characters.id, card: characters.card })
    .from(characters)
    .where(eq(characters.plotId, plotId))
    .orderBy(asc(characters.orderIndex), asc(characters.createdAt));
  const overlay = await loadReaderOverlay(deps.db, userId, plotId);
  // The reader's modules on any of their chats with the plot: on everywhere, or listed by one.
  const listed = await deps.db
    .select({ modules: chats.modules })
    .from(chats)
    .where(and(eq(chats.userId, userId), eq(chats.plotId, plotId), isNotNull(chats.modules)));
  const ids = [...new Set(listed.flatMap((chat) => chat.modules ?? []))].filter((id) => UUID.test(id));
  const modules = await deps.db
    .select({ module: readerModules.module })
    .from(readerModules)
    .where(
      and(
        eq(readerModules.userId, userId),
        ids.length > 0
          ? or(eq(readerModules.enabledGlobally, true), inArray(readerModules.id, ids))
          : eq(readerModules.enabledGlobally, true),
      ),
    );
  const rewritten = members.flatMap((member) => {
    const own = overlay?.members?.[member.id];
    return own?.lorebook ? overlaidCard(member.card, own).lorebook : [];
  });
  const entries = [...rewritten, ...modules.flatMap((row) => row.module.lorebook)];
  // The book is judged whole — the work's lore with the reader's — as the search judges it.
  const work = await loadWorkLore(deps, plotId);
  const { keep } = await storedCandidates(
    deps,
    plotId,
    plot.language,
    model,
    [...(work?.entries ?? []), ...entries],
    members[0]?.card.loreSettings,
  );
  const contents = candidateContents(entries, keep);
  if (contents.size > 0) {
    // What the work's own rows hold is searched there.
    const shared = await deps.db
      .select({ hash: loreEntryVectors.contentHash })
      .from(loreEntryVectors)
      .where(
        and(
          eq(loreEntryVectors.plotId, plotId),
          eq(loreEntryVectors.model, model),
          inArray(loreEntryVectors.contentHash, [...contents.keys()]),
        ),
      );
    for (const { hash } of shared) contents.delete(hash);
  }

  const mine = and(eq(readerLoreVectors.userId, userId), eq(readerLoreVectors.plotId, plotId));
  await deps.db
    .delete(readerLoreVectors)
    .where(contents.size > 0 ? and(mine, notInArray(readerLoreVectors.contentHash, [...contents.keys()])) : mine);
  if (contents.size === 0) return;

  const current = await deps.db
    .select({ hash: readerLoreVectors.contentHash, chunkIndex: readerLoreVectors.chunkIndex, content: readerLoreVectors.content })
    .from(readerLoreVectors)
    .where(and(mine, eq(readerLoreVectors.model, model)));
  const pending = pendingLore(contents, current);
  if (pending.length === 0) return;
  const embedded = await embedLore(embedder, pending, plot.language);
  if (!embedded) return;
  await deps.db.transaction(async (tx) => {
    await tx.delete(readerLoreVectors).where(
      and(
        mine,
        inArray(
          readerLoreVectors.contentHash,
          pending.map(({ hash }) => hash),
        ),
      ),
    );
    for (let at = 0; at < embedded.rows.length; at += LORE_ROWS_PER_INSERT) {
      await tx
        .insert(readerLoreVectors)
        .values(
          embedded.rows.slice(at, at + LORE_ROWS_PER_INSERT).map((row) => ({
            userId,
            plotId,
            contentHash: row.hash,
            chunkIndex: row.chunkIndex,
            content: row.content,
            model: embedded.model,
            embedding: row.embedding,
          })),
        )
        .onConflictDoUpdate({
          target: [readerLoreVectors.userId, readerLoreVectors.plotId, readerLoreVectors.contentHash, readerLoreVectors.chunkIndex],
          set: {
            content: sql`excluded.content`,
            model: sql`excluded.model`,
            embedding: sql`excluded.embedding`,
          },
        });
    }
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
const similarity = (
  column: typeof loreEntryVectors.embedding | typeof readerLoreVectors.embedding | typeof messageChunks.embedding,
  vector: number[],
) =>
  sql<number>`1 - (${column} <=> ${JSON.stringify(vector)}::vector)`;

/**
 * The search a request runs before its prompt is put together: one query from
 * the newest turns the model may read, for the lore that activates by meaning
 * and for the chat's earlier messages. Nothing to search — no candidate entry
 * (`vectorLoreSearch`), the retrieval off — asks nothing of the embedder. The
 * book's Korean aliases come with it (`loreAliasesFor`), embedder or not, and a
 * keyed entry without them yet starts the plot's alias pass on the reader's
 * auxiliary model. Never throws.
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
  if (!vectors) return NOTHING;
  // The lore the assembler will read: the work's, the members on the stage's —
  // not the chat's own, which its scripts write — under the first member's settings.
  const onStage = input.characters.filter((member) => !member.absent);
  const { entries } = workLore(input.plot.lorebook, onStage, input.plot.modules);
  const settings = input.characters[0]?.card.loreSettings;

  const aliases = await loreAliasesFor(deps, vectors, entries);
  if (aliases?.pending && vectors.userId) {
    scheduleLoreAliases(deps, vectors.plotId, { userId: vectors.userId, subModel: vectors.subModel ?? null });
  }
  const none: VectorSearch = aliases ? { ...NOTHING, loreAliases: aliases.lookup } : NOTHING;

  const embedder = deps.embedder;
  const model = embedder ? embedder.modelFor(vectors.plotLanguage) : null;
  if (!embedder || !model) return none;
  const lore = vectorLoreSearch({
    model,
    entries,
    settings,
    ...(vectors.conversationLanguage ? { crossLanguage: vectors.conversationLanguage } : {}),
    ...(aliases ? { aliased: aliases.aliased } : {}),
  });
  const contents = lore ? candidateContents(entries, lore.candidate) : new Map<string, LoreEntry>();

  // ST's `coreChat`: what the model may read. Too short a chat brings nothing
  // back — every message of it is protected.
  const visible = visibleToAi(branch);
  const eligible = vectors.retrieval && visible.length >= RETRIEVAL_DEFAULTS.protect
    ? visible.slice(0, -RETRIEVAL_DEFAULTS.protect)
    : [];
  if (contents.size === 0 && eligible.length === 0) return none;
  // ST's query counts are one setting for both, so one query serves both.
  const query = vectorQueryText(
    visible.map((message) => stripImageMacros(message.content)),
    Math.max(VECTOR_LORE.query, RETRIEVAL_DEFAULTS.query),
  );
  if (!query) return none;

  let vector: number[];
  try {
    const embedded = await embedder.embed([query], {
      plotLanguage: vectors.plotLanguage,
      kind: 'query',
      timeoutMs: QUERY_EMBED_TIMEOUT_MS,
    });
    if (embedded.model !== model || !embedded.vectors[0]) return none;
    vector = embedded.vectors[0];
  } catch (error) {
    console.warn('[vectors] the search could not embed its query; lore by keyword only, no retrieval', error);
    return none;
  }

  try {
    const [found, retrieval] = await Promise.all([
      lore && contents.size > 0 ? activatedLore(deps, vectors, model, contents, vector, lore) : null,
      eligible.length > 0 ? retrievedMessages(deps, model, eligible, vector, input) : null,
    ]);
    return {
      ...none,
      ...(found && lore ? { vectorLore: (entry: LoreEntry) => lore.candidate(entry) && found.has(textHash(entry.content)) } : {}),
      ...(retrieval?.text ? { retrievalText: retrieval.text } : {}),
      retrieved: retrieval?.ids ?? new Set(),
    };
  } catch (error) {
    console.warn('[vectors] the search failed; lore by keyword only, no retrieval', error);
    return none;
  }
}

/**
 * ST's `activateWorldInfo` over the one book: every candidate's similarity to
 * the query — its best piece's — the `maxEntries` best at or above the
 * threshold (`search.bar`) —
 * the work's rows and the reader's own (`reader_lore_vectors`) together. A
 * candidate with no vector of the model yet is not found this time; the plot's
 * lore and the reader's are embedded again for the next. Across languages, one
 * chat in `COSINE_LOG_ONE_IN` logs its best cosines (`logCosines`).
 */
async function activatedLore(
  deps: AppDeps,
  plan: Pick<VectorPlan, 'plotId' | 'userId' | 'chatId' | 'plotLanguage' | 'conversationLanguage'>,
  model: string,
  contents: ReadonlyMap<string, LoreEntry>,
  vector: number[],
  search: { bar: VectorLoreBar; fallback: boolean },
): Promise<Set<string>> {
  const { plotId, userId } = plan;
  const hashes = [...contents.keys()];
  // An entry scores its best piece's similarity.
  const [work, own] = await Promise.all([
    deps.db
      .select({ hash: loreEntryVectors.contentHash, score: sql<number>`max(${similarity(loreEntryVectors.embedding, vector)})` })
      .from(loreEntryVectors)
      .where(
        and(
          eq(loreEntryVectors.plotId, plotId),
          eq(loreEntryVectors.model, model),
          inArray(loreEntryVectors.contentHash, hashes),
        ),
      )
      .groupBy(loreEntryVectors.contentHash),
    userId
      ? deps.db
          .select({ hash: readerLoreVectors.contentHash, score: sql<number>`max(${similarity(readerLoreVectors.embedding, vector)})` })
          .from(readerLoreVectors)
          .where(
            and(
              eq(readerLoreVectors.userId, userId),
              eq(readerLoreVectors.plotId, plotId),
              eq(readerLoreVectors.model, model),
              inArray(readerLoreVectors.contentHash, hashes),
            ),
          )
          .groupBy(readerLoreVectors.contentHash)
      : Promise.resolve([]),
  ]);
  const scored = new Map<string, number>();
  for (const row of [...work, ...own]) scored.set(row.hash, Math.max(scored.get(row.hash) ?? -Infinity, Number(row.score)));
  if (scored.size < contents.size) {
    scheduleLoreEmbedding(deps, plotId);
    if (userId) scheduleReaderLoreEmbedding(deps, userId, plotId);
  }
  const ranked = [...scored].map(([hash, score]) => ({ hash, score })).sort((a, b) => b.score - a.score);
  const picked = ranked.filter((row) => row.score >= search.bar.scoreThreshold).slice(0, search.bar.maxEntries);
  logCosines(plan, model, ranked, picked.length, search);
  return new Set(picked.map((row) => row.hash));
}

/**
 * One line per search for a sample of the chats read across languages: the
 * best three cosines, the bar, what it kept, of how many candidates, and
 * whether it searched in place of aliases (`fallback`). The bar was set on
 * synthetic two-turn windows; these are real turns, to set it again on.
 */
function logCosines(
  plan: Pick<VectorPlan, 'chatId' | 'plotLanguage' | 'conversationLanguage'>,
  model: string,
  ranked: readonly { score: number }[],
  picked: number,
  search: { bar: VectorLoreBar; fallback: boolean },
): void {
  if (!plan.conversationLanguage || !plan.chatId) return;
  if (Number.parseInt(textHash(plan.chatId).slice(0, 8), 16) % COSINE_LOG_ONE_IN !== 0) return;
  console.log(
    `[vectors] lore cosines ${JSON.stringify({
      chat: plan.chatId,
      model,
      pair: `${plan.conversationLanguage}>${plan.plotLanguage}`,
      top: ranked.slice(0, 3).map((row) => Math.round(row.score * 1000) / 1000),
      bar: search.bar.scoreThreshold,
      picked,
      candidates: ranked.length,
      fallback: search.fallback,
    })}`,
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
