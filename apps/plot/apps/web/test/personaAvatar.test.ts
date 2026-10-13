// @vitest-environment jsdom
/**
 * A persona's picture in the persona editor: uploaded and removed in place, with
 * the card's other writes held off while it goes, the preview cache-busted, and a
 * refusal said where the picture is rather than losing what was being written.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import { ApiError } from '../src/lib/api';
import type { Persona } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const persona: Persona = {
  id: 'per-1',
  name: '여행자',
  description: '길을 잃었다',
  avatarUrl: null,
  createdAt: '2026-10-14T00:00:00.000Z',
};
const upload = vi.fn<(path: string, file: File) => Promise<unknown>>();
const send = vi.fn<(method: string, path: string, body?: unknown) => Promise<unknown>>();

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  apiGet: () => Promise.resolve([persona]),
  apiUpload: (path: string, file: File) => upload(path, file),
  apiSend: (method: string, path: string, body?: unknown) => send(method, path, body),
  apiDelete: () => Promise.resolve(),
}));
vi.mock('@/lib/authClient', () => ({ useSession: () => ({ data: { user: { id: 'test' } }, isPending: false }) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children),
  usePathname: () => '/personas',
  useRouter: () => ({ push: vi.fn() }),
}));

const { default: Personas } = await import('../src/app/[locale]/(app)/(member)/personas/page');

let host: HTMLElement;
let root: Root;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        timeZone: 'Asia/Seoul',
        messages,
        children: createElement(Suspense, { fallback: null }, createElement(Personas)),
      }),
    ),
  );
}

/** The persona's own card — the new-persona form above it is a fieldset too. */
const card = (): HTMLFieldSetElement =>
  host.querySelector<HTMLInputElement>('[data-testid="persona-avatar-input"]')!.closest('fieldset')!;
const button = (label: string): HTMLButtonElement | undefined =>
  [...card().querySelectorAll('button')].find((node) => node.textContent === label);
const picture = (): HTMLImageElement | null => card().querySelector('img');

async function pick(file: File): Promise<void> {
  const input = card().querySelector<HTMLInputElement>('[data-testid="persona-avatar-input"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

beforeEach(() => {
  upload.mockReset();
  send.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('uploads a picture in place, holding the card while it goes, and removes it again', async () => {
  await render();
  expect(picture()).toBeNull();
  expect(card().textContent).toContain(messages.personas.avatarHint);

  // A name being written beside it stays written through the upload.
  const name = card().querySelector('input:not([type="file"])') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '다른 이름');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const pending = deferred<Persona>();
  upload.mockReturnValue(pending.promise);
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'me.png', { type: 'image/png' });
  await pick(file);
  expect(upload).toHaveBeenCalledWith('/api/personas/per-1/avatar', file);
  expect(card().disabled).toBe(true);
  expect(button(messages.personas.avatarUploading)).toBeDefined();

  await act(async () => pending.resolve({ ...persona, avatarUrl: '/api/personas/per-1/avatar' }));
  expect(card().disabled).toBe(false);
  expect(picture()!.getAttribute('src')).toBe('/api/personas/per-1/avatar?v=1');
  expect(name.value).toBe('다른 이름');

  send.mockResolvedValue({ ...persona, avatarUrl: null });
  await act(async () => button(messages.personas.avatarRemove)!.click());
  expect(send).toHaveBeenCalledWith('DELETE', '/api/personas/per-1/avatar', undefined);
  expect(picture()).toBeNull();
  expect(card().textContent).toContain(messages.personas.avatarHint);
});

it('says why a picture was refused, and lets the card go again', async () => {
  await render();
  upload.mockRejectedValue(new ApiError(400, 'invalid_asset', 'Unsupported image file'));
  await pick(new File([new Uint8Array([1, 2, 3])], 'x.bin'));
  expect(card().disabled).toBe(false);
  expect(picture()).toBeNull();
  expect(card().querySelector('[role="alert"], .text-danger')?.textContent).toBeTruthy();
});
