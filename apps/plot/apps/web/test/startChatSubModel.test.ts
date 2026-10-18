// @vitest-environment jsdom
/**
 * The auxiliary model, picked as the chat starts rather than only afterwards in
 * its settings. The control is the chat settings' own — the same caption, the
 * same default named after the first model, the same hint — and no pick sends
 * nothing, so the server's default stays the server's.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { ModelInfo } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** The body of every chat start the panel has sent. */
let started: Record<string, unknown>[] = [];
let catalog: ModelInfo[] = [];

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children }: { href: string; children?: ReactNode }) => h('a', { href }, children),
    useRouter: () => ({ push: vi.fn() }),
  };
});

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: (url: string) => Promise.resolve(url === '/api/models' ? catalog : []),
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
const subModel = (): HTMLSelectElement => field('보조 모델').querySelector('select')!;
const start = (): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((node) => node.textContent === '대화 시작')!;

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
  catalog = [
    { id: 'm1', label: '모델 하나' },
    { id: 'm2', label: '가벼운 모델' },
  ];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the start panel’s auxiliary model', () => {
  it('sits beside the model, defaulting to the first model by name, with the settings’ hint', async () => {
    await render();
    const selects = [...host.querySelectorAll('select')];
    // Next to the model it spares, before who the reader is.
    expect(selects.indexOf(subModel())).toBe(1);
    expect([...subModel().options].map((option) => [option.value, option.textContent])).toEqual([
      ['', '기본 (모델 하나)'],
      ['m1', '모델 하나'],
      ['m2', '가벼운 모델'],
    ]);
    expect(subModel().value).toBe('');
    expect(field('보조 모델').textContent).toContain(messages.chat.subModelHint);
  });

  it('names no model while the catalog is empty', async () => {
    catalog = [];
    await render();
    expect([...subModel().options].map((option) => option.textContent)).toEqual(['기본 (첫 번째 모델)']);
  });

  it('sends nothing for the default', async () => {
    await render();
    await click(start());
    expect(started).toEqual([{ plotId: 'sty_1', model: 'm1' }]);
  });

  it('sends the pick once there is one', async () => {
    await render();
    await pick(subModel(), 'm2');
    await click(start());
    expect(started).toEqual([{ plotId: 'sty_1', model: 'm1', subModel: 'm2' }]);
  });

  it('gives the pick up again when the default is chosen back', async () => {
    await render();
    await pick(subModel(), 'm2');
    await pick(subModel(), '');
    await click(start());
    expect(started).toEqual([{ plotId: 'sty_1', model: 'm1' }]);
  });
});
