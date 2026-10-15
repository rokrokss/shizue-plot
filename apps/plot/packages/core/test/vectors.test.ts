import { describe, expect, it } from 'vitest';
import { countTokens } from '../src/tokens.js';
import type { LoreEntry } from '../src/types.js';
import {
  isVectorLoreCandidate,
  LORE_CHUNK_TOKENS,
  loreChunkHeader,
  loreChunks,
  RETRIEVAL_DEFAULTS,
  retrievalBlock,
  retrievalChunks,
  splitRecursive,
  VECTOR_LORE,
  vectorLoreBar,
  vectorQueryText,
} from '../src/vectors.js';

const entry = (overrides: Partial<LoreEntry> = {}): LoreEntry => ({
  keys: [],
  secondaryKeys: [],
  selective: false,
  content: 'The lighthouse keeper',
  enabled: true,
  constant: false,
  insertionOrder: 0,
  caseSensitive: false,
  useRegex: false,
  position: 'before_char',
  ...overrides,
});

describe("SillyTavern's Vector Storage defaults", () => {
  it('are the ones its settings start from', () => {
    expect(VECTOR_LORE).toEqual({ query: 2, scoreThreshold: 0.25, maxEntries: 5 });
    expect(RETRIEVAL_DEFAULTS).toEqual({
      protect: 5,
      insert: 3,
      query: 2,
      chunkSize: 400,
      scoreThreshold: 0.25,
      template: 'Past events:\n{{text}}',
    });
  });
});

describe('isVectorLoreCandidate', () => {
  it('takes a marked entry, or every entry under the book switch, enabled and with content', () => {
    expect(isVectorLoreCandidate(entry(), undefined)).toBe(false);
    expect(isVectorLoreCandidate(entry({ vectorized: true }), undefined)).toBe(true);
    expect(isVectorLoreCandidate(entry(), { vectorizeAll: true })).toBe(true);
    expect(isVectorLoreCandidate(entry({ vectorized: true, enabled: false }), undefined)).toBe(false);
    expect(isVectorLoreCandidate(entry({ content: '  ' }), { vectorizeAll: true })).toBe(false);
  });
});

describe('vectorLoreBar', () => {
  it("is KURE-v1's measured bar, and ST's defaults for a model nobody measured", () => {
    expect(vectorLoreBar('KURE-v1')).toEqual({ scoreThreshold: 0.55, maxEntries: 3 });
    expect(vectorLoreBar('bge-m3')).toEqual({ scoreThreshold: 0.25, maxEntries: 5 });
  });
});

describe('loreChunks', () => {
  it('embeds an entry that fits whole, as it is', () => {
    expect(loreChunks(entry({ name: 'Keeper', keys: ['lighthouse'] }))).toEqual(['The lighthouse keeper']);
  });

  it('cuts a long one on its paragraphs and sentences, each piece under its header and within the chunk', () => {
    const paragraph = (topic: string) => `${`The ${topic} stands on the cliff. `.repeat(40).trim()}`;
    const long = entry({
      name: 'The North Light',
      keys: ['__SWITCH__', 'lighthouse', 'beacon', 'keeper', 'cliff'],
      content: [paragraph('tower'), paragraph('lamp'), paragraph('keeper')].join('\n\n'),
    });
    expect(loreChunkHeader(long)).toBe('The North Light — lighthouse, beacon, keeper');
    const chunks = loreChunks(long);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.startsWith('The North Light — lighthouse, beacon, keeper\n')).toBe(true);
      expect(countTokens(chunk)).toBeLessThanOrEqual(LORE_CHUNK_TOKENS + 2);
    }
    // Nothing of the content is lost, and no paragraph is cut inside a sentence.
    const bodies = chunks.map((chunk) => chunk.slice(chunk.indexOf('\n') + 1));
    expect(bodies.join(' ').replace(/\s+/g, ' ').replace(/\. /g, ' ').replace(/\./g, '')).toBe(
      long.content.replace(/\s+/g, ' ').replace(/\. /g, ' ').replace(/\./g, ''),
    );
    expect(bodies.every((body) => /cliff\.?$/.test(body))).toBe(true);
  });

  it('cuts a text with no boundaries anywhere, and an entry without a name or keys has no header', () => {
    const chunks = loreChunks(entry({ keys: [], content: '가나다라마바사'.repeat(170) }));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe('가나다라마바사'.repeat(170));
    expect(chunks.every((chunk) => countTokens(chunk) <= LORE_CHUNK_TOKENS)).toBe(true);
  });

  it("leaves ST's message chunking as it was", () => {
    expect(splitRecursive('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });
});

describe('vectorQueryText', () => {
  it('reads the newest messages with text, newest first, line breaks collapsed', () => {
    expect(vectorQueryText(['oldest', 'older\n\n\nstill', '', '  newest  '], 2)).toBe('newest\nolder\nstill');
    expect(vectorQueryText([], 2)).toBe('');
  });
});

describe('splitRecursive', () => {
  it('splits on paragraphs, then lines, then words, and joins neighbours back while they fit', () => {
    expect(splitRecursive('aaa\n\nbbb\n\nccc', 8)).toEqual(['aaa\n\nbbb', 'ccc']);
    expect(splitRecursive('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(splitRecursive('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(splitRecursive('short', 400)).toEqual(['short']);
    expect(splitRecursive('anything', 0)).toEqual(['anything']);
  });

  it('chunks a message at 400 characters and drops blank pieces', () => {
    const chunks = retrievalChunks(`${'가'.repeat(390)} ${'나'.repeat(390)}`);
    expect(chunks).toEqual(['가'.repeat(390), '나'.repeat(390)]);
    expect(chunks.every((chunk) => chunk.length <= RETRIEVAL_DEFAULTS.chunkSize)).toBe(true);
    expect(retrievalChunks('  \n\n  ')).toEqual([]);
  });
});

describe('retrievalBlock', () => {
  it("puts the lines in ST's template, a blank line between them", () => {
    expect(retrievalBlock(['리안: 등대에\n\n갔다', '유저: $& 그래'])).toBe('Past events:\n리안: 등대에\n갔다\n\n유저: $& 그래');
    expect(retrievalBlock([])).toBe('');
  });
});
