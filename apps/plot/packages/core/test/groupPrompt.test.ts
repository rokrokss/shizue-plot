import { describe, expect, it } from 'vitest';
import {
  GROUP_SPEECH_PROTOCOL,
  GROUP_SPEECH_PROTOCOL_REMINDER,
  groupPreset,
  PRESETS,
  SPEECH_PROTOCOL,
  SPEECH_PROTOCOL_REMINDER,
} from '../src/presets.js';
import {
  assemblePrompt,
  groupSpeakerLine,
  NARRATION_HEADER,
  promptText,
  scenarioLine,
  type AssemblePromptInput,
  type HistoryMessage,
  type PromptCharacter,
  type PromptPlot,
} from '../src/prompt.js';
import { countTokens } from '../src/tokens.js';
import { DEFAULT_LORE_SETTINGS, type LoreEntry, type NormalizedCard } from '../src/types.js';

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

const baseCard: NormalizedCard = {
  spec: 'v3',
  name: '',
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  alternateGreetings: [],
  mesExample: '',
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

const seiya: PromptCharacter = {
  name: '세이야',
  card: {
    ...baseCard,
    name: '세이야',
    nickname: '세이',
    description: '{{char}}는 검을 든 기사.',
    personality: '과묵하다.',
    mesExample: '<START>\n{{user}}: 누구야?\n{{char}}: *검을 거둔다* 기사다.',
    systemPrompt: '세이야 카드의 지시. {{original}}',
    postHistoryInstructions: '[{{char}}의 말투를 지킨다.]',
    lorebook: [loreEntry({ content: '{{char}}의 검은 은빛이다.', constant: false, keys: ['검'] })],
  },
};

const kai: PromptCharacter = {
  name: '카이',
  card: {
    ...baseCard,
    name: '카이',
    description: '{{char}}는 여관의 주인.',
    personality: '수다스럽다.',
    mesExample: '<START>\n{{user}}: 방 있어?\n{{char}}: 있지, 있고말고!',
    systemPrompt: '카이 카드의 지시만 따른다.',
  },
};

const mio: PromptCharacter = {
  name: '미오',
  card: { ...baseCard, name: '미오', description: '{{char}}는 떠돌이 악사.' },
  absent: true,
};

const plot: PromptPlot = {
  name: '은빛 여관',
  description: '눈 덮인 고개의 여관. {{user}}는 길을 잃었다.',
  lorebook: [loreEntry({ content: '여관은 백 년이 되었다.', position: 'after_char' })],
  narrator: { voice: '건조하게 끊어 쓴다.', pov: 'third' },
  style: { replyLength: 'short', statusWindow: true, choices: 'keywords' },
};

const history: HistoryMessage[] = [
  { role: 'assistant', content: '눈이 내린다.\n세이야: *문을 연다* 들어와.\n카이: 어서 와!' },
  { role: 'user', content: '@: 바람이 문을 흔든다.' },
  { role: 'user', content: '세이야, 그 검은 뭐야?' },
  {
    role: 'assistant',
    content: '세이야: 오래된 검이다.\n\n```status\n위치: 여관\n```\n>> 검을 만진다\n>> 물러선다',
  },
  { role: 'assistant', content: '*잔을 닦으며* 손님이 늘었네.', speaker: '카이' },
  { role: 'user', content: '{{char}}의 밤은 길다.' },
];

const base = (overrides: Partial<AssemblePromptInput> = {}): AssemblePromptInput => ({
  plot,
  characters: [seiya, kai, mio],
  history,
  personaText: '{{user}}는 길 잃은 여행자.',
  userName: '민준',
  memoryText: '[Summary of the story so far]\n민준은 고개를 넘다 길을 잃고 여관에 들었다.',
  authorNote: '긴장을 유지한다.',
  directions: '주사위 4. 문이 열린다.',
  injections: { start: '시작 주입', historyend: '끝 주입', promptend: '맨끝 주입' },
  preset: PRESETS.novel,
  contextBudget: 100_000,
  report: true,
  ...overrides,
});

// Pinned against the assembler as it stood before group turns: without a
// `speaker`, every byte it returns stays what it was. What each message is
// (`sources`), the request editors' view (`risu`) and the system string's
// sections came later, beside the prompt rather than in it.
const pinned = (input: AssemblePromptInput) => {
  const { sources: _sources, risu: _risu, fixedTokens: _fixed, systemSections: _sections, ...prompt } = assemblePrompt(input);
  return prompt;
};

describe('assemblePrompt - without a speaker, as before group turns', () => {
  it('assembles a one-member plot as it always has', () => {
    expect(pinned(base({ characters: [seiya] }))).toMatchSnapshot();
  });

  it('assembles a multi-member scene call as it always has', () => {
    expect(pinned(base())).toMatchSnapshot();
  });

  it('assembles a narration as it always has', () => {
    // Today's narration is the scene prompt; the narrate route adds its nudge
    // behind it as `trailingSystem`.
    const narrated = [...history, { role: 'assistant' as const, content: '@: 눈이 그쳤다.' }];
    expect(pinned(base({ preset: PRESETS.standard, directions: '', history: narrated }))).toMatchSnapshot();
  });
});

describe('group protocol', () => {
  it('is in every preset to swap, so no preset silently keeps the scene protocol', () => {
    for (const [id, preset] of Object.entries(PRESETS)) {
      expect(preset.main, id).toContain(SPEECH_PROTOCOL);
      expect(preset.postHistory, id).toContain(SPEECH_PROTOCOL_REMINDER);
      const group = groupPreset(preset);
      expect(group.main, id).toContain(GROUP_SPEECH_PROTOCOL);
      expect(group.main, id).not.toContain(SPEECH_PROTOCOL);
      expect(group.postHistory, id).toContain(GROUP_SPEECH_PROTOCOL_REMINDER);
      expect(group.postHistory, id).not.toContain(SPEECH_PROTOCOL_REMINDER);
      // Only the protocol changes: the preset's voice is the same text around it.
      expect(group.main.replace(GROUP_SPEECH_PROTOCOL, SPEECH_PROTOCOL), id).toBe(preset.main);
    }
  });

  it('leaves a preset without the protocol as it is', () => {
    expect(groupPreset({ main: 'MAIN', postHistory: 'POST' })).toEqual({ main: 'MAIN', postHistory: 'POST' });
  });
});

describe('assemblePrompt - a group turn', () => {
  const seiyaRow: PromptCharacter = { ...seiya, id: 'seiya-id' };
  const kaiRow: PromptCharacter = { ...kai, id: 'kai-id' };
  const groupHistory: HistoryMessage[] = [
    // An old scene message: untagged, prefixes and narrator lines as written.
    { role: 'assistant', content: '눈이 내린다.\n세이야: 들어와.' },
    { role: 'user', content: '세이야, 카이, 안녕?' },
    { role: 'assistant', content: '*고개를 끄덕인다* 왔군.', speakerId: 'seiya-id' },
    { role: 'assistant', content: '어서 와!\n\n*잔을 내민다*', speakerId: 'kai-id' },
    { role: 'assistant', content: '@: 바람이 분다.', speakerId: 'kai-id' },
    { role: 'user', content: '고마워.' },
  ];
  const group = (overrides: Partial<AssemblePromptInput> = {}) =>
    assemblePrompt({
      plot,
      characters: [seiyaRow, kaiRow, mio],
      history: groupHistory,
      userName: '민준',
      preset: PRESETS.standard,
      contextBudget: 100_000,
      ...overrides,
    });
  const texts = (prompt: ReturnType<typeof assemblePrompt>): string[] =>
    prompt.messages.map((message) => promptText(message.content));

  it("reads the speaker's own overrides, as them, with the group protocol", () => {
    const asKai = group({ speaker: 1 });
    // No {{original}}: the card's instruction stands, and the group protocol is put behind it.
    expect(asKai.system.startsWith(`카이 카드의 지시만 따른다.\n\n${GROUP_SPEECH_PROTOCOL}`)).toBe(true);
    expect(asKai.system).not.toContain('세이야 카드의 지시');
    expect(asKai.system).not.toContain(SPEECH_PROTOCOL);

    const asSeiya = group({ speaker: 0 });
    // {{original}} brings the group preset back; {{char}} in the card's text is the speaker's nickname.
    expect(asSeiya.system.startsWith('세이야 카드의 지시. You are the writer who plays every character of 은빛 여관.')).toBe(true);
    expect(asSeiya.system).toContain(GROUP_SPEECH_PROTOCOL);
    expect(asSeiya.system).not.toContain(SPEECH_PROTOCOL);
    expect(texts(asSeiya).at(-2)).toBe(`[세이의 말투를 지킨다.]\n\n${GROUP_SPEECH_PROTOCOL_REMINDER}`);
  });

  it("falls back to the preset where the speaker's card has no override, swapped all the same", () => {
    const post = texts(group({ speaker: 1 })).at(-2)!;
    expect(post).toContain(GROUP_SPEECH_PROTOCOL_REMINDER);
    expect(post).not.toContain(SPEECH_PROTOCOL_REMINDER);
    expect(post).toContain('은빛 여관');
  });

  it("sends the speaker's own replies plain and everyone else's under their name", () => {
    const turns = (speaker?: number): string[] =>
      // The turns alone: examples, labels and the closing blocks all open on `[`.
      texts(group(speaker === undefined ? {} : { speaker })).filter(
        (text) => !text.startsWith('[') && !text.includes('은빛 여관'),
      );
    expect(turns(0)).toEqual([
      '눈이 내린다.\n세이야: 들어와.',
      '세이야, 카이, 안녕?',
      '*고개를 끄덕인다* 왔군.',
      '카이: 어서 와!\n\n카이: *잔을 내민다*',
      '고마워.',
    ]);
    expect(turns(1).slice(2, 4)).toEqual(['세이야: *고개를 끄덕인다* 왔군.', '어서 와!\n\n*잔을 내민다*']);
    // A narration keeps its header whoever it is stored under.
    expect(texts(group({ speaker: 1 }))).toContain(`${NARRATION_HEADER} 바람이 분다.`);
    // A scene call reads every tagged reply under its member.
    expect(turns().slice(2, 4)).toEqual(['세이야: *고개를 끄덕인다* 왔군.', '카이: 어서 와!\n\n카이: *잔을 내민다*']);
  });

  it('closes on the speaker line, after everything else, charged to the budget', () => {
    const prompt = group({ speaker: 1, injections: { promptend: '맨끝' }, report: true });
    const { messages, report } = prompt;
    expect(messages.at(-1)).toEqual({ role: 'system', content: groupSpeakerLine('카이') });
    expect(messages.at(-2)).toEqual({ role: 'system', content: '맨끝' });
    expect(groupSpeakerLine('카이')).toBe("[Next speaker: 카이. Write only this character's words and actions.]");
    expect(report!.blocks.at(-1)).toMatchObject({ kind: 'trailing', label: '카이', text: groupSpeakerLine('카이') });
    expect(report!.totals.used).toBe(
      countTokens(prompt.system) + texts(prompt).reduce((sum, text) => sum + countTokens(text), 0),
    );
  });

  it("brings the speaker's own scenario beside the turn, as RisuAI sends the asked character's, never twice", () => {
    const withScenario = (row: PromptCharacter, scenario: string): PromptCharacter => ({ ...row, card: { ...row.card, scenario } });
    const characters = [withScenario(seiyaRow, '세이야는 순찰 중이다.'), withScenario(kaiRow, '{{char}}는 장부를 정리하는 중이다.'), mio];
    const asKai = group({ characters, speaker: 1 });
    expect(asKai.messages.at(-1)).toEqual({
      role: 'system',
      content: `${groupSpeakerLine('카이')}\n${scenarioLine('카이는 장부를 정리하는 중이다.')}`,
    });
    // Nothing of it in the cached prefix, which every speaker's turn shares.
    expect(asKai.system).not.toContain('장부를 정리');
    // The first member's became the work's description at import: it is not said again.
    expect(promptText(group({ characters, speaker: 0 }).messages.at(-1)!.content)).toBe(groupSpeakerLine('세이야'));
    // Nor a scenario that is the description itself, nor in a scene reply that is no one's turn.
    const same = [characters[0]!, withScenario(kaiRow, plot.description), mio];
    expect(promptText(group({ characters: same, speaker: 1 }).messages.at(-1)!.content)).toBe(groupSpeakerLine('카이'));
    expect(texts(group({ characters })).join('\n')).not.toContain('장부를 정리');
  });

  it("lets a speaker's next round repeat their request up to the system turns that close it, as the provider's cache needs", () => {
    /** The request up to its last turn of the conversation: the ChatGPT adapter sends the system turns after it as one. */
    const conversation = (prompt: ReturnType<typeof assemblePrompt>) =>
      prompt.messages.slice(0, prompt.messages.findLastIndex((message) => message.role !== 'system') + 1);
    const next: HistoryMessage[] = [
      ...groupHistory,
      { role: 'assistant', content: '카이의 답.', speakerId: 'kai-id' },
      { role: 'assistant', content: '세이야의 답.', speakerId: 'seiya-id' },
      { role: 'user', content: '또 보자.' },
    ];
    for (const speaker of [0, 1]) {
      const before = group({ speaker, factsText: '[Memory]\n- 하나.' });
      const after = group({ speaker, history: next, factsText: '[Memory]\n- 둘.' });
      expect(after.system).toBe(before.system);
      expect(conversation(after).slice(0, conversation(before).length)).toEqual(conversation(before));
    }
    // Another speaker reads the history otherwise — their own replies plain, the rest
    // under names — so the next speaker of a round does not repeat the one before.
    const first = group({ speaker: 0 });
    const second = group({ speaker: 1, history: [...groupHistory, { role: 'assistant', content: '세이야의 답.', speakerId: 'seiya-id' }] });
    expect(conversation(second).slice(0, conversation(first).length)).not.toEqual(conversation(first));
  });

  it("sends a member's keyword lore after the round's newest reply, ahead of what closes the speaker's turn", () => {
    // 세이야's book says what his 검 is; the reply the round already has names it.
    const round: HistoryMessage[] = [...groupHistory, { role: 'assistant', content: '*검을 내려놓는다*', speakerId: 'seiya-id' }];
    const asKai = group({ speaker: 1, history: round, directions: '판정.', report: true });
    expect(asKai.system).not.toContain('검은 은빛');
    // The work's always-on lore stays where it was.
    expect(asKai.system).toContain('여관은 백 년이 되었다.');
    expect(asKai.sources!.map((source) => source.kind).slice(-5)).toEqual(['history', 'moved_lore', 'directions', 'post_history', 'trailing']);
    // Read as its own book's, under its member's nickname, whoever speaks.
    expect(texts(asKai).slice(-5, -2)).toEqual(['세이야: *검을 내려놓는다*', '세이의 검은 은빛이다.', '[Game ruling]\n판정.']);
    expect(texts(group({ speaker: 0, history: round })).at(-3)).toBe('세이의 검은 은빛이다.');
    // The round's next speaker's system string is the one the turn before had, the lore notwithstanding.
    expect(asKai.system).toBe(group({ speaker: 1 }).system);
  });

  it("stops on every other on-stage member's name and nickname", () => {
    expect(group({ speaker: 1 }).stopSequences).toEqual(['\n세이야:', '\n세이:']);
    // The absent member is not on the stage, and the speaker is not among their own stops.
    expect(group({ speaker: 0 }).stopSequences).toEqual(['\n카이:']);
    expect(group().stopSequences).toBeUndefined();
  });

  it('refuses a speaker who is not on the roster', () => {
    expect(() => group({ speaker: 3 })).toThrow(RangeError);
  });
});

describe('assemblePrompt - lines the reader wrote as someone', () => {
  const turnsOf = (content: string, speaker?: number): string[] =>
    assemblePrompt({
      plot,
      characters: [{ ...seiya, id: 'seiya-id' }, { ...kai, id: 'kai-id' }],
      history: [{ role: 'user', content }],
      userName: '민준',
      contextBudget: 100_000,
      ...(speaker === undefined ? {} : { speaker }),
    }).messages.map((message) => promptText(message.content));

  it("sends a @name: line as that member's, under the roster name, and a @내레이터: line as narration", () => {
    const content = '*잔을 든다* 건배.\n@세이: 마시지 마.\n\n@카이: 한 잔 더!\n@내레이터: 바람이 분다.\n@: 눈이 그친다.\n@유령: 누구?';
    const expected = `*잔을 든다* 건배.\n세이야: 마시지 마.\n\n카이: 한 잔 더!\n${NARRATION_HEADER} 바람이 분다.\n${NARRATION_HEADER} 눈이 그친다.\n@유령: 누구?`;
    expect(turnsOf(content)).toContain(expected);
    // A group turn reads the reader's lines the same way, the speaker's own included.
    expect(turnsOf(content, 1)).toContain(expected);
  });

  it('sends a whole-turn @: and a turn without markers exactly as before', () => {
    expect(turnsOf('@: 문이 열린다.\n@세이: 응')).toContain(`${NARRATION_HEADER} 문이 열린다.\n@세이: 응`);
    expect(turnsOf('세이야: 안녕.\n@ 카이 왔어?')).toContain('세이야: 안녕.\n@ 카이 왔어?');
  });
});
