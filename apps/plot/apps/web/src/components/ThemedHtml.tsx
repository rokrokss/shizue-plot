'use client';

import { useServerInsertedHTML } from 'next/navigation';
import { useRef, useSyncExternalStore, type ReactNode } from 'react';
import { getTheme, subscribeTheme, THEME_SCRIPT } from '@/lib/theme';

/**
 * <html>, carrying the reader's theme pick as `data-theme`.
 *
 * React has to own the attribute: switching locale remounts this layout, and
 * React clears the attributes of an <html> it takes over. The script that sets
 * it before first paint goes into the server HTML only — rendered as an element,
 * a remount would have React create a script that never runs.
 */
export function ThemedHtml({ lang, children }: { lang: string; children: ReactNode }) {
  // The server cannot know the pick, so it renders `system` and the client corrects it.
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'system');
  const inserted = useRef(false);
  useServerInsertedHTML(() => {
    if (inserted.current) return null;
    inserted.current = true;
    return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
  });

  return (
    // The script set `data-theme` before hydration, where the server rendered none.
    <html lang={lang} data-theme={theme === 'system' ? undefined : theme} suppressHydrationWarning>
      {children}
    </html>
  );
}
