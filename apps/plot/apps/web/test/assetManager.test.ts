// @vitest-environment jsdom
/**
 * The asset manager's two quiet states: nothing uploaded yet, which used to be a
 * blank between the hint and the controls, and a file picked, which used to be
 * written into the button's own label — so the button grew to whatever the file
 * was called. The name now sits beside it and truncates instead.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { PlotAsset } from '../src/lib/assets';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** What the assets read answers with. */
let stored: PlotAsset[] = [];
let uploadResult: () => Promise<PlotAsset>;

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: () => Promise.resolve(stored),
  apiUpload: () => uploadResult(),
}));

vi.mock('@/lib/assets', async (original) => ({
  ...(await original<typeof import('../src/lib/assets')>()),
  measureImage: async () => null,
}));

const { AssetManager } = await import('../src/components/AssetManager');

const asset: PlotAsset = {
  slug: 'smile',
  url: '/api/plots/sty_1/assets/smile',
  mime: 'image/png',
  width: 512,
  height: 512,
  thumbhash: null,
  createdAt: '2026-08-06T12:30:00.000Z',
};

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

/** The picker, first of the row's two buttons; the upload button is the other. */
const pick = (): HTMLButtonElement => host.querySelectorAll('button')[0]!;
const picked = (): HTMLElement | null =>
  host.querySelector<HTMLElement>('[data-testid="asset-file-name"]');

/** What the browser hands the hidden input: jsdom has no file dialog to open. */
async function choose(name: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('[data-testid="asset-file-input"]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['png'], name, { type: 'image/png' })],
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  stored = [];
  uploadResult = async () => asset;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the asset manager', () => {
  it('says so when nothing has been uploaded', async () => {
    await render();
    expect(host.textContent).toContain('아직 에셋이 없습니다.');
    expect(host.querySelector('[data-testid="plot-asset"]')).toBeNull();
  });

  it('drops the empty line once there is an asset to show', async () => {
    stored = [asset];
    await render();
    expect(host.textContent).not.toContain('아직 에셋이 없습니다.');
    expect(host.querySelectorAll('[data-testid="plot-asset"]')).toHaveLength(1);
  });
});

it('keeps the submitted file and slug until upload settles and restores them on failure', async () => {
  let fail!: (error: Error) => void;
  uploadResult = () => new Promise((_resolve, reject) => { fail = reject; });
  await render();
  await choose('smile.png');
  const slug = host.querySelector<HTMLInputElement>('input:not([type="file"])')!;
  const upload = [...host.querySelectorAll('button')].find((node) => node.textContent === messages.plot.assetUpload)!;
  await act(async () => upload.click());
  expect(slug.matches(':disabled')).toBe(true);
  expect(pick().matches(':disabled')).toBe(true);
  expect(host.querySelector('[data-testid="asset-file-input"]')!.matches(':disabled')).toBe(true);
  await act(async () => fail(new Error('upload failed')));
  expect(slug.value).toBe('smile');
  expect(picked()?.textContent).toBe('smile.png');
  expect(slug.matches(':disabled')).toBe(false);
});
