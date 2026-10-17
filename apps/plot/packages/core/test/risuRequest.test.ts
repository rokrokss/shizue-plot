import { describe, expect, it } from 'vitest';
import { assemblePrompt, promptText, type HistoryMessage, type PromptCharacter, type PromptPlot } from '../src/prompt.js';
import { RISU_NEW_CHAT, RISU_REQUEST_ITEMS, risuExampleSides, risuRequestExtras, risuRequestView } from '../src/risuRequest.js';
import { DEFAULT_LORE_SETTINGS, type NormalizedCard } from '../src/types.js';

const card: NormalizedCard = {
  spec: 'v3',
  name: '아리아',
  description: '마녀.',
  personality: '',
  scenario: '',
  firstMes: '',
  alternateGreetings: [],
  mesExample: '<START>\n{{user}}: 예시 질문\n{{char}}: 예시 답변',
  systemPrompt: '',
  postHistoryInstructions: '',
  creatorNotes: '',
  tags: [],
  creator: '',
  characterVersion: '',
  lorebook: [
    {
      keys: [],
      secondaryKeys: [],
      selective: false,
      content: '깊은 곳의 이야기',
      enabled: true,
      constant: true,
      insertionOrder: 0,
      caseSensitive: false,
      useRegex: false,
      position: 'before_char',
      depth: 1,
    },
  ],
  loreSettings: { ...DEFAULT_LORE_SETTINGS },
  extensions: {},
  raw: null,
};
const plot: PromptPlot = { name: '골짜기', description: '여관.', lorebook: [] };
const aria: PromptCharacter = { name: '아리아', card };

describe('the request as RisuAI’s items', () => {
  it('marks our blocks as sendChat marks the turns they stand for, and invents no memo', () => {
    expect(RISU_REQUEST_ITEMS).toEqual({
      main: {},
      format: {},
      narration_note: {},
      lore_before: {},
      plot: {},
      character: {},
      absent_cast: {},
      narrator: {},
      style: {},
      lore_after: {},
      persona: {},
      memory: { memo: 'supaMemory' },
      directions: {},
      examples: { memo: 'NewChatExample', removable: true },
      history: { memo: 'chatId', removable: true, chat: true },
      depth_lore: {},
      author_note: {},
      moved_lore: {},
      recall: {},
      post_history: {},
      injection: {},
      trailing: {},
      request: {},
    });
  });

  it('gives a chat message its id as the memo, the greeting none, and the rest nothing', () => {
    expect(risuRequestExtras({ kind: 'history', id: 'm-1' })).toEqual({
      memo: 'm-1',
      removable: true,
      attr: [],
      thoughts: [],
    });
    expect(risuRequestExtras({ kind: 'history', id: 'm-0', greeting: true })).toEqual({ removable: true });
    expect(risuRequestExtras({ kind: 'examples' })).toEqual({ memo: 'NewChatExample', removable: true });
    expect(risuRequestExtras({ kind: 'memory' })).toEqual({ memo: 'supaMemory' });
    for (const kind of ['directions', 'depth_lore', 'author_note', 'post_history', 'injection', 'trailing'] as const) {
      expect(risuRequestExtras({ kind }), kind).toEqual({});
    }
    expect(risuRequestExtras(undefined)).toEqual({});
  });

  it('says what each assembled message is: the block, the stored message, and the greeting', () => {
    const history: HistoryMessage[] = [
      { role: 'assistant', content: '어서 와.', id: 'greeting' },
      { role: 'user', content: '안녕', id: 'm-1' },
      { role: 'assistant', content: '반가워', id: 'm-2' },
      { role: 'user', content: '또 왔어', id: 'm-3' },
    ];
    const prompt = assemblePrompt({
      plot,
      characters: [aria],
      history,
      userName: '민준',
      authorNote: '긴장',
      directions: '문이 열린다.',
      branch: { length: 4, greeting: { text: '어서 와.', index: -1 } },
    });
    expect(prompt.sources).toHaveLength(prompt.messages.length);
    expect(prompt.sources).toEqual([
      { kind: 'examples', speakers: { user: '민준', char: ['아리아', '아리아'] } },
      { kind: 'author_note' },
      { kind: 'history', id: 'greeting', greeting: true },
      { kind: 'history', id: 'm-1' },
      { kind: 'history', id: 'm-2' },
      { kind: 'depth_lore' },
      { kind: 'history', id: 'm-3' },
      { kind: 'directions' },
      { kind: 'post_history' },
    ]);

    // Where the memory trimmed the front, the first turn kept is no greeting.
    const trimmed = assemblePrompt({
      plot,
      characters: [aria],
      history: history.slice(2),
      userName: '민준',
      branch: { length: 4, greeting: { text: '어서 와.', index: -1 } },
    });
    expect(trimmed.sources!.filter((source) => source.kind === 'history')).toEqual([
      { kind: 'history', id: 'm-2' },
      { kind: 'history', id: 'm-3' },
    ]);
  });

  it('splits an example block as RisuAI’s exampleMessage does, keeping what it would drop', () => {
    const speakers = { user: '민준', char: ['아리아', 'Aria'] };
    expect(
      risuExampleSides('민준: 질문\n아리아: 답: 길게\n  이어서  \n\n<bot>: 둘째\n<USER>: 셋째\n{{char}}: 넷째\nARIA: 다섯째', speakers),
    ).toEqual([
      { role: 'user', content: '질문' },
      // The whole line after the speaker (RisuAI's split(':', 2) would cut it at '답'), its lines joined trimmed.
      { role: 'assistant', content: '답: 길게\n이어서' },
      { role: 'assistant', content: '둘째' },
      { role: 'user', content: '셋째' },
      { role: 'assistant', content: '넷째' },
      { role: 'assistant', content: '다섯째' },
    ]);
    // Text before the first speaker is a system turn rather than dropped; an empty turn is not sent.
    expect(risuExampleSides('장면 설명\n\n아리아:\n민준: 응', speakers)).toEqual([
      { role: 'system', content: '장면 설명' },
      { role: 'user', content: '응' },
    ]);
    expect(risuExampleSides('대사 없는 예시', speakers)).toEqual([{ role: 'system', content: '대사 없는 예시' }]);
  });

  const exampled: PromptCharacter = {
    name: '아리아',
    card: { ...card, lorebook: [], mesExample: '<START>\n{{user}}: 예시 질문\n{{char}}: 예시 답변\n<START>\n아리아: 혼잣말: 길다\n이어지는 줄' },
  };
  const picture = 'data:image/png;base64,AAAA';
  const chat: HistoryMessage[] = [
    { role: 'assistant', content: '어서 와.', id: 'greeting' },
    { role: 'user', content: '안녕', id: 'm-1' },
    { role: 'assistant', content: '반가워', id: 'm-2' },
    { role: 'user', content: '또 왔어', id: 'm-3', images: [picture] },
  ];
  const opening = { length: 4, greeting: { text: '어서 와.', index: -1 } };

  it('hands the editors the request in RisuAI’s shape: examples split and named, the separators, the newest turn not removable', () => {
    const prompt = assemblePrompt({ plot, characters: [exampled], history: chat, userName: '민준', directions: '문이 열린다.', branch: opening });
    const { items, origins } = risuRequestView(prompt);
    const separator = { role: 'system', content: RISU_NEW_CHAT, memo: 'NewChatExample', removable: true };
    expect(items).toEqual([
      { role: 'system', content: prompt.system },
      separator,
      { role: 'user', content: '예시 질문', name: 'example_user', removable: true },
      { role: 'assistant', content: '예시 답변', name: 'example_assistant', removable: true },
      separator,
      { role: 'assistant', content: '혼잣말: 길다\n이어지는 줄', name: 'example_assistant', removable: true },
      { role: 'system', content: '[Start a new chat]', memo: 'NewChat', removable: true },
      { role: 'assistant', content: '어서 와.', removable: true },
      { role: 'user', content: '안녕', memo: 'm-1', removable: true, attr: [], thoughts: [] },
      { role: 'assistant', content: '반가워', memo: 'm-2', removable: true, attr: [], thoughts: [] },
      // RisuAI's `lastChat`: the newest turn, sent without `removable`, its picture as its data URL.
      { role: 'user', content: '또 왔어', memo: 'm-3', attr: [], thoughts: [], multimodals: [{ type: 'image', base64: picture }] },
      // Our directions, after the newest turn, then the post-history: each its own item.
      { role: 'system', content: '[Game ruling]\n문이 열린다.' },
      { role: 'system', content: promptText(prompt.messages.at(-1)!.content) },
    ]);
    expect(origins).toEqual([
      { kind: 'system' },
      ...Array.from({ length: 3 }, () => ({ kind: 'example', at: 0 })),
      ...Array.from({ length: 2 }, () => ({ kind: 'example', at: 1 })),
      { kind: 'newChat' },
      ...[2, 3, 4, 5, 6, 7].map((at) => ({ kind: 'message', at })),
    ]);
  });

  it('sends the memory as its own supaMemory turn, and no NewChat once the chat’s front is gone', () => {
    const memoryText = '[Summary of the story so far]\n둘은 여관에서 만났다.';
    // The memory evicted the front: the history the assembler gets starts past the greeting.
    const remembered = assemblePrompt({ plot, characters: [aria], history: chat.slice(2), userName: '민준', memoryText, branch: opening });
    expect(remembered.system).toContain('둘은 여관에서 만났다.');
    expect(remembered.risu).toEqual({
      memory: { text: memoryText, system: remembered.system.replace(`\n\n${memoryText}`, '') },
      fromStart: false,
    });
    const { items } = risuRequestView(remembered);
    expect(items[0]).toEqual({ role: 'system', content: remembered.risu!.memory!.system });
    expect(items[1]).toEqual({ role: 'system', content: memoryText, memo: 'supaMemory' });
    expect(items.some((item) => item.memo === 'NewChat')).toBe(false);
    expect(items.filter((item) => item.memo?.startsWith('m-'))).toEqual([
      { role: 'assistant', content: '반가워', memo: 'm-2', removable: true, attr: [], thoughts: [] },
      { role: 'user', content: '또 왔어', memo: 'm-3', attr: [], thoughts: [], multimodals: [{ type: 'image', base64: picture }] },
    ]);

    // Nor where the budget dropped the oldest turns.
    const long: HistoryMessage[] = [chat[0]!, { role: 'user', content: '긴 이야기 '.repeat(4000), id: 'm-1' }, ...chat.slice(2)];
    const squeezed = assemblePrompt({ plot, characters: [aria], history: long, userName: '민준', branch: opening, contextBudget: 4000 });
    expect(squeezed.report).toBeUndefined();
    expect(squeezed.sources!.some((source) => source.greeting)).toBe(false);
    expect(squeezed.risu).toEqual({ fromStart: false });
    expect(assemblePrompt({ plot, characters: [aria], history: chat, userName: '민준', branch: opening }).risu).toEqual({ fromStart: true });
  });

  it('keeps the supaMemory turn to the summaries, and hands the recall turn over after the newest turn as a plain system turn', () => {
    const memoryText = '[Summary of the story so far]\n둘은 여관에서 만났다.';
    const factsText = '[Memory]\n- 민준은 등대 열쇠를 갖고 있다.';
    const prompt = assemblePrompt({ plot, characters: [aria], history: chat.slice(2), userName: '민준', memoryText, factsText, branch: opening });
    expect(prompt.risu!.memory!.text).toBe(memoryText);
    const { items } = risuRequestView(prompt);
    const at = items.findIndex((item) => item.content === factsText);
    // Nothing of RisuAI's: no memo, never removable — after the newest turn, which
    // is still `lastChat` behind the card's depth lore, and before the post-history.
    expect(items[at]).toEqual({ role: 'system', content: factsText });
    expect(items[at - 2]).toEqual({ role: 'system', content: '깊은 곳의 이야기' });
    expect(items[at - 1]).toEqual({
      role: 'user',
      content: '또 왔어',
      memo: 'm-3',
      attr: [],
      thoughts: [],
      multimodals: [{ type: 'image', base64: picture }],
    });
    expect(items[at + 1]).toEqual({ role: 'system', content: promptText(prompt.messages.at(-1)!.content) });
    expect(at + 2).toBe(items.length);
  });
});

describe('the request of a RisuAI utility bot', () => {
  it('keeps the newest turn removable, as RisuAI’s prompt template keeps it among the chat', () => {
    const utility: PromptCharacter = { name: '아리아', card: { ...card, mesExample: '', extensions: { risuai: { utilityBot: true } } } };
    const history: HistoryMessage[] = [
      { role: 'user', content: '안녕', id: 'm-1' },
      { role: 'user', content: '또 왔어', id: 'm-2' },
    ];
    const { items } = risuRequestView(assemblePrompt({ plot, characters: [utility], history, userName: '민준' }));
    expect(items.filter((item) => item.memo?.startsWith('m-'))).toEqual([
      { role: 'user', content: '안녕', memo: 'm-1', removable: true, attr: [], thoughts: [] },
      { role: 'user', content: '또 왔어', memo: 'm-2', removable: true, attr: [], thoughts: [] },
    ]);
  });

  it('sends no system turn with nothing in it, as RisuAI’s pushPrompts skips one', () => {
    const empty = risuRequestView({ system: '', messages: [{ role: 'user', content: '안녕' }] });
    expect(empty.items).toEqual([{ role: 'user', content: '안녕' }]);
    expect(empty.origins).toEqual([{ kind: 'message', at: 0 }]);
  });
});
