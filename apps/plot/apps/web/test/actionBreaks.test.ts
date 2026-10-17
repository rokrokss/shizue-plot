import { describe, expect, it } from 'vitest';
import { separateActions } from '../src/lib/actionBreaks';

describe('separateActions', () => {
  it('parts an action from the words on its line, as Zeta draws a reply', () => {
    expect(separateActions('*카타나를 쥐며* 합동 훈련 따위 필요 없어.')).toBe('*카타나를 쥐며*\n\n합동 훈련 따위 필요 없어.');
    expect(separateActions('안 돼. *고개를 젓는다* 팀워크가 필요해.')).toBe('안 돼.\n\n*고개를 젓는다*\n\n팀워크가 필요해.');
    // A short emphasis is an action too, as Zeta reads every single asterisk.
    expect(separateActions('그건 *정말* 좋아')).toBe('그건\n\n*정말*\n\n좋아');
  });

  it('parts lines a paragraph ran together where one of them is an action', () => {
    expect(separateActions('*웃는다*\n안녕')).toBe('*웃는다*\n\n안녕');
    expect(separateActions('안녕\n*웃는다*')).toBe('안녕\n\n*웃는다*');
    // Two lines of words stay one paragraph.
    expect(separateActions('*웃는다*\n\n안녕\n반가워')).toBe('*웃는다*\n\n안녕\n반가워');
  });

  it('leaves what is already parted as it is, so drawing and editing agree', () => {
    const once = separateActions('*박수를 친다.* 자, 일주일 뒤입니다. *김로키를 본다.* 준비하세요.');
    expect(separateActions(once)).toBe(once);
    expect(separateActions('*a*\n\nb')).toBe('*a*\n\nb');
  });

  it('leaves bold, code, markup, speaker lines and markdown structure alone', () => {
    for (const text of [
      '**굵게** 말한다',
      '`*a*` 코드',
      '```\n*a* b\n```',
      '<span class="x">*a*</span> b',
      '리안: *웃는다* 안녕',
      '@카이: *잔을 든다* 건배.',
      '- *a* b',
      '# *제목* 장',
      '> *인용* 끝',
      '별표 없는 글',
      '* 목록',
    ]) {
      expect(separateActions(text), text).toBe(text);
    }
  });
});
