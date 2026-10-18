// @vitest-environment jsdom
/**
 * The chat controls, in the settings sheet.
 *
 * Each has a visible caption, and a caption that is only a caption is a dead
 * zone: it reads like a label, it is the width of the row, and clicking it does
 * nothing. So what is checked here is that it is a real label — pointed at its
 * control, and the control's only name.
 *
 * `createElement` rather than JSX, matching bottomSheet.test.ts.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../messages/ko.json';
import { ChatSettings } from '../src/components/ChatSettings';
import type { ModelBinding, ModelPreset } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

const preset = (id: string, name: string): ModelPreset => ({
  id, name, format: 'openai-chat', endpoint: 'http://localhost:1234/v1', model: id, credentialId: null, params: {}, capabilities: {},
});
const ONE = preset('m1', '모델 하나');
const TWO = preset('m2', '모델 둘');
const OPEN: ModelBinding = { main: null, sub: null };

function render(
  options: { binding?: ModelBinding; presets?: ModelPreset[]; defaults?: ModelBinding; patches?: unknown[] } = {},
): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(ChatSettings, {
          binding: options.binding ?? OPEN,
          presets: options.presets ?? [ONE],
          defaults: options.defaults ?? OPEN,
          personaId: null,
          personas: [],
          disabled: false,
          onChange: (patch) => void options.patches?.push(patch),
        }) as ReactElement,
      }),
    );
  });
}

const selects = (): HTMLSelectElement[] => [...host.querySelectorAll('select')];
const labels = (): HTMLLabelElement[] => [...host.querySelectorAll('label')];
const pick = (select: HTMLSelectElement, value: string): void =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the captions', () => {
  beforeEach(() => render());

  it('points each caption at its own control', () => {
    const captions = labels();
    expect(captions.map((label) => label.textContent)).toEqual(['모델', '보조 모델', '페르소나']);
    // The caption is a label of the control below it, not of the page.
    expect(captions.map((label) => label.htmlFor)).toEqual(selects().map((select) => select.id));
    for (const select of selects()) expect(select.id).not.toBe('');
    expect(captions.map((label) => label.control)).toEqual(selects());
  });
});

describe('the main model', () => {
  it('offers the default, by what it runs on, and every preset; a pick sets the slot and the default clears it', () => {
    const patches: unknown[] = [];
    render({ binding: { main: 'm2', sub: null }, presets: [ONE, TWO], defaults: { main: 'm1', sub: null }, patches });
    const main = selects()[0]!;
    expect([...main.options].map((option) => option.textContent)).toEqual(['기본 (모델 하나)', '모델 하나', '모델 둘']);
    expect(main.value).toBe('m2');
    pick(main, 'm1');
    pick(main, '');
    expect(patches).toEqual([{ modelBinding: { main: 'm1' } }, { modelBinding: { main: null } }]);
  });
});

describe('the auxiliary model', () => {
  const HINT = messages.chat.subModelHint;

  it("defaults to the default's sub, or to the main where that is open too, by name", () => {
    const patches: unknown[] = [];
    render({ binding: { main: 'm1', sub: null }, presets: [ONE, TWO], patches });
    const sub = selects()[1]!;
    expect(sub.labels![0]!.textContent).toBe('보조 모델');
    expect([...sub.options].map((option) => option.textContent)).toEqual(['기본 (모델 하나)', '모델 하나', '모델 둘']);
    expect(sub.value).toBe('');
    // The hint stands under the control, and is its title as well.
    expect(sub.title).toBe(HINT);
    expect(sub.parentElement!.querySelector('p')?.textContent).toBe(HINT);
    pick(sub, 'm2');
    expect(patches).toEqual([{ modelBinding: { sub: 'm2' } }]);

    render({ binding: { main: 'm1', sub: null }, presets: [ONE, TWO], defaults: { main: null, sub: 'm2' } });
    expect(selects()[1]!.options[0]!.textContent).toBe('기본 (모델 둘)');
  });

  it('says only "default" before the presets are in, and keeps a pick the list does not have visible', () => {
    render({ presets: [] });
    expect([...selects()[1]!.options].map((option) => option.textContent)).toEqual(['기본']);
    const patches: unknown[] = [];
    render({ binding: { main: null, sub: 'gone' }, presets: [ONE], patches });
    const sub = selects()[1]!;
    expect([...sub.options].map((option) => option.value)).toEqual(['', 'gone', 'm1']);
    expect(sub.value).toBe('gone');
    pick(sub, '');
    expect(patches).toEqual([{ modelBinding: { sub: null } }]);
  });
});
