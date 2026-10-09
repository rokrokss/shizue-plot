import { describe, expect, it } from 'vitest';
import { exportCardV3 } from '../src/card/export.js';
import { normalizeCard } from '../src/card/normalize.js';
import type { LoreEntry } from '../src/types.js';
import { fromLorebookFile, LorebookFileError, toWorldInfo } from '../src/worldInfo.js';
import { stCard } from './fixtures/cards.js';

const entry = (overrides: Partial<LoreEntry> = {}): LoreEntry => ({
  keys: ['왕궁'],
  secondaryKeys: [],
  selective: false,
  content: '왕궁은 북쪽 언덕에 있다.',
  enabled: true,
  constant: false,
  insertionOrder: 0,
  caseSensitive: false,
  useRegex: false,
  position: 'before_char',
  ...overrides,
});

describe('toWorldInfo', () => {
  it("writes SillyTavern's World Info entries, keyed by uid", () => {
    const file = toWorldInfo([
      entry(),
      entry({
        keys: ['검(술|객)'],
        secondaryKeys: ['밤'],
        selective: true,
        useRegex: true,
        enabled: false,
        insertionOrder: 7,
        depth: 2,
        role: 'user',
        selectiveLogic: 'not_all',
        probability: 30,
        group: '무기',
        groupWeight: 5,
        scanDepth: 3,
        sticky: 2,
        cooldown: 1,
        delay: 4,
      }),
    ]);
    expect(Object.keys(file.entries)).toEqual(['0', '1']);
    expect(file.entries['0']).toEqual({
      uid: 0,
      key: ['왕궁'],
      keysecondary: [],
      comment: '',
      content: '왕궁은 북쪽 언덕에 있다.',
      constant: false,
      selective: false,
      order: 0,
      disable: false,
      caseSensitive: false,
      position: 0,
      depth: 4,
      role: 0,
      selectiveLogic: 0,
      probability: 100,
      useProbability: true,
      group: '',
      groupWeight: 100,
      // ST's own files say "unset" with null.
      scanDepth: null,
      sticky: null,
      cooldown: null,
      delay: null,
      displayIndex: 0,
    });
    expect(file.entries['1']).toMatchObject({
      key: ['/검(술|객)/i'],
      keysecondary: ['/밤/i'],
      disable: true,
      order: 7,
      position: 4,
      depth: 2,
      role: 1,
      selectiveLogic: 1,
      probability: 30,
      group: '무기',
      groupWeight: 5,
      scanDepth: 3,
      sticky: 2,
      cooldown: 1,
      delay: 4,
    });
  });

  it('reads its own output back unchanged', () => {
    const entries = [
      entry(),
      entry({ keys: ['검(술|객)'], useRegex: true, caseSensitive: true, depth: 0, role: 'assistant' }),
      entry({ position: 'after_char', selectiveLogic: 'and_all', secondaryKeys: ['밤'], selective: true }),
    ];
    // Through JSON, as the file travels.
    expect(fromLorebookFile(JSON.parse(JSON.stringify(toWorldInfo(entries))))).toEqual(entries);
  });
});

describe('fromLorebookFile', () => {
  it('reads a World Info file the way SillyTavern means it', () => {
    const entries = fromLorebookFile({
      entries: {
        '0': {
          uid: 0,
          key: ['엘프'],
          keysecondary: ['/숲(지기)?/'],
          content: '엘프는 숲을 지킨다.',
          constant: false,
          selective: true,
          selectiveLogic: 2,
          order: 50,
          position: 4,
          depth: 1,
          role: 2,
          disable: false,
          probability: 100,
          useProbability: true,
          group: '',
          groupWeight: 100,
          scanDepth: null,
          caseSensitive: null,
          sticky: null,
          cooldown: 3,
          delay: null,
        },
        '1': { uid: 1, key: ['비밀'], content: '꺼져 있다.', disable: true, order: 1, position: 7 },
      },
    });
    expect(entries).toEqual([
      {
        keys: ['엘프'],
        secondaryKeys: ['숲(지기)?'],
        selective: true,
        content: '엘프는 숲을 지킨다.',
        enabled: true,
        constant: false,
        insertionOrder: 50,
        caseSensitive: false,
        useRegex: true,
        position: 'before_char',
        depth: 1,
        role: 'assistant',
        selectiveLogic: 'not_any',
        cooldown: 3,
      },
      // An outlet entry has no counterpart; it lands in the system block.
      entry({ keys: ['비밀'], content: '꺼져 있다.', enabled: false, insertionOrder: 1 }),
    ]);
  });

  it('reads a character_book, and the one inside a card', () => {
    const raw = stCard();
    const fromBook = fromLorebookFile(raw.data.character_book);
    // The card's own entries; the character note is the card's, not the book's.
    expect(fromBook).toEqual(normalizeCard(stCard()).lorebook.slice(0, 2));
    expect(fromLorebookFile(stCard())).toEqual(fromBook);

    const exported = exportCardV3(normalizeCard(stCard()));
    expect(fromLorebookFile(exported)).toEqual(normalizeCard(stCard()).lorebook);
  });

  it('reads a CCv3 lorebook file', () => {
    const book = stCard().data.character_book;
    expect(fromLorebookFile({ spec: 'lorebook_v3', data: book })).toEqual(fromLorebookFile(book));
  });

  it('refuses anything else with a typed error', () => {
    for (const value of [null, [], 'entries', { name: '책' }, { data: { name: '카드' } }]) {
      expect(() => fromLorebookFile(value)).toThrow(LorebookFileError);
    }
  });
});
