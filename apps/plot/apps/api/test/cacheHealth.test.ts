import type { AssembledPrompt, MessageSource, PromptBlockKind, PromptMessage } from '@shizue/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { chatRequestSent } from '../src/cacheHealth.js';

/** A request as the assembler gives it: system sections, then messages with what each is. */
function request(
  parts: { sections?: [PromptBlockKind, string][]; turns: [MessageSource['kind'], PromptMessage['role'], string, string?][] },
): AssembledPrompt {
  const sections = parts.sections ?? [['main', '메인 지시.'], ['memory', '[지난 이야기 요약]\n(약 20턴 전) 요약.']];
  return {
    system: sections.map(([, text]) => text).join('\n\n'),
    systemSections: sections.map(([kind, text]) => ({ kind, text })),
    messages: parts.turns.map(([, role, content]) => ({ role, content })),
    sources: parts.turns.map(([kind, , , id]) => ({ kind, ...(id !== undefined ? { id } : {}) })),
    loreTriggers: [],
  };
}

const turn = (id: string, role: 'user' | 'assistant', text: string): [MessageSource['kind'], PromptMessage['role'], string, string] => [
  'history',
  role,
  text,
  id,
];
const recall: [MessageSource['kind'], PromptMessage['role'], string] = ['recall', 'system', '[기억]\n- 사실.'];
const history = (...ids: string[]) => ids.map((id) => ({ id }));
const usage = (cached: number, promptTokens = 30_000) => ({ promptTokens, cachedPromptTokens: cached });

describe('the prompt cache log', () => {
  let log: MockInstance<typeof console.log>;
  let chat = 0;
  let chatId = '';
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    chatId = `chat-${(chat += 1)}`;
  });
  afterEach(() => log.mockRestore());
  const line = (): string => String(log.mock.calls.at(-1)?.[0] ?? '');

  /** Turn n: the history from `start`, then the reader's turn n. */
  const turns = (start: number, n: number) =>
    Array.from({ length: 2 * n - 2 * start + 1 }, (_, at) => {
      const index = 2 * start + at;
      return turn(`m${index}`, index % 2 === 0 ? 'user' : 'assistant', `말 ${index}`);
    });
  /** Sends turn n's request and reports `cached`, `seconds` after the previous one. */
  const send = (prompt: AssembledPrompt, clock: number, ids: string[], cached: number, at: number) =>
    chatRequestSent({ chatId }, prompt, { clock, history: history(...ids) }, at)(usage(cached));

  it('says the share and the gap, and names no reason when the turn was served what the one before left', () => {
    send(request({ turns: [...turns(0, 1), recall] }), 10, ['m0'], 0, 0);
    expect(line()).toContain(`[cache] chat ${chatId}: 0 of 30000 prompt tokens cached (0%), no earlier request of the chat seen; miss: first`);
    send(request({ turns: [...turns(0, 2), recall] }), 10, ['m0', 'm1', 'm2'], 29_000, 90_000);
    expect(line()).toBe(`[cache] chat ${chatId}: 29000 of 30000 prompt tokens cached (97%), 90 s after the chat's request before`);
  });

  it('names a summary landing over the clock and the summary block it moved', () => {
    send(request({ turns: [...turns(0, 2), recall] }), 10, ['m0', 'm1', 'm2'], 0, 0);
    const landed = request({ sections: [['main', '메인 지시.'], ['memory', '[지난 이야기 요약]\n(약 10턴 전) 요약.\n\n(약 10턴 전) 새 요약.']], turns: [...turns(1, 3), recall] });
    send(landed, 12, ['m2', 'm3', 'm4'], 0, 30_000);
    expect(line()).toMatch(/30 s after the chat's request before, ~\d+ expected; miss: summary_landed$/);
  });

  it('tells an edit that dropped a summary from a landing, and an edited last turn from either', () => {
    send(request({ turns: [...turns(1, 2), recall] }), 10, ['m2', 'm3', 'm4'], 0, 0);
    // The history starts earlier again: the summary over m0–m1 went with an edit.
    send(request({ sections: [['main', '메인 지시.']], turns: [...turns(0, 3), recall] }), 10, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'], 0, 10_000);
    expect(line()).toMatch(/miss: edited_or_regenerated$/);
    // The reader rewrote their last turn: the turn the earlier request ended on is not there as it was.
    const rewritten = [...turns(0, 3).slice(0, -1), turn('m6', 'user', '고친 말')];
    send(request({ sections: [['main', '메인 지시.']], turns: [...rewritten, recall] }), 10, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'], 0, 20_000);
    expect(line()).toMatch(/miss: edited_or_regenerated$/);
  });

  it('names the lore, the clock and the rest of the system string apart', () => {
    const base = (memory: string, lore = '로어 하나.', main = '메인 지시.'): [PromptBlockKind, string][] => [
      ['main', main],
      ['lore_before', lore],
      ['memory', memory],
    ];
    const ids = (n: number) => Array.from({ length: 2 * n + 1 }, (_, at) => `m${at}`);
    send(request({ sections: base('요약.'), turns: [...turns(0, 1), recall] }), 10, ids(0), 0, 0);
    send(request({ sections: base('요약.', '로어 둘.'), turns: [...turns(0, 2), recall] }), 10, ids(1), 0, 1_000);
    expect(line()).toMatch(/miss: system_changed:lore$/);
    send(request({ sections: base('(시계) 요약.', '로어 둘.'), turns: [...turns(0, 3), recall] }), 20, ids(2), 0, 2_000);
    expect(line()).toMatch(/miss: system_changed:clock$/);
    send(request({ sections: base('(시계) 요약.', '로어 둘.', '{{time}} 메인.'), turns: [...turns(0, 4), recall] }), 20, ids(3), 0, 3_000);
    expect(line()).toMatch(/miss: system_changed:other$/);
  });

  it('names the budget dropping the oldest turn, and a depth injection moving among the turns', () => {
    const ids = Array.from({ length: 9 }, (_, at) => `m${at}`);
    send(request({ turns: [...turns(0, 2), recall] }), 10, ids, 0, 0);
    // Nothing landed, but the first turn sent is a later one.
    send(request({ turns: [...turns(1, 3), recall] }), 10, ids, 0, 1_000);
    expect(line()).toMatch(/miss: history_shifted$/);
    // The author's note four turns from the end: it stands one turn later each time.
    const note: [MessageSource['kind'], PromptMessage['role'], string] = ['author_note', 'system', '작가 노트.'];
    const at = (n: number) => {
      const all = turns(1, n);
      return [...all.slice(0, -4), note, ...all.slice(-4), recall];
    };
    send(request({ turns: at(4) }), 10, ids, 0, 2_000);
    send(request({ turns: at(5) }), 10, ids, 0, 3_000);
    expect(line()).toMatch(/miss: depth_injection$/);
  });

  it('blames a long gap, or nothing it can tell, when the turn went on from the earlier one and was still missed', () => {
    const ids = Array.from({ length: 9 }, (_, at) => `m${at}`);
    send(request({ turns: [...turns(0, 2), recall] }), 10, ids, 0, 0);
    send(request({ turns: [...turns(0, 3), recall] }), 10, ids, 0, 30_000);
    expect(line()).toMatch(/miss: unknown$/);
    send(request({ turns: [...turns(0, 4), recall] }), 10, ids, 0, 30_000 + 6 * 60_000);
    expect(line()).toMatch(/360 s after the chat's request before, ~\d+ expected; miss: gap_long$/);
  });

  it('compares a group member’s turn with that member’s own last one, and a regenerate with the turn it replaces', () => {
    const ids = Array.from({ length: 9 }, (_, at) => `m${at}`);
    const speaking = (speaker: number, prompt: AssembledPrompt, cached: number, at: number) =>
      chatRequestSent({ chatId, speaker }, prompt, { clock: 10, history: history(...ids) }, at)(usage(cached));
    speaking(0, request({ turns: [...turns(0, 1), ['history', 'assistant', '1번의 말', 'r0'], recall] }), 0, 0);
    // Another member reads the round differently; it is its own first.
    speaking(1, request({ turns: [...turns(0, 1), ['history', 'assistant', '0번: 1번의 말', 'r0'], recall] }), 0, 1_000);
    expect(line()).toContain(`chat ${chatId} (speaker 1)`);
    expect(line()).toMatch(/miss: first$/);
    // A regenerate repeats the turn up to the reader's: it is served, and nothing is missed.
    send(request({ turns: [...turns(0, 2), recall] }), 10, ids, 0, 2_000);
    send(request({ turns: [...turns(0, 2), ['recall', 'system', '[기억]\n- 다른 사실.']] }), 10, ids, 28_000, 3_000);
    expect(line()).not.toContain('miss');
  });
});
