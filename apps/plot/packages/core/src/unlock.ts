/**
 * What a plot asset waits for before a chat may reveal it, kept to the three
 * conditions the server can actually check.
 *
 * Same attitude as the style whitelist: the column is jsonb written from outside,
 * so an unlock this build cannot evaluate must never reach it — an unreadable one
 * would leave an image locked forever with nothing able to open it. A value that
 * describes no condition coerces to `null`, which is the asset every reader sees.
 */

import {
  MAX_UNLOCK_KEYWORD_LENGTH,
  MAX_UNLOCK_KEYWORDS,
  MAX_UNLOCK_RELATIONSHIP,
  MAX_UNLOCK_TURNS,
  UNLOCK_AXES,
  type AssetUnlock,
  type UnlockAxis,
} from './types.js';

/** A whole number inside the bounds, or undefined for anything that is not one. */
function bounded(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  // Clamped rather than refused: the bounds exist so the condition stays
  // reachable, and a creator who typed 900 turns meant "as deep as it goes".
  return Math.min(Math.max(rounded, 1), max);
}

/** The words a keyword unlock listens for, deduplicated in the creator's order. */
function keywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const words = value
    .filter((word): word is string => typeof word === 'string')
    .map((word) => word.trim().slice(0, MAX_UNLOCK_KEYWORD_LENGTH))
    .filter((word) => word.length > 0);
  return [...new Set(words)].slice(0, MAX_UNLOCK_KEYWORDS);
}

/**
 * The unlock a value describes, or null when it describes none — an unknown kind,
 * a keyword list with nothing in it, a relationship axis this build has no gauge
 * for. Numbers are clamped into their bounds; everything else is dropped.
 */
export function coerceAssetUnlock(value: unknown): AssetUnlock | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  switch (raw['kind']) {
    case 'keyword': {
      const words = keywords(raw['keywords']);
      return words.length > 0 ? { kind: 'keyword', keywords: words } : null;
    }
    case 'turns': {
      const count = bounded(raw['count'], MAX_UNLOCK_TURNS);
      return count === undefined ? null : { kind: 'turns', count };
    }
    case 'relationship': {
      const axis = raw['axis'];
      if (!UNLOCK_AXES.includes(axis as UnlockAxis)) return null;
      const min = bounded(raw['min'], MAX_UNLOCK_RELATIONSHIP);
      return min === undefined ? null : { kind: 'relationship', axis: axis as UnlockAxis, min };
    }
    default:
      return null;
  }
}
