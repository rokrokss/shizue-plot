/**
 * Card interop for the narrator — how the scene is told, as against how the
 * character speaks.
 *
 * No other card format has the field, so like the component code it goes under
 * our own namespace rather than pretending to be someone else's extension. It
 * still has to survive a round trip through an exported card: it is ours, and a
 * creator who exports a card and imports it back must get the same character.
 *
 * The whitelist lives here rather than at either edge because both edges need the
 * same one — the import path reads a card written by a stranger, and the API reads
 * a card body written by a client, and neither may end up with a point of view the
 * prompt has no label for.
 */

import { NARRATOR_POVS, type NarratorConfig, type NarratorPov } from '../types.js';
import { SHIZUE_EXTENSION } from './componentCode.js';

/**
 * The narrator a value describes, keeping only what this build understands: an
 * unknown point of view is dropped rather than stored, and a voice that is blank
 * says nothing. Returns an empty config when there is nothing to keep, so callers
 * can leave the key out of the card entirely.
 */
export function coerceNarrator(value: unknown): NarratorConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const voice = typeof raw['voice'] === 'string' ? (raw['voice'] as string) : '';
  const pov = raw['pov'];
  return {
    ...(voice.trim() ? { voice } : {}),
    ...(NARRATOR_POVS.includes(pov as NarratorPov) ? { pov: pov as NarratorPov } : {}),
  };
}

/** Reads `extensions.shizue.narrator` off an imported card. */
export function narratorFromExtensions(
  extensions: Record<string, unknown>,
): NarratorConfig | undefined {
  const shizue = extensions[SHIZUE_EXTENSION];
  if (shizue === null || typeof shizue !== 'object') return undefined;
  const narrator = coerceNarrator((shizue as Record<string, unknown>)['narrator']);
  return Object.keys(narrator).length > 0 ? narrator : undefined;
}

/** Writes it back into a copy of the extensions, dropping the key when unset. */
export function extensionsWithNarrator(
  extensions: Record<string, unknown>,
  narrator: NarratorConfig | undefined,
): Record<string, unknown> {
  const previous = extensions[SHIZUE_EXTENSION];
  const shizue: Record<string, unknown> =
    previous !== null && typeof previous === 'object'
      ? { ...(previous as Record<string, unknown>) }
      : {};

  // Coerced on the way out too: what leaves is what a reader would take back in,
  // so an export can never carry a narrator that re-imports as something else.
  const kept = coerceNarrator(narrator);
  if (Object.keys(kept).length > 0) shizue['narrator'] = kept;
  else delete shizue['narrator'];

  const next = { ...extensions };
  if (Object.keys(shizue).length > 0) next[SHIZUE_EXTENSION] = shizue;
  else delete next[SHIZUE_EXTENSION];
  return next;
}
