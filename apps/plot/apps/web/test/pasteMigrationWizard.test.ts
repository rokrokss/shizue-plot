// @vitest-environment jsdom
/**
 * The Zeta wizard as the page wires it, against the real schema and conversion:
 * the confirmations hold the form shut, what is typed is kept in this browser
 * and comes back after a remount, the preview draws the speakers the draft will
 * have, and the create sends the draft exactly as previewed — the one whose
 * fingerprint the lookup was asked about — with the source page beside it.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { draftFingerprint, type MigrationDraft } from '@shizue/core/migrate';
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, Suspense, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import { fingerprintHash } from '../src/lib/migrate/run';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

vi.mock('@/i18n/navigation', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
      h('a', { ...rest, href }, children),
    usePathname: () => '/plots/import/paste/zeta',
    useRouter: () => ({ push: vi.fn() }),
  };
});

/** Node's own `localStorage` shadows jsdom's (see catalogue.test.ts), so a map stands in. */
const store = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

/** Every request the page made, with its JSON body. */
let requests: { path: string; body: unknown }[] = [];

const { default: WizardPage } = await import('../src/app/[locale]/(app)/(member)/plots/import/paste/[platform]/page');

let host: HTMLElement;
let root: Root;

async function render(platform = 'zeta'): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        timeZone: 'Asia/Seoul',
        messages,
        children: createElement(
          Suspense,
          { fallback: null },
          createElement(WizardPage, { params: Promise.resolve({ platform }) }),
        ),
      }),
    );
  });
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  host.querySelector<T>(`[data-testid="${CSS.escape(id)}"]`);

async function click(node: Element | null): Promise<void> {
  expect(node).not.toBeNull();
  await act(async () => {
    node!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Sets a field the way typing does, through the setter React listens behind. */
async function type(id: string, value: string): Promise<void> {
  const node = byTestId<HTMLInputElement | HTMLTextAreaElement>(`migrate-field-${id}`);
  expect(node, id).not.toBeNull();
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Lets the autosave's and the lookup's short debounces run out. */
const settle = (): Promise<void> => act(async () => new Promise((resolve) => setTimeout(resolve, 450)));

beforeEach(() => {
  store.clear();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      requests.push({ path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
      if (path === '/api/imports/lookup') return Response.json({ characters: [], chats: [] });
      if (path === '/api/plots/migrate') {
        return Response.json(
          { id: 'plot-1', characters: [{ id: 'member-1', orderIndex: 0 }] },
          { status: 201 },
        );
      }
      return Response.json({}, { status: 201 });
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('the Zeta wizard', () => {
  it('opens the form only once every confirmation is checked', async () => {
    await render();
    const next = byTestId<HTMLButtonElement>('migrate-next')!;
    expect(next.disabled).toBe(true);
    const boxes = [...host.querySelectorAll<HTMLInputElement>('[data-testid="migrate-confirm-item"] input')];
    expect(boxes).toHaveLength(2);
    await click(boxes[0]!);
    expect(next.disabled).toBe(true);
    await click(boxes[1]!);
    expect(next.disabled).toBe(false);
    await click(next);
    expect(byTestId('migrate-form')).not.toBeNull();
  });

  it('keeps the form in this browser and brings it back', async () => {
    await render();
    for (const box of host.querySelectorAll('[data-testid="migrate-confirm-item"] input')) await click(box);
    await click(byTestId('migrate-next'));
    await type('about.title', '밤의 서점');
    await settle();
    expect(JSON.parse(store.get('shizue.migrate.zeta')!)).toMatchObject({
      step: 'form',
      input: { title: '밤의 서점' },
      confirmations: { ownWork: true, secondaryWork: true },
    });

    act(() => root.unmount());
    root = createRoot(host);
    await render();
    expect(byTestId('migrate-restored')).not.toBeNull();
    expect(byTestId<HTMLInputElement>('migrate-field-about.title')!.value).toBe('밤의 서점');
  });

  it('previews the speakers and creates the very draft it previewed', async () => {
    await render();
    for (const box of host.querySelectorAll('[data-testid="migrate-confirm-item"] input')) await click(box);
    const url = byTestId<HTMLInputElement>('migrate-source-url')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        url,
        'https://zeta-ai.io/ja/plots/0f8e6c1a-3b2d-4c5e-9f7a-1b2c3d4e5f60/profile',
      );
      url.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byTestId('migrate-next'));

    await type('about.title', '밤의 서점');
    await type('characters[0].name', '앨리스');
    await type('characters[0].description', '사서');
    await type('intro.intro', '@: 비가 온다.\n@앨리스: 어서 오세요.');
    await click(byTestId('migrate-next'));
    await click(byTestId('migrate-next'));

    const speaker = host.querySelector('[data-testid="migrate-speech-character"][data-speaker="앨리스"]');
    expect(speaker?.textContent).toContain('어서 오세요.');
    expect(host.querySelector('[data-testid="migrate-speech-narration"]')?.textContent).toContain('비가 온다.');
    await settle();
    const lookup = requests.find((request) => request.path === '/api/imports/lookup');
    expect(lookup).toBeDefined();

    await click(byTestId('migrate-create'));
    await settle();
    const created = requests.find((request) => request.path === '/api/plots/migrate')!.body as {
      platform: string;
      sourceUrl: string;
      confirmations: unknown;
      draft: MigrationDraft;
    };
    expect(created.platform).toBe('zeta');
    expect(created.sourceUrl).toBe('https://zeta-ai.io/ko/plots/0f8e6c1a-3b2d-4c5e-9f7a-1b2c3d4e5f60/profile');
    expect(created.confirmations).toEqual({ ownWork: true, notExclusive: true });
    expect(created.draft.plot.intros).toEqual(['비가 온다.\n앨리스: 어서 오세요.']);
    expect('sourceUrl' in created.draft).toBe(false);
    // The hash the lookup asked about is the one the API will stamp on the members.
    expect((lookup!.body as { sha256: string[] }).sha256).toEqual([
      await fingerprintHash(draftFingerprint(created.draft)),
    ]);

    expect(byTestId('migrate-open-studio')?.getAttribute('href')).toBe('/plots/plot-1');
    // Made is made: the saved copy is gone.
    expect(store.has('shizue.migrate.zeta')).toBe(false);
  });
});

/** The other Phase 1 site, whose schema has shapes Zeta's does not. */
describe('the Elyn wizard', () => {
  it('asks its exclusivity question and previews a lore row and the image list it calls for', async () => {
    await render('elyn');
    const boxes = host.querySelectorAll('[data-testid="migrate-confirm-item"] input');
    expect([...host.querySelectorAll('[data-testid="migrate-confirm-item"]')].map((item) => item.getAttribute('data-id'))).toEqual([
      'ownWork',
      'secondaryWork',
      'elynOnly',
    ]);
    for (const box of boxes) await click(box);
    await click(byTestId('migrate-next'));

    await type('profile.name', '세라');
    await type('prompt.prompt', '# 캐릭터\n## 세라\n야간 점원.\n\n웃을 때는 {{img::웃음}}을 출력한다.');
    await click(byTestId('migrate-add-lore'));
    await type('lore[0].content', '서점은 자정까지 연다.');
    await type('lore[0].keys', '서점|책방');
    await click(byTestId('migrate-choice-lore[0].scanRange-3'));
    await click(byTestId('migrate-next'));
    await click(byTestId('migrate-next'));

    expect(byTestId('migrate-preview-lore')).not.toBeNull();
    const checkboxes = [...host.querySelectorAll<HTMLLabelElement>('[data-testid="migrate-preview"] label')];
    const imageList = checkboxes.find((label) => label.textContent?.includes('이미지 목록'))!;
    // The prompt asks for `{{img::…}}`, so the core turns the image list on, and the box says so.
    expect(imageList.querySelector('input')!.checked).toBe(true);
    expect(host.querySelector('[data-code="imageInstructionsStripped"]')).not.toBeNull();

    const split = checkboxes.find((label) => label.textContent?.includes('구획'))!;
    await click(split.querySelector('input'));
    expect(
      [...host.querySelectorAll('[data-testid="migrate-preview-member"]')].map((member) => member.textContent),
    ).toEqual([expect.stringContaining('야간 점원.')]);
  });
});
