/**
 * Card interop for the reader-facing intro — what a person is told about the
 * character, as against `description`, which is what the model is told.
 *
 * No card format has the field (CCv3's `creator_notes` is addressed to other
 * creators, not to readers), so like the narrator it goes under our own namespace
 * rather than borrowing someone else's, and it has to survive a round trip: a
 * creator who exports a card and imports it back must get the same character.
 *
 * The cap is enforced here as well as at the API, because import is the path that
 * never passes through the editor. An oversized intro is dropped and the rest of
 * the card kept, exactly as the component code's is.
 */

import { SHIZUE_EXTENSION } from './componentCode.js';

/** Characters a reader-facing intro may hold. */
export const MAX_INTRO_LENGTH = 500;

/** Reads `extensions.shizue.intro` off an imported card. */
export function introFromExtensions(extensions: Record<string, unknown>): string | undefined {
  const shizue = extensions[SHIZUE_EXTENSION];
  if (shizue === null || typeof shizue !== 'object') return undefined;
  const intro = (shizue as Record<string, unknown>)['intro'];
  if (typeof intro !== 'string' || !intro.trim()) return undefined;
  return intro.length > MAX_INTRO_LENGTH ? undefined : intro;
}

/** Writes it back into a copy of the extensions, dropping the key when unset. */
export function extensionsWithIntro(
  extensions: Record<string, unknown>,
  intro: string | undefined,
): Record<string, unknown> {
  const previous = extensions[SHIZUE_EXTENSION];
  const shizue: Record<string, unknown> =
    previous !== null && typeof previous === 'object'
      ? { ...(previous as Record<string, unknown>) }
      : {};

  if (intro && intro.trim()) shizue['intro'] = intro;
  else delete shizue['intro'];

  const next = { ...extensions };
  if (Object.keys(shizue).length > 0) next[SHIZUE_EXTENSION] = shizue;
  else delete next[SHIZUE_EXTENSION];
  return next;
}
