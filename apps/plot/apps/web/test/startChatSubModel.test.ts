// @vitest-environment jsdom
/**
 * The model presets a chat starts on, picked as it starts rather than only
 * afterwards in its settings. The controls are the chat settings' own — the same
 * captions, the same default named after what it runs on, the same hint — and a
 * slot left to the default sends nothing, so the server's default stays the
 * server's.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { ModelBinding, ModelPreset } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** The body of every chat start the panel has sent. */
let started: Record<string, unknown>[] = [];
let presets: Pick<ModelPreset, 'id' | 'name'>[] = [];
let defaults: ModelBinding = { main: null, sub: null };

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
    useRouter: () => ({ push: vi.fn() }),
  };
});

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: (url: string) =>
    Promise.resolve(url === '/api/model-presets' ? presets : url === '/api/model-binding' ? defaults : []),
  apiSend: (_method: string, _path: string, body: Record<string, unknown>) => {
    started.push(body);
    return Promise.resolve({ chat: { id: 'cht_1' } });
  },
}));

const { StartChatPanel } = await import('../src/components/StartChatPanel');

let host: HTMLElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(StartChatPanel, { plotId: 'sty_1' }) as ReactNode,
      }),
    );
  });
}

/** The select under the caption, which `Field` wraps along with its hint. */
const field = (caption: string): HTMLLabelElement =>
  [...host.querySelectorAll('label')].find((label) => label.firstElementChild?.textContent === caption)!;
const mainModel = (): HTMLSelectElement => field('모델').querySelector('select')!;
const subModel = (): HTMLSelectElement => field('보조 모델').querySelector('select')!;
const start = (): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((node) => node.textContent === '대화 시작')!;
const texts = (select: HTMLSelectElement): string[][] => [...select.options].map((option) => [option.value, option.textContent ?? '']);

async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  started = [];
  presets = [
    { id: 'm1', name: '모델 하나' },
    { id: 'm2', name: '가벼운 모델' },
  ];
  defaults = { main: null, sub: null };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the start panel’s models', () => {
  it('starts on the first preset where there is no default, the sub beside it on the main, with the settings’ hint', async () => {
    await render();
    const selects = [...host.querySelectorAll('select')];
    // Next to the model it spares, before who the reader is.
    expect(selects.indexOf(subModel())).toBe(1);
    expect(mainModel().value).toBe('m1');
    expect(texts(subModel())).toEqual([
      ['', '기본 (모델 하나)'],
      ['m1', '모델 하나'],
      ['m2', '가벼운 모델'],
    ]);
    expect(subModel().value).toBe('');
    expect(field('보조 모델').textContent).toContain(messages.chat.subModelHint);
    await click(start());
    expect(started).toEqual([{ plotId: 'sty_1', modelBinding: { main: 'm1' } }]);
  });

  it('leaves both slots to a default binding, by what it runs on, and sends nothing for them', async () => {
    defaults = { main: 'm2', sub: null };
    await render();
    expect(texts(mainModel())[0]).toEqual(['', '기본 (가벼운 모델)']);
    expect(mainModel().value).toBe('');
    expect(texts(subModel())[0]).toEqual(['', '기본 (가벼운 모델)']);
    await click(start());
    expect(started).toEqual([{ plotId: 'sty_1' }]);
  });

  it('sends a sub pick once there is one', async () => {
    await render();
    await pick(subModel(), 'm2');
    await click(start());
    expect(started).toEqual([{ plotId: 'sty_1', modelBinding: { main: 'm1', sub: 'm2' } }]);
  });

  it('gives the pick up again when the default is chosen back', async () => {
    await render();
    await pick(subModel(), 'm2');
    await pick(subModel(), '');
    await click(start());
    expect(started).toEqual([{ plotId: 'sty_1', modelBinding: { main: 'm1' } }]);
  });

  it('says where to make a preset while there is none, and starts nothing', async () => {
    presets = [];
    await render();
    expect(texts(subModel())).toEqual([['', '기본']]);
    expect(host.textContent).toContain(messages.plot.noModels);
    expect(host.querySelector('a[href="/settings"]')?.textContent).toBe(messages.plot.openModelSettings);
    expect(start().disabled).toBe(true);
  });
});
