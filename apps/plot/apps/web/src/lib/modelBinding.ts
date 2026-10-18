import type { ModelBinding, ModelPreset } from './types';

/** No slot picked: what a chat starts with, and the default before it is read. */
export const OPEN_BINDING: ModelBinding = { main: null, sub: null };

/**
 * The preset a slot runs on as the page can tell it (the API's `resolvePreset`):
 * the chat's own pick, else the default's; an open sub, the main's. Undefined
 * when nothing names one the list has.
 */
export function effectivePreset(
  presets: readonly ModelPreset[],
  chat: ModelBinding | undefined,
  defaults: ModelBinding,
  slot: 'main' | 'sub',
): ModelPreset | undefined {
  const find = (id: string | null | undefined) => (id ? presets.find((preset) => preset.id === id) : undefined);
  const main = find(chat?.main) ?? (chat?.main ? undefined : find(defaults.main));
  if (slot === 'main') return main;
  return find(chat?.sub) ?? (defaults.sub ? find(defaults.sub) : undefined) ?? main;
}
