/**
 * The studio's lorebook budget line. The plot and every card lorebook are one
 * book under the first member's settings, so the always-on total spans all of
 * them while the budget is read from the first card alone — and a card that
 * leaves the budget out is automatic, a share of the default context.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_BUDGET, LORE_BUDGET_SHARE, loreBudget } from '../src/lib/loreBudget';
import type { NormalizedCard } from '../src/lib/types';

/** Only the lore settings matter here; the rest of the card is never read. */
const member = (loreConstantTokens: number, tokenBudget?: number) => ({
  loreConstantTokens,
  card: {
    loreSettings: {
      scanDepth: 4,
      recursiveScanning: false,
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
    },
  } as NormalizedCard,
});

describe('loreBudget', () => {
  it('adds the plot and every member to the always-on total', () => {
    expect(loreBudget(100, [member(200), member(300)]).constantTokens).toBe(600);
  });

  it('reads the budget from the first member only', () => {
    expect(loreBudget(0, [member(0, 1000), member(0, 9000)])).toMatchObject({ budget: 1000, automatic: false });
  });

  it('is automatic at the default context when the first card sets none, or there is no card', () => {
    const automatic = Math.floor(DEFAULT_CONTEXT_BUDGET * LORE_BUDGET_SHARE);
    expect(loreBudget(0, [member(0), member(0, 500)])).toMatchObject({ budget: automatic, automatic: true });
    expect(loreBudget(0, [])).toMatchObject({ budget: automatic, automatic: true });
  });

  it('takes the share a book names for the automatic budget', () => {
    const shared = {
      ...member(0),
      card: { loreSettings: { ...member(0).card.loreSettings, budgetPercent: 40 } } as NormalizedCard,
    };
    expect(loreBudget(0, [shared])).toMatchObject({
      budget: Math.floor(DEFAULT_CONTEXT_BUDGET * 0.4),
      automatic: true,
    });
  });

  it('warns only once the always-on entries take more than the budget', () => {
    expect(loreBudget(400, [member(600, 1000)]).over).toBe(false);
    expect(loreBudget(401, [member(600, 1000)]).over).toBe(true);
  });
});
