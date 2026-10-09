// @vitest-environment jsdom
/**
 * The lightbox, opened the way a reader opens it: by clicking an image inside a
 * message. What is worth testing is not the panel but its edges — that it walks
 * the images of the message it was opened from, in the order they were drawn,
 * and that every way out of it works.
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

const MESSAGES = {
  chat: {
    copyCode: '코드 복사',
    copied: '복사됨',
    imageError: '실패',
    download: '다운로드',
    imagePrev: '이전 이미지',
    imageNext: '다음 이미지',
  },
  common: { close: '닫기' },
};

const ASSETS = new Map([
  ['smile', '/api/plots/c1/assets/smile'],
  ['cry', '/api/plots/c1/assets/cry'],
]);

let host: HTMLElement;
let root: Root;

function render(content: string): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages: MESSAGES,
        children: createElement(MessageBody, { content, assets: ASSETS } as never) as ReactElement,
      }),
    );
  });
}

const panel = (): HTMLElement | null => document.body.querySelector('[data-testid="lightbox"]');
const shown = (): string | undefined => panel()?.querySelector('img')?.getAttribute('src') ?? undefined;

function click(node: Element): void {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

/** The images of the message, in the order the markdown drew them. */
const bodyImages = (): HTMLImageElement[] => [
  ...host.querySelectorAll<HTMLImageElement>('img[data-chat-image]'),
];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('opening', () => {
  it('shows the image that was clicked', () => {
    render('{{img::smile}}');
    expect(panel()).toBeNull();
    click(bodyImages()[0]!);
    expect(shown()).toBe('/api/plots/c1/assets/smile');
    expect(panel()!.querySelector('a[download]')?.textContent).toBe('다운로드');
    expect(panel()!.querySelector('[aria-label="닫기"]')).not.toBeNull();
  });

  it('opens from the keyboard, takes the focus, and gives it back on close', () => {
    render('{{img::smile}}');
    const image = bodyImages()[0]!;
    image.focus();
    expect(document.activeElement).toBe(image);

    act(() => {
      image.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(shown()).toBe('/api/plots/c1/assets/smile');
    expect(document.activeElement).toBe(panel());

    press('Escape');
    expect(document.activeElement).toBe(image);
  });

  it('cycles Tab inside the dialog instead of letting it reach the chat behind', () => {
    render('{{img::smile}}');
    click(bodyImages()[0]!);
    const download = panel()!.querySelector<HTMLElement>('a[download]')!;
    const close = panel()!.querySelector<HTMLElement>('[aria-label="닫기"]')!;

    // Forward off the last control wraps to the first…
    act(() => close.focus());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(download);

    // …and backward off the first wraps to the last.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(close);

    // Focus that somehow ended up outside is pulled back in.
    act(() => (document.body as HTMLElement).focus?.());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(panel()!.contains(document.activeElement)).toBe(true);
  });
});

describe('closing', () => {
  it('closes on Escape', () => {
    render('{{img::smile}}');
    click(bodyImages()[0]!);
    press('Escape');
    expect(panel()).toBeNull();
  });

  it('closes on a click in the backdrop, but not on the image itself', () => {
    render('{{img::smile}}');
    click(bodyImages()[0]!);
    click(panel()!.querySelector('img')!);
    expect(panel()).not.toBeNull();
    click(panel()!);
    expect(panel()).toBeNull();
  });

  it('closes with the close button', () => {
    render('{{img::smile}}');
    click(bodyImages()[0]!);
    click(panel()!.querySelector('[aria-label="닫기"]')!);
    expect(panel()).toBeNull();
  });
});

describe('walking a message with more than one image', () => {
  it('moves through them with the arrow keys, wrapping at both ends', () => {
    render('{{img::smile}} 그리고 {{img::cry}}');
    expect(bodyImages()).toHaveLength(2);
    click(bodyImages()[0]!);
    expect(shown()).toBe('/api/plots/c1/assets/smile');

    press('ArrowRight');
    expect(shown()).toBe('/api/plots/c1/assets/cry');
    press('ArrowRight');
    expect(shown()).toBe('/api/plots/c1/assets/smile');
    press('ArrowLeft');
    expect(shown()).toBe('/api/plots/c1/assets/cry');
  });

  it('opens on the one that was clicked and counts them', () => {
    render('{{img::smile}} 그리고 {{img::cry}}');
    click(bodyImages()[1]!);
    expect(shown()).toBe('/api/plots/c1/assets/cry');
    expect(panel()!.textContent).toContain('2 / 2');
  });

  it('leaves the arrow keys alone for a single image', () => {
    render('{{img::smile}}');
    click(bodyImages()[0]!);
    press('ArrowRight');
    expect(shown()).toBe('/api/plots/c1/assets/smile');
    expect(panel()!.textContent).not.toContain('1 / 1');
  });

  it('walks them with the on-screen arrows too, which a single image does not get', () => {
    render('{{img::smile}}');
    click(bodyImages()[0]!);
    expect(panel()!.querySelector('[aria-label="다음 이미지"]')).toBeNull();
    press('Escape');

    render('{{img::smile}} 그리고 {{img::cry}}');
    click(bodyImages()[0]!);
    click(panel()!.querySelector('[aria-label="다음 이미지"]')!);
    expect(shown()).toBe('/api/plots/c1/assets/cry');
    click(panel()!.querySelector('[aria-label="이전 이미지"]')!);
    expect(shown()).toBe('/api/plots/c1/assets/smile');
    // Wrapping, the same way the keys do.
    click(panel()!.querySelector('[aria-label="이전 이미지"]')!);
    expect(shown()).toBe('/api/plots/c1/assets/cry');
  });

  it('keeps the arrows inside the focus cycle', () => {
    render('{{img::smile}} 그리고 {{img::cry}}');
    click(bodyImages()[0]!);
    const next = panel()!.querySelector<HTMLElement>('[aria-label="다음 이미지"]')!;
    const download = panel()!.querySelector<HTMLElement>('a[download]')!;

    // The arrows are drawn after the header, so the next one is where Tab wraps.
    act(() => next.focus());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(download);
  });
});
