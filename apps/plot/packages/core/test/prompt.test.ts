import { describe, expect, it } from 'vitest';
import { withNarrationPrefix } from '../src/narration.js';
import {
  DEFAULT_MAIN_PRESET,
  DEFAULT_POST_HISTORY_PRESET,
  DEFAULT_PRESET,
  getPreset,
  isPresetId,
  PRESET_IDS,
  PRESETS,
  REPLY_FORMAT_HINT,
  SPEECH_PROTOCOL,
  SPEECH_PROTOCOL_REMINDER,
} from '../src/presets.js';
import { loreEntryKey } from '../src/lorebook.js';
import {
  absentCastLine,
  assemblePrompt,
  AUTHOR_NOTE_DEPTH,
  characterHeader,
  constantLoreTokens,
  DEFAULT_USER_NAME,
  exampleHeader,
  IMAGE_TOKEN_ESTIMATE,
  LORE_BUDGET_SHARE,
  NARRATION_HEADER,
  NARRATION_NOTE,
  NARRATOR_POV_LABELS,
  promptText,
  plotHeader,
  STYLE_DIRECTIVES_HEADER,
  styleDirectives,
  withBranchGreeting,
  type HistoryMessage,
  type PromptCharacter,
  type PromptPart,
  type PromptPlot,
} from '../src/prompt.js';
import { countTokens } from '../src/tokens.js';
import {
  CHOICES_MODES,
  DEFAULT_LORE_SETTINGS,
  NARRATIVE_DELIVERIES,
  NARRATOR_POVS,
  REPLY_LENGTHS,
  PLOT_DIFFICULTIES,
  PLOT_MOODS,
  PLOT_PACINGS,
  PLOT_TENSES,
  STORYTELLING_STYLES,
  type LoreEntry,
  type NormalizedCard,
  type PlotStyle,
} from '../src/types.js';

const preset = { main: 'MAIN', postHistory: 'POST' };

const card: NormalizedCard = {
  spec: 'v3',
  name: '아리아',
  description: '서리 골짜기의 마녀.',
  personality: '무뚝뚝하다.',
  // Kept on the fixture on purpose: the assembler no longer reads it, because a
  // situation belongs to the plot or to an intro rather than to one member.
  scenario: '눈보라 치는 밤.',
  firstMes: '',
  alternateGreetings: [],
  mesExample: '<START>\n{{user}}: 예시 질문 하나\n{{char}}: 예시 답변 하나\n<START>\n{{user}}: 예시 질문 둘\n{{char}}: 예시 답변 둘',
  systemPrompt: '',
  postHistoryInstructions: '',
  creatorNotes: '',
  tags: [],
  creator: '',
  characterVersion: '',
  lorebook: [],
  loreSettings: { ...DEFAULT_LORE_SETTINGS },
  extensions: {},
  raw: null,
};

const plot: PromptPlot = {
  name: '서리 골짜기의 밤',
  description: '눈보라가 그치지 않는 골짜기의 외딴 여관.',
  lorebook: [],
};

const aria: PromptCharacter = { name: '아리아', card };

// 이/가, 은/는, 을/를, 로/으로 pick their form from the preceding syllable, so a
// particle glued to {{char}}/{{user}} misreads for half of all names. Only
// invariant particles or a separator may follow a macro. Every text we write for
// the model — the presets and the style directives — is held to it.
const allowedAfterMacro = /^(?:$|[\s.,!?):\]'"]|의|에게|에서|에|도|만|까지|부터|처럼|보다|한테)/;

const expectNoParticleAfterMacro = (label: string, text: string): void => {
  for (const match of text.matchAll(/\{\{(?:char|user)\}\}/g)) {
    const tail = text.slice(match.index + match[0].length);
    expect(
      allowedAfterMacro.test(tail),
      `${label}: "${match[0]}${tail.slice(0, 12)}" attaches a particle to a macro`,
    ).toBe(true);
  }
};

const PLOT_BLOCK = `${plotHeader(plot.name)}\n${plot.description}`;
const ARIA_BLOCK = `${characterHeader('아리아')}\n서리 골짜기의 마녀.\n\n아리아의 성격: 무뚝뚝하다.`;

const history: HistoryMessage[] = [
  { role: 'assistant', content: '첫 번째 인사말입니다.' },
  { role: 'user', content: '두 번째 유저 발화입니다.' },
  { role: 'assistant', content: '세 번째 캐릭터 발화입니다.' },
  { role: 'user', content: '네 번째 유저 발화입니다.' },
];

const assemble = (contextBudget: number) =>
  assemblePrompt({
    plot,
    characters: [aria],
    history,
    preset,
    userName: '민준',
    contextBudget,
    maxResponseTokens: 0,
  });

describe('assemblePrompt', () => {
  it('builds the system prefix as plot then roster, with macros expanded', () => {
    const { system } = assemble(100_000);
    expect(system).toBe([('MAIN'), NARRATION_NOTE, PLOT_BLOCK, ARIA_BLOCK].join('\n\n'));
    // The card's scenario is not read any more.
    expect(system).not.toContain('눈보라 치는 밤');
  });

  it('falls back to the built-in preset, which pins responses to the user language', () => {
    const expand = (text: string): string =>
      text.replaceAll('{{char}}', plot.name).replaceAll('{{user}}', DEFAULT_USER_NAME);
    const { system, messages } = assemblePrompt({ plot, characters: [aria], history });
    expect(system.startsWith(expand(DEFAULT_MAIN_PRESET))).toBe(true);
    expect(messages.at(-1)!.content).toBe(expand(DEFAULT_POST_HISTORY_PRESET));
    expect(DEFAULT_MAIN_PRESET).toContain('상대방이 사용한 언어와 같은 언어로 응답');
    expect(DEFAULT_POST_HISTORY_PRESET).toContain('상대방이 쓴 언어로 답합니다');
  });

  it('never attaches a Korean allomorphic particle to a macro substitution', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      for (const [slot, text] of Object.entries(preset)) {
        expectNoParticleAfterMacro(`${id}.${slot}`, text);
      }
    }
  });

  it('writes one block per roster member, in the order it was given', () => {
    const minsu: PromptCharacter = {
      name: '민수',
      card: { ...card, name: '민수 카드', description: '여관 주인.', personality: '', mesExample: '' },
    };
    const { system } = assemblePrompt({
      plot,
      characters: [aria, minsu],
      history,
      preset,
      userName: '민준',
    });
    expect(system).toBe(
      ['MAIN', NARRATION_NOTE, PLOT_BLOCK, ARIA_BLOCK, `${characterHeader('민수')}\n여관 주인.`].join(
        '\n\n',
      ),
    );
    expect(system.indexOf(characterHeader('아리아'))).toBeLessThan(
      system.indexOf(characterHeader('민수')),
    );
  });

  it('says only what the plot says when it has no members yet', () => {
    const { system, messages } = assemblePrompt({
      plot,
      characters: [],
      history,
      preset,
      userName: '민준',
    });
    expect(system).toBe(['MAIN', NARRATION_NOTE, PLOT_BLOCK].join('\n\n'));
    expect(messages.map((message) => message.content)).toEqual([
      ...history.map((message) => message.content),
      'POST',
    ]);
  });

  it('resolves {{char}} to the member for card text and to the plot everywhere else', () => {
    const { system, messages } = assemblePrompt({
      plot: { ...plot, description: '{{char}}의 겨울.' },
      characters: [{ name: '아리아', card: { ...card, description: '{{char}}는 마녀다.', mesExample: '' } }],
      history,
      preset: { main: '{{char}} 담당 작가.', postHistory: '{{char}} 유지.' },
      userName: '민준',
      memoryText: '{{char}}의 지난 이야기.',
    });
    expect(system).toContain('서리 골짜기의 밤 담당 작가.');
    expect(system).toContain(`${plotHeader(plot.name)}\n서리 골짜기의 밤의 겨울.`);
    expect(system).toContain(`${characterHeader('아리아')}\n아리아는 마녀다.`);
    expect(system).toContain('서리 골짜기의 밤의 지난 이야기.');
    expect(messages.at(-1)!.content).toBe('서리 골짜기의 밤 유지.');
  });

  it('reads a member its scripts renamed, and the greeting they rewrote, as this chat has them', () => {
    // A plot of one member renamed by its scripts: the caller gives the member its new
    // name and the plot its `{{char}}`; the work's own header keeps the plot's name.
    const renamed: PromptCharacter = { name: '세라', card: { ...card, description: '{{char}}는 마녀다.', mesExample: '' } };
    const opening = { text: '{{char}}가 문을 연다.', index: -1 };
    const { system, messages } = assemblePrompt({
      plot: { ...plot, char: '세라', description: '{{char}}의 겨울.' },
      characters: [renamed],
      history,
      branch: { length: history.length, greeting: opening },
      preset: { main: '{{char}} 담당 작가.', postHistory: 'POST' },
      userName: '민준',
    });
    expect(system).toContain('세라 담당 작가.');
    expect(system).toContain(`${plotHeader(plot.name)}\n세라의 겨울.`);
    expect(system).toContain(`${characterHeader('세라')}\n세라는 마녀다.`);
    expect(system).not.toContain('아리아');
    // The greeting turn is sent as the branch reads it, with its macros.
    expect(messages.map((message) => promptText(message.content))).toContain('세라가 문을 연다.');
    expect(messages.map((message) => promptText(message.content))).not.toContain('첫 번째 인사말입니다.');
  });

  it('reads the greeting turn as the branch says only while the history still starts with it', () => {
    const opening = { text: '바뀐 인사.', index: -1 };
    const withPrompt: HistoryMessage[] = [{ ...history[0]!, promptContent: '스크립트가 고친 인사.' }, ...history.slice(1)];
    expect(withBranchGreeting(withPrompt, { length: 4, greeting: opening })).toEqual([
      { role: 'assistant', content: '바뀐 인사.' },
      ...history.slice(1),
    ]);
    // Trimmed by the memory: the first turn here is not the greeting.
    expect(withBranchGreeting(history, { length: 6, greeting: opening })).toBe(history);
    // Nothing to read it as, or nothing different.
    expect(withBranchGreeting(history, { length: 4 })).toBe(history);
    expect(withBranchGreeting(history, { length: 4, greeting: { text: history[0]!.content, index: -1 } })).toBe(history);
    expect(withBranchGreeting(history.slice(1), { length: 3, greeting: opening })).toEqual(history.slice(1));
  });

  it('includes persona and lorebook sections around the plot and roster blocks', () => {
    const { system } = assemblePrompt({
      plot: {
        ...plot,
        lorebook: [
          {
            keys: [],
            secondaryKeys: [],
            selective: false,
            content: 'BEFORE',
            enabled: true,
            constant: true,
            insertionOrder: 0,
            caseSensitive: false,
            useRegex: false,
            position: 'before_char',
          },
          {
            keys: [],
            secondaryKeys: [],
            selective: false,
            content: 'AFTER',
            enabled: true,
            constant: true,
            insertionOrder: 1,
            caseSensitive: false,
            useRegex: false,
            position: 'after_char',
          },
        ],
      },
      characters: [aria],
      history,
      preset,
      userName: '민준',
      personaText: '대학생.',
    });
    const sections = system.split('\n\n');
    expect(sections[0]).toBe('MAIN');
    expect(sections[1]).toBe(NARRATION_NOTE);
    expect(sections[2]).toBe('BEFORE');
    expect(sections[3]).toBe(PLOT_BLOCK);
    expect(sections).toContain('AFTER');
    expect(sections.at(-1)).toBe('유저(민준) 정보: 대학생.');
    expect(system.indexOf('AFTER')).toBeGreaterThan(system.indexOf('아리아의 성격'));
  });

  it('keeps every {{img::…}} reference, as RisuAI sends them', () => {
    const withImages: HistoryMessage[] = [
      { role: 'assistant', content: '{{img::smile}}웃으며 인사한다.' },
      { role: 'user', content: '반가워 {{img::wave}}{{inlay::photo-1}}' },
    ];
    const { system, messages } = assemblePrompt({
      plot: {
        ...plot,
        description: '외딴 여관. {{img::inn}}',
        lorebook: [loreEntry({ content: '여관의 규칙 {{img::rules}}' })],
      },
      characters: [
        {
          name: '아리아',
          card: {
            ...card,
            description: '서리 골짜기의 마녀. {{img::portrait}}',
            systemPrompt: '{{original}} {{img::hidden}}',
            postHistoryInstructions: '리마인더 {{img::footer}}',
            mesExample: '<START>\n{{user}}: 예시 {{img::example}}',
          },
        },
      ],
      history: withImages,
      preset,
      userName: '민준',
      personaText: '대학생 {{img::persona}}',
      authorNote: '노트 {{img::note}}',
    });

    const everything = [system, ...messages.map((message) => message.content)].join('\n');
    for (const ref of ['inn', 'rules', 'portrait', 'hidden', 'footer', 'example', 'persona', 'note', 'wave']) {
      expect(everything).toContain(`{{img::${ref}}}`);
    }
    // The model's own earlier picture is in the history as it wrote it.
    expect(messages.map((message) => message.content)).toContain('{{img::smile}}웃으며 인사한다.');
    // An inlay names a picture in the sender's own RisuAI storage; RisuAI drops it from turns.
    expect(messages.map((message) => message.content)).toContain('반가워 {{img::wave}}');
  });

  it('names the open images for {{assetlist}} and {{emotionlist}}', () => {
    const { system } = assemblePrompt({
      plot: { ...plot, description: '그림: {{assetlist}} / 표정: {{emotionlist}}' },
      characters: [aria],
      history,
      preset,
      assetNames: ['웃음.png', 'door'],
    });
    expect(system).toContain('그림: ["웃음.png","door"] / 표정: ["웃음.png","door"]');
  });

  it('injects memoryText after the persona, with macros expanded', () => {
    const memoryText = '[지난 이야기 요약]\n{{user}}와(과) {{char}}는 이미 만난 적이 있다.';
    const { system } = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      personaText: '대학생.',
      memoryText,
    });
    const sections = system.split('\n\n');
    expect(sections.at(-2)).toBe('유저(민준) 정보: 대학생.');
    expect(sections.at(-1)).toBe('[지난 이야기 요약]\n민준와(과) 서리 골짜기의 밤는 이미 만난 적이 있다.');
  });

  it('leaves the system prefix untouched when there is no memory', () => {
    const withBlank = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      memoryText: '  ',
    });
    expect(withBlank.system).toBe(assemble(100_000).system);
  });

  it('injects relationshipText after the memory, and nothing when it is blank', () => {
    const { system } = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      personaText: '대학생.',
      memoryText: '[지난 이야기 요약]\n요약.',
      relationshipText: '[현재 관계 상태]\n애정 70 / 두려움 5',
    });
    const sections = system.split('\n\n');
    expect(sections.at(-2)).toBe('[지난 이야기 요약]\n요약.');
    expect(sections.at(-1)).toBe('[현재 관계 상태]\n애정 70 / 두려움 5');

    const blank = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      relationshipText: '  ',
    });
    expect(blank.system).toBe(assemble(100_000).system);
  });

  it('charges memoryText to the same budget as the rest of the system prefix', () => {
    const memoryText = '[지난 이야기 요약]\n'.padEnd(400, '요약 ');
    const base = assemble(100_000);
    const budget =
      countTokens(base.system) +
      countTokens('POST') +
      countTokens(history[2]!.content) +
      countTokens(history[3]!.content);
    // Without memory that budget holds the last two turns (see the eviction test).
    expect(assemble(budget).messages.map((m) => m.content)).toEqual([
      history[2]!.content,
      history[3]!.content,
      'POST',
    ]);

    const tight = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      contextBudget: budget,
      maxResponseTokens: 0,
      memoryText,
    });
    // The memory block eats into the same budget, so one more turn is evicted.
    expect(tight.messages.map((m) => m.content)).toEqual([history[3]!.content, 'POST']);
    expect(tight.system).toContain('[지난 이야기 요약]');
  });

  it('injects the preset into the first member card system prompt via {{original}}', () => {
    const { system, messages } = assemblePrompt({
      plot,
      characters: [
        {
          name: '아리아',
          card: {
            ...card,
            systemPrompt: '{{original}}\n\n추가 규칙.',
            postHistoryInstructions: '{{original}} 리마인더.',
          },
        },
        // Only the first member's overrides are read; a second card's are ignored.
        { name: '민수', card: { ...card, systemPrompt: '무시된다.', mesExample: '' } },
      ],
      history,
      preset,
    });
    expect(system.startsWith('MAIN\n\n추가 규칙.')).toBe(true);
    expect(system).not.toContain('무시된다.');
    expect(messages.at(-1)).toEqual({ role: 'system', content: 'POST 리마인더.' });
  });

  it("keeps the preset's speech protocol under a card's own instructions", () => {
    const assembled = (systemPrompt: string, postHistoryInstructions: string) =>
      assemblePrompt({
        plot,
        characters: [{ name: '아리아', card: { ...card, systemPrompt, postHistoryInstructions } }],
        history,
        preset: DEFAULT_PRESET,
      });
    // A RisuAI card's instructions know nothing of the `이름: ` lines a reply is read by.
    const own = assembled('카드의 규칙.', '카드의 리마인더.');
    expect(own.system.startsWith(`카드의 규칙.\n\n${SPEECH_PROTOCOL}`)).toBe(true);
    expect(own.system).not.toContain('작성 규칙:');
    expect(own.messages.at(-1)).toEqual({
      role: 'system',
      content: `카드의 리마인더.\n\n${SPEECH_PROTOCOL_REMINDER}`,
    });
    // One that brings the preset back through {{original}} already has it — once.
    const kept = assembled('{{original}}\n\n추가.', '');
    expect(kept.system.split(SPEECH_PROTOCOL)).toHaveLength(2);
  });

  it('drops example dialogue first, then the oldest history', () => {
    const full = assemble(100_000);
    const systemTokens = countTokens(full.system);
    const postTokens = countTokens('POST');
    const historyTokens = history.map((message) => countTokens(message.content));
    const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

    // Everything fits: two example blocks, then the whole history, then post-history.
    expect(full.messages.map((m) => m.role)).toEqual([
      'system',
      'system',
      'assistant',
      'user',
      'assistant',
      'user',
      'system',
    ]);
    expect(full.messages[0]!.content).toBe(
      `${exampleHeader('아리아')}\n민준: 예시 질문 하나\n아리아: 예시 답변 하나`,
    );

    // Exactly enough for the full history: examples are evicted.
    const historyOnly = assemble(systemTokens + postTokens + sum(historyTokens));
    expect(historyOnly.messages.map((m) => m.content)).toEqual([
      ...history.map((m) => m.content),
      'POST',
    ]);

    // Only the last two history messages fit: the oldest are evicted next.
    const tail = assemble(systemTokens + postTokens + sum(historyTokens.slice(-2)));
    expect(tail.messages.map((m) => m.content)).toEqual([
      history[2]!.content,
      history[3]!.content,
      'POST',
    ]);
  });

  it('names the member each example block belongs to, roster order first', () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [
        { name: '아리아', card: { ...card, mesExample: '<START>\n{{char}}: 아리아의 예시' } },
        { name: '민수', card: { ...card, mesExample: '<START>\n{{char}}: 민수의 예시' } },
      ],
      history,
      preset,
      userName: '민준',
    });
    expect(messages.slice(0, 2).map((m) => m.content)).toEqual([
      `${exampleHeader('아리아')}\n아리아: 아리아의 예시`,
      `${exampleHeader('민수')}\n민수: 민수의 예시`,
    ]);
  });

  it('always keeps the newest message even when the budget is exhausted', () => {
    const tiny = assemble(1);
    expect(tiny.messages.map((m) => m.content)).toEqual([history[3]!.content, 'POST']);
  });
});

const loreEntry = (overrides: Partial<LoreEntry> & { content: string }): LoreEntry => ({
  keys: [],
  secondaryKeys: [],
  selective: false,
  enabled: true,
  constant: true,
  insertionOrder: 0,
  caseSensitive: false,
  useRegex: false,
  position: 'before_char',
  ...overrides,
});

// Without example dialogue the messages array is just history + depth lore.
const bareCard: NormalizedCard = { ...card, mesExample: '' };
const bareAria: PromptCharacter = { name: '아리아', card: bareCard };

const withLore = (lorebook: LoreEntry[], contextBudget = 100_000) =>
  assemblePrompt({
    plot,
    characters: [{ name: '아리아', card: { ...bareCard, lorebook } }],
    history,
    preset,
    userName: '민준',
    contextBudget,
    maxResponseTokens: 0,
  });

describe('assemblePrompt - merged lorebook', () => {
  it('activates the plot book and every member book as one, plot first on a tie', () => {
    const { system } = assemblePrompt({
      plot: {
        ...plot,
        lorebook: [loreEntry({ content: 'PLOT', insertionOrder: 1 })],
      },
      characters: [
        { name: '아리아', card: { ...bareCard, lorebook: [loreEntry({ content: 'ARIA', insertionOrder: 1 })] } },
        {
          name: '민수',
          card: {
            ...bareCard,
            description: '',
            personality: '',
            lorebook: [loreEntry({ content: 'MINSU', insertionOrder: 0 })],
          },
        },
      ],
      history,
      preset,
      userName: '민준',
    });
    // insertionOrder decides across books; the stable sort keeps the plot ahead
    // of a member entry it ties with, and members in roster order behind it.
    expect(system.split('\n\n').slice(2, 5)).toEqual(['MINSU', 'PLOT', 'ARIA']);
  });

  it('resolves {{char}} in each book against whoever the book belongs to', () => {
    const { system } = assemblePrompt({
      plot: { ...plot, lorebook: [loreEntry({ content: '{{char}} 세계.', insertionOrder: 0 })] },
      characters: [
        {
          name: '아리아',
          card: { ...bareCard, lorebook: [loreEntry({ content: '{{char}} 기억.', insertionOrder: 1 })] },
        },
      ],
      history,
      preset,
      userName: '민준',
    });
    expect(system).toContain('서리 골짜기의 밤 세계.\n\n아리아 기억.');
  });

  it('takes the scan depth and the lore budget from the first member', () => {
    const budgeted = (loreSettings: NormalizedCard['loreSettings']) =>
      assemblePrompt({
        plot: {
          ...plot,
          lorebook: [
            loreEntry({ content: '첫 번째 항목.', insertionOrder: 0 }),
            loreEntry({ content: '두 번째 항목.', insertionOrder: 1 }),
          ],
        },
        characters: [{ name: '아리아', card: { ...bareCard, loreSettings } }],
        history,
        preset,
        userName: '민준',
      }).system;
    expect(budgeted({ ...DEFAULT_LORE_SETTINGS })).toContain('첫 번째 항목.');
    // Room for one: the entry ranked higher (insertionOrder 1) takes it.
    const tight = budgeted({ ...DEFAULT_LORE_SETTINGS, tokenBudget: countTokens('두 번째 항목.') });
    expect(tight).toContain('두 번째 항목.');
    expect(tight).not.toContain('첫 번째 항목.');
  });

  it('gives a card that names no budget its share of the context budget', () => {
    const first = '첫 번째 항목.';
    const second = '두 번째 항목.';
    const automatic = (contextBudget: number) =>
      assemblePrompt({
        plot: {
          ...plot,
          lorebook: [
            loreEntry({ content: first, insertionOrder: 0 }),
            loreEntry({ content: second, insertionOrder: 1 }),
          ],
        },
        characters: [{ name: '아리아', card: { ...bareCard, loreSettings: { ...DEFAULT_LORE_SETTINGS } } }],
        history,
        preset,
        userName: '민준',
        contextBudget,
        maxResponseTokens: 0,
      }).system;
    // Room for exactly the higher-ranked entry: the budget is the share, rounded down.
    const tight = Math.ceil(countTokens(second) / LORE_BUDGET_SHARE);
    expect(Math.floor(tight * LORE_BUDGET_SHARE)).toBe(countTokens(second));
    expect(automatic(tight)).toContain(second);
    expect(automatic(tight)).not.toContain(first);
    const roomy = Math.ceil((countTokens(first) + countTokens(second)) / LORE_BUDGET_SHARE);
    expect(automatic(roomy)).toContain(first);
  });

  it('charges lore for its expanded text, and sends nothing for an entry that expands to nothing', () => {
    const conditional = `{{#if {{getvar::flag}}}}${'숨은 설정 '.repeat(50)}{{/if}}`;
    const later = '나중 항목.';
    const { system, messages } = assemblePrompt({
      plot,
      characters: [
        {
          name: '아리아',
          card: {
            ...bareCard,
            lorebook: [
              loreEntry({ content: conditional, insertionOrder: 0 }),
              loreEntry({ content: conditional, depth: 0, insertionOrder: 1 }),
              loreEntry({ content: later, insertionOrder: 2 }),
            ],
            // Room for the later entry alone: the raw block would have taken it all.
            loreSettings: { ...DEFAULT_LORE_SETTINGS, tokenBudget: countTokens(later) },
          },
        },
      ],
      history,
      preset,
      userName: '민준',
      variables: { flag: '0' },
    });
    expect(system).toContain(later);
    expect(system).not.toContain('숨은 설정');
    // Neither an empty system section nor an empty depth message is left behind.
    expect(system).not.toContain('\n\n\n\n');
    expect(messages.map((message) => message.content)).toEqual([
      ...history.map((turn) => turn.content),
      'POST',
    ]);
  });
});

describe('constantLoreTokens', () => {
  it('counts the enabled always-on entries as the prompt would expand them', () => {
    const entries = [
      loreEntry({ content: '{{char}}의 비밀.' }),
      loreEntry({ content: '{{#if {{getvar::flag}}}}숨은 설정{{/if}}' }),
      loreEntry({ content: '꺼진 항목.', enabled: false }),
      loreEntry({ content: '키워드 항목.', constant: false, keys: ['열쇠'] }),
    ];
    expect(constantLoreTokens(entries, { char: '아리아', user: '민준', variables: { flag: '0' } })).toBe(
      countTokens('아리아의 비밀.'),
    );
    expect(constantLoreTokens(entries, { char: '아리아', user: '민준', variables: { flag: '1' } })).toBe(
      countTokens('아리아의 비밀.') + countTokens('숨은 설정'),
    );
  });
});

describe('assemblePrompt - depth lore', () => {
  it('splices depth entries into the history instead of the system block', () => {
    const { system, messages } = withLore([
      loreEntry({ content: 'DEPTH0', depth: 0, insertionOrder: 1 }),
      loreEntry({ content: 'DEPTH2', depth: 2, role: 'assistant', insertionOrder: 2 }),
      loreEntry({ content: 'SYSTEM', insertionOrder: 3 }),
    ]);
    expect(system).toContain('SYSTEM');
    expect(system).not.toContain('DEPTH');
    expect(messages).toEqual([
      { role: 'assistant', content: history[0]!.content },
      { role: 'user', content: history[1]!.content },
      { role: 'assistant', content: 'DEPTH2' },
      { role: 'assistant', content: history[2]!.content },
      { role: 'user', content: history[3]!.content },
      { role: 'system', content: 'DEPTH0' },
      { role: 'system', content: 'POST' },
    ]);
  });

  it('clamps a depth beyond the history to its start and expands macros', () => {
    const { messages } = withLore([
      loreEntry({ content: '{{char}} 기억', depth: 99, role: 'user', insertionOrder: 1 }),
    ]);
    expect(messages[0]).toEqual({ role: 'user', content: '아리아 기억' });
    expect(messages.slice(1).map((m) => m.content)).toEqual([
      ...history.map((m) => m.content),
      'POST',
    ]);
  });

  it('keeps insertionOrder among entries sharing a depth and clamped entries', () => {
    const { messages } = withLore([
      loreEntry({ content: 'SECOND', depth: 1, insertionOrder: 2 }),
      loreEntry({ content: 'FIRST', depth: 1, insertionOrder: 1 }),
      loreEntry({ content: 'CLAMP-B', depth: 8, insertionOrder: 5 }),
      loreEntry({ content: 'CLAMP-A', depth: 9, insertionOrder: 4 }),
    ]);
    expect(messages.map((m) => m.content)).toEqual([
      'CLAMP-A',
      'CLAMP-B',
      ...history.slice(0, 3).map((m) => m.content),
      'FIRST',
      'SECOND',
      history[3]!.content,
      'POST',
    ]);
  });

  it('counts trailingTurns so a continue prefill does not shift the depths', () => {
    // The continue path assembles the history without its trailing partial and
    // re-attaches it after post-history, so depth must be measured as if it were
    // still the last message.
    const lorebook = [
      loreEntry({ content: 'DEPTH1', depth: 1, insertionOrder: 1 }),
      loreEntry({ content: 'DEPTH2', depth: 2, insertionOrder: 2 }),
    ];
    const partial = history[3]!.content;
    const { messages } = assemblePrompt({
      plot,
      characters: [{ name: '아리아', card: { ...bareCard, lorebook } }],
      history: history.slice(0, -1),
      preset,
      userName: '민준',
      contextBudget: 100_000,
      maxResponseTokens: 0,
      trailingTurns: 1,
    });
    // With the partial re-attached the result reads h1, h2, DEPTH2, h3, DEPTH1,
    // POST, partial — the same slots the entries take without a continue.
    expect([...messages.map((m) => m.content), partial]).toEqual([
      history[0]!.content,
      history[1]!.content,
      'DEPTH2',
      history[2]!.content,
      'DEPTH1',
      'POST',
      partial,
    ]);
    expect(withLore(lorebook).messages.map((m) => m.content)).toEqual([
      history[0]!.content,
      history[1]!.content,
      'DEPTH2',
      history[2]!.content,
      'DEPTH1',
      history[3]!.content,
      'POST',
    ]);
  });

  it('clamps a depth that would fall behind the trailing turns', () => {
    // Depth 0 wants to sit after the prefill, which the model must have last, so
    // it clamps to the end of the history block like depth 1.
    const { messages } = assemblePrompt({
      plot,
      characters: [
        {
          name: '아리아',
          card: {
            ...bareCard,
            lorebook: [
              loreEntry({ content: 'DEPTH0', depth: 0, insertionOrder: 1 }),
              loreEntry({ content: 'DEEP', depth: 9, insertionOrder: 2 }),
            ],
          },
        },
      ],
      history: history.slice(0, -1),
      preset,
      userName: '민준',
      contextBudget: 100_000,
      maxResponseTokens: 0,
      trailingTurns: 1,
    });
    expect(messages.map((m) => m.content)).toEqual([
      'DEEP',
      ...history.slice(0, 3).map((m) => m.content),
      'DEPTH0',
      'POST',
    ]);
  });

  it('charges depth entries to the context budget so history is evicted for them', () => {
    const depthText = '깊이 주입된 로어.';
    const base = assemblePrompt({
      plot,
      characters: [bareAria],
      history,
      preset,
      userName: '민준',
      contextBudget: 100_000,
      maxResponseTokens: 0,
    });
    const budget =
      countTokens(base.system) +
      countTokens('POST') +
      countTokens(history[2]!.content) +
      countTokens(history[3]!.content);
    // The depth entry takes its tokens from the same budget as the history.
    const { messages } = withLore([loreEntry({ content: depthText, depth: 0 })], budget);
    expect(messages.map((m) => m.content)).toEqual([history[3]!.content, depthText, 'POST']);
  });
});

describe('assemblePrompt - author note', () => {
  const authorNote = '{{user}}는 지금 초조하다.';
  const longer: HistoryMessage[] = [
    ...history,
    { role: 'assistant', content: '다섯 번째 캐릭터 발화입니다.' },
    { role: 'user', content: '여섯 번째 유저 발화입니다.' },
  ];

  it(`sits ${AUTHOR_NOTE_DEPTH} messages from the end of the history`, () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [aria],
      history: longer,
      preset,
      userName: '민준',
      authorNote,
    });
    expect(messages.map((m) => m.content)).toEqual([
      `${exampleHeader('아리아')}\n민준: 예시 질문 하나\n아리아: 예시 답변 하나`,
      `${exampleHeader('아리아')}\n민준: 예시 질문 둘\n아리아: 예시 답변 둘`,
      ...longer.slice(0, 2).map((m) => m.content),
      '민준는 지금 초조하다.',
      ...longer.slice(2).map((m) => m.content),
      'POST',
    ]);
    expect(messages.find((m) => m.content === '민준는 지금 초조하다.')?.role).toBe('system');
  });

  it('follows the depth lore that shares its slot, and clamps to the start of a short history', () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [
        {
          name: '아리아',
          card: { ...bareCard, lorebook: [loreEntry({ content: 'DEPTH4', depth: AUTHOR_NOTE_DEPTH })] },
        },
      ],
      history: longer,
      preset,
      userName: '민준',
      authorNote,
    });
    expect(messages.map((m) => m.content).slice(1, 5)).toEqual([
      longer[1]!.content,
      'DEPTH4',
      '민준는 지금 초조하다.',
      longer[2]!.content,
    ]);

    const short = assemblePrompt({
      plot,
      characters: [bareAria],
      history: history.slice(-2),
      preset,
      userName: '민준',
      authorNote,
    });
    expect(short.messages.map((m) => m.content)).toEqual([
      '민준는 지금 초조하다.',
      ...history.slice(-2).map((m) => m.content),
      'POST',
    ]);
  });

  it('counts trailing turns like depth lore does', () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [bareAria],
      history: longer.slice(0, -1),
      preset,
      userName: '민준',
      authorNote,
      trailingTurns: 1,
    });
    // With the partial re-attached last, the note is still four from the end.
    expect(messages.map((m) => m.content)).toEqual([
      ...longer.slice(0, 2).map((m) => m.content),
      '민준는 지금 초조하다.',
      ...longer.slice(2, -1).map((m) => m.content),
      'POST',
    ]);
  });

  it('is ignored when blank', () => {
    const blank = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      authorNote: '  ',
    });
    expect(blank.messages).toEqual(assemble(100_000).messages);
  });

  it('outlives the examples and the history it evicts', () => {
    const note = '민준는 지금 초조하다.';
    const budget =
      countTokens(assemble(100_000).system) +
      countTokens('POST') +
      countTokens(note) +
      countTokens(history[3]!.content);
    const { messages } = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      contextBudget: budget,
      maxResponseTokens: 0,
      authorNote,
    });
    expect(messages.map((m) => m.content)).toEqual([note, history[3]!.content, 'POST']);
  });
});

describe('assemblePrompt - old status windows and choices', () => {
  const status = (place: string) => `\`\`\`status\n위치: ${place}\n\`\`\``;
  const stated: HistoryMessage[] = [
    { role: 'assistant', content: `첫 장면.\n\n${status('왕궁')}\n\n>> 문을 연다\n>> 돌아선다` },
    { role: 'user', content: `>> 이건 유저의 글\n${status('유저가 쓴 블록')}` },
    { role: 'assistant', content: `둘째 장면.\n\n${status('정원')}` },
    { role: 'user', content: '정원을 걷는다.' },
  ];
  const assembleStated = (lorebook: LoreEntry[] = []) =>
    assemblePrompt({
      plot,
      characters: [{ name: '아리아', card: { ...bareCard, lorebook } }],
      history: stated,
      preset,
      userName: '민준',
    });

  it('sends only the newest assistant turn with its state, and user turns untouched', () => {
    expect(assembleStated().messages.map((m) => m.content)).toEqual([
      '첫 장면.',
      stated[1]!.content,
      stated[2]!.content,
      stated[3]!.content,
      'POST',
    ]);
  });

  it('still scans the stripped state for lore', () => {
    const { system, messages } = assembleStated([
      loreEntry({ content: '왕궁의 비밀', constant: false, keys: ['왕궁'] }),
    ]);
    expect(system).toContain('왕궁의 비밀');
    expect(promptText(messages[0]!.content)).toBe('첫 장면.');
  });

  it('keeps a turn whole when its state is all it says', () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [bareAria],
      history: [{ role: 'assistant', content: status('왕궁') }, ...stated.slice(2)],
      preset,
      userName: '민준',
    });
    expect(messages[0]!.content).toBe(status('왕궁'));
  });
});

describe('assemblePrompt - clock, seed and lore records', () => {
  const now = new Date('2026-01-02T23:30:00Z');
  const clock = { now, timeZone: 'Asia/Seoul', locale: 'ko' as const, idleMs: 3 * 86_400_000 };

  it('expands the time macros everywhere the plot macros reach', () => {
    const { system, messages } = assemblePrompt({
      plot: { ...plot, description: '오늘은 {{weekday}}.' },
      characters: [{ name: '아리아', card: { ...bareCard, description: '{{char}}는 {{idle_duration}} 기다렸다.' } }],
      history,
      preset,
      userName: '민준',
      authorNote: '{{pick::하나}}',
      clock,
      seed: 'chat',
    });
    expect(system).toContain('오늘은 토요일.');
    expect(system).toContain('아리아는 3일 기다렸다.');
    expect(messages.map((m) => m.content)).toContain('하나');
  });

  it('returns the keys that freshly triggered and honours the records it is given', () => {
    const sticky = loreEntry({ content: 'STICKY', constant: false, keys: ['없는 말'], sticky: 3 });
    const fresh = loreEntry({ content: 'FRESH', insertionOrder: 1 });
    const result = assemblePrompt({
      plot: { ...plot, lorebook: [sticky, fresh] },
      characters: [bareAria],
      history,
      preset,
      userName: '민준',
      loreState: { chatLength: 6, lastTriggered: { [loreEntryKey(sticky)]: 4 } },
    });
    expect(result.system).toContain('STICKY');
    expect(result.loreTriggers).toEqual([loreEntryKey(fresh)]);
  });
});

describe('assemblePrompt - scene cast', () => {
  const minsu: PromptCharacter = {
    name: '민수',
    card: {
      ...card,
      description: '여관 주인.',
      mesExample: '<START>\n{{char}}: MINSU EXAMPLE',
      lorebook: [loreEntry({ content: 'MINSU LORE' })],
    },
  };

  it("takes an absent member's block, examples and lorebook out, and names them once", () => {
    const { system, messages } = assemblePrompt({
      plot,
      characters: [aria, { ...minsu, absent: true }],
      history,
      preset,
      userName: '민준',
    });
    expect(system).not.toContain(characterHeader('민수'));
    expect(system).not.toContain('MINSU LORE');
    expect(messages.map((m) => promptText(m.content)).join('\n')).not.toContain('MINSU EXAMPLE');
    // Right behind the members who are still on the stage.
    expect(system).toBe([('MAIN'), NARRATION_NOTE, PLOT_BLOCK, ARIA_BLOCK, absentCastLine(['민수'])].join('\n\n'));
  });

  it('keeps an absent first member standing in for the work', () => {
    const { system } = assemblePrompt({
      plot,
      characters: [
        { ...minsu, card: { ...minsu.card, systemPrompt: 'WORK PROMPT' }, absent: true },
        aria,
      ],
      history,
      preset,
      userName: '민준',
    });
    expect(system.startsWith('WORK PROMPT')).toBe(true);
    expect(system).toContain(ARIA_BLOCK);
  });
});

describe('assemblePrompt - report', () => {
  it('is only measured when asked for', () => {
    expect(assemble(100_000).report).toBeUndefined();
  });

  it('lists every block in the order the model reads it, and what the budget gave out', () => {
    const result = assemblePrompt({
      plot: { ...plot, lorebook: [loreEntry({ content: 'DEPTH LORE', depth: 1 })] },
      characters: [aria, { name: '민수', card: bareCard, absent: true }],
      history,
      preset,
      userName: '민준',
      personaText: '검객.',
      authorNote: 'NOTE',
      directions: 'RULING',
      report: true,
    });
    const report = result.report!;
    const systemBlocks = report.blocks.slice(0, report.blocks.length - result.messages.length);
    const messageBlocks = report.blocks.slice(systemBlocks.length);

    expect(systemBlocks.map((block) => block.kind)).toEqual([
      'main',
      'narration_note',
      'plot',
      'character',
      'absent_cast',
      'persona',
    ]);
    expect(systemBlocks.map((block) => block.text).join('\n\n')).toBe(result.system);
    expect(systemBlocks[3]!.label).toBe('아리아');
    // One block per message, in the same order and with the same text.
    expect(messageBlocks.map((block) => block.text)).toEqual(result.messages.map((m) => promptText(m.content)));
    expect(messageBlocks.map((block) => block.kind)).toEqual([
      'directions',
      'examples',
      'examples',
      'author_note',
      'history',
      'history',
      'history',
      'depth_lore',
      'history',
      'post_history',
    ]);
    expect(messageBlocks[1]!.label).toBe('아리아');
    expect(messageBlocks[7]!.label).toBe('depth 1');

    expect(report.history).toEqual({ included: 4, total: 4 });
    expect(report.examples).toEqual({ included: 2, total: 2 });
    expect(report.totals).toEqual({
      contextBudget: 16000,
      responseReserve: 1200,
      used:
        countTokens(result.system) +
        result.messages.reduce((sum, m) => sum + countTokens(promptText(m.content)), 0),
    });
  });

  it('says where each activated entry came from, where it went and why', () => {
    const constant = loreEntry({ content: 'PLOT CONSTANT', insertionOrder: 0 });
    const keyed = loreEntry({
      content: `KEYED 열쇠 ${'가'.repeat(100)}`,
      constant: false,
      keys: ['인사말'],
      depth: 2,
      insertionOrder: 1,
    });
    const recursive = loreEntry({ content: 'RECURSIVE', constant: false, keys: ['열쇠'], insertionOrder: 2 });
    const sticky = loreEntry({ content: 'STICKY', constant: false, keys: ['없는 말'], sticky: 5, insertionOrder: 3 });
    const { report } = assemblePrompt({
      plot: { ...plot, lorebook: [constant, sticky] },
      characters: [
        {
          name: '아리아',
          card: {
            ...bareCard,
            lorebook: [keyed, recursive],
            loreSettings: { ...DEFAULT_LORE_SETTINGS, scanDepth: 10, recursiveScanning: true },
          },
        },
      ],
      history,
      preset,
      userName: '민준',
      loreState: { chatLength: 4, lastTriggered: { [loreEntryKey(sticky)]: 2 } },
      report: true,
    });

    expect(report!.lore).toEqual([
      {
        key: loreEntryKey(constant),
        source: 'plot',
        keys: [],
        preview: 'PLOT CONSTANT',
        placement: 'before_char',
        via: 'constant',
      },
      {
        key: loreEntryKey(keyed),
        source: '아리아',
        keys: ['인사말'],
        preview: keyed.content.slice(0, 80),
        placement: 'depth 2',
        via: 'keyword',
      },
      expect.objectContaining({ key: loreEntryKey(recursive), source: '아리아', via: 'recursion' }),
      expect.objectContaining({ key: loreEntryKey(sticky), source: 'plot', via: 'sticky' }),
    ]);
  });
});

describe('presets', () => {
  /** A marker per preset that its authorial voice cannot be missing. */
  const markers: Record<string, string[]> = {
    standard: ['2~4문단', '오감과 사소한 몸짓'],
    novel: ['3~5문단', '지문 줄이 무게를 집니다'],
    concise: ['1~2문단', '세 문장', '메신저'],
    literary: ['오감 중 최소 두 가지', '비유', '2~4문단'],
    screenplay: ['장소 / 시간', '대사 2~5줄'],
  };

  it('offers the five ids the API validates against', () => {
    expect(PRESET_IDS).toEqual(['standard', 'novel', 'concise', 'literary', 'screenplay']);
    expect(PRESETS.standard).toBe(DEFAULT_PRESET);
    expect(isPresetId('novel')).toBe(true);
    expect(isPresetId('nope')).toBe(false);
    expect(getPreset('screenplay')).toBe(PRESETS.screenplay);
    // An unknown or missing id must never break a generation.
    expect(getPreset('nope')).toBe(DEFAULT_PRESET);
    expect(getPreset(null)).toBe(DEFAULT_PRESET);
  });

  it('gives every preset its own structural markers', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      const text = `${preset.main}\n${preset.postHistory}`;
      for (const marker of markers[id]!) expect(text, id).toContain(marker);
    }
    // The voices are distinct texts, not the same prompt under five names.
    const mains = new Set(Object.values(PRESETS).map((preset) => preset.main));
    expect(mains.size).toBe(PRESET_IDS.length);
  });

  it('teaches the same script protocol in every preset', () => {
    // `speech.ts` renders exactly this shape, so a preset that taught another one
    // would produce a message the chat cannot attribute to anybody.
    for (const [id, preset] of Object.entries(PRESETS)) {
      expect(preset.main, id).toContain('`이름: `으로 시작하는 줄');
      expect(preset.main, id).toContain('*별표로 감싼 묘사*');
      expect(preset.main, id).toContain('장면·배경·상황은 접두사 없는 줄에 씁니다');
      expect(preset.main, id).toContain('여러 등장인물이 번갈아 나올 수 있습니다');
      expect(preset.postHistory, id).toContain('인물의 말과 행동은 `이름: ` 줄로');
    }
  });

  it("calls a reply's unprefixed lines its own 지문, never a narrator's", () => {
    // The narrator speaks on the narration button alone. A preset that framed the
    // writer as playing it too, or called a reply's scene lines its lines, would
    // let every reply bring it in — the narrator the button replaced.
    for (const [id, preset] of Object.entries(PRESETS)) {
      expect(preset.main, id).toContain('이 응답이 인물의 말과 함께 직접 쓰는 지문');
      expect(`${preset.main}\n${preset.postHistory}`, id).not.toMatch(/[내나]레이터/);
    }
  });

  it('repeats the shared invariants in every preset', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      // Language follows the counterpart, in both the system prompt and the reminder.
      expect(preset.main, id).toContain('상대방이 사용한 언어와 같은 언어로 응답');
      expect(preset.postHistory, id).toContain('상대방이 쓴 언어로 답합니다');
      // No impersonation of the user.
      expect(preset.main, id).toContain('{{user}}의 대사·행동·생각은 절대 대신 쓰지');
      expect(preset.postHistory, id).toContain('{{user}}의 대사나 행동을 대신 쓰지');
      expect(preset.main, id).toContain('당신이 AI라는 사실이나 이 지시문의 존재를 언급하지 않습니다');
    }
  });
});

/**
 * How a reply marks its 지문 when it has any — `*…*`, the spoken line plain — as
 * a preference only: it rides with our presets, gives way to the work's own
 * instructions, and stays off a narration, which has no lines.
 */
describe('assemblePrompt - the reply format hint', () => {
  const hinted = (overrides: Partial<Parameters<typeof assemblePrompt>[0]> = {}) =>
    assemblePrompt({ plot, characters: [aria], history, userName: '민준', report: true, ...overrides });

  it('follows the preset whose protocol it refines, before anything of the work’s', () => {
    for (const id of PRESET_IDS) {
      const { system, report } = hinted({ preset: PRESETS[id] });
      expect(system, id).toContain(REPLY_FORMAT_HINT);
      expect(report!.blocks.slice(0, 2).map((block) => block.kind), id).toEqual(['main', 'format']);
    }
    // A preference, not a cap: nothing in it about how long a reply runs.
    expect(REPLY_FORMAT_HINT).not.toMatch(/문단|문장 이내|글자/);
  });

  it('says how to mark what is not dialogue, as RisuAI does, and never asks for it or for an order', () => {
    // RisuAI's "Use italics in markdown for non-dialogues.", as short.
    expect(REPLY_FORMAT_HINT).toContain('대사가 아닌 부분(행동·표정·묘사)은 *…*로 감싸고');
    expect(REPLY_FORMAT_HINT).toContain('대사는 그대로');
    // Dialogue alone, or 지문 alone, is a whole reply.
    expect(REPLY_FORMAT_HINT).toContain('둘 중 하나만 있어도 됩니다');
    // No shape that requires it: not on every reply, not first, not before the line.
    expect(REPLY_FORMAT_HINT).not.toMatch(/먼저|반드시|매 응답|항상|빈 줄|앞에|뒤에/);
  });

  it('is absent when the card writes its own instructions', () => {
    expect(hinted({ characters: [{ ...aria, card: { ...card, systemPrompt: '카드의 지시.' } }] }).system).not.toContain(
      REPLY_FORMAT_HINT,
    );
    expect(
      hinted({ characters: [{ ...aria, card: { ...card, postHistoryInstructions: '카드의 마무리 지시.' } }] }).system,
    ).not.toContain(REPLY_FORMAT_HINT);
  });

  it('is absent on a narration, and on the narrator’s turn in a round', () => {
    expect(hinted({ narration: true }).system).not.toContain(REPLY_FORMAT_HINT);
    const kai: PromptCharacter = { name: '카이', card: { ...card, name: '카이' } };
    expect(hinted({ characters: [aria, kai], speaker: 'narrator' }).system).not.toContain(REPLY_FORMAT_HINT);
    // A member's own turn in the round is a reply like any other.
    expect(hinted({ characters: [aria, kai], speaker: 1 }).system).toContain(REPLY_FORMAT_HINT);
  });

  it('stays out of a prompt built on a preset of someone else’s', () => {
    expect(hinted({ preset }).system).not.toContain(REPLY_FORMAT_HINT);
  });
});

describe('assemblePrompt - stage directions', () => {
  const directions = '주사위 3. {{user}}의 자물쇠 따기는 실패한다.';

  it('injects the ruling ahead of the examples, leaving the cached prefix alone', () => {
    const plain = assemble(100_000);
    const { system, messages } = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      contextBudget: 100_000,
      maxResponseTokens: 0,
      directions,
    });
    // The system string is the Anthropic cache prefix, so it must be byte for
    // byte what a turn without directions would have sent.
    expect(system).toBe(plain.system);
    expect(messages[0]).toEqual({
      role: 'system',
      content: '[게임 판정]\n주사위 3. 민준의 자물쇠 따기는 실패한다.',
    });
    // …and everything else is where it was: examples, then history, then post.
    expect(messages.slice(1)).toEqual(plain.messages);
  });

  it('is absent when the turn carries none', () => {
    const plain = assemblePrompt({ plot, characters: [aria], history, preset, userName: '민준' });
    expect(plain.messages[0]?.content).not.toContain('게임 판정');
    const blank = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      directions: '  ',
    });
    expect(blank.messages).toEqual(plain.messages);
  });

  it('is charged to the budget and outlives the history it evicts', () => {
    const block = '[게임 판정]\n주사위 3. 민준의 자물쇠 따기는 실패한다.';
    const budget =
      countTokens(assemble(100_000).system) +
      countTokens('POST') +
      countTokens(block) +
      countTokens(history[3]!.content);
    const { messages } = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      contextBudget: budget,
      maxResponseTokens: 0,
      directions,
    });
    expect(messages.map((m) => m.content)).toEqual([block, history[3]!.content, 'POST']);
  });
});

describe('assemblePrompt - attached images', () => {
  const shown: HistoryMessage[] = [
    { role: 'user', content: '이 사진 봐' },
    { role: 'assistant', content: '어떤 사진?' },
    { role: 'user', content: '{{user}}의 방', images: ['data:image/png;base64,AAA', 'https://x/2.png'] },
  ];

  it('splits only the turn that carries images, text first', () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [aria],
      history: shown,
      preset,
      userName: '민준',
    });
    // The three history turns, between the examples and the post-history block.
    const turns = messages.slice(-4, -1);
    // The turns without images are the plain strings they have always been.
    expect(turns.slice(0, 2).map((message) => message.content)).toEqual(['이 사진 봐', '어떤 사진?']);
    expect(turns[2]).toEqual({
      role: 'user',
      content: [
        // Macros are expanded in the text part like anywhere else.
        { type: 'text', text: '민준의 방' },
        { type: 'image', url: 'data:image/png;base64,AAA' },
        { type: 'image', url: 'https://x/2.png' },
      ],
    });
    expect(promptText(turns[2]!.content)).toBe('민준의 방');
  });

  it('charges each image to the context budget', () => {
    const budget = (history: HistoryMessage[]): number =>
      countTokens(
        assemblePrompt({ plot, characters: [aria], history, preset, userName: '민준' }).system,
      );
    // Exactly enough for the last turn once its two images are charged, so
    // everything ahead of it is what the budget gives up.
    const room =
      budget(shown) + countTokens('POST') + countTokens('민준의 방') + 2 * IMAGE_TOKEN_ESTIMATE;
    const { messages } = assemblePrompt({
      plot,
      characters: [aria],
      history: shown,
      preset,
      userName: '민준',
      contextBudget: room,
      maxResponseTokens: 0,
    });
    expect(messages.map((message) => promptText(message.content))).toEqual(['민준의 방', 'POST']);
  });
});

describe('assemblePrompt - narration', () => {
  const narrated: HistoryMessage[] = [
    { role: 'assistant', content: '첫 번째 인사말입니다.' },
    { role: 'user', content: '@: 문이 열리고 바람이 들이쳤다.' },
    { role: 'user', content: '누구세요?' },
  ];

  const assembleNarrated = (history: HistoryMessage[]) =>
    assemblePrompt({
      plot,
      characters: [bareAria],
      history,
      preset,
      userName: '민준',
      maxResponseTokens: 0,
    });

  it('carries a narrating turn as a labelled user turn without its prefix', () => {
    const { messages } = assembleNarrated(narrated);
    expect(messages.slice(0, 3)).toEqual([
      { role: 'assistant', content: '첫 번째 인사말입니다.' },
      { role: 'user', content: `${NARRATION_HEADER} 문이 열리고 바람이 들이쳤다.` },
      { role: 'user', content: '누구세요?' },
    ]);
    expect(messages.some((message) => promptText(message.content).includes('@:'))).toBe(false);
  });

  it('expands macros in the narration body against the plot', () => {
    const { messages } = assembleNarrated([{ role: 'user', content: '@:  {{char}}의 첫 밤.' }]);
    expect(messages[0]).toEqual({
      role: 'user',
      content: `${NARRATION_HEADER} 서리 골짜기의 밤의 첫 밤.`,
    });
  });

  it('labels an assistant narration the same way, because the role does not decide', () => {
    const { messages } = assembleNarrated([{ role: 'assistant', content: '@: 눈이 그쳤다.' }]);
    expect(messages[0]).toEqual({ role: 'assistant', content: `${NARRATION_HEADER} 눈이 그쳤다.` });
  });

  it('prefixes a generated narration exactly once, whatever the model wrote', () => {
    expect(withNarrationPrefix('눈이 그쳤다.')).toBe('@: 눈이 그쳤다.');
    // The nudge asks for the scene alone, but a model that wrote the prefix anyway
    // must not end up with two.
    expect(withNarrationPrefix('@: 눈이 그쳤다.')).toBe('@: 눈이 그쳤다.');
    expect(withNarrationPrefix('  @:  눈이 그쳤다.  ')).toBe('@: 눈이 그쳤다.');
  });

  it('says what the label means once, in the cached system prefix', () => {
    const { system, messages } = assembleNarrated(narrated);
    expect(system).toContain(NARRATION_NOTE);
    // Every preset gets the same sentence, and it is never repeated per turn.
    expect(assemblePrompt({ plot, characters: [bareAria], history: narrated }).system).toContain(
      NARRATION_NOTE,
    );
    expect(messages.filter((message) => promptText(message.content).includes(NARRATION_NOTE))).toHaveLength(
      0,
    );
  });
});

describe('assemblePrompt - a turn a script wrote as its character', () => {
  const kai: PromptCharacter = { name: '카이', card: bareCard };
  const assembleScripted = (history: HistoryMessage[]) =>
    assemblePrompt({ plot, characters: [bareAria, kai], history, preset, userName: '민준', maxResponseTokens: 0 });

  it('sends its lines under its speaker, as a reply names them, and leaves every other turn as it is', () => {
    const { messages } = assembleScripted([
      { role: 'user', content: '누구세요?' },
      // Stored as the script wrote it: no one is named, and the narrator is not who says it.
      { role: 'assistant', content: '*문을 열며* 들어와.\n\n카이: 나도 있어.\n{{user}}, 춥지?', speaker: '아리아' },
      { role: 'assistant', content: '눈이 그쳤다.' },
    ]);
    expect(messages.slice(0, 3)).toEqual([
      { role: 'user', content: '누구세요?' },
      // A line that already names someone on the roster stays theirs; a blank line stays spacing.
      { role: 'assistant', content: '아리아: *문을 열며* 들어와.\n\n카이: 나도 있어.\n아리아: 민준, 춥지?' },
      { role: 'assistant', content: '눈이 그쳤다.' },
    ]);
  });

  it('voices what the prompt scripts made of it, and leaves a narration and a reader’s turn alone', () => {
    const { messages } = assembleScripted([
      { role: 'assistant', content: '원문', promptContent: '고친 글', speaker: '아리아' },
      { role: 'assistant', content: '@: 바람이 분다.', speaker: '아리아' },
      { role: 'user', content: '응', speaker: '아리아' },
    ]);
    expect(messages.slice(0, 3)).toEqual([
      { role: 'assistant', content: '아리아: 고친 글' },
      { role: 'assistant', content: `${NARRATION_HEADER} 바람이 분다.` },
      { role: 'user', content: '응' },
    ]);
  });
});

describe('assemblePrompt - narrator', () => {
  const assembleWith = (input: Partial<Parameters<typeof assemblePrompt>[0]>) =>
    assemblePrompt({
      plot,
      characters: [bareAria],
      history,
      preset,
      userName: '민준',
      maxResponseTokens: 0,
      ...input,
    });

  it('says nothing about a narrator the plot never set', () => {
    expect(assembleWith({}).system).not.toContain('서술 문체');
    expect(assembleWith({}).system).not.toContain('서술 시점');
  });

  it('carries the voice and the point of view after the roster blocks', () => {
    const { system } = assembleWith({
      plot: { ...plot, narrator: { voice: '{{char}}를 멀리서 지켜보는 건조한 문장.', pov: 'third' } },
    });
    const sections = system.split('\n\n');
    // The narrator is the plot's, so its macros resolve against the plot. The
    // labels name the prose, not a narrator: they govern a reply's 지문 as well.
    expect(sections).toContain(
      `서술 문체: 서리 골짜기의 밤를 멀리서 지켜보는 건조한 문장.\n서술 시점: ${NARRATOR_POV_LABELS.third}`,
    );
    expect(system.indexOf('서술 문체')).toBeGreaterThan(system.indexOf('서리 골짜기의 마녀.'));
  });

  it('carries either field on its own', () => {
    const voiced = assembleWith({ plot: { ...plot, narrator: { voice: '짧게 끊어 쓴다.' } } }).system;
    expect(voiced).toContain('서술 문체: 짧게 끊어 쓴다.');
    expect(voiced).not.toContain('서술 시점');

    const { system } = assembleWith({ plot: { ...plot, narrator: { pov: 'first' } } });
    expect(system).toContain(`서술 시점: ${NARRATOR_POV_LABELS.first}`);
    expect(system).not.toContain('서술 문체');
  });

  it('names each point of view without a macro, so no particle can disagree', () => {
    for (const pov of NARRATOR_POVS) {
      const { system } = assembleWith({ plot: { ...plot, narrator: { pov } } });
      expect(system).toContain(`서술 시점: ${NARRATOR_POV_LABELS[pov]}`);
    }
    // The limited view keeps the reader's character to what can be seen of them.
    expect(NARRATOR_POV_LABELS['third-limited']).toBe(
      '3인칭 제한 (장면과 등장인물만 서술하고, 유저의 속마음은 쓰지 않음)',
    );
  });

  it('lets the chat stand in for the plot, whole rather than field by field', () => {
    const narrating: PromptPlot = {
      ...plot,
      narrator: { voice: '플롯의 문체.', pov: 'third' as const },
    };
    const { system } = assembleWith({ plot: narrating, narrator: { pov: 'omniscient' } });
    expect(system).toContain(`서술 시점: ${NARRATOR_POV_LABELS.omniscient}`);
    // The override is the narrator now — the plot's voice does not leak into it.
    expect(system).not.toContain('플롯의 문체.');
    // …and no override leaves the plot's own in force.
    expect(assembleWith({ plot: narrating }).system).toContain('서술 문체: 플롯의 문체.');
  });
});

describe('assemblePrompt - style', () => {
  const assembleWith = (style: PlotStyle, lorebook: LoreEntry[] = []) =>
    assemblePrompt({
      plot: { ...plot, lorebook, narrator: { voice: '건조하게 쓴다.' }, style },
      characters: [bareAria],
      history,
      preset,
      userName: '민준',
      maxResponseTokens: 0,
    });

  it('says nothing about a plot whose style sets nothing', () => {
    expect(assembleWith({}).system).not.toContain(STYLE_DIRECTIVES_HEADER);
    expect(assemblePrompt({ plot, characters: [bareAria], history, preset }).system).not.toContain(
      STYLE_DIRECTIVES_HEADER,
    );
  });

  it('rides with the narrator, ahead of the after_char lore', () => {
    const after = loreEntry({ content: 'AFTER_CHAR_LORE', position: 'after_char' });
    const { system } = assembleWith({ tense: 'past', pacing: 'slow' }, [after]);
    expect(system).toContain(styleDirectives({ tense: 'past', pacing: 'slow' }));
    expect(system.indexOf(STYLE_DIRECTIVES_HEADER)).toBeGreaterThan(system.indexOf('서술 문체'));
    expect(system.indexOf(STYLE_DIRECTIVES_HEADER)).toBeLessThan(system.indexOf('AFTER_CHAR_LORE'));
  });

  it('expands the macros in a directive like every other section', () => {
    const { system } = assembleWith({ difficulty: 'easy' });
    expect(system).toContain('민준의 주도');
    expect(system).not.toContain('{{user}}');
  });

  it('never attaches a Korean allomorphic particle to a macro substitution', () => {
    const options: [keyof PlotStyle, readonly unknown[]][] = [
      ['tense', PLOT_TENSES],
      ['replyLength', REPLY_LENGTHS],
      ['delivery', NARRATIVE_DELIVERIES],
      ['pacing', PLOT_PACINGS],
      ['difficulty', PLOT_DIFFICULTIES],
      ['storytelling', STORYTELLING_STYLES],
      ['choices', CHOICES_MODES],
      ['statusWindow', [true]],
      ['moods', PLOT_MOODS.map((mood) => [mood])],
    ];
    for (const [key, values] of options) {
      for (const value of values) {
        const style = { [key]: value } as PlotStyle;
        expectNoParticleAfterMacro(`style.${key}=${String(value)}`, styleDirectives(style));
      }
    }
  });
});

describe('assemblePrompt - RisuAI host data', () => {
  const now = new Date('2026-01-02T23:30:00Z');
  const clock = { now, timeZone: 'Asia/Seoul', locale: 'ko' as const };
  const timed: HistoryMessage[] = [
    { role: 'assistant', content: '어서 와.', createdAt: 1_000 },
    { role: 'user', content: '안녕', createdAt: 2_000 },
    { role: 'assistant', content: '반가워', createdAt: 3_000 },
    { role: 'user', content: '{{setvar::x::1}}또 왔어', createdAt: 4_000 },
  ];
  const withDescription = (description: string, extra: Partial<Parameters<typeof assemblePrompt>[0]> = {}) =>
    assemblePrompt({
      plot,
      characters: [{ name: '아리아', card: { ...bareCard, description } }],
      history: timed,
      preset,
      userName: '민준',
      ...extra,
    });

  it("answers RisuAI's chat functions from the branch, the greeting kept apart", () => {
    const { system } = withDescription(
      '[{{lastmessageid}}|{{firstmsgindex}}|{{lastcharmessage}}|{{messageunixtimearray}}|{{lastmessage}}]',
      { branch: { length: 4, greeting: { text: '어서 와.', index: -1 } } },
    );
    expect(system).toContain('[2|-1|반가워|["2000","3000","4000"]|{{setvar::x::1}}또 왔어]');
  });

  it('counts the stretch the memory trimmed off the front of the branch', () => {
    const { system } = withDescription('[{{lastmessageid}}|{{previouschatlog::7}}|{{previouschatlog::0}}]', {
      history: timed.slice(2),
      branch: { length: 10, greeting: { text: '어서 와.', index: 0 } },
    });
    // Ten messages, the greeting and nine after it; only the last two are loaded.
    expect(system).toContain('[8|반가워|{{previouschatlog::0}}]');
  });

  it('never counts the branch below nothing, whatever it is told', () => {
    const { system } = withDescription('[{{lastmessageid}}]', {
      history: [],
      branch: { length: 0, greeting: { text: '어서 와.', index: -1 } },
    });
    expect(system).toContain('[-1]');
  });

  it("answers ST's {{lastUserMessage}} with the latest user turn, and {{input}} with nothing", () => {
    const { system } = withDescription('[{{lastUserMessage}}|{{input}}]');
    expect(system).toContain('[{{setvar::x::1}}또 왔어|]');
  });

  it("reads the card's own fields, the persona and the prompts as CBS", () => {
    const { system } = assemblePrompt({
      plot: { ...plot, description: '눈 내리는 {{char}}' },
      characters: [
        {
          name: '아리아',
          card: {
            ...bareCard,
            description: '[{{personality}}|{{scenario}}|{{persona}}|{{mainprompt}}]',
            personality: '{{char}}는 차갑다',
          },
        },
      ],
      history,
      preset: { main: 'MAIN {{user}}', postHistory: 'POST' },
      userName: '민준',
      personaText: '{{user}}는 여행자',
    });
    // `{{scenario}}` is the plot's setting, read where it is asked for: in the member's text.
    expect(system).toContain('[아리아는 차갑다|눈 내리는 아리아|민준는 여행자|MAIN 민준]');
  });

  it('answers ST field macros, the group and the role of the text', () => {
    const second: PromptCharacter = { name: '벨', card: { ...bareCard, description: '벨.' } };
    const { system, messages } = assemblePrompt({
      plot,
      characters: [
        {
          name: '아리아',
          card: {
            ...bareCard,
            description: '[{{mesExamples}}|{{charPrompt}}|{{charJailbreak}}|{{group}}|{{role}}]',
            mesExample: 'EX {{char}}',
            systemPrompt: 'SYS',
            postHistoryInstructions: 'PHI',
          },
        },
        second,
      ],
      history: [
        { role: 'user', content: '{{role}}' },
        { role: 'assistant', content: '{{role}}' },
      ],
      preset,
      userName: '민준',
    });
    expect(system).toContain('[EX 아리아|SYS|PHI|아리아, 벨|system]');
    const texts = messages.map((message) => promptText(message.content));
    expect(texts).toContain('user');
    expect(texts).toContain('char');
  });

  it('answers the clock with arguments in RisuAI tokens, bare in the reader language, and ST offsets', () => {
    const { system } = withDescription(
      '[{{date::YYYY-MM-DD}}|{{time::HH:mm}}|{{time}}|{{time_UTC+9}}|{{time_UTC-5}}]',
      { clock },
    );
    expect(system).toContain('[2026-01-03|08:30|08:30|08:30|18:30]');
  });

  it("draws {{pick}} RisuAI's way once the branch is known: per turn, the same on a reroll", () => {
    const options = Array.from({ length: 12 }, (_, i) => `o${i}`).join(',');
    const draw = (length: number): string =>
      withDescription(`[{{pick::${options}}}|{{pick::${options}}}]`, { seed: 'chat-1', branch: { length } }).system;
    expect(draw(4)).toBe(draw(4));
    const picked = /\[(o\d+)\|(o\d+)\]/.exec(draw(4))!;
    // One draw for every pick in a text.
    expect(picked[1]).toBe(picked[2]);
    const turns = [5, 6, 7, 8, 9].map((length) => /\[(o\d+)\|/.exec(draw(length))![1]);
    expect(turns.some((one) => one !== picked[1])).toBe(true);
  });

  it('reads global variables, and the whole enabled book for {{lorebook}}', () => {
    const entry = loreEntry({ content: '서리', keys: ['눈'], name: '날씨' });
    const off = loreEntry({ content: '꺼짐', enabled: false });
    const { system } = assemblePrompt({
      plot: { ...plot, description: '[{{getglobalvar::seen}}|{{? @seen + 1}}]', lorebook: [entry, off] },
      characters: [{ name: '아리아', card: { ...bareCard, description: 'BOOK{{lorebook}}' } }],
      history,
      preset,
      userName: '민준',
      globalVariables: { seen: '2' },
    });
    expect(system).toContain('[2|3]');
    const book = JSON.parse(/BOOK(.*)/.exec(system)![1]!) as string[];
    expect(book.map((one) => JSON.parse(one))).toEqual([
      expect.objectContaining({ key: '눈', content: '서리', comment: '날씨', alwaysActive: true, mode: 'normal' }),
    ]);
  });

  it('runs #each in the prompt, and sends a text whose expansion runs away as written', () => {
    expect(withDescription('{{#each [1,2,3] as n}}<{{slot::n}}>{{/each}}').system).toContain('<1><2><3>');
    const runaway = '{{#each {{range::[3000]}} as n}}{{range::[1000]}}{{/each}}';
    expect(withDescription(runaway).system).toContain(runaway);
  });

  it("maps RisuAI's display escapes back on what it sends", () => {
    const { system, messages } = withDescription('{{decbo}}x{{decbc}} {{#escape}}(y){{/escape}}', {
      authorNote: '{{bo}}',
    });
    expect(system).toContain('{x} (y)');
    expect(messages.map((message) => promptText(message.content))).toContain('{{');
  });

  it("says nothing for {{comment}} in the prompt, as RisuAI's prompt does", () => {
    expect(withDescription('a{{comment::메모}}b').system).toContain('ab');
  });
});

describe('assemblePrompt - nickname', () => {
  const nicknamed: PromptCharacter = {
    name: '아리아 블랑',
    card: { ...card, nickname: '아리', lorebook: [loreEntry({ content: '{{char}}의 로어' })] },
  };

  it("reads {{char}} as the card's nickname in its own text, and keeps the roster name on the headers", () => {
    const { system, messages } = assemblePrompt({
      plot,
      characters: [nicknamed],
      history,
      preset,
      userName: '민준',
    });
    expect(system).toContain(`${characterHeader('아리아 블랑')}\n서리 골짜기의 마녀.\n\n아리의 성격: 무뚝뚝하다.`);
    expect(system).toContain('아리의 로어');
    const examples = messages
      .map((message) => promptText(message.content))
      .filter((text) => text.startsWith(exampleHeader('아리아 블랑')));
    expect(examples[0]).toBe(`${exampleHeader('아리아 블랑')}\n민준: 예시 질문 하나\n아리: 예시 답변 하나`);
  });
});

describe('assemblePrompt - injections', () => {
  it("places RisuAI's three, as written: before the newest turn, after the history, at the very end", () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [bareAria],
      history,
      preset,
      userName: '민준',
      injections: { start: '{{char}} START', historyend: 'END', promptend: 'LAST' },
    });
    const texts = messages.map((message) => promptText(message.content));
    const newest = texts.indexOf('네 번째 유저 발화입니다.');
    expect(texts[newest - 1]).toBe('{{char}} START');
    expect(texts.slice(newest + 1)).toEqual(['END', 'POST', 'LAST']);
    const injected = messages.filter((message) =>
      ['{{char}} START', 'END', 'LAST'].includes(promptText(message.content)),
    );
    expect(injected.map((message) => message.role)).toEqual(['system', 'system', 'system']);
  });

  it('charges them to the budget, evicting history rather than themselves', () => {
    const big = '말 '.repeat(400).trim();
    const base = { plot, characters: [bareAria], history, preset, userName: '민준', maxResponseTokens: 0 };
    // Exactly the room everything takes without the injection.
    const contextBudget = assemblePrompt({ ...base, report: true }).report!.totals.used;
    const without = assemblePrompt({ ...base, contextBudget });
    const withIt = assemblePrompt({ ...base, contextBudget, injections: { promptend: big } });
    const turns = (prompt: typeof without): number =>
      prompt.messages.filter((message) => message.role !== 'system').length;
    expect(turns(withIt)).toBeLessThan(turns(without));
    expect(promptText(withIt.messages.at(-1)!.content)).toBe(big);
  });

  it('goes where the history would be when there is none', () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [bareAria],
      history: [],
      preset,
      userName: '민준',
      injections: { start: 'S', historyend: 'E' },
    });
    expect(messages.map((message) => promptText(message.content))).toEqual(['S', 'E', 'POST']);
  });
});

describe("assemblePrompt - a SillyTavern member's variable macros", () => {
  const tavern = (description: string, extra: Partial<PromptCharacter> = {}): PromptCharacter => ({
    name: '아리아',
    card: { ...bareCard, description },
    sillyTavern: true,
    ...extra,
  });

  it('runs them while the prompt is built, says nothing, and hands back what they wrote', () => {
    const variables = { hp: '10' };
    const result = assemblePrompt({
      plot,
      characters: [tavern('{{incvar::seen}}{{addvar::hp::-3}}마녀 {{getvar::hp}}.')],
      history,
      preset,
      userName: '민준',
      variables,
    });
    expect(result.system).toContain('마녀 7.');
    expect(result.system).not.toContain('incvar');
    expect(result.variableWrites).toEqual({ hp: '7', seen: '1' });
    // The caller's map is the branch's state, and stays it.
    expect(variables).toEqual({ hp: '10' });
  });

  it('is read by a {{getvar}} later in the same prompt, the history included', () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [tavern('{{setvar::mood::calm}}')],
      history: [{ role: 'user', content: '기분: {{getvar::mood}}' }],
      preset,
      userName: '민준',
    });
    expect(messages.map((message) => promptText(message.content))).toContain('기분: calm');
  });

  it("leaves them as written in any other member's text, and in the history", () => {
    const result = assemblePrompt({
      plot,
      characters: [tavern('{{setvar::mood::calm}}', { sillyTavern: undefined })],
      history: [{ role: 'user', content: '{{setvar::mood::angry}}' }],
      preset,
      userName: '민준',
    });
    expect(result.system).toContain('{{setvar::mood::calm}}');
    expect(result.messages.map((message) => promptText(message.content))).toContain('{{setvar::mood::angry}}');
    expect(result.variableWrites).toBeUndefined();
  });
});

describe("assemblePrompt - SillyTavern's lore positions", () => {
  const longer: HistoryMessage[] = [
    ...history,
    { role: 'assistant', content: '다섯 번째 캐릭터 발화입니다.' },
    { role: 'user', content: '여섯 번째 유저 발화입니다.' },
  ];
  const texts = (messages: { content: string | PromptPart[] }[]): string[] =>
    messages.map((message) => promptText(message.content));
  const noteLore = [
    loreEntry({ content: 'AN-BOTTOM', position: 'after_author_note', insertionOrder: 2 }),
    loreEntry({ content: 'AN-TOP', position: 'before_author_note', insertionOrder: 1 }),
  ];

  it("puts the author's-note lore around the note, a line each, where the note sits", () => {
    const { system, messages } = assemblePrompt({
      plot,
      characters: [{ name: '아리아', card: { ...bareCard, lorebook: noteLore } }],
      history: longer,
      preset,
      userName: '민준',
      authorNote: '{{user}}는 지금 초조하다.',
    });
    expect(system).not.toContain('AN-');
    expect(texts(messages)).toEqual([
      ...longer.slice(0, 2).map((m) => m.content),
      'AN-TOP\n민준는 지금 초조하다.\nAN-BOTTOM',
      ...longer.slice(2).map((m) => m.content),
      'POST',
    ]);
  });

  it("takes the note's place when the chat has no note of its own", () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [{ name: '아리아', card: { ...bareCard, lorebook: noteLore } }],
      history: longer,
      preset,
      userName: '민준',
    });
    expect(messages[2]).toEqual({ role: 'system', content: 'AN-TOP\nAN-BOTTOM' });
  });

  it('puts the example lore around the examples, named for its book, and evicts it with them', () => {
    const input = {
      plot: { ...plot, lorebook: [loreEntry({ content: '<START>\nA\n<START>\nB', position: 'before_examples' })] },
      characters: [
        { name: '아리아', card: { ...card, lorebook: [loreEntry({ content: 'C', position: 'after_examples' })] } },
      ],
      history,
      preset,
      userName: '민준',
      maxResponseTokens: 0,
    } satisfies Parameters<typeof assemblePrompt>[0];
    const roomy = assemblePrompt({ ...input, contextBudget: 100_000 });
    expect(texts(roomy.messages)).toEqual([
      `${exampleHeader(plot.name)}\nA`,
      `${exampleHeader(plot.name)}\nB`,
      `${exampleHeader('아리아')}\n민준: 예시 질문 하나\n아리아: 예시 답변 하나`,
      `${exampleHeader('아리아')}\n민준: 예시 질문 둘\n아리아: 예시 답변 둘`,
      `${exampleHeader('아리아')}\nC`,
      ...history.map((m) => m.content),
      'POST',
    ]);
    expect(roomy.system).not.toContain('\nC');

    // Room for the system string, the history and the post-history block only.
    const budget =
      countTokens(roomy.system) +
      countTokens('POST') +
      history.reduce((sum, turn) => sum + countTokens(turn.content), 0);
    expect(texts(assemblePrompt({ ...input, contextBudget: budget }).messages)).toEqual([
      ...history.map((m) => m.content),
      'POST',
    ]);
  });

  it('fills every {{outlet::name}} with its entries, and sends an outlet nothing names nowhere', () => {
    const { system, messages, report } = assemblePrompt({
      plot,
      characters: [
        {
          name: '아리아',
          card: {
            ...bareCard,
            description: '[{{outlet::무기}}|{{outlet::없음}}|{{OUTLET:: 무기 }}]',
            lorebook: [
              loreEntry({ content: 'BOW', position: 'outlet', outletName: '무기', insertionOrder: 2 }),
              loreEntry({ content: 'SWORD', position: 'outlet', outletName: '무기', insertionOrder: 1 }),
              loreEntry({ content: 'SHIELD', position: 'outlet', outletName: '방어' }),
              // ST never sends an outlet entry no macro can name.
              loreEntry({ content: 'NAMELESS', position: 'outlet' }),
            ],
          },
        },
      ],
      history: [{ role: 'user', content: '{{outlet::방어}}?' }],
      preset,
      userName: '민준',
      report: true,
    });
    expect(system).toContain('[SWORD\nBOW||SWORD\nBOW]');
    expect(system.split('SWORD')).toHaveLength(3);
    expect(system).not.toContain('SHIELD');
    expect(system).not.toContain('NAMELESS');
    expect(texts(messages)).toContain('SHIELD?');
    expect(report!.lore.map((entry) => entry.placement)).toEqual([
      'outlet 방어',
      'outlet ',
      'outlet 무기',
      'outlet 무기',
    ]);
  });
});

describe('assemblePrompt - what the prompt scripts made of the history', () => {
  it('sends the rewritten turn, while the lore still scans the stored one', () => {
    const { system, messages } = assemblePrompt({
      plot,
      characters: [
        {
          name: '아리아',
          card: { ...bareCard, lorebook: [loreEntry({ content: 'KEY-LORE', constant: false, keys: ['열쇠'] })] },
        },
      ],
      history: [
        { role: 'assistant', content: '열쇠가 있다.', promptContent: '[가려짐]' },
        { role: 'user', content: '좋아' },
      ],
      preset,
      userName: '민준',
    });
    expect(system).toContain('KEY-LORE');
    expect(messages.map((message) => promptText(message.content))).toEqual(['[가려짐]', '좋아', 'POST']);
  });

  it('reads each turn as its own message, as RisuAI does: {{chat_index}} is its index', () => {
    const turns: HistoryMessage[] = [
      { role: 'assistant', content: '{{chat_index}}' },
      { role: 'user', content: '{{chat_index}}' },
      { role: 'assistant', content: '{{chat_index}}' },
      { role: 'user', content: '{{chat_index}}' },
    ];
    const sent = (turnsSent: HistoryMessage[], length: number): string[] =>
      assemblePrompt({
        plot,
        characters: [bareAria],
        history: turnsSent,
        preset,
        userName: '민준',
        branch: { length, greeting: { text: '{{chat_index}}', index: -1 } },
      })
        .messages.slice(0, -1)
        .map((message) => promptText(message.content));
    // The greeting is -1 and the turns after it count from 0, the trimmed ones too.
    expect(sent(turns, 4)).toEqual(['-1', '0', '1', '2']);
    expect(sent(turns.slice(2), 4)).toEqual(['1', '2']);
  });
});

describe('assemblePrompt - messages hidden from the AI', () => {
  const turns: HistoryMessage[] = [
    { role: 'assistant', content: '인사 {{chat_index}}' },
    { role: 'user', content: '숨긴 말: 비밀 열쇠', hidden: true },
    { role: 'assistant', content: '대답 {{chat_index}}' },
    { role: 'user', content: '보이는 말' },
  ];
  const assembleWith = (turnsSent: HistoryMessage[], extra: { report?: boolean; contextBudget?: number } = {}) =>
    assemblePrompt({ plot, characters: [bareAria], history: turnsSent, preset, userName: '민준', maxResponseTokens: 0, ...extra });

  it('sends none of a hidden turn, and still counts it where the stored chat is read', () => {
    const { messages, report, risu } = assembleWith(turns, { report: true });
    // The turn after it reads its index on the stored chat, the hidden turn among it.
    expect(messages.map((message) => promptText(message.content))).toEqual(['인사 0', '대답 2', '보이는 말', 'POST']);
    expect(report!.history).toEqual({ included: 3, total: 3 });
    // Nothing was cut off the front for the request editors: a hidden turn is not dropped history.
    expect(risu!.fromStart).toBe(true);
    expect(assembleWith([{ ...turns[0]!, hidden: true }, ...turns.slice(1)]).risu!.fromStart).toBe(true);
  });

  it('scans no hidden turn for lore keywords', () => {
    const lorebook = [loreEntry({ content: 'KEY-LORE', constant: false, keys: ['열쇠'] })];
    const scanned = (turnsSent: HistoryMessage[]): string =>
      assemblePrompt({
        plot,
        characters: [{ name: '아리아', card: { ...bareCard, lorebook } }],
        history: turnsSent,
        preset,
        userName: '민준',
      }).system;
    expect(scanned(turns)).not.toContain('KEY-LORE');
    expect(scanned(turns.map(({ hidden: _hidden, ...turn }) => turn))).toContain('KEY-LORE');
  });

  it('keeps the newest turn the AI reads when the budget is spent, never a hidden one', () => {
    const tail: HistoryMessage[] = [...turns, { role: 'assistant', content: '숨긴 답', hidden: true }];
    const tiny = assembleWith(tail, { contextBudget: 1 });
    expect(tiny.messages.map((message) => promptText(message.content))).toEqual(['보이는 말', 'POST']);
    expect(tiny.risu!.fromStart).toBe(false);
  });

  it('sends no history at all when every turn is hidden', () => {
    const { messages, report } = assembleWith(
      turns.map((turn) => ({ ...turn, hidden: true })),
      { report: true },
    );
    expect(messages.map((message) => promptText(message.content))).toEqual(['POST']);
    expect(report!.history).toEqual({ included: 0, total: 0 });
  });
});

describe("assemblePrompt - SillyTavern's World Info settings", () => {
  it('gives the automatic budget the share the book names', () => {
    const words = '단어 '.repeat(40).trim();
    const lorebook = [
      loreEntry({ content: `A ${words}`, insertionOrder: 3 }),
      loreEntry({ content: `B ${words}`, insertionOrder: 2 }),
      loreEntry({ content: `C ${words}`, insertionOrder: 1 }),
    ];
    const cost = countTokens(`A ${words}`);
    const activated = (budgetPercent?: number): string[] =>
      assemblePrompt({
        plot,
        characters: [
          {
            name: '아리아',
            card: {
              ...bareCard,
              lorebook,
              loreSettings: { ...DEFAULT_LORE_SETTINGS, ...(budgetPercent ? { budgetPercent } : {}) },
            },
          },
        ],
        history,
        preset,
        userName: '민준',
        // Room for two entries at the default quarter, and for one at a tenth.
        contextBudget: Math.ceil((cost * 2.5) / LORE_BUDGET_SHARE),
        report: true,
      }).report!.lore.map((entry) => entry.preview.slice(0, 1));
    expect(activated()).toEqual(['B', 'A']);
    expect(activated(10)).toEqual(['A']);
  });

  it('stops a recursive scan at the step limit, the first scan included', () => {
    const lorebook = [
      loreEntry({ content: '열쇠', insertionOrder: 1 }),
      loreEntry({ content: '자물쇠', constant: false, keys: ['열쇠'], insertionOrder: 2 }),
      loreEntry({ content: '문', constant: false, keys: ['자물쇠'], insertionOrder: 3 }),
    ];
    const activated = (maxRecursionSteps?: number): string[] =>
      assemblePrompt({
        plot,
        characters: [
          {
            name: '아리아',
            card: {
              ...bareCard,
              lorebook,
              loreSettings: {
                ...DEFAULT_LORE_SETTINGS,
                recursiveScanning: true,
                ...(maxRecursionSteps ? { maxRecursionSteps } : {}),
              },
            },
          },
        ],
        history,
        preset,
        userName: '민준',
        report: true,
      }).report!.lore.map((entry) => entry.preview);
    expect(activated()).toEqual(['열쇠', '자물쇠', '문']);
    expect(activated(2)).toEqual(['열쇠', '자물쇠']);
    expect(activated(1)).toEqual(['열쇠']);
  });
});

describe('assemblePrompt - a RisuAI utility bot', () => {
  const utilityCard: NormalizedCard = {
    ...bareCard,
    systemPrompt: '카드의 시스템 프롬프트',
    postHistoryInstructions: '카드의 끝 지시 [{{original}}] {{char}}',
    extensions: { risuai: { utilityBot: true } },
  };
  const utility: PromptCharacter = { name: '아리아', card: utilityCard };
  const input = {
    plot,
    history,
    preset,
    userName: '민준',
    personaText: '페르소나 설명',
    authorNote: '작가 노트',
    memoryText: '[지난 이야기 요약]\n둘은 만났다.',
    injections: { start: 'START', historyend: 'END', promptend: 'LAST' },
    report: true,
  };

  it('sends RisuAI’s template for one: the card’s own parts, none of our preset, persona or note', () => {
    const prompt = assemblePrompt({ ...input, characters: [utility] });
    // RisuAI's utility template: description, lore, chat, the card's global note, what goes after everything.
    expect(prompt.system).toBe([PLOT_BLOCK, ARIA_BLOCK, '[지난 이야기 요약]\n둘은 만났다.'].join('\n\n'));
    for (const gone of ['MAIN', '카드의 시스템 프롬프트', NARRATION_NOTE, REPLY_FORMAT_HINT, '페르소나 설명']) {
      expect(prompt.system).not.toContain(gone);
    }
    const texts = prompt.messages.map((message) => promptText(message.content));
    // The chat whole, then the card's replacement with `{{original}}` as nothing and no protocol reminder,
    // then what goes after everything. The note and the start triggers' `start` and `historyend` have no place.
    expect(texts).toEqual([...history.map((turn) => turn.content), '카드의 끝 지시 [] 아리아', 'LAST']);
    expect(prompt.report!.blocks.map((block) => block.kind)).not.toContain('author_note');
    expect(prompt.risu).toEqual({ memory: expect.any(Object), fromStart: true, utilityBot: true });

    // The same card without the flag is read as it always was.
    const roleplay = assemblePrompt({ ...input, characters: [{ name: '아리아', card: { ...utilityCard, extensions: {} } }] });
    expect(roleplay.system).toContain('카드의 시스템 프롬프트');
    expect(roleplay.system).toContain('페르소나 설명');
    expect(roleplay.messages.map((message) => promptText(message.content))).toEqual(
      expect.arrayContaining(['작가 노트', 'START', 'END', 'LAST']),
    );
    expect(roleplay.risu!.utilityBot).toBeUndefined();
  });

  it('sends no post-history turn when the card has no replacement, and keeps the lore', () => {
    const lore = loreEntry({ content: '항상 켜진 설정', constant: true });
    const bare: PromptCharacter = {
      name: '아리아',
      card: { ...bareCard, lorebook: [lore], extensions: { risuai: { utilityBot: true } } },
    };
    const prompt = assemblePrompt({ ...input, characters: [bare] });
    expect(prompt.system).toContain('항상 켜진 설정');
    expect(prompt.messages.map((message) => promptText(message.content))).toEqual([...history.map((turn) => turn.content), 'LAST']);
    expect(prompt.sources!.map((source) => source.kind)).not.toContain('post_history');
  });

  it('is the asked member’s setting in a work of several, as RisuAI reads it off the character it asks', () => {
    const other: PromptCharacter = { name: '벨', card: { ...bareCard, name: '벨' } };
    const asked = assemblePrompt({ ...input, characters: [other, utility], speaker: 1 });
    expect(asked.system).not.toContain('MAIN');
    expect(asked.system).not.toContain('페르소나 설명');
    // The group's next-speaker line is RisuAI's `postEverything` too, and stays.
    expect(promptText(asked.messages.at(-1)!.content)).toContain('아리아');
    const scene = assemblePrompt({ ...input, characters: [other, utility], speaker: 0 });
    expect(scene.system).toContain('MAIN');
    expect(scene.system).toContain('페르소나 설명');
  });
});
