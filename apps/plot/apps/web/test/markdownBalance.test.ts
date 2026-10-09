/**
 * Closing what a half-written block left open.
 *
 * Everything here is about the block the model is still typing, so the bar is
 * "what would this have meant if they had stopped here", not "what is valid".
 */
import { describe, expect, it } from 'vitest';
import { balancePartial } from '../src/lib/markdown/balance';

describe('balancePartial', () => {
  it('leaves a finished block alone', () => {
    const md = '그는 **천천히** 문을 열었다. `const a = 1` 이라고 적혀 있었다.';
    expect(balancePartial(md)).toBe(md);
  });

  it('closes a bold run mid-word', () => {
    expect(balancePartial('그는 **천천히')).toBe('그는 **천천히**');
  });

  it('closes italics', () => {
    expect(balancePartial('아리아가 *뒤를 돌아')).toBe('아리아가 *뒤를 돌아*');
  });

  it('closes the inner emphasis first', () => {
    expect(balancePartial('**굵게 *기울여')).toBe('**굵게 *기울여***');
  });

  it('does not close what is already closed', () => {
    expect(balancePartial('**굵게** 그리고 *기울여* 다음')).toBe('**굵게** 그리고 *기울여* 다음');
  });

  it('closes strikethrough', () => {
    expect(balancePartial('~~취소된 말')).toBe('~~취소된 말~~');
  });

  it('closes an inline code span with the run that opened it', () => {
    expect(balancePartial('값은 ``a `b')).toBe('값은 ``a `b``');
  });

  it('does not balance emphasis inside inline code', () => {
    expect(balancePartial('`**여기는 코드')).toBe('`**여기는 코드`');
  });

  it('closes an open fence on its own line', () => {
    expect(balancePartial('```ts\nconst a = 1;')).toBe('```ts\nconst a = 1;\n```');
    expect(balancePartial('~~~\n한 줄\n')).toBe('~~~\n한 줄\n~~~');
  });

  it('leaves markup inside a fence exactly as written', () => {
    expect(balancePartial('```\n**not bold\n')).toBe('```\n**not bold\n```');
  });

  it('does not balance emphasis in a fence that is already closed', () => {
    const md = '```\n**a**\n```\n뒤에 *기울여';
    expect(balancePartial(md)).toBe('```\n**a**\n```\n뒤에 *기울여*');
  });

  it('shows a half-typed link as its text', () => {
    expect(balancePartial('자세한 내용은 [공식 문서](https://exa')).toBe('자세한 내용은 공식 문서');
    expect(balancePartial('여기 [문서](')).toBe('여기 문서');
  });

  it('drops a half-typed image rather than showing its alt', () => {
    expect(balancePartial('보라 ![aria-portrait](http')).toBe('보라 ');
  });

  it('leaves a finished link alone', () => {
    const md = '[문서](https://example.com) 를 보라';
    expect(balancePartial(md)).toBe(md);
  });

  it('does not mistake a bullet or a rule for emphasis', () => {
    expect(balancePartial('* 첫째\n* 둘째')).toBe('* 첫째\n* 둘째');
    expect(balancePartial('***\n다음 문단')).toBe('***\n다음 문단');
  });

  it('leaves an escaped marker escaped', () => {
    expect(balancePartial('별표 \\* 하나')).toBe('별표 \\* 하나');
  });

  it('carries emphasis across the lines of one block', () => {
    expect(balancePartial('**첫 줄\n둘째 줄')).toBe('**첫 줄\n둘째 줄**');
  });
});
