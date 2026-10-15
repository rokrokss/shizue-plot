/**
 * The chat's facts (ARCHITECTURE §7.3 사실), beside HypaV3's summaries: a few
 * durable ones a separate auxiliary-model call takes from the messages a
 * summary covers, right after the summary is written, and the most relevant of
 * which a request carries in a small `[기억]` block after the summaries. The
 * pure half — the call, its answer, the block — is @shizue/core `facts.ts`.
 *
 * - **A fact belongs to its summary** (`memories.summary_id`, cascade), so it
 *   applies where the summary applies and goes with it: an edit, a hide or a
 *   delete of a covered message, or the reader deleting the summary. The stretch
 *   is summarized again as a gap and its facts extracted again.
 * - **Vectors are the plot's model's**, as the summaries' chunks are; a fact
 *   without one of the current model is embedded by the next refresh.
 * - **Each request picks** the chat's `factCount` most similar to the latest
 *   turns — the same query vectors the summaries were ranked with, fused with
 *   the facts the newest turn names by words (BM25, `lexicalRanking`) — leaving out
 *   what a selected summary already says (in its words, or near enough by vector)
 *   and what another picked fact says, within the block's own token cap. Without
 *   an embedder for the plot, past the deadline, or with `factCount` 0: no block.
 */
import {
  factCoveredByText,
  factExtractionRequest,
  fitFacts,
  hybridRanking,
  lexicalRanking,
  parseFacts,
  rankBySimilarity,
  sameFact,
} from '@shizue/core';
import {
  chats,
  chatSummaries,
  chatSummaryChunks,
  memories,
  plots,
  type Chat,
  type ChatSummary,
  type ContentLanguage,
  type Message,
} from '@shizue/db';
import type { MacroLocale } from '@shizue/core';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import type { Embedder, Embedding } from './embedder.js';
import { loadMembers } from './hub.js';
import { noteLexicalSearch } from './lexicalHealth.js';
import { collect, memoryChannel } from './memory.js';
import { transcriptOf } from './transcript.js';

/** What one extraction may write: eight one-sentence facts in JSON. */
const FACTS_MAX_TOKENS = 800;
/** Deadline for one extraction call, as for a summary's. */
const FACTS_TIMEOUT_MS = 60_000;
/** Facts one refresh embeds at most, for facts still without a vector of the current model. */
const FACTS_PER_REFRESH = 64;
/**
 * Cosine at or above which a fact counts as one a selected summary's chunk
 * already says, and as another fact said again. Measured on KURE-v1
 * (ARCHITECTURE §7.3): a fact the summary restates scored 0.77–0.90 against its
 * paragraph, one it never mentions at most 0.61; two wordings of one fact
 * 0.96–0.99, two different facts about one thing ("water" and "fire") at most 0.89.
 */
export const FACT_COVERED_SIMILARITY = 0.75;
export const FACT_DUPLICATE_SIMILARITY = 0.92;
/** How many of the ranked facts the duplicate checks look through for each one a request carries. */
const CANDIDATES_PER_FACT = 4;

const vectorLiteral = (vector: readonly number[]) => sql`${JSON.stringify(vector)}::vector`;

/* --------------------------------------------------------------- extraction */

export interface ExtractionInput {
  chat: Pick<Chat, 'id' | 'userId' | 'plotId' | 'subModel'>;
  plotLanguage: ContentLanguage;
  /** The summary just written, whose messages the facts come from. */
  summary: Pick<ChatSummary, 'id'>;
  /** Those messages, oldest first, as the summary was made from them. */
  messages: Message[];
  userName: string;
  /** The summaries applying to the branch the summary was written on: their facts are the ones a new fact must not repeat. */
  branchSummaryIds: readonly string[];
  /** The language the conversation now runs in (its latest turns'), which the facts are written in; unknown, the model is told the conversation's. */
  conversationLanguage: MacroLocale | undefined;
}

/**
 * Extracts the facts of a summary just written and stores them, embedded where
 * the embedder can. Best effort, never throws: an auxiliary model that is
 * unusable or fails, or an answer that is not the JSON asked for, stores
 * nothing. A fact the branch already holds — the same words, or a vector at
 * `FACT_DUPLICATE_SIMILARITY` — is left out. Nothing is written once the
 * summary is gone (an edit dropped it while the model was answering).
 */
export async function extractFacts(deps: AppDeps, embedder: Embedder, input: ExtractionInput): Promise<void> {
  try {
    const resolved = await memoryChannel(deps, input.chat);
    if (!resolved) return;
    const transcript = transcriptOf(input.messages, input.userName, await loadMembers(deps.db, input.chat.plotId));
    const request = factExtractionRequest(transcript, input.conversationLanguage);
    const answer = await collect(resolved.adapter, {
      model: resolved.providerModel,
      system: request.system,
      messages: request.messages,
      maxTokens: FACTS_MAX_TOKENS,
      abortSignal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
    let facts = parseFacts(answer.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, ''));
    if (facts.length === 0) return;

    const existing =
      input.branchSummaryIds.length === 0
        ? []
        : await deps.db
            .select({ content: memories.content })
            .from(memories)
            .where(inArray(memories.summaryId, [...input.branchSummaryIds]));
    facts = facts.filter((fact) => !existing.some((row) => sameFact(row.content, fact)));
    if (facts.length === 0) return;

    let embedded: Embedding | null = null;
    try {
      embedded = await embedder.embed(facts, { plotLanguage: input.plotLanguage, kind: 'document' });
    } catch (error) {
      console.warn('[facts] embedding new facts failed; the next refresh embeds them', error);
    }
    let rows = facts.map((content, index) => ({ content, vector: embedded?.vectors[index] ?? null }));
    if (embedded && input.branchSummaryIds.length > 0) {
      const model = embedded.model;
      const near = await Promise.all(
        rows.map(async (row) => {
          if (!row.vector) return 0;
          const [hit] = await deps.db
            .select({ score: sql<number>`max(1 - (${memories.embedding} <=> ${vectorLiteral(row.vector)}))` })
            .from(memories)
            .where(and(inArray(memories.summaryId, [...input.branchSummaryIds]), eq(memories.model, model)));
          return Number(hit?.score ?? 0);
        }),
      );
      rows = rows.filter((_, index) => near[index]! < FACT_DUPLICATE_SIMILARITY);
    }
    if (rows.length === 0) return;

    await deps.db.transaction(async (tx) => {
      // Under the chat row's lock, which every edit takes before it drops the
      // summaries it touches: the summary is either still there or already gone.
      await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, input.chat.id)).for('update');
      const [summary] = await tx
        .select({ id: chatSummaries.id })
        .from(chatSummaries)
        .where(eq(chatSummaries.id, input.summary.id));
      if (!summary) return;
      // A millisecond apart, so the extraction's order is the order they are listed and sent in.
      const at = Date.now();
      await tx.insert(memories).values(
        rows.map((row, index) => ({
          createdAt: new Date(at + index),
          userId: input.chat.userId,
          plotId: input.chat.plotId,
          chatId: input.chat.id,
          summaryId: input.summary.id,
          content: row.content,
          model: row.vector ? embedded!.model : null,
          embedding: row.vector,
        })),
      );
    });
  } catch (error) {
    console.error('[facts] extraction failed', error);
  }
}

/**
 * Embeds the chat's facts that have no vector of its plot's model — new ones the
 * embedder could not take, ones the reader rewrote, ones another model embedded
 * — up to `FACTS_PER_REFRESH` a call, oldest first. Best effort, as the
 * summaries' (`embedPendingSummaries`). A fact rewritten meanwhile is skipped.
 */
export async function embedPendingFacts(deps: AppDeps, chatId: string): Promise<void> {
  const embedder = deps.embedder;
  if (!embedder) return;
  const [chat] = await deps.db
    .select({ plotLanguage: plots.language })
    .from(chats)
    .innerJoin(plots, eq(chats.plotId, plots.id))
    .where(eq(chats.id, chatId))
    .limit(1);
  const plotLanguage = chat?.plotLanguage;
  const model = plotLanguage ? embedder.modelFor(plotLanguage) : null;
  if (!plotLanguage || !model) return;
  const pending = await deps.db
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(eq(memories.chatId, chatId), or(isNull(memories.model), ne(memories.model, model))))
    .orderBy(asc(memories.createdAt), asc(memories.id))
    .limit(FACTS_PER_REFRESH);
  if (pending.length === 0) return;
  let embedded: Embedding;
  try {
    embedded = await embedder.embed(
      pending.map((fact) => fact.content),
      { plotLanguage, kind: 'document' },
    );
  } catch (error) {
    console.warn('[facts] embedding facts failed; they are searched once it works', error);
    return;
  }
  for (const [index, fact] of pending.entries()) {
    await deps.db
      .update(memories)
      .set({ model: embedded.model, embedding: embedded.vectors[index]! })
      .where(and(eq(memories.id, fact.id), eq(memories.content, fact.content)));
  }
}

/* ---------------------------------------------------------------- selection */

export interface FactSelectionInput {
  /** The summaries applying to the branch, in its order: their facts are the ones that may be picked. */
  applicable: readonly Pick<ChatSummary, 'id'>[];
  /** The summaries this request carries: what they say is not said again. */
  selected: readonly Pick<ChatSummary, 'id' | 'text'>[];
  /** The plot's model, whose vectors alone are compared. */
  model: string;
  /** The latest turns' vectors, shared with the summaries' ranking; throws when the embedder does. */
  queryVectors: () => Promise<Embedding>;
  /** The newest of those turns, which the facts are searched by words with. */
  turn: string;
  /** Facts the block may carry (`factCount`). */
  count: number;
}

/**
 * The facts a request carries, in the branch's order: the eligible ones ranked
 * by HypaV3's fusion of their similarity to each query turn (`rankBySimilarity`,
 * the newest turn weighing most) and fused with their BM25 ranking for the
 * newest turn (`hybridRanking`), without the ones a selected summary already
 * says or another picked fact says, at most `count`, within the block's cap.
 * Empty when the branch has no fact of the plot's model; throws when the query
 * vectors do, which the caller turns into no block.
 */
export async function selectFacts(deps: AppDeps, input: FactSelectionInput): Promise<string[]> {
  if (input.count <= 0 || input.applicable.length === 0) return [];
  const summaryIds = input.applicable.map((summary) => summary.id);
  const eligible = await deps.db
    .select({ id: memories.id, content: memories.content, summaryId: memories.summaryId, createdAt: memories.createdAt })
    .from(memories)
    .where(and(inArray(memories.summaryId, summaryIds), eq(memories.model, input.model)));
  if (eligible.length === 0) return [];

  const { model, vectors } = await input.queryVectors();
  if (model !== input.model || vectors.length === 0) return [];
  const ids = eligible.map((fact) => fact.id);
  const lists = await Promise.all(
    vectors.map(async (vector) => {
      const rows = await deps.db
        .select({ id: memories.id, score: sql<number>`1 - (${memories.embedding} <=> ${vectorLiteral(vector)})` })
        .from(memories)
        .where(and(inArray(memories.id, ids), eq(memories.model, model)))
        // A tie goes to the fact extracted first.
        .orderBy(asc(memories.createdAt), asc(memories.id));
      return rows.map((row) => [row.id, Number(row.score)] as const);
    }),
  );
  const byId = new Map(eligible.map((fact) => [fact.id, fact]));
  const selectedTexts = input.selected.map((summary) => summary.text);
  const lexical = lexicalRanking(
    eligible.map((fact) => [fact.id, fact.content] as const),
    input.turn,
  );
  noteLexicalSearch('facts', lexical.length > 0);
  const candidates = hybridRanking(rankBySimilarity(lists, (id: string) => id), lexical)
    .slice(0, input.count * CANDIDATES_PER_FACT)
    .map((id) => byId.get(id)!)
    .filter((fact) => !factCoveredByText(fact.content, selectedTexts));
  if (candidates.length === 0) return [];
  const candidateIds = candidates.map((fact) => fact.id);

  // Said by a selected summary in other words: a chunk of it near enough.
  const selectedIds = input.selected.map((summary) => summary.id);
  const covered = new Set<string>();
  if (selectedIds.length > 0) {
    const rows = await deps.db
      .select({
        id: memories.id,
        score: sql<number>`max(1 - (${memories.embedding} <=> ${chatSummaryChunks.embedding}))`,
      })
      .from(memories)
      .innerJoin(
        chatSummaryChunks,
        and(inArray(chatSummaryChunks.summaryId, selectedIds), eq(chatSummaryChunks.model, model)),
      )
      .where(and(inArray(memories.id, candidateIds), eq(memories.model, model)))
      .groupBy(memories.id);
    for (const row of rows) if (Number(row.score) >= FACT_COVERED_SIMILARITY) covered.add(row.id);
  }

  // Said by a fact ranked above it.
  const idList = sql.join(
    candidateIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const pairs = await deps.db.execute<{ a: string; b: string; score: number }>(sql`
    select a.id as a, b.id as b, 1 - (a.embedding <=> b.embedding) as score
    from ${memories} a join ${memories} b on a.id < b.id
    where a.id in (${idList}) and b.id in (${idList}) and a.model = ${model} and b.model = ${model}
  `);
  const near = new Set(
    [...pairs]
      .filter((pair) => Number(pair.score) >= FACT_DUPLICATE_SIMILARITY)
      .flatMap((pair) => [`${pair.a}:${pair.b}`, `${pair.b}:${pair.a}`]),
  );

  const picked: typeof candidates = [];
  for (const fact of candidates) {
    if (covered.has(fact.id)) continue;
    if (picked.some((other) => near.has(`${other.id}:${fact.id}`) || sameFact(other.content, fact.content))) continue;
    picked.push(fact);
    if (picked.length === input.count) break;
  }
  const kept = new Set(fitFacts(picked.map((fact) => fact.content)));
  const position = new Map(summaryIds.map((id, at) => [id, at]));
  return picked
    .filter((fact) => kept.has(fact.content))
    .sort(
      (a, b) =>
        position.get(a.summaryId)! - position.get(b.summaryId)! || a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .map((fact) => fact.content);
}

/* ----------------------------------------------------------------- listing */

/** The facts of the summaries applying to the branch, in its order: what the memory panel lists. */
export async function branchFacts(deps: AppDeps, applicable: readonly Pick<ChatSummary, 'id'>[]) {
  if (applicable.length === 0) return [];
  const summaryIds = applicable.map((summary) => summary.id);
  const rows = await deps.db
    .select()
    .from(memories)
    .where(inArray(memories.summaryId, summaryIds))
    .orderBy(asc(memories.createdAt), asc(memories.id));
  const position = new Map(summaryIds.map((id, at) => [id, at]));
  return rows
    .sort((a, b) => position.get(a.summaryId)! - position.get(b.summaryId)!)
    .map((row) => ({
      id: row.id,
      content: row.content,
      summaryId: row.summaryId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
}
