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
      // The label rides in ST's `comment`.
      entry({ name: '야경' }),
      // ST's own positions, an outlet with the name its macro reads.
      entry({ position: 'before_author_note' }),
      entry({ position: 'after_examples' }),
      entry({ position: 'outlet', outletName: '금고' }),
      // ST's 🔗 status: activated by meaning as well.
      entry({ vectorized: true }),
    ];
    // Through JSON, as the file travels — and read back as SillyTavern's, whose
    // scan reads the greeting; the file itself says nothing of it. A regex entry
    // comes back in ST's own terms: each key a `/pattern/flags` of its own.
    const written = toWorldInfo(entries.map((read) => ({ ...read, sillyTavern: true as const })));
    expect(JSON.stringify(written)).not.toContain('sillyTavern');
    const read = fromLorebookFile(JSON.parse(JSON.stringify(written)));
    expect(read).toEqual(
      entries.map((one) =>
        one.useRegex ? { ...one, keys: ['/검(술|객)/'], useRegex: false, sillyTavern: true } : { ...one, sillyTavern: true },
      ),
    );
    // And from there it is a fixed point.
    expect(fromLorebookFile(JSON.parse(JSON.stringify(toWorldInfo(read))))).toEqual(read);
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
        '1': {
          uid: 1,
          key: ['비밀'],
          content: '꺼져 있다.',
          disable: true,
          order: 1,
          position: 7,
          outletName: ' 금고 ',
        },
        // ST's other positions: around the author's note and the examples.
        '2': { uid: 2, key: ['노트'], content: '노트 위', order: 2, position: 2 },
        '3': { uid: 3, key: ['노트'], content: '노트 아래', order: 3, position: 3 },
        '4': { uid: 4, key: ['예시'], content: '예시 위', order: 4, position: 5 },
        '5': { uid: 5, key: ['예시'], content: '예시 아래', order: 5, position: 6 },
        // An outlet no macro can name.
        '6': { uid: 6, key: ['이름'], content: '이름 없음', order: 6, position: 7, outletName: '' },
      },
    });
    // Keys stay as ST wrote them — `/숲(지기)?/` is a regex key, `엘프` a plain one
    // — and a case ST leaves unset (null, or no field) is the book's.
    const st = { sillyTavern: true as const, caseSensitiveFromBook: true as const };
    expect(entries).toEqual([
      {
        keys: ['엘프'],
        secondaryKeys: ['/숲(지기)?/'],
        selective: true,
        content: '엘프는 숲을 지킨다.',
        enabled: true,
        constant: false,
        insertionOrder: 50,
        caseSensitive: false,
        useRegex: false,
        position: 'before_char',
        depth: 1,
        role: 'assistant',
        selectiveLogic: 'not_any',
        cooldown: 3,
        ...st,
      },
      entry({
        keys: ['비밀'],
        content: '꺼져 있다.',
        enabled: false,
        insertionOrder: 1,
        position: 'outlet',
        outletName: '금고',
        ...st,
      }),
      entry({ keys: ['노트'], content: '노트 위', insertionOrder: 2, position: 'before_author_note', ...st }),
      entry({ keys: ['노트'], content: '노트 아래', insertionOrder: 3, position: 'after_author_note', ...st }),
      entry({ keys: ['예시'], content: '예시 위', insertionOrder: 4, position: 'before_examples', ...st }),
      entry({ keys: ['예시'], content: '예시 아래', insertionOrder: 5, position: 'after_examples', ...st }),
      entry({ keys: ['이름'], content: '이름 없음', insertionOrder: 6, position: 'outlet', ...st }),
    ]);
  });

  it('reads a character_book, and the one inside a card', () => {
    const raw = stCard();
    const fromBook = fromLorebookFile(raw.data.character_book);
    // The card's own entries; the character note is the card's, not the book's.
    expect(fromBook).toEqual(normalizeCard(stCard()).lorebook.slice(0, 2));
    // Entries that carry ST's settings are ST's, read as ST reads them.
    expect(fromBook.every((read) => read.sillyTavern)).toBe(true);
    expect(fromLorebookFile(stCard())).toEqual(fromBook);

    // Our export keeps them ST's, and writes the note back to `depth_prompt`.
    const exported = exportCardV3(normalizeCard(stCard()));
    expect(fromLorebookFile(exported)).toEqual(normalizeCard(stCard()).lorebook.slice(0, 2));
    // A book we wrote whose entries were ours stays ours on the way back.
    const own = exportCardV3({ ...normalizeCard(stCard()), lorebook: [entry({ keys: ['검(술|객)'], useRegex: true })] });
    expect(fromLorebookFile(own)).toEqual([entry({ keys: ['검(술|객)'], useRegex: true, caseSensitive: false })]);
  });

  it("keeps SillyTavern's vectorized flag from a character_book entry, and writes it back only when set", () => {
    const book = {
      entries: [
        { keys: ['등대'], content: '등대지기', extensions: { position: 0, vectorized: true } },
        { keys: ['지도'], content: '낡은 지도', extensions: { position: 0, vectorized: false } },
      ],
    };
    const [marked, plain] = fromLorebookFile(book);
    expect(marked!.vectorized).toBe(true);
    expect('vectorized' in plain!).toBe(false);
    const written = toWorldInfo([marked!, plain!]);
    expect(written.entries['0']!['vectorized']).toBe(true);
    expect('vectorized' in written.entries['1']!).toBe(false);
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
