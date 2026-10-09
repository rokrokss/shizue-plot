import type { PlotStyle } from './types';

/**
 * The value of each option that says nothing — the delivery that leans neither
 * way, the difficulty of an ordinary scene. The directive compiler skips them, so
 * the editor drops them: what a creator never chose and what they chose and then
 * took back are the same plot, and both should leave the column null. The two
 * options with no quiet value of their own — the tense and the storytelling style
 * — say nothing by being absent, which the loop below covers already.
 */
const QUIET: Partial<Record<keyof PlotStyle, string | boolean>> = {
  replyLength: 'auto',
  delivery: 'balanced',
  pacing: 'natural',
  difficulty: 'normal',
  statusWindow: false,
  choices: 'off',
};

/**
 * The style with one field replaced, or null once it says nothing at all.
 *
 * The same answer `withNarratorField` gives for the narrator, for the same
 * reason: the API stores an empty style as no style, so the editor has to be able
 * to hand back an absence rather than an object full of defaults.
 */
export function withPlotStyleField(
  current: PlotStyle | null | undefined,
  values: Partial<PlotStyle>,
): PlotStyle | null {
  const next: PlotStyle = { ...current, ...values };
  for (const key of Object.keys(next) as (keyof PlotStyle)[]) {
    const value = next[key];
    if (value === undefined || value === QUIET[key] || (Array.isArray(value) && value.length === 0)) {
      delete next[key];
    }
  }
  return Object.keys(next).length > 0 ? next : null;
}
