/**
 * RisuAI's prompt and lorebook, pinned to what its own code does (kwaroran/Risuai
 * main e773240): `src/ts/process/index.svelte.ts` (`sendChat`),
 * `lorebook.svelte.ts` (`loadLoreBookV3Prompt`), `exampleMessages.ts`,
 * `parser/chatML.ts` and ccardlib's decorator parser. Where a piece of RisuAI's
 * code runs on its own, it is the oracle: copied here as it is, or — ccardlib —
 * called from its package.
 */
import { CCardLib } from '@risuai/ccardlib';
import { describe, expect, it } from 'vitest';
import { exportCardV3 } from '../src/card/export.js';
import { normalizeCard } from '../src/card/normalize.js';
import { parseDecorators } from '../src/card/bookEntry.js';
import { activateLore } from '../src/lorebook.js';
import { normalizePromptSettings, parseChatML, type PromptPreset, type PromptTemplateItem } from '../src/presets.js';
import {
  assemblePrompt,
  assetPromptNames,
  CONTINUE_LINE,
  NEW_CHAT_SEPARATOR,
  promptText,
  type AssemblePromptInput,
  type HistoryMessage,
  type PromptCharacter,
  type PromptPlot,
} from '../src/prompt.js';
import { JAILBREAK_TOGGLE_VARIABLE, jailbreakToggled, presetHasJailbreak } from '../src/toggles.js';
import { DEFAULT_LORE_SETTINGS, type LoreEntry, type NormalizedCard } from '../src/types.js';

const card: NormalizedCard = {
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
  loreSettings: { ...DEFAULT_LORE_SETTINGS, risuMatching: true },
  extensions: {},
  raw: null,
};
const plot: PromptPlot = { name: '골짜기', description: '', lorebook: [] };
const lore = (overrides: Partial<LoreEntry> & { content: string }): LoreEntry => ({
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
const member = (overrides: Partial<NormalizedCard> = {}): PromptCharacter => ({ name: '아리아', card: { ...card, ...overrides } });
/** A template that is the chat, then what follows it: RisuAI's chat block laid bare. */
const bare = (items: PromptTemplateItem[] = [], extra: Partial<PromptPreset> = {}): PromptPreset => ({
  mainPrompt: '',
  jailbreak: '',
  globalNote: '',
  formatingOrder: [],
  promptTemplate: [...items, { type: 'chat', rangeStart: 0, rangeEnd: 'end' }, { type: 'postEverything' }],
  groupTemplate: '',
  groupOtherBotRole: 'user',
  ...extra,
});
const history: HistoryMessage[] = [
  { role: 'assistant', content: '인사.', id: 'g' },
  { role: 'user', content: '하나.', id: 'm1' },
  { role: 'assistant', content: '둘.', id: 'm2' },
  { role: 'user', content: '셋.', id: 'm3' },
];
const opening = { length: 4, greeting: { text: '인사.', index: -1 } };
const assemble = (input: Partial<AssemblePromptInput>) =>
  assemblePrompt({ plot, characters: [member()], history, branch: opening, userName: '민준', preset: bare(), ...input });
const texts = (prompt: { messages: { content: string | unknown[] }[] }): string[] =>
  prompt.messages.map((message) => promptText(message.content as never));

describe("decorators, as RisuAI's lorebook reads them through ccardlib", () => {
  it('leaves the same body as ccardlib’s own parser', () => {
    const contents = [
      '@@depth 2\n@@role user\n본문',
      '  @@@end\n@@@depth 3\n\n본문  ',
      '@@instruct_depth 1\n@@@depth 2\n본문\n@@depth 4',
      '@@role narrator\n@@@role user\n  본문  ',
      '@@\n@@ x\n본문',
      '@@depth 1',
      '',
      '본문만',
    ];
    for (const content of contents) {
      expect(parseDecorators(content).body, content).toBe(CCardLib.decorator.parse(content, () => false));
    }
  });

  it('calls each decorator with ccardlib’s name and comma-split arguments', () => {
    const calls: [string, string[]][] = [];
    CCardLib.decorator.parse('@@inject_lore 왕궁, 지도\n@@position pt_A\n본문', (name, args) => {
      calls.push([name, args]);
      return undefined;
    });
    expect(calls).toEqual([
      ['inject_lore', ['왕궁', '지도']],
      ['position', ['pt_A']],
    ]);
    expect(parseDecorators('@@inject_lore 왕궁, 지도\n@@position pt_A\n본문').decorators).toEqual({
      inject: { operation: 'append', location: '왕궁 지도', param: '', lore: true },
      pos: 'pt_A',
    });
  });

  it('reads every decorator onto the entry an import keeps, and writes them back out', () => {
    const raw = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '아리아',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        group_only_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: { risuai: {} },
        character_book: {
          extensions: { risu_fullWordMatching: false },
          entries: [
            {
              keys: ['왕'],
              content:
                '@@depth 3\n@@role assistant\n@@activate_only_every 2\n@@is_greeting 1\n@@priority 9\n@@recursive\n@@match_full_word\n왕의 이야기',
              extensions: {},
              enabled: true,
              insertion_order: 5,
              use_regex: false,
            },
            {
              keys: ['지도'],
              content: '@@position pt_지도\n@@inject_at globalNote\n@@inject_replace [자리]\n지도 이야기',
              extensions: {},
              enabled: true,
              insertion_order: 1,
              use_regex: false,
            },
          ],
        },
      },
    };
    const [king, map] = normalizeCard(raw).lorebook;
    expect(king).toMatchObject({
      content: '왕의 이야기',
      depth: 3,
      role: 'assistant',
      risu: { depthFrom: 'start', every: 2, greeting: 1, priority: 9, recursive: true, fullWord: true },
    });
    expect(map).toMatchObject({
      content: '지도 이야기',
      positioned: true,
      risu: { slot: '지도', inject: { operation: 'replace', location: 'globalNote', param: '[자리]', lore: false } },
    });
    // Our export writes them back as RisuAI's decorators, which read back the same.
    const again = normalizeCard(exportCardV3(normalizeCard(raw))).lorebook;
    expect(again.map((entry) => entry.risu)).toEqual([king!.risu, map!.risu]);
    expect(again.map((entry) => entry.content)).toEqual(['왕의 이야기', '지도 이야기']);
  });
});

/**
 * RisuAI's budget and order (`loadLoreBookV3Prompt`, lorebook.svelte.ts:613–667):
 * sorted by priority, highest first, paid for while it fits, sorted by order,
 * highest first, and turned round.
 */
function risuBudget(actives: { name: string; order: number; priority: number; tokens: number }[], budget: number): string[] {
  const activesSorted = [...actives].sort((a, b) => b.priority - a.priority);
  let usedTokens = 0;
  const activesFiltered = activesSorted.filter((act) => {
    if (usedTokens + act.tokens <= budget) {
      usedTokens += act.tokens;
      return true;
    }
    return false;
  });
  return activesFiltered.sort((a, b) => b.order - a.order).reverse().map((act) => act.name);
}

describe("the lore's budget and order, as RisuAI's", () => {
  const book = [
    { name: 'a', order: 2, priority: 2, tokens: 3 },
    { name: 'b', order: 1, priority: 1, tokens: 2 },
    { name: 'c', order: 2, priority: 2, tokens: 1 },
    { name: 'd', order: 0, priority: 50, tokens: 4 },
    { name: 'e', order: 1, priority: -1000, tokens: 1 },
    { name: 'f', order: 1, priority: 1, tokens: 2 },
  ];
  const run = (budget: number): string[] =>
    activateLore(
      book.map(({ name, order, priority }) =>
        lore({ content: name, insertionOrder: order, ...(priority !== order ? { risu: { priority } } : {}) }),
      ),
      {
        history: [],
        scanDepth: 5,
        budgetTokens: budget,
        countTokens: (text) => book.find((entry) => entry.name === text)!.tokens,
      },
    ).entries.map((entry) => entry.content);

  it('pays for the highest priority first, and sends lowest order first, ties reversed', () => {
    for (const budget of [100, 10, 7, 5, 1]) expect(run(budget), String(budget)).toEqual(risuBudget(book, budget));
  });
});

describe("RisuAI's own lore conditions", () => {
  const fires = (entry: LoreEntry, input: Partial<Parameters<typeof activateLore>[1]> = {}): boolean =>
    activateLore([entry], { history: [], scanDepth: 5, budgetTokens: 1000, countTokens: () => 1, ...input }).entries.length === 1;

  it('reads @@activate_only_every against the chat’s length', () => {
    const every = lore({ content: 'x', risu: { every: 3 } });
    expect(fires(every, { timed: { chatLength: 6, lastTriggered: {} } })).toBe(true);
    expect(fires(every, { timed: { chatLength: 7, lastTriggered: {} } })).toBe(false);
  });

  it('reads @@is_greeting against the intro the branch opened on, RisuAI’s fmIndex + 1', () => {
    const second = lore({ content: 'x', risu: { greeting: 1 } });
    expect(fires(second, { openingIndex: 0 })).toBe(true);
    expect(fires(second, { openingIndex: -1 })).toBe(false);
    expect(fires(lore({ content: 'x', risu: { greeting: 0 } }))).toBe(true);
  });

  it('matches whole words where the book or the entry asks, as RisuAI splits a message on spaces', () => {
    const cat = lore({ content: 'x', constant: false, keys: ['Cat'] });
    expect(fires(cat, { history: ['the CAT sat'], fullWordMatching: true })).toBe(true);
    expect(fires(cat, { history: ['category'], fullWordMatching: true })).toBe(false);
    expect(fires({ ...cat, risu: { fullWord: true } }, { history: ['category'] })).toBe(false);
    expect(fires({ ...cat, risu: { fullWord: false } }, { history: ['category'], fullWordMatching: true, risuMatching: true })).toBe(true);
  });

  it('scans what a @@recursive entry says again in a book that does not recurse', () => {
    const caller = lore({ content: 'B를 부른다', constant: false, keys: ['시작'] });
    const called = lore({ content: 'B', constant: false, keys: ['B를'] });
    const run = (first: LoreEntry) =>
      activateLore([first, called], { history: ['시작'], scanDepth: 5, budgetTokens: 1000, countTokens: () => 1 }).entries.map(
        (entry) => entry.content,
      );
    expect(run(caller)).toEqual(['B를 부른다']);
    // Both of order 0: sent in the reverse of the order they activated in.
    expect(run({ ...caller, risu: { recursive: true } })).toEqual(['B', 'B를 부른다']);
  });
});

/** RisuAI's depth lore splice (`sendChat`, index.svelte.ts:1188–1195), over the chat block's texts. */
function risuSplice(chats: string[], depthPrompts: { pos: 'depth' | 'reverse_depth'; depth: number; content: string }[]): string[] {
  const out = [...chats];
  for (const depthPrompt of depthPrompts) {
    const depth = depthPrompt.pos === 'depth' ? depthPrompt.depth : out.length - depthPrompt.depth;
    out.splice(depth, 0, depthPrompt.content);
  }
  return out;
}

describe("the depth lore, where RisuAI's sendChat splices it", () => {
  const examples = member({ mesExample: '<START>\n{{user}}: 질문\n{{char}}: 답' });
  const withLore = (entries: LoreEntry[]) =>
    assemble({ characters: [{ ...examples, card: { ...examples.card, lorebook: entries } }] });

  it('counts @@depth from the start of the chat block and @@reverse_depth from its end, one entry after another', () => {
    const block = texts(withLore([]));
    const entries = [
      lore({ content: 'D2', depth: 2, risu: { depthFrom: 'start' }, insertionOrder: 1 }),
      lore({ content: 'R1', depth: 1, risu: { depthFrom: 'end' }, insertionOrder: 2 }),
      lore({ content: 'D2b', depth: 2, risu: { depthFrom: 'start' }, insertionOrder: 3 }),
      lore({ content: 'D99', depth: 99, risu: { depthFrom: 'start' }, insertionOrder: 4 }),
    ];
    const chat = block.slice(0, block.indexOf('셋.') + 1);
    const after = block.slice(chat.length);
    expect(texts(withLore(entries))).toEqual([
      ...risuSplice(chat, [
        { pos: 'depth', depth: 2, content: 'D2' },
        { pos: 'reverse_depth', depth: 1, content: 'R1' },
        { pos: 'depth', depth: 2, content: 'D2b' },
        { pos: 'depth', depth: 99, content: 'D99' },
      ]),
      ...after,
    ]);
    // The chat block holds the example's turns, the separator and the greeting.
    expect(chat.slice(0, 5)).toEqual([NEW_CHAT_SEPARATOR, '질문', '답', NEW_CHAT_SEPARATOR, '인사.']);
  });

  it('sends @@depth 0 and @@end after everything, the assistant’s last', () => {
    const prompt = withLore([
      lore({ content: 'PREFILL', depth: 0, role: 'assistant', risu: { depthFrom: 'start' }, insertionOrder: 1 }),
      lore({ content: 'END', depth: 0, risu: { depthFrom: 'start' }, insertionOrder: 2 }),
    ]);
    expect(texts(prompt).slice(-2)).toEqual(['END', 'PREFILL']);
    expect(prompt.messages.at(-1)!.role).toBe('assistant');
  });

  it('keeps SillyTavern’s at-depth lore counted from the end of the history', () => {
    const prompt = withLore([lore({ content: 'ST1', depth: 1 })]);
    const sent = texts(prompt);
    expect(sent.indexOf('ST1')).toBe(sent.indexOf('셋.') - 1);
  });
});

describe("RisuAI's lore placements and slots", () => {
  const template = (text: string): PromptPreset =>
    bare([
      { type: 'plain', type2: 'main', text, role: 'system' },
      { type: 'description', innerFormat: '[D]{{slot}}' },
      { type: 'lorebook' },
      { type: 'plain', type2: 'globalNote', text: 'GN', role: 'system' },
    ]);

  it('fills {{position::name}} with the lore positioned there, five slots deep, and never sends one as written', () => {
    const prompt = assemble({
      preset: template('앞 {{position::자리}} 뒤 {{position::없음}}.'),
      characters: [
        member({
          lorebook: [
            lore({ content: '자리 글 {{position::안}}', risu: { slot: '자리' }, positioned: true }),
            lore({ content: '안쪽', risu: { slot: '안' }, positioned: true }),
            lore({ content: '로어의 {{position::자리}}', insertionOrder: 1 }),
          ],
        }),
      ],
    });
    expect(prompt.system).toContain('앞 자리 글 안쪽 뒤 .');
    expect(prompt.system).toContain('로어의 자리 글 안쪽');
    expect(prompt.system).not.toContain('{{position::');
    // A slot's own entries go nowhere else.
    expect(prompt.system.split('안쪽')).toHaveLength(3);
  });

  it('puts @@position personality and scenario after the description, and before_desc entries before it in reverse', () => {
    const prompt = assemble({
      preset: template('MAIN'),
      characters: [
        member({
          lorebook: [
            lore({ content: 'B1', position: 'before_char', positioned: true, insertionOrder: 1 }),
            lore({ content: 'B2', position: 'before_char', positioned: true, insertionOrder: 2 }),
            lore({ content: 'AFTER', position: 'after_char', positioned: true }),
          ],
        }),
      ],
    });
    const parts = prompt.risu!.system[0]!.text.split('\n\n');
    expect(parts.slice(1, 5)).toEqual(['[D]B2', '[D]B1', '[D]서리 골짜기의 마녀.', '[D]AFTER']);
  });

  it('merges @@inject_lore into the entry it names, and @@inject_at into the template item of its place', () => {
    const prompt = assemble({
      preset: template('MAIN [자리]'),
      characters: [
        member({
          lorebook: [
            lore({ content: '대상', name: '왕궁' }),
            lore({ content: '덧붙임', risu: { inject: { operation: 'append', location: '왕궁', param: '', lore: true } } }),
            lore({ content: '앞에', risu: { inject: { operation: 'prepend', location: '왕궁', param: '', lore: true } } }),
            lore({ content: '메인에', risu: { inject: { operation: 'replace', location: 'main', param: '[자리]', lore: false } } }),
            lore({ content: '노트에', risu: { inject: { operation: 'append', location: 'globalNote', param: '', lore: false } } }),
          ],
        }),
      ],
    });
    expect(prompt.system).toContain('앞에 대상 덧붙임');
    expect(prompt.system.startsWith('MAIN 메인에')).toBe(true);
    expect(prompt.system).toContain('GN 노트에');
    // Neither goes into the lorebook slot of its own.
    expect(prompt.system.split('노트에')).toHaveLength(2);
    expect(prompt.system.split('덧붙임')).toHaveLength(2);
  });

  it('sends a @@role entry in its role wherever it goes', () => {
    const prompt = assemble({
      preset: bare([{ type: 'lorebook' }]),
      characters: [member({ lorebook: [lore({ content: '유저의 말', role: 'user' })] })],
    });
    expect(prompt.messages[0]).toEqual({ role: 'user', content: '유저의 말' });
  });
});

describe("RisuAI's examples, thoughts and pictures in the chat", () => {
  /** RisuAI's `exampleMessage` (exampleMessages.ts), the macros left to the caller. */
  function risuExamples(exampleMessage: string, charName: string): { role: string; content: string; name?: string }[] {
    const result: { role: string; content: string; name?: string }[] = [];
    let current: { role: string; content: string; name?: string } | null = null;
    const add = (): void => {
      if (current) result.push(current);
    };
    for (const mes of exampleMessage.split('\n')) {
      const trimed = mes.trim();
      const lowered = trimed.toLocaleLowerCase();
      if (lowered === '<start>') {
        add();
        result.push({ role: 'system', content: '[Start a new chat]' });
        current = null;
      } else if (lowered.startsWith('{{char}}:') || lowered.startsWith('<bot>:') || lowered.startsWith(`${charName}:`)) {
        add();
        current = { role: 'assistant', content: trimed.split(':', 2)[1]!.trimStart(), name: 'example_assistant' };
      } else if (lowered.startsWith('{{user}}:') || lowered.startsWith('<user>:')) {
        add();
        current = { role: 'user', content: trimed.split(':', 2)[1]!.trimStart(), name: 'example_user' };
      } else if (current) {
        current.content += '\n' + trimed;
      }
    }
    add();
    return result;
  }

  it('sends the examples as RisuAI’s turns', () => {
    const mesExample = '<START>\n{{user}}: 질문\n{{char}}: 답\n  이어서\n<START>\n<bot>: 혼잣말';
    const prompt = assemble({ characters: [member({ mesExample })], history: [], branch: { length: 0 } });
    const turns = risuExamples(mesExample, '아리아');
    expect(prompt.messages.slice(0, turns.length).map((message, at) => ({
      role: message.role,
      content: promptText(message.content),
      ...(prompt.sources![at]!.name ? { name: prompt.sources![at]!.name } : {}),
    }))).toEqual(turns.map((turn) => ({ ...turn, content: turn.content.trim() })));
  });

  it('lifts <Thoughts> out of every turn of the chat but the greeting', () => {
    const prompt = assemble({
      history: [
        { role: 'assistant', content: '<Thoughts>인사 생각</Thoughts>인사.' },
        { role: 'user', content: '하나.' },
        { role: 'assistant', content: '<Thoughts>첫\n생각</Thoughts>대답<Thoughts>둘</Thoughts>끝' },
      ],
      branch: { length: 3, greeting: { text: '<Thoughts>인사 생각</Thoughts>인사.', index: -1 } },
    });
    const sent = texts(prompt);
    expect(sent).toContain('<Thoughts>인사 생각</Thoughts>인사.');
    // RisuAI's pattern is greedy: the first <Thoughts> to the last </Thoughts>, the words between them too.
    expect(sent).toContain('끝');
    expect(sent.join('\n')).not.toContain('대답');
  });

  it('sends the picture {{asset_prompt::name}} names with its turn, and drops the macro either way', () => {
    const picture = 'data:image/png;base64,AAAA';
    const turn: HistoryMessage = { role: 'user', content: '보세요 {{asset_prompt::그림}} {{AssetPrompt::없음}}' };
    expect(assetPromptNames(turn.content)).toEqual(['그림', '없음']);
    const sent = assemble({ history: [turn], branch: { length: 1 }, assetPrompts: new Map([['그림', picture]]) });
    expect(sent.messages.find((message) => message.role === 'user')!.content).toEqual([
      { type: 'text', text: '보세요  ' },
      { type: 'image', url: picture },
    ]);
    const blind = assemble({ history: [turn], branch: { length: 1 } });
    expect(blind.messages.find((message) => message.role === 'user')!.content).toBe('보세요  ');
  });
});

describe("RisuAI's continue, system turns and jailbreak", () => {
  it('tells a gpt model to continue, after everything', () => {
    // Run into the system turns before it, as RisuAI's pushPrompts runs them for that model.
    expect(texts(assemble({ continuing: true, modelKind: 'gpt' })).at(-1)!.endsWith(`\n\n${CONTINUE_LINE}`)).toBe(true);
    expect(texts(assemble({ continuing: true }))).not.toContain(CONTINUE_LINE);
    expect(texts(assemble({ modelKind: 'gpt' }))).not.toContain(CONTINUE_LINE);
  });

  it('runs consecutive system turns together for a gpt model, as pushPrompts does', () => {
    const preset = bare([], {});
    const twoAfter: PromptPreset = {
      ...preset,
      promptTemplate: [
        ...preset.promptTemplate!,
        { type: 'plain', type2: 'normal', text: 'A', role: 'system' },
        { type: 'plain', type2: 'normal', text: 'B', role: 'system' },
      ],
    };
    expect(texts(assemble({ preset: twoAfter })).slice(-2)).toEqual(['A', 'B']);
    const merged = texts(assemble({ preset: twoAfter, modelKind: 'gpt' }));
    expect(merged.at(-1)!.endsWith('\n\nA\n\nB')).toBe(true);
    expect(merged.at(-2)).toBe('셋.');
  });

  it('sends a jailbreak only while the toggle is on, and says which presets have one', () => {
    const jailbroken = bare([{ type: 'jailbreak', type2: 'normal', text: 'JB {{jbtoggled}}', role: 'system' }]);
    expect(assemble({ preset: jailbroken }).system).not.toContain('JB');
    expect(assemble({ preset: jailbroken, jailbreak: true }).system.startsWith('JB 1')).toBe(true);
    const legacy: PromptPreset = { ...bare(), promptTemplate: null, jailbreak: 'OLD JB', formatingOrder: ['chats', 'lastChat', 'jailbreak'] };
    expect(texts(assemble({ preset: legacy })).join('\n')).not.toContain('OLD JB');
    expect(texts(assemble({ preset: legacy, jailbreak: true }))).toContain('OLD JB');
    expect(presetHasJailbreak(jailbroken)).toBe(true);
    expect(presetHasJailbreak(legacy)).toBe(true);
    expect(presetHasJailbreak({ ...legacy, jailbreak: ' ' })).toBe(false);
    expect(presetHasJailbreak(bare([{ type: 'plain', type2: 'normal', text: '{{jbtoggled}}', role: 'system' }]))).toBe(true);
    expect(jailbreakToggled({ [JAILBREAK_TOGGLE_VARIABLE]: '1' })).toBe(true);
    expect(jailbreakToggled({ [JAILBREAK_TOGGLE_VARIABLE]: '0' })).toBe(false);
  });
});

/** RisuAI's `systemizeChat` (index.svelte.ts:2210). */
function risuSystemize(chats: { role: string; content: string; name?: string; nameAdded?: boolean }[]): { role: string; content: string }[] {
  return chats.map((chat) => {
    if (chat.role !== 'user' && chat.role !== 'assistant') return { role: chat.role, content: chat.content };
    if (chat.name?.startsWith('example_')) return { role: 'system', content: `${chat.name}: ${chat.content}` };
    if (!chat.nameAdded) return { role: 'system', content: `${chat.role}: ${chat.content}` };
    return { role: 'system', content: chat.content };
  });
}

describe("RisuAI's prompt settings", () => {
  const settled = (promptSettings: PromptPreset['promptSettings']) => bare([], { promptSettings });

  it('sends the chat as the system’s, sendChatAsSystem, as systemizeChat writes it', () => {
    const chatted = member({ mesExample: '<START>\n{{user}}: 질문' });
    const plain = assemble({ characters: [chatted] });
    const systemized = assemble({ characters: [chatted], preset: settled({ sendChatAsSystem: true }) });
    const asRisu = risuSystemize(
      plain.messages.map((message, at) => ({
        role: message.role,
        content: promptText(message.content),
        ...(plain.sources![at]!.name ? { name: plain.sources![at]!.name } : {}),
      })),
    );
    expect(systemized.messages.map((message) => ({ role: message.role, content: promptText(message.content) }))).toEqual(asRisu);
  });

  it('sends names, sendName: the greeting under the character’s, every other turn in the group template', () => {
    const sent = assemble({ preset: settled({ sendName: true }) });
    expect(sent.messages.slice(1, 3)).toEqual([
      { role: 'assistant', content: '아리아: 인사.' },
      { role: 'user', content: "<아리아's Message>\n하나.\n</아리아's Message>" },
    ]);
  });

  it('trims the chat’s separator, writes the post-end format after everything, and lets a template stand in for a utility bot', () => {
    expect(texts(assemble({ preset: settled({ trimStartNewChat: true }) }))).not.toContain(NEW_CHAT_SEPARATOR);
    expect(texts(assemble({ modelKind: 'novelai' }))).not.toContain(NEW_CHAT_SEPARATOR);
    expect(texts(assemble({ preset: settled({ postEndInnerFormat: '끝 {{char}}' }) })).at(-1)).toBe('끝 {{char}}');
    const utility = member({ extensions: { risuai: { utilityBot: true } } });
    const main = bare([{ type: 'plain', type2: 'main', text: 'TEMPLATE MAIN', role: 'system' }], { promptSettings: { utilOverride: true } });
    expect(assemble({ characters: [utility], preset: main }).system).toContain('TEMPLATE MAIN');
    expect(assemble({ characters: [utility], preset: { ...main, promptSettings: {} } }).system).not.toContain('TEMPLATE MAIN');
  });

  it('reads the settings a preset file carries, as RisuAI saves them', () => {
    expect(
      normalizePromptSettings({
        assistantPrefill: 'x',
        postEndInnerFormat: 'P',
        sendChatAsSystem: true,
        sendName: false,
        utilOverride: true,
        customChainOfThought: true,
        maxThoughtTagDepth: -1,
        trimStartNewChat: true,
      }),
    ).toEqual({ postEndInnerFormat: 'P', sendChatAsSystem: true, utilOverride: true, trimStartNewChat: true });
    expect(normalizePromptSettings({ maxThoughtTagDepth: -1 })).toBeUndefined();
  });
});

/** RisuAI's `parseChatML` (parser/chatML.ts), its macros left out. */
function risuChatML(data: string): { role: string; content: string }[] | null {
  const starter = '<|im_start|>';
  const seperator = '<|im_sep|>';
  const ender = '<|im_end|>';
  const trimedData = data.trim();
  if (!trimedData.startsWith(starter)) return null;
  return trimedData
    .split(starter)
    .filter((f) => f !== '')
    .map((v) => {
      let role = 'user';
      if (v.startsWith('user' + seperator)) {
        role = 'user';
        v = v.substring(4 + seperator.length);
      } else if (v.startsWith('system' + seperator)) {
        role = 'system';
        v = v.substring(6 + seperator.length);
      } else if (v.startsWith('assistant' + seperator)) {
        role = 'assistant';
        v = v.substring(9 + seperator.length);
      } else if (v.startsWith('user ') || v.startsWith('user\n')) {
        role = 'user';
        v = v.substring(5);
      } else if (v.startsWith('system ') || v.startsWith('system\n')) {
        role = 'system';
        v = v.substring(7);
      } else if (v.startsWith('assistant ') || v.startsWith('assistant\n')) {
        role = 'assistant';
        v = v.substring(10);
      }
      v = v.trim();
      if (v.endsWith(ender)) v = v.substring(0, v.length - ender.length);
      v = v.replace(/<Thoughts>(.+)<\/Thoughts>/gms, () => '');
      return { role, content: v };
    });
}

describe("RisuAI's ChatML items", () => {
  const chatML = '<|im_start|>system\n규칙<|im_end|>\n<|im_start|>user<|im_sep|>질문 {{user}}<|im_end|>\n<|im_start|>assistant 답<Thoughts>속</Thoughts>';

  it('reads a ChatML text as RisuAI’s parser does, and sends its messages where the item stands', () => {
    expect(parseChatML(chatML)).toEqual(risuChatML(chatML));
    expect(parseChatML('그냥 글')).toBeNull();
    const prompt = assemble({ preset: bare([{ type: 'chatML', text: chatML }]) });
    expect(prompt.system.startsWith('규칙\n\nSpeech rules:')).toBe(true);
    expect(prompt.messages.slice(0, 2)).toEqual([
      { role: 'user', content: '질문 민준' },
      { role: 'assistant', content: '답' },
    ]);
  });
});

describe("a card's Additional Text and image-tag instruction", () => {
  it('sends the Additional Text found for the chat after the description', () => {
    const prompt = assemble({
      preset: bare([{ type: 'description' }]),
      characters: [{ ...member({ personality: '무뚝뚝하다.' }), additionalText: '찾은 글 {{char}}' }],
    });
    expect(prompt.system).toBe('서리 골짜기의 마녀.\n\n찾은 글 아리아\n\nDescription of 아리아: 무뚝뚝하다.' + prompt.system.slice(prompt.system.indexOf('\n\nSpeech rules:')));
  });

  it("closes a template's global note on RisuAI's image-tag instruction where the card asks, listing its pictures", () => {
    const illustrated = member({ extensions: { risuai: { prebuiltAssetCommand: true } } });
    const note = (text: string) => bare([{ type: 'plain', type2: 'globalNote', text, role: 'system' }]);
    const prompt = assemble({ characters: [illustrated], preset: note('GN'), assetNames: ['웃음', '울음'] });
    expect(prompt.system).toContain('GN\n<Image Tag Instruction>');
    expect(prompt.system).toContain('<keywords>웃음,울음</keywords>');
    expect(prompt.system).toContain('Example: <img src="웃음">');
    // Not where the item writes its own, nor without the card asking, nor without a template.
    expect(assemble({ characters: [illustrated], preset: note('{{//@customimageinstruction}}GN'), assetNames: ['웃음'] }).system).not.toContain(
      '<Image Tag Instruction>',
    );
    expect(assemble({ preset: note('GN'), assetNames: ['웃음'] }).system).not.toContain('<Image Tag Instruction>');
    const legacy: PromptPreset = { ...bare(), promptTemplate: null, globalNote: 'GN', formatingOrder: ['chats', 'lastChat', 'globalNote'] };
    expect(texts(assemble({ characters: [illustrated], preset: legacy, assetNames: ['웃음'] })).join('\n')).not.toContain('<Image Tag Instruction>');
  });
});

/** RisuAI's `cache` item (`sendChat`, index.svelte.ts:1445–1458), over the roles of what was pushed before it. */
function risuCachePoints(roles: string[], item: { depth: number; role: string }): boolean[] {
  const marked = roles.map(() => false);
  let pointer = roles.length - 1;
  let depthRemaining = item.depth;
  while (pointer >= 0) {
    if (depthRemaining === 0) break;
    if (roles[pointer] === item.role || item.role === 'all') {
      marked[pointer] = true;
      depthRemaining--;
    }
    pointer--;
  }
  return marked;
}

describe("RisuAI's cache item", () => {
  it('marks the turns RisuAI marks as the prompt cache’s points, and the inspector shows them', () => {
    for (const item of [
      { type: 'cache' as const, depth: 2, role: 'user' as const },
      { type: 'cache' as const, depth: 3, role: 'all' as const },
      { type: 'cache' as const, depth: 9, role: 'assistant' as const },
    ]) {
      const preset: PromptPreset = { ...bare(), promptTemplate: [{ type: 'chat', rangeStart: 0, rangeEnd: 'end' }, item, { type: 'postEverything' }] };
      const prompt = assemble({ preset, report: true });
      const before = prompt.messages.slice(0, prompt.messages.findIndex((message) => message.content === '셋.') + 1);
      expect(prompt.messages.map((message) => message.cachePoint === true), item.role).toEqual([
        ...risuCachePoints(before.map((message) => message.role), item),
        ...prompt.messages.slice(before.length).map(() => false),
      ]);
      const blocks = prompt.report!.blocks.slice(-prompt.messages.length);
      expect(blocks.map((block) => block.cachePoint === true)).toEqual(prompt.messages.map((message) => message.cachePoint === true));
    }
  });

  it('says when the system string holds a marked turn, which it has no room to mark', () => {
    const preset = bare([{ type: 'plain', type2: 'normal', text: '규칙', role: 'system' }, { type: 'cache', depth: 1, role: 'system' }]);
    expect(assemble({ preset }).systemCachePoint).toBe(true);
    expect(assemble({}).systemCachePoint).toBeUndefined();
  });
});
