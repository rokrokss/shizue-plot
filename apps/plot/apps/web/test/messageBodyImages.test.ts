// @vitest-environment jsdom
/**
 * Images a message writes for itself, in markdown.
 *
 * The plot's own pictures arrive as `{{img::slug}}` and resolve to same-origin
 * asset URLs; anything else a model (or a card's lore) spells as `![](…)` must
 * not become a request — a foreign image is a beacon reporting the reader to
 * whoever wrote it. The display scripts' HTML has always been held to this; the
 * markdown path is held to it here.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../messages/ko.json';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const { MessageBody } = await import('../src/components/MessageBody');

const OPEN = '/api/plots/sty_1/assets/kiss';

let host: HTMLElement;
let root: Root;

async function render(content: string, extra: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(MessageBody, {
          content,
          assets: new Map([['kiss', OPEN]]),
          ...extra,
        }) as ReactNode,
      }),
    );
  });
}

const images = (): HTMLImageElement[] => [...host.querySelectorAll<HTMLImageElement>('img')];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('an image a message writes in markdown', () => {
  it.each([
    ['an absolute address', '![x](https://evil.test/p.png)'],
    ['a protocol-relative one', '![x](//evil.test/p.png)'],
    ['a backslash the browser would fold into a slash', '![x](/\\evil.test/p.png)'],
  ])('draws nothing and requests nothing for %s', async (_, markdown) => {
    await render(`문이 열린다. ${markdown} 끝.`);

    expect(images()).toEqual([]);
    expect(host.innerHTML).not.toContain('evil.test');
    // The prose around it is untouched.
    expect(host.textContent).toContain('문이 열린다.');
    expect(host.textContent).toContain('끝.');
  });

  it("still draws the plot's own images, by reference or by address", async () => {
    await render(`{{img::kiss}} 그리고 ![kiss](${OPEN})`);

    expect(images().map((image) => image.getAttribute('src'))).toEqual([OPEN, OPEN]);
  });
});

/** Zeta's pictures: in the flow between the bubbles, never inside one. */
describe('a picture on a line of its own', () => {
  const owned = { roster: [{ id: 'c1', name: '아리아', avatarUrl: null }], speaker: '아리아', mode: 'reply' };

  it('stands outside the bubble, between what was said before and after it', async () => {
    await render('*문을 연다.*\n{{img::kiss}}\n들어와.', owned);

    const figure = host.querySelector('[data-testid="chat-figure"]')!;
    expect(figure.querySelector('img')?.getAttribute('src')).toBe(OPEN);
    expect(figure.closest('.chat-bubble')).toBeNull();
    expect([...host.querySelectorAll('.chat-bubble')].map((node) => node.textContent)).toEqual(['문을 연다.', '들어와.']);
  });

  it('stays in the sentence it is written in', async () => {
    await render('여기 {{img::kiss}} 봐.', owned);
    expect(host.querySelector('[data-testid="chat-figure"]')).toBeNull();
    expect(host.querySelector('.chat-bubble img')?.getAttribute('src')).toBe(OPEN);
  });

  it('breaks a narration into the stretch before it and the one after, each with its mark', async () => {
    await render('바람이 분다.\n\n{{img::kiss}}\n\n늑대가 운다.', { mode: 'narration' });
    expect(host.querySelectorAll('.chat-narration')).toHaveLength(2);
    expect(host.querySelector('[data-testid="chat-figure"]')?.closest('.chat-narration')).toBeNull();
  });
});
