// @vitest-environment jsdom
/**
 * The images a turn was sent with, mounted.
 *
 * Two things are worth holding: the shape of the grid, and that the set of them
 * is one group in the lightbox — they are drawn above the message body rather
 * than inside it, so the grouping the markdown images get had to be extended
 * rather than inherited.
 *
 * `createElement` rather than JSX, matching chatImage.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatAttachment } from '../src/lib/types';

const { MessageAttachments } = await import('../src/components/MessageAttachments');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MESSAGES = {
  chat: {
    imageError: '이미지를 불러오지 못했습니다',
    download: '다운로드',
    imagePrev: '이전 이미지',
    imageNext: '다음 이미지',
  },
  common: { close: '닫기' },
};

const attachment = (id: string, measured = true): ChatAttachment => ({
  id,
  url: `/api/chats/c1/attachments/${id}`,
  mime: 'image/png',
  ...(measured
    ? { width: 800, height: 600, thumbhash: 'HBkSHYSIeHiPiHh8eJd4h4eAeIhw==' }
    : { width: null, height: null, thumbhash: null }),
});

let host: HTMLElement;
let root: Root;

function render(attachments: ChatAttachment[]): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages: MESSAGES,
        children: createElement(MessageAttachments, { attachments }) as ReactElement,
      }),
    );
  });
}

const images = (): HTMLImageElement[] => [...host.querySelectorAll('[data-chat-image]')] as never;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('MessageAttachments', () => {
  it('draws nothing at all for a turn that carries none', () => {
    render([]);
    expect(host.innerHTML).toBe('');
  });

  it('reserves each box from the measurement the composer took', () => {
    render([attachment('a'), attachment('b', false)]);
    const [measured, unmeasured] = images();
    expect(measured!.getAttribute('width')).toBe('800');
    expect(measured!.style.aspectRatio).toBe('800 / 600');
    // An image the browser could not decode still shows, just without a box.
    expect(unmeasured!.getAttribute('width')).toBeNull();
    expect(unmeasured!.style.aspectRatio).toBe('');
  });

  it('opens the whole set in the lightbox, starting at the one clicked', () => {
    render([attachment('a'), attachment('b')]);
    act(() => {
      images()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const lightbox = document.querySelector('[data-testid="lightbox"]')!;
    expect(lightbox.textContent).toContain('2 / 2');
    expect(lightbox.querySelector('img')!.getAttribute('src')).toContain('/attachments/b');
  });
});
