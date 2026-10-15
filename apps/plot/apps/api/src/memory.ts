/**
 * The chat memory: RisuAI's HypaV3 (see @shizue/core `memory.ts` and
 * ARCHITECTURE §7.3) on the server.
 *
 * - **Summaries are written in the background.** After a reply is done, the
 *   oldest messages a branch can no longer fit are summarized a batch at a time
 *   (`nextSummaryBatch`) by the chat's auxiliary model into `chat_summaries`,
 *   one per batch. Never while a request is being built: the request only
 *   selects, and the assembler's budget drops the oldest turns until a summary
 *   lands. An imported chat's backlog goes through the `memory_backfill` job.
 * - **A summary applies to a branch while every message it covers is on it.**
 *   The prompt's history starts after the last message an applying summary
 *   covers; editing, hiding or deleting a covered message deletes that summary
 *   only, and the stretch it covered is summarized again first.
 * - **Each request selects** (`selectSummaries`): the pinned ones, the most
 *   recent, the ones most similar to the latest turns — by the server
 *   embedder's vectors of the plot's model (`embedder.ts`), fused with BM25 over
 *   the newest turn (core `lexical.ts`) — and random ones,
 *   into a share of the context budget. Without an embedder for the plot's
 *   language the similar share goes to random ones.
 * - **Facts ride along** (`facts.ts`): each summary written has its facts
 *   extracted right after it, and each request adds the relevant ones as a
 *   `[기억]` block after the summaries, searched with the same query vectors.
 *
 * Everything in the update path is fire-and-forget: it runs after the SSE `done`
 * event and swallows its own failures.
 */
import {
  countTokens,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_FACT_COUNT,
  DEFAULT_USER_NAME,
  detectContentLanguage,
  factsBlock,
  fnv1a,
  hybridRanking,
  hypaV3SettingsOf,
  lexicalRanking,
  MEMORY_HEADING,
  memoryBlock,
  memoryClock,
  memoryTokenBudget,
  nextSummaryBatch,
  rankBySimilarity,
  replyLengthTokens,
  selectSummaries,
  similarityQueries,
  stripImageMacros,
  summarizationTurns,
  summaryChunks,
  SUMMARY_SEPARATOR,
  turnsAgoLabel,
  withTimeLabel,
  type BatchMessage,
  type HypaV3Settings,
  type SummaryBatch,
} from '@shizue/core';
import {
  chats,
  chatSummaries,
  chatSummaryChunks,
  messages,
  personas,
  plots,
  type Chat,
  type ChatSummary,
  type ContentLanguage,
  type JobPayloadMap,
  type Message,
} from '@shizue/db';
import { getAdapter, listEnabledModels, type ChatRequest, type LLMAdapter } from '@shizue/llm';
import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { AppDeps, Tx } from './deps.js';
import type { Embedding } from './embedder.js';
import { noteCachedTokens } from './cacheHealth.js';
import { embedPendingFacts, extractFacts, keepEndedFacts, selectFacts } from './facts.js';
import { loadMembers } from './hub.js';
import { enqueueJob } from './jobs.js';
import { noteLexicalSearch } from './lexicalHealth.js';
import { transcriptOf } from './transcript.js';
import { buildPath, roundsAlong, visibleToAi } from './tree.js';

/** What one summary call may write; HypaV3 does not cap it, the API needs a number. */
const SUMMARY_MAX_TOKENS = 1600;
/** Deadline for one background summary call, so a hung provider frees its slot. */
const MEMORY_TIMEOUT_MS = 60_000;
/** Summaries one finished turn's refresh writes at most; the next turn takes up the rest. */
export const REFRESH_BATCHES_PER_RUN = 3;
/** Summaries one `memory_backfill` run writes before a successor job takes over. */
export const BACKFILL_BATCHES_PER_RUN = 3;
/** How long a backfill stands back from a refresh a finished turn is already running. */
const BACKFILL_RETRY_MS = 30_000;
/** How long a request waits to embed its queries before the similar share goes to random ones. */
const QUERY_EMBED_TIMEOUT_MS = 3_000;
/** Summary chunks one refresh embeds at most, for summaries still without vectors of the current model. */
const CHUNKS_PER_REFRESH = 64;
/** Longest summary a reader may write. */
export const MAX_SUMMARY_LENGTH = 20_000;
/** The latest turns the conversation's language is read from, for the facts. */
const LANGUAGE_TURNS = 6;

/* --------------------------------------------------------------- settings */

export interface MemorySettings extends HypaV3Settings {
  contextBudget: number;
  /** Facts a request carries (`[기억]`); 0 turns the facts off, extraction included. */
  factCount: number;
}

/**
 * The knobs this chat runs the memory with — its own overrides where it has
 * them, HypaV3's defaults everywhere else. The values are validated when they
 * are written.
 */
export function memorySettingsOf(chat: Pick<Chat, 'memorySettings'>): MemorySettings {
  const { contextBudget, factCount, ...hypa } = chat.memorySettings ?? {};
  return {
    ...hypaV3SettingsOf(hypa),
    contextBudget: contextBudget ?? DEFAULT_CONTEXT_BUDGET,
    factCount: factCount ?? DEFAULT_FACT_COUNT,
  };
}

/* ------------------------------------------------------------ applicability */

/**
 * The summaries that apply to `path` — every message they cover is on it —
 * ordered by where their last message stands on it, and the index of the last
 * message any of them covers (-1: none). The prompt's history starts after it.
 */
export function applicableSummaries<S extends Pick<ChatSummary, 'messageIds'>>(
  summaries: readonly S[],
  path: readonly Pick<Message, 'id'>[],
): { applicable: S[]; frontier: number } {
  const index = new Map(path.map((message, at) => [message.id, at]));
  const placed = summaries
    .filter((summary) => summary.messageIds.length > 0 && summary.messageIds.every((id) => index.has(id)))
    .map((summary) => ({ summary, last: Math.max(...summary.messageIds.map((id) => index.get(id)!)) }));
  // Stable: two summaries ending on one message (a gap's and a neighbour's cannot,
  // but a pasted one could) keep the order they were made in.
  placed.sort((a, b) => a.last - b.last);
  return {
    applicable: placed.map(({ summary }) => summary),
    frontier: placed.reduce((max, { last }) => Math.max(max, last), -1),
  };
}

/** A chat's summaries, oldest first. */
export function loadSummaries(db: AppDeps['db'] | Tx, chatId: string): Promise<ChatSummary[]> {
  return db
    .select()
    .from(chatSummaries)
    .where(eq(chatSummaries.chatId, chatId))
    .orderBy(asc(chatSummaries.createdAt), asc(chatSummaries.id));
}

/* -------------------------------------------------------------- injection */

/**
 * Memory inputs for one generation: the memory block injected after the persona
 * — the selected summaries, then the facts (`[기억]`, `facts.ts`), each led by
 * a coarse "N turns ago" in the conversation's language — and the history the
 * model still sees verbatim: `path` after the last message an applying summary
 * covers.
 *
 * `answering` is the branch the reply answers, as the model will read it: the
 * latest `queryChatCount` of its turns are the similarity search's queries
 * (HypaV3's `chats.slice(-queryChatCount)`), embedded once for the summaries and
 * the facts alike. The random picks are drawn from the chat and the branch's
 * length, as `{{pick}}` is — a regenerate and the prompt inspector see the same
 * selection the turn did.
 */
export async function buildMemoryInput(
  deps: AppDeps,
  chat: Chat,
  path: Message[],
  answering: readonly Message[],
): Promise<{ memoryText: string; history: Message[] }> {
  const { applicable, frontier } = applicableSummaries(await loadSummaries(deps.db, chat.id), path);
  const history = path.slice(frontier + 1);
  if (applicable.length === 0) return { memoryText: '', history };

  const settings = memorySettingsOf(chat);
  const available = memoryTokenBudget(settings.contextBudget, settings) - countTokens(`${MEMORY_HEADING}\n`);
  const turns = visibleToAi(answering).map((message) => stripImageMacros(message.content));
  const queries = similarityQueries(turns, settings);

  // Each summary, and each fact by its summary, dated by how many turns ago its
  // last message stands (`turnsAgoLabel`, bucketed) from the memory's clock
  // (`memoryClock`, which moves every ten turns), in the language the
  // conversation runs in — the label counts against the share like the words.
  const rounds = roundsAlong(path);
  const now = memoryClock(rounds.at(-1) ?? 0);
  const position = new Map(path.map((message, at) => [message.id, at]));
  const language = detectContentLanguage(turns.slice(-LANGUAGE_TURNS).join('\n'));
  const labels = new Map(
    applicable.map((summary) => {
      const last = Math.max(...summary.messageIds.map((id) => position.get(id)!));
      return [summary.id, turnsAgoLabel(now - rounds[last]!, language)] as const;
    }),
  );
  const dated = (summary: ChatSummary): string => withTimeLabel(summary.text, labels.get(summary.id)!);
  const embedder = deps.embedder;
  const plotLanguage = embedder ? await plotLanguageOf(deps, chat.plotId) : null;
  const model = embedder && plotLanguage ? embedder.modelFor(plotLanguage) : null;
  // One embedding of the queries, made when the first search asks for it.
  let embedding: Promise<Embedding> | null = null;
  const queryVectors = (): Promise<Embedding> =>
    (embedding ??= embedder!.embed(queries, { plotLanguage: plotLanguage!, kind: 'query', timeoutMs: QUERY_EMBED_TIMEOUT_MS }));
  const selection = await selectSummaries(
    applicable.map((summary) => ({
      summary,
      important: summary.important,
      tokens: countTokens(dated(summary) + SUMMARY_SEPARATOR),
    })),
    available,
    settings,
    model ? (unused) => rankSimilar(deps, unused, queries, queryVectors) : null,
    seededRandom(`${chat.id}\u0000${answering.length}`),
  );
  let facts: string[] = [];
  if (model && queries.length > 0) {
    try {
      facts = await selectFacts(deps, {
        applicable,
        selected: selection.selected,
        model,
        queryVectors,
        turn: queries.at(-1)!,
        count: settings.factCount,
        line: (fact) => withTimeLabel(fact.content, labels.get(fact.summaryId)!),
      });
    } catch (error) {
      console.warn('[memory] the facts were left out: the queries could not be embedded', error);
    }
  }
  const blocks = [memoryBlock(selection.selected.map(dated)), factsBlock(facts)];
  return { memoryText: blocks.filter((block) => block !== '').join('\n\n'), history };
}

/** The plot's content language, which picks its embedding model; null for a plot that is gone. */
async function plotLanguageOf(deps: AppDeps, plotId: string): Promise<ContentLanguage | null> {
  const [plot] = await deps.db.select({ language: plots.language }).from(plots).where(eq(plots.id, plotId)).limit(1);
  return plot?.language ?? null;
}

/**
 * HypaV3's similar ranking over `unused`: the queries' vectors (the plot's
 * model, `queryVectors`), each chunk of that model scored by cosine in
 * pgvector, fused by `rankBySimilarity` — and then with the summaries' BM25
 * ranking for the newest turn (`lexicalRanking`, only those with evidence) by
 * reciprocal rank (`hybridRanking`, ARCHITECTURE §7.3 단어 검색). A summary
 * with no vectors of that model yet is ranked by its words alone, if at all
 * (the background refresh embeds it); none ranked by meaning, none ranked.
 * Throws when the embedder does, which hands the share to random ones.
 */
async function rankSimilar(
  deps: AppDeps,
  unused: ChatSummary[],
  queries: string[],
  queryVectors: () => Promise<Embedding>,
): Promise<ChatSummary[]> {
  if (unused.length === 0 || queries.length === 0) return [];
  const { model, vectors } = await queryVectors();
  const ids = unused.map((summary) => summary.id);
  const lists = await Promise.all(
    vectors.map(async (vector) => {
      const rows = await deps.db
        .select({
          summaryId: chatSummaryChunks.summaryId,
          chunkIndex: chatSummaryChunks.chunkIndex,
          score: sql<number>`1 - (${chatSummaryChunks.embedding} <=> ${JSON.stringify(vector)}::vector)`,
        })
        .from(chatSummaryChunks)
        .where(and(inArray(chatSummaryChunks.summaryId, ids), eq(chatSummaryChunks.model, model)));
      return rows.map((row) => [`${row.summaryId}:${row.chunkIndex}`, Number(row.score)] as const);
    }),
  );
  const byId = new Map(unused.map((summary) => [summary.id, summary]));
  const dense = rankBySimilarity(lists, (chunk: string) => chunk.slice(0, chunk.lastIndexOf(':')));
  if (dense.length === 0) return [];
  const lexical = lexicalRanking(
    unused.map((summary) => [summary.id, summary.text] as const),
    queries.at(-1)!,
  );
  noteLexicalSearch('memory', lexical.length > 0);
  return hybridRanking(dense, lexical)
    .map((id) => byId.get(id))
    .filter((summary): summary is ChatSummary => summary !== undefined);
}

/** mulberry32 over a string's FNV-1a: the same seed draws the same numbers. */
function seededRandom(seed: string): () => number {
  let state = fnv1a(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ update */

/**
 * What the chat's last request spent besides its history and memory
 * (`AssembledPrompt.fixedTokens`), by chat: how much history fits beside it,
 * which decides when to summarize. Kept in this process, newest last, for the
 * chats that generated lately; a chat it does not know counts 0.
 */
const fixedTokensOf = new Map<string, number>();
const MAX_REMEMBERED_CHATS = 10_000;

function rememberFixedTokens(chatId: string, tokens: number): void {
  fixedTokensOf.delete(chatId);
  fixedTokensOf.set(chatId, tokens);
  if (fixedTokensOf.size > MAX_REMEMBERED_CHATS) fixedTokensOf.delete(fixedTokensOf.keys().next().value!);
}

/** Records what a request the chat just sent spent besides history and memory (`fixedTokens`). */
export function noteRequestOverhead(chatId: string, fixedTokens: number): void {
  rememberFixedTokens(chatId, fixedTokens);
}

/**
 * Fire-and-forget memory refresh. Must only be called after the response is
 * done, or after a write that dropped summaries has committed: it reloads
 * everything itself and never propagates a failure.
 */
export function scheduleMemoryUpdate(deps: AppDeps, chatId: string): void {
  // One refresh per chat at a time. While a refresh runs the branch stays over
  // what fits, so every following turn would otherwise start a duplicate; there
  // is nothing to queue, the next completed turn reschedules.
  if (deps.refreshingMemory.has(chatId)) return;
  deps.refreshingMemory.add(chatId);

  const task = (async () => {
    let continuing = false;
    for (let pass = 0; pass < REFRESH_BATCHES_PER_RUN; pass += 1) {
      const result = await updateMemory(deps, chatId, continuing);
      continuing = result.continuing;
      if (!result.more) break;
    }
    await embedPendingSummaries(deps, chatId);
    await embedPendingFacts(deps, chatId);
  })()
    .catch((error: unknown) => {
      console.error('[memory] update failed', error);
    })
    .finally(() => deps.refreshingMemory.delete(chatId));
  deps.onBackgroundTask?.(task, 'memory');
}

/** One summary's worth of work: what it did, and whether a later pass has more to do. */
interface PassResult {
  /** Whether a later pass may have more to summarize (or an edit discarded this one's). */
  more: boolean;
  /** Whether the next pass continues a run past fitting, by `extraSummarizationRatio`. */
  continuing: boolean;
}

/**
 * One batch: the next summary the branch is due (`nextSummaryBatch`), written
 * by the chat's auxiliary model.
 */
async function updateMemory(deps: AppDeps, chatId: string, continuing: boolean): Promise<PassResult> {
  const nothing: PassResult = { more: false, continuing };
  const [row] = await deps.db
    .select({ chat: chats, personaName: personas.name, style: plots.style, plotLanguage: plots.language })
    .from(chats)
    .innerJoin(plots, eq(chats.plotId, plots.id))
    .leftJoin(personas, eq(chats.personaId, personas.id))
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!row) return nothing;
  const chat = row.chat;
  // Read-modify-write over a slow model call: remember the revision this refresh
  // snapshotted, so any edit landing in the meantime discards its result.
  const captured = chat.memoryRevision;

  const all = await deps.db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt));
  const path = buildPath(all, chat.headMessageId);
  const settings = memorySettingsOf(chat);
  const budget = {
    contextBudget: settings.contextBudget,
    responseReserve: replyLengthTokens(row.style?.replyLength),
    fixedTokens: fixedTokensOf.get(chatId) ?? 0,
  };
  const summaries = await loadSummaries(deps.db, chatId);
  const planned = planBatch(path, summaries, settings, budget, continuing);
  if (!planned) return nothing;
  const { batch, plan } = planned;

  const byId = new Map(path.map((message) => [message.id, message]));
  const summarized = batch.summarizedIds.map((id) => byId.get(id)!);
  const userName = row.personaName ?? DEFAULT_USER_NAME;
  // Where the batch stands on the branch, and the turns it covers.
  const position = new Map(path.map((message, at) => [message.id, at]));
  const rounds = roundsAlong(path);
  const first = position.get(batch.messageIds[0]!)!;
  const last = position.get(batch.messageIds.at(-1)!)!;
  const text = await summarize(deps, chat, {
    messages: summarized,
    userName,
    prompt: settings.summarizationPrompt,
  });
  if (!text) return nothing;

  const written = await deps.db.transaction(async (tx) => {
    // The revision is compared under the chat row's lock, which an edit's own
    // bump takes too: the two cannot interleave.
    const [current] = await tx
      .select({ revision: chats.memoryRevision })
      .from(chats)
      .where(eq(chats.id, chatId))
      .for('update');
    if (current?.revision !== captured) return null;
    const [summary] = await tx
      .insert(chatSummaries)
      .values({ chatId, text, messageIds: batch.messageIds, turnFrom: rounds[first]!, turnTo: rounds[last]! })
      .returning();
    return summary ?? null;
  });
  // The chat changed under this pass (an edit, a hide, a delete): the summary
  // describes history that no longer holds. The backlog is still there for the
  // next pass to read afresh.
  if (!written) return { more: true, continuing };

  // The facts of what it covers, from the same messages, by a call of their own
  // (`facts.ts`). Only where they can be searched: a plot whose model cannot run
  // here would pay for facts no request ever picks.
  const embedder = deps.embedder;
  if (settings.factCount > 0 && embedder?.modelFor(row.plotLanguage)) {
    const { applicable } = applicableSummaries(summaries, path);
    await extractFacts(deps, embedder, {
      chat,
      plotLanguage: row.plotLanguage,
      summary: written,
      messages: summarized,
      userName,
      // A gap's batch stands before summaries already written: their facts are
      // later in the story than its messages, and not its to change.
      branch: applicable.map((summary) => ({
        id: summary.id,
        earlier: Math.max(...summary.messageIds.map((id) => position.get(id)!)) < first,
      })),
      // The language the conversation runs in now — a Korean reader of an English
      // card writes Korean — rather than the plot's.
      conversationLanguage: detectContentLanguage(
        visibleToAi(path)
          .slice(-LANGUAGE_TURNS)
          .map((message) => stripImageMacros(message.content))
          .join('\n'),
      ),
    });
  }

  const next = { continuing: continuing || !batch.gap };
  const covered = plan.map((message) =>
    batch.messageIds.includes(message.id) ? { ...message, covered: true } : message,
  );
  return { more: nextSummaryBatch(covered, settings, budget, next.continuing) !== null, ...next };
}

/** The branch as the batching reads it, and the batch it is due — or null. */
function planBatch(
  path: Message[],
  summaries: ChatSummary[],
  settings: MemorySettings,
  budget: { contextBudget: number; responseReserve: number; fixedTokens: number },
  continuing: boolean,
): { batch: SummaryBatch; plan: BatchMessage[] } | null {
  const { applicable } = applicableSummaries(summaries, path);
  const covered = new Set(applicable.flatMap((summary) => summary.messageIds));
  // What a model may read and there is something to summarize in: a message
  // hidden from the AI is neither counted nor covered, nor is an empty one.
  const plan: BatchMessage[] = visibleToAi(path)
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({
      id: message.id,
      role: message.role,
      tokens: countTokens(message.content),
      covered: covered.has(message.id),
    }));
  const batch = nextSummaryBatch(plan, settings, budget, continuing);
  return batch ? { batch, plan } : null;
}

/**
 * Whether a branch is due a summary: what an import asks before it queues a
 * backfill. `responseReserve` is the plot's reply length's.
 */
export function summaryDue(
  chat: Pick<Chat, 'memorySettings'>,
  path: Message[],
  summaries: ChatSummary[],
  responseReserve: number,
): boolean {
  const settings = memorySettingsOf(chat);
  return planBatch(path, summaries, settings, { contextBudget: settings.contextBudget, responseReserve, fixedTokens: 0 }, false) !== null;
}

/**
 * Embeds the chat's summaries that have no vectors of its plot's model yet —
 * new ones, rewritten ones, ones another model embedded (an older default, the
 * plot's language since changed) — a bounded number of chunks per call, oldest
 * summary first. Best effort: an embedder that fails leaves them for the next
 * refresh. A summary rewritten meanwhile is skipped.
 */
export async function embedPendingSummaries(deps: AppDeps, chatId: string): Promise<void> {
  const embedder = deps.embedder;
  if (!embedder) return;
  const [chat] = await deps.db
    .select({ plotLanguage: plots.language })
    .from(chats)
    .innerJoin(plots, eq(chats.plotId, plots.id))
    .where(eq(chats.id, chatId))
    .limit(1);
  const model = chat ? embedder.modelFor(chat.plotLanguage) : null;
  if (!chat || !model) return;
  const pending = await deps.db
    .select({ id: chatSummaries.id, text: chatSummaries.text })
    .from(chatSummaries)
    .where(
      and(
        eq(chatSummaries.chatId, chatId),
        notExists(
          deps.db
            .select({ one: sql`1` })
            .from(chatSummaryChunks)
            .where(and(eq(chatSummaryChunks.summaryId, chatSummaries.id), eq(chatSummaryChunks.model, model))),
        ),
      ),
    )
    .orderBy(asc(chatSummaries.createdAt), asc(chatSummaries.id));

  let budget = CHUNKS_PER_REFRESH;
  for (const summary of pending) {
    const chunks = summaryChunks(summary.text);
    if (chunks.length === 0) continue;
    // One summary longer than the whole allowance is still embedded, alone —
    // left for later it would stand first in line on every refresh, forever.
    if (chunks.length > budget && budget < CHUNKS_PER_REFRESH) continue;
    budget -= chunks.length;
    let embedded: Embedding;
    try {
      embedded = await embedder.embed(chunks, { plotLanguage: chat.plotLanguage, kind: 'document' });
    } catch (error) {
      console.warn('[memory] embedding summaries failed; they are searched once it works', error);
      return;
    }
    await deps.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ text: chatSummaries.text })
        .from(chatSummaries)
        .where(eq(chatSummaries.id, summary.id))
        .for('update');
      if (current?.text !== summary.text) return;
      await tx.delete(chatSummaryChunks).where(eq(chatSummaryChunks.summaryId, summary.id));
      await tx.insert(chatSummaryChunks).values(
        chunks.map((content, chunkIndex) => ({
          summaryId: summary.id,
          chunkIndex,
          content,
          model: embedded.model,
          embedding: embedded.vectors[chunkIndex]!,
        })),
      );
    });
  }
}

/**
 * The `memory_backfill` job (§7.3): summarizes an imported chat's history, a
 * batch per summary call, a few calls per run.
 *
 * A run is bounded so one long import does not hold this instance's worker — the
 * queue runs one job at a time — for an hour; what is left goes to a successor
 * job, behind whatever else is due. It takes the same per-chat guard a finished
 * turn's refresh takes and stands back when one is running, and every summary
 * still goes through the revision CAS, so a reader who starts chatting meanwhile
 * only shares the work. A chat that is gone, or an owner with no memory channel,
 * ends the chain quietly: nothing is summarized and nothing more is said to be
 * left. A provider failure throws, and the queue retries the run with its backoff.
 */
export async function memoryBackfill(
  deps: AppDeps,
  { chatId }: JobPayloadMap['memory_backfill'],
): Promise<void> {
  let continuing = false;
  for (let pass = 0; pass < BACKFILL_BATCHES_PER_RUN; pass += 1) {
    if (deps.refreshingMemory.has(chatId)) {
      await enqueueBackfill(deps, chatId, new Date(Date.now() + BACKFILL_RETRY_MS));
      return;
    }
    deps.refreshingMemory.add(chatId);
    let result: PassResult;
    try {
      result = await updateMemory(deps, chatId, continuing);
    } finally {
      deps.refreshingMemory.delete(chatId);
    }
    continuing = result.continuing;
    if (!result.more) {
      await embedPendingSummaries(deps, chatId).catch((error: unknown) => {
        console.error('[memory] embedding a backfill failed', error);
      });
      await embedPendingFacts(deps, chatId).catch((error: unknown) => {
        console.error('[memory] embedding a backfill\'s facts failed', error);
      });
      return;
    }
  }
  await enqueueBackfill(deps, chatId);
}

/** The next backfill run, on a transaction of its own: nothing else is being written with it. */
async function enqueueBackfill(deps: AppDeps, chatId: string, runAt?: Date): Promise<void> {
  await deps.db.transaction((tx) => enqueueJob(tx, 'memory_backfill', { chatId }, runAt ? { runAt } : {}));
}

/**
 * Invalidates the memory for an edit of messages — an in-place edit, a delete
 * (every message it takes), a message hidden from the AI or shown to it again.
 * Runs inside the edit's own transaction, so the bump and the edit land together.
 *
 * Every call bumps `memory_revision`, which discards any summary being written
 * from a snapshot that may still hold the old text. The summaries covering one
 * of the messages are deleted — that one summary each, not the memory: the
 * stretch it covered is summarized again (as a gap) on the next refresh. A fact
 * of theirs a later summary ended moves to that summary first (`keepEndedFacts`),
 * so the stretch summarized again does not bring it back. Answers how many were
 * deleted; a caller with any should schedule that refresh once its transaction
 * has committed.
 *
 * Also touches `chats.updated_at`, since it owns the chat row write for this edit.
 */
export async function invalidateMemoryForEdit(
  tx: Tx,
  chatId: string,
  editedMessageIds: string | readonly string[],
): Promise<number> {
  const ids = typeof editedMessageIds === 'string' ? [editedMessageIds] : [...editedMessageIds];
  // Lock the chat row first: a background summary's write serializes behind this,
  // so it either lands before and is deleted here, or sees the bump and is dropped.
  const [locked] = await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).for('update');
  if (!locked) return 0;
  await tx
    .update(chats)
    .set({ memoryRevision: sql`${chats.memoryRevision} + 1`, updatedAt: new Date() })
    .where(eq(chats.id, chatId));
  if (ids.length === 0) return 0;
  const doomed = await tx
    .select({ id: chatSummaries.id })
    .from(chatSummaries)
    .where(
      and(
        eq(chatSummaries.chatId, chatId),
        sql`${chatSummaries.messageIds} && ARRAY[${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`,
      ),
    );
  if (doomed.length === 0) return 0;
  const doomedIds = doomed.map((summary) => summary.id);
  await keepEndedFacts(tx, doomedIds);
  await tx.delete(chatSummaries).where(inArray(chatSummaries.id, doomedIds));
  return doomed.length;
}

/* -------------------------------------------------------------- the model */

interface SummarizeInput {
  /** The messages the summary is made from, oldest first. */
  messages: Message[];
  userName: string;
  /** The chat's summarization prompt; empty for HypaV3's. */
  prompt: string;
}

/**
 * The summary of `input.messages`, as HypaV3's `summarize` asks for it — our
 * transcript (a group reply under its speaker's name) in place of RisuAI's
 * `role: content` lines, images left out. Null when the chat's auxiliary model
 * is unusable or answers nothing; never throws for that.
 */
export async function summarize(
  deps: AppDeps,
  chat: Pick<Chat, 'userId' | 'subModel' | 'plotId'>,
  input: SummarizeInput,
): Promise<string | null> {
  const resolved = await memoryChannel(deps, chat);
  if (!resolved) return null;
  const transcript = transcriptOf(input.messages, input.userName, await loadMembers(deps.db, chat.plotId));
  const request: ChatRequest = {
    model: resolved.providerModel,
    system: '',
    messages: summarizationTurns(transcript, input.prompt),
    maxTokens: SUMMARY_MAX_TOKENS,
    // A hung provider must not hold this chat's refresh slot indefinitely.
    abortSignal: AbortSignal.timeout(MEMORY_TIMEOUT_MS),
  };
  // HypaV3 strips a model's `<Thoughts>` before it keeps the summary.
  const text = (await collect(resolved.adapter, request)).replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, '').trim();
  return text || null;
}

/** Memory models already reported as unusable — a config state, not a per-turn failure. */
const warnedModels = new Set<string>();

/** What picks a chat's auxiliary model: whose catalog it comes from, and the reader's choice. */
export type AuxiliaryOwner = Pick<Chat, 'userId' | 'subModel'>;

/**
 * The model a chat's side work runs on — RisuAI's auxiliary (sub) model: the
 * one the reader picked for the chat (`chats.sub_model`) while the owner's
 * ChatGPT catalog still lists it, and otherwise the first model that catalog
 * lists. '' when there is none, which is what a signed-out owner has.
 *
 * A pick the catalog has since dropped is not an error: the chat falls back to
 * the default, as it would had the reader never picked, and the server says so
 * once. The setting is left as it is — the model may come back, and the
 * selector keeps showing it until the reader picks another.
 *
 * Tests have no first model worth the name — the catalog leads with echo, the
 * chat's own — so the default there is `MEMORY_MODEL`, or `test/memory`. A pick
 * is still checked against the catalog, which is how a vanished one is tested.
 */
export async function auxiliaryModelOf(deps: Pick<AppDeps, 'env' | 'chatgpt'>, owner: AuxiliaryOwner): Promise<string> {
  const catalog = await listEnabledModels(deps.env, deps.chatgpt?.accounts.forUser(owner.userId));
  if (owner.subModel) {
    if (catalog.some((model) => model.id === owner.subModel)) return owner.subModel;
    const key = `sub:${owner.subModel}`;
    if (!warnedModels.has(key)) {
      warnedModels.add(key);
      console.warn(`[memory] auxiliary model ${owner.subModel} is no longer offered, falling back to the default`);
    }
  }
  return (deps.env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test'
    ? deps.env['MEMORY_MODEL'] || 'test/memory'
    : catalog[0]?.id ?? '';
}

/**
 * Summaries, suggestions and relationships run on the chat's auxiliary model
 * (`auxiliaryModelOf`). A signed-out owner disables background work.
 */
export async function memoryChannel(
  deps: Pick<AppDeps, 'env' | 'chatgpt' | 'getAdapter'>,
  owner: AuxiliaryOwner,
): Promise<{ adapter: LLMAdapter; providerModel: string } | null> {
  let modelId = "chatgpt";
  try {
    modelId = await auxiliaryModelOf(deps, owner);
    if (!modelId) return null;
    return await (deps.getAdapter ?? getAdapter)(modelId, deps.env, deps.chatgpt?.accounts.forUser(owner.userId));
  } catch (error) {
    // Warn once, not on every turn for the rest of the process' life.
    if (!warnedModels.has(modelId)) {
      warnedModels.add(modelId);
      console.error('[memory] channel model unavailable, background updates are off', error);
    }
    return null;
  }
}

/** Drains a non-streaming side-channel call into one string, its prompt cache's share noted (`cacheHealth.ts`). */
export async function collect(adapter: LLMAdapter, request: ChatRequest): Promise<string> {
  const generator = adapter.stream(request);
  let text = '';
  let next = await generator.next();
  while (!next.done) {
    text += next.value.text;
    next = await generator.next();
  }
  // A test's stub may end without saying anything of its usage.
  if (next.value?.usage) noteCachedTokens('side', next.value.usage);
  return text;
}
