/**
 * CBS — RisuAI's curly-brace syntax — as one parser and one evaluator for every
 * place a card's text is expanded.
 *
 * Two hosts read the same language and want different things from it. The prompt
 * (`applyMacros`) wants plain text, and must leave what it does not understand
 * exactly as written: the model's own `{{setvar}}` protocol rides along in the
 * history. The chat (`apps/web/src/lib/cbs.ts`) wants HTML — every value escaped,
 * the model's values marked, every step paid for. So this module owns the
 * language (how braces nest, what a block is, what `equal` and `{{? …}}` mean) and
 * a host owns everything about where the text ends up.
 *
 * RisuAI evaluates inside-out over text: an inner macro's output is pasted into
 * the outer one's source before the outer one is read. Here the nesting is a tree,
 * so an argument boundary (`::`) is only ever one the author wrote — a variable
 * holding `a::b` stays one argument, and nothing a value contains is ever parsed
 * as a macro. Expressions are the one place a value is read as source: by the time
 * `{{? $hp > {{getvar::max}}}}` is computed it is text, as in RisuAI, and a value
 * can change what the expression computes. Only that — never what the template is.
 *
 * Deliberately dependency-free, like `variables.ts`, so the web can import it
 * (`@shizue/core/cbs`) without the tokenizer or the card parser. No `eval`.
 */

/* ------------------------------------------------------------------ parsing */

export type CbsNode = CbsText | CbsMacro | CbsBlock;

export interface CbsText {
  type: 'text';
  text: string;
}

/** `{{…}}`. `start`/`end` are offsets into the source, so it can be shown as written. */
export interface CbsMacro {
  type: 'macro';
  start: number;
  end: number;
  body: CbsNode[];
}

/**
 * The blocks RisuAI cards use, plus our own `#each`. `#if_pure` is `#if` that
 * keeps its whitespace; `#when` is RisuAI's successor to `#if`, with operators.
 */
export type CbsBlockKind = 'if' | 'if_pure' | 'when' | 'each';

export interface CbsBlock {
  type: 'block';
  kind: CbsBlockKind;
  start: number;
  end: number;
  /** The opening macro after its keyword: the condition, or the list. */
  head: CbsNode[];
  body: CbsNode[];
  /** What follows `{{:else}}`; null when there is none. */
  otherwise: CbsNode[] | null;
}

/** A template strict parsing refuses. Lenient parsing never throws. */
export class CbsSyntaxError extends Error {}

/** Blocks inside blocks. One more is malformed. */
export const MAX_CBS_BLOCK_DEPTH = 8;
/** Macros inside macro arguments — real cards reach six or seven. */
const MAX_MACRO_DEPTH = 16;

const OPEN_RE = /^\s*#(if_pure|if|when|each)(?![A-Za-z0-9_])/i;

type Frame =
  | { type: 'macro'; start: number; nodes: CbsNode[] }
  | {
      type: 'block';
      kind: CbsBlockKind;
      opener: CbsMacro;
      head: CbsNode[];
      nodes: CbsNode[];
      /** The body so far, once `{{:else}}` has moved `nodes` on to the other branch. */
      body: CbsNode[] | null;
      elseMarker: CbsMacro | null;
    };

/** Appends, merging runs of text so a flattened frame reads as one node. */
function append(list: CbsNode[], node: CbsNode): void {
  const last = list[list.length - 1];
  if (node.type === 'text' && last?.type === 'text') last.text += node.text;
  else if (node.type !== 'text' || node.text) list.push(node);
}

/** The macro's leading text, when it starts with text. */
const lead = (macro: CbsMacro): string => {
  const first = macro.body[0];
  return first?.type === 'text' ? first.text.trimStart() : '';
};

/** Written out in full, with nothing nested in it. */
const literalText = (macro: CbsMacro): string | null => {
  if (macro.body.length === 0) return '';
  const only = macro.body[0];
  return macro.body.length === 1 && only?.type === 'text' ? only.text : null;
};

/**
 * Pairs braces left to right, the way RisuAI does: `{{` opens, and `}}` closes the
 * innermost macro still open — or is plain text when none is.
 *
 * Lenient (the default) repairs rather than refuses, because the prompt has to say
 * *something* with a stranger's typo in it: an unclosed block is its opening macro
 * written out, a stray closer is text, and any closer ends the innermost block, as
 * in RisuAI. Strict refuses all three — the chat shows a creator their own
 * template rather than guessing at it. An unclosed `{{` is text in both.
 */
export function parseCbs(source: string, options: { strict?: boolean } = {}): CbsNode[] {
  const strict = options.strict ?? false;
  const root: CbsNode[] = [];
  const stack: Frame[] = [];
  const top = (): CbsNode[] => stack[stack.length - 1]?.nodes ?? root;
  let macros = 0;
  let blocks = 0;
  let textStart = 0;

  const flush = (end: number): void => {
    if (end > textStart) append(top(), { type: 'text', text: source.slice(textStart, end) });
  };

  const closeMacro = (macro: CbsMacro): void => {
    const opener = OPEN_RE.exec(lead(macro));
    if (opener) {
      if (blocks >= MAX_CBS_BLOCK_DEPTH) {
        if (strict) throw new CbsSyntaxError('block nesting too deep');
        append(top(), macro);
        return;
      }
      const rest = lead(macro).slice(opener[0].length);
      const head = [...(rest ? [{ type: 'text', text: rest } as CbsText] : []), ...macro.body.slice(1)];
      const kind = opener[1]!.toLowerCase() as CbsBlockKind;
      stack.push({ type: 'block', kind, opener: macro, head, nodes: [], body: null, elseMarker: null });
      blocks += 1;
      return;
    }

    const literal = literalText(macro)?.trim();
    const frame = stack[stack.length - 1];
    if (literal !== undefined && literal.startsWith('/') && !literal.startsWith('//')) {
      const name = literal.slice(1).trim().toLowerCase();
      const matches =
        frame?.type === 'block' &&
        (!strict || name === '' || name === frame.kind || (frame.kind === 'if_pure' && name === 'if'));
      if (frame?.type === 'block' && matches) {
        stack.pop();
        blocks -= 1;
        append(top(), {
          type: 'block',
          kind: frame.kind,
          start: frame.opener.start,
          end: macro.end,
          head: frame.head,
          body: frame.body ?? frame.nodes,
          otherwise: frame.body ? frame.nodes : null,
        });
        return;
      }
      if (strict) throw new CbsSyntaxError(frame?.type === 'block' ? 'mismatched close' : 'stray close');
    }

    if (literal === ':else' && frame?.type === 'block' && frame.kind !== 'each' && !frame.body) {
      frame.body = frame.nodes;
      frame.nodes = [];
      frame.elseMarker = macro;
      return;
    }
    append(top(), macro);
  };

  let i = 0;
  while (i < source.length - 1) {
    const here = source.charCodeAt(i);
    const next = source.charCodeAt(i + 1);
    if (here === 0x7b && next === 0x7b) {
      if (macros >= MAX_MACRO_DEPTH) {
        if (strict) throw new CbsSyntaxError('macro nesting too deep');
        // Left as text; its closer then ends the enclosing macro early, which
        // garbles a template no card writes rather than refusing the prompt.
        i += 2;
        continue;
      }
      flush(i);
      stack.push({ type: 'macro', start: i, nodes: [] });
      macros += 1;
      i += 2;
      textStart = i;
      continue;
    }
    const frame = stack[stack.length - 1];
    if (here === 0x7d && next === 0x7d && frame?.type === 'macro') {
      flush(i);
      stack.pop();
      macros -= 1;
      i += 2;
      textStart = i;
      closeMacro({ type: 'macro', start: frame.start, end: i, body: frame.nodes });
      continue;
    }
    i += 1;
  }
  flush(source.length);

  // Whatever is still open was never closed. A macro is text that happens to
  // start with braces; a block is an error, or (leniently) its parts written out.
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.type === 'macro') {
      macros -= 1;
      append(top(), { type: 'text', text: '{{' });
      for (const node of frame.nodes) append(top(), node);
      continue;
    }
    if (strict) throw new CbsSyntaxError('unclosed block');
    blocks -= 1;
    append(top(), frame.opener);
    for (const node of frame.body ?? []) append(top(), node);
    if (frame.elseMarker) append(top(), frame.elseMarker);
    for (const node of frame.nodes) append(top(), node);
  }
  return root;
}

/**
 * A macro's name and arguments, split where the author wrote separators.
 *
 * RisuAI's rule: if the first colon is doubled, `::` separates; otherwise `:`
 * does — so `{{random:a,b}}` and `{{random::a::b}}` both work. Only colons in the
 * author's own text count. The name must be written out: one composed at render
 * time (`{{{{getvar::f}}::x}}`) would let a value choose which function runs, and
 * is null here.
 */
function splitMacro(macro: CbsMacro): { name: string | null; parts: CbsNode[][]; separator: string } {
  let separator = '';
  for (const node of macro.body) {
    if (node.type !== 'text') continue;
    const colon = node.text.indexOf(':');
    if (colon === -1) continue;
    separator = node.text[colon + 1] === ':' ? '::' : ':';
    break;
  }

  const parts: CbsNode[][] = [[]];
  for (const node of macro.body) {
    if (node.type !== 'text' || !separator) {
      parts[parts.length - 1]!.push(node);
      continue;
    }
    const pieces = node.text.split(separator);
    pieces.forEach((piece, index) => {
      if (index > 0) parts.push([]);
      if (piece) parts[parts.length - 1]!.push({ type: 'text', text: piece });
    });
  }

  const head = parts[0]!;
  const name =
    head.length === 0 ? '' : head.length === 1 && head[0]!.type === 'text' ? head[0]!.text : null;
  return { name: name === null ? null : normalizeName(name), parts, separator };
}

/** RisuAI's: case, spaces, `_` and `-` do not matter — `greater_equal` is `greaterequal`. */
const normalizeName = (name: string): string => name.toLowerCase().replace(/[\s_-]/g, '');

/* --------------------------------------------------------------- expressions */

/** An expression that cannot be read. Hosts show the macro as written. */
export class CbsExpressionError extends Error {}

export type CbsExpressionValue = number | string;

/** Parentheses deep enough to matter are an attack on the stack, not arithmetic. */
const MAX_EXPRESSION_DEPTH = 64;

const TOKEN_RE =
  /\s*(?:(\d+(?:\.\d+)?)|"([^"]*)"|'([^']*)'|\$([A-Za-z0-9_]+)|([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)|(==|!=|>=|<=|&&|\|\||[-+*/%^()<>=&|!≤≥≠]))/y;

type Token =
  | { type: 'number' | 'string' | 'name' | 'op'; text: string }
  | { type: 'dollar'; text: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < source.length) {
    const start = TOKEN_RE.lastIndex;
    const match = TOKEN_RE.exec(source);
    if (!match) {
      if (source.slice(start).trim() === '') break;
      throw new CbsExpressionError(`unexpected character: ${source.slice(start, start + 1)}`);
    }
    if (match[1] !== undefined) tokens.push({ type: 'number', text: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: 'string', text: match[2] });
    else if (match[3] !== undefined) tokens.push({ type: 'string', text: match[3] });
    else if (match[4] !== undefined) tokens.push({ type: 'dollar', text: match[4] });
    else if (match[5] !== undefined) tokens.push({ type: 'name', text: match[5] });
    else tokens.push({ type: 'op', text: match[6]! });
  }
  return tokens;
}

const isNumeric = (value: CbsExpressionValue): boolean =>
  typeof value === 'number' || (value.trim() !== '' && Number.isFinite(Number(value)));

const toNumber = (value: CbsExpressionValue): number => {
  if (typeof value === 'number') return value;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Nonzero, or text that is not empty, `0` or `false`. */
export const expressionTruthy = (value: CbsExpressionValue): boolean =>
  typeof value === 'number'
    ? value !== 0
    : value.trim() !== '' && value.trim() !== '0' && value.trim().toLowerCase() !== 'false';

const COMPARISONS = new Set(['=', '==', '!=', '≠', '<', '>', '<=', '>=', '≤', '≥']);

function compare(left: CbsExpressionValue, right: CbsExpressionValue, operator: string): boolean {
  const numeric = isNumeric(left) && isNumeric(right);
  const a = numeric ? toNumber(left) : String(left);
  const b = numeric ? toNumber(right) : String(right);
  switch (operator) {
    case '=':
    case '==':
      return a === b;
    case '!=':
    case '≠':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
    case '≤':
      return a <= b;
    default:
      return a >= b;
  }
}

/**
 * The union of two dialects, which agree wherever both say something:
 *
 *   - RisuAI's `{{? …}}`/`{{calc::…}}`: `$name` is a chat variable read as a
 *     number (unset or not a number is 0), `=` is equality, `&`/`|`/`!` are logic,
 *     `^` is a power, `≤ ≥ ≠` are spelled out.
 *   - Ours: a bare name is a chat variable read as text (`getvar::hp` is the
 *     same name), quoted strings compare as text, `==` and `&&`/`||` are spelled
 *     the C way.
 *
 * Precedence, loosest first: `|`, `&`, comparisons, `+ -`, `* / %`, `^`, unary
 * `- + !`. RisuAI puts `&`, `|` and the comparisons on one level, so its
 * `$a>1&$b<2` means `(($a>1)&$b)<2`; here it means what it says. Real cards
 * parenthesize, where both agree. Logic answers 1 or 0; division by zero is 0,
 * not Infinity.
 */
export function evaluateExpression(
  source: string,
  variable: (name: string) => string,
): CbsExpressionValue {
  const tokens = tokenize(source);
  let index = 0;
  let depth = 0;

  const peek = (): Token | undefined => tokens[index];
  const eat = (...ops: string[]): string | null => {
    const token = peek();
    if (token?.type === 'op' && ops.includes(token.text)) {
      index += 1;
      return token.text;
    }
    return null;
  };

  const or = (): CbsExpressionValue => {
    let left = and();
    while (eat('|', '||')) {
      const right = and();
      left = expressionTruthy(left) || expressionTruthy(right) ? 1 : 0;
    }
    return left;
  };
  const and = (): CbsExpressionValue => {
    let left = comparison();
    while (eat('&', '&&')) {
      const right = comparison();
      left = expressionTruthy(left) && expressionTruthy(right) ? 1 : 0;
    }
    return left;
  };
  const comparison = (): CbsExpressionValue => {
    let left = additive();
    for (;;) {
      const token = peek();
      if (token?.type !== 'op' || !COMPARISONS.has(token.text)) return left;
      index += 1;
      left = compare(left, additive(), token.text) ? 1 : 0;
    }
  };
  const additive = (): CbsExpressionValue => {
    let left = multiplicative();
    for (let op = eat('+', '-'); op; op = eat('+', '-')) {
      const right = toNumber(multiplicative());
      left = op === '+' ? toNumber(left) + right : toNumber(left) - right;
    }
    return left;
  };
  const multiplicative = (): CbsExpressionValue => {
    let left = power();
    for (let op = eat('*', '/', '%'); op; op = eat('*', '/', '%')) {
      const right = toNumber(power());
      if (op === '*') left = toNumber(left) * right;
      else if (right === 0) left = 0;
      else left = op === '/' ? toNumber(left) / right : toNumber(left) % right;
    }
    return left;
  };
  const power = (): CbsExpressionValue => {
    let left = unary();
    while (eat('^')) left = toNumber(left) ** toNumber(unary());
    return left;
  };
  const unary = (): CbsExpressionValue => {
    const op = eat('-', '+', '!');
    if (!op) return primary();
    if (++depth > MAX_EXPRESSION_DEPTH) throw new CbsExpressionError('expression too deep');
    const operand = unary();
    depth -= 1;
    if (op === '!') return expressionTruthy(operand) ? 0 : 1;
    return op === '-' ? -toNumber(operand) : toNumber(operand);
  };
  const primary = (): CbsExpressionValue => {
    const token = peek();
    if (!token) throw new CbsExpressionError('unexpected end of expression');
    if (token.type === 'op') {
      if (!eat('(')) throw new CbsExpressionError(`unexpected token: ${token.text}`);
      if (++depth > MAX_EXPRESSION_DEPTH) throw new CbsExpressionError('expression too deep');
      const value = or();
      depth -= 1;
      if (!eat(')')) throw new CbsExpressionError('missing )');
      return value;
    }
    index += 1;
    if (token.type === 'number') return Number(token.text);
    if (token.type === 'string') return token.text;
    if (token.type === 'dollar') {
      const parsed = Number.parseFloat(variable(token.text));
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return variable(token.text.startsWith('getvar::') ? token.text.slice('getvar::'.length) : token.text);
  };

  const value = or();
  if (index < tokens.length) throw new CbsExpressionError('trailing tokens');
  return value;
}

/** Trims the float noise `0.1 + 0.2` would otherwise put on screen. */
export const formatCbsNumber = (value: number): string =>
  Number.isFinite(value) ? String(Number(value.toFixed(6))) : '0';

/* ---------------------------------------------------------------- evaluation */

/**
 * A value moving through an evaluation.
 *
 * `untrusted` is the host's taint, carried rather than interpreted: whatever a
 * chat variable put in (and whatever the host's `text` says was marked) stays
 * marked through every function that passes it on. `markup` is HTML a host
 * macro produced, which its `emit` writes out as it is.
 *
 * `deferred` means a variable was needed where the host has none, so the text is
 * the macro as written rather than its answer. It travels like `untrusted`, and a
 * block whose condition is deferred is written out whole: a greeting expanded
 * before the chat has variables keeps the condition for the prompt to decide,
 * rather than reading it as false and dropping its body for good.
 */
export interface CbsValue {
  text: string;
  untrusted?: boolean;
  markup?: boolean;
  deferred?: boolean;
}

/** One argument, evaluated when first read and then kept. */
export interface CbsArg {
  /** Nothing nested in it: the text is exactly what the author wrote. */
  readonly literal: boolean;
  value(): CbsValue;
}

export interface CbsArgs {
  /** Arguments after the name. */
  readonly length: number;
  /** The i-th argument, from 1. */
  at(index: number): CbsArg | undefined;
  /**
   * The i-th argument to the end, separators and all — what an expression, a
   * variable name or a button's fill text wants, so `{{calc::getvar::hp + 1}}`
   * is one expression rather than two arguments.
   */
  rest(index: number): CbsArg | undefined;
}

/** Where a result goes: written out, or read as another macro's argument. */
export type CbsMode = 'out' | 'arg';

export interface CbsCall {
  /** Normalized: lower case, spaces, `_` and `-` removed. */
  name: string;
  args: CbsArgs;
  macro: CbsMacro;
  mode: CbsMode;
  /** The current `#each` item, for a host that has one. */
  slot: string | null;
}

export interface CbsBlockScope {
  head: CbsArg;
  mode: CbsMode;
  /** Renders nodes in this block's mode, with `slot` as the current item. */
  render(nodes: CbsNode[], slot: string | null): CbsValue;
}

export interface CbsHost {
  /**
   * A chat variable, for `getvar`, `$name` and bare names; undefined when unset.
   * Without it there are no variables to read, and anything that reads one —
   * `getvar`, an expression naming one — is left as written.
   */
  variable?(name: string): string | undefined;
  /** The host's own macros, tried before the built-ins. Undefined: not one of them. */
  macro?(call: CbsCall): CbsValue | undefined;
  /** Blocks the language leaves to the host (`#each`). Undefined: left as written. */
  block?(block: CbsBlock, scope: CbsBlockScope): CbsValue | undefined;
  /** `#if`'s truth. The default is RisuAI's: the first word is `1` or `true`. */
  condition?(head: CbsArg): boolean;
  /** [0, 1), for `random` and `roll`. */
  random?(): number;
  /** Which of `count` options a `{{pick}}` at this macro takes. Defaults to random. */
  pick?(count: number, macro: CbsMacro): number;
  /** The author's own text, read as part of an argument. */
  text?(raw: string): CbsValue;
  /** A macro's result, written out. Text the author wrote never passes here. */
  emit?(value: CbsValue): string;
  /** Called for every node evaluated; throw to stop. */
  visit?(): void;
  /** Called with the length of every string the evaluation grows; throw to stop. */
  grow?(length: number): void;
}

/** RisuAI's truth for a condition: the first word is `1` or `true`, and nothing else is. */
export function isCbsTrue(text: string): boolean {
  const word = text.trim().split(/\s+/, 1)[0];
  return word === '1' || word === 'true';
}

/** `#if`'s whitespace: every line's indent and the block's ends trimmed off. */
const trimLines = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trimStart())
    .join('\n')
    .trim();

/** `#when`'s: blank lines at either end of a multi-line block. */
const trimBlankLines = (text: string): string => {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.join('\n');
};

/** `{{random}}`'s options: several arguments, a JSON array, or one list split on `,`/`:`. */
function options(args: CbsArgs): { list: string[]; untrusted: boolean; deferred: boolean } {
  const values = Array.from({ length: args.length }, (_, i) => args.at(i + 1)!.value());
  const untrusted = values.some((value) => value.untrusted);
  const deferred = values.some((value) => value.deferred);
  if (values.length !== 1) return { list: values.map((value) => value.text.trim()), untrusted, deferred };
  const only = values[0]!.text.trim();
  const array = parseArray(only);
  if (array) return { list: array, untrusted, deferred };
  // `\,` is a literal comma, as in RisuAI.
  const list = only
    .replace(/\\,/g, '\u0000')
    .split(/[:,]/)
    .map((option) => option.replace(/\u0000/g, ',').trim());
  return { list, untrusted, deferred };
}

/** A JSON array's items as text, or null for anything else. */
function parseArray(text: string): string[] | null {
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.map((item) => (typeof item === 'string' ? item : JSON.stringify(item) ?? ''))
      : null;
  } catch {
    return null;
  }
}

/** Dice past this are not a roll anyone wrote, just a loop someone wants run. */
const MAX_DICE = 100;

/**
 * Evaluates parsed nodes against a host. `source` is the text they were parsed
 * from, which is how a macro nobody understands is written back out as it was.
 *
 * An unknown macro is left exactly as written, its arguments unevaluated — the
 * reason `{{setvar::x::{{getvar::y}}}}` survives the prompt for the history fold
 * to replay. Exceptions from the host's hooks pass through untouched: a budget
 * that ran out is the host's to report, not this module's to hide.
 */
export function evaluateCbs(source: string, nodes: CbsNode[], host: CbsHost = {}): string {
  const random = host.random ?? Math.random;

  const textValue = (raw: string): CbsValue => host.text?.(raw) ?? { text: raw };
  const verbatim = (node: CbsMacro | CbsBlock): CbsValue => textValue(source.slice(node.start, node.end));
  /** As written, because answering would take a variable the host does not have. */
  const deferred = (node: CbsMacro | CbsBlock): CbsValue => ({ ...verbatim(node), deferred: true });

  const sequence = (list: CbsNode[], mode: CbsMode, slot: string | null): CbsValue => {
    let text = '';
    let untrusted = false;
    let waiting = false;
    for (const node of list) {
      host.visit?.();
      const part = evaluate(node, mode, slot);
      text += part.text;
      if (part.untrusted) untrusted = true;
      if (part.deferred) waiting = true;
      host.grow?.(text.length);
    }
    return { text, untrusted, ...(waiting ? { deferred: true } : {}) };
  };

  const argOf = (list: CbsNode[], slot: string | null): CbsArg => {
    let kept: CbsValue | undefined;
    return {
      literal: list.every((node) => node.type === 'text'),
      value: () => (kept ??= sequence(list, 'arg', slot)),
    };
  };

  /** Written-out results go through the host's `emit`; arguments stay values. */
  const settle = (value: CbsValue, mode: CbsMode): CbsValue =>
    mode === 'out' ? { text: host.emit ? host.emit(value) : value.text } : value;

  function evaluate(node: CbsNode, mode: CbsMode, slot: string | null): CbsValue {
    if (node.type === 'text') return mode === 'out' ? { text: node.text } : textValue(node.text);
    if (node.type === 'block') return block(node, mode, slot);
    return settle(macro(node, mode, slot), mode);
  }

  function block(node: CbsBlock, mode: CbsMode, slot: string | null): CbsValue {
    const head = argOf(node.head, slot);
    const branch = (taken: CbsNode[] | null, trim: (text: string) => string): CbsValue => {
      if (!taken) return { text: '' };
      const value = sequence(taken, mode, slot);
      return { ...value, text: trim(value.text) };
    };

    if (node.kind === 'if' || node.kind === 'if_pure') {
      if (head.value().deferred) return settle(deferred(node), mode);
      const holds = host.condition ? host.condition(head) : isCbsTrue(head.value().text);
      const trim = node.kind === 'if' ? trimLines : (text: string) => text;
      return branch(holds ? node.body : node.otherwise, trim);
    }
    if (node.kind === 'when') {
      const decided = when(node.head, slot);
      if (decided === null) return settle(deferred(node), mode);
      const { holds, whitespace } = decided;
      const trim = whitespace === 'keep' ? (text: string) => text : whitespace === 'legacy' ? trimLines : trimBlankLines;
      return branch(holds ? node.body : node.otherwise, trim);
    }
    const hosted = host.block?.(node, {
      head,
      mode,
      render: (list, itemSlot) => sequence(list, mode, itemSlot),
    });
    return hosted ?? settle(verbatim(node), mode);
  }

  /**
   * `{{#when X}}`, or `{{#when::A::op::B}}` read right to left as RisuAI does:
   * each step pops a value and the operator before it, and a binary operator
   * pops its left operand too. `toggle`, `tis` and `tisnot` read RisuAI's global
   * toggles, which have no counterpart here, so a toggle is always off.
   */
  function when(
    head: CbsNode[],
    slot: string | null,
  ): { holds: boolean; whitespace: 'normal' | 'keep' | 'legacy' } | null {
    const first = head[0];
    if (!(first?.type === 'text' && first.text.startsWith('::'))) {
      const value = argOf(head, slot).value();
      if (value.deferred) return null;
      return { holds: isCbsTrue(value.text), whitespace: 'normal' };
    }
    const { parts } = splitMacro({ type: 'macro', start: 0, end: 0, body: head });
    const values = parts.slice(1).map((part) => argOf(part, slot).value());
    // `var`, `vis` and `visnot` read a variable themselves, without a macro to say so.
    const reads = values.some((value) => ['var', 'vis', 'visnot'].includes(value.text));
    if (values.some((value) => value.deferred) || (reads && !host.variable)) return null;
    const statement = values.map((value) => value.text);
    const read = (name: string): string => host.variable?.(name) ?? '';
    const truth = (value: string | undefined): string => (isCbsTrue(value ?? '') ? '1' : '0');
    let whitespace: 'normal' | 'keep' | 'legacy' = 'normal';
    while (statement.length > 1) {
      const condition = statement.pop()!;
      const operator = statement.pop()!;
      const numbers = (): [number, number] => [Number.parseFloat(statement.pop() ?? ''), Number.parseFloat(condition)];
      switch (operator) {
        case 'not':
          statement.push(truth(condition) === '1' ? '0' : '1');
          break;
        case 'keep':
        case 'legacy':
          whitespace = operator;
          statement.push(condition);
          break;
        case 'and': {
          const other = statement.pop();
          statement.push(truth(condition) === '1' && truth(other) === '1' ? '1' : '0');
          break;
        }
        case 'or': {
          const other = statement.pop();
          statement.push(truth(condition) === '1' || truth(other) === '1' ? '1' : '0');
          break;
        }
        case 'is':
          statement.push(statement.pop() === condition ? '1' : '0');
          break;
        case 'isnot':
          statement.push(statement.pop() !== condition ? '1' : '0');
          break;
        case 'var':
          statement.push(truth(read(condition)));
          break;
        case 'vis':
          statement.push(read(statement.pop() ?? '') === condition ? '1' : '0');
          break;
        case 'visnot':
          statement.push(read(statement.pop() ?? '') !== condition ? '1' : '0');
          break;
        case 'toggle':
          statement.push('0');
          break;
        case 'tis':
          statement.pop();
          statement.push(condition === '' ? '1' : '0');
          break;
        case 'tisnot':
          statement.pop();
          statement.push(condition !== '' ? '1' : '0');
          break;
        case '>': {
          const [a, b] = numbers();
          statement.push(a > b ? '1' : '0');
          break;
        }
        case '<': {
          const [a, b] = numbers();
          statement.push(a < b ? '1' : '0');
          break;
        }
        case '>=': {
          const [a, b] = numbers();
          statement.push(a >= b ? '1' : '0');
          break;
        }
        case '<=': {
          const [a, b] = numbers();
          statement.push(a <= b ? '1' : '0');
          break;
        }
        default:
          statement.push(truth(condition));
      }
    }
    return { holds: isCbsTrue(statement[0] ?? ''), whitespace };
  }

  /** `{{? …}}` and `{{calc::…}}`. Reading a variable marks the answer. */
  function expression(arg: CbsArg | undefined, node: CbsMacro): CbsValue {
    if (!host.variable) return deferred(node);
    if (!arg) return verbatim(node);
    const read = host.variable;
    try {
      const value = evaluateExpression(arg.value().text, (name) => read(name) ?? '');
      return { text: typeof value === 'number' ? formatCbsNumber(value) : value, untrusted: true };
    } catch (error) {
      if (error instanceof CbsExpressionError) return verbatim(node);
      throw error;
    }
  }

  function macro(node: CbsMacro, mode: CbsMode, slot: string | null): CbsValue {
    const opening = lead(node);
    if (opening.startsWith('//')) return { text: '' };
    if (/^\?\s/.test(opening)) {
      const first = node.body[0] as CbsText;
      const rest = first.text.trimStart().slice(1);
      return expression(argOf([{ type: 'text', text: rest }, ...node.body.slice(1)], slot), node);
    }

    const { name, parts, separator } = splitMacro(node);
    if (name === null) return verbatim(node);
    const rests = new Map<number, CbsArg>();
    const argList = parts.slice(1).map((part) => argOf(part, slot));
    const args: CbsArgs = {
      length: argList.length,
      at: (index) => argList[index - 1],
      rest: (index) => {
        if (index < 1 || index > argList.length) return undefined;
        if (index === argList.length) return argList[index - 1];
        let kept = rests.get(index);
        if (!kept) {
          const joined = parts.slice(index).flatMap((part, i) =>
            i === 0 ? part : [{ type: 'text', text: separator } as CbsText, ...part],
          );
          kept = argOf(joined, slot);
          rests.set(index, kept);
        }
        return kept;
      },
    };

    const call: CbsCall = { name, args, macro: node, mode, slot };
    const result = host.macro?.(call) ?? builtin(call) ?? verbatim(node);
    // An answer built on a variable the host does not have is no answer: the
    // macro is written as itself, inner text and all, for a later pass to decide.
    return result.deferred ? deferred(node) : result;
  }

  /** A function of its arguments: marked when any argument it read was. */
  const derived = (text: string, values: CbsValue[]): CbsValue => ({
    text,
    untrusted: values.some((value) => value.untrusted),
    ...(values.some((value) => value.deferred) ? { deferred: true } : {}),
  });

  function builtin({ name, args, macro: node }: CbsCall): CbsValue | undefined {
    const value = (index: number): CbsValue => args.at(index)?.value() ?? { text: '' };
    const pair = (): [CbsValue, CbsValue] | null =>
      args.length >= 2 ? [value(1), value(2)] : null;
    const bit = (holds: boolean, values: CbsValue[]): CbsValue => derived(holds ? '1' : '0', values);

    switch (name) {
      case 'getvar': {
        if (!host.variable) return deferred(node);
        const key = args.rest(1)?.value().text.trim() ?? '';
        return { text: host.variable(key) ?? '', untrusted: true };
      }
      case 'calc':
        return expression(args.rest(1), node);
      case 'equal':
      case 'notequal': {
        const both = pair();
        if (!both) return bit(name === 'notequal', []);
        const same = both[0].text === both[1].text;
        return bit(name === 'equal' ? same : !same, both);
      }
      case 'greater':
      case 'greaterequal':
      case 'less':
      case 'lessequal': {
        // A missing operand is NaN in RisuAI, and NaN compares false.
        const both = pair();
        if (!both) return bit(false, []);
        const a = Number(both[0].text);
        const b = Number(both[1].text);
        const holds =
          name === 'greater' ? a > b : name === 'greaterequal' ? a >= b : name === 'less' ? a < b : a <= b;
        return bit(holds, both);
      }
      case 'and':
      case 'or': {
        const both: [CbsValue, CbsValue] = [value(1), value(2)];
        const [a, b] = both.map((one) => one.text === '1');
        return bit(name === 'and' ? a! && b! : a! || b!, both);
      }
      case 'not': {
        const one = value(1);
        return bit(one.text !== '1', [one]);
      }
      case 'sum': {
        if (args.length === 0) return undefined;
        const values = Array.from({ length: args.length }, (_, i) => value(i + 1));
        const numbers =
          values.length === 1
            ? (parseArray(values[0]!.text.trim()) ?? values[0]!.text.split('§'))
            : values.map((one) => one.text);
        const total = numbers.reduce((sum, item) => {
          const number = Number(item);
          return sum + (Number.isNaN(number) ? 0 : number);
        }, 0);
        return derived(formatCbsNumber(total), values);
      }
      case 'random':
      case 'pick': {
        const choose = (count: number): number =>
          name === 'pick' && host.pick ? host.pick(count, node) : Math.floor(random() * count);
        if (args.length === 0) return { text: String(choose(1_000_000) / 1_000_000) };
        const { list, untrusted, deferred: waiting } = options(args);
        if (waiting) return deferred(node);
        return { text: list[choose(list.length)] ?? '', untrusted };
      }
      case 'roll': {
        // `N`, `dN` or `XdY`; an empty side of the `d` is RisuAI's 1 die or 6 sides.
        const notation = args.at(1)?.value();
        if (!notation) return undefined;
        const halves = notation.text.trim().toLowerCase().split('d');
        if (halves.length > 2) return undefined;
        const count = halves.length === 2 ? Number(halves[0] || 1) : 1;
        const sides = halves.length === 2 ? Number(halves[1] || 6) : Number(halves[0]);
        if (!Number.isInteger(count) || !Number.isInteger(sides) || count < 1 || sides < 1 || count > MAX_DICE) {
          return undefined;
        }
        let total = 0;
        for (let i = 0; i < count; i += 1) total += Math.floor(random() * sides) + 1;
        return derived(String(total), [notation]);
      }
      default:
        return undefined;
    }
  }

  return sequence(nodes, 'out', null).text;
}

/* ------------------------------------------------------------------- assets */

/**
 * What RisuAI's asset macros draw: an image, the image's address, or something
 * there is no counterpart for here (backgrounds, music, video, inlays, profile
 * pictures), which is dropped. Keys are normalized names — `video-img` is
 * `videoimg`.
 */
const ASSET_MACROS: Record<string, 'image' | 'url' | 'drop'> = {
  img: 'image',
  image: 'image',
  asset: 'image',
  emotion: 'image',
  raw: 'url',
  path: 'url',
  bg: 'drop',
  bgm: 'drop',
  audio: 'drop',
  video: 'drop',
  videoimg: 'drop',
  inlay: 'drop',
  inlayed: 'drop',
  inlayeddata: 'drop',
  source: 'drop',
};

export type AssetMacroKind = 'image' | 'url' | 'drop';

/** The kind of asset macro a normalized name is, or undefined for any other. */
export const assetMacroKind = (name: string): AssetMacroKind | undefined =>
  Object.prototype.hasOwnProperty.call(ASSET_MACROS, name) ? ASSET_MACROS[name] : undefined;

export interface AssetMacro {
  start: number;
  end: number;
  kind: AssetMacroKind;
  /** The asset it names, trimmed; null when the name is composed at render time. */
  ref: string | null;
}

/**
 * Every asset macro in `text`, outermost first and in order — inside blocks and
 * other macros' arguments too, since none of them may reach a model or a screen
 * as written. One whose name is built from other macros has no `ref`: only a
 * renderer holding the variables can say which image it means.
 */
export function findAssetMacros(text: string): AssetMacro[] {
  if (!text.includes('{{')) return [];
  const found: AssetMacro[] = [];
  const walk = (nodes: CbsNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'text') continue;
      if (node.type === 'block') {
        walk(node.head);
        walk(node.body);
        if (node.otherwise) walk(node.otherwise);
        continue;
      }
      const { name, parts, separator } = splitMacro(node);
      const kind = name === null ? undefined : assetMacroKind(name);
      if (!kind) {
        walk(node.body);
        continue;
      }
      const rest = parts.slice(1);
      const literal = rest.every((part) => part.every((child) => child.type === 'text'));
      const ref = literal
        ? rest.map((part) => part.map((child) => (child as CbsText).text).join('')).join(separator).trim()
        : null;
      found.push({ start: node.start, end: node.end, kind, ref });
    }
  };
  walk(parseCbs(text));
  return found;
}

/** `text` with every asset macro replaced by what `replace` answers for it. */
export function replaceAssetMacros(text: string, replace: (macro: AssetMacro) => string): string {
  const found = findAssetMacros(text);
  if (found.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const macro of found) {
    out += text.slice(cursor, macro.start) + replace(macro);
    cursor = macro.end;
  }
  return out + text.slice(cursor);
}

/** An asset as a reference can name it. */
export interface NamedAsset {
  slug: string;
  /** The imported card's own name for it; null for an upload. */
  name: string | null;
}

/** Mirrors MAX_SLUG_LENGTH in apps/api/src/assets.ts. */
const MAX_SLUG_LENGTH = 40;

/** Mirrors `normalizeSlug` in apps/api/src/assets.ts, which made every imported slug. */
const foldSlug = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');

const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|avif|bmp)$/;

/**
 * Builds the lookup from a reference to the slug it means, once per asset list.
 *
 * In order: the slug as written; then the card's own name for the image,
 * compared without case as RisuAI does; then both without an image extension,
 * because a card may store `profile` and write `profile.png`, or the reverse;
 * and last the slug the import would have folded the reference into. RisuAI
 * also guesses at the nearest name by edit distance — not here: a wrong picture
 * is worse than none.
 */
export function assetResolver(assets: readonly NamedAsset[]): (ref: string) => string | undefined {
  const slugs = new Set(assets.map((asset) => asset.slug));
  const byName = new Map<string, string>();
  const byStem = new Map<string, string>();
  for (const asset of assets) {
    if (!asset.name) continue;
    const name = asset.name.trim().toLowerCase();
    if (!byName.has(name)) byName.set(name, asset.slug);
    const stem = name.replace(IMAGE_EXTENSION, '');
    if (!byStem.has(stem)) byStem.set(stem, asset.slug);
  }
  return (ref) => {
    const trimmed = ref.trim();
    if (slugs.has(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    const stem = lower.replace(IMAGE_EXTENSION, '');
    const named = byName.get(lower) ?? byStem.get(stem);
    if (named) return named;
    for (const folded of [foldSlug(trimmed), foldSlug(stem)]) {
      if (folded && slugs.has(folded)) return folded;
    }
    return undefined;
  };
}
