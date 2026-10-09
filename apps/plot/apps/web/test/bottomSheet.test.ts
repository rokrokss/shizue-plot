// @vitest-environment jsdom
/**
 * The sheet the chat's settings come up in on a narrow screen. What matters is
 * that it is as modal as it says it is: every way out works, and the keyboard
 * stays inside it while it is open.
 *
 * `createElement` rather than JSX, matching lightbox.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from '../src/components/BottomSheet';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MESSAGES = { common: { close: '닫기' } };

let host: HTMLElement;
let root: Root;
let onClose: () => void;

function open(): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages: MESSAGES,
        children: createElement(BottomSheet, {
          title: '대화 설정',
          onClose,
          // A form control last, which is what the chat's settings actually put
          // there — and where the trap used to leak.
          children: [
            createElement('button', { type: 'button', key: 'note' }, '메모'),
            createElement('select', { key: 'model', 'aria-label': '모델' }),
          ],
        }) as ReactElement,
      }),
    );
  });
}

const sheet = (): HTMLElement | null => document.body.querySelector('[data-testid="bottom-sheet"]');
const closeButton = (): HTMLElement => sheet()!.querySelector<HTMLElement>('[aria-label="닫기"]')!;
const childButton = (): HTMLElement =>
  [...sheet()!.querySelectorAll<HTMLElement>('button')].find((node) => node.textContent === '메모')!;
const childSelect = (): HTMLElement => sheet()!.querySelector<HTMLElement>('select')!;

function click(node: Element): void {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function press(key: string, shiftKey = false): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
  });
}

beforeEach(() => {
  onClose = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('BottomSheet', () => {
  it('names itself, carries its controls, and takes the focus', () => {
    open();
    expect(sheet()!.getAttribute('aria-label')).toBe('대화 설정');
    expect(sheet()!.getAttribute('aria-modal')).toBe('true');
    expect(childButton()).not.toBeUndefined();
    expect(document.activeElement).toBe(sheet());
  });

  it('closes on Escape, on the close button, and on the backdrop', () => {
    open();
    press('Escape');
    click(closeButton());
    click(sheet()!.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('does not close on a click inside it', () => {
    open();
    click(sheet()!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cycles Tab inside itself rather than letting it reach the chat behind', () => {
    open();
    // Forward off the last control wraps to the first…
    act(() => childSelect().focus());
    press('Tab');
    expect(document.activeElement).toBe(closeButton());
    // …and backward off the first wraps to the last.
    press('Tab', true);
    expect(document.activeElement).toBe(childSelect());
  });

  it('gives the focus back to whatever opened it', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    open();
    expect(document.activeElement).toBe(sheet());
    act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
