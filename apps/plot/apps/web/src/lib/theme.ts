/**
 * The reader's theme. Dark is the default, as Zeta's is, whatever the OS says;
 * light is a pick, kept in localStorage and shown as <html data-theme="light">.
 * `THEME_SCRIPT` puts it there before first paint, and `ThemedHtml` keeps it
 * there from then on.
 */
export const themes = ['dark', 'light'] as const;
export type Theme = (typeof themes)[number];
export type ColorScheme = Theme;

const STORAGE_KEY = 'shizue-theme';

/**
 * Inlined in the server HTML so a stored pick lands before anything paints.
 * Storage can throw (blocked site data), and then the page stays dark.
 */
export const THEME_SCRIPT = `try{if(localStorage.getItem('${STORAGE_KEY}')==='light')document.documentElement.dataset.theme='light'}catch(e){}`;

let picked: Theme | undefined;
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  if (picked === undefined) {
    try {
      picked = localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
    } catch {
      picked = 'dark';
    }
  }
  return picked;
}

export function setTheme(theme: Theme): void {
  picked = theme;
  try {
    if (theme === 'dark') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The pick still holds for this page; it just won't outlive it.
  }
  for (const listener of listeners) listener();
}

/** The scheme on screen, which is the pick. */
export function getColorScheme(): ColorScheme {
  return getTheme();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
