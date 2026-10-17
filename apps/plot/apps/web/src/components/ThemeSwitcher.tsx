'use client';

import { useTranslations } from 'next-intl';
import { useSyncExternalStore } from 'react';
import { getTheme, setTheme, subscribeTheme, themes, type Theme } from '@/lib/theme';

/** System, light or dark, beside the language; the pick lives in this browser. */
export function ThemeSwitcher() {
  const t = useTranslations('themes');
  const nav = useTranslations('nav');
  // The server cannot know the pick, so it renders `system` and the client corrects it.
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'system');

  return (
    <select
      aria-label={nav('theme')}
      value={theme}
      onChange={(event) => setTheme(event.target.value as Theme)}
      // 8px each side of the text, the ⌄ as far in (the global `select` rule).
      className="cursor-pointer rounded-lg border border-line bg-surface py-1.5 text-xs [--select-inset:0.5rem] text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {themes.map((value) => (
        <option key={value} value={value}>
          {t(value)}
        </option>
      ))}
    </select>
  );
}
