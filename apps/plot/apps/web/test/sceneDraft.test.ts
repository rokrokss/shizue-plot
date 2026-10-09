// @vitest-environment jsdom
/**
 * The row a drawn scene stands in while it is being drawn.
 *
 * Two things are worth holding: the box keeps the aspect the picture will land
 * in, so nothing jumps when the real message replaces it; and the shimmer is
 * given up under `prefers-reduced-motion` while the label stays, because the
 * label is what actually says what is happening.
 *
 * `createElement` rather than JSX, matching messageAttachments.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { SceneDraft } = await import('../src/components/SceneDraft');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MESSAGES = {
  chat: { drawingScene: '장면을 그리는 중…', drawFailed: '이미지를 만들지 못했습니다' },
  common: { retry: '다시 시도' },
};

let host: HTMLElement;
let root: Root;

function render(status: 'drawing' | 'failed', onRetry: () => void = () => undefined): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages: MESSAGES,
        children: createElement(SceneDraft, { status, onRetry }) as ReactElement,
      }),
    );
  });
}

const box = (): HTMLElement => host.querySelector('[data-testid="scene-draft"] > div > div')!;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('SceneDraft', () => {
  it('reserves the picture’s box and says what is happening while it draws', () => {
    render('drawing');
    expect(box().style.aspectRatio).toBe('4 / 3');
    expect(host.textContent).toContain('장면을 그리는 중…');
    expect(host.textContent).not.toContain('다시 시도');
    // The shimmer is only for the eye; the label is the news for everyone else.
    expect(host.querySelector('[role="status"]')?.textContent).toBe('장면을 그리는 중…');
  });

  it('keeps the row and offers the retry when nothing came back', () => {
    const onRetry = vi.fn();
    render('failed', onRetry);

    expect(box().style.aspectRatio).toBe('4 / 3');
    expect(box().className).not.toContain('animate-pulse');
    expect(host.textContent).toContain('이미지를 만들지 못했습니다');
    // Nothing was stored, so the failure speaks up rather than waiting to be read.
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('이미지를 만들지 못했습니다');

    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '다시 시도',
    )!;
    act(() => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
