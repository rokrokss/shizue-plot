/**
 * The composer's three ways of writing a turn.
 *
 * The mode is not stored anywhere, so the whole of it is what it does to the text
 * on its way out: what comes back has to be something the reader could have typed
 * by hand, in the same notation the parser reads back.
 */
import { describe, expect, it } from 'vitest';
import { composeTurn } from '../src/lib/composerMode';

describe('the composer modes', () => {
  it('sends a line of dialogue exactly as it was typed', () => {
    expect(composeTurn('  안녕, 오랜만이야.  ', 'dialogue')).toBe('  안녕, 오랜만이야.  ');
  });

  it('wraps a description in the marks the parser reads', () => {
    expect(composeTurn('문을 열고 들어선다', 'description')).toBe('*문을 열고 들어선다*');
  });

  it('leaves marks the reader already put there, so the two never double up', () => {
    expect(composeTurn('*문을 열고 들어선다*', 'description')).toBe('*문을 열고 들어선다*');
    // A lone star is text, not a pair around anything, so it is wrapped like any.
    expect(composeTurn('*', 'description')).toBe('***');
  });

  it('prefixes a narration, and never twice', () => {
    expect(composeTurn('비가 그쳤다', 'narration')).toBe('@: 비가 그쳤다');
    expect(composeTurn('@: 비가 그쳤다', 'narration')).toBe('@: 비가 그쳤다');
  });

  it('leaves an empty composer alone, whatever the mode', () => {
    expect(composeTurn('   ', 'description')).toBe('   ');
    expect(composeTurn('', 'narration')).toBe('');
  });
});
