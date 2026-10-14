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
    expect(composeTurn('  ', 'dialogue', '세이야')).toBe('  ');
  });
});

/**
 * Zeta's write-as: the reader writing a member's line themselves. What comes out
 * is the `@이름: …` a reader could have typed, one marker per line, which core
 * `readerRuns` reads back as that member's.
 */
describe('writing as a member', () => {
  it('marks every line with text as the member’s, and leaves the blank ones as spacing', () => {
    expect(composeTurn('왔어?\n\n  앉아.  ', 'dialogue', '세이야')).toBe('@세이야: 왔어?\n\n@세이야: 앉아.');
  });

  it('writes the member’s 상황묘사 line by line, since a span never crosses a line', () => {
    expect(composeTurn('검을 거둔다\n*고개를 든다*', 'description', '세이야')).toBe(
      '@세이야: *검을 거둔다*\n@세이야: *고개를 든다*',
    );
  });

  it('keeps a line the reader already marked as someone, typed by hand', () => {
    expect(composeTurn('@카이: 내가 할게\n그래.\n@: 비가 그쳤다', 'dialogue', '세이야')).toBe(
      '@카이: 내가 할게\n@세이야: 그래.\n@: 비가 그쳤다',
    );
  });

  it('is the narrator’s when the 내레이터 chip is on, whoever was picked', () => {
    expect(composeTurn('비가 그쳤다', 'narration', '세이야')).toBe('@: 비가 그쳤다');
  });

  it('is the reader’s own voice without a member, exactly as before', () => {
    expect(composeTurn('@세이야: 이건 손으로 친 줄', 'dialogue', null)).toBe('@세이야: 이건 손으로 친 줄');
  });
});
