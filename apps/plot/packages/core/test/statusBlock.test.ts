import { describe, expect, it } from 'vitest';
import { extractStatusBlock, parseStatusEntries } from '../src/statusBlock.js';

const status = '위치: 여관 로비\n시간: 자정';

describe('extractStatusBlock', () => {
  it('splits the fence off the end of a turn', () => {
    expect(extractStatusBlock(`문이 닫혔다.\n\n\`\`\`status\n${status}\n\`\`\``)).toEqual({
      body: '문이 닫혔다.',
      status,
    });
  });

  it('leaves a turn without a fence exactly as it was', () => {
    const content = '문이 닫혔다.\n\n아리아: 늦었네요.\n';
    expect(extractStatusBlock(content)).toEqual({ body: content, status: null });
    // A fence of another kind is somebody else's block.
    const code = '```js\nconst a = 1;\n```';
    expect(extractStatusBlock(code)).toEqual({ body: code, status: null });
  });

  it('takes the last fence, which is the current state', () => {
    const older = '위치: 눈길';
    const { body, status: kept } = extractStatusBlock(
      `\`\`\`status\n${older}\n\`\`\`\n\n문이 닫혔다.\n\n\`\`\`status\n${status}\n\`\`\``,
    );
    expect(kept).toBe(status);
    // The one it did not take stays where it was written.
    expect(body).toBe(`\`\`\`status\n${older}\n\`\`\`\n\n문이 닫혔다.`);
  });

  it('leaves a closed fence alone when prose follows it', () => {
    // An early fence a stream has already moved past is not the current state —
    // extracting it would reorder the message around the card.
    const passed = `\`\`\`status\n위치: 눈길\n\`\`\`\n\n문이 다시 열렸다.`;
    expect(extractStatusBlock(passed)).toEqual({ body: passed, status: null });
  });

  it('leaves a trailing code fence that is not a status block alone', () => {
    const code = '설명이다.\n\n```js\nconsole.log(1)\n```';
    expect(extractStatusBlock(code)).toEqual({ body: code, status: null });
  });

  it('leaves an unterminated fence in the body while the message is still arriving', () => {
    const streaming = '문이 닫혔다.\n\n```status\n위치: 여관 로';
    expect(extractStatusBlock(streaming)).toEqual({ body: streaming, status: null });
    // …and reads as the block the moment the closing fence lands.
    expect(extractStatusBlock(`${streaming}비\n\`\`\``).status).toBe('위치: 여관 로비');
  });

  it('reads the same fence written with CRLF line endings', () => {
    expect(extractStatusBlock('문이 닫혔다.\r\n\r\n```status\r\n위치: 여관 로비\r\n```')).toEqual({
      body: '문이 닫혔다.',
      status: '위치: 여관 로비',
    });
  });

  it('reads an empty block as an empty status rather than as none', () => {
    expect(extractStatusBlock('문이 닫혔다.\n```status\n```')).toEqual({
      body: '문이 닫혔다.',
      status: '',
    });
  });
});

describe('parseStatusEntries', () => {
  it('splits each line at its first colon', () => {
    expect(parseStatusEntries(status)).toEqual([
      { key: '위치', value: '여관 로비' },
      { key: '시간', value: '자정' },
    ]);
    expect(parseStatusEntries('시간: 23:59')).toEqual([{ key: '시간', value: '23:59' }]);
  });

  it('reads a line without a colon as a value with no key, and skips the blanks', () => {
    expect(parseStatusEntries('  위치: 여관 로비  \n\n눈보라가 그치지 않는다\n')).toEqual([
      { key: '위치', value: '여관 로비' },
      { key: '', value: '눈보라가 그치지 않는다' },
    ]);
    expect(parseStatusEntries('')).toEqual([]);
  });
});
