import { describe, expect, it } from 'vitest';
import { applyMention, matchMentions, mentionAt, narratorOption, type MentionOption } from '../src/lib/mention';

const members: MentionOption[] = [
  { key: 'a', label: '민수', name: '민수', names: ['민수', 'Minsu'] },
  { key: 'b', label: '유나', name: '유나', names: ['유나'] },
  narratorOption('내레이터'),
];

describe('the @ being typed', () => {
  it('is the one that opens the caret’s line, until its colon', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('안녕\n  @민', 7)).toEqual({ start: 5, query: '민' });
    expect(mentionAt('@민수: 안녕', 8)).toBeNull();
    // Mid-line, or past the caret's line, is no marker.
    expect(mentionAt('메일은 a@b', 8)).toBeNull();
    expect(mentionAt('@민\n다음 줄', 7)).toBeNull();
  });
});

describe('the names offered', () => {
  it('are every one for a bare @, and those a name begins with otherwise, nicknames and the narrator’s other names too', () => {
    expect(matchMentions(members, '').map((option) => option.key)).toEqual(['a', 'b', 'narrator']);
    expect(matchMentions(members, '민').map((option) => option.key)).toEqual(['a']);
    expect(matchMentions(members, 'min').map((option) => option.key)).toEqual(['a']);
    expect(matchMentions(members, '나레').map((option) => option.key)).toEqual(['narrator']);
    expect(matchMentions(members, '없음')).toEqual([]);
  });
});

describe('taking one', () => {
  it('writes the whole marker in place of what was typed, and the narrator’s as @:', () => {
    expect(applyMention('안녕\n@민', { start: 3, query: '민' }, 5, members[0]!)).toEqual({ value: '안녕\n@민수: ', caret: 8 });
    expect(applyMention('@나 문이 열린다', { start: 0, query: '나' }, 2, members[2]!)).toEqual({ value: '@:  문이 열린다', caret: 3 });
  });
});
