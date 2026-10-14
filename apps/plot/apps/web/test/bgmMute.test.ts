// @vitest-environment jsdom
/**
 * The chat header's music mute: there only while the page has music, silencing
 * every player on the page — those already drawn, those drawn later, and the
 * `{{bgm::…}}` track, which is in no document — without stopping any, and kept
 * per browser even where storage is refused.
 *
 * jsdom plays nothing, so `play` is a stub that records what the background-music
 * hook started. `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import messages from '../messages/ko.json';
import { BgmMute } from '../src/components/BgmMute';
import { setBgmMuted } from '../src/lib/bgmMute';
import { useBackgroundMusic } from '../src/lib/useBackgroundMusic';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const KEY = 'shizue.bgmMuted';
const MUTE = messages.chat.bgmMute;
const UNMUTE = messages.chat.bgmUnmute;

// Node's own `localStorage` shadows jsdom's (catalogue.test.ts), so a map stands in.
const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
const useStorage = (value: unknown): void => {
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => value });
};

/** The tracks the hook started, in order. */
let started: HTMLMediaElement[] = [];
let pause: MockInstance<() => void>;
/** Where the conversation's markup goes, apart from the header. */
let stage: HTMLElement;
let host: HTMLElement;
let root: Root | null = null;

/** The chat page's two halves: the hook that plays `{{bgm::…}}`, and the header's control. */
function ChatPage() {
  useBackgroundMusic();
  return createElement(BgmMute);
}

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(NextIntlClientProvider, { locale: 'ko', messages, children: createElement(ChatPage) })));
}

/** MutationObserver answers in a microtask; let it, and the render it asks for, land. */
async function settle(): Promise<void> {
  await act(async () => {});
}

async function draw(html: string): Promise<HTMLElement> {
  const block = document.createElement('div');
  block.innerHTML = html;
  stage.appendChild(block);
  await settle();
  return block;
}

const button = (): HTMLButtonElement | null => host.querySelector('[data-testid="bgm-mute"]');
const players = (): HTMLAudioElement[] => [...document.querySelectorAll('audio')];

async function press(): Promise<void> {
  act(() => button()!.click());
  await settle();
}

beforeEach(() => {
  started = [];
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    started.push(this);
    return Promise.resolve();
  });
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  useStorage(storage);
  stage = document.createElement('div');
  document.body.appendChild(stage);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  setBgmMuted(false);
  store.clear();
  vi.restoreAllMocks();
});

describe('the chat music mute', () => {
  it('stands only while the page has music', async () => {
    mount();
    expect(button()).toBeNull();

    const player = await draw('<audio controls autoplay loop src="/api/plots/p/assets/song"></audio>');
    expect(button()?.getAttribute('aria-label')).toBe(MUTE);
    player.remove();
    await settle();
    expect(button()).toBeNull();

    // A marker is music too; once the track it started plays, it stays music
    // after the marker goes (a swiped reply), until the track ends.
    const marker = await draw('<span data-shizue-bgm="/api/plots/p/assets/bgm"></span>');
    expect(started).toHaveLength(1);
    expect(button()).not.toBeNull();
    marker.remove();
    await settle();
    expect(button()).not.toBeNull();
    act(() => {
      started[0]!.dispatchEvent(new Event('ended'));
    });
    await settle();
    expect(button()).toBeNull();
  });

  it('silences every player on the page, later ones too, and gives each back what it had', async () => {
    await draw('<audio controls autoplay loop src="/api/plots/p/assets/a"></audio><audio muted src="/api/plots/p/assets/b"></audio>');
    mount();
    await settle();
    const [song, quiet] = players();
    expect(song!.muted).toBe(false);

    await press();
    expect(song!.muted).toBe(true);
    expect(quiet!.muted).toBe(true);
    expect(button()?.getAttribute('aria-label')).toBe(UNMUTE);

    // A reply that brings its own player while muted: silent from the start.
    await draw('<div><audio controls autoplay loop src="/api/plots/p/assets/c"></audio></div>');
    const later = players()[2]!;
    expect(later.muted).toBe(true);

    await press();
    expect(song!.muted).toBe(false);
    expect(later.muted).toBe(false);
    // The card asked for this one to be silent, and it stays so.
    expect(quiet!.muted).toBe(true);
    expect(button()?.getAttribute('aria-label')).toBe(MUTE);
    // Muting is not stopping: nothing was paused, nothing changed source.
    expect(pause).not.toHaveBeenCalled();
    expect(song!.getAttribute('src')).toBe('/api/plots/p/assets/a');
  });

  it("mutes the {{bgm}} track, the one playing and the next to start", async () => {
    mount();
    await draw('<span data-shizue-bgm="/api/plots/p/assets/bgm"></span>');
    expect(started).toHaveLength(1);
    const first = started[0]!;
    expect(first.muted).toBe(false);

    await press();
    expect(first.muted).toBe(true);
    expect(first.volume).toBe(0.5);
    expect(pause).not.toHaveBeenCalled();

    // RisuAI's loop: once it ends, the marker starts it again — muted, as the reader left it.
    act(() => {
      first.dispatchEvent(new Event('ended'));
    });
    await settle();
    expect(started).toHaveLength(2);
    expect(started[1]!.muted).toBe(true);

    await press();
    expect(started[1]!.muted).toBe(false);
  });

  it('is kept for the next chat, and a new page starts muted', async () => {
    mount();
    await draw('<audio src="/api/plots/p/assets/a"></audio>');
    await press();
    expect(store.get(KEY)).toBe('1');
    act(() => root!.unmount());
    root = null;

    // Drawn before the next page's control is there to see it arrive.
    const next = await draw('<audio controls autoplay loop src="/api/plots/q/assets/a"></audio>');
    expect(next.querySelector('audio')!.muted).toBe(false);
    mount();
    await settle();
    expect(next.querySelector('audio')!.muted).toBe(true);
    expect(button()?.getAttribute('aria-label')).toBe(UNMUTE);

    // A fresh page load reads it back.
    vi.resetModules();
    const fresh = await import('../src/lib/bgmMute');
    expect(fresh.isBgmMuted()).toBe(true);
  });

  it('mutes for the visit where the browser refuses storage', async () => {
    // Blocked site data: reaching for storage at all throws, as some browsers do.
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    vi.resetModules();
    const fresh = await import('../src/lib/bgmMute');
    await draw('<audio src="/api/plots/p/assets/a"></audio>');

    expect(fresh.isBgmMuted()).toBe(false);
    expect(() => fresh.setBgmMuted(true)).not.toThrow();
    expect(fresh.isBgmMuted()).toBe(true);
    expect(players()[0]!.muted).toBe(true);
    expect(() => fresh.setBgmMuted(false)).not.toThrow();
    expect(players()[0]!.muted).toBe(false);

    // And the header's control on such a page.
    mount();
    await settle();
    await press();
    expect(players()[0]!.muted).toBe(true);
    expect(button()?.getAttribute('aria-label')).toBe(UNMUTE);
  });
});
