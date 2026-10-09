// @vitest-environment jsdom
/**
 * The markdown half of the message body, mounted.
 *
 * The unit tests cover the pieces; what only shows up here is the seam between
 * them — that a streaming message balances the block it is writing and no other,
 * that the reveal spans go when the stream ends without the text changing, and
 * that a settled message still comes out the way it always did.
 *
 * `createElement` rather than JSX, matching messageBody.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/displayPlanner', () => ({
  displayPlanner: { plan: () => new Promise(() => undefined), stop: () => undefined },
}));

const { MessageBody } = await import('../src/components/MessageBody');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

const MESSAGES = { chat: { copyCode: '코드 복사', copied: '복사됨' } };

function render(props: Record<string, unknown>): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages: MESSAGES,
        children: createElement(MessageBody, props as never) as ReactElement,
      }),
    );
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a settled message', () => {
  it('renders each block, in order, as one flat body', () => {
    render({ content: '첫 문단\n\n둘째 문단\n\n- 하나\n- 둘' });
    const body = host.querySelector('.message-body')!;
    expect([...body.children].map((child) => child.tagName)).toEqual(['P', 'P', 'UL']);
    expect(body.textContent).toBe('첫 문단둘째 문단\n하나\n둘\n');
  });

  it('renders GFM tables and strikethrough', () => {
    render({ content: '| a | b |\n| - | - |\n| 1 | 2 |\n\n~~취소~~' });
    expect(host.querySelector('table')).not.toBeNull();
    expect(host.querySelector('del')?.textContent).toBe('취소');
  });

  it('wraps dialogue and leaves stage directions as em', () => {
    render({ content: '*문을 열었다* 「돌아가라.」' });
    expect(host.querySelector('em')?.textContent).toBe('문을 열었다');
    expect(host.querySelector('q[data-dialogue]')?.textContent).toBe('「돌아가라.」');
  });

  it('gives a fenced block its language and a copy button', () => {
    render({ content: '```ts\nconst a = 1;\n```' });
    expect(host.querySelector('.code-block-lang')?.textContent).toBe('ts');
    expect(host.querySelector('.code-block-copy')?.textContent).toBe('코드 복사');
    expect(host.querySelector('pre')?.textContent).toBe('const a = 1;\n');
    // rehype-highlight ran, and the quote plugin stayed out of the code.
    expect(host.querySelector('pre code')?.className).toContain('hljs');
  });

  it('has no reveal spans', () => {
    render({ content: '아리아가 돌아섰다' });
    expect(host.querySelectorAll('.shizue-reveal')).toHaveLength(0);
  });
});

describe('a message being written', () => {
  it('closes the markers of the block it is writing, and only that block', () => {
    render({ content: '**첫 문단**\n\n그는 **천천히', streaming: true });
    const bolds = [...host.querySelectorAll('strong')].map((node) => node.textContent);
    expect(bolds).toEqual(['첫 문단', '천천히']);
  });

  it('leaves a settled block exactly as written', () => {
    render({ content: '별 하나 * 둘\n\n다음', streaming: true });
    expect(host.querySelector('.message-body')!.children[0]!.textContent).toBe('별 하나 * 둘');
  });

  it('reveals words, and drops the spans when the stream ends without moving text', () => {
    render({ content: '아리아가 천천히 돌아섰다', streaming: true });
    const revealed = [...host.querySelectorAll('.shizue-reveal')].map((node) => node.textContent);
    expect(revealed).toEqual(['아리아가', '천천히', '돌아섰다']);
    const before = host.querySelector('.message-body')!.textContent;

    render({ content: '아리아가 천천히 돌아섰다', streaming: false });
    expect(host.querySelectorAll('.shizue-reveal')).toHaveLength(0);
    expect(host.querySelector('.message-body')!.textContent).toBe(before);
  });

  it('keeps the span of a word already on screen as more arrive', () => {
    render({ content: '아리아가 천천히', streaming: true });
    const first = host.querySelector('.shizue-reveal');
    render({ content: '아리아가 천천히 돌아섰다', streaming: true });
    // Same node, not a new one: a remount would replay the fade.
    expect(host.querySelector('.shizue-reveal')).toBe(first);
    expect(host.querySelectorAll('.shizue-reveal')).toHaveLength(3);
  });
});
