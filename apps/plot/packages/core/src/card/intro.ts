/**
 * Card interop for the reader-facing intro — what a person is told about the
 * character, as against `description`, which is what the model is told.
 *
 * Our own cards carry it under our namespace, like the narrator, and it has to
 * survive a round trip: a creator who exports a card and imports it back must get
 * the same character. Someone else's card says it in `creator_notes`, which
 * RisuAI and its Realm show readers as the card's description — when it is
 * searched for and when it is first opened — so a card without ours lends the
 * work that.
 *
 * The cap is enforced here as well as at the API, because import is the path that
 * never passes through the editor. An oversized intro of our own is dropped and
 * the rest of the card kept, exactly as the component code's is; creator notes
 * were never written against our cap, so they are cut as imported openings are.
 */

import { SHIZUE_EXTENSION } from './componentCode.js';

/** Characters a reader-facing intro may hold. */
export const MAX_INTRO_LENGTH = 4000;

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

/**
 * RisuAI's `parseMultilangString`: each `` # `ko` `` header opens a section in
 * that language, and whatever no header claims is `xx`.
 */
function multilangSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const header = /# `(.+?)`\n([\s\S]+?)(?=\n# `|$)/g;
  for (const [, code, body] of text.matchAll(header)) sections[code!] = body!;
  sections['xx'] = text.replace(header, '');
  return sections;
}

/**
 * The intro an imported card's `creator_notes` gives the work, picked as Realm
 * picks it for a reader: their language, else English (which Realm requires
 * every upload to have), else the untagged text.
 */
export function introFromCreatorNotes(notes: string, language?: string): string | undefined {
  const sections = multilangSections(notes);
  const intro = [language ? sections[language] : undefined, sections['en'], sections['xx']]
    .map((section) => section?.trim())
    .find(Boolean);
  return intro?.slice(0, MAX_INTRO_LENGTH);
}
