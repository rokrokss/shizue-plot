import { describe, expect, it } from 'vitest';
import { extractChoices } from '../src/choices.js';

describe('extractChoices', () => {
  it('splits the trailing run off the end of a turn', () => {
    expect(extractChoices('문이 닫혔다.\n\n>> 방을 둘러본다\n>> 문을 두드린다')).toEqual({
      body: '문이 닫혔다.',
      choices: ['방을 둘러본다', '문을 두드린다'],
    });
  });

  it('leaves a turn without a trailing run exactly as it was', () => {
    const content = '문이 닫혔다.\n\n아리아: 늦었네요.\n';
    expect(extractChoices(content)).toEqual({ body: content, choices: [] });
  });

  it('reads a `>>` that is not in the trailing run as prose', () => {
    const content = '>> 라고 적힌 표지판이 서 있다.\n\n아리아: 저건 뭐죠?';
    expect(extractChoices(content)).toEqual({ body: content, choices: [] });
    // The same line above a run stays prose; only the run at the end is offers.
    expect(extractChoices(`${content}\n\n>> 표지판을 읽는다`)).toEqual({
      body: content,
      choices: ['표지판을 읽는다'],
    });
  });

  it('reads a run that is the whole turn, and treats blank lines inside it as spacing', () => {
    expect(extractChoices('>> 방을 둘러본다\n\n>> 문을 두드린다\n')).toEqual({
      body: '',
      choices: ['방을 둘러본다', '문을 두드린다'],
    });
  });

  it('waits for the text of a line that is still arriving', () => {
    const streaming = '문이 닫혔다.\n\n>> ';
    expect(extractChoices(streaming)).toEqual({ body: streaming, choices: [] });
    expect(extractChoices(`${streaming}방을`).choices).toEqual(['방을']);
  });
});
