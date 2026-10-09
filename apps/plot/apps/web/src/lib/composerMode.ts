import { withNarrationPrefix } from '@shizue/core/narration';

/**
 * What the composer is writing: a line of the reader's own dialogue, their
 * 상황묘사, or the narrator's.
 *
 * The mode is a way of typing, not a column: it transforms the text on its way
 * out and nothing else — what is stored is the same `*…*` and `@:` conventions a
 * reader can type by hand, so a turn written in one mode is indistinguishable
 * from the same turn typed out in another.
 */
export type ComposerMode = 'dialogue' | 'description' | 'narration';

/** In the order the chips stand, dialogue first because it is the default. */
export const COMPOSER_MODES: readonly ComposerMode[] = ['dialogue', 'description', 'narration'];

/**
 * The turn as it will be stored. Marks the reader already put there are left
 * alone: the `*` button and the 묘사 chip write the same notation, and pressing
 * both must not come out as bold.
 */
export function composeTurn(text: string, mode: ComposerMode): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (mode === 'narration') return withNarrationPrefix(trimmed);
  if (mode === 'description') {
    const wrapped = trimmed.length > 1 && trimmed.startsWith('*') && trimmed.endsWith('*');
    return wrapped ? trimmed : `*${trimmed}*`;
  }
  return text;
}
