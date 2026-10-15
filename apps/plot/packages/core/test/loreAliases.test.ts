import { describe, expect, it } from 'vitest';
import {
  ALIAS_BATCH_ENTRIES,
  aliasBatches,
  aliasedSecondaryKeys,
  aliasRequest,
  aliasSourceText,
  isKeyedLoreEntry,
  lacksKoreanKeys,
  MAX_ALIASES_PER_ENTRY,
  naturalKeys,
  parseLoreAliases,
} from '../src/loreAliases.js';
import type { LoreEntry } from '../src/types.js';

const entry = (overrides: Partial<LoreEntry> = {}): LoreEntry => ({
  keys: ['Dumbledore'],
  secondaryKeys: [],
  selective: false,
  content: 'Albus Dumbledore, headmaster of Hogwarts.',
  enabled: true,
  constant: false,
  insertionOrder: 0,
  caseSensitive: false,
  useRegex: false,
  position: 'before_char',
  ...overrides,
});

describe('isKeyedLoreEntry', () => {
  it('takes an enabled, non-constant entry with content and a key a reader could type', () => {
    expect(isKeyedLoreEntry(entry())).toBe(true);
    expect(isKeyedLoreEntry(entry({ enabled: false }))).toBe(false);
    expect(isKeyedLoreEntry(entry({ constant: true }))).toBe(false);
    expect(isKeyedLoreEntry(entry({ depthPrompt: true }))).toBe(false);
    expect(isKeyedLoreEntry(entry({ content: '  ' }))).toBe(false);
    expect(isKeyedLoreEntry(entry({ keys: ['', '  '] }))).toBe(false);
  });

  it("leaves out keys that are a script's switch, a toggle or a RisuAI folder", () => {
    for (const key of ['__HOGWARTS_START_ADULT__', '@@year1@@', 'folder:bf66', 'folder:bf66']) {
      expect(isKeyedLoreEntry(entry({ keys: [key] }))).toBe(false);
    }
    expect(naturalKeys(entry({ keys: [' Snape ', '__SWITCH__', ''] }))).toEqual(['Snape']);
  });
});

describe('lacksKoreanKeys', () => {
  const korean = entry({ keys: ['Dumbledore', '덤블도어'] });
  it('is true below a fifth of keyed entries carrying a Hangul key', () => {
    expect(lacksKoreanKeys([entry(), entry(), entry(), entry(), entry()])).toBe(true);
    expect(lacksKoreanKeys([korean, entry(), entry(), entry(), entry(), entry()])).toBe(true);
    expect(lacksKoreanKeys([korean, entry(), entry(), entry(), entry()])).toBe(false);
  });

  it('judges keyed entries only, and is false for a book without any', () => {
    expect(lacksKoreanKeys([])).toBe(false);
    expect(lacksKoreanKeys([entry({ constant: true, keys: [] })])).toBe(false);
    expect(lacksKoreanKeys([entry(), entry({ constant: true, keys: ['상수'] })])).toBe(true);
  });
});

describe('aliasSourceText', () => {
  it('changes with the keys, the content and the secondary keys it aliases, and with nothing else', () => {
    const base = aliasSourceText(entry());
    expect(aliasSourceText(entry({ insertionOrder: 9, probability: 50, selectiveLogic: 'not_any' }))).toBe(base);
    expect(aliasSourceText(entry({ keys: ['Albus'] }))).not.toBe(base);
    expect(aliasSourceText(entry({ content: 'Another text' }))).not.toBe(base);
    // Secondary keys count only where their aliases are asked for: a selective entry's typable ones.
    expect(aliasSourceText(entry({ secondaryKeys: ['wand'] }))).toBe(base);
    expect(aliasSourceText(entry({ selective: true, secondaryKeys: ['__X__'] }))).toBe(base);
    const wand = aliasSourceText(entry({ selective: true, secondaryKeys: ['wand'] }));
    expect(wand).not.toBe(base);
    expect(aliasSourceText(entry({ selective: true, secondaryKeys: ['robe'] }))).not.toBe(wand);
  });
});

describe('aliasedSecondaryKeys', () => {
  it("takes a selective entry's typable secondary keys, by their place", () => {
    expect(aliasedSecondaryKeys(entry({ secondaryKeys: ['wand'] }))).toEqual([]);
    expect(aliasedSecondaryKeys(entry({ selective: true, secondaryKeys: ['wand', ' ', '@@night@@', 'robe'] }))).toEqual([0, 3]);
  });
});

describe('aliasRequest and aliasBatches', () => {
  it("numbers the entries from 1 with their typable keys and the content's first 600 characters", () => {
    const request = aliasRequest([
      entry({ keys: ['Snape', '__X__'], content: `Severus\n\nSnape ${'x'.repeat(700)}` }),
      entry(),
    ]);
    expect(request.system).toContain('Korean');
    expect(request.messages).toHaveLength(1);
    const [first, second] = request.messages[0]!.content.split('\n[');
    expect(first).toBe(`[1] keys: ["Snape"]\n  ${`Severus Snape ${'x'.repeat(700)}`.slice(0, 600)}`);
    expect(second!.startsWith('2] keys: ["Dumbledore"]')).toBe(true);
  });

  it("lists a selective entry's secondary keys under the entry's number and their place", () => {
    const request = aliasRequest([entry(), entry({ selective: true, secondaryKeys: ['wand', '__X__', 'Elder wand'] })]);
    expect(request.system).toContain('[number.n]');
    expect(request.messages[0]!.content).toContain(
      '[2] keys: ["Dumbledore"]\n  secondary keys: [2.1] "wand", [2.3] "Elder wand"\n  Albus Dumbledore',
    );
    expect(request.messages[0]!.content).not.toContain('[1.');
  });

  it('closes a request at its entry cap or its token cap, never empty', () => {
    const many = Array.from({ length: ALIAS_BATCH_ENTRIES + 5 }, () => entry());
    expect(aliasBatches(many).map((batch) => batch.length)).toEqual([ALIAS_BATCH_ENTRIES, 5]);
    const keys = Array.from({ length: 24 }, (_, at) => `The Long Name Of Archive Wing Number ${at}`);
    const long = Array.from({ length: 50 }, () => entry({ keys, content: 'lore '.repeat(400) }));
    const batches = aliasBatches(long);
    expect(batches.length).toBeGreaterThan(2);
    expect(batches.flat()).toEqual(long.map((_, index) => index));
    expect(aliasBatches([])).toEqual([]);
  });
});

describe('parseLoreAliases', () => {
  it('reads each numbered entry, cleaned and deduplicated, an absent one as none', () => {
    const answer = '```json\n{"1": ["덤블도어", "덤블 도어", "  알버스  ", "Dumbledore", "문", "교장", 3], "3": ["스네이프"]}\n```';
    expect(parseLoreAliases(answer, [entry(), entry(), entry()])).toEqual([
      { keys: ['덤블도어', '알버스', '교장'] },
      { keys: [] },
      { keys: ['스네이프'] },
    ]);
  });

  it("reads each asked secondary key's list into its place, the rest as none", () => {
    const selective = entry({ selective: true, secondaryKeys: ['wand', '__X__', 'robe', 'hat'] });
    const answer = JSON.stringify({ 1: ['덤블도어'], '1.1': ['지팡이', '지팡이'], '1.2': ['스위치'], '1.3': ['로브', '망토'] });
    expect(parseLoreAliases(answer, [selective])).toEqual([{ keys: ['덤블도어'], secondary: [['지팡이'], [], ['로브', '망토'], []] }]);
    // An entry whose secondary keys were not asked about reads none, whatever the answer says.
    expect(parseLoreAliases(answer, [entry({ secondaryKeys: ['wand'] })])).toEqual([{ keys: ['덤블도어'] }]);
  });

  it('keeps at most the cap, and nothing too long to be a name', () => {
    const many = Array.from({ length: 20 }, (_, at) => `별칭${at}`);
    const parsed = parseLoreAliases(JSON.stringify({ 1: [...many, '가'.repeat(41)] }), [entry()])!;
    expect(parsed[0]!.keys).toEqual(many.slice(0, MAX_ALIASES_PER_ENTRY));
  });

  it('is null for an answer that is no JSON object: a refusal, or one cut off', () => {
    expect(parseLoreAliases("I can't help with that.", [entry(), entry()])).toBeNull();
    expect(parseLoreAliases('{"1": ["덤블도어"], "2": ["스네', [entry(), entry()])).toBeNull();
    expect(parseLoreAliases('[["덤블도어"]]', [entry()])).toBeNull();
  });
});
