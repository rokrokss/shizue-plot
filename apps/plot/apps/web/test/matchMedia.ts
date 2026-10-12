/** jsdom has no `matchMedia`, and the theme asks it whether the OS is dark. */
export function stubMatchMedia(dark = false): void {
  window.matchMedia = ((query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}
