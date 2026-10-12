// @vitest-environment jsdom
/**
 * The theme pick has two readers — the head script before first paint, the app
 * after — and they must agree on where it is kept, or a pick never survives a
 * reload. Each case loads the module fresh, as a reload would.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubMatchMedia } from './matchMedia';

/**
 * Node's own experimental `localStorage` shadows the jsdom one and is an empty
 * object without `--localstorage-file`, so the pick gets a map of its own.
 */
const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
for (const scope of new Set([globalThis, window])) {
  Object.defineProperty(scope, 'localStorage', { configurable: true, value: storage });
}

const load = () => {
  vi.resetModules();
  return import('../src/lib/theme');
};

/** What the head script leaves on <html> after a reload. */
async function reloaded(): Promise<string | undefined> {
  delete document.documentElement.dataset['theme'];
  new Function((await load()).THEME_SCRIPT)();
  return document.documentElement.dataset['theme'];
}

beforeEach(() => {
  store.clear();
  stubMatchMedia(true);
});

describe('the theme', () => {
  it('keeps a pick across a reload', async () => {
    (await load()).setTheme('light');
    expect(await reloaded()).toBe('light');
    const theme = await load();
    expect(theme.getTheme()).toBe('light');
    expect(theme.getColorScheme()).toBe('light');
  });

  it('goes back to the OS on system, and stays there after a reload', async () => {
    const before = await load();
    before.setTheme('dark');
    before.setTheme('system');
    expect(await reloaded()).toBeUndefined();
    const theme = await load();
    expect(theme.getTheme()).toBe('system');
    expect(theme.getColorScheme()).toBe('dark');
  });

  it('ignores a stored value it does not know', async () => {
    store.set('shizue-theme', 'sepia');
    expect(await reloaded()).toBeUndefined();
    expect((await load()).getTheme()).toBe('system');
  });
});
