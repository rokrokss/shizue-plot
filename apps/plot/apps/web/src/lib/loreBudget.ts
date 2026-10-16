/** What the studio says about the one lorebook a plot and its roster share. */

import type { NormalizedCard, PlotMember } from './types';

/** Mirrors DEFAULT_CONTEXT_BUDGET in @shizue/core — what a chat gets until its reader picks another. */
export const DEFAULT_CONTEXT_BUDGET = 64000;
/** Mirrors LORE_BUDGET_SHARE in @shizue/core: an automatic budget's share of the context. */
export const LORE_BUDGET_SHARE = 0.5;
/** Mirrors TAVERN_LORE_BUDGET_SHARE in @shizue/core: a SillyTavern book's automatic share. */
export const TAVERN_LORE_BUDGET_SHARE = 0.25;

export interface LoreBudget {
  /** Plot and every member together, as the server last counted them. */
  constantTokens: number;
  /** The first member's explicit budget, or the automatic one at the default context. */
  budget: number;
  automatic: boolean;
  /** The automatic budget's share of the context. */
  share: number;
  /** The always-on entries alone take more than the budget, so later entries are cut. */
  over: boolean;
}

/**
 * Mirrors the API's `isSillyTavernCard`: ST's exporter writes `talkativeness`
 * and `fav` on every card it saves, and a card that carries RisuAI's block was
 * written for RisuAI.
 */
function isSillyTavernCard(card: NormalizedCard): boolean {
  const extensions = card.extensions ?? {};
  if (extensions['risuai'] !== undefined) return false;
  return 'talkativeness' in extensions || 'fav' in extensions;
}

/**
 * The plot lorebook and every card lorebook are activated as one book, under
 * the settings of the first member's card — the same card the prompt's
 * overrides come from. A budget the card leaves out is automatic, a share of
 * the chat's context; the studio has no chat, so it answers for the default.
 */
export function loreBudget(
  plotConstantTokens: number,
  members: Pick<PlotMember, 'card' | 'loreConstantTokens'>[],
): LoreBudget {
  const constantTokens = members.reduce((sum, member) => sum + member.loreConstantTokens, plotConstantTokens);
  const first = members[0]?.card;
  const settings = first?.loreSettings;
  const explicit = settings?.tokenBudget;
  // A book SillyTavern's migration set a share on takes that share instead, and
  // a SillyTavern card's book ST's own quarter. The server also runs a book as
  // ST's when every entry in it is; the studio reads the first card alone.
  const share =
    settings?.budgetPercent !== undefined
      ? settings.budgetPercent / 100
      : first && isSillyTavernCard(first)
        ? TAVERN_LORE_BUDGET_SHARE
        : LORE_BUDGET_SHARE;
  const budget = explicit ?? Math.floor(DEFAULT_CONTEXT_BUDGET * share);
  return { constantTokens, budget, automatic: explicit === undefined, share, over: constantTokens > budget };
}
