/**
 * The one-off repair for works of several members whose companions joined before
 * each member's custom UI was lifted (355e738, 2026-10-14).
 *
 * Until then `/characters/import` put a companion's card on the roster and lifted
 * nothing: its display scripts, its stylesheet and its default variables stayed
 * on the card, so its messages were drawn bare. The card was stored whole
 * (`characters.card`), so what today's import lifts off it (`liftCompanion`) can
 * be lifted now — tagged as its own, after the work's scripts, its variables into
 * the work's namespace with the work's values kept. The first card's scripts,
 * which the plot import put on the work untagged, stay untagged: untagged is the
 * work's own and dresses every message, as before, and a creator's work scripts
 * look exactly the same. No background is lifted: a work draws one (RisuAI's
 * groups draw their own, never a member's), and the roster is not changed, so it
 * draws what it drew.
 *
 * A plot is only touched while its custom UI is exactly what the old import left:
 * the first card's lift (`legacyCustomUiOfCard`) — the first member by creation,
 * as the plot import inserted it with the plot, wherever the roster has moved it
 * since. Anything else was changed since — by its creator, or by an importer
 * that added scripts of its own — and is left as it is, the caution
 * `displayOrder.ts` takes.
 */

import { creatorCssFromExtensions, type NormalizedCard, type PlotCustomUi } from '@shizue/core';
import { characters, plots, type Db } from '@shizue/db';
import { asc, eq, sql } from 'drizzle-orm';
import { liftCompanion } from '../card.js';
import { currentDisplayScripts, judgeDisplayOrder } from './displayOrder.js';

/** One member as the repair reads it, in the order they were created. */
export interface RepairMember {
  id: string;
  name: string;
  card: NormalizedCard;
}

/**
 * What the plot import before 355e738 lifted off the card that made the plot.
 * Verbatim from `customUiOfCard` at 355e738^ (`apps/api/src/card.ts`), so it
 * reproduces what that import stored.
 */
export function legacyCustomUiOfCard(card: NormalizedCard): PlotCustomUi {
  const css = creatorCssFromExtensions(card.extensions);
  return {
    ...(card.displayScripts?.length ? { displayScripts: card.displayScripts } : {}),
    ...(css ? { css } : {}),
    ...(card.defaultVariables && Object.keys(card.defaultVariables).length > 0
      ? { defaultVariables: card.defaultVariables }
      : {}),
    ...(card.componentCode ? { componentCode: card.componentCode } : {}),
    ...(card.componentCapabilities?.length
      ? { componentCapabilities: card.componentCapabilities }
      : {}),
  };
}

/** The same JSON, whatever order the keys were written in — jsonb keeps its own. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
  }
  return value;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Whether a card has anything `liftCompanion` would lift. */
const brings = (card: NormalizedCard): boolean =>
  Boolean(card.displayScripts?.length) ||
  creatorCssFromExtensions(card.extensions) !== undefined ||
  Object.keys(card.defaultVariables ?? {}).length > 0;

/**
 * Whether the work already holds what a member brought: a script tagged with it
 * or its stylesheet — or, for a card that brings variables alone, every one of
 * their names.
 */
const liftedAlready = (customUi: PlotCustomUi, member: RepairMember): boolean =>
  (customUi.displayScripts ?? []).some((script) => script.memberId === member.id) ||
  customUi.memberCss?.[member.id] !== undefined ||
  (!member.card.displayScripts?.length &&
    creatorCssFromExtensions(member.card.extensions) === undefined &&
    Object.keys(member.card.defaultVariables ?? {}).every((name) => Object.hasOwn(customUi.defaultVariables ?? {}, name)));

export type MemberScriptsVerdict =
  /** No companion carries anything to lift. */
  | { kind: 'unaffected' }
  /** Every companion's is on the work already: imported since, or repaired. */
  | { kind: 'current' }
  /**
   * The first card's scripts are as the import before 353c976 ordered them:
   * `fix:display-order` reorders them only while they are the whole list, so it
   * goes first.
   */
  | { kind: 'order-first' }
  /** Not what the old import left: changed since, so the creator's own. */
  | { kind: 'edited' }
  /**
   * What to store: the companions' lifted on. `lifted` are their member ids;
   * `conflicts` the variables the work kept another value for.
   */
  | { kind: 'fix'; customUi: PlotCustomUi; lifted: string[]; conflicts: { member: string; names: string[] }[] };

/**
 * Where a work's custom UI stands. `members` in the order they were created: the
 * first is the card the plot import made the plot of, the rest are companions.
 */
export function judgeMemberScripts(
  customUi: PlotCustomUi | null | undefined,
  members: readonly RepairMember[],
): MemberScriptsVerdict {
  const [first, ...companions] = members;
  const bringing = companions.filter((member) => brings(member.card));
  if (!first || bringing.length === 0) return { kind: 'unaffected' };
  const stored = customUi ?? {};

  // Anything only today's import or editor writes — a tagged script, a member's
  // stylesheet, the work's background — means the plot was shaped since. It is
  // current if every companion already has its own there, and otherwise not the
  // old import's to finish.
  const shapedSince =
    (stored.displayScripts ?? []).some((script) => script.memberId !== undefined) ||
    stored.memberCss !== undefined ||
    stored.backgroundHtml !== undefined;
  if (shapedSince) {
    return bringing.every((member) => liftedAlready(stored, member)) ? { kind: 'current' } : { kind: 'edited' };
  }

  const legacy = legacyCustomUiOfCard(first.card);
  if (!same(stored, legacy)) {
    // The same, past the order `fix:display-order` has since put its scripts in.
    const reordered = currentDisplayScripts(first.card.extensions);
    if (!reordered || !same(stored, { ...legacy, displayScripts: reordered })) return { kind: 'edited' };
  } else if (judgeDisplayOrder(stored.displayScripts, [first.card.extensions]).kind === 'fix') {
    return { kind: 'order-first' };
  }

  let lifted: PlotCustomUi = stored;
  const conflicts: { member: string; names: string[] }[] = [];
  for (const member of bringing) {
    const next = liftCompanion(lifted, member.card, member.id);
    lifted = next.customUi;
    if (next.conflicts.length > 0) conflicts.push({ member: member.name, names: next.conflicts });
  }
  if (same(lifted, stored)) return { kind: 'current' };
  return { kind: 'fix', customUi: lifted, lifted: bringing.map((member) => member.id), conflicts };
}

/* ---------------------------------------------------------------- the run */

export interface MemberScriptsReport {
  /** Works of two or more members looked at. */
  scanned: number;
  /** Repaired — or, on a dry run, to be repaired. */
  fixed: string[];
  current: number;
  unaffected: number;
  /** Waiting on `fix:display-order`, and left. */
  orderFirst: string[];
  /** Changed since the import, and left alone. */
  edited: string[];
}

/** What a member brought, as a line a person can check. */
function broughtLine(customUi: PlotCustomUi, memberId: string): string {
  const scripts = (customUi.displayScripts ?? []).filter((script) => script.memberId === memberId).length;
  const css = customUi.memberCss?.[memberId] !== undefined;
  return `${scripts} display script${scripts === 1 ? '' : 's'}${css ? ', its stylesheet' : ''}`;
}

/**
 * Looks at every work of two or more members and, with `apply`, lifts what its
 * companions brought onto the ones the old import left. Each plot is read and
 * written under its row lock, so a creator saving at the same moment either lands
 * first — and the plot is then theirs — or after, over this. `updated_at` is not
 * touched: it is a correction, not an edit. Running it again finds nothing to do.
 */
export async function repairMemberScripts(
  db: Db,
  { apply, log = console.log }: { apply: boolean; log?: (line: string) => void },
): Promise<MemberScriptsReport> {
  const report: MemberScriptsReport = { scanned: 0, fixed: [], current: 0, unaffected: 0, orderFirst: [], edited: [] };
  const candidates = await db
    .select({ id: plots.id })
    .from(plots)
    .where(sql`(select count(*) from ${characters} where ${characters.plotId} = ${plots.id}) >= 2`)
    .orderBy(asc(plots.createdAt), asc(plots.id));

  for (const { id } of candidates) {
    await db.transaction(async (tx) => {
      const read = tx
        .select({ id: plots.id, name: plots.name, customUi: plots.customUi })
        .from(plots)
        .where(eq(plots.id, id));
      const [plot] = apply ? await read.for('update') : await read;
      if (!plot) return;
      const members = await tx
        .select({ id: characters.id, name: characters.name, card: characters.card })
        .from(characters)
        .where(eq(characters.plotId, id))
        .orderBy(asc(characters.createdAt), asc(characters.orderIndex), asc(characters.id));
      if (members.length < 2) return;
      report.scanned += 1;

      const verdict = judgeMemberScripts(plot.customUi, members);
      const label = `plot ${plot.id} ${JSON.stringify(plot.name)}`;
      if (verdict.kind === 'unaffected') report.unaffected += 1;
      else if (verdict.kind === 'current') report.current += 1;
      else if (verdict.kind === 'order-first') {
        report.orderFirst.push(plot.id);
        log(`left  ${label}: its first card's scripts still run in the old <order> — run fix:display-order first`);
      } else if (verdict.kind === 'edited') {
        report.edited.push(plot.id);
        log(`left  ${label}: its custom UI is not what the old import left — changed since`);
      } else {
        report.fixed.push(plot.id);
        log(`${apply ? 'lifted' : 'would lift'} into ${label}:`);
        for (const member of members.filter((one) => verdict.lifted.includes(one.id))) {
          log(`  ${JSON.stringify(member.name)}: ${broughtLine(verdict.customUi, member.id)}`);
        }
        for (const conflict of verdict.conflicts) {
          log(`  kept the work's value of ${conflict.names.join(', ')} over ${JSON.stringify(conflict.member)}'s`);
        }
        if (apply) await tx.update(plots).set({ customUi: verdict.customUi }).where(eq(plots.id, plot.id));
      }
    });
  }

  log(
    `${report.scanned} works of several members: ${report.fixed.length} ${apply ? 'repaired' : 'to repair'}, ` +
      `${report.current} already current, ${report.unaffected} with nothing to lift, ` +
      `${report.orderFirst.length} waiting on fix:display-order, ${report.edited.length} changed since and left alone.`,
  );
  return report;
}
