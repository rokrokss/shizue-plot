/**
 * SillyTavern World Info parity. Every case is read off ST's release
 * `public/scripts/world-info.js` — `checkWorldInfo`, `WorldInfoBuffer`,
 * `filterByInclusionGroups`, `parseDecorators`, `convertCharacterBook` — and
 * says which part it follows.
 */
import { describe, expect, it } from 'vitest';
import { exportCardV3 } from '../src/card/export.js';
import { loreEntryFromBook, loreEntryFromWorldInfo, parseTavernDecorators, worldInfoFieldsOf } from '../src/card/bookEntry.js';
import { normalizeCard } from '../src/card/normalize.js';
import { activateLore, type ActivateLoreInput } from '../src/lorebook.js';
import { stWorldWithFilters } from '../src/sillytavern/scan.js';
import type { LoreEntry } from '../src/types.js';

const entry = (overrides: Partial<LoreEntry> & { content: string }): LoreEntry => ({
  keys: [],
  secondaryKeys: [],
  selective: false,
  enabled: true,
  constant: false,
  insertionOrder: 100,
  caseSensitive: false,
  useRegex: false,
  position: 'before_char',
  sillyTavern: true,
  ...overrides,
});

const countChars = (text: string): number => text.length;

/** An ST book over the given messages, newest last. */
const st = (entries: LoreEntry[], input: Partial<ActivateLoreInput> & { history: string[] }) =>
  activateLore(entries, {
    scanDepth: 2,
    budgetTokens: 10_000,
    countTokens: countChars,
    sillyTavern: true,
    ...input,
  });

const contents = (result: { entries: LoreEntry[] }): string[] => result.entries.map((one) => one.content);

const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++] ?? 0;
};

describe('SillyTavern World Info — keys (WorldInfoBuffer.matchKeys)', () => {
  it('reads a /pattern/flags key as a regex with its own flags, one key at a time', () => {
    const own = entry({ content: 'own', keys: ['/Dragon/'] });
    const folded = entry({ content: 'folded', keys: ['/Dragon/i'] });
    const plain = entry({ content: 'plain', keys: ['Dragon'] });
    // ST's prompt order is ascending order with ties the other way round from how they activated.
    expect(contents(st([own, folded, plain], { history: ['a dragon'] }))).toEqual(['plain', 'folded']);
  });

  it('puts each message behind \\x01, so a ^ never meets a message start', () => {
    const anchored = entry({ content: 'anchored', keys: ['/^dragon/m'] });
    expect(contents(st([anchored], { history: ['dragon'] }))).toEqual([]);
  });

  it('expands a key before matching it (substituteParams)', () => {
    const named = entry({ content: 'named', keys: ['{{user}}'] });
    const keyText = (_entry: LoreEntry, key: string) => key.replace('{{user}}', 'Alice');
    expect(contents(st([named], { history: ['Alice: hi'], keyText }))).toEqual(['named']);
    expect(contents(st([named], { history: ['Alice: hi'] }))).toEqual([]);
  });

  it('matches a one-word key between non-word characters with matchWholeWords', () => {
    const cat = entry({ content: 'cat', keys: ['cat'], matchWholeWords: true });
    const bigCat = entry({ content: 'big cat', keys: ['big cat'], matchWholeWords: true });
    expect(contents(st([cat], { history: ['concatenate'] }))).toEqual([]);
    expect(contents(st([cat], { history: ['the cat.'] }))).toEqual(['cat']);
    // A key of several words is a plain search.
    expect(contents(st([bigCat], { history: ['a big catapult'] }))).toEqual(['big cat']);
    // The book's setting stands in for an entry that leaves it to the book.
    const loose = entry({ content: 'loose', keys: ['cat'] });
    expect(contents(st([loose], { history: ['concatenate'], matchWholeWords: true }))).toEqual([]);
  });

  it("takes the book's case for an entry whose case is null", () => {
    const fromBook = entry({ content: 'book', keys: ['dragon'], caseSensitiveFromBook: true });
    expect(contents(st([fromBook], { history: ['DRAGON'] }))).toEqual(['book']);
    expect(contents(st([fromBook], { history: ['DRAGON'], caseSensitive: true }))).toEqual([]);
  });

  it('scans nothing at all for an entry whose own scan depth is 0', () => {
    const blind = entry({ content: 'blind', keys: ['dragon'], scanDepth: 0 });
    expect(contents(st([blind], { history: ['dragon'] }))).toEqual([]);
  });
});

describe('SillyTavern World Info — scan sources, triggers, character filter', () => {
  it('scans the texts matchSources names besides the chat', () => {
    const knight = entry({ content: 'knight', keys: ['knight'], matchSources: ['persona'] });
    expect(contents(st([knight], { history: ['hello'], scanData: { persona: 'a knight' } }))).toEqual(['knight']);
    expect(contents(st([{ ...knight, matchSources: ['description'] }], { history: ['hello'], scanData: { persona: 'a knight' } }))).toEqual([]);
  });

  it('considers an entry only on the generation types it names', () => {
    const onContinue = entry({ content: 'continue', constant: true, triggers: ['continue'] });
    expect(contents(st([onContinue], { history: [''] }))).toEqual([]);
    expect(contents(st([onContinue], { history: [''], trigger: 'continue' }))).toEqual(['continue']);
  });

  it('keeps an entry to the characters its filter names, or away from them', () => {
    const only = entry({ content: 'only', constant: true, characterFilter: { names: ['Seraphina'] } });
    const not = entry({ content: 'not', constant: true, characterFilter: { names: ['Seraphina'], exclude: true } });
    const tagged = entry({ content: 'tagged', constant: true, characterFilter: { tags: ['Fantasy'] } });
    const seraphina = { names: ['Seraphina'], tags: ['fantasy'] };
    expect(contents(st([only, not, tagged], { history: [''], character: seraphina }))).toEqual(['tagged', 'only']);
    expect(contents(st([only, not, tagged], { history: [''], character: { names: ['Aqua'], tags: [] } }))).toEqual(['not']);
  });
});

describe('SillyTavern World Info — the budget (checkWorldInfo)', () => {
  it('stops at the first entry that reaches the budget, where the other books skip it', () => {
    const a = entry({ content: 'a'.repeat(10), constant: true, insertionOrder: 300 });
    const long = entry({ content: 'l'.repeat(20), constant: true, insertionOrder: 200 });
    const short = entry({ content: 'sss', constant: true, insertionOrder: 100 });
    // ST: 11 fits; 11 + 21 reaches 20 and overflows; the scan stops there.
    expect(contents(st([a, long, short], { history: [''], budgetTokens: 20 }))).toEqual(['a'.repeat(10)]);
    // RisuAI and the V3 spec skip the long one and keep going.
    expect(contents(activateLore([a, long, short], { history: [''], scanDepth: 2, budgetTokens: 20, countTokens: countChars }))).toEqual([
      'sss',
      'a'.repeat(10),
    ]);
  });

  it('lets an entry that ignores the budget in after the overflow, still counting it', () => {
    const a = entry({ content: 'a'.repeat(10), constant: true, insertionOrder: 300 });
    const b = entry({ content: 'b'.repeat(10), constant: true, insertionOrder: 200 });
    const over = entry({ content: 'o'.repeat(10), constant: true, insertionOrder: 100 });
    const free = entry({ content: 'free', constant: true, insertionOrder: 50, ignoreBudget: true });
    expect(contents(st([a, b, over, free], { history: [''], budgetTokens: 25 }))).toEqual([
      'free',
      'b'.repeat(10),
      'a'.repeat(10),
    ]);
  });

  it('keeps the character’s note outside the budget and the recursion', () => {
    const note = entry({ content: 'note', constant: true, depth: 4, depthPrompt: true });
    const tower = entry({ content: 'tower', keys: ['note'] });
    const result = st([note, tower], { history: [''], budgetTokens: 1, recursiveScanning: true });
    expect(contents(result)).toEqual(['note']);
  });
});

describe('SillyTavern World Info — groups and chance (filterByInclusionGroups)', () => {
  it('settles the group before the roll, so a winner that fails its roll leaves the group empty', () => {
    const a = entry({ content: 'A', keys: ['rain'], group: 'weather', probability: 50, insertionOrder: 2 });
    const b = entry({ content: 'B', keys: ['rain'], group: 'weather', insertionOrder: 1 });
    // Group roll 0.1 × 200 = 20 lands on A; A then rolls 90 > 50.
    expect(contents(st([a, b], { history: ['rain'], random: sequence(0.1, 0.9) }))).toEqual([]);
    // The other books roll first: A fails, and B is left alone in the group.
    expect(
      contents(activateLore([a, b], { history: ['rain'], scanDepth: 2, budgetTokens: 1000, countTokens: countChars, random: sequence(0.9) })),
    ).toEqual(['B']);
  });

  it('gives the group to the override with the highest order', () => {
    const low = entry({ content: 'low', keys: ['rain'], group: 'weather', groupOverride: true, insertionOrder: 10 });
    const high = entry({ content: 'high', keys: ['rain'], group: 'weather', groupOverride: true, insertionOrder: 20 });
    const plain = entry({ content: 'plain', keys: ['rain'], group: 'weather', insertionOrder: 30 });
    expect(contents(st([low, high, plain], { history: ['rain'] }))).toEqual(['high']);
  });

  it('drops the scored members whose keys matched less (getScore)', () => {
    const one = entry({ content: 'one', keys: ['dragon'], group: 'beast', useGroupScoring: true });
    const two = entry({ content: 'two', keys: ['dragon', 'fire'], group: 'beast', useGroupScoring: true });
    expect(contents(st([one, two], { history: ['dragon fire'], random: () => 0 }))).toEqual(['two']);
  });

  it('takes a group only where an active entry has exactly that group field', () => {
    const first = (group: string) => entry({ content: 'first', keys: ['castle'], group, insertionOrder: 2 });
    const later = entry({ content: 'later', keys: ['gate'], group: 'a', insertionOrder: 1 });
    const chained = (group: string) => ({ ...first(group), content: 'first gate' });
    expect(contents(st([chained('a, b'), later], { history: ['castle'], recursiveScanning: true }))).toEqual([
      'later',
      'first gate',
    ]);
    expect(contents(st([chained('a'), later], { history: ['castle'], recursiveScanning: true }))).toEqual(['first gate']);
  });
});

describe('SillyTavern World Info — recursion', () => {
  const gate = entry({ content: 'the gate', keys: ['castle'], insertionOrder: 3 });

  it('opens delay levels one at a time, and only once a scan finds nothing more', () => {
    const one = entry({ content: 'level one', keys: ['castle'], delayUntilRecursion: 1, insertionOrder: 2 });
    const two = entry({ content: 'level two', keys: ['castle'], delayUntilRecursion: 2, insertionOrder: 1 });
    const result = st([gate, one, two], { history: ['castle'], recursiveScanning: true });
    expect(contents(result)).toEqual(['level two', 'level one', 'the gate']);
    expect(result.via.get(one)).toBe('recursion');
    // Three scans: the chat, level one, and the empty one after it — level two needs a fourth.
    expect(contents(st([gate, one, two], { history: ['castle'], recursiveScanning: true, maxRecursionSteps: 3 }))).toEqual([
      'level one',
      'the gate',
    ]);
  });

  it('runs the delay levels with recursion off too, the next level straight away', () => {
    const one = entry({ content: 'level one', keys: ['castle'], delayUntilRecursion: 1, insertionOrder: 2 });
    const two = entry({ content: 'level two', keys: ['castle'], delayUntilRecursion: 2, insertionOrder: 1 });
    expect(contents(st([gate, one, two], { history: ['castle'] }))).toEqual(['level two', 'level one', 'the gate']);
  });

  it('never lets recursion activate an excluded entry, nor scan a preventing one', () => {
    const excluded = entry({ content: 'excluded', keys: ['gate'], excludeRecursion: true });
    expect(contents(st([gate, excluded], { history: ['castle'], recursiveScanning: true }))).toEqual(['the gate']);
    const tower = entry({ content: 'tower', keys: ['gate'] });
    expect(contents(st([{ ...gate, preventRecursion: true }, tower], { history: ['castle'], recursiveScanning: true }))).toEqual([
      'the gate',
    ]);
    expect(contents(st([gate, tower], { history: ['castle'], recursiveScanning: true }))).toEqual(['the gate', 'tower']);
  });

  it('reaches one message further back while too few entries are active (min activations)', () => {
    const dragon = entry({ content: 'dragon', keys: ['dragon'] });
    const history = ['a dragon', 'mid', 'new'];
    expect(contents(st([dragon], { history, scanDepth: 1 }))).toEqual([]);
    expect(contents(st([dragon], { history, scanDepth: 1, minActivations: 1 }))).toEqual(['dragon']);
    // ST checks the cap before it reaches further, so a cap of 2 still scans 3
    // deep; a cap of 1 stops at 2.
    expect(contents(st([dragon], { history, scanDepth: 1, minActivations: 1, minActivationsDepthMax: 2 }))).toEqual([
      'dragon',
    ]);
    expect(contents(st([dragon], { history, scanDepth: 1, minActivations: 1, minActivationsDepthMax: 1 }))).toEqual([]);
  });
});

describe('SillyTavern World Info — order (getSortedEntries)', () => {
  it("considers the character's lore before the rest under character_first", () => {
    const global = entry({ content: 'g'.repeat(10), constant: true, insertionOrder: 900 });
    const own = entry({ content: 'c'.repeat(10), constant: true, insertionOrder: 1 });
    const source = (one: LoreEntry) => (one === own ? 'character' : 'global');
    expect(contents(st([global, own], { history: [''], budgetTokens: 15, source }))).toEqual(['c'.repeat(10)]);
    expect(contents(st([global, own], { history: [''], budgetTokens: 15, source, insertionStrategy: 'evenly' }))).toEqual([
      'g'.repeat(10),
    ]);
  });
});

describe('SillyTavern World Info — reading and writing entries', () => {
  it('reads only @@activate and @@dont_activate, and drops the other decorators (parseDecorators)', () => {
    expect(parseTavernDecorators('@@activate\n@@depth 3\nbody')).toEqual({ activate: true, dontActivate: false, body: 'body' });
    expect(parseTavernDecorators('@@dont_activate\nbody').dontActivate).toBe(true);
    // A @@@ line is a fallback, read only right after a decorator ST does not know.
    expect(parseTavernDecorators('@@unknown\n@@@activate\nbody').activate).toBe(true);
    expect(parseTavernDecorators('@@@activate\nbody')).toEqual({ activate: false, dontActivate: false, body: 'body' });
    // Content that is nothing but decorators stays whole.
    expect(parseTavernDecorators('@@activate').body).toBe('@@activate');
    // Not at the very start: no decorators at all.
    expect(parseTavernDecorators(' @@activate\nbody').activate).toBe(false);

    const read = loreEntryFromWorldInfo({ key: ['x'], content: '@@activate\n@@depth 2\nhello', position: 0 });
    expect(read).toMatchObject({ constant: true, content: 'hello', sillyTavern: true });
    expect(read.depth).toBeUndefined();
  });

  it('reads every setting of a World Info entry, and writes it back', () => {
    const raw = {
      uid: 3,
      key: ['/Dragon/i', '{{char}}'],
      keysecondary: ['fire'],
      comment: 'Dragon',
      content: 'A dragon.',
      constant: false,
      selective: true,
      selectiveLogic: 3,
      order: 120,
      position: 4,
      depth: 2,
      role: 1,
      disable: false,
      ignoreBudget: true,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 2,
      probability: 40,
      useProbability: true,
      group: 'beast',
      groupOverride: true,
      groupWeight: 30,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: true,
      useGroupScoring: false,
      matchPersonaDescription: true,
      matchScenario: true,
      sticky: 2,
      cooldown: 3,
      delay: null,
      triggers: ['normal', 'continue', 'bogus'],
      characterFilter: { isExclude: true, names: ['Seraphina'], tags: ['tag-1'] },
    };
    const read = loreEntryFromWorldInfo(raw);
    expect(read).toMatchObject({
      keys: ['/Dragon/i', '{{char}}'],
      useRegex: false,
      selectiveLogic: 'and_all',
      depth: 2,
      role: 'user',
      ignoreBudget: true,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 2,
      probability: 40,
      group: 'beast',
      groupOverride: true,
      groupWeight: 30,
      caseSensitiveFromBook: true,
      matchWholeWords: true,
      useGroupScoring: false,
      matchSources: ['persona', 'scenario'],
      sticky: 2,
      cooldown: 3,
      triggers: ['normal', 'continue'],
      characterFilter: { names: ['Seraphina'], tags: ['tag-1'], exclude: true },
    });
    expect(worldInfoFieldsOf(read)).toMatchObject({
      key: ['/Dragon/i', '{{char}}'],
      caseSensitive: null,
      ignoreBudget: true,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 2,
      groupOverride: true,
      matchWholeWords: true,
      useGroupScoring: false,
      matchPersonaDescription: true,
      matchScenario: true,
      triggers: ['normal', 'continue'],
      characterFilter: { isExclude: true, names: ['Seraphina'], tags: ['tag-1'] },
    });
  });

  it('reads a card book entry ST wrote from its snake_case extensions (convertCharacterBook)', () => {
    const read = loreEntryFromBook({
      keys: ['/Sword/'],
      content: 'A sword.',
      insertion_order: 10,
      enabled: true,
      use_regex: true,
      extensions: {
        position: 1,
        prevent_recursion: true,
        delay_until_recursion: true,
        group_override: true,
        match_whole_words: false,
        match_character_description: true,
        ignore_budget: true,
        triggers: ['swipe'],
        case_sensitive: null,
      },
    });
    expect(read).toMatchObject({
      keys: ['/Sword/'],
      useRegex: false,
      position: 'after_char',
      preventRecursion: true,
      delayUntilRecursion: 1,
      groupOverride: true,
      matchWholeWords: false,
      matchSources: ['description'],
      ignoreBudget: true,
      triggers: ['swipe'],
      caseSensitiveFromBook: true,
      sillyTavern: true,
    });
  });

  it("keeps a RisuAI book's entries RisuAI's even when they carry ST's extensions", () => {
    const read = loreEntryFromBook(
      { keys: ['/Sword/'], content: '@@depth 2\nA sword.', extensions: { position: 0 } },
      { sillyTavern: false },
    );
    expect(read.sillyTavern).toBeUndefined();
    expect(read.depth).toBe(2);
  });

  it('round-trips the character’s note through extensions.depth_prompt', () => {
    const card = normalizeCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Seraphina',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: { talkativeness: '0.5', fav: false, depth_prompt: { prompt: 'Stay kind.', depth: 2, role: 'user' } },
      },
    });
    const note = card.lorebook.find((one) => one.depthPrompt);
    expect(note).toMatchObject({ content: 'Stay kind.', depth: 2, role: 'user', constant: true });
    const out = exportCardV3(card);
    expect(out.data.extensions['depth_prompt']).toEqual({ prompt: 'Stay kind.', depth: 2, role: 'user' });
    expect(out.data.character_book?.entries ?? []).toEqual([]);
  });

  it('names roster members and tag names in a backup’s character filters', () => {
    const world = {
      entries: { 0: { key: ['x'], content: 'x', characterFilter: { isExclude: false, names: ['Seraphina1'], tags: ['t1'] } } },
    };
    const out = stWorldWithFilters(world, {
      characters: [{ avatar: 'Seraphina1.png', name: 'Seraphina' } as never],
      tagNames: { t1: 'Fantasy' },
    }) as { entries: Record<string, { characterFilter: unknown }> };
    expect(out.entries['0']!.characterFilter).toEqual({ isExclude: false, names: ['Seraphina'], tags: ['Fantasy'] });
  });
});
