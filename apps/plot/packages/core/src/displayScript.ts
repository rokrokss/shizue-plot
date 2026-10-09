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
 * The rule is deliberately blunt: **an unbounded quantifier may not be applied to
 * a group whose body contains another unbounded quantifier or an alternation.**
 * Ambiguity is what makes backtracking explode, and both of those introduce it —
 * `(a|aa)+` is as bad as `(a+)+` and looks nothing like it, so no test for
 * "the branches are the same" would have caught it.
 *
 * That rejects safe patterns too. `(foo|bar)+` is linear and is refused anyway,
 * because deciding which alternations are ambiguous is the analysis this screen
 * exists to avoid. Creators write `[ab]+` rather than `(a|b)+`, and literals,
 * character classes and bounded quantifiers under a quantifier all stay legal, so
 * the patterns status windows are actually made of are unaffected.
 *
 * It remains a syntactic bound and not a completeness proof: it says a pattern has
 * none of these shapes, never that a pattern is safe. Nothing here looks at a
 * pattern with no groups in it at all, and `a+a+a+a+a+a+a+a+a+a+b` is exponential
 * without a single parenthesis; a bounded quantifier over an alternation,
 * `(a|aa){1,20}`, is exponential and is deliberately allowed. Deciding the general
 * case is regular-expression ambiguity analysis, which is why the guarantee lives
 * in the runtime instead — see `apps/web/src/lib/displayPlanner.ts`.
 *
 * Dependency-free, so the web editor can import it (`@shizue/core/display-script`)
 * without pulling the tokenizer and the card parser into the bundle.
 */

/** Longest pattern a display script may carry. */
export const MAX_DISPLAY_PATTERN_LENGTH = 500;

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

/**
 * Screens a pattern. Returns null when it may be stored, or the reason it may not.
 *
 * Rejected: anything the regex engine will not compile, anything over the length
 * cap, and any unboundedly quantified group whose body repeats unboundedly itself
 * (`(a+)+`, `(x*)*`, `(a+)*`) or offers the engine a choice (`(a|aa)+`, `(a|b)*`,
 * `(\s|\s\s)+`). See the module comment for why the second half is this blunt.
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
    if (UNBOUNDED_QUANTIFIER.test(structure) || structure.includes('|')) {
      return 'unsafe_repetition';
    }
  }
  return null;
}
