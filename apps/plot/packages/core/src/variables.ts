/**
 * Path-derived chat variables.
 *
 * There is no storage column: the value of a variable is whatever you get by
 * replaying the `{{setvar}}` / `{{addvar}}` macros — and SillyTavern's
 * `{{incvar}}` / `{{decvar}}` — of the messages on the current branch, oldest
 * first. Because the message tree is append-only, a swipe or a fork automatically
 * yields that branch's state — the same guarantee a per-node state column would
 * give, at zero storage cost.
 *
 * Deliberately dependency-free so the web client can import it (`@shizue/core/variables`)
 * without pulling the tokenizer and the card parser into the bundle.
 *
 * Every map here has a null prototype, and every read goes through
 * `readVariable`. Variable names come from model output and from cards written by
 * strangers, so `toString`, `valueOf`, `hasOwnProperty`, `constructor` and
 * `__proto__` are names that arrive in practice — and on an ordinary object each
 * one either resolves to a function the fold then tries to trim, or (for
 * `__proto__`) is silently swallowed on assignment.
 */

/** Chat variables by name. Values are always strings; `addvar` does the math. */
export type Variables = Record<string, string>;

/**
 * A variables map that inherits nothing, so `{{setvar::toString::x}}` stores a
 * variable instead of shadowing a method — and `{{addvar::__proto__::1}}` stores
 * one instead of being dropped on the floor.
 */
export const emptyVariables = (): Variables => Object.create(null) as Variables;

/** Own-property read, for a map that might not have come from here. */
export const readVariable = (variables: Variables, key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : undefined;

/** Copies own string entries into a fresh null-prototype map. */
function adopt(source: Record<string, string>): Variables {
  const variables = emptyVariables();
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value === 'string') variables[key] = value;
  }
  return variables;
}

/**
 * `{{setvar::key::value}}` / `{{addvar::key::delta}}`, and `{{incvar::key}}` /
 * `{{decvar::key}}`. The key may not contain a colon or a brace; the value runs to
 * the closing braces, so it may contain `::`. One pattern, so a message's macros
 * fold in the order they were written.
 */
const VAR_MACRO_RE = /\{\{\s*(?:(setvar|addvar)\s*::([^:{}]*)::([^{}]*)|(incvar|decvar)\s*::([^:{}]*))\}\}/gi;

/** `{{getvar::key}}`. Resolved wherever macros are expanded. */
const GETVAR_RE = /\{\{\s*getvar\s*::([^{}]*)\}\}/gi;

/**
 * Formats an `addvar` result. Floating point noise (0.1 + 0.2) would otherwise
 * end up in the prompt, and an integer must stay an integer.
 */
const formatNumber = (value: number): string => String(Number(value.toFixed(6)));

/** Missing or non-numeric values count as 0, so `addvar` works without a default. */
const toNumber = (value: string | undefined): number => {
  const parsed = Number((value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Folds the macros of `texts` (branch messages, oldest first) over `defaults`.
 * Malformed macros — an empty key, a non-numeric `addvar` delta — are skipped
 * rather than throwing, so a model typo can never break a chat.
 *
 * `incvar`/`decvar` are `addvar` by 1 and -1, which is how ST defines them — so a
 * value that is not a number counts as 0 here too, where ST's `addvar` would
 * append the digit to the text instead.
 */
export function computeVariables(texts: readonly string[], defaults: Variables = {}): Variables {
  // Copied rather than spread: a card's defaultVariables comes back from jsonb as
  // an ordinary object, and spreading it would hand the result a prototype again.
  const variables = adopt(defaults);
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(VAR_MACRO_RE)) {
      const op = (match[1] ?? match[4]!).toLowerCase();
      const key = (match[2] ?? match[5]!).trim();
      if (!key) continue;
      if (op === 'setvar') {
        variables[key] = match[3]!;
        continue;
      }
      const delta = op === 'incvar' ? 1 : op === 'decvar' ? -1 : Number(match[3]!.trim());
      if (!Number.isFinite(delta)) continue;
      variables[key] = formatNumber(toNumber(readVariable(variables, key)) + delta);
    }
  }
  return variables;
}

/**
 * Drops every `{{setvar}}` / `{{addvar}}` / `{{incvar}}` / `{{decvar}}` macro
 * (ST shows the new value where an `incvar` stood; here it is protocol like the
 * rest). Display only — the macros stay in the stored message and in the prompt
 * history, so the model keeps observing its own protocol and keeps emitting it.
 */
export function stripVariableMacros(text: string): string {
  return text.replace(VAR_MACRO_RE, '');
}

/** Resolves `{{getvar::key}}`. An unset key reads as the empty string. */
export function resolveGetVars(text: string, variables: Variables): string {
  return text.replace(GETVAR_RE, (_match, key: string) => readVariable(variables, key.trim()) ?? '');
}

/**
 * Parses RisuAI's `defaultVariables`, which is a newline-separated `key=value`
 * block. An object is accepted too, because that is what our own editor stores.
 */
export function parseDefaultVariables(value: unknown): Variables | undefined {
  if (typeof value === 'string') {
    const variables = emptyVariables();
    for (const line of value.split('\n')) {
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      if (key) variables[key] = line.slice(separator + 1).trim();
    }
    return Object.keys(variables).length > 0 ? variables : undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const variables = emptyVariables();
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && key.trim()) variables[key.trim()] = entry;
  }
  return Object.keys(variables).length > 0 ? variables : undefined;
}

/** Serializes back into RisuAI's `key=value` block, for card export. */
export function serializeDefaultVariables(variables: Variables): string {
  return Object.entries(variables)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}
