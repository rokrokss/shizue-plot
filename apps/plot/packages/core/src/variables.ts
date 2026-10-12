/**
 * Path-derived chat variables.
 *
 * The value of a variable is whatever you get by replaying the `{{setvar}}` /
 * `{{addvar}}` macros — and SillyTavern's `{{incvar}}` / `{{decvar}}` — of the
 * messages on the current branch, oldest first. Because the message tree is
 * append-only, a swipe or a fork automatically yields that branch's state.
 *
 * The one thing stored is what a card's scripts did, which no replay can redo:
 * a trigger or a Lua function runs in the reader's browser, once, and may roll a
 * die or read the reader's answer to a prompt. Its result is kept on the message
 * it ran for as that message's `variableDelta` — the values the scripts left,
 * not the operations that produced them — and laid over the message's own
 * macros. So the rule for any message is: its parent's state, then its own
 * macros, then its delta on top. A delta lives on its node like everything else
 * here, so a sibling that never carried it never sees it.
 *
 * Deliberately free of everything but the CBS evaluator (`cbs.ts`, itself
 * dependency-free), so the web client can import it (`@shizue/core/variables`)
 * without pulling the tokenizer and the card parser into the bundle.
 *
 * Every map here has a null prototype, and every read goes through
 * `readVariable`. Variable names come from model output and from cards written by
 * strangers, so `toString`, `valueOf`, `hasOwnProperty`, `constructor` and
 * `__proto__` are names that arrive in practice — and on an ordinary object each
 * one either resolves to a function the fold then tries to trim, or (for
 * `__proto__`) is silently swallowed on assignment.
 */

import { evaluateCbs, parseCbs, type CbsCall, type CbsHost, type CbsMacro, type CbsNode } from './cbs.js';

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
 * What a card's scripts left on one message: the final value of every variable
 * they changed, with `null` for one they unset. Absolute rather than a list of
 * operations, so laying it over the message a second time changes nothing, and
 * it is right whatever order RisuAI ran the scripts and the macros in — the
 * browser computes it as the difference between where the scripts ended and
 * where the message's macros alone would have ended (`diffVariables`).
 */
export type VariableDelta = Record<string, string | null>;

/**
 * One message of a branch as the fold reads it: its text, and the delta its
 * scripts left, if any. A bare string is a message without one — text still being
 * typed or streamed, which no script has run on yet.
 */
export type FoldItem = string | { readonly content: string; readonly variableDelta?: VariableDelta | null };

/**
 * The limits a stored delta is held to — the API refuses one past them, and the
 * browser that computes one checks the same numbers first. A value may be as
 * long as anything the fold itself lets grow (`MAX_FOLD_CHARS`); a delta is
 * capped in keys and in total size, since it is read back on every fold of the
 * branch. A name the length of a sentence is not a variable anyone reads.
 */
export const MAX_DELTA_KEYS = 512;
export const MAX_VARIABLE_NAME_LENGTH = 256;
export const MAX_DELTA_CHARS = 1_000_000;

/** Lays `delta` over `variables` in place: a string sets, `null` unsets. */
function layDelta(variables: Variables, delta: VariableDelta | null | undefined): void {
  if (!delta) return;
  // Own keys only: a delta arrives as parsed JSON, where `__proto__` is an own
  // key like any other, and the target has no prototype to be confused by it.
  for (const key of Object.keys(delta)) {
    const value = delta[key];
    if (value === null) delete variables[key];
    else if (typeof value === 'string') variables[key] = value;
  }
}

/** `variables` with `delta` laid over it, as a fresh map; neither input is touched. */
export function applyVariableDelta(variables: Variables, delta: VariableDelta | null | undefined): Variables {
  const next = adopt(variables);
  layDelta(next, delta);
  return next;
}

/**
 * The delta that takes `base` to `target`: every key whose value differs, and
 * `null` for every key `target` dropped. Null when they are the same map, so a
 * message whose scripts changed nothing stores nothing.
 *
 * `applyVariableDelta(base, diffVariables(target, base))` is `target` — which is
 * why the browser computes a message's delta with this, against the fold of the
 * message's own macros (`computeVariables([content], parentState)`), and not by
 * recording what the scripts did step by step.
 */
export function diffVariables(target: Variables, base: Variables): VariableDelta | null {
  const delta: VariableDelta = Object.create(null) as VariableDelta;
  let changed = false;
  for (const key of Object.keys(target)) {
    const value = readVariable(target, key);
    if (value !== undefined && value !== readVariable(base, key)) {
      delta[key] = value;
      changed = true;
    }
  }
  for (const key of Object.keys(base)) {
    if (readVariable(target, key) === undefined) {
      delta[key] = null;
      changed = true;
    }
  }
  return changed ? delta : null;
}

/**
 * `{{setvar::key::value}}` / `{{addvar::key::delta}}`, and `{{incvar::key}}` /
 * `{{decvar::key}}`, as the CBS evaluator reads a call: the name without case,
 * spaces, `_` or `-`, and arguments split where the author wrote separators. The
 * value runs to the closing braces, so it may contain `::`. A call with any other
 * number of arguments is not one of them, and is left as written — by the fold
 * and by `stripVariableMacros` alike.
 */
type VariableOp = 'setvar' | 'addvar' | 'incvar' | 'decvar';

function variableOp({ name, args }: CbsCall): VariableOp | null {
  if (name === 'setvar' || name === 'addvar') return args.length >= 2 ? name : null;
  if (name === 'incvar' || name === 'decvar') return args.length === 1 ? name : null;
  return null;
}

/**
 * Whether `text` could hold one of them at all: braces, and a name that ends in
 * `var` — with the spaces, `_` and `-` the evaluator ignores allowed in between.
 * A message that fails it is never parsed.
 */
const mayHoldVariableMacro = (text: string): boolean => text.includes('{{') && /v[\s_-]*a[\s_-]*r/i.test(text);

/**
 * What any one string built while folding a message may grow to. A value is no
 * longer bounded by the message that sets it — `{{setvar::x::{{getvar::x}}{{getvar::x}}}}`
 * doubles `x` every turn — and the fold reruns over the whole branch on every
 * request, so this is what keeps a few turns of that from taking the chat, and
 * the server, down with them. The scale of the screen's own budgets.
 */
const MAX_FOLD_CHARS = 100_000;

/** The longest value a delta may carry: no longer than the fold could have grown it. */
export const MAX_VARIABLE_VALUE_LENGTH = MAX_FOLD_CHARS;

/** How many names, and how many characters in all, a checked map may hold. */
export interface DeltaLimits {
  keys: number;
  chars: number;
}

export type DeltaCheck = { ok: true; delta: VariableDelta | null } | { ok: false; error: string };

/**
 * Reads a delta that arrived from outside — a request body, a script's result —
 * into a null-prototype map, or says why it is not one. Every name is a
 * non-empty string within `MAX_VARIABLE_NAME_LENGTH`, every value a string
 * within `MAX_VARIABLE_VALUE_LENGTH` or `null`, and the whole within `limits`.
 * U+0000 is refused anywhere in it: Postgres cannot store it in a jsonb string,
 * so it would otherwise surface as a failed write rather than as a bad request.
 * An empty object is no delta at all, and so is `null`.
 */
export function checkVariableDelta(
  value: unknown,
  limits: DeltaLimits = { keys: MAX_DELTA_KEYS, chars: MAX_DELTA_CHARS },
): DeltaCheck {
  if (value === null || value === undefined) return { ok: true, delta: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'must be an object of strings and nulls' };
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length > limits.keys) return { ok: false, error: `may hold at most ${limits.keys} variables` };
  const delta: VariableDelta = Object.create(null) as VariableDelta;
  let chars = 0;
  for (const key of keys) {
    if (!key || key.length > MAX_VARIABLE_NAME_LENGTH) {
      return { ok: false, error: `variable names must be 1 to ${MAX_VARIABLE_NAME_LENGTH} characters` };
    }
    const entry = source[key];
    if (entry !== null && typeof entry !== 'string') {
      return { ok: false, error: 'values must be strings or null' };
    }
    if (entry !== null && entry.length > MAX_VARIABLE_VALUE_LENGTH) {
      return { ok: false, error: `values may be at most ${MAX_VARIABLE_VALUE_LENGTH} characters` };
    }
    if (key.includes('\u0000') || entry?.includes('\u0000')) {
      return { ok: false, error: 'must not contain U+0000' };
    }
    chars += key.length + (entry?.length ?? 0);
    if (chars > limits.chars) return { ok: false, error: `may hold at most ${limits.chars} characters in all` };
    delta[key] = entry;
  }
  return { ok: true, delta: keys.length > 0 ? delta : null };
}

/** Thrown by the fold's `grow`, and caught a message at a time. */
class FoldBudgetExhausted extends Error {}

/** 32-bit FNV-1a — `fnv1a` in `macro.ts`, which imports this module and so is not imported back. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/**
 * [0, 1) for a `{{random}}`, `{{pick}}` or `{{roll}}` in a value. RisuAI rolls
 * once and stores the message with the result in it; here nothing is stored, and
 * the fold reruns on every request and in the reader's browser, which have to
 * agree. So a message rolls the same on every replay: the rolls are seeded by
 * its own text, and two messages that say exactly the same thing roll alike.
 */
function replayableRandom(text: string): () => number {
  const seed = hash(text);
  let calls = 0;
  return () => hash(`${seed}\u0000${(calls += 1)}`) / 0x1_0000_0000;
}

/**
 * Folds one message into `variables`, in place, by running it through the CBS
 * evaluator with a host whose only macros are these four — RisuAI's `runVar`.
 * Whatever is nested in a key or a value is evaluated first, against the
 * variables as they stand at that point of the branch, so
 * `{{setvar::hp::{{calc::{{getvar::hp}}-3}}}}` takes three off; and a macro in
 * a branch of `{{#if}}`, `{{#when}}` or `{{if}}` that is not taken does not run.
 * A nested macro nothing here answers (`{{user}}`, `{{img::…}}`) stays in the
 * value as written, as it does under RisuAI's `runVar`.
 */
function foldMessage(text: string, variables: Variables): void {
  const host: CbsHost = {
    variable: (name) => readVariable(variables, name),
    random: replayableRandom(text),
    grow: (length) => {
      if (length > MAX_FOLD_CHARS) throw new FoldBudgetExhausted();
    },
    macro: (call) => {
      const op = variableOp(call);
      if (!op) return undefined;
      const key = call.args.at(1)!.value().text.trim();
      if (op === 'setvar') {
        const value = call.args.rest(2)!.value().text;
        if (key) variables[key] = value;
        return { text: '' };
      }
      const delta =
        op === 'incvar' ? 1 : op === 'decvar' ? -1 : Number(call.args.rest(2)!.value().text.trim());
      if (key && Number.isFinite(delta)) {
        variables[key] = formatNumber(toNumber(readVariable(variables, key)) + delta);
      }
      return { text: '' };
    },
  };
  // Only what the macros do counts, not what the message reads as, so the prose
  // between them is left out of the evaluation — and out of the budget.
  const nodes = parseCbs(text).filter((node) => node.type !== 'text');
  try {
    evaluateCbs(text, nodes, host);
  } catch (error) {
    // What folded before the budget ran out stays folded, and the rest of the
    // message does not run — the same way on every replay.
    if (!(error instanceof FoldBudgetExhausted)) throw error;
  }
}

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
 * Folds the branch `items` (messages, oldest first) over `defaults`: each
 * message's macros in the order they were written (`foldMessage`), then the delta
 * its scripts left on top (`VariableDelta`). Malformed macros — an empty key, a
 * non-numeric `addvar` delta — are skipped rather than throwing, so a model typo
 * can never break a chat.
 *
 * Every fold of a branch goes through here — the prompt's, the chat state's, the
 * export's and the reader's own screen — so passing the message rows themselves,
 * rather than their text, is what keeps a delta from being seen by one and not
 * the others.
 *
 * `incvar`/`decvar` are `addvar` by 1 and -1, which is how ST defines them — so a
 * value that is not a number counts as 0 here too, where ST's `addvar` would
 * append the digit to the text instead.
 */
export function computeVariables(items: readonly FoldItem[], defaults: Variables = {}): Variables {
  // Copied rather than spread: a card's defaultVariables comes back from jsonb as
  // an ordinary object, and spreading it would hand the result a prototype again.
  const variables = adopt(defaults);
  for (const item of items) {
    const text = typeof item === 'string' ? item : item.content;
    if (text && mayHoldVariableMacro(text)) foldMessage(text, variables);
    if (typeof item !== 'string') layDelta(variables, item.variableDelta);
  }
  return variables;
}

/**
 * Whether the evaluator reads `node` as one of the four. Asked of the evaluator
 * rather than parsed again here, so this and the fold cannot drift apart; a host
 * that answers every call stops it there, before it reads an argument.
 */
function isVariableMacro(source: string, node: CbsMacro): boolean {
  let found = false;
  evaluateCbs(source, [node], {
    macro: (call) => {
      found = variableOp(call) !== null;
      return { text: '' };
    },
  });
  return found;
}

/**
 * Drops every `{{setvar}}` / `{{addvar}}` / `{{incvar}}` / `{{decvar}}` macro,
 * whatever is nested in it (ST shows the new value where an `incvar` stood; here
 * it is protocol like the rest). Display only — the macros stay in the stored
 * message and in the prompt history, so the model keeps observing its own
 * protocol and keeps emitting it.
 *
 * In every branch of a block, taken or not: there are no variables here to say
 * which one the fold took, and one it skipped is protocol all the same. The
 * blocks themselves, and everything around the macros, are left as written.
 */
export function stripVariableMacros(text: string): string {
  if (!mayHoldVariableMacro(text)) return text;
  let out = '';
  let cursor = 0;
  // Parsed nodes come in the order they were written, and a macro that is cut is
  // not looked into, so the cuts never overlap.
  const walk = (nodes: readonly CbsNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'text') continue;
      if (node.type === 'block') {
        walk(node.head);
        walk(node.body);
        if (node.otherwise) walk(node.otherwise);
      } else if (isVariableMacro(text, node)) {
        out += text.slice(cursor, node.start);
        cursor = node.end;
      } else {
        walk(node.body);
      }
    }
  };
  walk(parseCbs(text));
  return out + text.slice(cursor);
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
