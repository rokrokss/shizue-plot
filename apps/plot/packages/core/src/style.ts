/**
 * The plot's style, kept to what this build understands.
 *
 * The column is jsonb and every writer of it — the plot editor editor through the API,
 * and any import path we grow later — comes from outside, so the whitelist lives
 * here rather than at either edge: an option this build has no directive for must
 * never reach the prompt assembler, and a stored style must always be a style the
 * next assembly can compile.
 *
 * Junk is dropped silently rather than rejected, the way `coerceNarrator` drops an
 * unknown point of view: a client that sends one unknown enum still gets to set
 * the eight it did know.
 */

import {
  CHOICES_MODES,
  MAX_PLOT_MOODS,
  NARRATIVE_DELIVERIES,
  REPLY_LENGTHS,
  PLOT_DIFFICULTIES,
  PLOT_MOODS,
  PLOT_PACINGS,
  PLOT_TENSES,
  STORYTELLING_STYLES,
  type ChoicesMode,
  type NarrativeDelivery,
  type ReplyLength,
  type PlotDifficulty,
  type PlotMood,
  type PlotPacing,
  type PlotStyle,
  type PlotTense,
  type StorytellingStyle,
} from './types.js';

/** The value when it is one of the options, and undefined for anything else. */
function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

/**
 * The style a value describes. Unknown enum values are dropped, moods are kept in
 * the creator's order without duplicates and clamped to `MAX_PLOT_MOODS`, and a
 * value that describes nothing returns an empty style — so a caller can leave the
 * column null rather than store a config that says nothing.
 *
 * Options that happen to equal a default (`balanced`, `natural`, `normal`, `off`)
 * are kept: they are what the creator picked, and it is the directive compiler's
 * business that they produce no line.
 */
export function coercePlotStyle(value: unknown): PlotStyle {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;

  const tense = pick<PlotTense>(raw['tense'], PLOT_TENSES);
  const replyLength = pick<ReplyLength>(raw['replyLength'], REPLY_LENGTHS);
  const delivery = pick<NarrativeDelivery>(raw['delivery'], NARRATIVE_DELIVERIES);
  const pacing = pick<PlotPacing>(raw['pacing'], PLOT_PACINGS);
  const difficulty = pick<PlotDifficulty>(raw['difficulty'], PLOT_DIFFICULTIES);
  const storytelling = pick<StorytellingStyle>(raw['storytelling'], STORYTELLING_STYLES);
  const choices = pick<ChoicesMode>(raw['choices'], CHOICES_MODES);
  const statusWindow = raw['statusWindow'];

  const moods = Array.isArray(raw['moods'])
    ? [
        ...new Set(
          raw['moods'].filter((mood): mood is PlotMood => PLOT_MOODS.includes(mood as PlotMood)),
        ),
      ].slice(0, MAX_PLOT_MOODS)
    : [];

  return {
    ...(tense ? { tense } : {}),
    ...(replyLength ? { replyLength } : {}),
    ...(delivery ? { delivery } : {}),
    ...(pacing ? { pacing } : {}),
    ...(difficulty ? { difficulty } : {}),
    ...(moods.length > 0 ? { moods } : {}),
    ...(storytelling ? { storytelling } : {}),
    ...(typeof statusWindow === 'boolean' ? { statusWindow } : {}),
    ...(choices ? { choices } : {}),
  };
}
