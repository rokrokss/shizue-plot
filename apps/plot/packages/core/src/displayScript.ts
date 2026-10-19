/**
 * Authoring-time screening of a display script's pattern.
 *
 * A display script's regex is creator-authored and runs against every message in
 * every reader's chat. A catastrophically backtracking pattern (`^(a+)+$` against a
 * long non-matching line) takes minutes to return, so it is worth telling a creator
 * about the shapes that do it while they are still writing one.
 *
 * **This is a lint, not a boundary.** It is not what makes a pattern survivable —
 * the web client runs the matching in a worker it terminates (`lib/displayPlanner`)
 * and that is the guarantee. The screen exists so that the common mistake is caught
 * where it can be explained, rather than showing up later as somebody's status
 * window quietly refusing to render.
 *
 * The rule: **an unboundedly repeated group may hold another unbounded repeat or
 * a `|` choice only in the two shapes that cannot be split two ways.** Ambiguity
 * is what makes backtracking explode — `(a+)+` can cut a run of a's into
 * iterations in exponentially many ways, and `(a|aa)+` can too while looking
 * nothing like it — so a group is refused when its body could match one stretch
 * of text as more than one sequence of iterations, unless it is one of:
 *
 * - **a delimited run**: a flat sequence (no nested group, no choice) in which
 *   every unbounded atom is followed at once by a single literal character the
 *   atom cannot match. `(?:⟦[^⟧]*⟧)+` and `(?:[ \t]*\n)+` are this — the run
 *   has to stop at the first `⟧` or newline, so where each iteration ends is
 *   forced. Cards write their status lines this way, and the earlier rule, which
 *   refused every repeat inside a repeat, disabled 8 of one popular card's 65
 *   display scripts for it.
 * - **a choice of plain words** none of which starts another
 *   (`(?:<br>|</div><div>)*`, `(cat|dog)+`): at each point at most one of them
 *   can match.
 *
 * Whether an atom can match the character after it is asked of the engine
 * itself, with `i` and `s` on — the screen never sees the script's flags, so
 * `.` is taken to match a newline and a letter its other case.
 *
 * It remains a syntactic bound and not a completeness proof: it says a pattern has
 * none of the refused shapes, never that a pattern is safe. Nothing here looks at
 * a pattern with no groups in it at all, and `a+a+a+a+a+a+a+a+a+a+b` is
 * exponential without a single parenthesis; a bounded quantifier over an
 * alternation, `(a|aa){1,20}`, is exponential and is deliberately allowed.
 * Deciding the general case is regular-expression ambiguity analysis, which is why
 * the guarantee lives in the runtime instead — see `apps/web/src/lib/displayPlanner.ts`.
 *
 * Dependency-free, so the web editor can import it (`@shizue/core/display-script`)
 * without pulling the tokenizer and the card parser into the bundle.
 */

import type { DisplayScript, DisplaySide } from './types.js';

/**
 * Longest pattern a display script may carry. RisuAI sets none, and a card that
 * names each of its images in one alternation runs to thousands of characters;
 * what could hang a reader is the repetition refused below, not the length.
 */
export const MAX_DISPLAY_PATTERN_LENGTH = 10_000;

/** Why a pattern was rejected. Stable codes — the UI maps them to a message. */
export type PatternRejection = 'too_long' | 'invalid' | 'unsafe_repetition';

/** `*`, `+`, or an open-ended `{n,}` — the quantifiers that admit unbounded repetition. */
const UNBOUNDED_QUANTIFIER = /[*+]|\{\d*,\}/;

/**
 * Blanks out escaped characters and the insides of character classes, so that the
 * `+` in `(a\+)+` and in `([+*])+` is read as the literal it is rather than as a
 * quantifier. Length is preserved to keep the text readable while debugging.
 */
function stripLiterals(source: string): string {
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

interface Group {
  /** Body between the parentheses, decorations (`?:`, `?<name>`, …) removed. */
  body: string;
  /** The quantifier that follows the closing paren, if any. */
  quantifier: string;
}

/**
 * Splits out every parenthesised group with the quantifier that follows it.
 * Escapes and character classes are skipped, so `\(` and `[(]` are not groups.
 */
function groupsOf(source: string): Group[] {
  const groups: Group[] = [];
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
    // Strip the group's own decoration so `(?:a+)` reads like `(a+)`.
    const body = source.slice(start + 1, i).replace(/^\?(?::|<?[=!]|<[A-Za-z_$][\w$]*>)/, '');
    const rest = source.slice(i + 1);
    const quantifier = /^(?:[*+?]|\{\d*(?:,\d*)?\})/.exec(rest)?.[0] ?? '';
    groups.push({ body, quantifier });
  }
  return groups;
}

/** `*`, `+` and `{n,}` as they appear *after* a group's closing paren. */
const isUnbounded = (quantifier: string): boolean =>
  quantifier === '*' || quantifier === '+' || /^\{\d*,\}$/.test(quantifier);

/** One atom of a flat sequence, with the quantifier written after it. */
interface Atom {
  /** As written, to be compiled on its own; null for an assertion or a backreference. */
  source: string | null;
  /** The one character it matches, when it is a literal. */
  literal: string | null;
  quantifier: string;
}

/** A quantifier after an atom: `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, each maybe lazy. */
const ATOM_QUANTIFIER = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/;

/** The control escapes, as the characters they stand for. */
const CONTROL_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' };

/**
 * Reads one atom at `at`: its text, and its literal character when it has one.
 * Null at a group or a `|` — the body is not a flat sequence. Never called past
 * a pattern that failed to compile, so a quantifier is never where an atom is.
 */
function atomAt(body: string, at: number): { end: number; source: string | null; literal: string | null } | null {
  const char = body[at]!;
  if (char === '(' || char === ')' || char === '|') return null;
  if (char === '^' || char === '$') return { end: at + 1, source: null, literal: null };
  if (char === '.') return { end: at + 1, source: '.', literal: null };
  if (char === '[') {
    let end = at + 1;
    while (end < body.length && body[end] !== ']') end += body[end] === '\\' ? 2 : 1;
    return { end: end + 1, source: body.slice(at, end + 1), literal: null };
  }
  if (char !== '\\') return { end: at + 1, source: char, literal: char };

  const next = body[at + 1] ?? '';
  const escape = (length: number, literal: string | null): { end: number; source: string; literal: string | null } => ({
    end: at + length,
    source: body.slice(at, at + length),
    literal,
  });
  if (/[dDwWsS]/.test(next)) return escape(2, null);
  if (CONTROL_ESCAPES[next] !== undefined) return escape(2, CONTROL_ESCAPES[next]!);
  const hex = /^x([0-9a-fA-F]{2})|^u([0-9a-fA-F]{4})/.exec(body.slice(at + 1));
  if (hex) return escape(1 + hex[0].length, String.fromCharCode(Number.parseInt(hex[1] ?? hex[2]!, 16)));
  const control = /^c([A-Za-z])/.exec(body.slice(at + 1));
  if (control) return escape(3, String.fromCharCode(control[1]!.charCodeAt(0) % 32));
  if (next === '0' && !/\d/.test(body[at + 2] ?? '')) return escape(2, '\0');
  // A backreference, `\b`, and every other letter or digit: nothing this reads as one character.
  if (/[0-9A-Za-z]/.test(next)) return { end: at + 2, source: null, literal: null };
  return escape(2, next);
}

/** The body as atoms, or null when it is not a flat sequence (a group, a `|`). */
function atomsOf(body: string): Atom[] | null {
  const atoms: Atom[] = [];
  let at = 0;
  while (at < body.length) {
    const atom = atomAt(body, at);
    if (!atom) return null;
    const quantifier = ATOM_QUANTIFIER.exec(body.slice(atom.end))?.[0] ?? '';
    atoms.push({ source: atom.source, literal: atom.literal, quantifier });
    at = atom.end + quantifier.length;
  }
  return atoms;
}

/** Whether `atom` could match `char`, read as broadly as any flags would read it. */
function mayMatch(atom: string, char: string): boolean {
  try {
    return new RegExp(`^(?:${atom})$`, 'is').test(char);
  } catch {
    return true;
  }
}

/**
 * A delimited run: a flat sequence whose every unbounded atom is followed at
 * once by a literal character it cannot match, so each run, and with it each
 * iteration of the group, has only one place it can end.
 */
function isDelimitedRun(body: string): boolean {
  const atoms = atomsOf(body);
  if (!atoms) return false;
  return atoms.every((atom, index) => {
    if (!UNBOUNDED_QUANTIFIER.test(atom.quantifier)) return true;
    const next = atoms[index + 1];
    return (
      atom.source !== null &&
      next !== undefined &&
      next.literal !== null &&
      next.quantifier === '' &&
      !mayMatch(atom.source, next.literal)
    );
  });
}

/** A choice of plain words, none empty and none the start of another (case aside). */
function isWordChoice(body: string): boolean {
  const words: string[] = [];
  let branch = '';
  // Split at the `|`s outside classes and escapes, which `stripLiterals` keeps.
  const structure = stripLiterals(body);
  for (let i = 0; i <= body.length; i += 1) {
    if (i < body.length && structure[i] !== '|') {
      branch += body[i];
      continue;
    }
    const atoms = atomsOf(branch);
    if (!atoms || atoms.length === 0) return false;
    if (atoms.some((atom) => atom.literal === null || atom.quantifier !== '')) return false;
    words.push(atoms.map((atom) => atom.literal).join('').toLowerCase());
    branch = '';
  }
  return words.every((word, i) => words.every((other, j) => i === j || !other.startsWith(word)));
}

/**
 * Screens a pattern. Returns null when it may be stored, or the reason it may not.
 *
 * Rejected: anything the regex engine will not compile, anything over the length
 * cap, and any unboundedly quantified group whose body repeats unboundedly itself
 * (`(a+)+`, `(x*)*`, `([a-z]+\s*)+`, `(?:a*ba*)+`) or offers the engine a choice
 * (`(a|aa)+`, `(\s|\s\s)+`) — unless the body is one of the two shapes the
 * module comment names, `(?:⟦[^⟧]*⟧)+` and `(cat|dog)+`.
 */
export function displayScriptPatternError(source: string): PatternRejection | null {
  if (source.length > MAX_DISPLAY_PATTERN_LENGTH) return 'too_long';
  try {
    new RegExp(source);
  } catch {
    return 'invalid';
  }

  for (const { body, quantifier } of groupsOf(source)) {
    if (!isUnbounded(quantifier)) continue;
    // Escapes and classes blanked first, so the `+` in `(a\+)+` and the `|` in
    // `([a|b])+` are the literals they are rather than structure.
    const structure = stripLiterals(body);
    if (!UNBOUNDED_QUANTIFIER.test(structure) && !structure.includes('|')) continue;
    if (isDelimitedRun(body) || isWordChoice(body)) continue;
    return 'unsafe_repetition';
  }
  return null;
}

/**
 * The deepest bound a display script's range may name: past the length of any
 * chat (an import holds 20,000 messages), so the cap never changes what runs.
 */
export const MAX_DISPLAY_DEPTH = 100_000;

/**
 * One depth bound as SillyTavern reads one — a number, or the numeric string an
 * old export left — rounded inward to whole messages and capped. Undefined where
 * ST sets no limit on a message on screen: no value, not a number, or below 0
 * (a min of -1 only reaches a prompt's continue, and ST ignores a negative max).
 */
function displayDepthBound(value: unknown, round: (value: number) => number): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.min(MAX_DISPLAY_DEPTH, round(number));
}

/**
 * A display script's range (`DisplayScript.minDepth`/`maxDepth`), each bound
 * only where it limits something. A min above the max is kept as written: ST
 * runs such a script on no message, and so does this.
 */
export function coerceDisplayDepth(raw: {
  minDepth?: unknown;
  maxDepth?: unknown;
}): Pick<DisplayScript, 'minDepth' | 'maxDepth'> {
  const minDepth = displayDepthBound(raw.minDepth, Math.ceil);
  const maxDepth = displayDepthBound(raw.maxDepth, Math.floor);
  return {
    ...(minDepth !== undefined ? { minDepth } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  };
}

const DISPLAY_SIDES: readonly DisplaySide[] = ['user', 'assistant', 'narration'];

/**
 * A set of sides as `DisplayScript.role` keeps it: one side as itself, two as
 * a list in a fixed order, all three (or none named) as nothing — every message.
 */
export function displayRoleOf(sides: Iterable<DisplaySide>): Pick<DisplayScript, 'role'> {
  const kept = DISPLAY_SIDES.filter((side) => new Set(sides).has(side));
  if (kept.length === 0 || kept.length === DISPLAY_SIDES.length) return {};
  return { role: kept.length === 1 ? kept[0]! : kept };
}

/** The sides a script's role names, every one for none. */
export function displaySidesOf(script: Pick<DisplayScript, 'role'>): DisplaySide[] {
  if (script.role === undefined) return [...DISPLAY_SIDES];
  return Array.isArray(script.role) ? [...script.role] : [script.role];
}

/** A display script's role (`DisplayScript.role`), where it names sides it keeps to; nothing otherwise. */
export function coerceDisplayRole(raw: { role?: unknown }): Pick<DisplayScript, 'role'> {
  const named = Array.isArray(raw.role) ? raw.role : [raw.role];
  const sides = named.filter((side): side is DisplaySide => DISPLAY_SIDES.includes(side as DisplaySide));
  return sides.length === named.length ? displayRoleOf(sides) : {};
}

/**
 * Whether a script runs on a message of `side` — SillyTavern's placement, which
 * `messageFormatting` asks as `USER_INPUT` for the reader's message,
 * `SLASH_COMMAND` for the narrator's and `AI_OUTPUT` for every other. A script
 * with no role runs on every one.
 */
export function inDisplayRole(script: Pick<DisplayScript, 'role'>, side: DisplaySide): boolean {
  if (script.role === undefined) return true;
  return Array.isArray(script.role) ? script.role.includes(side) : script.role === side;
}

/**
 * Whether a script runs on a message `depth` deep — SillyTavern's
 * `getRegexedString`: both bounds inclusive. Undefined depth is ST's hidden
 * message, which it numbers no depth and so holds to no range.
 */
export function inDisplayDepth(
  script: Pick<DisplayScript, 'minDepth' | 'maxDepth'>,
  depth: number | undefined,
): boolean {
  if (depth === undefined) return true;
  if (script.minDepth !== undefined && depth < script.minDepth) return false;
  return script.maxDepth === undefined || depth <= script.maxDepth;
}

/**
 * The scripts that dress a message `memberId` is the speaker of, in a work of
 * several members: every untagged script, and the ones tagged with that member
 * (`DisplayScript.memberId`, the card a script came with). A tagged script is
 * skipped only on another member's messages. The same list is what a member's
 * card export carries out, the untagged scripts being the work's own.
 */
export function displayScriptsFor<T extends Pick<DisplayScript, 'memberId'>>(
  scripts: readonly T[],
  memberId: string,
): T[] {
  return scripts.filter((script) => script.memberId === undefined || script.memberId === memberId);
}

/**
 * A work's display scripts with its modules' after them, as RisuAI runs a
 * character's regex scripts with its modules' (`processScriptFull`): one list —
 * the chat's prompt preset's first (`preset`, RisuAI's `presetRegex`), then the
 * character's (`own`), then each module's, each by its own `order` — and, once
 * any script on it carries RisuAI's `<order N>` (`rank`), the whole list sorted
 * by that number, highest first, stably, a script without one counting as 0.
 * Renumbered 0, 1, 2… in the sequence it runs, so the renderer's ascending
 * `order` runs it so. Applying it again with more modules gives what one pass
 * over all of them gives, the sort being stable.
 */
export function orderedWithModules<T extends Pick<DisplayScript, 'order' | 'rank'>>(
  own: readonly T[],
  modules: readonly (readonly T[])[],
  preset: readonly T[] = [],
): T[] {
  const byOrder = (list: readonly T[]): T[] => [...list].sort((a, b) => a.order - b.order);
  const list = [...byOrder(preset), ...byOrder(own), ...modules.flatMap(byOrder)];
  if (list.some((script) => script.rank !== undefined)) {
    list.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  }
  return list.map((script, order) => ({ ...script, order }));
}
