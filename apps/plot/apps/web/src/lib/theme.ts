/**
 * The reader's theme. `system` follows the OS through the stylesheet's media
 * query alone; `light` and `dark` are a pick, kept in localStorage and shown as
 * <html data-theme>. `THEME_SCRIPT` puts it there before first paint, and
 * `ThemedHtml` keeps it there from then on.
 */
export const themes = ['system', 'light', 'dark'] as const;
export type Theme = (typeof themes)[number];
export type ColorScheme = 'light' | 'dark';

const STORAGE_KEY = 'shizue-theme';

/**
 * Inlined in the server HTML so a stored pick lands before anything paints.
 * Storage can throw (blocked site data), and then the OS decides.
 */
export const THEME_SCRIPT = `try{var t=localStorage.getItem('${STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

let picked: Theme | undefined;
const listeners = new Set<() => void>();
const darkQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)');

export function getTheme(): Theme {
  if (picked === undefined) {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      picked = stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      picked = 'system';
    }
  }
  return picked;
}

export function setTheme(theme: Theme): void {
  picked = theme;
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The pick still holds for this page; it just won't outlive it.
  }
  for (const listener of listeners) listener();
}

/** The scheme actually on screen: the pick, or the OS's when there is none. */
export function getColorScheme(): ColorScheme {
  const theme = getTheme();
  if (theme !== 'system') return theme;
  return darkQuery().matches ? 'dark' : 'light';
}

/** Hears a pick and, for `system`, the OS changing its mind. */
export function subscribeTheme(listener: () => void): () => void {
  const query = darkQuery();
  listeners.add(listener);
  query.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    query.removeEventListener('change', listener);
  };
}
