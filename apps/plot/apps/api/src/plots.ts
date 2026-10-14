import type { NormalizedCard, PlotModule, PromptCharacter, PromptPlot, PlotStyle } from '@shizue/core';
import { plots, type Chat, type Character, type Plot } from '@shizue/db';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { notFound } from './errors.js';

/** Loads a plot owned by the caller; other users' rows are simply not found. */
export async function loadOwnedPlot(deps: AppDeps, id: string, userId: string): Promise<Plot> {
  const [plot] = await deps.db
    .select()
    .from(plots)
    .where(and(eq(plots.id, id), eq(plots.ownerId, userId)))
    .limit(1);
  if (!plot) throw notFound('Plot not found');
  return plot;
}

/**
 * The style this chat generates under. Everything in it is the creator's —
 * the reply length included — except the two derived features, which the reader
 * may turn off in their own chat: a plot that never asked for a status window
 * does not get one because a chat's column says true, and a reader who turned the
 * choices off gets none however the plot set them. The assembler is handed the
 * crossing rather than both halves, so only this one place knows the rule.
 */
const chatStyle = (style: PlotStyle, chat: Chat): PlotStyle => ({
  ...style,
  statusWindow: style.statusWindow === true && chat.statusWindowEnabled,
  choices: chat.choicesEnabled ? (style.choices ?? 'off') : 'off',
});

/** The work as the assembler reads it; the reader-facing intro never travels. */
export const toPromptPlot = (plot: Plot, chat: Chat): PromptPlot => ({
  name: plot.name,
  description: plot.description,
  lorebook: plot.lorebook,
  ...(plot.narrator ? { narrator: plot.narrator } : {}),
  ...(plot.style ? { style: chatStyle(plot.style, chat) } : {}),
  // The work's RisuAI modules: their lore for the assembler, their scripts for the request's runs.
  ...(plot.customUi?.modules?.length ? { modules: plot.customUi.modules } : {}),
});

/**
 * The work's modules as RisuAI's `{{moduleenabled}}` and `{{moduleassetlist}}`
 * find them (`CbsHostData.modules`): each that has a namespace, with the names
 * its pictures go by out of `names` — the plot's assets by id, each under the
 * card's own name or else its slug. A picture `names` does not hold is left
 * out. Empty for a work with none, rather than absent: RisuAI answers `0` then.
 */
export function cbsModulesOf(
  modules: readonly PlotModule[] | undefined,
  names: ReadonlyMap<string, string>,
): { namespace: string; assets: string[] }[] {
  return (modules ?? []).flatMap((module) =>
    module.namespace
      ? [{ namespace: module.namespace, assets: module.assets.flatMap((id) => names.get(id) ?? []) }]
      : [],
  );
}

/**
 * Whether a card was last written by SillyTavern, whose prompt runs the
 * `{{setvar}}` its text holds (`PromptCharacter.sillyTavern`). ST's exporter puts
 * `talkativeness` and `fav` in `data.extensions` on every card it saves, and
 * nothing else writes them; a studio-made card has neither. A card that also
 * carries RisuAI's `extensions.risuai` block was written for RisuAI — ST keeps
 * the block on a card it got from there — and RisuAI's prompt never runs them,
 * so it is read RisuAI's way.
 */
export function isSillyTavernCard(card: NormalizedCard): boolean {
  const extensions = card.extensions ?? {};
  if (extensions['risuai'] !== undefined) return false;
  return 'talkativeness' in extensions || 'fav' in extensions;
}

/**
 * The roster as the assembler reads it. The name is the row's rather than the
 * card's: it is the speaker prefix the script protocol matches, so the name the
 * model is taught to write has to be the name the parser looks for. `absent` are
 * the ids a chat sent off the stage; an id no member has any more matches nothing.
 * The id is what a group reply names its speaker by (`HistoryMessage.speakerId`).
 */
export const toPromptCharacters = (
  members: Character[],
  absent: ReadonlySet<string> = new Set(),
): PromptCharacter[] =>
  members.map((member) => ({
    id: member.id,
    name: member.name,
    card: member.card,
    ...(absent.has(member.id) ? { absent: true } : {}),
    ...(isSillyTavernCard(member.card) ? { sillyTavern: true } : {}),
  }));
