/**
 * The chat memory as RisuAI's HypaV3 (`process/memory/hypav3.ts`, its
 * `hypaMemoryV3Main`): the branch's older messages are summarized a batch at a
 * time into separate summaries, and each request carries a selection of them —
 * the pinned ones first, then the most recent, then the ones most similar to the
 * latest turns, then random ones — that fills a fixed share of the context.
 *
 * What is RisuAI's here is the data model, the batching and the selection, with
 * its default settings. What is not: RisuAI summarizes while it builds the
 * request; here the API does it in the background after a reply, and the
 * request only selects (§7.3 of the architecture). A summary applies to a branch
 * only while every message it covers is on it, and the summaries are ordered by
 * where their messages stand on that branch rather than by when they were made.
 *
 * Pure: the API loads the summaries, counts nothing it does not pass in, and
 * ranks by the vectors it holds.
 */

/** HypaV3's settings a chat may tune (RisuAI's `HypaV3Settings`, the subset that applies here). */
export interface HypaV3Settings {
  /** Share of the context budget the selected summaries may fill. */
  memoryTokensRatio: number;
  /** Share of the context budget summarized beyond what is needed to fit. */
  extraSummarizationRatio: number;
  /** Messages one summary covers at most. */
  maxChatsPerSummary: number;
  /** Share of the memory budget for the most recent summaries. */
  recentMemoryRatio: number;
  /** Share of the memory budget for the summaries most similar to the latest turns; the rest is random. */
  similarMemoryRatio: number;
  /** Latest messages never summarized, and the queries of the similarity search. */
  queryChatCount: number;
  /** Leave the reader's turns out of what is summarized. */
  doNotSummarizeUserMessage: boolean;
  /** The summarizer's instruction; empty for RisuAI's default. `{{slot}}` takes the messages in a ChatML prompt. */
  summarizationPrompt: string;
}

/** RisuAI's `createHypaV3Preset` defaults. */
export const HYPA_V3_DEFAULTS: Readonly<HypaV3Settings> = {
  memoryTokensRatio: 0.2,
  extraSummarizationRatio: 0,
  maxChatsPerSummary: 6,
  recentMemoryRatio: 0.4,
  similarMemoryRatio: 0.4,
  queryChatCount: 3,
  doNotSummarizeUserMessage: false,
  summarizationPrompt: '',
};

/** HypaV3's summarizer instruction when the setting is empty, verbatim. */
export const HYPA_V3_SUMMARIZATION_PROMPT =
  '[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]';

/** Longest custom summarization prompt a chat may keep. */
export const MAX_SUMMARIZATION_PROMPT_LENGTH = 10_000;
/** Most messages one summary may be set to cover. */
export const MAX_CHATS_PER_SUMMARY = 50;
/** Most latest messages a chat may keep out of summaries and search by. */
export const MAX_QUERY_CHAT_COUNT = 20;

/** The memory block's head in the prompt; the summaries follow it. */
export const MEMORY_HEADING = '[지난 이야기 요약]';
/** Between two summaries in the memory block, and what each is counted with (HypaV3's `summarySeparator`). */
export const SUMMARY_SEPARATOR = '\n\n';

/** The settings a chat runs with: its own where it set them, HypaV3's defaults elsewhere. */
export function hypaV3SettingsOf(overrides: Partial<HypaV3Settings> | null | undefined): HypaV3Settings {
  return { ...HYPA_V3_DEFAULTS, ...(overrides ?? {}) };
}

/** Tokens the summaries may take: HypaV3's `memoryTokens`. */
export function memoryTokenBudget(contextBudget: number, settings: Pick<HypaV3Settings, 'memoryTokensRatio'>): number {
  return Math.floor(contextBudget * settings.memoryTokensRatio);
}

/**
 * A summary's text as the similarity search embeds it: HypaV3's default
 * `summaryChunkSeparator` (`\n\n`), the pieces trimmed and the blank ones left out.
 */
export function summaryChunks(text: string): string[] {
  return text
    .split(/\n\n/)
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => chunk.trim());
}

/** The memory block the prompt carries for the selected summaries, oldest first; '' for none. */
export function memoryBlock(texts: readonly string[]): string {
  return texts.length > 0 ? `${MEMORY_HEADING}\n${texts.join(SUMMARY_SEPARATOR)}` : '';
}

/* -------------------------------------------------------------- selection */

/** A summary that may be selected, with what it costs. */
export interface SummaryCandidate<T> {
  summary: T;
  important: boolean;
  /** `countTokens(text + SUMMARY_SEPARATOR)`, as HypaV3 counts each one. */
  tokens: number;
}

/** What one selection picked, by the phase that picked it, and all of it oldest first. */
export interface SummarySelection<T> {
  selected: T[];
  important: T[];
  recent: T[];
  similar: T[];
  random: T[];
}

/**
 * HypaV3's selection (`hypaMemoryV3Main`, after its summarization phase).
 * `candidates` are oldest first; `available` is the memory budget less the
 * empty block's cost. The phases, each over what the ones before left:
 *
 * - important, in order, stopping at the first that does not fit what is left;
 * - recent, `available × recentMemoryRatio` (of what the important ones left),
 *   from the newest back, stopping at the first that does not fit;
 * - similar, `available × similarMemoryRatio`, best ranked first, stopping at the
 *   first that does not fit — plus what recent left unused when there is no
 *   random share. `rankSimilar` ranks the summaries it is handed; null (or a
 *   ranking that throws) is the embedder being unavailable, and the share then
 *   goes unused, which hands it to random;
 * - random, the rest of the budget plus what recent and similar left unused,
 *   shuffled with `random`, skipping any that does not fit.
 *
 * Without a random share a ranking that fails would leave the similar share
 * empty; then it goes to the recent ones instead, continuing from where recent
 * stopped — the embedder being down never costs the prompt its memory.
 */
export async function selectSummaries<T>(
  candidates: readonly SummaryCandidate<T>[],
  available: number,
  settings: Pick<HypaV3Settings, 'recentMemoryRatio' | 'similarMemoryRatio'>,
  rankSimilar: ((unused: T[]) => Promise<T[]>) | null,
  random: () => number = Math.random,
): Promise<SummarySelection<T>> {
  const order = new Map(candidates.map((candidate, index) => [candidate.summary, index]));
  const cost = new Map(candidates.map((candidate) => [candidate.summary, candidate.tokens]));
  const picked = new Set<T>();
  const unused = (): T[] => candidates.map((candidate) => candidate.summary).filter((summary) => !picked.has(summary));
  const randomRatio = 1 - settings.recentMemoryRatio - settings.similarMemoryRatio;

  const important: T[] = [];
  for (const candidate of candidates) {
    if (!candidate.important) continue;
    if (candidate.tokens > available) break;
    important.push(candidate.summary);
    picked.add(candidate.summary);
    available -= candidate.tokens;
  }

  const recent: T[] = [];
  const recentReserved = Math.floor(available * settings.recentMemoryRatio);
  let recentUsed = 0;
  /** Takes recent ones from the newest unused back, until one does not fit `reserved`. */
  const takeRecent = (reserved: number): number => {
    let used = 0;
    const pool = unused();
    for (let i = pool.length - 1; i >= 0; i -= 1) {
      const summary = pool[i]!;
      const tokens = cost.get(summary)!;
      if (tokens + used > reserved) break;
      recent.push(summary);
      picked.add(summary);
      used += tokens;
    }
    return used;
  };
  if (settings.recentMemoryRatio > 0) recentUsed = takeRecent(recentReserved);

  const similar: T[] = [];
  let similarReserved = Math.floor(available * settings.similarMemoryRatio);
  let similarUsed = 0;
  let rankingFailed = false;
  if (settings.similarMemoryRatio > 0) {
    if (randomRatio <= 0) similarReserved += recentReserved - recentUsed;
    let ranked: T[] | null = null;
    if (rankSimilar) {
      try {
        ranked = await rankSimilar(unused());
      } catch {
        ranked = null;
      }
    }
    if (ranked === null) rankingFailed = true;
    for (const summary of ranked ?? []) {
      if (picked.has(summary) || !cost.has(summary)) continue;
      const tokens = cost.get(summary)!;
      if (tokens + similarUsed > similarReserved) break;
      similar.push(summary);
      picked.add(summary);
      similarUsed += tokens;
    }
  }

  const randomPicks: T[] = [];
  if (randomRatio > 0) {
    const reserved =
      Math.floor(available * randomRatio) + (recentReserved - recentUsed) + (similarReserved - similarUsed);
    let used = 0;
    for (const summary of shuffle(unused(), random)) {
      const tokens = cost.get(summary)!;
      if (tokens + used > reserved) continue;
      randomPicks.push(summary);
      picked.add(summary);
      used += tokens;
    }
  } else if (rankingFailed && similarReserved - similarUsed > 0) {
    takeRecent(similarReserved - similarUsed);
  }

  const chronological = (list: T[]): T[] => [...list].sort((a, b) => order.get(a)! - order.get(b)!);
  return {
    selected: chronological([...picked]),
    important,
    recent: chronological(recent),
    similar,
    random: chronological(randomPicks),
  };
}

/** Fisher–Yates on a copy. RisuAI sorts by `Math.random() - 0.5`, which is a biased shuffle; the intent is a shuffle. */
function shuffle<T>(list: T[], random: () => number): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * HypaV3's ranking of the summaries by similarity to the latest turns. One list
 * per query, oldest query first, each of `[chunk, similarity]` for every chunk:
 * the chunks are fused by HypaV3's `simpleCC`, each query weighted by its place
 * (`(i + 1) / (n(n + 1) / 2)`, so the newest turn counts most), and the chunks'
 * ranks fused into their summaries' by `childToParentRRF` (k = 60) — a summary
 * with several well-placed chunks rises above one with a single close one.
 */
export function rankBySimilarity<C, P>(scoredLists: readonly (readonly [C, number])[][], parentOf: (chunk: C) => P): P[] {
  const total = scoredLists.length;
  const scores = new Map<C, number>();
  scoredLists.forEach((list, index) => {
    const weight = (index + 1) / ((total * (total + 1)) / 2);
    // Each list best first, as HypaV3's `similaritySearchScoredEx` hands it over:
    // the fused map then meets the chunks in that order, which settles its ties.
    for (const [chunk, score] of [...list].sort((a, b) => b[1] - a[1])) {
      scores.set(chunk, (scores.get(chunk) ?? 0) + score * weight);
    }
  });
  const rankedChunks = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([chunk]) => chunk);

  const parents = new Map<P, number>();
  rankedChunks.forEach((chunk, index) => {
    const parent = parentOf(chunk);
    parents.set(parent, (parents.get(parent) ?? 0) + 1 / (60 + index + 1));
  });
  return [...parents.entries()].sort((a, b) => b[1] - a[1]).map(([parent]) => parent);
}

/** HypaV3's queries: the latest `queryChatCount` turns that say anything, oldest first. */
export function similarityQueries(latest: readonly string[], settings: Pick<HypaV3Settings, 'queryChatCount'>): string[] {
  return latest.slice(-settings.queryChatCount).filter((content) => content.trim().length > 0);
}

/* --------------------------------------------------------------- batching */

/** A message of the branch as the summarizer plans over it. */
export interface BatchMessage {
  id: string;
  role: 'user' | 'assistant';
  /** What it costs in the prompt. */
  tokens: number;
  /** Covered by a summary that applies to this branch. */
  covered: boolean;
}

/** The next summary to write: the messages it covers, and those of them it is made from. */
export interface SummaryBatch {
  /** Oldest first. Every message the summary stands for, the ones left out of its text included. */
  messageIds: string[];
  /** The ones its text is made from. */
  summarizedIds: string[];
  /** Whether it closes a gap a dropped summary left, rather than taking from the tail. */
  gap: boolean;
}

export interface BatchBudget {
  contextBudget: number;
  /** What the reply may take. */
  responseReserve: number;
  /**
   * What the rest of the prompt takes, which no history can have: the
   * assembler's `fixedTokens` for the chat's last request, or 0 where none is
   * known. HypaV3 counts the whole request; leaving this out would let the
   * oldest history fall out of the prompt before any summary covers it.
   */
  fixedTokens?: number;
}

/**
 * The next batch to summarize on a branch, or null when it needs none.
 * `messages` are the branch's messages a model reads (hidden ones and empty
 * ones left out), oldest first.
 *
 * - **A gap first.** Messages before the last covered one that no summary
 *   covers — what a dropped summary (an edit, a hide or a delete) left — are
 *   summarized whatever the budget, the oldest stretch first and at most
 *   `maxChatsPerSummary` of it: the prompt's history starts after the last
 *   covered message, so until then that stretch is in neither.
 * - **Then the tail, as HypaV3 does.** The messages after the last covered one
 *   are what the prompt sends verbatim. When they outgrow what fits —
 *   `contextBudget − memory budget − responseReserve − fixedTokens` — the oldest
 *   `maxChatsPerSummary` of them are summarized, never the latest
 *   `queryChatCount`. A run (`continuing`) goes on past fitting until the tail
 *   is down to `extraSummarizationRatio` under it, but never a batch that would
 *   take it below that.
 *
 * With `doNotSummarizeUserMessage` the reader's turns are covered but left out
 * of the text, as HypaV3 leaves them out — and a batch is stretched until it has
 * at least one other message, since a summary of nothing would leave its turns
 * to be batched again forever.
 */
export function nextSummaryBatch(
  messages: readonly BatchMessage[],
  settings: HypaV3Settings,
  budget: BatchBudget,
  continuing = false,
): SummaryBatch | null {
  const summarizable = (message: BatchMessage): boolean =>
    !settings.doNotSummarizeUserMessage || message.role !== 'user';
  const toBatch = (list: BatchMessage[], gap: boolean): SummaryBatch => ({
    messageIds: list.map((message) => message.id),
    summarizedIds: list.filter(summarizable).map((message) => message.id),
    gap,
  });
  const lastCovered = messages.findLastIndex((message) => message.covered);

  const gapStart = messages.findIndex((message, index) => index < lastCovered && !message.covered);
  if (gapStart >= 0) {
    let end = gapStart;
    const stop = (index: number): boolean => index >= lastCovered || messages[index]!.covered;
    while (!stop(end) && end - gapStart < settings.maxChatsPerSummary) end += 1;
    while (!stop(end) && !messages.slice(gapStart, end).some(summarizable)) end += 1;
    const batch = messages.slice(gapStart, end);
    if (batch.some(summarizable)) return toBatch(batch, true);
    // A gap of reader turns alone, with nothing after it to join: covered by a
    // summary of nothing would be no summary, so it is left as it is.
  }

  const tail = messages.slice(lastCovered + 1);
  const memory = memoryTokenBudget(budget.contextBudget, settings);
  const fixed = budget.responseReserve + (budget.fixedTokens ?? 0);
  const fits = budget.contextBudget - memory - fixed;
  const target = budget.contextBudget * (1 - settings.extraSummarizationRatio) - memory - fixed;
  const tailTokens = tail.reduce((sum, message) => sum + message.tokens, 0);
  if (continuing ? tailTokens <= target : tailTokens <= fits) return null;

  const limit = tail.length - settings.queryChatCount;
  let end = Math.min(settings.maxChatsPerSummary, limit);
  while (end < limit && end > 0 && !tail.slice(0, end).some(summarizable)) end += 1;
  if (end <= 0) return null;
  const batch = tail.slice(0, end);
  const batchTokens = batch.reduce((sum, message) => sum + message.tokens, 0);
  if (tailTokens <= fits && tailTokens - batchTokens < target) return null;
  if (!batch.some(summarizable)) return null;
  return toBatch(batch, false);
}

/* ------------------------------------------------------------- the request */

export interface SummarizationTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * The summarizer's request, as HypaV3's `summarize` builds it: a prompt written
 * in ChatML (`<|im_start|>…`) with `{{slot}}` replaced by the messages is that
 * conversation; any other prompt goes after the messages as a system turn — the
 * messages first, as one user turn. RisuAI also runs its CBS over each ChatML
 * turn; nothing here does.
 */
export function summarizationTurns(transcript: string, prompt: string): SummarizationTurn[] {
  const instruction = prompt.trim() === '' ? HYPA_V3_SUMMARIZATION_PROMPT : prompt;
  return (
    parseChatML(instruction.replaceAll('{{slot}}', transcript)) ?? [
      { role: 'user', content: transcript },
      { role: 'system', content: instruction },
    ]
  );
}

/** RisuAI's `parseChatML`, without the CBS pass and the `<Thoughts>` it keeps aside. */
function parseChatML(data: string): SummarizationTurn[] | null {
  const starter = '<|im_start|>';
  const separator = '<|im_sep|>';
  const ender = '<|im_end|>';
  const trimmed = data.trim();
  if (!trimmed.startsWith(starter)) return null;
  return trimmed
    .split(starter)
    .filter((part) => part !== '')
    .map((part) => {
      let role: SummarizationTurn['role'] = 'user';
      let content = part;
      for (const name of ['user', 'system', 'assistant'] as const) {
        if (content.startsWith(name + separator)) {
          role = name;
          content = content.substring(name.length + separator.length);
          break;
        }
        if (content.startsWith(`${name} `) || content.startsWith(`${name}\n`)) {
          role = name;
          content = content.substring(name.length + 1);
          break;
        }
      }
      content = content.trim();
      if (content.endsWith(ender)) content = content.substring(0, content.length - ender.length);
      return { role, content: content.replace(/<Thoughts>(.+)<\/Thoughts>/gms, '') };
    });
}
