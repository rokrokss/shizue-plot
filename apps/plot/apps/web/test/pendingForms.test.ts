// @vitest-environment jsdom
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;
let records: unknown[] = [];
const send = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const remove = vi.fn<(...args: unknown[]) => Promise<void>>();
const plot = {
  id: 'plot-1', name: '원래 제목', intro: '', description: '세계관', language: 'ko',
  tags: [], commentsEnabled: true, intros: [], narrator: null, style: null,
  profiles: [], lorebook: [], customUi: null, characters: [], coverUrl: null,
  visibility: 'private', safetyLevel: 'all',
};
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  apiGet: (path: string) => Promise.resolve(
    path === '/api/plots/plot-1' ? plot
      : path.endsWith('/comments') ? { items: [], nextCursor: null }
      : path === '/api/models' ? [{ id: 'echo/echo', label: 'Echo' }]
      : path === '/api/notes' || path === '/api/personas' ? records : [],
  ),
  apiSend: (...args: unknown[]) => send(...args),
  apiDelete: (...args: unknown[]) => remove(...args),
}));
vi.mock('@/lib/authClient', () => ({ useSession: () => ({ data: { user: { id: 'test' } }, isPending: false }) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => createElement('a', { href }, children),
  usePathname: () => '/notes',
  useRouter: () => ({ push: vi.fn() }),
}));

const { default: Notes } = await import('../src/app/[locale]/(app)/(member)/notes/page');
const { default: Personas } = await import('../src/app/[locale]/(app)/(member)/personas/page');
const { default: Studio } = await import('../src/app/[locale]/(app)/(member)/plots/[id]/page');
const { CommentsSection } = await import('../src/components/CommentsSection');
const { StartChatPanel } = await import('../src/components/StartChatPanel');

let host: HTMLElement;
let root: Root;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function render(children: ReactNode) {
  await act(async () => root.render(createElement(NextIntlClientProvider, {
    locale: 'ko', timeZone: 'Asia/Seoul', messages,
    children: createElement(Suspense, { fallback: null }, children),
  })));
}
async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll('button')].find((node) => node.textContent === label)!;
const click = async (node: HTMLElement) => act(async () => node.click());
const isLocked = (scope: ParentNode) => [...scope.querySelectorAll('input, textarea, select, button')].every((node) => node.matches(':disabled'));

beforeEach(() => {
  records = []; send.mockReset(); remove.mockReset();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

for (const [name, Component, label] of [
  ['note', Notes, messages.notes.create], ['persona', Personas, messages.personas.create],
] as const) {
  it(`locks a new ${name} until creation settles and retains the rejected input`, async () => {
    const pending = deferred<unknown>(); send.mockReturnValue(pending.promise);
    await render(createElement(Component));
    const section = host.querySelector('section')!;
    const text = section.querySelector('textarea')!;
    await type(section.querySelector('input')!, '보존할 이름');
    await type(text, '보존할 본문');
    await click(button(section, label));
    expect(isLocked(section)).toBe(true);
    await click(button(section, label));
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error('create failed')));
    expect(text.value).toBe('보존할 본문');
    expect(text.matches(':disabled')).toBe(false);
  });

  it(`prevents deleting or changing a ${name} while saving it`, async () => {
    records = [{ id: 'item-1', title: '기존', groupName: '', content: '원문', name: '기존', description: '원문' }];
    const pending = deferred<unknown>(); send.mockReturnValue(pending.promise);
    await render(createElement(Component));
    const save = button(host, messages.common.save);
    const card = save.closest('fieldset')!;
    const text = card.querySelector('textarea')!;
    await type(text, '수정 내용');
    await click(save);
    expect(isLocked(card)).toBe(true);
    expect(button(card, messages.common.delete).matches(':disabled')).toBe(true);
    await act(async () => pending.reject(new Error('save failed')));
    expect(text.value).toBe('수정 내용');
    expect(isLocked(card)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
}

it('locks comment text and spoiler together, recovering without erasing either', async () => {
  const pending = deferred<unknown>(); send.mockReturnValue(pending.promise);
  await render(createElement(CommentsSection, { plotId: 'plot-1', count: 0 }));
  const form = host.querySelector('[data-testid="comment-form"]')!;
  const text = form.querySelector('textarea')!;
  const spoiler = form.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await type(text, '보존할 댓글'); await click(spoiler);
  await click(button(form, messages.comments.submit));
  expect(isLocked(form)).toBe(true);
  await act(async () => pending.reject(new Error('comment failed')));
  expect(text.value).toBe('보존할 댓글'); expect(spoiler.checked).toBe(true);
  expect(text.matches(':disabled')).toBe(false);
});

it('locks the model and identity selection while opening a chat', async () => {
  const pending = deferred<unknown>(); send.mockReturnValue(pending.promise);
  await render(createElement(StartChatPanel, { plotId: 'plot-1', profiles: [{ id: 'profile-1', name: '단골', description: '' }] }));
  await click(button(host, messages.plot.startChat));
  expect(isLocked(host)).toBe(true);
  await act(async () => pending.reject(new Error('start failed')));
  expect(host.querySelector('select')!.matches(':disabled')).toBe(false);
});

it('locks the studio snapshot and roster while saving, then preserves a rejected edit', async () => {
  const pending = deferred<unknown>(); send.mockReturnValue(pending.promise);
  await render(createElement(Studio, { params: Promise.resolve({ id: 'plot-1' }) }));
  const title = host.querySelector<HTMLInputElement>(`input[aria-label="${messages.plot.name}"]`)!;
  await type(title, '보존할 제목');
  await click(button(host, messages.common.save));
  expect(isLocked(host)).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => pending.reject(new Error('save failed')));
  expect(title.value).toBe('보존할 제목');
  expect(title.matches(':disabled')).toBe(false);
});
