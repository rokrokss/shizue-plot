import { describe, expect, it } from 'vitest';
import { messageSnippet } from '../src/lib/chatSnippet';

describe('messageSnippet', () => {
  it('drops the narration prefix the reader never sees', () => {
    expect(messageSnippet('@: 문이 열리고 바람이 들이쳤다')).toBe('문이 열리고 바람이 들이쳤다');
  });

  it('reads the markdown as the words it formats', () => {
    expect(messageSnippet('*문을 열었다* **정말로**')).toBe('문을 열었다 정말로');
    expect(messageSnippet('[도서관](https://example.com)에서')).toBe('도서관에서');
    expect(messageSnippet('![그림](https://example.com/a.png) 벽에 걸린')).toBe('벽에 걸린');
    expect(messageSnippet('# 제목\n> 인용\n- 목록')).toBe('제목 인용 목록');
  });

  it('leaves out the macros, which are protocol rather than prose', () => {
    expect(messageSnippet('{{img::wall}}벽에 걸린 그림')).toBe('벽에 걸린 그림');
    expect(messageSnippet('안녕하세요, {{user}}.')).toBe('안녕하세요, .');
  });

  it('collapses a message down to one line', () => {
    expect(messageSnippet('첫 줄\n\n둘째 줄  ')).toBe('첫 줄 둘째 줄');
    expect(messageSnippet('')).toBe('');
  });
});
