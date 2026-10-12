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

async function render(content: string): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(MessageBody, {
          content,
          assets: new Map([['kiss', OPEN]]),
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
