/**
 * Two-layer chat memory (see docs/ARCHITECTURE.md, Phase 2 / Chunk 4).
 *
 * Layer 1 — rolling summary: once the current path grows past a fraction of the
 * context budget, the oldest turns are folded into `chats.memory` by the memory
 * channel model and replaced in the prompt by a summary block. The anchor is the
 * last summarized message; a branch that does not contain it silently ignores the
 * summary (the next update recomputes it).
 *
 * Layer 2 — long-term facts: only when the EMBEDDING_* env is configured. Facts are
 * extracted in the same summarization call, embedded and stored in `memories`, then
 * retrieved by cosine similarity against the latest user message.
 *
 * Everything in the update path is fire-and-forget: it runs after the SSE `done`
 * event and swallows its own failures.
 */
import { countTokens, DEFAULT_CONTEXT_BUDGET, DEFAULT_USER_NAME, stripImageMacros } from '@shizue/core';
import { transcriptLine } from './transcript.js';
import { chats, memories, messages, personas, type Chat, type Message } from '@shizue/db';
import { getAdapter, listEnabledModels, type ChatRequest, type LLMAdapter } from '@shizue/llm';
import { and, asc, cosineDistance, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { AppDeps, Tx } from './deps.js';
import { buildPath } from './tree.js';

// Measured 2026-08-10 (45-call eval, production prompt): 9/9 JSON-parse, the
// lowest latency of the field, ~1/5 of haiku's cost. Internal catalog entry —
// served, never listed to users.
/** Path token share that triggers a re-summary, for a chat that has not tuned it. */
const DEFAULT_SUMMARY_THRESHOLD = 0.6;
/** Path token share kept verbatim after a re-summary; the rest is folded in. */
const KEEP_RATIO = 0.4;
/** The tail is never summarized away entirely — the prompt needs real turns. */
const MIN_RETAINED_MESSAGES = 2;
const SUMMARY_MAX_TOKENS = 1600;
/** Deadline for one background refresh call, so a hung provider frees its slot. */
const MEMORY_TIMEOUT_MS = 60_000;
const MAX_FACTS = 8;
const DEFAULT_RETRIEVAL_COUNT = 5;
/** Turns scanned for facts the model can already see, which are not re-injected. */
const RECENT_TURNS_SCANNED = 6;

const SUMMARY_HEADING = '[지난 이야기 요약]';
const FACTS_HEADING = '[기억]';

const MEMORY_RULES = `당신은 롤플레이 대화의 기록 담당자입니다. 컨텍스트에서 밀려나는 대화 구간을 압축해 "지난 이야기 요약"을 갱신합니다.

규칙:
- 기존 요약과 새 구간을 하나의 요약으로 통합합니다. 기존 요약의 내용은 새 구간과 모순되지 않는 한 유지합니다.
- 인물의 이름·호칭·관계, 약속과 목표, 실제로 일어난 사건, 장소와 시간의 이동, 되돌릴 수 없는 상태 변화를 우선 기록합니다.
- 사실만 건조하게 적습니다. 묘사·수식·감상·연출 문장은 쓰지 않습니다.
- 시간 순서대로 짧은 문장을 나열합니다. 대사를 그대로 옮기지 말고 요약합니다.
- 대명사 대신 이름을 씁니다. 확실하지 않은 내용은 추측하지 말고 생략합니다.
- 요약 전체가 800토큰(한국어 약 1200자)을 넘지 않게 합니다.`;

const OUTPUT_SUMMARY_ONLY = `
- 요약 본문만 출력합니다. 인사말·머리말·설명을 덧붙이지 않습니다.`;

const OUTPUT_WITH_FACTS = `

출력 형식: 아래 스키마를 따르는 JSON 객체 하나만 출력합니다. 코드 블록이나 다른 텍스트를 덧붙이지 않습니다.
{
  "summary": string,   // 위 규칙에 따라 통합한 요약 본문
  "facts": string[]    // 대화가 이어지는 동안 계속 참인 영구적 사실 3~8개
}
facts의 각 항목은 한 문장이며, 앞뒤 맥락 없이 그 자체로 이해되어야 합니다(대명사 대신 이름 사용). 장면에 한정된 일시적 상태는 넣지 않습니다.`;

/* --------------------------------------------------------------- settings */

interface MemorySettings {
  contextBudget: number;
  summaryThreshold: number;
  retrievalCount: number;
}

/**
 * The knobs this chat runs the memory layer with — its own overrides where it has
 * them, the pipeline defaults everywhere else. The values themselves are validated
 * against the whitelist when they are written.
 */
export function memorySettingsOf(chat: Chat): MemorySettings {
  const settings = chat.memorySettings;
  return {
    contextBudget: settings?.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
    summaryThreshold: settings?.summaryThreshold ?? DEFAULT_SUMMARY_THRESHOLD,
    retrievalCount: settings?.retrievalCount ?? DEFAULT_RETRIEVAL_COUNT,
  };
}

/* -------------------------------------------------------------- injection */

/**
 * Splits the path at the memory anchor. The summary only applies when the anchor is
 * on this branch; otherwise the whole path is history and the memory is ignored
 * (`anchored: false`), including the facts extracted alongside it.
 */
function applyMemory(
  path: Message[],
  chat: Chat,
): { summary: string; history: Message[]; anchored: boolean } {
  const memory = chat.memory;
  if (!memory?.summary.trim()) return { summary: '', history: path, anchored: false };
  const index = path.findIndex((message) => message.id === memory.anchorMessageId);
  if (index < 0) return { summary: '', history: path, anchored: false };
  return { summary: memory.summary, history: path.slice(index + 1), anchored: true };
}

function formatMemoryText(summary: string, facts: string[]): string {
  const blocks: string[] = [];
  if (summary.trim()) blocks.push(`${SUMMARY_HEADING}\n${summary.trim()}`);
  if (facts.length > 0) blocks.push(`${FACTS_HEADING}\n${facts.map((fact) => `- ${fact}`).join('\n')}`);
  return blocks.join('\n\n');
}

/**
 * Memory inputs for one generation: the text injected after the persona and the
 * history the model still sees verbatim.
 */
export async function buildMemoryInput(
  deps: AppDeps,
  chat: Chat,
  path: Message[],
  query: string,
): Promise<{ memoryText: string; history: Message[] }> {
  const { summary, history, anchored } = applyMemory(path, chat);
  // Branch divergence invalidates the whole memory layer, facts included. The
  // query is embedded by a provider, so it is stripped like any other text that
  // leaves this service.
  const facts = anchored
    ? await retrieveFacts(
        deps,
        chat,
        stripImageMacros(query),
        summary,
        path,
        history,
        memorySettingsOf(chat).retrievalCount,
      )
    : [];
  return { memoryText: formatMemoryText(summary, facts), history };
}

/** Punctuation- and space-insensitive form, for the redundancy filter. */
const normalize = (text: string): string => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** Top matches for `query`, minus facts the prompt already states verbatim. */
async function retrieveFacts(
  deps: AppDeps,
  chat: Chat,
  query: string,
  summary: string,
  path: Message[],
  history: Message[],
  limit: number,
): Promise<string[]> {
  // Facts are only ever written together with chats.memory, so a chat without a
  // summary has none — no need to pay for an embedding call. A chat that asked
  // for no facts skips the call for the same reason.
  if (!chat.memory || limit <= 0) return [];
  const embedder = deps.createEmbedder?.();
  if (!embedder || !query.trim()) return [];

  try {
    // A timeout rejects here and is handled like any other retrieval failure.
    const [vector] = await embedder.embed([query]);
    if (!vector) return [];

    const similarity = sql<number>`1 - (${cosineDistance(memories.embedding, vector)})`;
    const rows = await deps.db
      .select({ content: memories.content })
      .from(memories)
      .where(
        and(
          eq(memories.chatId, chat.id),
          isNotNull(memories.embedding),
          // Facts extracted on a branch this path left behind do not apply. The
          // filter is in SQL so the top-N is taken over eligible rows only.
          or(
            isNull(memories.sourceMessageId),
            inArray(
              memories.sourceMessageId,
              path.map((message) => message.id),
            ),
          ),
        ),
      )
      .orderBy(desc(similarity))
      .limit(limit * 2);

    const seen = normalize(
      [summary, ...history.slice(-RECENT_TURNS_SCANNED).map((message) => message.content)].join('\n'),
    );
    const picked: string[] = [];
    for (const row of rows) {
      const key = normalize(row.content);
      if (!key || seen.includes(key) || picked.some((fact) => normalize(fact) === key)) continue;
      picked.push(row.content);
      if (picked.length === limit) break;
    }
    return picked;
  } catch (error) {
    // Retrieval is best-effort: a failing embedding provider must not break the turn.
    console.error('[memory] retrieval failed', error);
    return [];
  }
}

/* ------------------------------------------------------------------ update */

/**
 * Fire-and-forget memory refresh. Must only be called after the response is done:
 * it reloads everything itself and never propagates a failure.
 */
export function scheduleMemoryUpdate(deps: AppDeps, chatId: string): void {
  // One refresh per chat at a time. While a refresh runs the branch stays over the
  // threshold, so every following turn would otherwise start a duplicate; there is
  // nothing to queue, the next completed turn reschedules.
  if (deps.refreshingMemory.has(chatId)) return;
  deps.refreshingMemory.add(chatId);

  const task = updateMemory(deps, chatId)
    .catch((error: unknown) => {
      console.error('[memory] update failed', error);
    })
    .finally(() => deps.refreshingMemory.delete(chatId));
  deps.onBackgroundTask?.(task, 'memory');
}

async function updateMemory(deps: AppDeps, chatId: string): Promise<void> {
  const [row] = await deps.db
    .select({ chat: chats, personaName: personas.name })
    .from(chats)
    .leftJoin(personas, eq(chats.personaId, personas.id))
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!row) return;
  const chat = row.chat;
  // Read-modify-write over a slow model call: remember the revision this refresh
  // snapshotted, so any edit landing in the meantime discards its result.
  const captured = chat.memoryRevision;

  const all = await deps.db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt));
  const { summary, history } = applyMemory(buildPath(all, chat.headMessageId), chat);

  const { contextBudget, summaryThreshold, retrievalCount } = memorySettingsOf(chat);
  const costs = history.map((message) => countTokens(message.content));
  const total = countTokens(summary) + costs.reduce((sum, cost) => sum + cost, 0);
  if (total <= contextBudget * summaryThreshold) return;

  const evicted = history.slice(0, evictionCount(costs, contextBudget));
  const anchor = evicted[evicted.length - 1];
  if (!anchor) return;

  // Retrieval off means the fact layer is off end to end: nothing derived from
  // this chat is sent to the embedding provider, nothing is stored, and the
  // summarizer is not even asked for facts. The rolling summary still runs.
  const embedder = retrievalCount > 0 ? deps.createEmbedder?.(MEMORY_TIMEOUT_MS) : undefined;
  const result = await summarize(deps, {
    userId: chat.userId,
    summary,
    evicted,
    userName: row.personaName ?? DEFAULT_USER_NAME,
    extractFacts: embedder !== undefined,
  });
  if (!result) return;

  const written = await deps.db
    .update(chats)
    .set({
      memory: {
        summary: result.summary,
        anchorMessageId: anchor.id,
        updatedAt: new Date().toISOString(),
      },
    })
    .where(and(eq(chats.id, chatId), eq(chats.memoryRevision, captured)))
    .returning({ id: chats.id });
  // The chat changed under this refresh (an edit, or the user's own summary): the
  // result describes history that no longer holds, and its facts go with it.
  if (written.length === 0) return;

  if (!embedder || result.facts.length === 0) return;
  const vectors = await embedder.embed(result.facts);
  await deps.db.transaction(async (tx) => {
    // Embedding is another window for an edit to land. Locking the chat row
    // serializes this check against the bump an edit performs.
    const [current] = await tx
      .select({ revision: chats.memoryRevision })
      .from(chats)
      .where(eq(chats.id, chatId))
      .for('update');
    if (current?.revision !== captured) return;

    await tx.insert(memories).values(
      result.facts.map((content, index) => ({
        userId: chat.userId,
        plotId: chat.plotId,
        chatId: chat.id,
        content,
        embedding: vectors[index] ?? null,
        sourceMessageId: anchor.id,
      })),
    );
  });
}

/**
 * Invalidates the memory layer for an in-place assistant edit. Runs inside the
 * edit's own transaction, so the bump and the edit land together.
 *
 * Every edit bumps `memory_revision`, which discards any refresh whose snapshot
 * may still contain the old text. An edit the summary already covers additionally
 * drops the summary — the edited words would otherwise stay hidden behind it —
 * and the chat's facts, which are a derived cache the next refresh rebuilds.
 *
 * Also touches `chats.updated_at`, since it owns the chat row write for this edit.
 */
export async function invalidateMemoryForEdit(
  tx: Tx,
  chatId: string,
  editedMessageId: string,
): Promise<void> {
  // Lock the chat row first: a concurrent refresh write serializes behind this, so
  // the anchor read below cannot go stale between the check and the write.
  const [locked] = await tx
    .select({ memory: chats.memory })
    .from(chats)
    .where(eq(chats.id, chatId))
    .for('update');
  if (!locked) return;

  const covered = locked.memory
    ? await coversMessage(tx, chatId, locked.memory.anchorMessageId, editedMessageId)
    : false;

  await tx
    .update(chats)
    .set({
      memoryRevision: sql`${chats.memoryRevision} + 1`,
      updatedAt: new Date(),
      ...(covered ? { memory: null } : {}),
    })
    .where(eq(chats.id, chatId));
  if (covered) await tx.delete(memories).where(eq(memories.chatId, chatId));
}

/** True when the summary anchored at `anchorId` stands for `messageId`. */
async function coversMessage(
  tx: Tx,
  chatId: string,
  anchorId: string,
  messageId: string,
): Promise<boolean> {
  const all = await tx
    .select({ id: messages.id, parentId: messages.parentId })
    .from(messages)
    .where(eq(messages.chatId, chatId));
  const parents = new Map(all.map((message) => [message.id, message.parentId]));

  // The summary covers the anchor and every message above it.
  let current: string | null | undefined = anchorId;
  while (current) {
    if (current === messageId) return true;
    current = parents.get(current);
  }
  return false;
}

/**
 * How many of the oldest messages to fold into the summary so the retained tail
 * fits KEEP_RATIO of the budget, while keeping at least MIN_RETAINED_MESSAGES.
 */
function evictionCount(costs: number[], contextBudget: number): number {
  const keep = contextBudget * KEEP_RATIO;
  let kept = 0;
  let cut = costs.length;
  for (let i = costs.length - 1; i >= 0; i -= 1) {
    const retained = costs.length - i;
    if (kept + costs[i]! > keep && retained > MIN_RETAINED_MESSAGES) break;
    kept += costs[i]!;
    cut = i;
  }
  return cut;
}

interface SummarizeInput {
  /** The chat's owner, whose ChatGPT account does the summarizing. */
  userId: string;
  summary: string;
  evicted: Message[];
  userName: string;
  extractFacts: boolean;
}

interface SummaryResult {
  summary: string;
  facts: string[];
}

/** Memory models already reported as unusable — a config state, not a per-turn failure. */
const warnedModels = new Set<string>();

/**
 * Summaries, suggestions and relationships use the first model in the chat
 * owner's ChatGPT account catalog. A signed-out owner disables background work.
 */
export async function memoryChannel(deps: AppDeps, userId: string): Promise<{ adapter: LLMAdapter; providerModel: string } | null> {
  let modelId = "chatgpt";
  try {
    const account = deps.chatgpt?.accounts.forUser(userId);
    modelId = (deps.env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test'
      ? deps.env['MEMORY_MODEL'] || 'test/memory'
      : (await listEnabledModels(deps.env, account))[0]?.id ?? '';
    if (!modelId) return null;
    return await (deps.getAdapter ?? getAdapter)(modelId, deps.env, account);
  } catch (error) {
    // Warn once, not on every turn for the rest of the process' life.
    if (!warnedModels.has(modelId)) {
      warnedModels.add(modelId);
      console.error('[memory] channel model unavailable, background updates are off', error);
    }
    return null;
  }
}

/** Calls the memory channel model. Returns null when it is unusable — never throws. */
async function summarize(deps: AppDeps, input: SummarizeInput): Promise<SummaryResult | null> {
  const resolved = await memoryChannel(deps, input.userId);
  if (!resolved) return null;

  // Image references are markup for the chat, not content to summarize.
  const transcript = input.evicted
    .map((message) => transcriptLine(message, input.userName))
    .join('\n');
  const request: ChatRequest = {
    model: resolved.providerModel,
    system: MEMORY_RULES + (input.extractFacts ? OUTPUT_WITH_FACTS : OUTPUT_SUMMARY_ONLY),
    messages: [
      {
        role: 'user',
        content: `[기존 요약]\n${input.summary.trim() || '(없음)'}\n\n[새로 요약할 구간]\n${transcript}`,
      },
    ],
    maxTokens: SUMMARY_MAX_TOKENS,
    // A hung provider must not hold this chat's refresh slot indefinitely.
    abortSignal: AbortSignal.timeout(MEMORY_TIMEOUT_MS),
  };

  const raw = (await collect(resolved.adapter, request)).trim();
  if (!raw) return null;
  if (!input.extractFacts) return { summary: raw, facts: [] };
  // Defensive: a model that ignored the schema still gives a usable summary.
  return parseSummaryJson(raw) ?? { summary: raw, facts: [] };
}

/** Drains a non-streaming side-channel call into one string. */
export async function collect(adapter: LLMAdapter, request: ChatRequest): Promise<string> {
  const generator = adapter.stream(request);
  let text = '';
  let next = await generator.next();
  while (!next.done) {
    text += next.value.text;
    next = await generator.next();
  }
  return text;
}

function parseSummaryJson(raw: string): SummaryResult | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const { summary, facts } = parsed as { summary?: unknown; facts?: unknown };
  if (typeof summary !== 'string' || !summary.trim()) return null;
  return {
    summary: summary.trim(),
    facts: (Array.isArray(facts) ? facts : [])
      .filter((fact): fact is string => typeof fact === 'string' && fact.trim().length > 0)
      .map((fact) => fact.trim())
      .slice(0, MAX_FACTS),
  };
}
