/**
 * The CBS subset a display script's OUT template is written in.
 *
 * Client-side by design: a template is a *presentation* of a message, so it is
 * evaluated where the message is drawn and never where it is stored or prompted.
 * That also keeps the whole thing reactive — a swipe or a streaming delta changes
 * the derived variables, and the next render simply picks them up.
 *
 * There is no `eval` anywhere: `{{calc}}` and `{{#if}}` run on the small
 * recursive-descent parser below. A malformed template is never fatal — it falls
 * back to its own escaped source, so the message still reads.
 */

import { readVariable } from '@shizue/core/variables';
import { stripTaint, taint } from './taint';

/** Nesting cap for `{{#if}}` / `{{#each}}`; anything deeper is malformed. */
const MAX_BLOCK_DEPTH = 8;

/** The relationship axes `{{rel::axis}}` exposes; mirrors RELATIONSHIP_AXES. */
const REL_AXES = ['affection', 'obsession', 'trust', 'liking', 'disgust', 'fear'] as const;

export interface CbsContext {
  /** Path-derived chat variables, for `{{getvar::k}}` and bare identifiers. */
  variables: Record<string, string>;
  /** Character asset urls by slug, for `{{img::slug}}`. */
  assets: ReadonlyMap<string, string>;
  /** Relationship axes 0-100, or null while the chat has none. */
  relationship: Record<string, number> | null;
  /** User turns taken on this branch, for `{{turn}}`. */
  turn: number;
  char: string;
  user: string;
}

/**
 * Neutralizes markup, and the taint marker with it: this is the one funnel every
 * interpolated value passes through, so stripping here is what keeps the marker
 * ours. A model that writes U+0001 into a chat variable gets it removed before
 * `taint()` puts the real ones back around the value.
 */
export function escapeHtml(text: string): string {
  return stripTaint(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ parsing */

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'macro'; body: string }
  | { kind: 'block'; name: 'if' | 'each'; arg: string; children: Node[] };

class MalformedTemplate extends Error {}

/** Macro bodies never contain braces, which is what makes a flat scan enough. */
const MACRO_RE = /\{\{([^{}]*)\}\}/g;
const OPEN_RE = /^#(if|each)\b\s*(.*)$/s;
const CLOSE_RE = /^\/(if|each)$/;

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: { name: 'if' | 'each'; arg: string; children: Node[] }[] = [];
  const top = (): Node[] => stack[stack.length - 1]?.children ?? root;

  let cursor = 0;
  MACRO_RE.lastIndex = 0;
  for (let match = MACRO_RE.exec(template); match; match = MACRO_RE.exec(template)) {
    if (match.index > cursor) top().push({ kind: 'text', text: template.slice(cursor, match.index) });
    cursor = match.index + match[0].length;

    // A capture bound into a macro argument — `{{calc::$1 / 2}}`, `{{#if $2}}` —
    // arrives marked, and an argument is read rather than shown: the marks would
    // only make the expression unparseable. What the macro *emits* is marked again
    // on the way out, so the taint follows the value rather than the spelling.
    const body = stripTaint(match[1]!).trim();
    const open = OPEN_RE.exec(body);
    if (open) {
      if (stack.length >= MAX_BLOCK_DEPTH) throw new MalformedTemplate('block nesting too deep');
      stack.push({ name: open[1] as 'if' | 'each', arg: (open[2] ?? '').trim(), children: [] });
      continue;
    }
    const close = CLOSE_RE.exec(body);
    if (close) {
      const block = stack.pop();
      if (!block || block.name !== close[1]) throw new MalformedTemplate('unbalanced block');
      top().push({ kind: 'block', name: block.name, arg: block.arg, children: block.children });
      continue;
    }
    top().push({ kind: 'macro', body });
  }
  if (stack.length > 0) throw new MalformedTemplate('unclosed block');
  if (cursor < template.length) top().push({ kind: 'text', text: template.slice(cursor) });
  return root;
}

/* --------------------------------------------------------------- expressions */

type Value = number | string;

const isNumeric = (value: Value): boolean =>
  typeof value === 'number' || (value.trim() !== '' && Number.isFinite(Number(value)));

const toNumber = (value: Value): number => {
  if (typeof value === 'number') return value;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Trims the float noise `0.1 + 0.2` would otherwise put on screen. */
const formatNumber = (value: number): string =>
  Number.isFinite(value) ? String(Number(value.toFixed(6))) : '0';

const TOKEN_RE =
  /\s*(?:(\d+(?:\.\d+)?)|"([^"]*)"|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)|(==|!=|>=|<=|[-+*/%()<>]))/y;

interface Token {
  type: 'number' | 'string' | 'ident' | 'op';
  text: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < source.length) {
    const start = TOKEN_RE.lastIndex;
    const match = TOKEN_RE.exec(source);
    if (!match) {
      // Trailing whitespace is fine; anything else is a character we do not know.
      if (source.slice(start).trim() === '') break;
      throw new MalformedTemplate(`unexpected character in expression: ${source.slice(start, start + 1)}`);
    }
    if (match[1] !== undefined) tokens.push({ type: 'number', text: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: 'string', text: match[2] });
    else if (match[3] !== undefined) tokens.push({ type: 'string', text: match[3] });
    else if (match[4] !== undefined) tokens.push({ type: 'ident', text: match[4] });
    else tokens.push({ type: 'op', text: match[5]! });
  }
  return tokens;
}

/**
 * `expr := compare`, `compare := add (cmp add)*`, `add := mul (('+'|'-') mul)*`,
 * `mul := unary (('*'|'/'|'%') unary)*`, `unary := '-' unary | primary`,
 * `primary := number | string | identifier | '(' expr ')'`.
 *
 * An identifier is a chat variable; `getvar::hp` is accepted as a spelling of `hp`.
 */
class ExpressionParser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly resolve: (name: string) => string,
  ) {}

  static evaluate(source: string, resolve: (name: string) => string): Value {
    const parser = new ExpressionParser(tokenize(source), resolve);
    const value = parser.compare();
    if (parser.index < parser.tokens.length) throw new MalformedTemplate('trailing tokens');
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private eat(text: string): boolean {
    const token = this.peek();
    if (token?.type === 'op' && token.text === text) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private compare(): Value {
    let left = this.add();
    for (;;) {
      const token = this.peek();
      if (token?.type !== 'op' || !['==', '!=', '>=', '<=', '>', '<'].includes(token.text)) return left;
      this.index += 1;
      const right = this.add();
      left = compareValues(left, right, token.text) ? 1 : 0;
    }
  }

  private add(): Value {
    let left = this.mul();
    for (;;) {
      if (this.eat('+')) left = toNumber(left) + toNumber(this.mul());
      else if (this.eat('-')) left = toNumber(left) - toNumber(this.mul());
      else return left;
    }
  }

  private mul(): Value {
    let left = this.unary();
    for (;;) {
      if (this.eat('*')) left = toNumber(left) * toNumber(this.unary());
      else if (this.eat('/')) {
        const divisor = toNumber(this.unary());
        left = divisor === 0 ? 0 : toNumber(left) / divisor;
      } else if (this.eat('%')) {
        const divisor = toNumber(this.unary());
        left = divisor === 0 ? 0 : toNumber(left) % divisor;
      } else return left;
    }
  }

  private unary(): Value {
    if (this.eat('-')) return -toNumber(this.unary());
    if (this.eat('+')) return toNumber(this.unary());
    return this.primary();
  }

  private primary(): Value {
    const token = this.peek();
    if (!token) throw new MalformedTemplate('unexpected end of expression');
    if (token.type === 'number') {
      this.index += 1;
      return Number(token.text);
    }
    if (token.type === 'string') {
      this.index += 1;
      return token.text;
    }
    if (token.type === 'ident') {
      this.index += 1;
      const name = token.text.startsWith('getvar::') ? token.text.slice('getvar::'.length) : token.text;
      return this.resolve(name);
    }
    if (this.eat('(')) {
      const value = this.compare();
      if (!this.eat(')')) throw new MalformedTemplate('missing )');
      return value;
    }
    throw new MalformedTemplate(`unexpected token: ${token.text}`);
  }
}

function compareValues(left: Value, right: Value, operator: string): boolean {
  if (isNumeric(left) && isNumeric(right)) {
    const a = toNumber(left);
    const b = toNumber(right);
    switch (operator) {
      case '==':
        return a === b;
      case '!=':
        return a !== b;
      case '>=':
        return a >= b;
      case '<=':
        return a <= b;
      case '>':
        return a > b;
      default:
        return a < b;
    }
  }
  const a = String(left);
  const b = String(right);
  switch (operator) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    default:
      return a < b;
  }
}

/* ---------------------------------------------------------------- rendering */

const truthy = (value: Value): boolean =>
  typeof value === 'number'
    ? value !== 0
    : value.trim() !== '' && value.trim() !== '0' && value.trim().toLowerCase() !== 'false';

/**
 * What one template render may spend. The depth cap bounds how deeply blocks
 * nest; it says nothing about how wide they get, and nesting `{{#each}}` over a
 * list multiplies — eight levels over a ten-item variable is 10^8 renders from a
 * template that fits on one line.
 */
const MAX_RENDERED_NODES = 20_000;
const MAX_RENDERED_CHARS = 100_000;
const MAX_EACH_ITERATIONS = 5_000;

/**
 * Thrown when a render runs out of allowance, and deliberately *not* caught
 * anywhere inside this engine.
 *
 * Falling back to the escaped source is right for a template the parser rejects —
 * the creator sees their own typo — and wrong for a template that ran out of
 * budget, because the fallback is small and successful-looking. A caller that
 * charges for the result would then be told a megabyte of work cost thirty
 * characters, and would happily buy it again for the next match. The one thing an
 * exhausted budget must do is reach the caller who owns it.
 */
export class RenderBudgetExhausted extends Error {}

/**
 * The allowance a render spends, owned by the caller.
 *
 * `nodes` and `iterations` bound the shape of the template. `charge` is the
 * caller's, and is called *before* any value is expanded rather than after — see
 * `read`, which is the only way a dynamic value enters this engine.
 */
interface Budget {
  nodes: number;
  iterations: number;
  charge: (chars: number) => void;
}

/**
 * Every dynamic value enters here, and is paid for before it is touched.
 *
 * The values are variables, and a variable is whatever the model's `{{setvar}}`
 * wrote or whatever the card shipped in `defaultVariables` — neither is bounded by
 * anything on the way in. `escapeHtml` on a five-megabyte one allocates five
 * megabytes; `truthy` trims it; `{{#each}}` splits it. All of that is work, all of
 * it can produce nothing, and a length is free to read. So the length is charged
 * first and the value is only then handed on.
 */
function read(value: string, budget: Budget): string {
  budget.charge(value.length);
  return value;
}

function renderNodes(nodes: Node[], ctx: CbsContext, slot: string | null, budget: Budget): string {
  let out = '';
  for (const node of nodes) {
    budget.nodes -= 1;
    if (budget.nodes < 0) throw new RenderBudgetExhausted('too many nodes');
    out += renderNode(node, ctx, slot, budget);
    // Checking each intermediate bounds the final string too, since it is one.
    if (out.length > MAX_RENDERED_CHARS) throw new RenderBudgetExhausted('output too large');
  }
  return out;
}

function renderNode(node: Node, ctx: CbsContext, slot: string | null, budget: Budget): string {
  if (node.kind === 'text') return node.text;
  if (node.kind === 'macro') return renderMacro(node.body, ctx, slot, budget);

  // Own-property reads throughout: a variable may legitimately be called
  // `toString`, and inheriting one would put a function where a string belongs.
  const resolve = (name: string): string => read(readVariable(ctx.variables, name) ?? '', budget);
  if (node.name === 'if') {
    let value: Value;
    try {
      value = ExpressionParser.evaluate(node.arg, resolve);
    } catch (error) {
      // An exhausted budget is not a malformed expression, and treating it as one
      // would turn a megabyte read into a silently truthy condition.
      if (error instanceof RenderBudgetExhausted) throw error;
      // Not an expression — fall back to the raw text, so `{{#if some text}}` is
      // simply truthy rather than an error that eats the whole message.
      value = node.arg;
    }
    return truthy(value) ? renderNodes(node.children, ctx, slot, budget) : '';
  }

  // {{#each}} over a comma-separated list: a bare name is a variable holding one
  // (empty when unset, so a typo renders nothing rather than itself), anything
  // else is the list written out inline. `{{slot}}` is the current item.
  const source = /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.arg)
    ? read(readVariable(ctx.variables, node.arg) ?? '', budget)
    : node.arg;
  const items = source
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  let out = '';
  for (const item of items) {
    budget.iterations -= 1;
    if (budget.iterations < 0) throw new RenderBudgetExhausted('too many iterations');
    out += renderNodes(node.children, ctx, item, budget);
    if (out.length > MAX_RENDERED_CHARS) throw new RenderBudgetExhausted('output too large');
  }
  return out;
}

/**
 * Which macros produce model-controlled content, and are therefore marked.
 *
 * `{{getvar}}` and `{{calc}}` read chat variables, and chat variables are whatever
 * the model's `{{setvar}}` macros said. `{{slot}}` is an item of an `{{#each}}`,
 * which is usually a variable. The rest are not the model's to choose: `{{char}}`
 * is the card's name, `{{user}}` the reader's persona, `{{turn}}` a count we keep,
 * `{{rel}}` an axis we compute, and `{{img}}` a url out of our own asset map —
 * marking those would make ordinary links inert for no gain.
 */
function renderMacro(body: string, ctx: CbsContext, slot: string | null, budget: Budget): string {
  const lower = body.toLowerCase();
  if (lower === 'char') return escapeHtml(read(ctx.char, budget));
  if (lower === 'user') return escapeHtml(read(ctx.user, budget));
  if (lower === 'turn') return String(ctx.turn);
  if (lower === 'slot') return taint(escapeHtml(read(slot ?? '', budget)));

  const separator = body.indexOf('::');
  if (separator !== -1) {
    const name = body.slice(0, separator).trim().toLowerCase();
    const rest = body.slice(separator + 2);
    if (name === 'getvar') {
      return taint(escapeHtml(read(readVariable(ctx.variables, rest.trim()) ?? '', budget)));
    }
    if (name === 'img') return escapeHtml(read(ctx.assets.get(rest.trim()) ?? '', budget));
    if (name === 'rel') {
      const axis = rest.trim().toLowerCase();
      if (!(REL_AXES as readonly string[]).includes(axis)) return escapeHtml(`{{${body}}}`);
      return String(ctx.relationship?.[axis] ?? 0);
    }
    if (name === 'calc') {
      try {
        const value = ExpressionParser.evaluate(rest, (key) =>
          read(readVariable(ctx.variables, key) ?? '', budget),
        );
        return taint(escapeHtml(typeof value === 'number' ? formatNumber(value) : value));
      } catch (error) {
        // Same reason as `{{#if}}`: an exhausted budget is not a bad expression,
        // and must not come back as a small string that looks like one.
        if (error instanceof RenderBudgetExhausted) throw error;
        return escapeHtml(`{{${body}}}`);
      }
    }
    if (name === 'button') {
      // The only interactive element a template can produce. It carries no
      // behaviour of its own — the chat page delegates on `data-shizue-fill` and
      // does nothing but put the text in the composer.
      const cut = rest.indexOf('::');
      const label = cut === -1 ? rest : rest.slice(0, cut);
      const fill = cut === -1 ? rest : rest.slice(cut + 2);
      return `<button type="button" data-shizue-fill="${escapeHtml(fill)}">${escapeHtml(label)}</button>`;
    }
  }
  // Unknown macro: shown as written, so a typo is visible instead of silent.
  return escapeHtml(`{{${body}}}`);
}

/**
 * Renders an OUT template to (still untrusted) HTML.
 *
 * A template the parser rejects comes back as its own escaped source, so a typo is
 * visible to the creator rather than fatal. An exhausted budget is the one thing
 * that does throw: `charge` belongs to the caller, and the caller is the only one
 * who can decide what to do about having spent it. Swallowing that here would hand
 * back a short string as though the work had been cheap.
 *
 * `charge` is called with the length of every dynamic value before it is expanded,
 * so a caller rendering the same template against many matches pays for each one.
 */
export function renderTemplate(
  template: string,
  ctx: CbsContext,
  charge: (chars: number) => void,
): string {
  const budget: Budget = { nodes: MAX_RENDERED_NODES, iterations: MAX_EACH_ITERATIONS, charge };
  try {
    return renderNodes(parse(template), ctx, null, budget);
  } catch (error) {
    if (error instanceof RenderBudgetExhausted) throw error;
    return escapeHtml(template);
  }
}
