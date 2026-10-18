import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMsgpack } from '../src/msgpack.js';
import { DEFAULT_PRESET, RISU_DEFAULT_FORMATING_ORDER, speechProtocol, type PromptPreset } from '../src/presets.js';
import { assemblePrompt, promptText, type AssemblePromptInput, type HistoryMessage, type PromptCharacter } from '../src/prompt.js';
import {
  moduleIntegrationNames,
  presetDefaultVariables,
  readerPromptPreset,
  readReaderPresetFile,
  ReaderPresetImportError,
} from '../src/readerPreset.js';
import { DEFAULT_LORE_SETTINGS, type NormalizedCard } from '../src/types.js';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Every string anywhere in an import result, to look for what must not be there. */
const everything = (value: unknown): string => JSON.stringify(value);

describe('readReaderPresetFile — RisuAI', () => {
  it('keeps a preset without a template as RisuAI sends it: its three texts in its order', async () => {
    const imported = await readReaderPresetFile(
      'mine_preset.json',
      json({
        name: '내 프리셋',
        mainPrompt: '메인 지시',
        globalNote: '글로벌 노트',
        jailbreak: '탈옥 지시',
        temperature: 80,
        openAIKey: 'sk-NEVER',
      }),
    );
    expect(imported).toEqual({
      source: 'risuai',
      name: '내 프리셋',
      main: '메인 지시',
      globalNote: '글로벌 노트',
      jailbreak: '탈옥 지시',
      // RisuAI's default order: … chats, lastChat, jailbreak, lorebook, globalNote, …
      formatingOrder: [...RISU_DEFAULT_FORMATING_ORDER],
      promptTemplate: null,
      groupTemplate: '',
      groupOtherBotRole: 'user',
      toggles: '',
      moduleIntegration: '',
      defaultVariables: '',
      promptSettings: null,
      regex: [],
      imported: [
        { kind: 'main', name: '', into: 'main' },
        { kind: 'globalNote', name: '', into: 'globalNote' },
        { kind: 'jailbreak', name: '', into: 'jailbreak' },
      ],
      ignoredPrompts: [],
      ignoredSettings: true,
    });
    expect(everything(imported)).not.toContain('sk-NEVER');
  });

  it('keeps the preset’s toggles and module integration, which RisuAI saves beside its prompts', async () => {
    const toggles = 'rain=비 오는 날\nmood=분위기=select=밝게,어둡게';
    for (const promptTemplate of [undefined, [{ type: 'plain', type2: 'main', role: 'system', text: '메인' }]]) {
      const imported = await readReaderPresetFile(
        'p.json',
        json({ mainPrompt: '메인', customPromptTemplateToggle: toggles, moduleIntergration: 'weather, ui,', promptTemplate }),
      );
      expect(imported.toggles).toBe(toggles);
      expect(imported.moduleIntegration).toBe('weather, ui,');
    }
    // Both are fields the import reads, not settings it leaves behind.
    expect((await readReaderPresetFile('p.json', json({ mainPrompt: 'm', customPromptTemplateToggle: 'a=b' }))).ignoredSettings).toBe(false);
  });

  it('keeps toggles and default variables whole, however long — a cut would send another prompt', async () => {
    const long = 'x'.repeat(50_000);
    const imported = await readReaderPresetFile(
      'p.json',
      json({ mainPrompt: 'm', customPromptTemplateToggle: long, templateDefaultVariables: `a=${long}` }),
    );
    expect(imported.toggles).toHaveLength(50_000);
    expect(imported.defaultVariables).toHaveLength(50_002);
  });

  it("keeps the preset's default variables, and reads them under the work's as RisuAI's getChatVar does", async () => {
    // database.svelte.ts saves `templateDefaultVariables` in the preset beside its
    // prompts; chatVar.svelte.ts `getChatVar` reads an unset variable from
    // `parseKeyValue(char.defaultVariables).concat(parseKeyValue(db.templateDefaultVariables))`,
    // the first pair with the name — the character's before the preset's.
    const imported = await readReaderPresetFile('p.json', json({ mainPrompt: 'm', templateDefaultVariables: 'hp=10\nmood=좋음\nempty=' }));
    expect(imported.defaultVariables).toBe('hp=10\nmood=좋음\nempty=');
    expect(imported.ignoredSettings).toBe(false);
    expect({ ...presetDefaultVariables({ hp: '3' }, imported.defaultVariables) }).toEqual({ hp: '3', mood: '좋음' });
    expect(presetDefaultVariables(undefined, '')).toBeUndefined();
    expect({ ...presetDefaultVariables(undefined, 'a=b=c') }).toEqual({ a: 'b' });
  });

  it("keeps the preset's prompt settings and regex, which RisuAI's sendChat reads from it", async () => {
    // database.svelte.ts saves `promptSettings` and `regex: db.presetRegex` in the
    // preset and loads them back (`db.presetRegex = newPres.regex ?? []`).
    const script = { comment: 'trim', in: '\\s+$', out: '', type: 'editprocess', ableFlag: false };
    const imported = await readReaderPresetFile(
      'p.json',
      json({
        mainPrompt: 'm',
        promptSettings: { sendName: true, sendChatAsSystem: false, postEndInnerFormat: '끝', assistantPrefill: 'x', bogus: 1 },
        regex: [script, 'not a script', null],
      }),
    );
    expect(imported.promptSettings).toEqual({ sendName: true, postEndInnerFormat: '끝' });
    expect(imported.regex).toEqual([script]);
    expect(imported.ignoredSettings).toBe(false);
    // A file without them has none.
    const bare = await readReaderPresetFile('p.json', json({ mainPrompt: 'm' }));
    expect([bare.promptSettings, bare.regex]).toEqual([null, []]);
    // Stored, they reach the prompt preset; empty ones are absent.
    expect(readerPromptPreset({ ...stored, promptSettings: imported.promptSettings, regex: imported.regex })).toMatchObject({
      promptSettings: { sendName: true, postEndInnerFormat: '끝' },
      regex: [script],
    });
    const none = readerPromptPreset({ ...stored, promptSettings: {}, regex: [] });
    expect('promptSettings' in none || 'regex' in none).toBe(false);
  });

  it('reads a module integration as RisuAI’s getModules splits it', () => {
    expect(moduleIntegrationNames(' weather, ui ,,status ')).toEqual(['weather', 'ui', 'status']);
    expect(moduleIntegrationNames('')).toEqual([]);
    expect(moduleIntegrationNames(null)).toEqual([]);
  });

  it('keeps the preset’s own order, and counts the jailbreak taken only where the order sends it', async () => {
    const preset = (formatingOrder: string[]) =>
      readReaderPresetFile('p.json', json({ mainPrompt: '메인', globalNote: '노트', jailbreak: '탈옥', formatingOrder }));
    // RisuAI's NAI preset order, kept as it is.
    const nai = ['main', 'description', 'chats', 'lastChat', 'lorebook', 'authorNote', 'jailbreak', 'globalNote'];
    expect(await preset(nai)).toMatchObject({ formatingOrder: nai, main: '메인', globalNote: '노트', jailbreak: '탈옥' });
    // An order that never sends the jailbreak: kept, but not counted as taken.
    const unsent = await preset(['main', 'chats', 'globalNote', 'nonsense', 'main']);
    expect(unsent.formatingOrder).toEqual(['main', 'chats', 'globalNote']);
    expect(unsent.imported.map((part) => part.kind)).toEqual(['main', 'globalNote']);
  });

  it('keeps a template preset whole, as RisuAI sends one', async () => {
    const promptTemplate = [
      { type: 'plain', type2: 'main', text: '첫 메인', role: 'system' },
      { type: 'jailbreak', type2: 'normal', text: '앞 탈옥', role: 'system', name: '탈옥' },
      { type: 'plain', type2: 'normal', text: '문체', role: 'system', name: '문체' },
      { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
      { type: 'jailbreak', type2: 'normal', text: 'USER-JB', role: 'user', name: '사용자 탈옥' },
      { type: 'plain', type2: 'globalNote', text: '노트', role: 'system' },
      { type: 'plain', type2: 'main', text: 'PREFILL', role: 'assistant', name: '프리필' },
      { type: 'authornote', innerFormat: '[{{slot}}]', name: '작가 노트' },
      { type: 'chatML', text: '<|im_start|>system\nX<|im_end|>', name: 'ChatML' },
      { type: 'mystery', text: '모르는 항목' },
    ];
    const imported = await readReaderPresetFile('template.json', json({ mainPrompt: 'STALE-MAIN', promptTemplate }));
    expect(imported.promptTemplate).toEqual([
      { type: 'plain', type2: 'main', text: '첫 메인', role: 'system' },
      { type: 'jailbreak', type2: 'normal', text: '앞 탈옥', role: 'system', name: '탈옥' },
      { type: 'plain', type2: 'normal', text: '문체', role: 'system', name: '문체' },
      { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
      { type: 'jailbreak', type2: 'normal', text: 'USER-JB', role: 'user', name: '사용자 탈옥' },
      { type: 'plain', type2: 'globalNote', text: '노트', role: 'system' },
      // RisuAI's `normalizePromptRole`: an assistant is the bot.
      { type: 'plain', type2: 'main', text: 'PREFILL', role: 'bot', name: '프리필' },
      { type: 'authornote', innerFormat: '[{{slot}}]', name: '작가 노트' },
      { type: 'chatML', text: '<|im_start|>system\nX<|im_end|>', name: 'ChatML' },
    ]);
    expect(imported.imported).toEqual([
      { kind: 'main', name: '', into: 'template' },
      { kind: 'jailbreak', name: '탈옥', into: 'template' },
      { kind: 'normal', name: '문체', into: 'template' },
      { kind: 'jailbreak', name: '사용자 탈옥', into: 'template' },
      { kind: 'globalNote', name: '', into: 'template' },
      { kind: 'main', name: '프리필', into: 'template' },
      // Sent as RisuAI sends a ChatML item.
      { kind: 'normal', name: 'ChatML', into: 'template' },
    ]);
    expect(imported.ignoredPrompts).toEqual([]);
    // RisuAI keeps the fields a template stands in for; so does the import, which sends none of them.
    expect(imported.main).toBe('STALE-MAIN');
  });

  it('opens a .risup as RisuAI exports it (RPack, deflate, MessagePack, AES-GCM)', async () => {
    // Written by msgpackr 1.10.1 — RisuAI's own — through `downloadPreset`'s steps.
    const imported = await readReaderPresetFile('테스트_preset.risup', fixture('reader-preset.risup'));
    expect(imported).toMatchObject({ source: 'risuai', name: '테스트 프리셋', ignoredPrompts: ['CoT'], ignoredSettings: true });
    expect(imported.promptTemplate?.map((item) => item.type)).toEqual([
      'plain',
      'jailbreak',
      'plain',
      'description',
      'chat',
      'plain',
      'cot',
      'plain',
      'plain',
    ]);
    expect(imported.promptTemplate?.[0]).toMatchObject({ type2: 'main', name: '메인', text: 'MAIN-ONE {{char}}와 {{user}}의 이야기를 씁니다.' });
  });

  it('opens the older .risupreset, which is not RPacked and keeps its preset under `pres`', async () => {
    const imported = await readReaderPresetFile('old.risupreset', fixture('reader-preset-v0.risupreset'));
    expect(imported.promptTemplate?.[0]).toMatchObject({ text: expect.stringContaining('MAIN-ONE') });
    expect(imported.imported.map((part) => part.kind)).toEqual(['main', 'jailbreak', 'normal', 'globalNote', 'main', 'main']);
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
      { identifier: 'nsfw', name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: 'AUX-TEXT' },
      { identifier: 'jailbreak', name: 'Post-History Instructions', system_prompt: true, role: 'system', content: 'PHI 응답 직전' },
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

  it('takes Post-History Instructions as the global note, and leaves a disabled Auxiliary Prompt behind', async () => {
    const imported = await readReaderPresetFile('Celia v4.json', json(stPreset()));
    expect(imported).toEqual({
      source: 'sillytavern',
      name: 'Celia v4',
      main: 'ST 메인 {{char}}',
      globalNote: 'PHI 응답 직전',
      jailbreak: '',
      // RisuAI's default order sends the global note after the history, as ST sends Post-History Instructions.
      formatingOrder: [...RISU_DEFAULT_FORMATING_ORDER],
      promptTemplate: null,
      groupTemplate: '',
      groupOtherBotRole: 'user',
      toggles: '',
      moduleIntegration: '',
      defaultVariables: '',
      promptSettings: null,
      regex: [],
      imported: [
        { kind: 'main', name: 'Main Prompt', into: 'main' },
        { kind: 'jailbreak', name: 'Post-History Instructions', into: 'globalNote' },
      ],
      ignoredPrompts: ['문체 규칙'],
      ignoredSettings: true,
    });
    // Off in this order, so ST would not send it.
    expect(everything(imported)).not.toMatch(/AUX-TEXT|안 쓰인다/);
  });

  it('puts an enabled Auxiliary Prompt after the Main Prompt, by the names the file gives them', async () => {
    const preset = stPreset();
    const order = (preset.prompt_order[1] as { order: { identifier: string; enabled: boolean }[] }).order;
    order.find((entry) => entry.identifier === 'nsfw')!.enabled = true;
    preset.prompts.find((prompt) => prompt.identifier === 'nsfw')!.name = '보조';
    expect(await readReaderPresetFile('p.json', json(preset))).toMatchObject({
      main: 'ST 메인 {{char}}\n\nAUX-TEXT',
      globalNote: 'PHI 응답 직전',
      imported: [
        { kind: 'main', name: 'Main Prompt', into: 'main' },
        { kind: 'nsfw', name: '보조', into: 'main' },
        { kind: 'jailbreak', name: 'Post-History Instructions', into: 'globalNote' },
      ],
    });
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

/** A reader preset as it is stored: RisuAI's three texts, no template, its default order. */
const stored = {
  main: '독자의 메인',
  globalNote: '독자의 글로벌 노트',
  jailbreak: '',
  formatingOrder: null,
  promptTemplate: null,
  groupTemplate: '',
  groupOtherBotRole: 'user',
  promptSettings: null,
  regex: null,
};
const reader: PromptPreset = readerPromptPreset(stored);

const assemble = (characters: PromptCharacter[], extra: Partial<AssemblePromptInput> = {}) =>
  assemblePrompt({
    plot: { name: '서리 골짜기', description: '외딴 여관.', lorebook: [] },
    characters,
    history,
    preset: reader,
    userName: '민준',
    report: true,
    ...extra,
  });

const blockOf = (prompt: ReturnType<typeof assemble>, kind: string): string | undefined =>
  prompt.report!.blocks.find((block) => block.kind === kind)?.text;
const sentOf = (prompt: ReturnType<typeof assemble>): string =>
  [prompt.system, ...prompt.messages.map((message) => promptText(message.content))].join('\n');

describe('readerPromptPreset', () => {
  it('reads a row written before presets were RisuAI’s whole as RisuAI’s preset without a template', () => {
    expect(reader).toEqual({
      mainPrompt: '독자의 메인',
      jailbreak: '',
      globalNote: '독자의 글로벌 노트',
      formatingOrder: RISU_DEFAULT_FORMATING_ORDER,
      promptTemplate: null,
      groupTemplate: '',
      groupOtherBotRole: 'user',
    });
    expect(readerPromptPreset({ ...stored, formatingOrder: ['main', 'chats', 'bogus'], groupOtherBotRole: 'nobody' })).toMatchObject({
      formatingOrder: ['main', 'chats'],
      groupOtherBotRole: 'user',
    });
  });
});

describe('assemblePrompt — a reader preset', () => {
  it('replaces the built-in default whole, as picking a preset does in PocketRisu', () => {
    const prompt = assemble([member()]);
    expect(prompt.system.startsWith('독자의 메인\n\n서리 골짜기의 마녀.')).toBe(true);
    expect(sentOf(prompt)).not.toContain('<SYSTEM_RULE>');
    // RisuAI's default order: the global note after the newest turn.
    const texts = prompt.messages.map((message) => promptText(message.content));
    expect(texts.indexOf('독자의 글로벌 노트')).toBeGreaterThan(texts.indexOf('안녕.'));
    // The built-in default is OAI2.
    expect(assemble([member()], { preset: DEFAULT_PRESET }).system.startsWith('<SYSTEM_RULE>')).toBe(true);
  });

  it('gives way to a card’s own system prompt and post-history instructions, which bring it back only through {{original}}', () => {
    const own = assemble([member({ systemPrompt: '카드의 지시', postHistoryInstructions: '카드의 끝 지시' })]);
    expect(blockOf(own, 'main')).toBe('카드의 지시');
    expect(blockOf(own, 'global_note')).toBe('카드의 끝 지시');
    expect(sentOf(own)).not.toContain('독자의');

    const keeps = assemble([member({ systemPrompt: '카드의 지시 [{{original}}]', postHistoryInstructions: '카드의 끝 지시 [{{original}}]' })]);
    expect(blockOf(keeps, 'main')).toBe('카드의 지시 [독자의 메인]');
    expect(blockOf(keeps, 'global_note')).toBe('카드의 끝 지시 [독자의 글로벌 노트]');
  });

  it('under a template reads no card system prompt, as RisuAI reads none, and still the card’s global-note replacement', () => {
    const templated: PromptPreset = {
      ...reader,
      promptTemplate: [
        { type: 'plain', type2: 'main', text: '템플릿 메인', role: 'system' },
        { type: 'description' },
        { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
        { type: 'plain', type2: 'globalNote', text: '템플릿 노트', role: 'system' },
      ],
    };
    const prompt = assemble([member({ systemPrompt: '카드의 지시 [{{original}}]', postHistoryInstructions: '카드의 끝 [{{original}}]' })], {
      preset: templated,
    });
    expect(blockOf(prompt, 'main')).toBe('템플릿 메인');
    expect(sentOf(prompt)).not.toContain('카드의 지시');
    expect(blockOf(prompt, 'global_note')).toBe('카드의 끝 [템플릿 노트]');
    // The stale three texts of a template preset are never sent.
    expect(sentOf(prompt)).not.toContain('독자의');
    expect(prompt.risu?.template).toBe(true);
  });

  it('is not sent for a RisuAI utility bot, as RisuAI sends it RisuAI’s utility template', () => {
    const utility = member({ postHistoryInstructions: '도구 [{{original}}]', extensions: { risuai: { utilityBot: true } } });
    const prompt = assemble([utility]);
    expect(sentOf(prompt)).not.toContain('독자의');
    expect(blockOf(prompt, 'global_note')).toBe('도구 []');
    expect(prompt.system).not.toContain('Speech rules:');
  });

  it('teaches a group turn no protocol and sends the others in its group template', () => {
    const grouped = { ...stored, groupTemplate: '({{char}}) {{slot}}' };
    const prompt = assemble([{ ...member(), id: 'a' }, { ...member({}, '벨'), id: 'b' }], {
      preset: readerPromptPreset(grouped),
      speaker: 1,
      history: [...history, { role: 'assistant', content: '안녕, 벨.', speakerId: 'a' }],
    });
    expect(prompt.system).not.toContain('Speech rules:');
    expect(prompt.messages).toContainEqual({ role: 'user', content: '(아리아) 안녕, 벨.' });
    // A scene still is taught it, under the members' names.
    expect(assemble([member(), member({}, '벨')]).system).toContain(speechProtocol(['아리아', '벨']));
  });

  it('reads the card, the chat and the preset’s own texts through its macros, as RisuAI’s preset does', () => {
    const creator = member({
      description: 'CREATOR-DESC',
      systemPrompt: 'CREATOR-SYS [{{original}}]',
      postHistoryInstructions: 'CREATOR-PH [{{original}}]',
    });
    const prompt = assemble([creator], {
      preset: readerPromptPreset({
        ...stored,
        main: '{{char}}/{{user}} [{{description}}] [{{globalnote}}] [{{getvar::hp}}]',
        globalNote: 'GN {{user}}',
      }),
      variables: { hp: '10' },
    });
    // The card's own text, the preset's other texts and the chat's variables, read
    // where the preset asks for them — and the card's `{{original}}` is the preset's text, once.
    // The preset's {{char}} is RisuAI's: the work's one member.
    expect(blockOf(prompt, 'main')).toBe('CREATOR-SYS [아리아/민준 [CREATOR-DESC] [GN 민준] [10]]');
    expect(blockOf(prompt, 'global_note')).toBe('CREATOR-PH [GN 민준]');
    expect(sentOf(prompt).split('CREATOR-SYS')).toHaveLength(2);
  });

  it('reads the toggles its preset defines from the globals and the chat’s variables, and writes none', () => {
    const text =
      '{{#when::toggle::rain}}비가 온다{{:else}}맑다{{/when}} {{getglobalvar::toggle_mood}} {{setglobalvar::x::1}} {{getvar::hp}}';
    const prompt = assemble([member()], {
      preset: readerPromptPreset({ ...stored, main: text }),
      globalVariables: { toggle_rain: '1', toggle_mood: '어둡게' },
      variables: { hp: '10' },
    });
    // A write is a word outside SillyTavern's text, as in any prompt text of RisuAI's.
    expect(blockOf(prompt, 'main')).toBe('비가 온다 어둡게 {{setglobalvar::x::1}} 10');
    expect(prompt.globalVariableWrites).toBeUndefined();
  });

  it('reads {{prefill_supported}} as RisuAI does on a model that takes no prefill', () => {
    const prompt = assemble([member()], { preset: DEFAULT_PRESET, model: { id: 'gpt', prefill: false } });
    expect(sentOf(prompt)).not.toContain('Roleplay response:');
    expect(prompt.messages.at(-1)!.role).toBe('system');
  });
});
