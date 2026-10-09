import { describe, expect, it } from 'vitest';
import { applyMacros, stripImageMacros } from '../src/macro.js';

const ctx = { char: '아리아', user: '민준' };

describe('applyMacros', () => {
  it('substitutes char and user, case-insensitively', () => {
    expect(applyMacros('{{char}}와 {{USER}}, {{ Char }}', ctx)).toBe('아리아와 민준, 아리아');
  });

  it('removes comments', () => {
    expect(applyMacros('앞{{// 숨은 메모}}뒤', ctx)).toBe('앞뒤');
  });

  it('picks one of the random options', () => {
    expect(applyMacros('{{random:빨강,파랑,초록}}', { ...ctx, random: () => 0 })).toBe('빨강');
    expect(applyMacros('{{random:빨강,파랑,초록}}', { ...ctx, random: () => 0.99 })).toBe('초록');
    expect(['빨강', '파랑', '초록']).toContain(applyMacros('{{random:빨강, 파랑, 초록}}', ctx));
  });

  it('rolls dice in 1..N', () => {
    expect(applyMacros('{{roll:d20}}', { ...ctx, random: () => 0 })).toBe('1');
    expect(applyMacros('{{roll:d20}}', { ...ctx, random: () => 0.999 })).toBe('20');
    expect(applyMacros('{{roll:6}}', { ...ctx, random: () => 0.5 })).toBe('4');
  });

  it('substitutes original only when a value is supplied', () => {
    expect(applyMacros('시작 {{original}} 끝', ctx)).toBe('시작 {{original}} 끝');
    expect(applyMacros('시작 {{original}} 끝', { ...ctx, original: '프리셋' })).toBe('시작 프리셋 끝');
  });

  it('leaves unsupported macros untouched', () => {
    expect(applyMacros('{{unknown}} {{setvar::a::1}}', ctx)).toBe('{{unknown}} {{setvar::a::1}}');
  });

  it('leaves image references in place — stripping them is the prompt assembler job', () => {
    expect(applyMacros('웃는다 {{img::smile}}', ctx)).toBe('웃는다 {{img::smile}}');
  });
});

describe('stripImageMacros', () => {
  it('removes every reference, however it is written', () => {
    expect(stripImageMacros('웃는다 {{img::smile}} 그리고 {{ IMG :: bg-2 }} 끝')).toBe(
      '웃는다  그리고  끝',
    );
  });

  it('keeps other macros and unknown slugs are not its problem', () => {
    expect(stripImageMacros('{{char}}가 {{img::존재하지-않음}} 웃는다')).toBe('{{char}}가  웃는다');
    expect(stripImageMacros('{{image::smile}}')).toBe('{{image::smile}}');
  });
});
