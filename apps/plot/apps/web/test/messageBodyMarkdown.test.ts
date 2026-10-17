// @vitest-environment jsdom
/**
 * The markdown half of the message body, mounted.
 *
 * The unit tests cover the pieces; what only shows up here is the seam between
 * them — that a streaming message shows the speaker's stretch it is writing as
 * written, as Zeta does, and draws it as markdown once that stretch is done, and
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
  displayPlanner: { plan: () => new Promise(() => undefined), cached: () => undefined, warm: () => true, stop: () => undefined },
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

  it("parts an action from the words in a reply and in the reader's turn, and leaves narration as written", () => {
    const paragraphs = () => [...host.querySelectorAll('.message-body p')].map((p) => p.innerHTML);
    render({ content: '*카타나를 쥐며* 합동 훈련 따위 필요 없어.', mode: 'reply' });
    expect(paragraphs()).toEqual(['<em>카타나를 쥐며</em>', '합동 훈련 따위 필요 없어.']);
    render({ content: '*웃으며* 반가워.' });
    expect(paragraphs()).toEqual(['<em>웃으며</em>', '반가워.']);
    render({ content: '*바람이 분다* 문이 열린다.', mode: 'narration' });
    expect(paragraphs()).toEqual(['<em>바람이 분다</em> 문이 열린다.']);
  });

  it('gives a fenced block its language and a copy button', () => {
    render({ content: '```ts\nconst a = 1;\n```' });
    expect(host.querySelector('.code-block-lang')?.textContent).toBe('ts');
    expect(host.querySelector('.code-block-copy')?.textContent).toBe('코드 복사');
    expect(host.querySelector('pre')?.textContent).toBe('const a = 1;\n');
    // rehype-highlight ran, and the quote plugin stayed out of the code.
    expect(host.querySelector('pre code')?.className).toContain('hljs');
  });
});

describe('a message being written', () => {
  const ROSTER = [
    { id: 'c1', name: '아리아', avatarUrl: null },
    { id: 'c2', name: '레온', avatarUrl: null },
  ];

  it('shows the stretch it is writing as written, every block of it', () => {
    render({ content: '**첫 문단**\n\n그는 *천천히* 돌아섰다', streaming: true });
    expect(host.querySelector('strong, em')).toBeNull();
    const body = host.querySelector('.message-body')!;
    expect([...body.children].map((child) => child.textContent)).toEqual(['**첫 문단**', '그는 *천천히* 돌아섰다']);
  });

  it('draws it as markdown once the stream ends', () => {
    render({ content: '**첫 문단**\n\n그는 *천천히* 돌아섰다', streaming: true });
    render({ content: '**첫 문단**\n\n그는 *천천히* 돌아섰다', streaming: false });
    expect(host.querySelector('strong')?.textContent).toBe('첫 문단');
    expect(host.querySelector('em')?.textContent).toBe('천천히');
  });

  it("draws a speaker's stretch once the next speaker begins", () => {
    render({ content: '아리아: *웃는다* 왔구나.\n\n레온: *고개를 끄덕', roster: ROSTER, mode: 'reply', streaming: true });
    const aria = host.querySelector('[data-speaker="아리아"]')!;
    const leon = host.querySelector('[data-speaker="레온"]')!;
    expect(aria.querySelector('em')?.textContent).toBe('웃는다');
    expect(leon.querySelector('em')).toBeNull();
    expect(leon.querySelector('.chat-bubble')?.textContent).toBe('*고개를 끄덕');
  });
});
