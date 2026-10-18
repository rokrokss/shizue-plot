import { describe, expect, it } from 'vitest';
import { RISU_DEFAULT_FORMATING_ORDER, SPEECH_PROTOCOL_REMINDER, type PromptPreset } from '../src/presets.js';
import { assemblePrompt, type HistoryMessage, type PromptCharacter, type PromptPlot } from '../src/prompt.js';
import { risuExampleSides } from '../src/prompt.js';
import { RISU_NEW_CHAT, RISU_REQUEST_ITEMS, risuRequestExtras, risuRequestView } from '../src/risuRequest.js';
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
/** RisuAI's preset without a template, in its default order — its request as `sendChat` sends one by default. */
const preset: PromptPreset = {
  mainPrompt: 'MAIN',
  jailbreak: '',
  globalNote: 'POST',
  formatingOrder: RISU_DEFAULT_FORMATING_ORDER,
  promptTemplate: null,
  groupTemplate: '',
  groupOtherBotRole: 'user',
};

describe('the request as RisuAI’s items', () => {
  it('marks our blocks as sendChat marks the turns they stand for, and invents no memo', () => {
    expect(RISU_REQUEST_ITEMS).toEqual({
      main: {},
      preset: {},
      speech_protocol: {},
      narration_note: {},
      lore_before: {},
      description: {},
      narrator: {},
      style: {},
      lore_after: {},
      lorebook: {},
      persona: {},
      memory: { memo: 'supaMemory' },
      directions: {},
      examples: { memo: 'NewChatExample', removable: true },
      new_chat: { memo: 'NewChat', removable: true },
      history: { memo: 'chatId', removable: true, chat: true },
      depth_lore: {},
      author_note: {},
      moved_lore: {},
      recall: {},
      global_note: {},
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
    // An example block's separator, its named turns, and a line before any speaker.
    expect(risuRequestExtras({ kind: 'examples', separator: true })).toEqual({ memo: 'NewChatExample', removable: true });
    expect(risuRequestExtras({ kind: 'examples', name: 'example_user' })).toEqual({ name: 'example_user', removable: true });
    expect(risuRequestExtras({ kind: 'examples' })).toEqual({ removable: true });
    expect(risuRequestExtras({ kind: 'new_chat' })).toEqual({ memo: 'NewChat', removable: true });
    expect(risuRequestExtras({ kind: 'memory' })).toEqual({ memo: 'supaMemory' });
    for (const kind of ['directions', 'depth_lore', 'author_note', 'global_note', 'lorebook', 'injection', 'trailing'] as const) {
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
      preset,
    });
    expect(prompt.sources).toHaveLength(prompt.messages.length);
    // RisuAI's default order: the chat, its newest turn, then the global note and the
    // author's note — and what follows everything, ours among it.
    expect(prompt.sources).toEqual([
      { kind: 'examples', separator: true },
      { kind: 'examples', name: 'example_user' },
      { kind: 'examples', name: 'example_assistant' },
      { kind: 'new_chat' },
      { kind: 'history', id: 'greeting', greeting: true },
      { kind: 'history', id: 'm-1' },
      { kind: 'history', id: 'm-2' },
      { kind: 'depth_lore' },
      { kind: 'history', id: 'm-3' },
      { kind: 'global_note' },
      { kind: 'author_note' },
      { kind: 'speech_protocol' },
      { kind: 'directions' },
    ]);

    // Where the memory trimmed the front, the first turn kept is no greeting, and there is no separator.
    const trimmed = assemblePrompt({
      plot,
      characters: [aria],
      history: history.slice(2),
      userName: '민준',
      branch: { length: 4, greeting: { text: '어서 와.', index: -1 } },
      preset,
    });
    expect(trimmed.sources!.filter((source) => source.kind === 'history')).toEqual([
      { kind: 'history', id: 'm-2' },
      { kind: 'history', id: 'm-3' },
    ]);
    expect(trimmed.sources!.some((source) => source.kind === 'new_chat')).toBe(false);
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
    const prompt = assemblePrompt({
      plot,
      characters: [exampled],
      history: chat,
      userName: '민준',
      directions: '문이 열린다.',
      branch: opening,
      preset,
    });
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
      // The global note, then what follows everything: each its own item.
      { role: 'system', content: 'POST' },
      { role: 'system', content: SPEECH_PROTOCOL_REMINDER },
      { role: 'system', content: '[Game ruling]\n문이 열린다.' },
    ]);
    // The assembler sends each of RisuAI's example turns as a message of its own.
    expect(origins).toEqual([{ kind: 'system', at: 0 }, ...Array.from({ length: 13 }, (_, at) => ({ kind: 'message', at }))]);
    expect(prompt.messages.slice(0, 5).map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'system', 'assistant']);
  });

  it('sends the memory as its own supaMemory turn — at the head of the chat without a memory item, among the system turns with one', () => {
    const memoryText = '[Summary of the story so far]\n둘은 여관에서 만났다.';
    // The memory evicted the front: the history the assembler gets starts past the greeting.
    const remembered = assemblePrompt({ plot, characters: [aria], history: chat.slice(2), userName: '민준', memoryText, branch: opening, preset });
    expect(remembered.system).not.toContain('둘은 여관에서 만났다.');
    expect(remembered.risu).toEqual({ system: [{ text: remembered.system }] });
    const { items } = risuRequestView(remembered);
    expect(items[1]).toEqual({ role: 'system', content: memoryText, memo: 'supaMemory' });
    expect(items.some((item) => item.memo === 'NewChat')).toBe(false);
    expect(items.filter((item) => item.memo?.startsWith('m-'))).toEqual([
      { role: 'assistant', content: '반가워', memo: 'm-2', removable: true, attr: [], thoughts: [] },
      { role: 'user', content: '또 왔어', memo: 'm-3', attr: [], thoughts: [], multimodals: [{ type: 'image', base64: picture }] },
    ]);

    // OAI2's memory item stands among its system items: the system string is three of RisuAI's turns.
    const templated = assemblePrompt({ plot, characters: [aria], history: chat.slice(2), userName: '민준', memoryText, branch: opening });
    expect(templated.risu!.template).toBe(true);
    expect(templated.risu!.system.map((turn) => turn.memo ?? '')).toEqual(['', 'supaMemory', '']);
    expect(templated.risu!.system[1]!.text).toBe(`[Roleplay Summary]\n${memoryText}\n`);
    expect(templated.risu!.system.map((turn) => turn.text).join('\n\n')).toBe(templated.system);
    const view = risuRequestView(templated);
    expect(view.items.slice(0, 3).map((item) => item.memo)).toEqual([undefined, 'supaMemory', undefined]);
    expect(view.origins.slice(0, 3)).toEqual([0, 1, 2].map((at) => ({ kind: 'system', at })));

    // Nor a separator where the budget dropped the oldest turns.
    const long: HistoryMessage[] = [chat[0]!, { role: 'user', content: '긴 이야기 '.repeat(4000), id: 'm-1' }, ...chat.slice(2)];
    const squeezed = assemblePrompt({ plot, characters: [aria], history: long, userName: '민준', branch: opening, contextBudget: 6000, preset });
    expect(squeezed.report).toBeUndefined();
    expect(squeezed.sources!.some((source) => source.greeting)).toBe(false);
    expect(squeezed.sources!.some((source) => source.kind === 'new_chat')).toBe(false);
    expect(assemblePrompt({ plot, characters: [aria], history: chat, userName: '민준', branch: opening, preset }).sources).toContainEqual({
      kind: 'new_chat',
    });
  });

  it('keeps the supaMemory turn to the summaries, and hands the recall turn over after the newest turn as a plain system turn', () => {
    const memoryText = '[Summary of the story so far]\n둘은 여관에서 만났다.';
    const factsText = '[Memory]\n- 민준은 등대 열쇠를 갖고 있다.';
    const prompt = assemblePrompt({ plot, characters: [aria], history: chat.slice(2), userName: '민준', memoryText, factsText, branch: opening, preset });
    const { items } = risuRequestView(prompt);
    const newest = items.findIndex((item) => item.memo === 'm-3');
    // The card's depth lore is spliced in ahead of the newest turn, which is still `lastChat`.
    expect(items[newest - 1]).toEqual({ role: 'system', content: '깊은 곳의 이야기' });
    // Nothing of RisuAI's on the recall turn: no memo, never removable — with what follows everything.
    expect(items.slice(newest + 1)).toEqual([
      { role: 'system', content: 'POST' },
      { role: 'system', content: SPEECH_PROTOCOL_REMINDER },
      { role: 'system', content: factsText },
    ]);
    expect(items.find((item) => item.memo === 'supaMemory')?.content).toBe(memoryText);
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
