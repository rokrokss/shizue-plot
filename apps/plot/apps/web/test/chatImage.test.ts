// @vitest-environment jsdom
/**
 * A character image inside a message, mounted.
 *
 * The whole point of the measurement is what happens *before* the bytes arrive,
 * so every case here is about that moment: the box the image will occupy, the
 * placeholder standing in it, and what is drawn when the image never comes. The
 * path is the real one — `{{img::slug}}` through the markdown pass — because the
 * measurement travels in the src and that is the thing worth testing.
 *
 * `createElement` rather than JSX, matching messageBody.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { rgbaToThumbHash } from 'thumbhash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/displayPlanner', () => ({
  displayPlanner: { plan: () => new Promise(() => undefined), stop: () => undefined },
}));

const { MessageBody } = await import('../src/components/MessageBody');
const { assetSrc } = await import('../src/lib/assets');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MESSAGES = {
  chat: {
    copyCode: '코드 복사',
    copied: '복사됨',
    imageError: '이미지를 불러오지 못했습니다',
    download: '다운로드',
    imagePrev: '이전 이미지',
    imageNext: '다음 이미지',
  },
  common: { close: '닫기' },
};

/** A real hash, so the decode in the component is the one under test. */
function thumbhashOf(r: number, g: number, b: number): string {
  const pixels = new Uint8Array(4 * 4 * 4);
  for (let at = 0; at < pixels.length; at += 4) pixels.set([r, g, b, 255], at);
  const hash = rgbaToThumbHash(4, 4, pixels);
  return btoa(String.fromCharCode(...hash));
}

const measured = (slug: string) =>
  assetSrc({
    slug,
    url: `/api/plots/c1/assets/${slug}`,
    mime: 'image/png',
    width: 800,
    height: 400,
    thumbhash: thumbhashOf(120, 90, 60),
    createdAt: '2026-08-11T00:00:00.000Z',
  });

const unmeasured = (slug: string) =>
  assetSrc({
    slug,
    url: `/api/plots/c1/assets/${slug}`,
    mime: 'image/png',
    width: null,
    height: null,
    thumbhash: null,
    createdAt: '2026-08-11T00:00:00.000Z',
  });

let host: HTMLElement;
let root: Root;

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

const image = (): HTMLImageElement => host.querySelector('img')!;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a measured image', () => {
  beforeEach(() => {
    render({ content: '웃는다 {{img::smile}}', assets: new Map([['smile', measured('smile')]]) });
  });

  it('reserves its box before the bytes arrive', () => {
    const img = image();
    expect(img.getAttribute('width')).toBe('800');
    expect(img.getAttribute('height')).toBe('400');
    expect(img.style.aspectRatio).toBe('800 / 400');
    // The clamp the messages always had is still the one that applies.
    expect(img.className).toContain('max-h-96');
  });

  it('paints the thumbhash in that box, and holds the image back', () => {
    const backdrop = image().parentElement!;
    // Compared by its head: the data URL itself is a few kilobytes of PNG.
    expect(backdrop.style.backgroundImage.slice(0, 27)).toBe('url("data:image/png;base64,');
    expect(image().className).toContain('opacity-0');
  });

  it('fades the image in over the placeholder once it loads', () => {
    vi.useFakeTimers();
    act(() => {
      image().dispatchEvent(new Event('load'));
    });
    expect(image().className).toContain('opacity-100');
    expect(image().className).toContain('transition-opacity');
    // Static for a reader who asked for no motion.
    expect(image().className).toContain('motion-reduce:transition-none');
    // The placeholder is still there to fade in over…
    expect(image().parentElement!.style.backgroundImage).not.toBe('');

    act(() => {
      vi.advanceTimersByTime(200);
    });
    // …and goes once there is nothing left to stand in for.
    expect(image().parentElement!.style.backgroundImage).toBe('');
    vi.useRealTimers();
  });

  it('draws a quiet tile in the same box when the image fails', () => {
    act(() => {
      image().dispatchEvent(new Event('error'));
    });
    expect(host.querySelector('img')).toBeNull();
    const tile = host.querySelector('[data-testid="chat-image-error"]') as HTMLElement;
    expect(tile.textContent).toBe('이미지를 불러오지 못했습니다');
    expect(tile.style.aspectRatio).toBe('800 / 400');
  });

  it('names the tile as the image it stands in for', () => {
    act(() => {
      image().dispatchEvent(new Event('error'));
    });
    const tile = host.querySelector('[data-testid="chat-image-error"]') as HTMLElement;
    // One thing with a name, where the image was.
    expect(tile.getAttribute('role')).toBe('img');
    expect(tile.getAttribute('aria-label')).toBe('이미지를 불러오지 못했습니다');
    // Named, not announced — a message can hold a dozen images.
    expect(tile.hasAttribute('aria-live')).toBe(false);
  });
});

describe('an image from before the measurement existed', () => {
  it('renders exactly as it always did', () => {
    render({ content: '{{img::old}}', assets: new Map([['old', unmeasured('old')]]) });
    const img = image();
    expect(img.getAttribute('src')).toBe('/api/plots/c1/assets/old');
    expect(img.hasAttribute('width')).toBe(false);
    expect(img.style.aspectRatio).toBe('');
    expect(img.className).toContain('max-h-96');
    // No placeholder to fade in from, so the image is never held back.
    expect(img.className).toContain('opacity-100');
    expect(img.parentElement!.style.backgroundImage).toBe('');
  });

  it('still shows the error tile, without a box', () => {
    render({ content: '{{img::old}}', assets: new Map([['old', unmeasured('old')]]) });
    act(() => {
      image().dispatchEvent(new Event('error'));
    });
    const tile = host.querySelector('[data-testid="chat-image-error"]') as HTMLElement;
    expect(tile.textContent).toBe('이미지를 불러오지 못했습니다');
    expect(tile.style.aspectRatio).toBe('');
  });
});

describe('the alt text', () => {
  it('is the slug the message referred to', () => {
    render({ content: '{{img::smile}}', assets: new Map([['smile', measured('smile')]]) });
    expect(image().alt).toBe('smile');
  });
});
