import type { PromptCharacter, PromptPlot, PlotStyle } from '@shizue/core';
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
});

/**
 * The roster as the assembler reads it. The name is the row's rather than the
 * card's: it is the speaker prefix the script protocol matches, so the name the
 * model is taught to write has to be the name the parser looks for.
 */
export const toPromptCharacters = (members: Character[]): PromptCharacter[] =>
  members.map((member) => ({ name: member.name, card: member.card }));
