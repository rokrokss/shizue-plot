import { describe, expect, it } from 'vitest';
import { withNarrationPrefix } from '../src/narration.js';
import {
  DEFAULT_PRESET,
  getPreset,
  isPresetId,
  PRESET_IDS,
  PRESETS,
  RISU_DEFAULT_FORMATING_ORDER,
  SPEECH_PROTOCOL_REMINDER,
  speechProtocol,
  type PromptPreset,
} from '../src/presets.js';
import { loreEntryKey } from '../src/lorebook.js';
import { OAI2_MAIN, OAI2_RESPONSE, OAI_JAILBREAK } from '../src/oai2.js';
import {
  assemblePrompt,
  AUTHOR_NOTE_DEPTH,
  constantLoreTokens,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_USER_NAME,
  IMAGE_TOKEN_ESTIMATE,
  LORE_BUDGET_SHARE,
  NARRATION_HEADER,
  NARRATION_NOTE,
  NARRATOR_POV_LABELS,
  NEW_CHAT_SEPARATOR,
  promptText,
  scenarioLine,
  STYLE_DIRECTIVES_HEADER,
  styleDirectives,
  withBranchGreeting,
  type HistoryMessage,
  type PromptCharacter,
  type PromptPart,
  type PromptPlot,
} from '../src/prompt.js';
import { rewriteTavernLore, withTavernLore } from '../src/tavernLore.js';
import { countTokens } from '../src/tokens.js';
import {
  DEFAULT_LORE_SETTINGS,
  NARRATOR_POVS,
  type LoreEntry,
  type NormalizedCard,
  type PlotStyle,
} from '../src/types.js';

/**
 * RisuAI's preset without a template, in its default order: the main prompt
 * ahead of the description and the chat, the global note behind the newest
 * turn — so a test reads 'MAIN' first and 'POST' after the chat.
 */
const legacyPreset = (mainPrompt: string, globalNote: string, extra: Partial<PromptPreset> = {}): PromptPreset => ({
  mainPrompt,
  jailbreak: '',
  globalNote,
  formatingOrder: RISU_DEFAULT_FORMATING_ORDER,
  promptTemplate: null,
  groupTemplate: '',
  groupOtherBotRole: 'user',
  ...extra,
});
const preset = legacyPreset('MAIN', 'POST');
/** An example block as it is sent: RisuAI's `NewChatExample` separator, then the block. */
const exampleBlock = (block: string): string => `${NEW_CHAT_SEPARATOR}\n${block}`;

const card: NormalizedCard = {
  spec: 'v3',
  name: '아리아',
  description: '서리 골짜기의 마녀.',
  personality: '무뚝뚝하다.',
  // Kept on the fixture on purpose: the first member's scenario became the
  // work's at import, so the assembler never reads it for her, while any later
  // member brings it as their own circumstances (`ownScenario`).
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

/** Aria's description, RisuAI's: her card, her personality, and the work's setting as the circumstances. */
const DESCRIPTION = `서리 골짜기의 마녀.\n\nDescription of 아리아: 무뚝뚝하다.\n\n${scenarioLine(plot.description)}`;
/** The speech protocol a work of one member is taught, and its reminder after the chat. */
const PROTOCOL = speechProtocol(['아리아']);
const REMINDER = SPEECH_PROTOCOL_REMINDER;
/** What closes the system string of a one-member, non-utility prompt. */
const CLOSING = [PROTOCOL, NARRATION_NOTE];
/** Aria's two example blocks as they are sent. */
const EXAMPLES = [
  exampleBlock('민준: 예시 질문 하나\n아리아: 예시 답변 하나'),
  exampleBlock('민준: 예시 질문 둘\n아리아: 예시 답변 둘'),
];
/** What follows the newest turn on `preset` when nothing else comes: the global note, then the reminder. */
const TAIL = ['POST', REMINDER];
/** The texts a prompt sends as one kind of block, in order. */
const sentAs = (prompt: ReturnType<typeof assemblePrompt>, kind: string): string[] =>
  prompt.messages.flatMap((message, at) => (prompt.sources![at]!.kind === kind ? [promptText(message.content)] : []));

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
  it("builds the system prefix as RisuAI's: the main prompt and the description, closed by the protocol and the narration note", () => {
    const { system, systemSections, risu } = assemble(100_000);
    expect(system).toBe(['MAIN', DESCRIPTION, ...CLOSING].join('\n\n'));
    expect(systemSections!.map((section) => section.kind)).toEqual(['main', 'description', 'speech_protocol', 'narration_note']);
    expect(risu).toEqual({ system: [{ text: system }] });
    // The first member's own scenario is the work's now, and not read again.
    expect(system).not.toContain('눈보라 치는 밤');
  });

  it("falls back to the built-in preset, PocketRisu's OAI2 template, which reads no card's system prompt", () => {
    const { system, messages, risu } = assemblePrompt({ plot, characters: [aria], history });
    expect(system.startsWith(OAI2_MAIN.replaceAll('{{user}}', DEFAULT_USER_NAME))).toBe(true);
    expect(system).toContain(`[Roleplay Setting]\n${DESCRIPTION}\n`);
    expect(system).toContain(OAI2_RESPONSE);
    expect(system.endsWith(CLOSING.join('\n\n'))).toBe(true);
    // The reminder after the chat, then the OAI preset's jailbreak after everything; the
    // prefill item asks for a model that takes one, and this request names none.
    expect(messages.slice(-2)).toEqual([
      { role: 'system', content: REMINDER },
      { role: 'system', content: OAI_JAILBREAK },
    ]);
    expect(risu!.template).toBe(true);
    // RisuAI reads no card's system prompt under a template.
    const own = assemblePrompt({ plot, characters: [{ ...aria, card: { ...card, systemPrompt: '카드의 규칙.' } }], history });
    expect(own.system).toBe(system);
  });

  it('writes one description per roster member, in the order it was given, and the setting once after them', () => {
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
      [
        'MAIN',
        '[아리아]\n\n서리 골짜기의 마녀.\n\nDescription of 아리아: 무뚝뚝하다.',
        // A member after the first brings their card's scenario as their own circumstances.
        `[민수]\n\n여관 주인.\n\n${scenarioLine('눈보라 치는 밤.')}`,
        scenarioLine(plot.description),
        speechProtocol(['아리아', '민수']),
        NARRATION_NOTE,
      ].join('\n\n'),
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
    expect(system).toBe(['MAIN', scenarioLine(plot.description), speechProtocol([]), NARRATION_NOTE].join('\n\n'));
    expect(messages.map((message) => message.content)).toEqual([
      NEW_CHAT_SEPARATOR,
      ...history.map((message) => message.content),
      ...TAIL,
    ]);
  });

  it('resolves {{char}} to the member for card text and to the plot everywhere else', () => {
    const prompt = assemblePrompt({
      plot: { ...plot, description: '{{char}}의 겨울.' },
      characters: [{ name: '아리아', card: { ...card, description: '{{char}}는 마녀다.', mesExample: '' } }],
      history,
      preset: legacyPreset('{{char}} 담당 작가.', '{{char}} 유지.'),
      userName: '민준',
      memoryText: '{{char}}의 지난 이야기.',
    });
    expect(prompt.system).toBe(
      [
        '서리 골짜기의 밤 담당 작가.',
        `아리아는 마녀다.\n\nDescription of 아리아: 무뚝뚝하다.\n\n${scenarioLine('서리 골짜기의 밤의 겨울.')}`,
        ...CLOSING,
      ].join('\n\n'),
    );
    expect(prompt.messages[0]).toEqual({ role: 'system', content: '서리 골짜기의 밤의 지난 이야기.' });
    expect(sentAs(prompt, 'global_note')).toEqual(['서리 골짜기의 밤 유지.']);
  });

  it('reads a member its scripts renamed, and the greeting they rewrote, as this chat has them', () => {
    // A plot of one member renamed by its scripts: the caller gives the member its new
    // name and the plot its `{{char}}`.
    const renamed: PromptCharacter = { name: '세라', card: { ...card, description: '{{char}}는 마녀다.', mesExample: '' } };
    const opening = { text: '{{char}}가 문을 연다.', index: -1 };
    const { system, messages } = assemblePrompt({
      plot: { ...plot, char: '세라', description: '{{char}}의 겨울.' },
      characters: [renamed],
      history,
      branch: { length: history.length, greeting: opening },
      preset: legacyPreset('{{char}} 담당 작가.', 'POST'),
      userName: '민준',
    });
    expect(system).toContain('세라 담당 작가.');
    expect(system).toContain(`세라는 마녀다.\n\nDescription of 세라: 무뚝뚝하다.\n\n${scenarioLine('세라의 겨울.')}`);
    expect(system).toContain(speechProtocol(['세라']));
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

  it("puts the positioned lore around the description, the persona after it, and other always-on lore in RisuAI's lorebook slot", () => {
    const prompt = assemblePrompt({
      plot: {
        ...plot,
        lorebook: [
          // The card's own `@@position` placed these.
          loreEntry({ content: 'BEFORE', positioned: true, insertionOrder: 0 }),
          loreEntry({ content: 'AFTER', position: 'after_char', positioned: true, insertionOrder: 1 }),
          loreEntry({ content: 'SLOT', insertionOrder: 2 }),
        ],
      },
      characters: [aria],
      history,
      preset,
      userName: '민준',
      personaText: '대학생.',
    });
    // RisuAI sends the persona as it is, under no head of its own.
    expect(prompt.system).toBe(['MAIN', 'BEFORE', DESCRIPTION, 'AFTER', '대학생.', ...CLOSING].join('\n\n'));
    expect(prompt.systemSections!.map((section) => section.kind)).toEqual([
      'main',
      'lore_before',
      'description',
      'lore_after',
      'persona',
      'speech_protocol',
      'narration_note',
    ]);
    // The lorebook slot follows the newest turn on RisuAI's order without a template.
    expect(prompt.messages.slice(-4).map((message) => message.content)).toEqual([history[3]!.content, 'SLOT', ...TAIL]);
    expect(sentAs(prompt, 'lorebook')).toEqual(['SLOT']);
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

  it("answers {{moduleenabled}} and {{moduleassetlist}} from the work's modules", () => {
    const description = '{{moduleenabled::weather}}{{moduleenabled::none}} {{moduleassetlist::weather}}|{{moduleassetlist::none}}|';
    const { system } = assemblePrompt({
      plot: { ...plot, description, cbsModules: [{ namespace: 'weather', assets: ['rain', '비.png'] }] },
      characters: [aria],
      history,
      preset,
    });
    expect(system).toContain('10 ["rain","비.png"]||');
    // A work with no module answers as RisuAI does with none; a caller that says nothing leaves them.
    expect(assemblePrompt({ plot: { ...plot, description, cbsModules: [] }, characters: [aria], history, preset }).system).toContain('00 ||');
    expect(assemblePrompt({ plot: { ...plot, description }, characters: [aria], history, preset }).system).toContain(
      '{{moduleenabled::weather}}',
    );
  });

  it("sends memoryText at the head of the chat, where RisuAI's HypaV3 puts its summary, with macros expanded", () => {
    const memoryText = '[Summary of the story so far]\n{{user}}와(과) {{char}}는 이미 만난 적이 있다.';
    const memory = '[Summary of the story so far]\n민준와(과) 서리 골짜기의 밤는 이미 만난 적이 있다.';
    const prompt = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      personaText: '대학생.',
      memoryText,
    });
    // Not in the system string: RisuAI's order without a template has no memory item.
    expect(prompt.system).toBe(['MAIN', DESCRIPTION, '대학생.', ...CLOSING].join('\n\n'));
    expect(prompt.messages[0]).toEqual({ role: 'system', content: memory });
    expect(prompt.sources![0]).toEqual({ kind: 'memory' });
    expect(prompt.messages.slice(1, 3).map((message) => message.content)).toEqual(EXAMPLES);
    // A template's memory item holds it among the system turns, a turn of its own for RisuAI.
    const templated = assemblePrompt({ plot, characters: [aria], history, userName: '민준', memoryText });
    expect(templated.risu!.system.map((part) => part.memo)).toEqual([undefined, 'supaMemory', undefined]);
    expect(templated.risu!.system[1]!.text).toBe(`[Roleplay Summary]\n${memory}\n`);
    expect(templated.messages.map((message) => message.content)).not.toContain(memory);
  });

  it('leaves the system prefix and the chat untouched when there is no memory', () => {
    const withBlank = assemblePrompt({
      plot,
      characters: [aria],
      history,
      preset,
      userName: '민준',
      memoryText: '  ',
    });
    expect(withBlank.system).toBe(assemble(100_000).system);
    expect(withBlank.messages).toEqual(assemble(100_000).messages);
  });

  describe('the recall turn', () => {
    const recalled = {
      factsText: '[Memory]\n- (약 20턴 전) {{user}}는 등대 열쇠를 갖고 있다.',
      retrievalText: 'Past events:\n{{user}}: 등대에 가자',
    };
    const RECALL = '[Memory]\n- (약 20턴 전) 민준는 등대 열쇠를 갖고 있다.\n\nPast events:\n민준: 등대에 가자';
    const turns = history.map((turn, at) => ({ ...turn, id: `m${at}` }));
    const recall = (input: Partial<Parameters<typeof assemblePrompt>[0]> = {}) =>
      assemblePrompt({ plot, characters: [aria], history: turns, preset, userName: '민준', report: true, ...recalled, ...input });
    /** The request up to its last turn of the conversation: what the system turns after it close. */
    const conversation = (prompt: ReturnType<typeof assemblePrompt>) =>
      prompt.messages.slice(0, prompt.messages.findLastIndex((message) => message.role !== 'system') + 1);

    it('sends the facts and the messages a search brought back as one system turn in what follows the chat', () => {
      const memoryText = '[Summary of the story so far]\n요약.';
      const { system, messages, sources, report } = recall({ memoryText });
      // None of it is in the system string, and neither is the memory, which heads the chat.
      expect(system).toBe(assemble(100_000).system);
      // Everything before it is what a turn recalling nothing sends.
      const plain = assemblePrompt({ plot, characters: [aria], history: turns, preset, userName: '민준', memoryText });
      expect(messages.slice(0, -1)).toEqual(plain.messages);
      expect(messages.slice(-4)).toEqual([
        { role: 'user', content: history[3]!.content },
        { role: 'system', content: 'POST' },
        { role: 'system', content: REMINDER },
        { role: 'system', content: RECALL },
      ]);
      expect(sources!.at(-1)).toEqual({ kind: 'recall' });
      // The inspector shows it where it is sent.
      expect(report!.blocks.slice(-4).map((block) => block.kind)).toEqual(['history', 'global_note', 'speech_protocol', 'recall']);
      expect(report!.blocks.at(-1)!.text).toBe(RECALL);
    });

    it('keeps the order facts, retrieval, and leaves out what is blank', () => {
      const only = (input: Partial<typeof recalled>) =>
        recall({ factsText: '', retrievalText: '', ...input }).messages.at(-1)!.content;
      expect(only({ retrievalText: recalled.retrievalText })).toBe('Past events:\n민준: 등대에 가자');
      expect(only({ factsText: recalled.factsText })).toBe('[Memory]\n- (약 20턴 전) 민준는 등대 열쇠를 갖고 있다.');
      const none = recall({ factsText: ' ', retrievalText: '  ' });
      expect(none.messages).toEqual(assemblePrompt({ plot, characters: [aria], history: turns, preset, userName: '민준' }).messages);
    });

    it('opens with the summaries the query and the draw picked, which are memory and not fixed tokens', () => {
      const picked = '[Summary of the story so far: recalled this turn]\n(약 40턴 전) {{user}}는 등대에 올랐다.';
      const { system, messages } = recall({ memoryText: '[Summary of the story so far]\n요약.', recalledMemoryText: picked });
      // The summaries that change only when one lands head the chat; what this turn picked goes with the recall turn.
      expect(system).toBe(assemble(100_000).system);
      expect(messages[0]).toEqual({ role: 'system', content: '[Summary of the story so far]\n요약.' });
      expect(messages.at(-1)).toEqual({
        role: 'system',
        content: `[Summary of the story so far: recalled this turn]\n(약 40턴 전) 민준는 등대에 올랐다.\n\n${RECALL}`,
      });
      const without = recall({ contextBudget: 100_000, maxResponseTokens: 0, report: false });
      const withIt = recall({ recalledMemoryText: picked, contextBudget: 100_000, maxResponseTokens: 0, report: false });
      // Only the blank line it is joined to the rest by is left in.
      const sent = '[Summary of the story so far: recalled this turn]\n(약 40턴 전) 민준는 등대에 올랐다.';
      expect(withIt.fixedTokens! - without.fixedTokens!).toBe(countTokens(`${sent}\n\n${RECALL}`) - countTokens(RECALL) - countTokens(sent));
      expect(recall({ factsText: '', retrievalText: '', recalledMemoryText: picked }).messages.at(-1)!.content).toBe(
        '[Summary of the story so far: recalled this turn]\n(약 40턴 전) 민준는 등대에 올랐다.',
      );
    });

    it('lets the next turn repeat this request up to the system turns that close it', () => {
      // The provider serves a request from an earlier one only when it repeats
      // that whole request but its last message (ARCHITECTURE §7.3), and the
      // ChatGPT adapter sends the system turns after the newest turn as one.
      const next = [...turns, { role: 'assistant' as const, content: '다섯 번째 답장.', id: 'm4' }, { role: 'user' as const, content: '여섯 번째.', id: 'm5' }];
      const first = recall({ directions: '판정 하나.' });
      const second = recall({ history: next, factsText: '[Memory]\n- 다른 사실.', directions: '판정 둘.' });
      expect(second.system).toBe(first.system);
      expect(conversation(second).slice(0, conversation(first).length)).toEqual(conversation(first));
      expect(second.messages.slice(conversation(first).length).map((message) => message.content)).toEqual([
        '다섯 번째 답장.',
        '여섯 번째.',
        ...TAIL,
        '[Game ruling]\n판정 둘.',
        '[Memory]\n- 다른 사실.\n\nPast events:\n민준: 등대에 가자',
      ]);
    });

    it('follows the newest turn sent: a reply a group round already has, or the turn before a hidden one', () => {
      const round = [...turns, { role: 'assistant' as const, content: '다섯 번째, 첫 화자의 답장.', id: 'm4' }];
      expect(recall({ history: round }).messages.slice(-4).map((message) => message.content)).toEqual([
        '다섯 번째, 첫 화자의 답장.',
        ...TAIL,
        RECALL,
      ]);
      // A turn hidden from the AI is not sent, so neither does the recall turn follow it.
      const hidden = round.map((turn) => (turn.id === 'm4' ? { ...turn, hidden: true } : turn));
      expect(recall({ history: hidden }).messages.slice(-4).map((message) => message.content)).toEqual([
        history[3]!.content,
        ...TAIL,
        RECALL,
      ]);
    });

    it('leaves the depth lore, the note and the start injection before the newest turn, and goes ahead of the depth-0 lore after it', () => {
      const lore = (content: string, depth: number): LoreEntry => ({
        keys: [],
        secondaryKeys: [],
        selective: false,
        content,
        enabled: true,
        constant: true,
        insertionOrder: depth,
        caseSensitive: false,
        useRegex: false,
        position: 'before_char',
        depth,
      });
      const { messages } = recall({
        plot: { ...plot, lorebook: [lore('깊이 하나의 로어.', 1), lore('깊이 영의 로어.', 0)] },
        authorNote: '유저노트.',
        authorNoteSettings: { depth: 1, frequency: 1, role: 'system' },
        injections: { start: '시작 주입.' },
        directions: '판정.',
      });
      expect(messages.slice(-9).map((message) => message.content)).toEqual([
        '깊이 하나의 로어.',
        '유저노트.',
        '시작 주입.',
        history[3]!.content,
        ...TAIL,
        '[Game ruling]\n판정.',
        RECALL,
        '깊이 영의 로어.',
      ]);
    });

    it('is charged up front and never evicted, and counts in the fixed tokens facts and all', () => {
      const bare = assemblePrompt({ plot, characters: [aria], history: turns, preset, userName: '민준', contextBudget: 100_000, maxResponseTokens: 0 });
      const full = recall({ contextBudget: 100_000, maxResponseTokens: 0, report: false });
      // The facts come on top of the summaries' share, so the summarizer has to see them.
      expect(full.fixedTokens! - bare.fixedTokens!).toBe(countTokens(RECALL));
      // A budget that holds nothing but the newest turn still holds the recall turn.
      const tight = recall({ contextBudget: bare.fixedTokens! + countTokens(RECALL) + countTokens(history[3]!.content), maxResponseTokens: 0 });
      expect(tight.messages.map((message) => message.content)).toEqual([history[3]!.content, ...TAIL, RECALL]);
    });

    it('still closes what follows the chat when none of the history is sent', () => {
      const { messages } = recall({ history: [] });
      expect(messages.slice(-3).map((message) => message.content)).toEqual([...TAIL, RECALL]);
    });
  });

  it('charges memoryText to the same budget as the rest of what is never evicted', () => {
    const memoryText = '[Summary of the story so far]\n'.padEnd(400, '요약 ');
    const base = assemble(100_000);
    const budget = base.fixedTokens! + countTokens(history[2]!.content) + countTokens(history[3]!.content);
    // Without memory that budget holds the last two turns (see the eviction test).
    expect(assemble(budget).messages.map((m) => m.content)).toEqual([
      history[2]!.content,
      history[3]!.content,
      ...TAIL,
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
    expect(tight.messages.map((m) => m.content)).toEqual([memoryText.trim(), history[3]!.content, ...TAIL]);
  });

  it("reads the first member card's system prompt and post-history instructions in place of the preset's, via {{original}}", () => {
    const prompt = assemblePrompt({
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
    expect(prompt.system.startsWith('MAIN\n\n추가 규칙.')).toBe(true);
    expect(prompt.system).not.toContain('무시된다.');
    expect(sentAs(prompt, 'global_note')).toEqual(['POST 리마인더.']);
  });

  it("keeps the speech protocol under a card's own instructions, once", () => {
    const assembled = (systemPrompt: string, postHistoryInstructions: string) =>
      assemblePrompt({
        plot,
        characters: [{ name: '아리아', card: { ...card, systemPrompt, postHistoryInstructions } }],
        history,
        preset,
      });
    // A RisuAI card's instructions know nothing of the `이름: ` lines a reply is read by.
    const own = assembled('카드의 규칙.', '카드의 리마인더.');
    expect(own.system).toBe(['카드의 규칙.', DESCRIPTION, ...CLOSING].join('\n\n'));
    expect(own.messages.slice(-2)).toEqual([
      { role: 'system', content: '카드의 리마인더.' },
      { role: 'system', content: REMINDER },
    ]);
    // One that brings the preset back through {{original}} has it once all the same.
    const kept = assembled('{{original}}\n\n추가.', '');
    expect(kept.system.startsWith('MAIN\n\n추가.')).toBe(true);
    expect(kept.system.split(PROTOCOL)).toHaveLength(2);
  });

  it('drops example dialogue first, then the oldest history', () => {
    const full = assemble(100_000);
    const fixed = full.fixedTokens!;
    const historyTokens = history.map((message) => countTokens(message.content));
    const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

    // Everything fits: two example blocks, RisuAI's separator, the whole history,
    // then the global note and the reminder.
    expect(full.messages.map((m) => m.role)).toEqual([
      'system',
      'system',
      'system',
      'assistant',
      'user',
      'assistant',
      'user',
      'system',
      'system',
    ]);
    expect(full.messages.slice(0, 3).map((m) => m.content)).toEqual([...EXAMPLES, NEW_CHAT_SEPARATOR]);

    // Room for the full history and the separator: the examples are evicted.
    const withSeparator = assemble(fixed + sum(historyTokens) + countTokens(NEW_CHAT_SEPARATOR));
    expect(withSeparator.messages.map((m) => m.content)).toEqual([
      NEW_CHAT_SEPARATOR,
      ...history.map((m) => m.content),
      ...TAIL,
    ]);

    // Exactly enough for the full history: the separator goes with them.
    const historyOnly = assemble(fixed + sum(historyTokens));
    expect(historyOnly.messages.map((m) => m.content)).toEqual([
      ...history.map((m) => m.content),
      ...TAIL,
    ]);

    // Only the last two history messages fit: the oldest are evicted next.
    const tail = assemble(fixed + sum(historyTokens.slice(-2)));
    expect(tail.messages.map((m) => m.content)).toEqual([
      history[2]!.content,
      history[3]!.content,
      ...TAIL,
    ]);
  });

  it('names the member each example block belongs to, roster order first', () => {
    const { messages, sources, report } = assemblePrompt({
      plot,
      characters: [
        { name: '아리아', card: { ...card, mesExample: '<START>\n{{char}}: 아리아의 예시' } },
        { name: '민수', card: { ...card, mesExample: '<START>\n{{char}}: 민수의 예시' } },
      ],
      history,
      preset,
      userName: '민준',
      report: true,
    });
    expect(messages.slice(0, 2).map((m) => m.content)).toEqual([
      exampleBlock('아리아: 아리아의 예시'),
      exampleBlock('민수: 민수의 예시'),
    ]);
    // The inspector says whose each is, and the request editors whose lines it holds.
    expect(report!.blocks.filter((block) => block.kind === 'examples').map((block) => block.label)).toEqual(['아리아', '민수']);
    expect(sources!.slice(0, 2).map((source) => source.speakers)).toEqual([
      { user: '민준', char: ['아리아', '아리아'] },
      { user: '민준', char: ['민수', '민수'] },
    ]);
  });

  it('always keeps the newest message even when the budget is exhausted', () => {
    const tiny = assemble(1);
    expect(tiny.messages.map((m) => m.content)).toEqual([history[3]!.content, ...TAIL]);
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

/** What the moved lore says — the keyword lore, after the newest turn — or '' when there is none. */
const movedLoreOf = (prompt: ReturnType<typeof assemblePrompt>): string => {
  const at = prompt.sources?.findIndex((source) => source.kind === 'moved_lore') ?? -1;
  return at < 0 ? '' : promptText(prompt.messages[at]!.content);
};

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
    const prompt = assemblePrompt({
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
    expect(sentAs(prompt, 'lorebook')).toEqual(['MINSU', 'PLOT', 'ARIA']);
  });

  it('resolves {{char}} in each book against whoever the book belongs to', () => {
    const prompt = assemblePrompt({
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
    expect(sentAs(prompt, 'lorebook')).toEqual(['서리 골짜기의 밤 세계.', '아리아 기억.']);
  });

  it('takes the scan depth and the lore budget from the first member', () => {
    const budgeted = (loreSettings: NormalizedCard['loreSettings']) =>
      sentAs(
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
        }),
        'lorebook',
      );
    expect(budgeted({ ...DEFAULT_LORE_SETTINGS })).toEqual(['첫 번째 항목.', '두 번째 항목.']);
    // Room for one: the entry ranked higher (insertionOrder 1) takes it.
    expect(budgeted({ ...DEFAULT_LORE_SETTINGS, tokenBudget: countTokens('두 번째 항목.') })).toEqual(['두 번째 항목.']);
  });

  it('gives a card that names no budget its share of the context budget', () => {
    const first = '첫 번째 항목.';
    const second = '두 번째 항목.';
    const automatic = (contextBudget: number) =>
      sentAs(
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
        }),
        'lorebook',
      );
    // Room for exactly the higher-ranked entry: the budget is the share, rounded down.
    const tight = Math.ceil(countTokens(second) / LORE_BUDGET_SHARE);
    expect(Math.floor(tight * LORE_BUDGET_SHARE)).toBe(countTokens(second));
    expect(automatic(tight)).toEqual([second]);
    const roomy = Math.ceil((countTokens(first) + countTokens(second)) / LORE_BUDGET_SHARE);
    expect(automatic(roomy)).toEqual([first, second]);
  });

  it("gives a RisuAI book that names no budget half the context, and a SillyTavern one ST's quarter", () => {
    const words = '단어 '.repeat(40).trim();
    const lorebook = ['A', 'B', 'C', 'D', 'E', 'F'].map((letter, index) =>
      loreEntry({ content: `${letter} ${words}`, insertionOrder: 6 - index }),
    );
    const cost = countTokens(`A ${words}`);
    expect(lorebook.every((entry) => countTokens(entry.content) === cost)).toBe(true);
    const activated = (loreSettings: NormalizedCard['loreSettings'], sillyTavern = false): string[] =>
      assemblePrompt({
        plot,
        characters: [
          { name: '아리아', card: { ...bareCard, lorebook, loreSettings }, ...(sillyTavern ? { sillyTavern } : {}) },
        ],
        history,
        preset,
        userName: '민준',
        // Half is room for five and a half entries; ST's quarter, for two and three quarters.
        contextBudget: 11 * cost,
        maxResponseTokens: 0,
        report: true,
      }).report!.lore.map((entry) => entry.preview.slice(0, 1));
    const risu = { ...DEFAULT_LORE_SETTINGS, risuMatching: true };
    expect(activated(risu)).toEqual(['E', 'D', 'C', 'B', 'A']);
    // A book with no source app, the studio's, takes the same half.
    expect(activated({ ...DEFAULT_LORE_SETTINGS })).toEqual(['E', 'D', 'C', 'B', 'A']);
    expect(activated({ ...DEFAULT_LORE_SETTINGS }, true)).toEqual(['B', 'A']);
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
    expect(system).not.toContain('숨은 설정');
    expect(system).not.toContain('\n\n\n\n');
    // Neither an empty lorebook message nor an empty depth message is left behind.
    expect(messages.map((message) => message.content)).toEqual([
      NEW_CHAT_SEPARATOR,
      ...history.map((turn) => turn.content),
      later,
      ...TAIL,
    ]);
  });
});

describe('assemblePrompt - the moved lore', () => {
  // Every turn of `history` says 유저 발화 or 캐릭터 발화.
  const keyed = (content: string, overrides: Partial<LoreEntry> = {}): LoreEntry =>
    loreEntry({ content, constant: false, keys: ['유저 발화'], ...overrides });
  const turns = history.map((turn, at) => ({ ...turn, id: `m${at}` }));
  const assembleLore = (lorebook: LoreEntry[], input: Partial<Parameters<typeof assemblePrompt>[0]> = {}) =>
    assemblePrompt({
      plot,
      characters: [{ name: '아리아', card: { ...bareCard, lorebook } }],
      history: turns,
      preset,
      userName: '민준',
      contextBudget: 100_000,
      maxResponseTokens: 0,
      report: true,
      ...input,
    });
  const texts = (prompt: ReturnType<typeof assemblePrompt>): string[] =>
    prompt.messages.map((message) => promptText(message.content));
  const section = (prompt: ReturnType<typeof assemblePrompt>, kind: string): string | undefined =>
    prompt.systemSections!.find((part) => part.kind === kind)?.text;

  it('takes the keyword lore at the default places out of the system string, and leaves every other entry where it was', () => {
    const prompt = assembleLore(
      [
        loreEntry({ content: 'ALWAYS BEFORE', insertionOrder: 1 }),
        loreEntry({ content: 'ALWAYS AFTER', position: 'after_char', insertionOrder: 2 }),
        keyed('KEY BEFORE', { insertionOrder: 3 }),
        keyed('KEY AFTER', { position: 'after_char', insertionOrder: 4 }),
        // The card's own `@@position` placed it: it stays.
        keyed('KEY PLACED', { positioned: true, insertionOrder: 5 }),
        keyed('KEY DEEP', { depth: 1, insertionOrder: 6 }),
        keyed('KEY NOTE', { position: 'after_author_note', insertionOrder: 7 }),
        keyed('KEY EXAMPLE', { position: 'before_examples', insertionOrder: 8 }),
        keyed('KEY OUTLET', { position: 'outlet', outletName: 'o', insertionOrder: 9 }),
        // SillyTavern's ↑Char and ↓Char are its default places too.
        keyed('ST BEFORE', { sillyTavern: true, insertionOrder: 10 }),
        keyed('ST AFTER', { sillyTavern: true, position: 'after_char', insertionOrder: 11 }),
      ],
      { plot: { ...plot, description: `${plot.description} {{outlet::o}}` }, authorNote: '유저노트.' },
    );
    // The positioned entry stays before the description, the always-on ones in the lorebook slot.
    expect(section(prompt, 'lore_before')).toBe('KEY PLACED');
    expect(sentAs(prompt, 'lorebook')).toEqual(['ALWAYS BEFORE', 'ALWAYS AFTER']);
    expect(prompt.system).toContain(`${plot.description} KEY OUTLET`);
    for (const moved of ['KEY BEFORE', 'KEY AFTER', 'ST BEFORE', 'ST AFTER']) expect(prompt.system).not.toContain(moved);
    expect(movedLoreOf(prompt)).toBe('KEY BEFORE\n\nST BEFORE\n\nKEY AFTER\n\nST AFTER');
    const sent = texts(prompt);
    expect(sent).toContain('KEY DEEP');
    expect(sent).toContain('유저노트.\nKEY NOTE');
    expect(sent.some((text) => text.endsWith('KEY EXAMPLE'))).toBe(true);
    // Each entry says where its creator put it; the block it went into says where it was sent.
    expect(prompt.report!.lore.find((entry) => entry.preview === 'KEY BEFORE')).toMatchObject({ placement: 'before_char', via: 'keyword' });
  });

  it('moves what a recursive scan or a sticky window brought in, but never an always-on entry', () => {
    const held = keyed('HELD', { keys: ['없는 말'], sticky: 5, insertionOrder: 3 });
    // An always-on entry with a window of its own is still always on.
    const alwaysHeld = loreEntry({ content: 'ALWAYS HELD', sticky: 5, insertionOrder: 4 });
    const lorebook = [
      loreEntry({ content: 'ALWAYS: 등대', insertionOrder: 1 }),
      keyed('RECURSED', { keys: ['등대'], insertionOrder: 2 }),
      held,
      alwaysHeld,
    ];
    const prompt = assembleLore([], {
      characters: [
        { name: '아리아', card: { ...bareCard, lorebook, loreSettings: { ...DEFAULT_LORE_SETTINGS, recursiveScanning: true } } },
      ],
      loreState: { chatLength: 4, lastTriggered: { [loreEntryKey(held)]: 2, [loreEntryKey(alwaysHeld)]: 2 } },
    });
    expect(prompt.report!.lore.map((entry) => entry.via)).toEqual(['constant', 'recursion', 'sticky', expect.any(String)]);
    expect(sentAs(prompt, 'lorebook')).toEqual(['ALWAYS: 등대', 'ALWAYS HELD']);
    expect(movedLoreOf(prompt)).toBe('RECURSED\n\nHELD');
    // With no turn to follow, it still goes in the lorebook slot, after the always-on entries.
    const bare = assembleLore([], {
      characters: [
        { name: '아리아', card: { ...bareCard, lorebook, loreSettings: { ...DEFAULT_LORE_SETTINGS, recursiveScanning: true } } },
      ],
      history: [],
    });
    expect(texts(bare)).toEqual([NEW_CHAT_SEPARATOR, 'ALWAYS: 등대', 'ALWAYS HELD', 'RECURSED', ...TAIL]);
  });

  it('sends the moved entries as the lorebook slot sends them always on, macros and order and all', () => {
    const book = [
      keyed('B2 {{char}}', { insertionOrder: 5 }),
      keyed('A1', { position: 'after_char', insertionOrder: 1 }),
      keyed('B1 {{user}}', { insertionOrder: 2 }),
      keyed('A2', { position: 'after_char', insertionOrder: 9 }),
      keyed('{{#if {{getvar::flag}}}}EMPTY{{/if}}', { insertionOrder: 3 }),
    ];
    const moved = assembleLore(book, { variables: { flag: '0' } });
    // The same entries always on: a turn each in the lorebook slot.
    const kept = assembleLore(
      book.map((entry) => ({ ...entry, constant: true })),
      { variables: { flag: '0' } },
    );
    expect(movedLoreOf(moved)).toBe(sentAs(kept, 'lorebook').join('\n\n'));
    expect(movedLoreOf(moved)).toBe('B1 민준\n\nB2 아리아\n\nA1\n\nA2');
    // What stays is the system string of a work with no such lore.
    expect(moved.system).toBe(assembleLore([]).system);
    expect(moved.systemSections).toEqual(assembleLore([]).systemSections);
    // Only after the cast, or only before it: no blank line left over.
    expect(movedLoreOf(assembleLore(book.filter((entry) => entry.position === 'after_char')))).toBe('A1\n\nA2');
    // Nothing keyed at all: no turn.
    expect(assembleLore([loreEntry({ content: 'ALWAYS' })]).sources!.some((source) => source.kind === 'moved_lore')).toBe(false);
  });

  it('goes in the lorebook slot after the newest turn: ahead of the global note, the directions, the recall turn and the depth-0 lore', () => {
    const prompt = assembleLore([keyed('KEY'), loreEntry({ content: 'DEPTH ZERO', depth: 0 }), keyed('KEY DEEP', { depth: 1 })], {
      directions: '판정.',
      factsText: '[Memory]\n- 사실.',
      injections: { start: '시작 주입.', historyend: '끝 주입.', promptend: '맨끝 주입.' },
    });
    expect(texts(prompt).slice(-11)).toEqual([
      'KEY DEEP',
      '시작 주입.',
      history[3]!.content,
      '끝 주입.',
      'KEY',
      ...TAIL,
      '[Game ruling]\n판정.',
      '[Memory]\n- 사실.',
      'DEPTH ZERO',
      '맨끝 주입.',
    ]);
    const kinds = prompt.sources!.map((source) => source.kind);
    expect(kinds.slice(-9)).toEqual([
      'history',
      'injection',
      'moved_lore',
      'global_note',
      'speech_protocol',
      'directions',
      'recall',
      'depth_lore',
      'injection',
    ]);
    // The inspector shows it where it is sent, as its own block.
    const blocks = prompt.report!.blocks;
    const at = blocks.findIndex((block) => block.kind === 'moved_lore');
    expect(blocks.slice(at - 1, at + 2).map((block) => block.kind)).toEqual(['injection', 'moved_lore', 'global_note']);
    expect(blocks[at]).toEqual({ kind: 'moved_lore', tokens: countTokens('KEY'), text: 'KEY' });
    // A reply already in the round, or a turn hidden from the AI: it follows the newest turn sent.
    const round = [...turns, { role: 'assistant' as const, content: '다섯 번째 캐릭터 발화.', id: 'm4' }];
    expect(texts(assembleLore([keyed('KEY')], { history: round })).slice(-4)).toEqual(['다섯 번째 캐릭터 발화.', 'KEY', ...TAIL]);
    const hidden = round.map((turn) => (turn.id === 'm4' ? { ...turn, hidden: true } : turn));
    expect(texts(assembleLore([keyed('KEY')], { history: hidden })).slice(-4)).toEqual([history[3]!.content, 'KEY', ...TAIL]);
    // Under a template whose lorebook item comes before the chat — the built-in one —
    // it goes with what follows the chat instead, never into the system string.
    const templated = assembleLore([keyed('KEY')], { preset: DEFAULT_PRESET, directions: '판정.' });
    const sent = texts(templated);
    expect(movedLoreOf(templated)).toBe('KEY');
    expect(sent.slice(sent.indexOf(history[3]!.content))).toEqual([
      history[3]!.content,
      REMINDER,
      'KEY',
      '[Game ruling]\n판정.',
      OAI_JAILBREAK,
    ]);
  });

  it('lets the next turn repeat this request up to the system turns that close it, though the keyword lore changed', () => {
    const lore = [keyed('등대 이야기', { keys: ['등대'] }), keyed('여관 이야기', { keys: ['여관'] })];
    const scanning = { ...bareCard, lorebook: lore, loreSettings: { ...DEFAULT_LORE_SETTINGS, scanDepth: 1 } };
    const at = (sent: HistoryMessage[]) => assembleLore([], { characters: [{ name: '아리아', card: scanning }], history: sent });
    const first = at([...turns.slice(0, 3), { role: 'user', content: '등대로 간다.', id: 'm3' }]);
    const second = at([
      ...turns.slice(0, 3),
      { role: 'user', content: '등대로 간다.', id: 'm3' },
      { role: 'assistant', content: '바다가 보인다.', id: 'm4' },
      { role: 'user', content: '이제 그곳으로 돌아간다.', id: 'm5' },
    ]);
    expect(movedLoreOf(first)).toBe('등대 이야기');
    expect(movedLoreOf(second)).toBe('');
    const third = at([...turns.slice(0, 3), { role: 'user', content: '여관에 묵는다.', id: 'm3' }]);
    expect(movedLoreOf(third)).toBe('여관 이야기');
    // The system string does not move with it, and the next request begins with all of this one but its closing turns.
    expect(second.system).toBe(first.system);
    expect(third.system).toBe(first.system);
    const conversation = (prompt: ReturnType<typeof assemblePrompt>) =>
      prompt.messages.slice(0, prompt.messages.findLastIndex((message) => message.role !== 'system') + 1);
    expect(conversation(second).slice(0, conversation(first).length)).toEqual(conversation(first));
  });

  it('is charged up front like the depth lore, never evicted, and counts in the fixed tokens', () => {
    const long = keyed(`KEY ${'설정 '.repeat(60)}`.trim());
    const bare = assembleLore([]);
    const prompt = assembleLore([long]);
    const moved = movedLoreOf(prompt);
    expect(prompt.fixedTokens! - bare.fixedTokens!).toBe(countTokens(moved));
    expect(prompt.report!.totals.used - bare.report!.totals.used).toBe(countTokens(moved));
    // A budget that holds nothing but the newest turn still holds it.
    const card = { ...bareCard, lorebook: [long], loreSettings: { ...DEFAULT_LORE_SETTINGS, tokenBudget: 10_000 } };
    const tight = assembleLore([], {
      characters: [{ name: '아리아', card }],
      contextBudget: bare.fixedTokens! + countTokens(moved) + countTokens(history[3]!.content),
    });
    expect(texts(tight)).toEqual([history[3]!.content, moved, ...TAIL]);
    // The lore budget still decides which entries get in, as it did: the higher insertionOrder first.
    const first = keyed('FIRST', { insertionOrder: 2 });
    const second = keyed('SECOND', { insertionOrder: 1 });
    const budgeted = { ...bareCard, lorebook: [second, first], loreSettings: { ...DEFAULT_LORE_SETTINGS, tokenBudget: countTokens('FIRST') } };
    expect(movedLoreOf(assembleLore([], { characters: [{ name: '아리아', card: budgeted }] }))).toBe('FIRST');
  });

  it('carries a SillyTavern entry marked for its WORLD_INFO scripts, which rewrite it where it went', async () => {
    const prompt = assembleLore([keyed('st key {{user}}', { sillyTavern: true })], { markTavernLore: true });
    expect(prompt.tavernLore).toEqual([{}]);
    const rewritten = await rewriteTavernLore(prompt, (segments) => Promise.resolve(segments.map((segment) => segment.text.toUpperCase())));
    expect(movedLoreOf(rewritten)).toBe('ST KEY 민준');
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
  it('splices depth entries into the history instead of the system block, depth 0 with what follows the chat', () => {
    const { system, messages } = withLore([
      loreEntry({ content: 'DEPTH0', depth: 0, insertionOrder: 1 }),
      loreEntry({ content: 'DEPTH2', depth: 2, role: 'assistant', insertionOrder: 2 }),
      loreEntry({ content: 'SYSTEM', insertionOrder: 3 }),
    ]);
    expect(system).not.toContain('DEPTH');
    expect(system).not.toContain('SYSTEM');
    expect(messages).toEqual([
      { role: 'system', content: NEW_CHAT_SEPARATOR },
      { role: 'assistant', content: history[0]!.content },
      { role: 'user', content: history[1]!.content },
      { role: 'assistant', content: 'DEPTH2' },
      { role: 'assistant', content: history[2]!.content },
      { role: 'user', content: history[3]!.content },
      // The always-on entry no position places: RisuAI's lorebook slot.
      { role: 'system', content: 'SYSTEM' },
      { role: 'system', content: 'POST' },
      { role: 'system', content: REMINDER },
      { role: 'system', content: 'DEPTH0' },
    ]);
  });

  it('clamps a depth beyond the history to its start and expands macros', () => {
    const { messages } = withLore([
      loreEntry({ content: '{{char}} 기억', depth: 99, role: 'user', insertionOrder: 1 }),
    ]);
    expect(messages.slice(0, 2)).toEqual([
      { role: 'system', content: NEW_CHAT_SEPARATOR },
      { role: 'user', content: '아리아 기억' },
    ]);
    expect(messages.slice(2).map((m) => m.content)).toEqual([
      ...history.map((m) => m.content),
      ...TAIL,
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
      NEW_CHAT_SEPARATOR,
      'CLAMP-A',
      'CLAMP-B',
      ...history.slice(0, 3).map((m) => m.content),
      'FIRST',
      'SECOND',
      history[3]!.content,
      ...TAIL,
    ]);
  });

  it('counts trailingTurns so a continue prefill does not shift the depths', () => {
    // The continue path assembles the history without its trailing partial and
    // re-attaches it after everything, so depth must be measured as if it were
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
    // With the partial re-attached the result reads h1, h2, DEPTH2, h3, POST, the
    // reminder, DEPTH1, partial — DEPTH1 right before the last turn and DEPTH2
    // before the one ahead of it, as the entries are without a continue. DEPTH1
    // stands at the history's end, so it goes with what follows the chat, as depth 0 does.
    expect([...messages.map((m) => m.content), partial]).toEqual([
      NEW_CHAT_SEPARATOR,
      history[0]!.content,
      history[1]!.content,
      'DEPTH2',
      history[2]!.content,
      ...TAIL,
      'DEPTH1',
      partial,
    ]);
    expect(withLore(lorebook).messages.map((m) => m.content)).toEqual([
      NEW_CHAT_SEPARATOR,
      history[0]!.content,
      history[1]!.content,
      'DEPTH2',
      history[2]!.content,
      'DEPTH1',
      history[3]!.content,
      ...TAIL,
    ]);
  });

  it('clamps a depth that would fall behind the trailing turns', () => {
    // Depth 0 wants to sit after the prefill, which the model must have last, so
    // it clamps to the end of the history like depth 1: with what follows the chat.
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
      NEW_CHAT_SEPARATOR,
      'DEEP',
      ...history.slice(0, 3).map((m) => m.content),
      ...TAIL,
      'DEPTH0',
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
    const budget = base.fixedTokens! + countTokens(history[2]!.content) + countTokens(history[3]!.content);
    // The depth entry takes its tokens from the same budget as the history.
    const { messages } = withLore([loreEntry({ content: depthText, depth: 0 })], budget);
    expect(messages.map((m) => m.content)).toEqual([history[3]!.content, ...TAIL, depthText]);
  });
});

describe('assemblePrompt - author note', () => {
  const authorNote = '{{user}}는 지금 초조하다.';
  const longer: HistoryMessage[] = [
    ...history,
    { role: 'assistant', content: '다섯 번째 캐릭터 발화입니다.' },
    { role: 'user', content: '여섯 번째 유저 발화입니다.' },
  ];

  // The chat's own settings (any at all) put the note at SillyTavern's depth.
  const atDepth = { authorNoteSettings: {} };

  it(`sits ${AUTHOR_NOTE_DEPTH} messages from the end of the history once the chat sets SillyTavern's placement`, () => {
    const { messages } = assemblePrompt({
      plot,
      characters: [aria],
      history: longer,
      preset,
      userName: '민준',
      authorNote,
      ...atDepth,
    });
    expect(messages.map((m) => m.content)).toEqual([
      ...EXAMPLES,
      NEW_CHAT_SEPARATOR,
      ...longer.slice(0, 2).map((m) => m.content),
      '민준는 지금 초조하다.',
      ...longer.slice(2).map((m) => m.content),
      ...TAIL,
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
      ...atDepth,
    });
    expect(messages.map((m) => m.content).slice(2, 6)).toEqual([
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
      ...atDepth,
    });
    expect(short.messages.map((m) => m.content)).toEqual([
      NEW_CHAT_SEPARATOR,
      '민준는 지금 초조하다.',
      ...history.slice(-2).map((m) => m.content),
      ...TAIL,
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
      ...atDepth,
    });
    // With the partial re-attached last, the note is still four from the end.
    expect(messages.map((m) => m.content)).toEqual([
      NEW_CHAT_SEPARATOR,
      ...longer.slice(0, 2).map((m) => m.content),
      '민준는 지금 초조하다.',
      ...longer.slice(2, -1).map((m) => m.content),
      ...TAIL,
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
    const budget = assemble(100_000).fixedTokens! + countTokens(note) + countTokens(history[3]!.content);
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
    // RisuAI's author's-note slot, after the global note, without settings of the chat's.
    expect(messages.map((m) => m.content)).toEqual([history[3]!.content, 'POST', note, REMINDER]);
  });
});

describe('assemblePrompt - author note settings', () => {
  const authorNote = '{{user}}는 지금 초조하다.';
  const note = '민준는 지금 초조하다.';
  // Three of the reader's turns: u1 a u2 a u3.
  const turns: HistoryMessage[] = [
    { role: 'assistant', content: 'a0' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ];
  const sent = (overrides: Partial<Parameters<typeof assemblePrompt>[0]> = {}) =>
    assemblePrompt({
      plot,
      characters: [bareAria],
      history: turns,
      preset,
      userName: '민준',
      authorNote,
      ...overrides,
    }).messages;
  const contents = (messages: { content: unknown }[]) => messages.map((m) => m.content);

  it('sits at the depth the chat sets, where depth lore of that depth would', () => {
    // Depth 0 goes with what follows the chat, as depth-0 lore does.
    expect(contents(sent({ authorNoteSettings: { depth: 0 } }))).toEqual([
      NEW_CHAT_SEPARATOR,
      ...turns.map((m) => m.content),
      ...TAIL,
      note,
    ]);
    expect(contents(sent({ authorNoteSettings: { depth: 1 } }))).toEqual([
      NEW_CHAT_SEPARATOR,
      ...turns.slice(0, 5).map((m) => m.content),
      note,
      'u3',
      ...TAIL,
    ]);
    // Same slot as a depth-2 lore entry, after it.
    const withLore = sent({
      authorNoteSettings: { depth: 2 },
      characters: [{ name: '아리아', card: { ...bareCard, lorebook: [loreEntry({ content: 'DEPTH2', depth: 2 })] } }],
    });
    expect(contents(withLore).slice(5, 8)).toEqual(['DEPTH2', note, 'a2']);
    // Deeper than the history: its start, after the separator.
    expect(contents(sent({ authorNoteSettings: { depth: 9999 } })).slice(0, 2)).toEqual([NEW_CHAT_SEPARATOR, note]);
  });

  it('goes in under the role the chat sets', () => {
    for (const role of ['system', 'user', 'assistant'] as const) {
      const message = sent({ authorNoteSettings: { role } }).find((m) => m.content === note);
      expect(message?.role).toBe(role);
    }
  });

  it("goes in RisuAI's author's-note slot with no settings: after the global note, every turn, system", () => {
    const plain = sent();
    expect(contents(plain)).toEqual([NEW_CHAT_SEPARATOR, ...turns.map((m) => m.content), 'POST', note, REMINDER]);
    expect(plain.find((m) => m.content === note)?.role).toBe('system');
    // Settings of any kind are SillyTavern's placement, with its defaults: depth 4, every turn, system.
    const defaults = sent({ authorNoteSettings: {} });
    expect(contents(defaults)).toEqual(contents(sent({ authorNoteSettings: { depth: 4, frequency: 1, role: 'system' } })));
    expect(contents(defaults).indexOf(note)).toBe(1 + turns.length - AUTHOR_NOTE_DEPTH);
    expect(defaults.find((m) => m.content === note)?.role).toBe('system');
  });

  it('is inserted every N of the reader messages, as SillyTavern counts them', () => {
    const due = (frequency: number, userTurns: number) =>
      contents(sent({ authorNoteSettings: { frequency }, userTurns })).includes(note);
    expect([1, 2, 3, 4].map((count) => due(2, count))).toEqual([false, true, false, true]);
    expect([1, 2, 3, 6].map((count) => due(3, count))).toEqual([false, false, true, true]);
    // Every turn, the first one too; never at 0.
    expect(due(1, 0)).toBe(true);
    expect([1, 2, 5].map((count) => due(0, count))).toEqual([false, false, false]);
    // Counted off the history when the caller does not say: three user turns here.
    expect(contents(sent({ authorNoteSettings: { frequency: 3 } }))).toContain(note);
    expect(contents(sent({ authorNoteSettings: { frequency: 2 } }))).not.toContain(note);
  });

  it('takes the lore around it with it on a turn it is not due', () => {
    const characters = [
      {
        name: '아리아',
        card: {
          ...bareCard,
          lorebook: [
            loreEntry({ content: 'BEFORE-AN', position: 'before_author_note' }),
            loreEntry({ content: 'AFTER-AN', position: 'after_author_note' }),
          ],
        },
      },
    ];
    const dueNow = contents(sent({ characters, authorNoteSettings: { frequency: 3 }, userTurns: 3 }));
    expect(dueNow).toContain(`BEFORE-AN\n${note}\nAFTER-AN`);
    const notDue = contents(sent({ characters, authorNoteSettings: { frequency: 3 }, userTurns: 2 })).join('\n');
    expect(notDue).not.toContain('BEFORE-AN');
    expect(notDue).not.toContain('AFTER-AN');
    expect(notDue).not.toContain(note);
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
      NEW_CHAT_SEPARATOR,
      '첫 장면.',
      stated[1]!.content,
      stated[2]!.content,
      stated[3]!.content,
      ...TAIL,
    ]);
  });

  it('still scans the stripped state for lore', () => {
    const prompt = assembleStated([loreEntry({ content: '왕궁의 비밀', constant: false, keys: ['왕궁'] })]);
    expect(movedLoreOf(prompt)).toBe('왕궁의 비밀');
    expect(sentAs(prompt, 'history')[0]).toBe('첫 장면.');
  });

  it('keeps a turn whole when its state is all it says', () => {
    const prompt = assemblePrompt({
      plot,
      characters: [bareAria],
      history: [{ role: 'assistant', content: status('왕궁') }, ...stated.slice(2)],
      preset,
      userName: '민준',
    });
    expect(sentAs(prompt, 'history')[0]).toBe(status('왕궁'));
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
    // Held by its window, a keyword entry is still keyword lore: after the newest turn.
    expect(movedLoreOf(result)).toBe('STICKY');
    expect(sentAs(result, 'lorebook')).toEqual(['FRESH']);
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

  it("takes an absent member's description, examples and lorebook out", () => {
    const { system, messages } = assemblePrompt({
      plot,
      characters: [aria, { ...minsu, absent: true }],
      history,
      preset,
      userName: '민준',
    });
    // Only the member still on the stage is described and named to the protocol.
    expect(system).toBe(['MAIN', DESCRIPTION, ...CLOSING].join('\n\n'));
    const everything = [system, ...messages.map((m) => promptText(m.content))].join('\n');
    for (const gone of ['여관 주인.', 'MINSU LORE', 'MINSU EXAMPLE']) expect(everything).not.toContain(gone);
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
    expect(system).toBe(
      [
        'WORK PROMPT',
        // 아리아 is not the first member here, so her card's scenario is her own, ahead of the work's setting.
        `서리 골짜기의 마녀.\n\nDescription of 아리아: 무뚝뚝하다.\n\n${scenarioLine(`눈보라 치는 밤.\n\n${plot.description}`)}`,
        ...CLOSING,
      ].join('\n\n'),
    );
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
      'description',
      'persona',
      'speech_protocol',
      'narration_note',
    ]);
    expect(systemBlocks.map((block) => block.text).join('\n\n')).toBe(result.system);
    // One block per message, in the same order and with the same text.
    expect(messageBlocks.map((block) => block.text)).toEqual(result.messages.map((m) => promptText(m.content)));
    expect(messageBlocks.map((block) => block.kind)).toEqual([
      'examples',
      'examples',
      'new_chat',
      'history',
      'history',
      'history',
      'depth_lore',
      'history',
      'global_note',
      'author_note',
      'speech_protocol',
      'directions',
    ]);
    expect(messageBlocks[0]!.label).toBe('아리아');
    expect(messageBlocks[6]!.label).toBe('depth 1');

    expect(report.history).toEqual({ included: 4, total: 4 });
    expect(report.examples).toEqual({ included: 2, total: 2 });
    // What the budget gave out is every block, as each was counted.
    expect(report.totals).toEqual({
      contextBudget: DEFAULT_CONTEXT_BUDGET,
      responseReserve: 1200,
      used: report.blocks.reduce((sum, block) => sum + block.tokens, 0),
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
  it('offers the one built-in id the API validates against, and falls back to it for any other', () => {
    expect(PRESET_IDS).toEqual(['default']);
    expect(PRESETS.default).toBe(DEFAULT_PRESET);
    expect(isPresetId('default')).toBe(true);
    // The five style presets that were are ids no more, and nothing the prototype holds is one.
    expect(isPresetId('novel')).toBe(false);
    expect(isPresetId('toString')).toBe(false);
    // An unknown, old or missing id must never break a generation.
    expect(getPreset('screenplay')).toBe(DEFAULT_PRESET);
    expect(getPreset('nope')).toBe(DEFAULT_PRESET);
    expect(getPreset(null)).toBe(DEFAULT_PRESET);
  });

  it('teaches the script protocol speech.ts reads, whatever the preset', () => {
    // `speech.ts` renders exactly this shape, so a prompt that taught another one
    // would produce a message the chat cannot attribute to anybody.
    const protocol = speechProtocol(['아리아', '민수']);
    expect(protocol).toContain('a line that starts with `Name: `, the name written exactly as one of: 아리아, 민수');
    expect(protocol).toContain('*descriptions wrapped in asterisks*');
    expect(protocol).toContain('Write the scene, setting and situation on lines with no prefix');
    expect(protocol).toContain('Several characters may take turns in one reply');
    expect(REMINDER).toContain("Write a character's words and actions on `Name: ` lines");
    // No preset carries it, so none can leave it out: the built-in one and a reader's get it alike.
    for (const which of [DEFAULT_PRESET, preset, legacyPreset('', '')]) {
      const prompt = assemblePrompt({ plot, characters: [aria], history, preset: which });
      expect(prompt.system.split(PROTOCOL)).toHaveLength(2);
      expect(prompt.messages.map((message) => message.content)).toContain(REMINDER);
    }
  });

  it("calls a reply's unprefixed lines its own 지문, never a narrator's", () => {
    // The narrator speaks on the narration button alone. A protocol that framed the
    // writer as playing it too, or called a reply's scene lines its lines, would
    // let every reply bring it in — the narrator the button replaced.
    expect(PROTOCOL).toContain("this reply's own narration, written alongside the characters' words");
    expect(`${PROTOCOL}\n${REMINDER}`).not.toMatch(/narrator/i);
  });
});

describe('assemblePrompt - stage directions', () => {
  const directions = '주사위 3. {{user}}의 자물쇠 따기는 실패한다.';

  it('injects the ruling after the newest turn and what follows it, leaving everything before it alone', () => {
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
    // What the next turn's request repeats — the system string and every turn up
    // to the newest — must be byte for byte what a turn without directions would
    // have sent, so the provider's cache serves it either way.
    expect(system).toBe(plain.system);
    expect(messages.slice(0, -1)).toEqual(plain.messages);
    expect(messages.slice(-4)).toEqual([
      { role: 'user', content: history[3]!.content },
      { role: 'system', content: 'POST' },
      { role: 'system', content: REMINDER },
      { role: 'system', content: '[Game ruling]\n주사위 3. 민준의 자물쇠 따기는 실패한다.' },
    ]);
  });

  it('is absent when the turn carries none', () => {
    const plain = assemblePrompt({ plot, characters: [aria], history, preset, userName: '민준' });
    expect(plain.messages.some((message) => promptText(message.content).includes('Game ruling'))).toBe(false);
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
    const block = '[Game ruling]\n주사위 3. 민준의 자물쇠 따기는 실패한다.';
    const budget =
      countTokens(assemble(100_000).system) +
      countTokens('POST') +
      countTokens(REMINDER) +
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
    expect(messages.map((m) => m.content)).toEqual([history[3]!.content, ...TAIL, block]);
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
    // The three history turns, between the separator and what follows the chat.
    const turns = messages.slice(-3 - TAIL.length, -TAIL.length);
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
      budget(shown) + countTokens('POST') + countTokens(REMINDER) + countTokens('민준의 방') + 2 * IMAGE_TOKEN_ESTIMATE;
    const { messages } = assemblePrompt({
      plot,
      characters: [aria],
      history: shown,
      preset,
      userName: '민준',
      contextBudget: room,
      maxResponseTokens: 0,
    });
    expect(messages.map((message) => promptText(message.content))).toEqual(['민준의 방', ...TAIL]);
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
    expect(messages.slice(0, 4)).toEqual([
      { role: 'system', content: NEW_CHAT_SEPARATOR },
      { role: 'assistant', content: '첫 번째 인사말입니다.' },
      { role: 'user', content: `${NARRATION_HEADER} 문이 열리고 바람이 들이쳤다.` },
      { role: 'user', content: '누구세요?' },
    ]);
    expect(messages.some((message) => promptText(message.content).includes('@:'))).toBe(false);
  });

  it('expands macros in the narration body against the plot', () => {
    const { messages } = assembleNarrated([{ role: 'user', content: '@:  {{char}}의 첫 밤.' }]);
    expect(messages[1]).toEqual({
      role: 'user',
      content: `${NARRATION_HEADER} 서리 골짜기의 밤의 첫 밤.`,
    });
  });

  it('labels an assistant narration the same way, because the role does not decide', () => {
    const { messages } = assembleNarrated([{ role: 'assistant', content: '@: 눈이 그쳤다.' }]);
    expect(messages[1]).toEqual({ role: 'assistant', content: `${NARRATION_HEADER} 눈이 그쳤다.` });
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
    expect(messages.slice(0, 4)).toEqual([
      { role: 'system', content: NEW_CHAT_SEPARATOR },
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
    expect(messages.slice(0, 4)).toEqual([
      { role: 'system', content: NEW_CHAT_SEPARATOR },
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
  /** What the narrator turn says, or '' when there is none. */
  const narratorOf = (input: Partial<Parameters<typeof assemblePrompt>[0]>): string =>
    sentAs(assembleWith(input), 'narrator').join('\n\n');

  it('says nothing about a narrator the plot never set', () => {
    const prompt = assembleWith({});
    expect(sentAs(prompt, 'narrator')).toEqual([]);
    for (const text of [prompt.system, ...prompt.messages.map((message) => promptText(message.content))]) {
      expect(text).not.toContain('Narrative style');
      expect(text).not.toContain('Point of view');
    }
  });

  it('carries the voice and the point of view with what follows the chat, never in the cached prefix', () => {
    const prompt = assembleWith({
      plot: { ...plot, narrator: { voice: '{{char}}를 멀리서 지켜보는 건조한 문장.', pov: 'third' } },
    });
    // The narrator is the plot's, so its macros resolve against the plot. The
    // labels name the prose, not a narrator: they govern a reply's 지문 as well.
    expect(sentAs(prompt, 'narrator')).toEqual([
      `Narrative style: 서리 골짜기의 밤를 멀리서 지켜보는 건조한 문장.\nPoint of view: ${NARRATOR_POV_LABELS.third}`,
    ]);
    expect(prompt.system).not.toContain('Narrative style');
    // RisuAI has no place for it: it goes after the global note and the reminder.
    expect(prompt.messages.map((message) => promptText(message.content)).slice(-3, -1)).toEqual(TAIL);
    expect(prompt.sources!.at(-1)!.kind).toBe('narrator');
  });

  it('carries either field on its own', () => {
    const voiced = narratorOf({ plot: { ...plot, narrator: { voice: '짧게 끊어 쓴다.' } } });
    expect(voiced).toBe('Narrative style: 짧게 끊어 쓴다.');

    expect(narratorOf({ plot: { ...plot, narrator: { pov: 'first' } } })).toBe(
      `Point of view: ${NARRATOR_POV_LABELS.first}`,
    );
  });

  it('names each point of view in the prompt', () => {
    for (const pov of NARRATOR_POVS) {
      expect(narratorOf({ plot: { ...plot, narrator: { pov } } })).toBe(`Point of view: ${NARRATOR_POV_LABELS[pov]}`);
    }
    expect(NARRATOR_POV_LABELS['third-limited']).toBe(
      'third-person limited (narrated within what one point-of-view character observes or feels)',
    );
  });

  it('lets the chat stand in for the plot, whole rather than field by field', () => {
    const narrating: PromptPlot = {
      ...plot,
      narrator: { voice: '플롯의 문체.', pov: 'third' as const },
    };
    // The override is the narrator now — the plot's voice does not leak into it.
    expect(narratorOf({ plot: narrating, narrator: { pov: 'omniscient' } })).toBe(
      `Point of view: ${NARRATOR_POV_LABELS.omniscient}`,
    );
    // …and no override leaves the plot's own in force.
    expect(narratorOf({ plot: narrating })).toContain('Narrative style: 플롯의 문체.');
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
    expect(sentAs(assembleWith({}), 'style')).toEqual([]);
    expect(sentAs(assemblePrompt({ plot, characters: [bareAria], history, preset }), 'style')).toEqual([]);
  });

  it('rides right behind the narrator, after the lore and the global note', () => {
    const after = loreEntry({ content: 'AFTER_CHAR_LORE', position: 'after_char' });
    const prompt = assembleWith({ tense: 'past', pacing: 'slow' }, [after]);
    expect(sentAs(prompt, 'style')).toEqual([styleDirectives({ tense: 'past', pacing: 'slow' })]);
    expect(prompt.system).not.toContain(STYLE_DIRECTIVES_HEADER);
    const kinds = prompt.sources!.map((source) => source.kind);
    expect(kinds.indexOf('style')).toBe(kinds.indexOf('narrator') + 1);
    expect(kinds.indexOf('style')).toBeGreaterThan(kinds.indexOf('lorebook'));
    expect(kinds.indexOf('style')).toBeGreaterThan(kinds.indexOf('global_note'));
  });

  it('expands the macros in a directive like every other section', () => {
    const [style] = sentAs(assembleWith({ difficulty: 'easy' }), 'style');
    expect(style).toContain("민준's lead");
    expect(style).not.toContain('{{user}}');
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

  it("reads the card's own fields and the persona as CBS, and the reader's preset as nothing", () => {
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
      preset: legacyPreset('MAIN {{user}}', 'POST'),
      userName: '민준',
      personaText: '{{user}}는 여행자',
    });
    // `{{scenario}}` is the plot's setting, read where it is asked for: in the member's text.
    // `{{mainprompt}}` is empty: the preset is the reader's text, which no card text reads.
    expect(system).toContain('[아리아는 차갑다|눈 내리는 아리아|민준는 여행자|]');
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

  it("reads {{char}} as the card's nickname in its own text, and keeps the roster name in the protocol", () => {
    const { system, messages } = assemblePrompt({
      plot,
      characters: [nicknamed],
      history,
      preset,
      userName: '민준',
    });
    expect(system).toContain('서리 골짜기의 마녀.\n\nDescription of 아리: 무뚝뚝하다.');
    expect(system).toContain(speechProtocol(['아리아 블랑']));
    const texts = messages.map((message) => promptText(message.content));
    // RisuAI's lorebook place, after the newest turn.
    expect(texts).toContain('아리의 로어');
    const examples = texts.filter((text) => text.startsWith(`${NEW_CHAT_SEPARATOR}\n`));
    expect(examples[0]).toBe(exampleBlock('민준: 예시 질문 하나\n아리: 예시 답변 하나'));
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
    expect(texts.slice(newest + 1)).toEqual(['END', ...TAIL, 'LAST']);
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
    expect(messages.map((message) => promptText(message.content))).toEqual([NEW_CHAT_SEPARATOR, 'S', 'E', ...TAIL]);
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
    const input = {
      plot,
      characters: [{ name: '아리아', card: { ...bareCard, lorebook: noteLore } }],
      history: longer,
      preset,
      userName: '민준',
      authorNote: '{{user}}는 지금 초조하다.',
    } satisfies Parameters<typeof assemblePrompt>[0];
    const note = 'AN-TOP\n민준는 지금 초조하다.\nAN-BOTTOM';
    // RisuAI's place, the preset's author's-note item: after the global note.
    const { system, messages } = assemblePrompt(input);
    expect(system).not.toContain('AN-');
    expect(texts(messages)).toEqual([NEW_CHAT_SEPARATOR, ...longer.map((m) => m.content), 'POST', note, REMINDER]);
    // SillyTavern's depth, where the chat set one.
    expect(texts(assemblePrompt({ ...input, authorNoteSettings: { depth: 4 } }).messages)).toEqual([
      NEW_CHAT_SEPARATOR,
      ...longer.slice(0, 2).map((m) => m.content),
      note,
      ...longer.slice(2).map((m) => m.content),
      ...TAIL,
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
    const at = texts(messages).indexOf('POST') + 1;
    expect(messages[at]).toEqual({ role: 'system', content: 'AN-TOP\nAN-BOTTOM' });
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
      exampleBlock('A'),
      exampleBlock('B'),
      ...EXAMPLES,
      exampleBlock('C'),
      NEW_CHAT_SEPARATOR,
      ...history.map((m) => m.content),
      ...TAIL,
    ]);
    expect(roomy.system.split('\n')).not.toContain('C');

    // Room for the system string, the history and what follows it only.
    const budget =
      countTokens(roomy.system) +
      countTokens('POST') +
      countTokens(REMINDER) +
      history.reduce((sum, turn) => sum + countTokens(turn.content), 0);
    expect(texts(assemblePrompt({ ...input, contextBudget: budget }).messages)).toEqual([
      ...history.map((m) => m.content),
      ...TAIL,
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
    const { messages } = assemblePrompt({
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
    expect(messages.map((message) => promptText(message.content))).toEqual([
      NEW_CHAT_SEPARATOR,
      '[가려짐]',
      '좋아',
      'KEY-LORE',
      ...TAIL,
    ]);
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
        .messages.slice(0, -TAIL.length)
        .map((message) => promptText(message.content))
        .filter((text) => text !== NEW_CHAT_SEPARATOR);
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
    expect(messages.map((message) => promptText(message.content))).toEqual([
      NEW_CHAT_SEPARATOR,
      '인사 0',
      '대답 2',
      '보이는 말',
      ...TAIL,
    ]);
    expect(report!.history).toEqual({ included: 3, total: 3 });
    expect(risu).toEqual({ system: [{ text: assembleWith(turns).system }] });
    // Nothing was cut off the front: a hidden turn is not dropped history, so
    // the chat still opens with RisuAI's separator.
    expect(promptText(assembleWith([{ ...turns[0]!, hidden: true }, ...turns.slice(1)]).messages[0]!.content)).toBe(
      NEW_CHAT_SEPARATOR,
    );
  });

  it('scans no hidden turn for lore keywords', () => {
    const lorebook = [loreEntry({ content: 'KEY-LORE', constant: false, keys: ['열쇠'] })];
    const scanned = (turnsSent: HistoryMessage[]): string =>
      movedLoreOf(
        assemblePrompt({
          plot,
          characters: [{ name: '아리아', card: { ...bareCard, lorebook } }],
          history: turnsSent,
          preset,
          userName: '민준',
        }),
      );
    expect(scanned(turns)).not.toContain('KEY-LORE');
    expect(scanned(turns.map(({ hidden: _hidden, ...turn }) => turn))).toContain('KEY-LORE');
  });

  it('keeps the newest turn the AI reads when the budget is spent, never a hidden one', () => {
    const tail: HistoryMessage[] = [...turns, { role: 'assistant', content: '숨긴 답', hidden: true }];
    const tiny = assembleWith(tail, { contextBudget: 1 });
    // No separator either: the turns before it were cut off.
    expect(tiny.messages.map((message) => promptText(message.content))).toEqual(['보이는 말', ...TAIL]);
  });

  it('sends no history at all when every turn is hidden', () => {
    const { messages, report } = assembleWith(
      turns.map((turn) => ({ ...turn, hidden: true })),
      { report: true },
    );
    expect(messages.map((message) => promptText(message.content))).toEqual([NEW_CHAT_SEPARATOR, ...TAIL]);
    expect(report!.history).toEqual({ included: 0, total: 0 });
  });
});

describe('assemblePrompt - the greeting in the lore scan', () => {
  // Only the greeting, history[0], says 인사말.
  const greeting = loreEntry({ content: 'GREETING-LORE', constant: false, keys: ['인사말'] });
  const opened = { length: history.length, greeting: { text: history[0]!.content, index: -1 } };
  const scanned = (
    lore: { plot?: LoreEntry[]; member?: LoreEntry[] },
    extra: { sillyTavern?: boolean; branch?: typeof opened; history?: HistoryMessage[] } = {},
  ): boolean =>
    movedLoreOf(
      assemblePrompt({
        plot: { ...plot, lorebook: lore.plot ?? [] },
        characters: [
          {
            name: '아리아',
            card: { ...bareCard, lorebook: lore.member ?? [] },
            ...(extra.sillyTavern ? { sillyTavern: true } : {}),
          },
        ],
        history: extra.history ?? history,
        preset,
        userName: '민준',
        branch: extra.branch ?? opened,
      }),
    ).includes('GREETING-LORE');

  it("leaves the greeting out of the scan, as RisuAI's chat never holds it", () => {
    expect(scanned({ member: [greeting] })).toBe(false);
    expect(scanned({ plot: [greeting] })).toBe(false);
    // Trimmed by the memory, the history no longer opens on the greeting: its first turn is scanned.
    expect(scanned({ member: [greeting] }, { branch: { ...opened, length: 6 } })).toBe(true);
    // A greeting hidden from the AI is scanned by nobody.
    const hidden = [{ ...history[0]!, hidden: true }, ...history.slice(1)];
    expect(scanned({ member: [{ ...greeting, sillyTavern: true }] }, { history: hidden })).toBe(false);
  });

  it("scans it for SillyTavern's lore: a member card ST wrote, an entry of a World Info file", () => {
    expect(scanned({ member: [greeting] }, { sillyTavern: true })).toBe(true);
    expect(scanned({ plot: [{ ...greeting, sillyTavern: true }] })).toBe(true);
    expect(scanned({ member: [{ ...greeting, sillyTavern: true }] })).toBe(true);
    // The member's card is ST's, so the whole book runs as ST's World Info, which
    // scans the greeting for every entry — the work's own one too.
    expect(scanned({ plot: [greeting] }, { sillyTavern: true })).toBe(true);
    // Neither is: RisuAI's scan.
    expect(scanned({ plot: [greeting] })).toBe(false);
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
        // Room for two entries at the default share, and for one at 30%.
        contextBudget: Math.ceil((cost * 2.5) / LORE_BUDGET_SHARE),
        report: true,
      }).report!.lore.map((entry) => entry.preview.slice(0, 1));
    expect(activated()).toEqual(['B', 'A']);
    expect(activated(30)).toEqual(['A']);
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
    memoryText: '[Summary of the story so far]\n둘은 만났다.',
    injections: { start: 'START', historyend: 'END', promptend: 'LAST' },
    report: true,
  };

  it('sends RisuAI’s template for one: the card’s own parts, none of our preset, persona or note', () => {
    const prompt = assemblePrompt({ ...input, characters: [utility] });
    // RisuAI's utility template: description, lore, chat, the card's global note, what goes after everything.
    expect(prompt.system).toBe(DESCRIPTION);
    for (const gone of ['MAIN', '카드의 시스템 프롬프트', NARRATION_NOTE, PROTOCOL, '페르소나 설명']) {
      expect(prompt.system).not.toContain(gone);
    }
    const texts = prompt.messages.map((message) => promptText(message.content));
    // The memory at the head of the chat, as HypaV3 puts it where no item holds it, the chat whole,
    // then the card's replacement with `{{original}}` as nothing and no protocol reminder, then what
    // goes after everything. The note and the start triggers' `start` and `historyend` have no place.
    expect(texts).toEqual([
      '[Summary of the story so far]\n둘은 만났다.',
      NEW_CHAT_SEPARATOR,
      ...history.map((turn) => turn.content),
      '카드의 끝 지시 [] 아리아',
      'LAST',
    ]);
    expect(prompt.report!.blocks.map((block) => block.kind)).not.toContain('author_note');
    expect(prompt.risu).toEqual({ system: [{ text: DESCRIPTION }], template: true });

    // The same card without the flag is read as it always was.
    const roleplay = assemblePrompt({ ...input, characters: [{ name: '아리아', card: { ...utilityCard, extensions: {} } }] });
    expect(roleplay.system).toContain('카드의 시스템 프롬프트');
    expect(roleplay.system).toContain('페르소나 설명');
    expect(roleplay.messages.map((message) => promptText(message.content))).toEqual(
      expect.arrayContaining(['작가 노트', 'START', 'END', 'LAST']),
    );
    expect(roleplay.risu!.template).toBeUndefined();
  });

  it('sends no post-history turn when the card has no replacement, and keeps the lore', () => {
    const lore = loreEntry({ content: '항상 켜진 설정', constant: true });
    const bare: PromptCharacter = {
      name: '아리아',
      card: { ...bareCard, lorebook: [lore], extensions: { risuai: { utilityBot: true } } },
    };
    const prompt = assemblePrompt({ ...input, characters: [bare] });
    expect(prompt.system).toContain('항상 켜진 설정');
    expect(prompt.messages.map((message) => promptText(message.content))).toEqual([
      '[Summary of the story so far]\n둘은 만났다.',
      NEW_CHAT_SEPARATOR,
      ...history.map((turn) => turn.content),
      'LAST',
    ]);
    expect(prompt.sources!.map((source) => source.kind)).not.toContain('global_note');
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

describe("assemblePrompt - SillyTavern's WORLD_INFO regex marks (world-info.js getRegexedString(entry.content, WORLD_INFO))", () => {
  const stEntry = (content: string, overrides: Partial<LoreEntry> = {}): LoreEntry =>
    loreEntry({ content, sillyTavern: true, ...overrides });
  const assembled = (lorebook: LoreEntry[], markTavernLore = true) =>
    assemblePrompt({
      plot: { ...plot, lorebook },
      characters: [bareAria],
      history,
      preset,
      userName: '민준',
      contextBudget: 100_000,
      markTavernLore,
    });
  const upper = (segments: { text: string }[]) => Promise.resolve(segments.map((segment) => segment.text.toUpperCase()));

  it("marks an ST entry's text where it is inserted, with its depth, and nothing else", async () => {
    const prompt = assembled([
      stEntry('st before {{user}}'),
      loreEntry({ content: 'own lore' }),
      stEntry('st deep', { depth: 2 }),
    ]);
    expect(prompt.tavernLore).toHaveLength(2);
    expect(prompt.tavernLore).toEqual(expect.arrayContaining([{}, { depth: 2 }]));
    // Our own entry goes to RisuAI's lorebook place, after the newest turn; an ST one stays by the description.
    expect(sentAs(prompt, 'lorebook')).toEqual(['own lore']);
    // Rewritten after the macros, as ST runs the regex on the substituted content.
    const rewritten = await rewriteTavernLore(prompt, upper);
    expect(rewritten.system).toContain('ST BEFORE 민준');
    const rewrittenTexts = rewritten.messages.map((message) => promptText(message.content));
    expect(rewrittenTexts).toContain('own lore');
    expect(rewrittenTexts).toContain('ST DEEP');
    expect(JSON.stringify(rewritten)).not.toMatch(/[\uFDD0-\uFDD2]/);
    expect(rewritten.tavernLore).toBeUndefined();
    // Not asked: the same prompt as ever.
    expect(assembled([stEntry('st before {{user}}')], false)).toEqual(
      (({ tavernLore: _segments, ...rest }) => rest)(await rewriteTavernLore(assembled([stEntry('st before {{user}}')]), (segments) => Promise.resolve(segments.map((segment) => segment.text)))),
    );
  });

  it('leaves out an entry the scripts empty, with the separator beside it, and a depth turn with nothing left', async () => {
    const prompt = assembled([
      stEntry('keep one', { insertionOrder: 3 }),
      stEntry('drop', { insertionOrder: 2 }),
      stEntry('keep two', { insertionOrder: 1 }),
      stEntry('drop', { depth: 1 }),
    ]);
    const emptied = await rewriteTavernLore(prompt, (segments) =>
      Promise.resolve(segments.map((segment) => (segment.text === 'drop' ? '' : segment.text))),
    );
    expect(emptied.system).toMatch(/keep (one|two)\n\nkeep (one|two)/);
    expect(emptied.system).not.toContain('drop');
    expect(emptied.system).not.toMatch(/\n{3,}/);
    expect(emptied.messages).toHaveLength(prompt.messages.length - 1);
    expect(emptied.sources).toHaveLength(prompt.messages.length - 1);
    expect(emptied.messages.map((message) => promptText(message.content))).not.toContain('');
  });

  it("takes the template's wrapper of an entry the scripts empty with it", async () => {
    const onDefault = (lorebook: LoreEntry[], markTavernLore: boolean) =>
      assemblePrompt({
        plot: { ...plot, lorebook },
        characters: [bareAria],
        history,
        preset: DEFAULT_PRESET,
        userName: '민준',
        markTavernLore,
      });
    const prompt = onDefault([stEntry('keep'), stEntry('drop')], true);
    expect(prompt.system).toContain('[Roleplay Setting]\n');
    const emptied = await rewriteTavernLore(prompt, (segments) =>
      Promise.resolve(segments.map((segment) => (segment.text === 'drop' ? '' : segment.text))),
    );
    // As if the entry had never been there: no empty `[Roleplay Setting]` block, no blank lines left.
    expect(emptied.system).toBe(onDefault([stEntry('keep')], false).system);
  });

  it('keeps a segment no one rewrote as it was', () => {
    const prompt = assembled([stEntry('kept')]);
    expect(withTavernLore(prompt, new Map()).system).toBe(prompt.system);
  });
});
