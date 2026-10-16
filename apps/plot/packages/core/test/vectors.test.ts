import { describe, expect, it } from 'vitest';
import { RETRIEVAL_DEFAULTS, retrievalBlock, retrievalChunks, splitRecursive, vectorQueryText } from '../src/vectors.js';

describe("SillyTavern's Vector Storage defaults", () => {
  it('are the ones its settings start from', () => {
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
