/**
 * The one-off repair for plots whose card was imported before RisuAI's `<order N>`
 * was read the right way round (commit 353c976, 2026-10-12).
 *
 * RisuAI runs the script with the highest `<order N>` first. The import before
 * that commit copied the numbers straight into our `order`, which runs the lowest
 * first, so those plots draw their display scripts backwards. The member's card
 * still holds RisuAI's own list verbatim (`extensions.risuai.customScripts`), so
 * both answers can be worked out again: what that import made of it
 * (`legacyDisplayScripts`, its code as it stood) and what today's import makes of
 * it (`currentDisplayScripts`). A plot whose scripts are exactly the first gets the
 * second; a plot whose scripts are neither was changed by its creator since, and
 * is left as it is.
 *
 * A command rather than a fix on load: the answer needs the plot and every
 * member's card together, which no hot path reads, and an operator wants to see
 * the list before anything is written (`fixDisplayOrder.ts`).
 */

import {
  displayScriptsFromExtensions,
  displayScriptsWithRegexScripts,
  MAX_DISPLAY_PATTERN_LENGTH,
  type DisplayScript,
  type DisplayScriptAction,
} from '@shizue/core';
import { characters, plots, type Db } from '@shizue/db';
import { asc, eq, isNotNull } from 'drizzle-orm';

/* ---------------------------------------------- the import before 353c976 */

// Verbatim from `packages/core/src/card/risu.ts` at 353c976^, so it reproduces
// what that import stored to the byte.

const NATIVE_FLAGS = 'dgimsuvy';
const FLAG_DIRECTIVE = /<([a-z_]+)(?:[ \t]+(-?\d+))?>/gi;
const OUT_ACTION = /@@(move_top|move_bottom|repeat_back)\b/i;
const OUT_ORDER = /<order[ \t]+(-?\d+)>/i;
const ACTIONS = ['move_top', 'move_bottom', 'repeat_back'];

interface Directives {
  action?: DisplayScriptAction;
  order?: number;
}

function parseFlagField(flag: string): Directives & { flags: string } {
  let action: DisplayScriptAction | undefined;
  let order: number | undefined;
  const rest = flag.replace(FLAG_DIRECTIVE, (_directive, name: string, argument?: string) => {
    const key = name.toLowerCase();
    if (ACTIONS.includes(key)) action ??= key as DisplayScriptAction;
    else if (key === 'order' && argument !== undefined) order ??= Number.parseInt(argument, 10);
    return '';
  });
  const flags = [...new Set(rest)].filter((letter) => NATIVE_FLAGS.includes(letter)).join('');
  return { flags, ...(action ? { action } : {}), ...(order !== undefined ? { order } : {}) };
}

function parseOutDirectives(out: string): Directives & { template: string } {
  const action = OUT_ACTION.exec(out);
  const order = OUT_ORDER.exec(out);
  return {
    ...(action ? { action: action[1]!.toLowerCase() as DisplayScriptAction } : {}),
    ...(order ? { order: Number.parseInt(order[1]!, 10) } : {}),
    template: out.replace(OUT_ACTION, '').replace(OUT_ORDER, '').replace(/^\n+/, ''),
  };
}

// The pattern screen as it stood then (`displayScriptPatternError` in
// `packages/core/src/displayScript.ts` at 353c976^, unchanged until the Realm
// sweep narrowed it), which switched off every repeat inside a repeat. Today's
// narrower screen would turn some of those scripts on, and a plot the old import
// left would no longer read as exactly its work. SillyTavern's display regexes
// below (`displayScriptsWithRegexScripts`) still go through today's screen: a
// card carrying both an `<order N>` and an ST regex the two screens disagree on
// reads as changed by its creator, and is left alone.

const LEGACY_UNBOUNDED_QUANTIFIER = /[*+]|\{\d*,\}/;

function legacyStripLiterals(source: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === '\\') {
      out += '  ';
      i += 1;
      continue;
    }
    if (inClass) {
      out += char === ']' ? ']' : ' ';
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') inClass = true;
    out += char;
  }
  return out;
}

function legacyGroupsOf(source: string): { body: string; quantifier: string }[] {
  const groups: { body: string; quantifier: string }[] = [];
  const open: number[] = [];
  let inClass = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === '(') {
      open.push(i);
      continue;
    }
    if (char !== ')') continue;

    const start = open.pop();
    if (start === undefined) continue;
    const body = source.slice(start + 1, i).replace(/^\?(?::|<?[=!]|<[A-Za-z_$][\w$]*>)/, '');
    const rest = source.slice(i + 1);
    const quantifier = /^(?:[*+?]|\{\d*(?:,\d*)?\})/.exec(rest)?.[0] ?? '';
    groups.push({ body, quantifier });
  }
  return groups;
}

const legacyIsUnbounded = (quantifier: string): boolean =>
  quantifier === '*' || quantifier === '+' || /^\{\d*,\}$/.test(quantifier);

function legacyPatternError(source: string): string | null {
  if (source.length > MAX_DISPLAY_PATTERN_LENGTH) return 'too_long';
  try {
    new RegExp(source);
  } catch {
    return 'invalid';
  }

  for (const { body, quantifier } of legacyGroupsOf(source)) {
    if (!legacyIsUnbounded(quantifier)) continue;
    const structure = legacyStripLiterals(body);
    if (LEGACY_UNBOUNDED_QUANTIFIER.test(structure) || structure.includes('|')) {
      return 'unsafe_repetition';
    }
  }
  return null;
}

/** One script as that import read it, and whether it took an `<order N>` from it. */
function toLegacyScript(raw: Record<string, unknown>, index: number): { script: DisplayScript; ordered: boolean } | null {
  const source = typeof raw['in'] === 'string' ? raw['in'] : '';
  if (!source) return null;
  const fromFlag = parseFlagField(typeof raw['flag'] === 'string' ? raw['flag'] : '');
  const flags = raw['ableFlag'] === true ? fromFlag.flags : '';
  const out = typeof raw['out'] === 'string' ? raw['out'].replaceAll('\\n', '\n') : '';
  const fromOut = parseOutDirectives(out);
  const action = fromFlag.action ?? fromOut.action;
  const explicit = fromFlag.order ?? fromOut.order;
  return {
    script: {
      in: source,
      out: fromOut.template,
      ...(flags ? { flags } : {}),
      order: explicit ?? index,
      ...(action ? { action } : {}),
      enabled: legacyPatternError(source) === null,
    },
    ordered: explicit !== undefined,
  };
}

/**
 * What the import before 353c976 stored as the plot's display scripts, and
 * whether any `<order N>` went into them — from the flag field whatever
 * `ableFlag` said, or from `out`. Its numbering counted the `editdisplay` entries
 * before dropping the ones without a pattern, and SillyTavern's display regexes
 * followed them (`displayScriptsWithRegexScripts`, unchanged since), as in
 * `normalizeCard`.
 */
export function legacyDisplayScripts(
  extensions: Record<string, unknown>,
): { scripts: DisplayScript[] | undefined; ordered: boolean } {
  const risu = extensions['risuai'];
  const entries =
    risu !== null && typeof risu === 'object' ? (risu as Record<string, unknown>)['customScripts'] : undefined;
  let ordered = false;
  let mapped: DisplayScript[] | undefined;
  if (Array.isArray(entries)) {
    const read = entries
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === 'object' && (entry as Record<string, unknown>)['type'] === 'editdisplay',
      )
      .map(toLegacyScript)
      .filter((entry) => entry !== null);
    ordered = read.some((entry) => entry.ordered);
    mapped = read.length > 0 ? read.map((entry) => entry.script) : undefined;
  }
  return { scripts: displayScriptsWithRegexScripts(extensions, mapped), ordered };
}

/**
 * RisuAI's own `<order N>` beside a script (`DisplayScript.rank`), which today's
 * import keeps and the repairs here never wrote: what they compare and write is
 * the sequence alone.
 */
const withoutRank = (scripts: readonly DisplayScript[]): DisplayScript[] =>
  scripts.map(({ rank: _rank, ...script }) => script);

/** What today's import makes of the same card (`normalizeCard`), as the sequence it runs in. */
export function currentDisplayScripts(extensions: Record<string, unknown>): DisplayScript[] | undefined {
  const scripts = displayScriptsWithRegexScripts(extensions, displayScriptsFromExtensions(extensions));
  return scripts ? withoutRank(scripts) : undefined;
}

/* ------------------------------------------------------------- the verdict */

/** The same JSON, whatever order the keys were written in — jsonb keeps its own. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
  }
  return value;
}

const sameScripts = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export type OrderVerdict =
  /** No display scripts, or no member's card has an `<order N>` the old import read. */
  | { kind: 'unaffected' }
  /** Already what today's import makes: fixed, or imported since. */
  | { kind: 'current' }
  /** Exactly what the old import made: these are today's. */
  | { kind: 'fix'; scripts: DisplayScript[] }
  /** Neither: changed since the import, so the creator's own. */
  | { kind: 'edited' };

/**
 * Where a plot's display scripts stand. Any member's card may be the one they
 * were lifted from — an import makes the card the first member, but the roster
 * can be reordered since — so each one with an `<order N>` is tried.
 * `memberIds`, beside the cards, are their members': today's import tags the
 * scripts as the member's own (`DisplayScript.memberId`), and that is current
 * too. A fix only reorders, as the old import's scripts were never tagged.
 */
export function judgeDisplayOrder(
  stored: readonly DisplayScript[] | undefined,
  cards: readonly Record<string, unknown>[],
  memberIds: readonly string[] = [],
): OrderVerdict {
  if (!stored || stored.length === 0) return { kind: 'unaffected' };
  // A plot imported since keeps RisuAI's ranks beside the sequence; the sequence is what is judged.
  const sequence = withoutRank(stored);
  let ordered = false;
  for (const [index, extensions] of cards.entries()) {
    const legacy = legacyDisplayScripts(extensions);
    if (!legacy.ordered) continue;
    ordered = true;
    const current = currentDisplayScripts(extensions);
    if (!current) continue;
    const memberId = memberIds[index];
    if (sameScripts(sequence, current)) return { kind: 'current' };
    if (memberId !== undefined && sameScripts(sequence, current.map((script) => ({ ...script, memberId })))) {
      return { kind: 'current' };
    }
    if (sameScripts(stored, legacy.scripts)) return { kind: 'fix', scripts: current };
  }
  return ordered ? { kind: 'edited' } : { kind: 'unaffected' };
}

/* ---------------------------------------------------------------- the run */

export interface DisplayOrderReport {
  /** Plots with display scripts looked at. */
  scanned: number;
  /** Fixed — or, on a dry run, to be fixed. */
  fixed: string[];
  current: number;
  /** Changed by their creators since the import, and left alone. */
  edited: string[];
}

/** The run order of a list, by pattern, as a line a person can check. */
function runOrder(scripts: readonly DisplayScript[]): string {
  return scripts
    .map((script, index) => ({ script, index }))
    .sort((a, b) => a.script.order - b.script.order || a.index - b.index)
    .map(({ script }) => JSON.stringify(script.in.length > 32 ? `${script.in.slice(0, 31)}…` : script.in))
    .join(' → ');
}

/**
 * Looks at every plot with display scripts and, with `apply`, rewrites the ones
 * the old import left. Each plot is read and written under its row lock, so a
 * creator saving at the same moment either lands first — and the plot is then
 * theirs — or after, over this. `updated_at` is not touched: it is a correction,
 * not an edit, and it orders the creator's own list. Running it again finds
 * nothing to do.
 */
export async function repairDisplayOrder(
  db: Db,
  { apply, log = console.log }: { apply: boolean; log?: (line: string) => void },
): Promise<DisplayOrderReport> {
  const report: DisplayOrderReport = { scanned: 0, fixed: [], current: 0, edited: [] };
  const candidates = await db
    .select({ id: plots.id })
    .from(plots)
    .where(isNotNull(plots.customUi))
    .orderBy(asc(plots.createdAt), asc(plots.id));

  for (const { id } of candidates) {
    await db.transaction(async (tx) => {
      const read = tx
        .select({ id: plots.id, name: plots.name, customUi: plots.customUi })
        .from(plots)
        .where(eq(plots.id, id));
      const [plot] = apply ? await read.for('update') : await read;
      const stored = plot?.customUi?.displayScripts;
      if (!plot || !stored?.length) return;
      report.scanned += 1;

      const members = await tx
        .select({ id: characters.id, card: characters.card })
        .from(characters)
        .where(eq(characters.plotId, id))
        .orderBy(asc(characters.orderIndex));
      const verdict = judgeDisplayOrder(
        stored,
        members.map((member) => member.card.extensions ?? {}),
        members.map((member) => member.id),
      );
      const label = `plot ${plot.id} ${JSON.stringify(plot.name)}`;

      if (verdict.kind === 'current') report.current += 1;
      else if (verdict.kind === 'edited') {
        report.edited.push(plot.id);
        log(`left  ${label}: its display scripts are neither the old import's nor today's — the creator's own`);
      } else if (verdict.kind === 'fix') {
        report.fixed.push(plot.id);
        log(`${apply ? 'fixed' : 'would fix'} ${label}`);
        log(`  was: ${runOrder(stored)}`);
        log(`  now: ${runOrder(verdict.scripts)}`);
        if (apply) {
          await tx
            .update(plots)
            .set({ customUi: { ...plot.customUi, displayScripts: verdict.scripts } })
            .where(eq(plots.id, plot.id));
        }
      }
    });
  }

  log(
    `${report.scanned} plots with display scripts: ${report.fixed.length} ${apply ? 'fixed' : 'to fix'}, ` +
      `${report.current} already current, ${report.edited.length} edited by their creators and left alone.`,
  );
  return report;
}
