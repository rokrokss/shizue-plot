// @vitest-environment jsdom
/**
 * The three chat controls, in both layouts they are drawn in.
 *
 * The stacked layout is the one with a visible caption, and a caption that is
 * only a caption is a dead zone: it reads like a label, it is the width of the
 * row, and clicking it does nothing. So what is checked here is that it is a
 * real label — pointed at its control, and the control's only name — while the
 * compact row, which has no caption to point with, keeps its `aria-label`.
 *
 * `createElement` rather than JSX, matching bottomSheet.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../messages/ko.json';
import { ChatSettings } from '../src/components/ChatSettings';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

function render(stacked: boolean): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(ChatSettings, {
          model: 'm1',
          preset: 'standard',
          personaId: null,
          models: [{ id: 'm1', label: '모델 하나' }],
          presets: [],
          personas: [],
          disabled: false,
          stacked,
          onChange: () => undefined,
        } as never) as ReactElement,
      }),
    );
  });
}

const selects = (): HTMLSelectElement[] => [...host.querySelectorAll('select')];
const labels = (): HTMLLabelElement[] => [...host.querySelectorAll('label')];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the stacked layout', () => {
  beforeEach(() => render(true));

  it('points each caption at its own control', () => {
    const captions = labels();
    expect(captions.map((label) => label.textContent)).toEqual(['모델', '프리셋', '페르소나']);
    // The caption is a label of the control below it, not of the page.
    expect(captions.map((label) => label.htmlFor)).toEqual(selects().map((select) => select.id));
    for (const select of selects()) expect(select.id).not.toBe('');
    expect(captions.map((label) => label.control)).toEqual(selects());
  });
});

describe('the compact row', () => {
  beforeEach(() => render(false));

  it('has no caption to click, so the name stays on the control', () => {
    expect(labels()).toHaveLength(0);
    expect(selects().map((select) => select.getAttribute('aria-label'))).toEqual([
      '모델',
      '프리셋',
      '페르소나',
    ]);
  });
});
