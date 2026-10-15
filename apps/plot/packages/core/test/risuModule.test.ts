/**
 * A RisuAI module brought into a work on its own (`card/risuModule.ts`), and
 * what the work's modules add to the scripts a member runs (`cardScripts`).
 */
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  indicatorLore,
  ModuleParseError,
  parseRisuModule,
  plotModuleOf,
  risuLoreBookEntry,
} from '../src/card/risuModule.js';
import { assemblePrompt, type PromptCharacter, type PromptPlot } from '../src/prompt.js';
import { cardScripts, runTriggersSync, scriptedMember } from '../src/triggers/index.js';
import { DEFAULT_LORE_SETTINGS, type NormalizedCard, type PlotModule } from '../src/types.js';
import { buildCharx } from './helpers/charx.js';
import { buildRisum } from './helpers/risum.js';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const risuModule = {
  name: '날씨 모듈',
  description: '비가 온다.',
  id: 'risu-id',
  lowLevelAccess: true,
  backgroundEmbedding: '<style>.rain{color:blue}</style><div class="rain">비</div>',
  regex: [
    { comment: '표시', in: '비', out: '<b>비</b>', type: 'editdisplay', ableFlag: false },
    { comment: '입력', in: 'a', out: 'b', type: 'editinput', ableFlag: false },
    { comment: '프롬프트', in: 'x', out: 'y', type: 'editprocess', ableFlag: false },
  ],
  trigger: [{ comment: '시작', type: 'start', conditions: [], effect: [{ type: 'setvar', var: 'rain', value: '1', operator: '=' }] }],
  lorebook: [
    { key: '우산, 장화', secondkey: '', insertorder: 3, comment: '우산', content: '우산은 파랗다.', mode: 'normal', alwaysActive: false, selective: false },
    { key: '', secondkey: '', insertorder: 0, comment: '날씨', content: '@@depth 2\n비가 내린다.', mode: 'normal', alwaysActive: true, selective: false },
    { key: '/구름\\d/i', secondkey: '', insertorder: 0, comment: '정규식', content: '구름', mode: 'normal', alwaysActive: false, selective: false, useRegex: true },
  ],
  assets: [
    ['rain', '', 'png'],
    ['song', '', 'mp3'],
    ['cloud', '', 'png'],
    ['notes', '', 'txt'],
  ],
};

describe('parseRisuModule', () => {
  it('reads a .risum whole: its lore as entries, its scripts as written, its pictures by position', () => {
    const file = buildRisum({ module: risuModule, type: 'risuModule' }, [png, Uint8Array.from([9]), png, Uint8Array.from([7])]);
    const parsed = parseRisuModule(file);
    expect(parsed.name).toBe('날씨 모듈');
    expect(parsed.description).toBe('비가 온다.');
    expect(parsed.regex).toEqual(risuModule.regex);
    expect(parsed.trigger).toEqual(risuModule.trigger);
    expect(parsed.lowLevelAccess).toBe(true);
    expect(parsed.backgroundEmbedding).toBe(risuModule.backgroundEmbedding);
    // The song is the module's as its pictures are (the store sniffs the bytes);
    // the notes are none of them, and are passed over. Each keeps its name.
    expect(parsed.assets.map((asset) => asset.name)).toEqual(['rain', 'song', 'cloud']);
    expect(parsed.assets[0]!.bytes).toEqual(png);
    // RisuAI's lore shape, as its V3 export writes it and the card import reads it.
    expect(parsed.lorebook.map(({ name, keys, constant, insertionOrder, depth, useRegex, content }) => ({
      name,
      keys,
      constant,
      insertionOrder,
      depth,
      useRegex,
      content,
    }))).toEqual([
      { name: '우산', keys: ['우산', '장화'], constant: false, insertionOrder: 3, depth: undefined, useRegex: false, content: '우산은 파랗다.' },
      { name: '날씨', keys: [''], constant: true, insertionOrder: 0, depth: 2, useRegex: false, content: '비가 내린다.' },
      { name: '정규식', keys: ['구름\\d'], constant: false, insertionOrder: 0, depth: undefined, useRegex: true, content: '구름' },
    ]);
  });

  it('stops at the first picture past the caps or a broken block, and keeps the module', () => {
    const file = buildRisum({ module: risuModule, type: 'risuModule' }, [png]);
    // The closing byte gone and a stray block length after the one picture.
    const broken = Uint8Array.from([...file.slice(0, -1), 1, 0xff, 0xff, 0xff, 0x7f]);
    expect(parseRisuModule(broken).assets.map((asset) => asset.name)).toEqual(['rain']);
  });

  it('reads RisuAI’s module JSON, which carries no pictures, and only with a name and an id', () => {
    const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const parsed = parseRisuModule(json({ ...risuModule, type: 'risuModule' }));
    expect(parsed.name).toBe('날씨 모듈');
    expect(parsed.assets).toEqual([]);
    expect(parsed.lorebook).toHaveLength(3);
    expect(() => parseRisuModule(json({ ...risuModule, type: 'risuModule', id: undefined }))).toThrow(ModuleParseError);
    expect(() => parseRisuModule(json({ ...risuModule, type: 'risuModule', name: ' ' }))).toThrow(ModuleParseError);
    expect(() => parseRisuModule(json({ ...risuModule, type: 'risu' }))).toThrow(ModuleParseError);
    expect(() => parseRisuModule(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toThrow(ModuleParseError);
  });

  it('reads RisuAI’s lorebook export as a module of lore, named as RisuAI names it', () => {
    const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const parsed = parseRisuModule(json({ type: 'risu', ver: 1, data: risuModule.lorebook }));
    expect(parsed).toMatchObject({
      name: 'Imported Lorebook',
      description: 'Converted from risu lorebook',
      regex: [],
      trigger: [],
      lowLevelAccess: false,
      assets: [],
    });
    expect(parsed.lorebook.map((entry) => entry.name)).toEqual(['우산', '날씨', '정규식']);
    expect(parseRisuModule(json({ type: 'risu', name: '우산 책', data: [] })).name).toBe('우산 책');
    // A HypaV3 preset export has the same type with a record for its data: not a lorebook.
    expect(() => parseRisuModule(json({ type: 'risu', data: { summaries: [] } }))).toThrow(ModuleParseError);
  });

  it('reads an external lorebook — SillyTavern’s World Info — through the lorebook file mapping', () => {
    const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const worldInfo = {
      entries: {
        0: { uid: 0, key: ['검'], keysecondary: [], comment: '검', content: '검은 녹슬었다.', constant: false, order: 5, position: 4, depth: 2, role: 0 },
        1: { uid: 1, key: [], keysecondary: [], comment: '배경', content: '왕국은 망했다.', constant: true, order: 1, position: 0 },
      },
    };
    const parsed = parseRisuModule(json(worldInfo));
    expect(parsed.name).toBe('Imported Lorebook');
    expect(parsed.description).toBe('Converted from external lorebook');
    expect(parsed.lorebook).toMatchObject([
      { name: '검', keys: ['검'], content: '검은 녹슬었다.', insertionOrder: 5, depth: 2, constant: false },
      { name: '배경', content: '왕국은 망했다.', constant: true, position: 'before_char' },
    ]);
    // A module's lore is scanned as RisuAI's, the greeting left out, though the file was SillyTavern's.
    expect(parsed.lorebook.some((entry) => 'sillyTavern' in entry)).toBe(false);
    // A character_book's array of entries is an external lorebook too.
    expect(parseRisuModule(json({ name: '책', entries: [{ keys: ['문'], content: '열렸다.' }] })).lorebook[0]).toMatchObject({
      keys: ['문'],
      content: '열렸다.',
    });
    // The other lorebook files the studio reads are not what RisuAI's module import takes.
    expect(() => parseRisuModule(json({ spec: 'lorebook_v3', data: { entries: [] } }))).toThrow(ModuleParseError);
  });

  it('reads RisuAI’s regex export as a module of regex scripts', () => {
    const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const parsed = parseRisuModule(json({ type: 'regex', data: risuModule.regex }));
    expect(parsed).toMatchObject({ name: 'Imported Regex', description: 'Converted from risu regex', lorebook: [], trigger: [] });
    expect(parsed.regex).toEqual(risuModule.regex);
    const module = plotModuleOf(parsed, {
      id: 'm-2',
      name: parsed.name,
      description: parsed.description,
      lorebook: [],
      assets: [],
      importedFrom: { fileName: 'regexscript_export.json', sha256: 'x', importedAt: '2026-10-14T00:00:00.000Z' },
    });
    expect(module.displayScripts).toEqual([{ in: '비', out: '<b>비</b>', order: 0, enabled: true }]);
    expect(() => parseRisuModule(json({ type: 'regex' }))).toThrow(ModuleParseError);
    expect(() => parseRisuModule(json([risuModule]))).toThrow(ModuleParseError);
  });

  it('reads a lore entry RisuAI wrote selective with its secondary keys', () => {
    const entry = risuLoreBookEntry({ key: '문', secondkey: '열쇠', selective: true, content: '잠겨 있다.', insertorder: 1, comment: '', mode: 'normal', alwaysActive: false });
    expect(entry).toMatchObject({ keys: ['문'], secondaryKeys: ['열쇠'], selective: true, content: '잠겨 있다.' });
  });
});

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const rainPicture = Uint8Array.from([...png, 7]);
const smilePicture = Uint8Array.from([...png, 8]);
const v3 = (data: Record<string, unknown>) => ({ spec: 'chara_card_v3', spec_version: '3.0', data });

/**
 * A module as RisuAI's `exportModule` writes it (`name.module.charx`): the module
 * made a character (`convertModuleToCharacter` — its `@@indicator` entries back
 * in the description, first messages and post-history instructions; no icon, so
 * the stand-in and `moduleNoneImage`) and exported as a V3 charx, the scripts
 * and lore in `module.risum` and the scripts out of `card.json`.
 */
const moduleCharx = (): Uint8Array =>
  buildCharx(
    v3({
      name: '날씨 모듈',
      description: '골짜기의 하늘을 다룬다.',
      first_mes: '비가 그쳤다.',
      alternate_greetings: ['눈이 온다.'],
      post_history_instructions: '{{original}} 날씨를 잊지 마라.',
      creator_notes: '비가 온다.',
      // RisuAI writes the same lore here; the module's is the one its import takes.
      character_book: { extensions: {}, entries: [{ keys: ['책'], content: '카드 책에만 있다.', extensions: {}, enabled: true, insertion_order: 0 }] },
      extensions: {
        risuai: {
          backgroundHTML: risuModule.backgroundEmbedding,
          lowLevelAccess: true,
          moduleNamespace: 'weather',
          hideChatIcon: false,
          toggles: '',
        },
        moduleNoneImage: true,
      },
    }),
    [
      { type: 'x-risu-asset', name: 'rain', ext: 'png', entry: 'assets/other/image/rain.png', bytes: rainPicture },
      { type: 'icon', name: 'main', ext: 'png', entry: 'assets/icon/image/main.png', bytes: png },
    ],
    {
      'module.risum': buildRisum({
        module: {
          name: '날씨 모듈 Module',
          description: 'Module for 날씨 모듈',
          id: 'charx-id',
          trigger: risuModule.trigger,
          regex: risuModule.regex,
          lorebook: risuModule.lorebook,
        },
        type: 'risuModule',
      }),
    },
  );

describe('a charx as a module', () => {
  it('writes the description, first messages and global note as RisuAI’s indicator entries', () => {
    const entry = (comment: string, content: string, alwaysActive: boolean) => ({
      key: '',
      secondkey: '',
      insertorder: 0,
      comment,
      content,
      mode: 'constant',
      alwaysActive,
      selective: false,
    });
    expect(
      indicatorLore({ desc: '마녀.', firstMessage: '안녕.', alternateGreetings: ['또 왔네.', '어서 와.'], replaceGlobalNote: '짧게.' }),
    ).toEqual([
      entry('From Character Description', '@@indicator character_desc\n\n마녀.', true),
      entry(
        'From First Messages',
        '@@indicator character_first_message\n\n<FM>\n안녕.\n</FM>\n<FM_alt>\n또 왔네.\n</FM_alt>\n<FM_alt>\n어서 와.\n</FM_alt>',
        false,
      ),
      entry('From Global Note Replacement', '@@indicator replace_global_note\n\n짧게.', true),
    ]);
    expect(indicatorLore({ desc: '', firstMessage: '', alternateGreetings: [], replaceGlobalNote: '' })).toEqual([]);
    // Alternate greetings alone still bring the first-message entry, an empty <FM> and all.
    expect(indicatorLore({ desc: '', firstMessage: '', alternateGreetings: ['또.'], replaceGlobalNote: '' })).toEqual([
      entry('From First Messages', '@@indicator character_first_message\n\n<FM>\n\n</FM>\n<FM_alt>\n또.\n</FM_alt>', false),
    ]);
  });

  it('reads RisuAI’s .module.charx as convertCharacterToModule makes a module of it', () => {
    const parsed = parseRisuModule(moduleCharx());
    expect(parsed.name).toBe('날씨 모듈');
    expect(parsed.description).toBe('비가 온다.');
    // The module's lore over the card's book, then the three indicator entries in RisuAI's order.
    expect(parsed.lorebook.map((entry) => [entry.name, entry.constant, entry.content.trim()])).toEqual([
      ['우산', false, '우산은 파랗다.'],
      ['날씨', true, '비가 내린다.'],
      ['정규식', false, '구름'],
      ['From Character Description', true, '골짜기의 하늘을 다룬다.'],
      ['From First Messages', false, '<FM>\n비가 그쳤다.\n</FM>\n<FM_alt>\n눈이 온다.\n</FM_alt>'],
      ['From Global Note Replacement', true, '{{original}} 날씨를 잊지 마라.'],
    ]);
    expect(parsed.regex).toEqual(risuModule.regex);
    expect(parsed.trigger).toEqual(risuModule.trigger);
    expect(parsed.lowLevelAccess).toBe(true);
    expect(parsed.backgroundEmbedding).toBe(risuModule.backgroundEmbedding);
    expect(parsed.namespace).toBe('weather');
    expect(parsed.hideIcon).toBe(false);
    // The x-risu-asset alone: the icon (here RisuAI's stand-in) is not a module's picture.
    expect(parsed.assets.map((asset) => [asset.name, asset.bytes])).toEqual([['rain', rainPicture]]);

    const module = plotModuleOf(parsed, {
      id: 'm-3',
      name: parsed.name,
      description: parsed.description,
      lorebook: parsed.lorebook,
      assets: [],
      importedFrom: { fileName: '날씨 모듈.module.charx', sha256: 'x', importedAt: '2026-10-14T00:00:00.000Z' },
    });
    expect(module.namespace).toBe('weather');
    expect(module.css).toBe('.rain{color:blue}');
  });

  it('makes any character’s charx a module: the card’s own book and scripts, its additional pictures only', () => {
    const charx = buildCharx(
      v3({
        name: '아리아',
        description: '',
        first_mes: '',
        creator_notes: '',
        character_book: { extensions: {}, entries: [{ keys: ['검'], content: '검은 녹슬었다.', extensions: {}, enabled: true, insertion_order: 2 }] },
        extensions: { risuai: { customScripts: risuModule.regex, triggerscript: risuModule.trigger } },
      }),
      [
        { type: 'emotion', name: 'smile', ext: 'png', entry: 'assets/emotion/image/smile.png', bytes: smilePicture },
        { type: 'x-risu-asset', name: 'rain', ext: 'png', entry: 'assets/other/image/rain.png', bytes: rainPicture },
      ],
    );
    const parsed = parseRisuModule(charx);
    expect(parsed.name).toBe('아리아');
    // Nothing to mark: no description, no first messages, no global note.
    expect(parsed.lorebook.map((entry) => [entry.keys, entry.content])).toEqual([[['검'], '검은 녹슬었다.']]);
    expect(parsed.regex).toEqual(risuModule.regex);
    expect(parsed.trigger).toEqual(risuModule.trigger);
    expect(parsed.lowLevelAccess).toBe(false);
    expect(parsed.namespace).toBeUndefined();
    expect(parsed.assets.map((asset) => asset.name)).toEqual(['rain']);
  });

  it('turns away a charx RisuAI would not read, as unreadable', () => {
    const v2 = zipSync({ 'card.json': encode({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '옛 카드' } }) });
    expect(() => parseRisuModule(v2)).toThrow(ModuleParseError);
    expect(() => parseRisuModule(zipSync({ 'other.json': encode({}) }))).toThrow(ModuleParseError);
    expect(() => parseRisuModule(zipSync({ 'card.json': new TextEncoder().encode('{not json') }))).toThrow(ModuleParseError);
  });
});

describe('plotModuleOf', () => {
  it('lifts the display scripts and splits the background as a card import does', () => {
    const parsed = parseRisuModule(buildRisum({ module: risuModule, type: 'risuModule' }));
    const module = plotModuleOf(parsed, {
      id: 'm-1',
      name: parsed.name,
      description: parsed.description,
      lorebook: parsed.lorebook,
      assets: [],
      importedFrom: { fileName: 'rain.risum', sha256: 'x', importedAt: '2026-10-14T00:00:00.000Z' },
    });
    expect(module.displayScripts).toEqual([{ in: '비', out: '<b>비</b>', order: 0, enabled: true }]);
    expect(module.css).toBe('.rain{color:blue}');
    expect(module.backgroundHtml).toBe('<div class="rain">비</div>');
    expect(module.lowLevelAccess).toBe(true);
    expect(module.regex).toHaveLength(3);
    expect(module.hideIcon).toBeUndefined();
    expect(module.inert).toBeUndefined();
  });

  it('keeps RisuAI’s hideIcon, and an MCP server and cjs code only as a record of what is never run', () => {
    const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const record = { id: 'm-2', name: 'x', description: '', lorebook: [], assets: [], importedFrom: { fileName: 'x.json', sha256: 'x', importedAt: '2026-10-15T00:00:00.000Z' } };
    // `importMCPModule`'s module: a name, a description and the server, nothing else.
    const mcp = parseRisuModule(
      json({ type: 'risuModule', id: 'risu-mcp', name: 'Dice', description: 'MCP from internal:dice', mcp: { url: 'internal:dice' } }),
    );
    expect(mcp.inert).toEqual({ mcp: 'internal:dice' });
    expect(plotModuleOf(mcp, record).inert).toEqual({ mcp: 'internal:dice' });

    const both = parseRisuModule(
      json({ ...risuModule, type: 'risuModule', hideIcon: true, cjs: 'module.exports = () => fetch("https://x")', mcp: {} }),
    );
    expect(both.hideIcon).toBe(true);
    // An MCP object naming no server is still one (RisuAI draws its glyph); the code is not kept.
    expect(both.inert).toEqual({ mcp: '', cjs: true });
    const module = plotModuleOf(both, record);
    expect(module.hideIcon).toBe(true);
    expect(JSON.stringify(module)).not.toContain('fetch(');
    // The rest of such a module is a module like any other.
    expect(module.displayScripts).toHaveLength(1);

    // A charx says it as the character's `hideChatIcon`, which RisuAI makes the module's `hideIcon`.
    const charx = parseRisuModule(
      buildCharx(v3({ name: '숨김', extensions: { risuai: { hideChatIcon: true } } }), [], {}),
    );
    expect(charx.hideIcon).toBe(true);
    expect(charx.inert).toBeUndefined();
  });
});

const card = (extensions: Record<string, unknown>): NormalizedCard => ({
  spec: 'v3',
  name: '아리아',
  description: '마녀.',
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
  extensions,
  raw: null,
});

const work = (overrides: Partial<PlotModule> = {}): PlotModule => ({
  id: 'm-1',
  name: '모듈',
  description: '',
  lorebook: [],
  regex: [{ in: 'm', out: 'M', type: 'editinput' }],
  trigger: [{ comment: '모듈', type: 'start', conditions: [], effect: [] }],
  assets: [],
  importedFrom: { fileName: 'm.risum', sha256: 'x', importedAt: '2026-10-14T00:00:00.000Z' },
  ...overrides,
});

describe('a work’s modules in the scripts', () => {
  const own = card({
    risuai: {
      triggerscript: [{ comment: '카드', type: 'start', conditions: [], effect: [] }],
      customScripts: [{ in: 'c', out: 'C', type: 'editinput' }],
    },
  });

  it('runs after the card’s own, each trigger with its own low-level access', () => {
    const scripts = cardScripts(own, [work({ lowLevelAccess: true })])!;
    expect(scripts.triggers.map((trigger) => [trigger.comment, trigger.lowLevelAccess])).toEqual([
      ['카드', false],
      ['모듈', true],
    ]);
    expect(scripts.editScripts.map((script) => script.in)).toEqual(['c', 'm']);
    // What a gate that cannot tell one trigger's call from another's is held to.
    expect(scripts.lowLevelAccess).toBe(true);
    // Without modules the card's scripts are what they always were: no flag of their own.
    expect(cardScripts(own)!.triggers[0]!.lowLevelAccess).toBeUndefined();
    // A module of only lore adds nothing to run.
    expect(cardScripts(own, [work({ regex: [], trigger: [] })])).toEqual(cardScripts(own));
  });

  it('makes a card with none of its own a scripted one, and the work’s first member the lead', () => {
    const plain = { name: '벨', card: card({}) };
    const scripted = { name: '아리아', card: own };
    expect(scriptedMember([plain, scripted])!.member).toBe(scripted);
    const lead = scriptedMember([plain, scripted], [work()])!;
    expect(lead.member).toBe(plain);
    expect(lead.scripts.triggers.map((trigger) => trigger.comment)).toEqual(['모듈']);
  });

  it('holds each trigger to its own low-level access in a run', () => {
    // `runtrigger` past ten nested calls needs low-level access: the module's has it, the card's not.
    const recursing = (comment: string) => ({
      comment,
      type: 'manual',
      conditions: [],
      effect: [
        { type: 'setvar', var: comment, value: '1', operator: '+=' },
        { type: 'runtrigger', value: comment },
      ],
    });
    const start = (name: string) => ({ comment: '', type: 'start', conditions: [], effect: [{ type: 'runtrigger', value: name }] });
    const scripts = cardScripts(card({ risuai: { triggerscript: [start('card'), recursing('card')] } }), [
      work({ trigger: [start('module'), recursing('module')], regex: [], lowLevelAccess: true }),
    ])!;
    const result = runTriggersSync({
      mode: 'start',
      character: { name: '아리아', description: '', lorebook: [], postHistoryInstructions: '', lowLevelAccess: false, triggers: scripts.triggers },
      messages: [],
      note: '',
      persona: '',
      variables: Object.create(null),
      random: () => 0.5,
    });
    // The card's own stops at ten nested calls; the module's goes on until our own cap ends the run.
    expect(result.variables['card']).toBe('10');
    expect(Number(result.variables['module'])).toBeGreaterThan(10);
  });
});

describe('a work’s modules in the prompt', () => {
  const lore = (content: string, insertionOrder = 0) => ({
    keys: [],
    secondaryKeys: [],
    selective: false,
    content,
    enabled: true,
    constant: true,
    insertionOrder,
    caseSensitive: false,
    useRegex: false,
    position: 'before_char' as const,
  });

  it('activates the module’s lore after every member’s, under the module’s name', () => {
    const aria: PromptCharacter = { name: '아리아', card: { ...card({}), lorebook: [lore('카드의 로어')] } };
    const plot: PromptPlot = {
      name: '골짜기',
      description: '',
      lorebook: [lore('작품의 로어')],
      modules: [work({ name: '날씨', lorebook: [lore('모듈의 로어')] })],
    };
    const prompt = assemblePrompt({ plot, characters: [aria], history: [], userName: '민준', report: true });
    const at = (text: string) => prompt.system.indexOf(text);
    expect(at('작품의 로어')).toBeLessThan(at('카드의 로어'));
    expect(at('카드의 로어')).toBeLessThan(at('모듈의 로어'));
    expect(prompt.report!.lore.map((entry) => entry.source)).toEqual(['plot', '아리아', '날씨']);
  });

  it('sends the indicator entries as RisuAI does in a module: description and global note as lore, never the first messages', () => {
    const parsed = parseRisuModule(moduleCharx());
    const aria: PromptCharacter = { name: '아리아', card: card({}) };
    const plot: PromptPlot = {
      name: '골짜기',
      description: '',
      lorebook: [],
      modules: [work({ name: '날씨 모듈', lorebook: parsed.lorebook, regex: [], trigger: [] })],
    };
    const prompt = assemblePrompt({ plot, characters: [aria], history: [], userName: '민준', report: true });
    const sent = [prompt.system, ...prompt.messages.map((message) => JSON.stringify(message.content))].join('\n');
    expect(sent).toContain('골짜기의 하늘을 다룬다.');
    expect(sent).toContain('날씨를 잊지 마라.');
    expect(sent).not.toContain('비가 그쳤다.');
    expect(sent).not.toContain('@@indicator');
    // The module's always-on entry, the description and the note: nothing keyed fired, nor the first messages.
    expect(prompt.report!.lore.filter((entry) => entry.source === '날씨 모듈')).toHaveLength(3);
  });
});
