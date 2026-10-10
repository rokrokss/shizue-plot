// @vitest-environment jsdom
/**
 * The unlock condition an image waits on, in the studio's asset manager.
 *
 * It is the one thing about an asset that is edited without re-uploading its
 * bytes, so it saves on its own — a PATCH per image rather than a field riding
 * the plot's Save — and the tile says what each image is currently waiting for.
 *
 * `createElement` rather than JSX, matching `assetManager.test.ts`.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { PlotAsset } from '../src/lib/assets';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let stored: PlotAsset[] = [];
let pendingSave: (() => Promise<PlotAsset>) | null = null;
/** Every unlock write the editor has sent, as `path` and body. */
let sent: { path: string; body: unknown }[] = [];

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: () => Promise.resolve(stored),
  apiSend: (_method: string, path: string, body: unknown) => {
    sent.push({ path, body });
    if (pendingSave) return pendingSave();
    const [asset] = stored;
    return Promise.resolve({ ...asset, ...(body as { unlock: unknown }) });
  },
}));

const { AssetManager } = await import('../src/components/AssetManager');

const asset = (unlock: PlotAsset['unlock'] = null): PlotAsset => ({
  slug: 'kiss',
  name: null,
  url: '/api/plots/sty_1/assets/kiss',
  mime: 'image/png',
  width: 512,
  height: 512,
  thumbhash: null,
  unlock,
  createdAt: '2026-08-16T00:00:00.000Z',
});

let host: HTMLElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(AssetManager, { plotId: 'sty_1' }) as ReactNode,
      }),
    );
  });
}

const summary = (): HTMLButtonElement => host.querySelector('[data-testid="asset-unlock-open"]')!;
const editor = (): HTMLElement | null => host.querySelector('[data-testid="asset-unlock-editor"]');
const kind = (): HTMLSelectElement => host.querySelector('[data-testid="asset-unlock-kind"]')!;
const keywords = (): HTMLInputElement => host.querySelector('[data-testid="asset-unlock-keywords"]')!;
const save = (): HTMLButtonElement =>
  [...editor()!.querySelectorAll('button')].find((node) => node.textContent === '저장')!;

async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function choose(node: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Types into a controlled input the way React reads it back. */
async function type(node: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  stored = [asset()];
  pendingSave = null;
  sent = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the asset unlock editor', () => {
  it('says what each image waits for, and opens on the tile that says it', async () => {
    await render();
    expect(summary().textContent).toBe('없음');
    expect(editor()).toBeNull();

    await click(summary());
    expect(editor()).not.toBeNull();
    expect(editor()!.textContent).toContain('kiss');
  });

  it('sends the keywords as a condition, and the tile then says so', async () => {
    await render();
    await click(summary());
    await choose(kind(), 'keyword');

    // Saving is not offered until there is something to wait for.
    expect(save().disabled).toBe(true);
    await type(keywords(), '입맞춤, 첫 키스 ,');
    expect(save().disabled).toBe(false);

    await click(save());
    expect(sent).toEqual([
      {
        path: '/api/plots/sty_1/assets/kiss',
        body: { unlock: { kind: 'keyword', keywords: ['입맞춤', '첫 키스'] } },
      },
    ]);
    // The answer is the asset row, so the grid says what it now waits on.
    expect(editor()).toBeNull();
    expect(summary().textContent).toBe('🔒 키워드');
  });

  it('starts from the condition the image already carries', async () => {
    stored = [asset({ kind: 'relationship', axis: 'trust', min: 60 })];
    await render();
    expect(summary().textContent).toBe('🔒 관계');

    await click(summary());
    expect(kind().value).toBe('relationship');
    // The kind select, then the axis one; the only input is the minimum.
    expect([...editor()!.querySelectorAll('select')][1]!.value).toBe('trust');
    expect(editor()!.querySelector('input')!.value).toBe('60');
  });

  it('clears the condition with 없음', async () => {
    stored = [asset({ kind: 'turns', count: 12 })];
    await render();
    await click(summary());
    expect(kind().value).toBe('turns');

    await choose(kind(), 'none');
    await click(save());
    expect(sent).toEqual([{ path: '/api/plots/sty_1/assets/kiss', body: { unlock: null } }]);
  });
});

it('locks the unlock editor and parent asset actions, then preserves input on failure', async () => {
  let fail!: (error: Error) => void;
  pendingSave = () => new Promise((_resolve, reject) => { fail = reject; });
  await render();
  await click(summary());
  await choose(kind(), 'keyword');
  await type(keywords(), '보존할 조건');
  await click(save());
  expect(kind().matches(':disabled')).toBe(true);
  expect(keywords().matches(':disabled')).toBe(true);
  expect(summary().matches(':disabled')).toBe(true);
  expect([...host.querySelectorAll('button')].every((button) => button.matches(':disabled'))).toBe(true);
  await act(async () => fail(new Error('save failed')));
  expect(keywords().value).toBe('보존할 조건');
  expect(kind().matches(':disabled')).toBe(false);
  expect(summary().matches(':disabled')).toBe(false);
});
