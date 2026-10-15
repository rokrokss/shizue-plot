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
 * - **Facts are updated, never deleted for it.** The extraction is shown the
 *   branch's facts from earlier in the story closest to the new summary
 *   (`knownFacts`: KURE fused with BM25) and may update or end them by number;
 *   only those it was shown can be touched. An ended fact stays, marked with the
 *   summary that ended it (`invalidated_by_summary_id`), that summary's last turn
 *   and the fact that took its place: it no longer holds on a branch that summary
 *   applies to, is never sent there, and the reader may restore it. When its own
 *   summary goes while the one that ended it stays, it moves to that one
 *   (`keepEndedFacts`), so the stretch summarized again cannot bring it back: a
 *   new fact that says it again is left out.
 * - **Vectors are the plot's model's**, as the summaries' chunks are; a fact
 *   without one of the current model is embedded by the next refresh.
 * - **Each request picks** the chat's `factCount` most similar to the latest
 *   turns among those that hold on the branch — the same query vectors the
 *   summaries were ranked with, fused with the facts the newest turn names by
 *   words (BM25, `lexicalRanking`) — leaving out what a selected summary already
 *   says (in its words, or near enough by vector) and what another picked fact
 *   says, within the block's own token cap. Without an embedder for the plot,
 *   past the deadline, or with `factCount` 0: no block.
 */
import {
  factCoveredByText,
  factExtractionRequest,
  fitFacts,
  hybridRanking,
  lexicalRanking,
  MAX_KNOWN_FACTS,
  parseFactExtraction,
  rankBySimilarity,
  sameFact,
  summaryChunks,
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
  type Memory,
  type Message,
} from '@shizue/db';
import type { MacroLocale } from '@shizue/core';
import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { AppDeps, Tx } from './deps.js';
import type { Embedder, Embedding } from './embedder.js';
import { loadMembers } from './hub.js';
import { noteLexicalSearch } from './lexicalHealth.js';
import { collect, memoryChannel } from './memory.js';
import { transcriptOf } from './transcript.js';

/** What one extraction may write: eight one-sentence facts and the changes to the ten it is shown, in JSON. */
const FACTS_MAX_TOKENS = 1200;
/** Deadline for one extraction call, as for a summary's. */
const FACTS_TIMEOUT_MS = 60_000;
/** Facts one refresh embeds at most, for facts still without a vector of the current model. */
const FACTS_PER_REFRESH = 64;
/**
 * Cosine at or above which a fact counts as one a selected summary's chunk
 * already says, and as another fact said again. Measured on KURE-v1
 * (ARCHITECTURE §7.3): a fact the summary restates scored 0.77–0.90 against its
 * paragraph, one it never mentions at most 0.61; two wordings of one fact
 * 0.96–0.99, two different facts about one thing ("water" and "fire") at most
 * 0.89 — so "X is alive" and "X died" both pass the duplicate bar, and only the
 * extraction's update step keeps them from being sent together.
 */
export const FACT_COVERED_SIMILARITY = 0.75;
export const FACT_DUPLICATE_SIMILARITY = 0.92;
/** How many of the ranked facts the duplicate checks look through for each one a request carries. */
const CANDIDATES_PER_FACT = 4;

const vectorLiteral = (vector: readonly number[]) => sql`${JSON.stringify(vector)}::vector`;

/**
 * Whether a fact holds on a branch: nothing ended it, or what ended it is a
 * summary of another branch (`branchIds`: the summaries applying to this one).
 */
export const holdsOn = (fact: Pick<Memory, 'invalidatedBySummaryId'>, branchIds: ReadonlySet<string>): boolean =>
  fact.invalidatedBySummaryId === null || !branchIds.has(fact.invalidatedBySummaryId);

/** The SQL of `holdsOn`, over the summaries applying to a branch. */
const holdsOnSql = (branchIds: readonly string[]) =>
  branchIds.length === 0
    ? sql`true`
    : or(isNull(memories.invalidatedBySummaryId), notInArray(memories.invalidatedBySummaryId, [...branchIds]))!;

/* --------------------------------------------------------------- extraction */

export interface ExtractionInput {
  chat: Pick<Chat, 'id' | 'userId' | 'plotId' | 'subModel'>;
  plotLanguage: ContentLanguage;
  /** The summary just written, whose messages the facts come from. */
  summary: Pick<ChatSummary, 'id' | 'text' | 'turnFrom' | 'turnTo'>;
  /** Those messages, oldest first, as the summary was made from them. */
  messages: Message[];
  userName: string;
  /**
   * The other summaries applying to the branch the summary was written on, and
   * whether each ends before its first message — earlier in the story, whose
   * facts it may change — or after it, as a gap's later neighbours do.
   */
  branch: readonly { id: string; earlier: boolean }[];
  /** The language the conversation now runs in (its latest turns'), which the facts are written in; unknown, the model is told the conversation's. */
  conversationLanguage: MacroLocale | undefined;
}

/** A fact of the branch as the extraction weighs it. */
type BranchFact = Pick<Memory, 'id' | 'content' | 'summaryId' | 'invalidatedBySummaryId'>;

/**
 * Extracts the facts of a summary just written and stores them, embedded where
 * the embedder can, with the changes the answer makes to the facts it was shown.
 * Best effort, never throws: an auxiliary model that is unusable or fails, or an
 * answer that is not the JSON asked for, stores and changes nothing.
 *
 * A new fact — added, or an update's new words — that a fact holding on the
 * branch already says (the same words, or a vector at `FACT_DUPLICATE_SIMILARITY`)
 * is left out; an update that only says what another fact says ends the old one
 * in favour of that one. A new fact that says what a summary later on the branch
 * ended is left out too (a gap summarized again). Nothing is written once the
 * summary is gone (an edit dropped it while the model was answering).
 */
export async function extractFacts(deps: AppDeps, embedder: Embedder, input: ExtractionInput): Promise<void> {
  try {
    const resolved = await memoryChannel(deps, input.chat);
    if (!resolved) return;
    const branchIds = new Set(input.branch.map((summary) => summary.id));
    const earlierIds = new Set(input.branch.filter((summary) => summary.earlier).map((summary) => summary.id));
    const laterIds = new Set(input.branch.filter((summary) => !summary.earlier).map((summary) => summary.id));
    const branchFactsNow: BranchFact[] =
      branchIds.size === 0
        ? []
        : await deps.db
            .select({
              id: memories.id,
              content: memories.content,
              summaryId: memories.summaryId,
              invalidatedBySummaryId: memories.invalidatedBySummaryId,
            })
            .from(memories)
            .where(inArray(memories.summaryId, [...branchIds]))
            .orderBy(asc(memories.createdAt), asc(memories.id));
    const holding = branchFactsNow.filter((fact) => holdsOn(fact, branchIds));
    const known = await knownFacts(deps, embedder, input, holding.filter((fact) => earlierIds.has(fact.summaryId)));

    const transcript = transcriptOf(input.messages, input.userName, await loadMembers(deps.db, input.chat.plotId));
    const request = factExtractionRequest(
      transcript,
      input.conversationLanguage,
      known.map((fact) => fact.content),
    );
    const answer = await collect(resolved.adapter, {
      model: resolved.providerModel,
      system: request.system,
      messages: request.messages,
      maxTokens: FACTS_MAX_TOKENS,
      abortSignal: AbortSignal.timeout(FACTS_TIMEOUT_MS),
    });
    const parsed = parseFactExtraction(
      answer.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, ''),
      known.map((fact) => fact.content),
    );
    const changed = new Set([...parsed.updated.map((update) => update.id), ...parsed.invalidated].map((id) => known[id - 1]!.id));
    // What a new fact must not repeat: what still holds once this answer's changes are made.
    const standing = holding.filter((fact) => !changed.has(fact.id));
    // What a gap's new fact must not bring back: what a later summary ended.
    const endedLater = branchFactsNow.filter(
      (fact) => fact.invalidatedBySummaryId !== null && laterIds.has(fact.invalidatedBySummaryId),
    );

    const texts = [...parsed.added, ...parsed.updated.map((update) => update.content)];
    let embedded: Embedding | null = null;
    if (texts.length > 0) {
      try {
        embedded = await embedder.embed(texts, { plotLanguage: input.plotLanguage, kind: 'document' });
      } catch (error) {
        console.warn('[facts] embedding new facts failed; the next refresh embeds them', error);
      }
    }
    /** The fact of `among` a new text says again, by its words or its vector; null for none. */
    const saidBy = async (text: string, vector: number[] | undefined, among: readonly BranchFact[]): Promise<string | null> => {
      const same = among.find((fact) => sameFact(fact.content, text));
      if (same) return same.id;
      if (!vector || !embedded || among.length === 0) return null;
      const [hit] = await deps.db
        .select({ id: memories.id, score: sql<number>`1 - (${memories.embedding} <=> ${vectorLiteral(vector)})` })
        .from(memories)
        .where(and(inArray(memories.id, among.map((fact) => fact.id)), eq(memories.model, embedded.model)))
        .orderBy(sql`${memories.embedding} <=> ${vectorLiteral(vector)}`)
        .limit(1);
      return hit && Number(hit.score) >= FACT_DUPLICATE_SIMILARITY ? hit.id : null;
    };

    let suppressed = 0;
    const added: { content: string; vector: number[] | null }[] = [];
    for (const [index, content] of parsed.added.entries()) {
      const vector = embedded?.vectors[index];
      if (await saidBy(content, vector, standing)) continue;
      if (await saidBy(content, vector, endedLater)) {
        suppressed += 1;
        continue;
      }
      added.push({ content, vector: vector ?? null });
    }
    const updates: { old: string; content: string; vector: number[] | null; supersededBy: string | null }[] = [];
    for (const [at, update] of parsed.updated.entries()) {
      const vector = embedded?.vectors[parsed.added.length + at];
      const old = known[update.id - 1]!.id;
      const already = await saidBy(update.content, vector, standing);
      updates.push({ old, content: update.content, vector: vector ?? null, supersededBy: already });
    }
    const invalidated = parsed.invalidated.map((id) => known[id - 1]!.id);

    console.log(
      `[facts] chat ${input.chat.id}: ${added.length} added, ${updates.length} updated, ${invalidated.length} invalidated` +
        ` of ${known.length} shown, ${parsed.rejected} rejected, ${suppressed} ended later`,
    );
    if (added.length === 0 && updates.length === 0 && invalidated.length === 0) return;

    const model = embedded?.model ?? null;
    const turns = { turnFrom: input.summary.turnFrom, turnTo: input.summary.turnTo };
    const ending = { invalidatedBySummaryId: input.summary.id, invalidatedTurn: input.summary.turnTo };
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
      const fresh = [...added, ...updates.filter((update) => update.supersededBy === null)];
      const rows =
        fresh.length === 0
          ? []
          : await tx
              .insert(memories)
              .values(
                fresh.map((fact, index) => ({
                  createdAt: new Date(at + index),
                  userId: input.chat.userId,
                  plotId: input.chat.plotId,
                  chatId: input.chat.id,
                  summaryId: input.summary.id,
                  content: fact.content,
                  model: fact.vector ? model : null,
                  embedding: fact.vector,
                  ...turns,
                })),
              )
              .returning({ id: memories.id, content: memories.content });
      for (const update of updates) {
        const supersededById = update.supersededBy ?? rows.find((row) => row.content === update.content)?.id ?? null;
        await tx
          .update(memories)
          .set({ ...ending, supersededById })
          .where(and(eq(memories.id, update.old), eq(memories.chatId, input.chat.id)));
      }
      if (invalidated.length > 0) {
        await tx
          .update(memories)
          .set({ ...ending, supersededById: null })
          .where(and(inArray(memories.id, invalidated), eq(memories.chatId, input.chat.id)));
      }
    });
  } catch (error) {
    console.error('[facts] extraction failed', error);
  }
}

/**
 * The facts an extraction is shown to update or end: of `candidates` — the
 * branch's facts from earlier in the story that still hold — all of them while
 * they are few, else the `MAX_KNOWN_FACTS` closest to the new summary: its
 * chunks embedded as queries and each fact scored by cosine, fused as HypaV3
 * fuses its queries (`rankBySimilarity`), then with the facts the summary names
 * by words (`lexicalRanking`, reciprocal rank — a name the embedder misses still
 * finds its fact). An embedder that fails leaves the words alone to rank.
 */
async function knownFacts(
  deps: AppDeps,
  embedder: Embedder,
  input: Pick<ExtractionInput, 'summary' | 'plotLanguage'>,
  candidates: readonly BranchFact[],
): Promise<BranchFact[]> {
  if (candidates.length <= MAX_KNOWN_FACTS) return [...candidates];
  const ids = candidates.map((fact) => fact.id);
  let dense: string[] = [];
  try {
    const queries = summaryChunks(input.summary.text);
    const { model, vectors } = await embedder.embed(queries, { plotLanguage: input.plotLanguage, kind: 'query' });
    const lists = await Promise.all(
      vectors.map(async (vector) => {
        const rows = await deps.db
          .select({ id: memories.id, score: sql<number>`1 - (${memories.embedding} <=> ${vectorLiteral(vector)})` })
          .from(memories)
          .where(and(inArray(memories.id, ids), eq(memories.model, model)))
          .orderBy(asc(memories.createdAt), asc(memories.id));
        return rows.map((row) => [row.id, Number(row.score)] as const);
      }),
    );
    dense = rankBySimilarity(lists, (id: string) => id);
  } catch (error) {
    console.warn('[facts] ranking the facts to show by meaning failed; by words alone', error);
  }
  const lexical = lexicalRanking(
    candidates.map((fact) => [fact.id, fact.content] as const),
    input.summary.text,
  );
  const byId = new Map(candidates.map((fact) => [fact.id, fact]));
  return hybridRanking(dense, lexical)
    .slice(0, MAX_KNOWN_FACTS)
    .map((id) => byId.get(id)!);
}

/**
 * Before `summaryIds` are deleted: the facts of theirs that a summary staying on
 * ended move to that summary, so the record of the ending outlives the stretch
 * it ended — summarized again, the stretch's facts meet it and are left out
 * (`extractFacts`). Run in the delete's own transaction.
 */
export async function keepEndedFacts(tx: Tx, summaryIds: readonly string[]): Promise<void> {
  if (summaryIds.length === 0) return;
  await tx
    .update(memories)
    .set({ summaryId: sql`${memories.invalidatedBySummaryId}` })
    .where(
      and(
        inArray(memories.summaryId, [...summaryIds]),
        isNotNull(memories.invalidatedBySummaryId),
        notInArray(memories.invalidatedBySummaryId, [...summaryIds]),
      ),
    );
}

/**
 * Embeds the chat's facts that have no vector of its plot's model — new ones the
 * embedder could not take, ones the reader rewrote, ones another model embedded
 * — up to `FACTS_PER_REFRESH` a call, oldest first. Best effort, as the
 * summaries' (`embedPendingSummaries`). A fact rewritten meanwhile is skipped.
 * The ended ones too: a new fact is checked against them by vector.
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
  /** The summaries applying to the branch, in its order: their facts that hold on it are the ones that may be picked. */
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
  /** A fact's line as the block carries it, from its summary: its time label and its words (`withTimeLabel`). */
  line: (fact: { content: string; summaryId: string }) => string;
}

/**
 * The facts a request carries, as the block's lines (`input.line`), in the
 * branch's order: the eligible ones — of the summaries on the branch, holding on
 * it — ranked by HypaV3's fusion of their similarity to each query turn
 * (`rankBySimilarity`, the newest turn weighing most) and fused with their BM25
 * ranking for the newest turn (`hybridRanking`), without the ones a selected
 * summary already says or another picked fact says, at most `count`, within the
 * block's cap. Empty when the branch has no fact of the plot's model; throws
 * when the query vectors do, which the caller turns into no block.
 */
export async function selectFacts(deps: AppDeps, input: FactSelectionInput): Promise<string[]> {
  if (input.count <= 0 || input.applicable.length === 0) return [];
  const summaryIds = input.applicable.map((summary) => summary.id);
  const eligible = await deps.db
    .select({ id: memories.id, content: memories.content, summaryId: memories.summaryId, createdAt: memories.createdAt })
    .from(memories)
    .where(and(inArray(memories.summaryId, summaryIds), eq(memories.model, input.model), holdsOnSql(summaryIds)));
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
  const lines = new Map(picked.map((fact) => [fact.id, input.line(fact)]));
  const kept = new Set(fitFacts(picked.map((fact) => lines.get(fact.id)!)));
  const position = new Map(summaryIds.map((id, at) => [id, at]));
  return picked
    .filter((fact) => kept.has(lines.get(fact.id)!))
    .sort(
      (a, b) =>
        position.get(a.summaryId)! - position.get(b.summaryId)! || a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .map((fact) => lines.get(fact.id)!);
}

/* ----------------------------------------------------------------- listing */

/** A fact as the memory panel shows it; `branchIds` are the summaries applying to the branch it is read on. */
export function toFactJson(
  row: Memory,
  branchIds: ReadonlySet<string>,
  supersededBy: Pick<Memory, 'id' | 'content'> | null,
) {
  const ended = !holdsOn(row, branchIds);
  return {
    id: row.id,
    content: row.content,
    summaryId: row.summaryId,
    turnFrom: row.turnFrom,
    turnTo: row.turnTo,
    /** Ended on this branch by a later summary: kept, never sent, restorable. */
    invalidated: ended,
    invalidatedTurn: ended ? row.invalidatedTurn : null,
    supersededBy: ended && supersededBy ? { id: supersededBy.id, content: supersededBy.content } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The facts of the summaries applying to the branch, in its order — those that
 * hold and those a summary on it ended alike: what the memory panel lists.
 */
export async function branchFacts(deps: AppDeps, applicable: readonly Pick<ChatSummary, 'id'>[]) {
  if (applicable.length === 0) return [];
  const summaryIds = applicable.map((summary) => summary.id);
  const rows = await deps.db
    .select()
    .from(memories)
    .where(inArray(memories.summaryId, summaryIds))
    .orderBy(asc(memories.createdAt), asc(memories.id));
  const position = new Map(summaryIds.map((id, at) => [id, at]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const branchIds = new Set(summaryIds);
  return rows
    .sort((a, b) => position.get(a.summaryId)! - position.get(b.summaryId)!)
    .map((row) => toFactJson(row, branchIds, row.supersededById ? byId.get(row.supersededById) ?? null : null));
}
