/**
 * SillyTavern's chat vectorization on the server embedder (@shizue/core
 * `vectors.ts`, ARCHITECTURE §7.3): a chat's earlier messages brought back by
 * meaning. Off until the chat's `retrieval` is on, and costs nothing until then.
 * No lore entry activates by meaning (removed 2026-10-16): lore goes by its keys
 * and its Korean aliases alone.
 *
 * - **Embedding is background work.** A chat's messages are embedded after
 *   every reply (`scheduleMessageEmbedding`) with the plot's model
 *   (`embedder.modelFor(plot.language)`) and stored with it. A row of another
 *   model, or of text that has since changed, is stale: never compared, and
 *   embedded again — lazily, as HypaV3's summaries are.
 * - **A request searches once** (`searchByMeaning`): the newest turns embedded
 *   as one query (ST's `getQueryText`), then compared with the branch's in
 *   pgvector. It waits for the embedder no longer than
 *   `QUERY_EMBED_TIMEOUT_MS`; any failure leaves the turn to its history, and
 *   the generation goes on.
 *   The messages are found by the newest turn's words too (BM25, core
 *   `lexical.ts`), fused with the search by meaning by reciprocal rank.
 * - **The Korean aliases are scheduled here too** (`scheduleLoreAliases`), on
 *   the same guard, so a plot's alias pass runs once at a time.
 *
 * Everything here swallows its own failures.
 */
import {
  detectContentLanguage,
  hybridRanking,
  lexicalRanking,
  RETRIEVAL_DEFAULTS,
  retrievalBlock,
  retrievalChunks,
  retrievalEnabled,
  stripImageMacros,
  transcriptLine,
  turnsAgoLabel,
  vectorQueryText,
  withTimeLabel,
  type LoreAliases,
  type LoreEntry,
  type PlotModule,
  type PromptCharacter,
  type ReaderMember,
} from '@shizue/core';
import { chats, messageChunks, messages, plots, type ContentLanguage, type Message } from '@shizue/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { AppDeps, BackgroundTaskKind } from './deps.js';
import type { Embedder, Embedding } from './embedder.js';
import { aliasPlotLore, loreAliasesEnabled, loreAliasesFor } from './loreAliases.js';
import { noteLexicalSearch } from './lexicalHealth.js';
import { LANGUAGE_TURNS, type AuxiliaryOwner } from './memory.js';
import { buildPath, roundsAlong, visibleToAi } from './tree.js';

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
  /** The chat's reader, on whose auxiliary model a search that finds aliases missing starts the pass. */
  userId?: string;
  plotLanguage: ContentLanguage;
  /**
   * The reader's language in the `instruct` mode: the turns are in it, the lore
   * in the plot's. What the aliases go by. Absent in the other modes.
   */
  conversationLanguage?: ContentLanguage;
  /** The chat's own auxiliary model pick (`chats.sub_model`), for an alias pass its search starts. */
  subModel?: string | null;
  /** The chat's retrieval is on (`chats.retrieval`). */
  retrieval: boolean;
}

/** What the search found for one request. */
export interface VectorSearch {
  /** The entries' Korean aliases, as `AssemblePromptInput.loreAliases` asks (`loreAliases.ts`). */
  loreAliases?: (entry: LoreEntry) => LoreAliases | undefined;
  /** The found messages in ST's template (`retrievalBlock`), copies of messages the history does not send. */
  retrievalText?: string;
}

const NOTHING: VectorSearch = {};

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

/** Every lore entry the work holds: its own book, its members' and its modules'. */
function workLore(
  lorebook: readonly LoreEntry[],
  members: readonly { card: { lorebook: LoreEntry[] } }[],
  modules: readonly PlotModule[] | undefined,
): LoreEntry[] {
  return [...lorebook, ...members.flatMap((member) => member.card.lorebook), ...(modules ?? []).flatMap((module) => module.lorebook)];
}

/** The plot's Korean alias pass (`loreAliases.ts` `aliasPlotLore`) on `owner`'s auxiliary model, one at a time per plot. */
export function scheduleLoreAliases(deps: AppDeps, plotId: string, owner: AuxiliaryOwner): void {
  if (!loreAliasesEnabled(deps.env)) return;
  runGuarded(
    deps,
    `aliases:${plotId}`,
    async () => {
      await aliasPlotLore(deps, plotId, owner);
    },
    'aliases',
  );
}

/** What a write that can change a plot's lore starts: its aliases, on its creator's auxiliary model. */
export function scheduleLoreUpdate(deps: AppDeps, plotId: string, ownerId: string): void {
  scheduleLoreAliases(deps, plotId, { userId: ownerId, subModel: null });
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
const similarity = (column: typeof messageChunks.embedding, vector: number[]) =>
  sql<number>`1 - (${column} <=> ${JSON.stringify(vector)}::vector)`;

/**
 * The search a request runs before its prompt is put together: one query from
 * the newest turns the model may read, for the chat's earlier messages. With
 * the retrieval off it asks nothing of the embedder. The book's Korean aliases
 * come with it (`loreAliasesFor`), embedder or not, and a keyed entry without
 * them yet starts the plot's alias pass on the reader's auxiliary model. Never
 * throws.
 */
export async function searchByMeaning(
  deps: AppDeps,
  input: {
    vectors: VectorPlan | undefined;
    plot: { lorebook: LoreEntry[]; modules?: readonly PlotModule[] };
    characters: readonly PromptCharacter[];
    /** The whole branch the turn is generated on, as stored. */
    branch: readonly Message[];
    /** The ids of the history the prompt sends verbatim: none of it is brought back again. */
    sent: ReadonlySet<string>;
    userName: string;
    /** The turn the time labels count back from: the memory's for this generation (`MemoryInput.clock`). */
    clock: number;
  },
): Promise<VectorSearch> {
  const { vectors, branch, sent } = input;
  if (!vectors) return NOTHING;
  // The lore the assembler will read, for its aliases: the work's, the members
  // on the stage's — not the chat's own, which its scripts write.
  const onStage = input.characters.filter((member) => !member.absent);
  const entries = workLore(input.plot.lorebook, onStage, input.plot.modules);

  const aliases = await loreAliasesFor(deps, vectors, entries);
  if (aliases?.pending && vectors.userId) {
    scheduleLoreAliases(deps, vectors.plotId, { userId: vectors.userId, subModel: vectors.subModel ?? null });
  }
  const none: VectorSearch = aliases ? { loreAliases: aliases.lookup } : NOTHING;

  const embedder = deps.embedder;
  const model = embedder ? embedder.modelFor(vectors.plotLanguage) : null;
  if (!embedder || !model) return none;

  // ST's `coreChat`: what the model may read. Too short a chat brings nothing
  // back — every message of it is protected. Nor does a message the history
  // sends anyway: what is brought back is a copy, of what the summaries cover.
  const visible = visibleToAi(branch);
  const eligible = vectors.retrieval && visible.length >= RETRIEVAL_DEFAULTS.protect
    ? visible.slice(0, -RETRIEVAL_DEFAULTS.protect).filter((message) => !sent.has(message.id))
    : [];
  if (eligible.length === 0) return none;
  const query = vectorQueryText(
    visible.map((message) => stripImageMacros(message.content)),
    RETRIEVAL_DEFAULTS.query,
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
    console.warn('[vectors] the search could not embed its query; no retrieval', error);
    return none;
  }

  try {
    const retrieval = await retrievedMessages(deps, model, eligible, vector, stripImageMacros(visible.at(-1)?.content ?? ''), input);
    return { ...none, ...(retrieval ? { retrievalText: retrieval } : {}) };
  } catch (error) {
    console.warn('[vectors] the search failed; no retrieval', error);
    return none;
  }
}

/** Chunks each side of the messages' search hands its fusion: enough to reach past the dense side's near-ties. */
const RETRIEVAL_CANDIDATES = 20;

/**
 * ST's `rearrangeChat` over the branch: the `insert` chunks most relevant to
 * the turn among the messages it may bring back — on this branch, not hidden,
 * older than the protected tail, not in the history sent — each text once, as
 * ST keys messages by their text. Sent least relevant first, so the most
 * relevant stands nearest the turns. Relevant is the fusion (`hybridRanking`,
 * ARCHITECTURE §7.3 단어 검색) of ST's search, the chunks most like the query at
 * or above its threshold whose vectors are of the text they still hold, and
 * BM25 over the same chunks for the newest turn (`turn`), with evidence only.
 * Unlike ST, nothing leaves the history: the block is a copy. Each line is led
 * by the time label the memory dates its summaries and facts with.
 */
async function retrievedMessages(
  deps: AppDeps,
  model: string,
  eligible: readonly Message[],
  vector: number[],
  turn: string,
  input: { characters: readonly PromptCharacter[]; userName: string; branch: readonly Message[]; clock: number },
): Promise<string> {
  const score = similarity(messageChunks.embedding, vector);
  // Every id and hash is a uuid or hex, so the array literals need no quoting.
  const ids = `{${eligible.map((message) => message.id).join(',')}}`;
  const hashes = `{${eligible.map((message) => textHash(message.content)).join(',')}}`;
  const rows = await deps.db
    .select({ messageId: messageChunks.messageId, chunkIndex: messageChunks.chunkIndex })
    .from(messageChunks)
    .where(
      and(
        eq(messageChunks.model, model),
        sql`(${messageChunks.messageId}, ${messageChunks.contentHash}) in (select * from unnest(${ids}::uuid[], ${hashes}::text[]))`,
        sql`${score} >= ${RETRIEVAL_DEFAULTS.scoreThreshold}`,
      ),
    )
    .orderBy(desc(score))
    .limit(RETRIEVAL_CANDIDATES);
  const dense = rows.map((row) => `${row.messageId}:${row.chunkIndex}`);
  const lexical = lexicalRanking(
    eligible.flatMap((message) =>
      retrievalChunks(stripImageMacros(message.content)).map((chunk, at) => [`${message.id}:${at}`, chunk] as const),
    ),
    turn,
  ).slice(0, RETRIEVAL_CANDIDATES);
  noteLexicalSearch('messages', lexical.length > 0);
  const chunks = hybridRanking(dense, lexical).slice(0, RETRIEVAL_DEFAULTS.insert);

  // ST finds texts, not messages: each text found, most relevant first, goes in
  // as the earliest message of the branch that says it.
  const byId = new Map(eligible.map((message) => [message.id, message]));
  const texts = [...new Set(chunks.flatMap((chunk) => byId.get(chunk.slice(0, chunk.lastIndexOf(':')))?.content ?? []))];
  const found = texts.map((text) => eligible.find((message) => message.content === text)!);
  if (found.length === 0) return '';

  const readers: ReaderMember[] = input.characters.flatMap((member) =>
    member.id
      ? [{ id: member.id, names: [member.name, ...(member.card.nickname?.trim() ? [member.card.nickname.trim()] : [])] }]
      : [],
  );
  const names = new Map(input.characters.flatMap((member) => (member.id ? [[member.id, member.name] as const] : [])));
  // Each dated as the memory dates its summaries and facts (`buildMemoryInput`):
  // the turn the message closes on the branch (`roundsAlong`), counted back from
  // the memory's own ten-turn clock (`clock`), in the language of the latest
  // turns — so an old value brought back reads as older than a newer fact.
  const rounds = roundsAlong(input.branch);
  const roundOf = new Map(input.branch.map((message, at) => [message.id, rounds[at]!]));
  const language = detectContentLanguage(
    visibleToAi(input.branch)
      .slice(-LANGUAGE_TURNS)
      .map((message) => stripImageMacros(message.content))
      .join('\n'),
  );
  const lines = [...found].reverse().map((message) =>
    withTimeLabel(
      transcriptLine(
        message,
        input.userName,
        message.speakerMemberId !== null ? names.get(message.speakerMemberId) : undefined,
        readers,
      ).trim(),
      turnsAgoLabel(input.clock - roundOf.get(message.id)!, language),
    ),
  );
  return retrievalBlock(lines);
}
