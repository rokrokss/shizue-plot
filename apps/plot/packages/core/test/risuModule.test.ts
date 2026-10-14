/**
 * A RisuAI module brought into a work on its own (`card/risuModule.ts`), and
 * what the work's modules add to the scripts a member runs (`cardScripts`).
 */
import { describe, expect, it } from 'vitest';
import {
  ModuleParseError,
  parseRisuModule,
  plotModuleOf,
  risuLoreBookEntry,
} from '../src/card/risuModule.js';
import { assemblePrompt, type PromptCharacter, type PromptPlot } from '../src/prompt.js';
import { cardScripts, runTriggersSync, scriptedMember } from '../src/triggers/index.js';
import { DEFAULT_LORE_SETTINGS, type NormalizedCard, type PlotModule } from '../src/types.js';
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
  ],
};

describe('parseRisuModule', () => {
  it('reads a .risum whole: its lore as entries, its scripts as written, its pictures by position', () => {
    const file = buildRisum({ module: risuModule, type: 'risuModule' }, [png, Uint8Array.from([9]), png]);
    const parsed = parseRisuModule(file);
    expect(parsed.name).toBe('날씨 모듈');
    expect(parsed.description).toBe('비가 온다.');
    expect(parsed.regex).toEqual(risuModule.regex);
    expect(parsed.trigger).toEqual(risuModule.trigger);
    expect(parsed.lowLevelAccess).toBe(true);
    expect(parsed.backgroundEmbedding).toBe(risuModule.backgroundEmbedding);
    // The song is not a picture, and is passed over; the pictures keep their names.
    expect(parsed.assets.map((asset) => asset.name)).toEqual(['rain', 'cloud']);
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

  it('reads a lore entry RisuAI wrote selective with its secondary keys', () => {
    const entry = risuLoreBookEntry({ key: '문', secondkey: '열쇠', selective: true, content: '잠겨 있다.', insertorder: 1, comment: '', mode: 'normal', alwaysActive: false });
    expect(entry).toMatchObject({ keys: ['문'], secondaryKeys: ['열쇠'], selective: true, content: '잠겨 있다.' });
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
});
