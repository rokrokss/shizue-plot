import { describe, expect, it } from 'vitest';
import { assemblePrompt, type HistoryMessage, type PromptCharacter, type PromptPlot } from '../src/prompt.js';
import { RISU_REQUEST_ITEMS, risuRequestExtras } from '../src/risuRequest.js';
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
      memory: {},
      relationship: {},
      directions: {},
      examples: { memo: 'NewChatExample', removable: true },
      history: { memo: 'chatId', removable: true, chat: true },
      depth_lore: {},
      author_note: {},
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
      { kind: 'directions' },
      { kind: 'examples' },
      { kind: 'author_note' },
      { kind: 'history', id: 'greeting', greeting: true },
      { kind: 'history', id: 'm-1' },
      { kind: 'history', id: 'm-2' },
      { kind: 'depth_lore' },
      { kind: 'history', id: 'm-3' },
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
});
