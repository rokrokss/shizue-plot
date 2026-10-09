// @vitest-environment jsdom
/**
 * The catalogue's own controls, with the feed stubbed to a single page: the
 * filters it keeps in the URL, the popover for the tags this browser has muted,
 * and what its two busy states say while they work.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import { HIDDEN_TAGS_KEY } from '../src/lib/hub';
import type { ExploreResult, PublicPlot } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/**
 * Node's own experimental `localStorage` shadows the jsdom one, and without
 * `--localstorage-file` it is an empty object — so the muted-tag set gets a map
 * of its own, exactly the two methods `hub.ts` reaches for.
 */
const store = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

/**
 * The router, in as much as this page uses one: the query string, whoever is
 * listening to it, and the two ways it moves — the page's own `replace`, and a
 * `navigate` standing in for Back, Forward, or a link arriving from elsewhere.
 * Both go through the same door, because to the page they are the same event.
 */
let search = new URLSearchParams();
const listeners = new Set<() => void>();

function navigate(href: string): void {
  const next = href.split('?')[1] ?? '';
  // A replace to the URL that is already up moves nothing, and re-rendering for
  // it would only tell `useSyncExternalStore` the snapshot is unstable.
  if (next === search.toString()) return;
  search = new URLSearchParams(next);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Set by a test that wants replaces to queue the way a slow transition does. */
let heldNavigation: string[] | null = null;
const replace = vi.fn((href: string, _options?: { scroll: boolean }) => {
  if (heldNavigation) {
    heldNavigation.push(href);
    return;
  }
  navigate(href);
});
/** The router keeps only the newest of the queued navigations, as Next does. */
function releaseNavigation(): void {
  const last = heldNavigation?.at(-1);
  heldNavigation = null;
  if (last !== undefined) navigate(last);
}
/** Every explore URL the page has asked for, newest last. */
let asked: string[] = [];
/** Set by a test that wants the next page to stay in flight. */
let holdNextPage: ((page: ExploreResult) => void) | null = null;

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
  usePathname: () => '/',
  useRouter: () => ({ replace }),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => useSyncExternalStore(subscribe, () => search, () => search),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: (url: string) => {
    asked.push(url);
    if (url.includes('cursor=') && holdNextPage) {
      return new Promise<ExploreResult>((resolve) => {
        holdNextPage = resolve;
      });
    }
    return Promise.resolve(page());
  },
}));

const { default: PlotsFeedPage } = await import('../src/app/[locale]/(app)/page');

const plot = (tag: string): PublicPlot => ({
  id: tag,
  name: tag,
  coverUrl: null,
  creatorId: 'u1',
  creatorName: '작가',
  language: 'ko',
  tags: [tag],
  likeCount: 0,
  chatCount: 0,
  intro: '',
  introPreview: '',
  publishedAt: null,
  likedByMe: false,
  characters: [],
});

/** One page with two tags on it, and always another page behind it. */
const page = (): ExploreResult => ({
  items: [plot('로맨스'), plot('공포')],
  nextCursor: 'next',
});

let host: HTMLElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(PlotsFeedPage),
      }),
    );
  });
}

const toggle = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="hidden-tags-toggle"]')!;
const popover = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="hidden-tags-toggle"] + div');
const search_ = (): HTMLInputElement => host.querySelector<HTMLInputElement>('input[type="search"]')!;
const more = (): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((node) => node.textContent?.startsWith('더 보기'))!;

/** The path the last `router.replace` was given. */
const written = (): string => (replace.mock.calls.at(-1)?.[0] as string) ?? '';

/** Async so the read a click sets off lands inside the same `act`. */
async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const button = (label: string): HTMLElement =>
  [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;

beforeEach(() => {
  search = new URLSearchParams();
  asked = [];
  holdNextPage = null;
  heldNavigation = null;
  replace.mockClear();
  store.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the catalogue', () => {
  it('gives the search field a name of its own', async () => {
    await render();
    expect(search_().getAttribute('aria-label')).toBe('플롯 이름 검색');
  });

  it('puts the filters in the URL, and leaves the defaults out of it', async () => {
    await render();
    // Nothing has been chosen, so there is nothing to say and the path is bare.
    expect(replace).not.toHaveBeenCalled();

    // A sort change restarts the feed, so the chips are only back once its page is.
    await click(button('인기'));
    expect(written()).toBe('/?sort=chats');
    expect(replace.mock.calls.at(-1)?.[1]).toEqual({ scroll: false });

    await click(button('로맨스'));
    expect(written()).toBe('/?sort=chats&tag=%EB%A1%9C%EB%A7%A8%EC%8A%A4');

    // Back to the default sort, and it leaves the URL rather than being stated.
    await click(button('최신'));
    expect(written()).toBe('/?tag=%EB%A1%9C%EB%A7%A8%EC%8A%A4');
  });

  it('offers 주간 인기 beside the other three, and asks the API for it by name', async () => {
    await render();
    // The four sorts, in the order the row lists them.
    expect(
      [...host.querySelectorAll('button')]
        .map((node) => node.textContent)
        .filter((label) => ['최신', '주간 인기', '인기', '좋아요'].includes(label ?? '')),
    ).toEqual(['최신', '주간 인기', '인기', '좋아요']);

    await click(button('주간 인기'));
    expect(written()).toBe('/?sort=weekly');
    expect(asked.at(-1)).toContain('sort=weekly');
  });

  it('starts from the filters the URL arrived with', async () => {
    search = new URLSearchParams('sort=likes&tag=공포&q=밤');
    await render();
    expect(search_().value).toBe('밤');
    expect(asked[0]).toContain('sort=likes');
    expect(asked[0]).toContain('q=%EB%B0%A4');
    expect(asked[0]).toContain('tag=%EA%B3%B5%ED%8F%AC');
  });

  /**
   * The one the mirroring version got wrong: with the filters copied into state
   * at mount, a Back left that copy behind and the mirror wrote it straight back
   * over the URL the reader had just navigated to. The URL is the filters now,
   * so the navigation is simply obeyed — one refetch, and nothing written.
   */
  it('follows a Back or Forward that moves the filters, without rewriting it', async () => {
    await render();
    expect(asked).toHaveLength(1);

    await act(async () => navigate('/?sort=likes&tag=공포&q=밤'));
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('sort=likes');
    expect(asked[1]).toContain('tag=%EA%B3%B5%ED%8F%AC');
    expect(asked[1]).toContain('q=%EB%B0%A4');
    // The pressed sort and the search field followed it too.
    expect(button('좋아요').getAttribute('aria-pressed')).toBe('true');
    expect(search_().value).toBe('밤');

    // Long enough for the search debounce, which must not write the old text back.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(replace).not.toHaveBeenCalled();
    expect(asked).toHaveLength(2);
  });

  /**
   * A replace commits a beat after it is asked for, and until it does the params
   * still show the old filters. A second click inside that beat merges over what
   * the first just wrote — not over what is still showing — or it would quietly
   * undo it.
   */
  it('keeps the first click when a second lands before the URL catches up', async () => {
    await render();
    heldNavigation = [];

    await click(button('인기'));
    expect(written()).toBe('/?sort=chats');
    await click(button('로맨스'));
    expect(written()).toBe('/?sort=chats&tag=%EB%A1%9C%EB%A7%A8%EC%8A%A4');

    // The newest write lands carrying both choices, and the page follows it.
    await act(async () => releaseNavigation());
    expect(button('인기').getAttribute('aria-pressed')).toBe('true');
    expect(asked.at(-1)).toContain('sort=chats');
    expect(asked.at(-1)).toContain('tag=%EB%A1%9C%EB%A7%A8%EC%8A%A4');
  });

  it('closes the hidden-tags popover on Escape, and hands the focus back', async () => {
    window.localStorage.setItem(HIDDEN_TAGS_KEY, JSON.stringify(['공포']));
    await render();
    await click(toggle());
    expect(popover()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it('closes it on a press outside, and stays open on one inside', async () => {
    window.localStorage.setItem(HIDDEN_TAGS_KEY, JSON.stringify(['공포']));
    await render();
    await click(toggle());

    act(() => {
      popover()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(popover()).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(popover()).toBeNull();
  });

  /** The label is what the button does; the spinner only lies over it. */
  it('keeps the load-more label while the next page is in flight', async () => {
    holdNextPage = () => undefined;
    await render();
    expect(more().textContent).toBe('더 보기');

    await click(more());
    expect(more().textContent).toBe('더 보기');
    expect(more().disabled).toBe(true);
    expect(more().getAttribute('aria-busy')).toBe('true');
    expect(more().querySelector('[aria-hidden="true"]')).not.toBeNull();

    await act(async () => holdNextPage!({ items: [], nextCursor: null }));
    expect(more()).toBeUndefined();
  });
});
