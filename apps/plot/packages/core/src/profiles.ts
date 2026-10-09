/**
 * The reader profiles a plot recommends, kept to what the start panel can offer.
 *
 * The column is jsonb and every writer of it comes from outside — the plot editor
 * editor through the API — so the caps live here rather than at either edge, the
 * way the style whitelist does. Junk is dropped silently rather than refused: a
 * creator who sends one malformed row still gets to keep the ones they wrote.
 */

import {
  MAX_PLOT_PROFILE_DESCRIPTION_LENGTH,
  MAX_PLOT_PROFILE_NAME_LENGTH,
  MAX_PLOT_PROFILES,
  type PlotProfile,
} from './types.js';

/** A profile row's id: the editor's own where it sent a usable one, a new one otherwise. */
function profileId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : crypto.randomUUID();
}

/**
 * The profiles a value describes. A row without a usable name is dropped — the
 * name is what a reader picks by — and everything else is trimmed to its cap
 * rather than refused, since the alternative is a create that fails over a
 * description one character too long.
 */
export function coercePlotProfiles(value: unknown): PlotProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: PlotProfile[] = [];
  for (const entry of value) {
    if (profiles.length >= MAX_PLOT_PROFILES) break;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
    if (!name) continue;
    const description = typeof raw['description'] === 'string' ? raw['description'].trim() : '';
    profiles.push({
      id: profileId(raw['id']),
      name: name.slice(0, MAX_PLOT_PROFILE_NAME_LENGTH),
      description: description.slice(0, MAX_PLOT_PROFILE_DESCRIPTION_LENGTH),
    });
  }
  return profiles;
}
