import { describe, expect, it } from 'vitest';
import {
  HYPA_V3_DEFAULTS,
  HYPA_V3_SUMMARIZATION_PROMPT,
  SUMMARY_CONTENT_LINE,
  SUMMARY_LANGUAGE_LINE,
  memoryBlock,
  recalledMemoryBlock,
  memoryTokenBudget,
  nextSummaryBatch,
  rankBySimilarity,
  selectSummaries,
  similarityQueries,
  summarizationTurns,
  summaryChunks,
  turnsAgoBucket,
  turnsAgoLabel,
  withTimeLabel,
  type BatchMessage,
  type SummaryCandidate,
} from '../src/memory.js';

const candidates = (spec: [name: string, tokens: number, important?: boolean][]): SummaryCandidate<string>[] =>
  spec.map(([summary, tokens, important = false]) => ({ summary, tokens, important }));

/** A generator that walks a fixed list, for a shuffle the test can predict. */
const sequence = (values: number[]): (() => number) => {
  let at = 0;
  return () => values[at++ % values.length]!;
};

describe('HypaV3 settings', () => {
  it('keeps RisuAI’s defaults but summarizes a tenth of the context past what fits', () => {
    expect(HYPA_V3_DEFAULTS).toEqual({
      memoryTokensRatio: 0.2,
      extraSummarizationRatio: 0.1,
      maxChatsPerSummary: 6,
      recentMemoryRatio: 0.4,
      similarMemoryRatio: 0.4,
      queryChatCount: 3,
      doNotSummarizeUserMessage: false,
      summarizationPrompt: '',
    });
    expect(memoryTokenBudget(16000, HYPA_V3_DEFAULTS)).toBe(3200);
  });

  it('splits a summary into its chunks and joins the selected ones under one heading', () => {
    expect(summaryChunks('  첫 문단.\n\n\n\n둘째 문단.\n셋째 줄.\n\n  ')).toEqual(['첫 문단.', '둘째 문단.\n셋째 줄.']);
    expect(memoryBlock([])).toBe('');
    expect(memoryBlock(['하나.', '둘.'])).toBe('[Summary of the story so far]\n하나.\n\n둘.');
    expect(recalledMemoryBlock([])).toBe('');
    expect(recalledMemoryBlock(['셋.'])).toBe('[Summary of the story so far: recalled this turn]\n셋.');
  });
});

describe('time labels', () => {
  it('buckets turns coarsely, so a label changes only when its bucket does', () => {
    const table: [turns: number, bucket: number][] = [
      [0, 0], [9, 0], [10, 10], [14, 10], [15, 20], [44, 40], [94, 90], [95, 100],
      [99, 100], [100, 100], [124, 100], [125, 150], [474, 450], [475, 500], [549, 500], [550, 600], [1234, 1200],
    ];
    for (const [turns, bucket] of table) expect([turns, turnsAgoBucket(turns)]).toEqual([turns, bucket]);
    // From 10 on the label holds for at least ten turns at a time.
    const changes = Array.from({ length: 1000 }, (_, turns) => turnsAgoBucket(turns)).filter(
      (bucket, turns, all) => turns > 0 && bucket !== all[turns - 1],
    );
    expect(changes.length).toBeLessThan(1000 / 10);
  });

  it('says it in the conversation’s language, Korean when that is unknown, and leads the text with it', () => {
    expect(turnsAgoLabel(42, 'ko')).toBe('약 40턴 전');
    expect(turnsAgoLabel(42, 'en')).toBe('~40 turns ago');
    expect(turnsAgoLabel(42, 'ja')).toBe('約40ターン前');
    expect(turnsAgoLabel(3, 'ko')).toBe('최근 10턴 이내');
    expect(turnsAgoLabel(3, 'en')).toBe('within the last 10 turns');
    expect(turnsAgoLabel(3, 'ja')).toBe('直近10ターン以内');
    expect(turnsAgoLabel(-2, undefined)).toBe('최근 10턴 이내');
    expect(turnsAgoLabel(260, undefined)).toBe('약 250턴 전');
    expect(withTimeLabel('리안은 열쇠를 맡았다.', '약 40턴 전')).toBe('(약 40턴 전) 리안은 열쇠를 맡았다.');
    expect(withTimeLabel('리안은 열쇠를 맡았다.', '')).toBe('리안은 열쇠를 맡았다.');
  });
});

describe('selectSummaries', () => {
  it('takes the important ones first, then the recent from the newest back, then random — oldest first in the end', async () => {
    // 100 to spend: important `a` (20) leaves 80 → recent 32, similar 32 (no
    // ranking: unused), random ~16 + 32 unused similar + recent’s leftover.
    const pool = candidates([
      ['a', 20, true],
      ['b', 10],
      ['c', 10],
      ['d', 10],
      ['e', 15],
      ['f', 15],
    ]);
    const result = await selectSummaries(pool, 100, HYPA_V3_DEFAULTS, null, sequence([0]));
    expect(result.important).toEqual(['a']);
    // From the newest back: f (15), e (15) = 30; d would make 40 > 32 — stop.
    expect(result.recent).toEqual(['e', 'f']);
    expect(result.similar).toEqual([]);
    // Random pool: ~16 + (32 - 30) + 32; b, c, d (30) all fit.
    expect([...result.random].sort()).toEqual(['b', 'c', 'd']);
    expect(result.selected).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('stops the important phase at the first that does not fit, as HypaV3 does', async () => {
    const pool = candidates([
      ['a', 60, true],
      ['b', 50, true],
      ['c', 5, true],
    ]);
    const result = await selectSummaries(pool, 100, { recentMemoryRatio: 1, similarMemoryRatio: 0 }, null);
    expect(result.important).toEqual(['a']);
    // `c` is not important-selected (the phase broke at `b`), but recent takes it.
    expect(result.recent).toEqual(['c']);
  });

  it('ranks the similar share over what important and recent left, and stops at the first that does not fit', async () => {
    const pool = candidates([
      ['a', 10],
      ['b', 10],
      ['c', 10],
      ['d', 10],
      ['e', 10],
    ]);
    let handed: string[] = [];
    const result = await selectSummaries(
      pool,
      100,
      { recentMemoryRatio: 0.1, similarMemoryRatio: 0.2 },
      async (unused) => {
        handed = unused;
        return ['b', 'd', 'a'];
      },
      sequence([0.99]),
    );
    expect(result.recent).toEqual(['e']);
    expect(handed).toEqual(['a', 'b', 'c', 'd']);
    expect(result.similar).toEqual(['b', 'd']);
    // Random: 70 + 0 + 0 left; a and c both fit.
    expect([...result.random].sort()).toEqual(['a', 'c']);
  });

  it('skips a random pick that does not fit and tries the next', async () => {
    const pool = candidates([
      ['big', 50],
      ['small', 5],
    ]);
    const result = await selectSummaries(pool, 10, { recentMemoryRatio: 0, similarMemoryRatio: 0 }, null, sequence([0.99]));
    expect(result.random).toEqual(['small']);
  });

  it('hands the unused recent share to similar when there is no random share', async () => {
    const pool = candidates([
      ['a', 30],
      ['b', 30],
      ['c', 30],
    ]);
    const result = await selectSummaries(pool, 100, { recentMemoryRatio: 0.5, similarMemoryRatio: 0.5 }, async () => [
      'a',
      'b',
    ]);
    // Recent 50: c (30); b would make 60. Similar 50 + 20 unused = 70: a, b.
    expect(result.recent).toEqual(['c']);
    expect(result.similar).toEqual(['a', 'b']);
  });

  it('falls back to random when the embedder is unavailable or the ranking fails', async () => {
    const pool = candidates([
      ['a', 10],
      ['b', 10],
      ['c', 10],
      ['d', 10],
    ]);
    for (const rank of [null, async () => Promise.reject(new Error('embedder down'))]) {
      const result = await selectSummaries(pool, 50, HYPA_V3_DEFAULTS, rank, sequence([0]));
      expect(result.similar).toEqual([]);
      // Recent 20: d, c. Random: 10 + 0 + 20 = 30 → a and b.
      expect(result.recent).toEqual(['c', 'd']);
      expect([...result.random].sort()).toEqual(['a', 'b']);
    }
  });

  it('gives the similar share to more recent ones when it fails without a random share', async () => {
    const pool = candidates([
      ['a', 10],
      ['b', 10],
      ['c', 10],
      ['d', 10],
    ]);
    const result = await selectSummaries(pool, 40, { recentMemoryRatio: 0.5, similarMemoryRatio: 0.5 }, null);
    expect(result.selected).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never goes over the budget', async () => {
    const pool = candidates(Array.from({ length: 40 }, (_, i) => [`s${i}`, 7 + (i % 5)] as [string, number]));
    for (const seed of [0, 0.3, 0.7, 0.99]) {
      const result = await selectSummaries(pool, 101, HYPA_V3_DEFAULTS, async (unused) => [...unused].reverse(), sequence([seed]));
      const spent = result.selected.reduce((sum, name) => sum + pool.find((c) => c.summary === name)!.tokens, 0);
      expect(spent).toBeLessThanOrEqual(101);
    }
  });
});

describe('rankBySimilarity', () => {
  it('weights the newest query most and lifts a summary by all of its chunks', () => {
    type Chunk = { summary: string; id: string };
    const chunk = (summary: string, id: string): Chunk => ({ summary, id });
    const a1 = chunk('A', 'a1');
    const b1 = chunk('B', 'b1');
    const b2 = chunk('B', 'b2');
    // Query 1 (weight 1/3) prefers A; query 2 (weight 2/3) prefers B.
    const ranked = rankBySimilarity(
      [
        [
          [a1, 0.9],
          [b1, 0.1],
          [b2, 0.1],
        ],
        [
          [a1, 0.2],
          [b1, 0.8],
          [b2, 0.7],
        ],
      ],
      (c: Chunk) => c.summary,
    );
    expect(ranked).toEqual(['B', 'A']);
  });

  it('takes the latest turns that say anything as the queries', () => {
    expect(similarityQueries(['one', 'two', ' ', 'three', 'four'], { queryChatCount: 3 })).toEqual(['three', 'four']);
  });
});

describe('nextSummaryBatch', () => {
  const message = (id: string, tokens: number, covered = false, role: 'user' | 'assistant' = 'assistant'): BatchMessage => ({
    id,
    role,
    tokens,
    covered,
  });
  /** 20 messages of 100 tokens, alternating roles, the first `covered` of them covered. */
  const branch = (covered = 0): BatchMessage[] =>
    Array.from({ length: 20 }, (_, i) => message(`m${i}`, 100, i < covered, i % 2 === 0 ? 'assistant' : 'user'));
  // At budget 3000: memory 600 and reply 600 leave 1800 for the 2000 of history.
  const budget = { contextBudget: 3000, responseReserve: 600 };

  it('does nothing while the uncovered tail fits', () => {
    expect(nextSummaryBatch(branch(), HYPA_V3_DEFAULTS, { contextBudget: 3000, responseReserve: 0 })).toBeNull();
  });

  it('summarizes the oldest maxChatsPerSummary of the tail once it does not fit', () => {
    const batch = nextSummaryBatch(branch(), HYPA_V3_DEFAULTS, budget);
    expect(batch).toEqual({
      messageIds: ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'],
      summarizedIds: ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'],
      gap: false,
    });
    // After the first batch, the tail (14 × 100) fits the 2000 — done.
    expect(nextSummaryBatch(branch(6), HYPA_V3_DEFAULTS, budget, true)).toBeNull();
  });

  it('never summarizes the latest queryChatCount messages', () => {
    const tight = { contextBudget: 1000, responseReserve: 600 };
    let covered = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      const batch = nextSummaryBatch(branch(covered), HYPA_V3_DEFAULTS, tight, pass > 0);
      if (!batch) break;
      covered += batch.messageIds.length;
    }
    expect(covered).toBe(17);
  });

  it('goes on past fitting by the extra summarization ratio within a run', () => {
    const settings = { ...HYPA_V3_DEFAULTS, extraSummarizationRatio: 0.3 };
    // fits = 3000 - 600 - 600 = 1800; target = 2100 - 1200 = 900.
    const first = nextSummaryBatch(branch(), settings, budget);
    expect(first?.messageIds).toHaveLength(6);
    // Tail 1400: fits, but over target and a batch keeps it at 800 < 900 — stop.
    expect(nextSummaryBatch(branch(6), settings, budget, true)).toBeNull();
    // Not continuing a run, a tail that fits is left alone.
    expect(nextSummaryBatch(branch(6), settings, budget)).toBeNull();
  });

  it('closes a gap a dropped summary left first, whatever the budget', () => {
    const messages = branch(12).map((m, i) => (i >= 3 && i < 6 ? { ...m, covered: false } : m));
    expect(nextSummaryBatch(messages, HYPA_V3_DEFAULTS, { contextBudget: 100_000, responseReserve: 0 })).toEqual({
      messageIds: ['m3', 'm4', 'm5'],
      summarizedIds: ['m3', 'm4', 'm5'],
      gap: true,
    });
  });

  it('covers the reader’s turns without summarizing them under doNotSummarizeUserMessage', () => {
    const settings = { ...HYPA_V3_DEFAULTS, doNotSummarizeUserMessage: true, maxChatsPerSummary: 1 };
    // m0 is the assistant's; m1 the reader's alone would be a summary of nothing,
    // so it takes m2 along.
    expect(nextSummaryBatch(branch(), settings, budget)?.summarizedIds).toEqual(['m0']);
    expect(nextSummaryBatch(branch(1), settings, budget, true)).toEqual({
      messageIds: ['m1', 'm2'],
      summarizedIds: ['m2'],
      gap: false,
    });
  });
});

describe('summarizationTurns', () => {
  it('sends the messages and then HypaV3’s instruction as a system turn, with the conversation’s language and the adult-fiction line', () => {
    expect(summarizationTurns('A: hi', '')).toEqual([
      { role: 'user', content: 'A: hi' },
      { role: 'system', content: `${HYPA_V3_SUMMARIZATION_PROMPT}\n${SUMMARY_LANGUAGE_LINE}\n${SUMMARY_CONTENT_LINE}` },
    ]);
    // A chat's own prompt goes as written.
    expect(summarizationTurns('A: hi', 'Summarize briefly.')).toEqual([
      { role: 'user', content: 'A: hi' },
      { role: 'system', content: 'Summarize briefly.' },
    ]);
  });

  it('reads a ChatML prompt with the messages in its slot', () => {
    const prompt = '<|im_start|>system\nSummarize.<|im_end|><|im_start|>user\n{{slot}}<|im_end|>';
    expect(summarizationTurns('A: hi', prompt)).toEqual([
      { role: 'system', content: 'Summarize.' },
      { role: 'user', content: 'A: hi' },
    ]);
  });
});
