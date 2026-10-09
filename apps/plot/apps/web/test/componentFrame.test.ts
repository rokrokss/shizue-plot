// @vitest-environment jsdom
/**
 * The frame's handshake, from the outside.
 *
 * `componentBridge.test.ts` covers what the bridge honours; this is about the
 * case where nothing comes back at all. A frame that never says `ready` used to
 * leave a 24px box that stayed empty for the rest of the conversation, with
 * nothing on screen to say why or to try again — so what is checked here is the
 * deadline, the card it turns into, and that a retry really is a fresh frame
 * rather than the old one's second load, which the bridge reads as a navigation.
 *
 * `createElement` rather than JSX, matching bottomSheet.test.ts.
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFrame } from '../src/components/ComponentFrame';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** Matches `HANDSHAKE_TIMEOUT_MS`, which the component keeps to itself. */
const DEADLINE = 10_000;

let host: HTMLElement;
let root: Root;

function render(): void {
  act(() => {
    root.render(
      createElement(ComponentFrame, {
        code: 'export function StatusWindow() { return null; }',
        name: 'StatusWindow',
        props: {},
        platform: {} as never,
        errorLabel: '컴포넌트 오류',
        navigatedLabel: '이동',
        timeoutLabel: '컴포넌트가 제때 응답하지 않아 불러오기를 멈췄습니다.',
        retryLabel: '다시 시도',
      } as never) as ReactElement,
    );
  });
}

const frame = (): HTMLIFrameElement | null => host.querySelector('[data-testid="component-frame"]');
const card = (): HTMLElement | null => host.querySelector('[data-testid="component-timeout"]');
const retry = (): HTMLButtonElement => card()!.querySelector('button')!;

const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('a frame that does complete the handshake', () => {
  it('is never taken off the page by the deadline', () => {
    render();
    const source = frame()!.contentWindow;
    act(() => {
      const event = new MessageEvent('message', { data: { type: 'ready' } });
      // `source` is read-only on a constructed event; the identity is all the
      // bridge's guard reads, matching componentBridge.test.ts.
      Object.defineProperty(event, 'source', { value: source });
      window.dispatchEvent(event);
    });

    wait(DEADLINE);
    expect(frame()).not.toBeNull();
    expect(card()).toBeNull();
  });
});

describe('a frame that never completes the handshake', () => {
  it('is given the whole deadline first', () => {
    render();
    expect(frame()).not.toBeNull();
    wait(DEADLINE - 1);
    expect(frame()).not.toBeNull();
    expect(card()).toBeNull();
  });

  it('gives way to a card in the same tone as the navigated one', () => {
    render();
    wait(DEADLINE);
    expect(frame()).toBeNull();
    const shown = card()!;
    expect(shown.getAttribute('role')).toBe('alert');
    expect(shown.textContent).toContain('컴포넌트 오류');
    expect(shown.textContent).toContain('제때 응답하지 않아');
    // Not the navigated card wearing a different detail.
    expect(host.querySelector('[data-testid="component-lost"]')).toBeNull();
  });

  it('mounts a fresh frame when the retry is pressed', () => {
    render();
    wait(DEADLINE);
    const first = frame();
    act(() => retry().click());

    expect(card()).toBeNull();
    const second = frame();
    expect(second).not.toBeNull();
    // A new element, not the old one re-shown: the old bridge has already counted
    // a load, and a second on it would be read as the frame navigating away.
    expect(second).not.toBe(first);
    expect(host.querySelector('[data-testid="component-lost"]')).toBeNull();
  });

  it('holds the retried frame to a deadline of its own', () => {
    render();
    wait(DEADLINE);
    act(() => retry().click());

    wait(DEADLINE - 1);
    expect(frame()).not.toBeNull();
    wait(1);
    expect(card()).not.toBeNull();
  });

  /**
   * The frame the retry mounted is a different frame on a different bridge, and
   * its handshake has to be heard the same way the first one was.
   *
   * What this does *not* cover, and cannot: the component keeps one listener
   * for its whole life so that a handshake landing between the render that
   * swaps the bridge and the effect after it still reaches the current one.
   * `act` flushes effects with the commit, so that gap does not exist here —
   * this passes either way, and the single listener stands on the reasoning
   * rather than on this test.
   */
  it('hears the retried frame say ready', () => {
    render();
    wait(DEADLINE);
    act(() => retry().click());

    act(() => {
      const event = new MessageEvent('message', { data: { type: 'ready' } });
      Object.defineProperty(event, 'source', { value: frame()!.contentWindow });
      window.dispatchEvent(event);
    });
    wait(DEADLINE);
    expect(frame()).not.toBeNull();
    expect(card()).toBeNull();
  });
});
