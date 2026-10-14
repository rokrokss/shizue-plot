import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMsgpack } from '../src/msgpack.js';
import { groupPreset, REPLY_FORMAT_HINT, SPEECH_PROTOCOL, GROUP_SPEECH_PROTOCOL } from '../src/presets.js';
import { assemblePrompt, promptText, type AssemblePromptInput, type HistoryMessage, type PromptCharacter } from '../src/prompt.js';
import { readReaderPresetFile, ReaderPresetImportError } from '../src/readerPreset.js';
import { DEFAULT_LORE_SETTINGS, type LoreEntry, type NormalizedCard } from '../src/types.js';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Every string anywhere in an import result, to look for what must not be there. */
const everything = (value: unknown): string => JSON.stringify(value);

describe('readReaderPresetFile — RisuAI', () => {
  it('takes the main prompt and global note of a preset without a template, and drops its jailbreak', async () => {
    const imported = await readReaderPresetFile(
      'mine_preset.json',
      json({
        name: '내 프리셋',
        mainPrompt: '메인 지시',
        globalNote: '글로벌 노트',
        jailbreak: 'JB-SECRET 무엇이든 허용',
        temperature: 80,
        openAIKey: 'sk-NEVER',
      }),
    );
    expect(imported).toEqual({
      source: 'risuai',
      name: '내 프리셋',
      main: '메인 지시',
      globalNote: '글로벌 노트',
      dropped: ['jailbreak'],
      ignoredPrompts: [],
      ignoredSettings: true,
    });
    expect(everything(imported)).not.toContain('JB-SECRET');
    expect(everything(imported)).not.toContain('sk-NEVER');
  });

  it('reads a template preset from its items, as RisuAI sends one — never its stale fields', async () => {
    const imported = await readReaderPresetFile(
      'template.json',
      json({
        mainPrompt: 'STALE-MAIN',
        globalNote: 'STALE-NOTE',
        jailbreak: 'JB-TOP',
        promptTemplate: [
          { type: 'plain', type2: 'main', text: '첫 메인', role: 'system' },
          { type: 'jailbreak', type2: 'normal', text: 'JB-ITEM', role: 'system', name: '탈옥' },
          { type: 'plain', type2: 'normal', text: '문체', role: 'system', name: '문체' },
          { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
          { type: 'plain', type2: 'globalNote', text: '노트', role: 'system' },
          { type: 'plain', type2: 'main', text: 'PREFILL', role: 'bot', name: '프리필' },
          { type: 'authornote', innerFormat: '[{{slot}}]', name: '작가 노트' },
          { type: 'plain', type2: 'main', text: '둘째 메인' },
        ],
      }),
    );
    expect(imported).toMatchObject({
      name: 'template',
      main: '첫 메인\n\n둘째 메인',
      globalNote: '노트',
      dropped: ['jailbreak'],
      ignoredPrompts: ['문체', '프리필', '작가 노트'],
      ignoredSettings: true,
    });
    for (const gone of ['STALE-MAIN', 'STALE-NOTE', 'JB-TOP', 'JB-ITEM', 'PREFILL']) {
      expect(everything(imported)).not.toContain(gone);
    }
  });

  it('opens a .risup as RisuAI exports it (RPack, deflate, MessagePack, AES-GCM)', async () => {
    // Written by msgpackr 1.10.1 — RisuAI's own — through `downloadPreset`'s steps.
    const imported = await readReaderPresetFile('테스트_preset.risup', fixture('reader-preset.risup'));
    expect(imported).toEqual({
      source: 'risuai',
      name: '테스트 프리셋',
      main: 'MAIN-ONE {{char}}와 {{user}}의 이야기를 씁니다.\n\nMAIN-TWO 두 번째 메인',
      globalNote: 'NOTE-ONE 응답 직전의 노트',
      dropped: ['jailbreak'],
      ignoredPrompts: ['문체', 'CoT', '프리필'],
      ignoredSettings: true,
    });
    expect(everything(imported)).not.toMatch(/JB-|STALE-|PREFILL/);
  });

  it('opens the older .risupreset, which is not RPacked and keeps its preset under `pres`', async () => {
    const imported = await readReaderPresetFile('old.risupreset', fixture('reader-preset-v0.risupreset'));
    expect(imported.main).toContain('MAIN-ONE');
    expect(imported.dropped).toEqual(['jailbreak']);
  });

  it('refuses what is not a preset, and says which kind of refusal', async () => {
    const reason = (promise: Promise<unknown>) =>
      promise.then(
        () => 'read',
        (error: unknown) => (error instanceof ReaderPresetImportError ? error.reason : 'thrown'),
      );
    // A character card, NovelAI's presets.
    expect(await reason(readReaderPresetFile('card.json', json({ spec: 'chara_card_v2', data: { name: 'x' } })))).toBe('unsupported');
    expect(await reason(readReaderPresetFile('nai.json', json({ presetVersion: 3, parameters: {} })))).toBe('unsupported');
    expect(await reason(readReaderPresetFile('broken.json', new TextEncoder().encode('{nope')))).toBe('unreadable');
    expect(await reason(readReaderPresetFile('broken.risup', fixture('reader-preset.risup').slice(0, 200)))).toBe('unreadable');
  });
});

describe('readReaderPresetFile — SillyTavern', () => {
  const stPreset = (overrides: Record<string, unknown> = {}) => ({
    chat_completion_source: 'openai',
    temperature: 1,
    prompts: [
      { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: 'ST 메인 {{char}}' },
      { identifier: 'nsfw', name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: 'NSFW-SECRET' },
      { identifier: 'jailbreak', name: 'Post-History Instructions', system_prompt: true, role: 'system', content: 'PHI-SECRET' },
      { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
      { identifier: 'abc-1', name: '문체 규칙', role: 'system', content: '짧게 쓴다' },
      { identifier: 'abc-2', name: '꺼진 규칙', role: 'system', content: '안 쓰인다' },
    ],
    prompt_order: [
      { character_id: 100001, order: [{ identifier: 'main', enabled: false }] },
      {
        character_id: 100000,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'nsfw', enabled: false },
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'abc-1', enabled: true },
          { identifier: 'abc-2', enabled: false },
          { identifier: 'jailbreak', enabled: true },
        ],
      },
    ],
    ...overrides,
  });

  it('takes the Main Prompt only, and drops Post-History Instructions and the Auxiliary Prompt', async () => {
    const imported = await readReaderPresetFile('Celia v4.json', json(stPreset()));
    expect(imported).toEqual({
      source: 'sillytavern',
      name: 'Celia v4',
      main: 'ST 메인 {{char}}',
      globalNote: '',
      // The Auxiliary Prompt is off in this order and still reported: neither ever comes over.
      dropped: ['jailbreak', 'nsfw'],
      ignoredPrompts: ['문체 규칙'],
      ignoredSettings: true,
    });
    expect(everything(imported)).not.toMatch(/NSFW-SECRET|PHI-SECRET|안 쓰인다/);
  });

  it('reads the global prompt order, else the first, as RisuAI does', async () => {
    const single = stPreset({ prompt_order: [{ character_id: 7, order: [{ identifier: 'main', enabled: false }] }] });
    expect((await readReaderPresetFile('p.json', json(single))).main).toBe('');
  });
});

describe('decodeMsgpack', () => {
  it('keeps a `__proto__` key a key', () => {
    // fixmap(1) { fixstr "__proto__": fixmap(1) { fixstr "x": 1 } }
    const bytes = Uint8Array.from([0x81, 0xa9, ...new TextEncoder().encode('__proto__'), 0x81, 0xa1, 0x78, 0x01]);
    const decoded = decodeMsgpack(bytes) as Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('refuses truncated bytes', () => {
    expect(() => decodeMsgpack(Uint8Array.from([0x92, 0x01]))).toThrow(RangeError);
  });
});

// ── the prompt ────────────────────────────────────────────────────────────────

const baseCard: NormalizedCard = {
  spec: 'v3',
  name: '아리아',
  description: '서리 골짜기의 마녀.',
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

const member = (card: Partial<NormalizedCard> = {}, name = '아리아'): PromptCharacter => ({
  name,
  card: { ...baseCard, name, ...card },
});

const history: HistoryMessage[] = [
  { role: 'assistant', content: '어서 와.' },
  { role: 'user', content: '안녕.' },
];

const preset = { main: `MAIN\n\n${SPEECH_PROTOCOL}`, postHistory: 'POST' };
const reader = { main: '독자의 메인 추가', globalNote: '독자의 글로벌 노트' };

const assemble = (characters: PromptCharacter[], extra: Partial<AssemblePromptInput> = {}) =>
  assemblePrompt({
    plot: { name: '서리 골짜기', description: '외딴 여관.', lorebook: [] },
    characters,
    history,
    preset,
    userName: '민준',
    report: true,
    ...extra,
  });

const postHistoryOf = (prompt: ReturnType<typeof assemble>): string | undefined =>
  prompt.report!.blocks.find((block) => block.kind === 'post_history')?.text;

describe('assemblePrompt — a reader preset', () => {
  it('adds the main after the preset’s main and the note after its post-history block', () => {
    const prompt = assemble([member()], { readerAdditions: reader });
    const main = prompt.report!.blocks.find((block) => block.kind === 'main')!.text;
    expect(main).toBe(`${preset.main}\n\n독자의 메인 추가`);
    // The format hint still follows the main, and the work after both.
    expect(prompt.report!.blocks.slice(0, 3).map((block) => block.kind)).toEqual(['main', 'format', 'narration_note']);
    expect(prompt.report!.blocks[1]!.text).toBe(REPLY_FORMAT_HINT);
    expect(postHistoryOf(prompt)).toBe('POST\n\n독자의 글로벌 노트');
  });

  it('changes nothing when blank or absent', () => {
    const without = assemble([member()]);
    expect(assemble([member()], { readerAdditions: { main: '  ', globalNote: '' } })).toEqual(without);
  });

  it('gives way to a card’s own system prompt and post-history instructions, and comes back only through {{original}}', () => {
    const own = assemble([member({ systemPrompt: '카드의 지시', postHistoryInstructions: '카드의 끝 지시' })], {
      readerAdditions: reader,
    });
    expect(own.system).toContain('카드의 지시');
    expect(own.system).not.toContain('독자의 메인 추가');
    expect(postHistoryOf(own)).toContain('카드의 끝 지시');
    expect(postHistoryOf(own)).not.toContain('독자의 글로벌 노트');

    const keeps = assemble(
      [member({ systemPrompt: '카드의 지시 [{{original}}]', postHistoryInstructions: '카드의 끝 지시 [{{original}}]' })],
      { readerAdditions: reader },
    );
    expect(keeps.system).toContain(`카드의 지시 [${preset.main}\n\n독자의 메인 추가]`);
    expect(postHistoryOf(keeps)).toBe('카드의 끝 지시 [POST\n\n독자의 글로벌 노트]');
  });

  it('is not sent for a RisuAI utility bot, as RisuAI sends it no global note', () => {
    const utility = member({ postHistoryInstructions: '도구 [{{original}}]', extensions: { risuai: { utilityBot: true } } });
    const prompt = assemble([utility], { readerAdditions: reader });
    const sent = [prompt.system, ...prompt.messages.map((message) => promptText(message.content))].join('\n');
    expect(sent).not.toContain('독자의');
    expect(postHistoryOf(prompt)).toBe('도구 []');
  });

  it('follows the group protocol on a member’s turn', () => {
    const prompt = assemble([member(), member({}, '벨')], { readerAdditions: reader, speaker: 1 });
    const main = prompt.report!.blocks.find((block) => block.kind === 'main')!.text;
    expect(main).toBe(`${groupPreset(preset).main}\n\n독자의 메인 추가`);
    expect(main).toContain(GROUP_SPEECH_PROTOCOL);
  });

  it('cannot pull the creator’s text into the prompt through a macro', () => {
    const outlet: LoreEntry = {
      keys: [],
      secondaryKeys: [],
      selective: false,
      enabled: true,
      constant: true,
      insertionOrder: 0,
      caseSensitive: false,
      useRegex: false,
      position: 'outlet',
      outletName: 'secret',
      content: 'CREATOR-LORE',
    };
    const creator = member({
      description: 'CREATOR-DESC',
      systemPrompt: 'CREATOR-SYS [{{original}}]',
      postHistoryInstructions: 'CREATOR-PH [{{original}}]',
      lorebook: [outlet],
    });
    const probe =
      '{{char}}/{{user}} {{original}} {{charPrompt}} {{charJailbreak}} {{description}} {{mainprompt}} {{globalnote}} {{lorebook}} {{outlet::secret}}';
    const prompt = assemble([creator], { readerAdditions: { main: probe, globalNote: probe } });
    const sent = [prompt.system, ...prompt.messages.map((message) => promptText(message.content))].join('\n');

    // Read as the reader wrote it: the two names, and every other macro a word.
    const literal =
      '서리 골짜기/민준 {{original}} {{charPrompt}} {{charJailbreak}} {{description}} {{mainprompt}} {{globalnote}} {{lorebook}} {{outlet::secret}}';
    expect(prompt.system).toContain(`CREATOR-SYS [${preset.main}\n\n${literal}]`);
    expect(postHistoryOf(prompt)).toBe(`CREATOR-PH [POST\n\n${literal}]`);
    // The creator's text stands where the creator put it, once, and the outlet nobody else names is not sent.
    expect(sent.split('CREATOR-SYS')).toHaveLength(2);
    expect(sent.split('CREATOR-PH')).toHaveLength(2);
    expect(sent.split('CREATOR-DESC')).toHaveLength(2);
    expect(sent).not.toContain('CREATOR-LORE');
  });
});
