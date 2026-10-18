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
 * SillyTavern's Macros 2.0 rides along where it says something RisuAI does not:
 * `{{if COND}}…{{else}}…{{/if}}` without the `#`, and `{{trim}}`, `{{newline}}`,
 * `{{space}}`, `{{noop}}`. RisuAI has no `if`, `else` or `/if` macro outside its
 * `#` blocks, so the two never compete for a template; where both spell the same
 * thing (`{{#if}}`, which ST reads as its `if` keeping whitespace), RisuAI wins.
 *
 * What RisuAI's functions read besides their arguments — the chat, the
 * character, the clock, the model — a host hands over as data (`CbsHostData`),
 * and a function whose data it did not hand over is left as written, like a
 * macro nobody knows. That is also how card internals stay off a reader's
 * screen: the display host never has them to give.
 *
 * Deliberately dependency-free, like `variables.ts`, so the web can import it
 * (`@shizue/core/cbs`) without the tokenizer or the card parser. No `eval`.
 */

import { dateTimeFormat, duration, isoDate, isoTime, localDate, unixTime, type CbsClock } from './cbs/dateFormat.js';
import {
  CBS_FUNCTIONS,
  decodeFile,
  makeArray,
  MAX_CBS_VALUE,
  normalizeCode,
  parseRisuArray,
  pickHashRand,
  risuEscape,
  type CbsFunction,
} from './cbs/functions.js';

export type { CbsClock } from './cbs/dateFormat.js';
export { parseRisuArray, pickHashRand, unescapeCbs } from './cbs/functions.js';

/* ------------------------------------------------------------------ parsing */

export type CbsNode = CbsText | CbsMacro | CbsBlock;

export interface CbsText {
  type: 'text';
  text: string;
}

/**
 * `{{…}}`. `start`/`end` are offsets into the source, so it can be shown as
 * written. RisuAI's `<user>`, `<char>` and `<bot>` are macros too, which RisuAI
 * rewrites to `{{user}}` and so on before it reads anything; their offsets are
 * the tag's, so one nobody answers is written back as the tag.
 */
export interface CbsMacro {
  type: 'macro';
  start: number;
  end: number;
  body: CbsNode[];
}

/**
 * The blocks RisuAI cards use, and SillyTavern's.
 *
 *   - `if`, and `if_pure`, which keeps its whitespace: RisuAI's first blocks.
 *     `when` is their successor, with operators.
 *   - `each`: RisuAI's `{{#each LIST as name}}`, or our `{{#each list}}`.
 *   - `pure`, `puredisplay`, `escape`: a body that is text, never macros —
 *     RisuAI's "pure mode". `func` too, until a `{{call}}` runs it.
 *   - `code`: a body whose result is unescaped (`\n`, `A`).
 *   - `legacy_if`: RisuAI's oldest form, `{#if X` on a line, the body, `#}`.
 *   - `st_if`: SillyTavern's `{{if COND}}`, written without the `#`.
 */
export type CbsBlockKind =
  | 'if'
  | 'if_pure'
  | 'when'
  | 'each'
  | 'pure'
  | 'puredisplay'
  | 'escape'
  | 'code'
  | 'func'
  | 'legacy_if'
  | 'st_if';

export interface CbsBlock {
  type: 'block';
  kind: CbsBlockKind;
  start: number;
  end: number;
  /** The opening macro after its keyword: the condition, or the list. */
  head: CbsNode[];
  /** For the blocks whose body is text, one text node: the body as written. */
  body: CbsNode[];
  /** What follows `{{:else}}` (`{{else}}` in `st_if`); null when there is none. */
  otherwise: CbsNode[] | null;
  /** `when` only: its body spans lines, which decides RisuAI's `{{:else}}` and whitespace. */
  multiline?: boolean;
}

/** A template strict parsing refuses. Lenient parsing never throws. */
export class CbsSyntaxError extends Error {}

/**
 * Blocks inside blocks. One more is malformed. RisuAI's parser has no such cap
 * (only its call stack of 20, for functions); presets nest toggle and model
 * conditions far deeper than a card would — the owner's "소악마" preset 39
 * levels, whose conditions all went to the model unread at the old 8. This
 * one only keeps a hostile template from exhausting the stack.
 */
export const MAX_CBS_BLOCK_DEPTH = 256;
/** Macros inside macro arguments — real cards reach six or seven. */
const MAX_MACRO_DEPTH = 16;

const OPEN_RE = /^\s*#(if_pure|if|when|each|pure_display|puredisplay|pure|escape|code|func)(?![A-Za-z0-9_])/i;

/** RisuAI's tags for the names, rewritten to macros wherever text is read. */
const TAG_RE = /<(user|char|bot)>/gi;

/** Blocks whose body is read as text, to its closer, and never parsed. */
const RAW_BODIES: ReadonlySet<CbsBlockKind> = new Set(['pure', 'puredisplay', 'escape', 'func']);

/**
 * Whether an opener opens its block. RisuAI matches `#pure`, `#puredisplay` and
 * `#code` exactly — `{{#pure x}}` opens nothing — and `#func` only with a name
 * after a space.
 */
function opens(kind: CbsBlockKind, head: CbsNode[]): boolean {
  if (kind === 'pure' || kind === 'puredisplay' || kind === 'code') {
    return head.every((node) => node.type === 'text' && node.text.trim() === '');
  }
  if (kind === 'func') return head.some((node) => node.type === 'text' && node.text.includes(' '));
  return true;
}

/** Whether a closer's normalized name ends a block: its own, none (`{{/}}`), or `/if` for `if_pure`. */
const closes = (name: string, kind: CbsBlockKind): boolean =>
  name === '' || name === normalizeName(kind) || (kind === 'if_pure' && name === 'if');

type BlockFrame = {
  type: 'block';
  kind: CbsBlockKind;
  opener: CbsMacro;
  head: CbsNode[];
  nodes: CbsNode[];
  /** The body so far, once `{{:else}}` has moved `nodes` on to the other branch. */
  body: CbsNode[] | null;
  elseMarker: CbsMacro | null;
};

type Frame =
  | { type: 'macro'; start: number; nodes: CbsNode[] }
  /** `{#if …`, RisuAI's oldest block, open until `#}`. */
  | { type: 'legacy'; start: number; nodes: CbsNode[] }
  | BlockFrame;

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
 * The condition of SillyTavern's `{{if COND}}` — or null when the macro does not
 * open one. ST reads the keyword up to whitespace or a colon, then one argument:
 * `{{if a::b}}` and `{{if:a::b}}` both test `a::b`. Only after a leading `::` do
 * further `::` separate, and `{{if::COND::THEN}}` is then ST's inline form, which
 * has no body to close; it stays a macro, as does `{{if}}` with nothing to test.
 */
function tavernIfHead(macro: CbsMacro): CbsNode[] | null {
  const opening = lead(macro);
  if (!/^if(?=[\s:])/i.test(opening)) return null;
  const tail = macro.body.slice(1);
  let rest = opening.slice(2).trimStart();
  if (rest.startsWith('::')) {
    rest = rest.slice(2);
    if (rest.includes('::') || tail.some((node) => node.type === 'text' && node.text.includes('::'))) return null;
  } else if (rest.startsWith(':')) {
    rest = rest.slice(1);
  }
  const head = [...(rest ? [{ type: 'text', text: rest } as CbsText] : []), ...tail];
  return head.some((node) => node.type !== 'text' || node.text.trim() !== '') ? head : null;
}

/**
 * Where a body read as text ends — RisuAI's "pure mode", which evaluates nothing
 * but still counts blocks, so that an inner `{{/…}}` does not end the outer one:
 * any `{{#…}}`, or `{{:…}}` but `{{:else}}`, opens a level, and any `{{/…}}` but
 * `{{//…}}` closes one. A closer inside another macro's argument closes nothing.
 * Null when the body runs to the end of the source.
 */
function scanRaw(source: string, from: number): { start: number; end: number; name: string } | null {
  // The open `{{`s by where their text starts, and -1 for each inner block.
  const open: number[] = [];
  const brace = /[{}]/g;
  let i = from;
  while (i < source.length - 1) {
    brace.lastIndex = i;
    if (!brace.exec(source)) break;
    i = brace.lastIndex - 1;
    const here = source.charCodeAt(i);
    const next = source.charCodeAt(i + 1);
    if (here === 0x7b && next === 0x7b) {
      open.push(i + 2);
      i += 2;
      continue;
    }
    const inner = open[open.length - 1];
    if (here === 0x7d && next === 0x7d && inner !== undefined && inner >= 0) {
      open.pop();
      const text = source.slice(inner, i);
      i += 2;
      if (text.startsWith('#') || text.startsWith(':')) {
        if (text !== ':else') open.push(-1);
      } else if (text.startsWith('/') && !text.startsWith('//')) {
        if (open.length === 0) return { start: inner - 2, end: i, name: text.slice(1) };
        if (open[open.length - 1] === -1) open.pop();
      }
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * RisuAI's `{{:else}}` in `#when`, read off the source. In a body on one line
 * the first `{{:else}}` splits it; in a body over several, only one standing
 * alone on its line does — written inline there it is text, as upstream — and
 * that line belongs to neither branch. Only `{{:else}}` exactly: upstream finds
 * it as text.
 */
function splitWhen(source: string, block: CbsBlock, bodyStart: number, bodyEnd: number): CbsBlock {
  const newline = source.indexOf('\n', bodyStart);
  const multiline = newline !== -1 && newline < bodyEnd;
  const alone = (node: CbsMacro): boolean => {
    const lineStart = Math.max(bodyStart, source.lastIndexOf('\n', node.start - 1) + 1);
    const next = source.indexOf('\n', node.end);
    const lineEnd = next === -1 || next > bodyEnd ? bodyEnd : next;
    return source.slice(lineStart, node.start).trim() === '' && source.slice(node.end, lineEnd).trim() === '';
  };
  const nodes = block.body;
  const at = nodes.findIndex(
    (node) =>
      node.type === 'macro' &&
      node.end - node.start === 9 &&
      source.startsWith('{{:else}}', node.start) &&
      (!multiline || alone(node)),
  );
  if (at === -1) return { ...block, multiline };
  let body = nodes.slice(0, at);
  let otherwise = nodes.slice(at + 1);
  if (multiline) {
    // What shares the else's line is whitespace: the end of the body back to its
    // last line break, and the start of the other branch up to its first.
    const last = body[body.length - 1];
    if (last?.type === 'text') {
      const cut = last.text.lastIndexOf('\n');
      body = [...body.slice(0, -1), ...(cut > 0 ? [{ type: 'text', text: last.text.slice(0, cut) } as CbsText] : [])];
    }
    const first = otherwise[0];
    if (first?.type === 'text') {
      const cut = first.text.indexOf('\n');
      const rest = cut === -1 ? '' : first.text.slice(cut + 1);
      otherwise = [...(rest ? [{ type: 'text', text: rest } as CbsText] : []), ...otherwise.slice(1)];
    }
  }
  return { ...block, body, otherwise, multiline };
}

/**
 * Pairs braces left to right, the way RisuAI does: `{{` opens, and `}}` closes the
 * innermost macro still open — or is plain text when none is.
 *
 * Lenient (the default) repairs rather than refuses, because the prompt has to say
 * *something* with a stranger's typo in it: an unclosed block is its opening macro
 * written out, a stray closer is text, and any closer ends the innermost block, as
 * in RisuAI — but ST's `{{if}}`, which only its own closer ends. Strict refuses
 * all three — the chat shows a creator their own template rather than guessing at
 * it. An unclosed `{{` is text in both, and so is an unclosed `{#if`.
 *
 * A body RisuAI reads as text (`#pure`, `#puredisplay`, `#escape`, `#func`) is
 * read to its closer here too and kept as written, so nothing in it can be
 * malformed. RisuAI's `<user>`/`<char>`/`<bot>` tags become macros wherever they
 * stand, and `{#if` (followed by a space or a line break) opens its legacy block,
 * which only `#}` closes — so a stylesheet's or a Jinja template's `{#` is text.
 */
export function parseCbs(source: string, options: { strict?: boolean } = {}): CbsNode[] {
  const strict = options.strict ?? false;
  const root: CbsNode[] = [];
  const stack: Frame[] = [];
  const top = (): CbsNode[] => stack[stack.length - 1]?.nodes ?? root;
  let macros = 0;
  let blocks = 0;
  let textStart = 0;
  /** Where the scan picks up after a body read as text; -1 when it reads on. */
  let resume = -1;

  const flush = (end: number): void => {
    if (end > textStart) append(top(), { type: 'text', text: source.slice(textStart, end) });
  };

  const deepEnough = (macro: CbsMacro): boolean => {
    if (blocks < MAX_CBS_BLOCK_DEPTH) return false;
    if (strict) throw new CbsSyntaxError('block nesting too deep');
    append(top(), macro);
    return true;
  };

  const openBlock = (macro: CbsMacro, kind: CbsBlockKind, head: CbsNode[]): void => {
    if (deepEnough(macro)) return;
    stack.push({ type: 'block', kind, opener: macro, head, nodes: [], body: null, elseMarker: null });
    blocks += 1;
  };

  /** A body read as text, up to its closer — or, when nothing closes it, an opener left as written. */
  const openRaw = (macro: CbsMacro, kind: CbsBlockKind, head: CbsNode[]): void => {
    if (deepEnough(macro)) return;
    const closer = scanRaw(source, macro.end);
    if (!closer) {
      if (strict) throw new CbsSyntaxError('unclosed block');
      append(top(), macro);
      return;
    }
    if (strict && !closes(normalizeName(closer.name), kind)) throw new CbsSyntaxError('mismatched close');
    const raw = source.slice(macro.end, closer.start);
    append(top(), {
      type: 'block',
      kind,
      start: macro.start,
      end: closer.end,
      head,
      body: raw ? [{ type: 'text', text: raw }] : [],
      otherwise: null,
    });
    resume = closer.end;
  };

  /** `{#if X`, a line break, the body, `#}`: without the line break it is text, as upstream. */
  const closeLegacy = (frame: { start: number; nodes: CbsNode[] }, end: number): void => {
    const nodes = frame.nodes;
    const at = nodes.findIndex((node) => node.type === 'text' && node.text.includes('\n'));
    if (at === -1) {
      append(top(), { type: 'text', text: '{#' });
      for (const node of nodes) append(top(), node);
      append(top(), { type: 'text', text: '#}' });
      return;
    }
    const split = nodes[at] as CbsText;
    const cut = split.text.indexOf('\n');
    const line = [...nodes.slice(0, at), { type: 'text', text: split.text.slice(0, cut) } as CbsText];
    // The frame opened on `{#if`, so the line starts with `if`.
    line[0] = { type: 'text', text: (line[0] as CbsText).text.slice(2) };
    const body = [{ type: 'text', text: split.text.slice(cut + 1) } as CbsText, ...nodes.slice(at + 1)];
    const nonEmpty = (node: CbsNode): boolean => node.type !== 'text' || node.text !== '';
    append(top(), {
      type: 'block',
      kind: 'legacy_if',
      start: frame.start,
      end,
      head: line.filter(nonEmpty),
      body: body.filter(nonEmpty),
      otherwise: null,
    });
  };

  const closeMacro = (macro: CbsMacro): void => {
    const opener = OPEN_RE.exec(lead(macro));
    if (opener) {
      const rest = lead(macro).slice(opener[0].length);
      const head = [...(rest ? [{ type: 'text', text: rest } as CbsText] : []), ...macro.body.slice(1)];
      const word = opener[1]!.toLowerCase();
      const kind = (word === 'pure_display' ? 'puredisplay' : word) as CbsBlockKind;
      if (opens(kind, head)) {
        if (RAW_BODIES.has(kind)) openRaw(macro, kind, head);
        else openBlock(macro, kind, head);
        return;
      }
    }
    const condition = tavernIfHead(macro);
    if (condition) {
      openBlock(macro, 'st_if', condition);
      return;
    }

    const literal = literalText(macro)?.trim();
    const frame = stack[stack.length - 1];
    if (literal !== undefined && literal.startsWith('/') && !literal.startsWith('//')) {
      const name = normalizeName(literal.slice(1));
      // ST's `{{if}}` closes on its own name only: any other closer inside it is
      // ST's scoped form of another macro (`{{/setvar}}`), which ST leaves as text.
      const matches =
        frame?.type === 'block' &&
        (frame.kind === 'st_if' ? name === '' || name === 'if' : !strict || closes(name, frame.kind));
      if (frame?.type === 'block' && matches) {
        stack.pop();
        blocks -= 1;
        const block: CbsBlock = {
          type: 'block',
          kind: frame.kind,
          start: frame.opener.start,
          end: macro.end,
          head: frame.head,
          body: frame.body ?? frame.nodes,
          otherwise: frame.body ? frame.nodes : null,
        };
        append(top(), frame.kind === 'when' ? splitWhen(source, block, frame.opener.end, macro.start) : block);
        return;
      }
      if (strict) throw new CbsSyntaxError(frame?.type === 'block' ? 'mismatched close' : 'stray close');
    }

    // Each dialect's else in its own blocks only: elsewhere it is text, as in both.
    // `#when`'s is RisuAI's, decided once the block is closed (`splitWhen`); `#if`
    // takes one too, where RisuAI writes it out — no card relies on seeing it.
    if (
      frame?.type === 'block' &&
      !frame.body &&
      (frame.kind === 'st_if'
        ? literal?.toLowerCase() === 'else'
        : (frame.kind === 'if' || frame.kind === 'if_pure') && literal === ':else')
    ) {
      frame.body = frame.nodes;
      frame.nodes = [];
      frame.elseMarker = macro;
      return;
    }
    append(top(), macro);
  };

  // Only a brace can open or close anything, so the scan jumps from one to the
  // next rather than stepping through the prose between them — the variable fold
  // parses every message of a branch, and most of that is prose. RisuAI's tags
  // and the legacy closer join the search only in a source that has them.
  const tags = source.includes('<') && /<(?:user|char|bot)>/i.test(source);
  const legacy = source.includes('{#');
  const brace = tags
    ? legacy
      ? /[{}]|<(?:user|char|bot)>|#\}/gi
      : /[{}]|<(?:user|char|bot)>/gi
    : legacy
      ? /[{}]|#\}/g
      : /[{}]/g;
  let i = 0;
  while (i < source.length - 1) {
    brace.lastIndex = i;
    const found = brace.exec(source);
    if (!found) break;
    i = found.index;
    const here = source.charCodeAt(i);
    const next = source.charCodeAt(i + 1);
    if (here === 0x3c) {
      // `<user>`: a macro of its own, wherever it stands.
      const end = i + found[0].length;
      flush(i);
      append(top(), { type: 'macro', start: i, end, body: [{ type: 'text', text: found[0].slice(1, -1) }] });
      i = end;
      textStart = end;
      continue;
    }
    if (here === 0x23) {
      const frame = stack[stack.length - 1];
      if (frame?.type === 'legacy') {
        flush(i);
        stack.pop();
        blocks -= 1;
        i += 2;
        textStart = i;
        closeLegacy(frame, i);
        continue;
      }
      i += 1;
      continue;
    }
    if (here === 0x7b && next === 0x23 && legacy && source.startsWith('{#if', i) && /[ \n]/.test(source[i + 4] ?? '')) {
      if (blocks >= MAX_CBS_BLOCK_DEPTH) {
        if (strict) throw new CbsSyntaxError('block nesting too deep');
        i += 2;
        continue;
      }
      flush(i);
      stack.push({ type: 'legacy', start: i, nodes: [] });
      blocks += 1;
      i += 2;
      textStart = i;
      continue;
    }
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
      if (resume !== -1) {
        i = resume;
        textStart = resume;
        resume = -1;
      }
      continue;
    }
    i += 1;
  }
  flush(source.length);

  // Whatever is still open was never closed. A macro, or a legacy `{#if`, is text
  // that happens to start with braces; a block is an error, or (leniently) its
  // parts written out.
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.type !== 'block') {
      if (frame.type === 'macro') macros -= 1;
      else blocks -= 1;
      append(top(), { type: 'text', text: frame.type === 'macro' ? '{{' : '{#' });
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
  /\s*(?:(\d+(?:\.\d+)?)|"([^"]*)"|'([^']*)'|\$([A-Za-z0-9_]+)|@([A-Za-z0-9_]+)|([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)|(==|!=|>=|<=|&&|\|\||[-+*/%^()<>=&|!≤≥≠]))/y;

type Token = { type: 'number' | 'string' | 'dollar' | 'global' | 'name' | 'op'; text: string };

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
    else if (match[5] !== undefined) tokens.push({ type: 'global', text: match[5] });
    else if (match[6] !== undefined) tokens.push({ type: 'name', text: match[6] });
    else tokens.push({ type: 'op', text: match[7]! });
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
 *     number (unset or not a number is 0), `@name` a global one the same way,
 *     `null` is 0, `=` is equality, `&`/`|`/`!` are logic, `^` is a power,
 *     `≤ ≥ ≠` are spelled out.
 *   - Ours: a bare name is a chat variable read as text (`getvar::hp` is the
 *     same name) — 0 when unset, as RisuAI reads the `null` its `getvar` writes —
 *     quoted strings compare as text, `==` and `&&`/`||` are spelled the C way.
 *
 * Precedence, loosest first: `|`, `&`, comparisons, `+ -`, `* / %`, `^`, unary
 * `- + !`. RisuAI puts `&`, `|` and the comparisons on one level, so its
 * `$a>1&$b<2` means `(($a>1)&$b)<2`; here it means what it says. Real cards
 * parenthesize, where both agree. `|` and `&` answer an operand, as JavaScript's
 * `||` and `&&` do upstream — `$hp|10` is `$hp`, or 10 when that is 0 — and
 * comparisons and `!` answer 1 or 0. Division by zero is 0, not Infinity.
 */
export function evaluateExpression(
  source: string,
  variable: (name: string) => string | undefined,
  global?: (name: string) => string | undefined,
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
      left = expressionTruthy(left) ? left : right;
    }
    return left;
  };
  const and = (): CbsExpressionValue => {
    let left = comparison();
    while (eat('&', '&&')) {
      const right = comparison();
      left = expressionTruthy(left) ? right : left;
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
    if (token.type === 'dollar' || token.type === 'global') {
      const read = token.type === 'dollar' ? variable(token.text) : global?.(token.text);
      const parsed = Number.parseFloat(read ?? '');
      return Number.isFinite(parsed) ? parsed : 0;
    }
    if (/^null$/i.test(token.text)) return 0;
    const read = variable(token.text.startsWith('getvar::') ? token.text.slice('getvar::'.length) : token.text);
    return read ?? 0;
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
  /**
   * `{{getvar}}` of a variable nobody set. RisuAI writes `null` for one, and so
   * does this — but nothing was set, so SillyTavern's `{{if}}`, to which the word
   * `null` is true, still finds it false.
   */
  unset?: boolean;
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

/** RisuAI's message roles. A host writes our `assistant` as `char`. */
export type CbsRole = 'user' | 'char' | 'system';

/** One message, as RisuAI's chat functions see it. */
export interface CbsMessage {
  role: CbsRole;
  /** What it says — the model's words or the reader's: marked, and never read as CBS. */
  data: string;
  /** When it was sent, in ms. Without it the time functions say so, as upstream does. */
  time?: number;
}

/**
 * The branch, as RisuAI's `chat` is to its chat functions. Like RisuAI, the
 * greeting is kept apart from `messages`, and indexes count from the first
 * message after it.
 */
export interface CbsChat {
  /** The branch after the greeting, oldest first — or the stretch of it that is loaded. */
  messages: readonly CbsMessage[];
  /** The branch index of `messages[0]`: 0, unless only a later stretch is loaded. */
  offset: number;
  /** How many messages follow the greeting, loaded or not — RisuAI's `chat.message.length`. */
  length: number;
  /**
   * RisuAI's `chatID`: the index of the message this text belongs to, the
   * greeting being -1. Also -1 where the text belongs to no message — the
   * prompt, as in RisuAI, whose prompt never passes one.
   */
  index: number;
  /** The greeting, and which one: -1 the first intro, k the k-th alternate (`{{firstmsgindex}}`). */
  greeting?: { text: string; index: number };
}

/** A character's card internals. The prompt's only: a reader's screen never holds them. */
export interface CbsCharacter {
  description?: string;
  personality?: string;
  scenario?: string;
  exampleDialogue?: string;
}

export interface CbsModel {
  /** `{{model}}`. */
  id: string;
  name?: string;
  shortName?: string;
  internalId?: string;
  provider?: string;
  format?: string;
  tokenizer?: string;
  /** `{{prefillsupported}}`: the provider continues an assistant prefill. */
  prefill?: boolean;
  /** `{{maxcontext}}`. */
  maxContext?: number;
  /** `{{axmodel}}`: the side tasks' model, '' for none. */
  auxiliary?: string;
}

/**
 * What RisuAI's functions read besides their arguments. Every field is
 * optional, and a function whose field is missing is left as written: a host
 * gives what it has, and what a reader must not see — card internals, on the
 * screen — it simply never gives.
 */
export interface CbsHostData {
  /**
   * Where the text goes, in RisuAI's terms. `display` draws `{{comment}}` and
   * `{{file}}` as markup; `prompt` and `fold` (RisuAI's `runVar`) do not. A host
   * with no data at all leaves those two as written.
   */
  phase?: 'prompt' | 'display' | 'fold';
  user?: string;
  /** `{{char}}`, and RisuAI's `{{bot}}`, for this text: whose card it came from, or the plot. */
  char?: string;
  character?: CbsCharacter;
  /** The reader's persona. Like `character` and `prompts`, read as CBS where it is asked for. */
  persona?: string;
  prompts?: {
    /** `{{mainprompt}}`. */
    main?: string;
    /** `{{globalnote}}`: RisuAI's global note, the post-history block here. */
    postHistory?: string;
    /** `{{authornote}}`. */
    authorNote?: string;
    /** `{{jb}}` and `{{jbtoggled}}`. */
    jailbreak?: { text: string; enabled: boolean };
  };
  /** The branch, built when first asked: most texts never ask. */
  chat?: () => CbsChat;
  /**
   * What `{{pick}}` and `{{rollp}}` draw from — RisuAI's `chaId + chat.id` and
   * `chat.message.length`: one draw for every pick in a text, a new one each
   * turn, the same one again on a reroll. `CbsHost.pick`, given, decides instead.
   */
  seed?: { key: string; length: number };
  /** `{{role}}`, already resolved through RisuAI's chain by the host. */
  role?: string;
  /** `{{isfirstmsg}}`: this text is a greeting. */
  firstMessage?: boolean;
  /** The reader's clock. Never the fold's: there the clock functions stay as written. */
  clock?: CbsClock;
  model?: CbsModel;
  /** Lore entries in RisuAI's shape, for `{{lorebook}}`; built when asked. */
  lorebook?: () => readonly object[];
  /** `{{assetlist}}`/`{{emotionlist}}`, and `{{chardisplayasset}}`. */
  assets?: { names: readonly string[]; display?: readonly string[] };
  screen?: { width: number; height: number };
  /** `{{metadata::…}}`. */
  meta?: { mobile?: boolean; language?: string; browserLanguage?: string };
  modules?: readonly { namespace: string; assets: readonly string[] }[];
  /** The manual trigger that fired, for `{{trigger_id}}`; null outside one. */
  triggerId?: string | null;
}

export interface CbsHost {
  /**
   * A chat variable, for `getvar`, `$name` and bare names; undefined when unset.
   * Without it there are no variables to read, and anything that reads one —
   * `getvar`, an expression naming one — is left as written.
   */
  variable?(name: string): string | undefined;
  /**
   * A global variable, RisuAI's: `{{getglobalvar}}`, `@name`, and `#when`'s
   * toggles (`toggle_<name>`). Undefined when unset. Without it `getglobalvar`
   * is left as written, and the others read RisuAI's unset `null`.
   */
  globalVariable?(name: string): string | undefined;
  /** The host's own macros, tried before the built-ins. Undefined: not one of them. */
  macro?(call: CbsCall): CbsValue | undefined;
  /** Blocks the language leaves to the host (`#each`). Undefined: left as written. */
  block?(block: CbsBlock, scope: CbsBlockScope): CbsValue | undefined;
  /**
   * `#each` evaluated here — RisuAI's dialect and ours — rather than asked of
   * `block`. Off until every host has moved over.
   */
  each?: boolean;
  /**
   * `#if`'s truth. The default is RisuAI's: the first word is `1` or `true`. ST's
   * `{{if}}` has its own, which no host changes.
   */
  condition?(head: CbsArg): boolean;
  /**
   * The text is SillyTavern's: `{{if $name}}` reads the global variable, as ST's
   * `$` shorthand does (`getglobalvar`), and `.name` the chat's. Elsewhere both
   * read the chat's.
   */
  sillyTavern?: boolean;
  /** [0, 1), for `random`, `roll`, `randint` and `dice`. */
  random?(): number;
  /**
   * Which of `count` options a `{{pick}}` at this macro takes. Given, it decides;
   * otherwise `data.seed` makes RisuAI's draw, and without either a pick is random.
   */
  pick?(count: number, macro: CbsMacro): number;
  /** What RisuAI's functions read besides their arguments. */
  data?: CbsHostData;
  /** The author's own text, read as part of an argument. */
  text?(raw: string): CbsValue;
  /** A macro's result, written out. Text the author wrote never passes here. */
  emit?(value: CbsValue): string;
  /** Called for every node evaluated; throw to stop. */
  visit?(): void;
  /** Called before every `#each` iteration this module runs; throw to stop. */
  iterate?(): void;
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

/**
 * `#when`'s: blank lines at either end of a block over several lines — which it
 * is when its source was, or its result is.
 */
const trimBlankLines = (text: string, multiline: boolean): string => {
  if (!multiline && !text.includes('\n')) return text;
  const lines = text.split('\n');
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.join('\n');
};

const indentOf = (line: string): number => line.length - line.replace(/^[ \t]+/, '').length;

/**
 * ST `{{if}}`'s: the branch trimmed and dedented by its first non-blank line's
 * indent, a line indented less losing all of its own. Unlike `#if`, a deeper
 * indent (a nested list) keeps its shape.
 */
const dedent = (text: string): string => {
  const lines = text.split('\n');
  const first = lines.find((line) => line.trim() !== '');
  const indent = first === undefined ? 0 : indentOf(first);
  if (indent === 0) return text.trim();
  return lines
    .map((line) => (indentOf(line) >= indent ? line.slice(indent) : line.trimStart()))
    .join('\n')
    .trim();
};

/** ST's false condition: empty, or `false`, `off` or `0` in any case. Anything else holds. */
const isTavernFalse = (text: string): boolean =>
  text === '' || ['false', 'off', '0'].includes(text.trim().toLowerCase());

/** A macro called with nothing: a bare name in ST's `{{if}}`. */
const NO_ARGS: CbsArgs = { length: 0, at: () => undefined, rest: () => undefined };

/** An item of a JSON array as text: a string as it is, anything else as JSON. */
const itemText = (item: unknown): string => (typeof item === 'string' ? item : (JSON.stringify(item) ?? ''));

/** A JSON array written out in full, or null. */
function jsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `{{random}}`'s options: several arguments, one in brackets read as RisuAI reads
 * an array (JSON, or failing that its `§` list — so a broken one is one option),
 * or one list split on `,`/`:`. Options are trimmed, which RisuAI does not do:
 * `{{random:a, b}}` picks `b`, not ` b`.
 */
function options(args: CbsArgs): { list: string[]; untrusted: boolean; deferred: boolean } {
  const values = Array.from({ length: args.length }, (_, i) => args.at(i + 1)!.value());
  const untrusted = values.some((value) => value.untrusted);
  const deferred = values.some((value) => value.deferred);
  if (values.length !== 1) return { list: values.map((value) => value.text.trim()), untrusted, deferred };
  const only = values[0]!.text.trim();
  if (only.startsWith('[') && only.endsWith(']')) return { list: parseRisuArray(only).map(itemText), untrusted, deferred };
  // `\,` is a literal comma, as in RisuAI.
  const list = only
    .replace(/\\,/g, '\u0000')
    .split(/[:,]/)
    .map((option) => option.replace(/\u0000/g, ',').trim());
  return { list, untrusted, deferred };
}

/**
 * Dice past this are not a roll anyone wrote, just a loop someone wants run.
 * RisuAI has no cap; past this a roll answers `NaN`, as a roll it cannot read does.
 */
const MAX_DICE = 1_000;

/**
 * `N`, `dN` or `XdY`, as RisuAI reads them: an empty side of the `d` is 1 die or
 * 6 sides, a fraction of a die still rolls one, and anything else is `NaN`.
 * `draw(i)` is die `i`'s roll in [0, 1).
 */
function rollDice(notation: string, draw: (die: number) => number): string {
  const halves = notation.split('d');
  let count = 1;
  let sides = 6;
  if (halves.length === 2) {
    count = Number(halves[0] || 1);
    sides = Number(halves[1] || 6);
  } else if (halves.length === 1) {
    sides = Number(halves[0]);
  }
  if (Number.isNaN(count) || Number.isNaN(sides) || count < 1 || sides < 1 || count > MAX_DICE) return 'NaN';
  let total = 0;
  for (let die = 0; die < count; die += 1) total += Math.floor(draw(die) * sides) + 1;
  return total.toString();
}

/**
 * RisuAI's call stack: `{{call}}`s and the character fields read as CBS, twenty
 * deep — counted over the whole evaluation, as upstream counts them, which also
 * keeps a function that calls itself twice from running a million times.
 */
const MAX_INVOCATIONS = 20;
const CALL_LIMIT = 'ERROR: Call stack limit reached';

/** `#each` iterations in one evaluation, every block together, for hosts that bound nothing themselves. */
const MAX_EACH_ITERATIONS = 5_000;

/** What RisuAI's functions may build in one evaluation, all together, before they stop answering. */
const MAX_PRODUCED = 2_000_000;

/** The RisuAI this port follows, for `{{metadata::version}}`. */
const RISU_VERSION = '2026.8.250';

/** `{{return}}`, unwinding to the evaluation — or the call — it ends. */
class Return {
  constructor(readonly value: CbsValue) {}
}

/** A value read where HTML is written: escaped, so it is never markup. */
const escapeMarkup = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** `{{bkspc}}`: what came before, without its last word — RisuAI's loop, quirks and all. */
function backspace(text: string): string {
  if (!text) return text;
  const root = text.trimEnd();
  let at = root.length - 1;
  for (; at >= 0; at -= 1) {
    const char = root[at];
    if (at === 0) break;
    if (char === ' ' || char === '\n' || char === '\t') break;
  }
  return root.substring(0, Math.max(at, 0)).trimEnd();
}

/** `{{erase}}`: what came before, back to the end of the sentence before the last. */
function erase(text: string): string {
  if (!text) return text;
  const root = text.trimEnd();
  let at = root.length - 1;
  let found = false;
  for (; at >= 0; at -= 1) {
    const char = root[at];
    if (char === '.' || char === '!' || char === '?' || char === '\n') {
      found = true;
      break;
    }
    if (at === 0) break;
  }
  if (at === -1) at = 0;
  else if (found) at += 1;
  return root.substring(0, at).trimEnd();
}

/**
 * RisuAI's `trimLines` over an `#each` body before anything in it runs: every
 * line's indent off, and the whole trimmed. Upstream does it to the text it then
 * pastes the items into, so an item keeps its own whitespace; here it is done to
 * the author's text — the body, and the blocks in it — and never to a value.
 */
function unindentNodes(nodes: CbsNode[]): CbsNode[] {
  const lines = (list: CbsNode[]): CbsNode[] =>
    list.map((node): CbsNode => {
      if (node.type === 'text') return { type: 'text', text: node.text.replace(/\n[^\S\n]+/g, '\n') };
      if (node.type === 'block') {
        return { ...node, body: lines(node.body), otherwise: node.otherwise && lines(node.otherwise) };
      }
      return node;
    });
  const out = lines(nodes);
  const first = out[0];
  if (first?.type === 'text') out[0] = { type: 'text', text: first.text.trimStart() };
  const last = out[out.length - 1];
  if (last?.type === 'text') out[out.length - 1] = { type: 'text', text: last.text.trimEnd() };
  return out;
}

/** The chat functions: answered from `data.chat`, which is only built for them. */
const CHAT_FUNCTIONS: ReadonlySet<string> = new Set([
  'chatindex',
  'firstmsgindex',
  'firstmessageindex',
  'lastmessage',
  'lastmessageid',
  'lastmessageindex',
  'previouscharchat',
  'lastcharmessage',
  'previoususerchat',
  'lastusermessage',
  'previouschatlog',
  'history',
  'messages',
  'userhistory',
  'usermessages',
  'charhistory',
  'charmessages',
  'messageunixtimearray',
  'messagetime',
  'messagedate',
  'messageidleduration',
]);

/** Likewise `{{newline::N}}` and `{{space::N}}`: past this, a memory bomb rather than layout. */
const MAX_REPEAT = 100;

/**
 * Where a bare `{{trim}}` stood. ST deletes it once everything else is expanded,
 * with every line break directly around it — across block and macro boundaries,
 * so it is a mark in the output rather than an edit of the tree. Control
 * characters, like ST's own else marker: no template writes them, and a value that
 * smuggles one in only costs the text its line breaks.
 */
const TRIM_MARK = '\u0000\u001Ftrim\u001F\u0000';
const TRIM_RE = /(?:\r?\n)*\u0000\u001Ftrim\u001F\u0000(?:\r?\n)*/g;

/** One RisuAI parse: its temporary variables, and the functions defined in it (shared with its calls). */
interface Invocation {
  temps: Map<string, CbsValue> | null;
  functions: Map<string, { source: string; nodes?: CbsNode[] }> | null;
}

/** An `#each` item, under the name RisuAI's form gives it — null for one of ours. */
interface Slot {
  name: string | null;
  item: string;
}

/**
 * Evaluates parsed nodes against a host. `source` is the text they were parsed
 * from, which is how a macro nobody understands is written back out as it was.
 *
 * An unknown macro is left exactly as written, its arguments unevaluated — the
 * reason `{{setvar::x::{{getvar::y}}}}` survives the prompt for the history fold
 * to replay. Exceptions from the host's hooks pass through untouched: a budget
 * that ran out is the host's to report, not this module's to hide.
 *
 * One call is one RisuAI parse: `{{settempvar}}`, `{{#func}}` and `{{pick}}`'s
 * draw last as long as it does, and `{{return}}` ends it with its argument.
 */
export function evaluateCbs(source: string, nodes: CbsNode[], host: CbsHost = {}): string {
  const random = host.random ?? Math.random;
  const data = host.data;

  /** The text being evaluated: `source`, or a function's body or a field read as CBS inside it. */
  let text = source;
  let invocation: Invocation = { temps: null, functions: null };
  /** The `#each` items around the node being evaluated, outermost first. */
  let slots: Slot[] = [];
  /** The arguments of the `{{call}}` being run: `{{arg::0}}` is the function's name. */
  let callArgs: CbsValue[] = [];
  let invocations = 1;
  let iterations = 0;
  let produced = 0;
  let pickDraw: number | undefined;
  let chat: CbsChat | undefined;
  /** Every running `sequence`'s text so far, innermost last — what `{{bkspc}}` edits. */
  const buffers: { text: string }[] = [];
  /** Values whose text is output already — a call run in `out` mode — which `settle` must not emit twice. */
  const written = new WeakSet<CbsValue>();

  const textValue = (raw: string): CbsValue => host.text?.(raw) ?? { text: raw };
  const verbatim = (node: CbsMacro | CbsBlock): CbsValue => textValue(text.slice(node.start, node.end));
  /** As written, because answering would take a variable the host does not have. */
  const deferred = (node: CbsMacro | CbsBlock): CbsValue => ({ ...verbatim(node), deferred: true });

  const sequence = (list: CbsNode[], mode: CbsMode, slot: string | null): CbsValue => {
    const buffer = { text: '' };
    let untrusted = false;
    let waiting = false;
    let unset = false;
    let other = false;
    buffers.push(buffer);
    try {
      for (const node of list) {
        host.visit?.();
        const part = evaluate(node, mode, slot);
        buffer.text += part.text;
        if (part.untrusted) untrusted = true;
        if (part.deferred) waiting = true;
        if (part.unset) unset = true;
        else if (part.text !== '') other = true;
        host.grow?.(buffer.text.length);
      }
    } finally {
      buffers.pop();
    }
    return {
      text: buffer.text,
      untrusted,
      ...(waiting ? { deferred: true } : {}),
      ...(unset && !other ? { unset: true } : {}),
    };
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
    mode === 'out' ? { text: host.emit && !written.has(value) ? host.emit(value) : value.text } : value;

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

    switch (node.kind) {
      case 'if':
      case 'if_pure': {
        if (head.value().deferred) return settle(deferred(node), mode);
        const holds = host.condition ? host.condition(head) : isCbsTrue(head.value().text);
        const trim = node.kind === 'if' ? trimLines : (body: string) => body;
        return branch(holds ? node.body : node.otherwise, trim);
      }
      case 'when': {
        const decided = when(node.head, slot);
        if (decided === null) return settle(deferred(node), mode);
        const { holds, whitespace } = decided;
        const trim =
          whitespace === 'keep'
            ? (body: string) => body
            : whitespace === 'legacy'
              ? trimLines
              : (body: string) => trimBlankLines(body, node.multiline === true);
        return branch(holds ? node.body : node.otherwise, trim);
      }
      case 'st_if': {
        const { negated, value } = tavernCondition(node, slot);
        if (value.deferred) return settle(deferred(node), mode);
        const falsy = value.unset === true || isTavernFalse(value.text);
        return branch(falsy === negated ? node.body : node.otherwise, dedent);
      }
      case 'legacy_if': {
        // RisuAI's oldest truth: anything but nothing, `0` or `-1` — read off the
        // line as `if X` splits on its first space, so `{#if\n` holds.
        const condition = head.value();
        if (condition.deferred) return settle(deferred(node), mode);
        const word = `if${condition.text}`.split(' ', 2)[1];
        return branch(word !== undefined && ['', '0', '-1'].includes(word) ? null : node.body, (body) => body.trim());
      }
      case 'pure':
      case 'puredisplay':
      case 'escape':
        return raw(node, head, mode);
      case 'code': {
        // Evaluated as values, so the unescaping runs on what a variable says too
        // — and what it makes of one is shown as text, never read as markup.
        const value = sequence(node.body, 'arg', slot);
        if (value.deferred) return settle(deferred(node), mode);
        return settle({ text: normalizeCode(value.text), untrusted: value.untrusted }, mode);
      }
      case 'func':
        define(node, head);
        return { text: '' };
      case 'each':
        if (host.each) return each(node, head, mode);
    }
    const hosted = host.block?.(node, {
      head,
      mode,
      render: (list, itemSlot) => sequence(list, mode, itemSlot),
    });
    return hosted ?? settle(verbatim(node), mode);
  }

  /**
   * `#pure`, `#puredisplay` and `#escape`: the body as written, with RisuAI's
   * `<user>` tags rewritten as it rewrites them before reading anything. The
   * author's text, so it is written out as text nodes are; what it becomes is
   * inert to a later pass — `#puredisplay`'s braces backslashed, `#escape`'s
   * swapped for RisuAI's display escapes — for the host to turn back where it
   * finally shows the text (`unescapeCbs`).
   */
  function raw(node: CbsBlock, head: CbsArg, mode: CbsMode): CbsValue {
    const body = ((node.body[0] as CbsText | undefined)?.text ?? '').replace(TAG_RE, '{{$1}}');
    const out =
      node.kind === 'pure'
        ? body.trim()
        : node.kind === 'puredisplay'
          ? body.trim().replaceAll('{{', '\\{\\{').replaceAll('}}', '\\}\\}')
          : risuEscape(head.value().text.trim() === '::keep' ? body : body.trim());
    return mode === 'out' ? { text: out } : textValue(out);
  }

  /** `{{#func name …}}`: kept, as written, for a `{{call::name}}` later in this evaluation. */
  function define(node: CbsBlock, head: CbsArg): void {
    const name = `#func${head.value().text}`.split(' ')[1];
    if (name === undefined) return;
    const body = ((node.body[0] as CbsText | undefined)?.text ?? '').trim();
    (invocation.functions ??= new Map()).set(name, { source: body });
  }

  /**
   * `#each`, in two dialects told apart by an ` as `.
   *
   * RisuAI's is `{{#each LIST as name}}…{{slot::name}}…{{/each}}`: LIST is a JSON
   * array, or failing that text split on `§`, so a bare name is one item, its own
   * spelling; an item that is not a string is written as JSON. Its whitespace is
   * RisuAI's — the body's lines unindented and the whole trimmed, unless the
   * block opens `{{#each::keep …}}`. RisuAI's older `{{#each LIST name}}`, which
   * names the item after the last space, is read too when LIST is a JSON array:
   * otherwise it cannot be told from a list of ours with spaces in it.
   *
   * Ours is `{{#each list}}…{{slot}}…{{/each}}` over a comma-separated list: a
   * bare name is a variable holding one, anything else the list written out.
   *
   * One difference is deliberate: RisuAI pastes each item into the body and reads
   * the result as CBS, so an item holding a macro runs. Here an item is a value,
   * marked like a variable, and never syntax.
   */
  function each(node: CbsBlock, head: CbsArg, mode: CbsMode): CbsValue {
    const value = head.value();
    if (value.deferred) return settle(deferred(node), mode);
    let list = value.text.trim();
    let keep = false;
    if (list.startsWith('::keep ')) {
      keep = true;
      list = list.slice(7).trim();
    }
    if (list.startsWith('as ')) list = list.slice(3).trim();
    const as = list.lastIndexOf(' as ');
    const space = list.lastIndexOf(' ');
    const compat = as === -1 && space !== -1 ? jsonArray(list.slice(0, space)) : null;
    let name: string | null = null;
    let items: string[];
    if (as !== -1) {
      name = list.slice(as + 4).trim();
      items = parseRisuArray(list.slice(0, as)).map(itemText);
    } else if (compat) {
      name = list.slice(space + 1);
      items = compat.map(itemText);
    } else {
      let spelled = list;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(list)) {
        if (!host.variable) return settle(deferred(node), mode);
        spelled = host.variable(list) ?? '';
      }
      items = spelled
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    const risu = name !== null && !keep;
    const body = risu ? unindentNodes(node.body) : node.body;
    let out = '';
    let untrusted = false;
    for (const item of items) {
      if ((iterations += 1) > MAX_EACH_ITERATIONS || out.length > MAX_CBS_VALUE) break;
      host.iterate?.();
      slots.push({ name, item });
      let part: CbsValue;
      try {
        part = sequence(body, mode, item);
      } finally {
        slots.pop();
      }
      out += part.text;
      if (part.untrusted) untrusted = true;
      host.grow?.(out.length);
    }
    return { text: risu ? out.trim() : out, untrusted };
  }

  /**
   * `{{#when X}}`, or `{{#when::A::op::B}}` read right to left as RisuAI does:
   * each step pops a value and the operator before it, and a binary operator
   * pops its left operand too. `var`, `vis` and `visnot` read a variable as
   * `getvar` does, unset being `null`; `toggle`, `tis` and `tisnot` read RisuAI's
   * global `toggle_<name>`, unset (or with no globals) `null` as well.
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
    const read = (name: string): string => host.variable?.(name) ?? 'null';
    const toggle = (name: string): string => host.globalVariable?.(`toggle_${name}`) ?? 'null';
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
          statement.push(truth(toggle(condition)));
          break;
        case 'tis':
          statement.push(toggle(statement.pop() ?? '') === condition ? '1' : '0');
          break;
        case 'tisnot':
          statement.push(toggle(statement.pop() ?? '') !== condition ? '1' : '0');
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

  /**
   * ST `{{if}}`'s condition: a `!` in front inverts it, and nested macros are
   * answered first. Written out, it may also name a chat variable — `.name`, or
   * `$name`, ST's global, which reads the chat's too since there are no globals —
   * or a macro called with nothing (`{{if char}}` asks `{{char}}`); a name nothing
   * answers is just its text. ST looks a nested macro's answer up the same way,
   * which would let a value choose the variable or the macro; here a composed
   * condition is only ever its text.
   */
  function tavernCondition(node: CbsBlock, slot: string | null): { negated: boolean; value: CbsValue } {
    const list = [...node.head];
    const first = list[0];
    let negated = false;
    if (first?.type === 'text') {
      const bang = /^\s*!\s*/.exec(first.text);
      negated = bang !== null;
      list[0] = { type: 'text', text: first.text.slice(bang?.[0].length ?? 0).trimStart() };
    }
    const last = list[list.length - 1];
    if (last?.type === 'text') list[list.length - 1] = { type: 'text', text: last.text.trimEnd() };

    const condition = argOf(list, slot);
    const value = condition.value();
    if (!condition.literal) return { negated, value };
    const variable = /^[.$]([A-Za-z](?:[\w-]*\w)?)$/.exec(value.text);
    if (variable) {
      const read = host.sillyTavern && value.text.startsWith('$') ? host.globalVariable : host.variable;
      if (!read) return { negated, value: { text: value.text, deferred: true } };
      return { negated, value: { text: read(variable[1]!) ?? '', untrusted: true } };
    }
    if (!/^[A-Za-z][\w-]*$/.test(value.text)) return { negated, value };
    const called = answer({
      name: normalizeName(value.text),
      args: NO_ARGS,
      macro: { type: 'macro', start: node.start, end: node.end, body: list },
      mode: 'arg',
      slot,
    });
    return { negated, value: called ?? value };
  }

  /** `{{? …}}` and `{{calc::…}}`. Reading a variable marks the answer. */
  function expression(arg: CbsArg | undefined, node: CbsMacro): CbsValue {
    if (!host.variable) return deferred(node);
    if (!arg) return verbatim(node);
    const read = host.variable;
    try {
      const value = evaluateExpression(
        arg.value().text,
        (name) => read(name),
        (name) => host.globalVariable?.(name),
      );
      return { text: typeof value === 'number' ? formatCbsNumber(value) : value, untrusted: true };
    } catch (error) {
      if (error instanceof CbsExpressionError) return verbatim(node);
      throw error;
    }
  }

  /** An argument that is already a value. */
  const fixed = (value: CbsValue): CbsArg => ({ literal: false, value: () => value });

  /**
   * `{{spread::LIST}}` written as a whole argument: its items, as arguments of
   * their own. RisuAI gets that by pasting `a::b` into the macro and splitting it
   * again; here a value never becomes separators, so this is the one place an
   * argument turns into several — asked for by name, by the author.
   */
  function spread(part: CbsNode[], slot: string | null): CbsArg[] | null {
    const only = part[0];
    if (part.length !== 1 || only?.type !== 'macro' || !/^[\s_-]*s/i.test(lead(only))) return null;
    const { name, parts } = splitMacro(only);
    if (name !== 'spread' || parts.length < 2) return null;
    const list = argOf(parts[1]!, slot).value();
    const marks = { untrusted: list.untrusted, ...(list.deferred ? { deferred: true } : {}) };
    return parseRisuArray(list.text)
      .join('::')
      .split('::')
      .map((item) => fixed({ text: item, ...marks }));
  }

  /** A macro's arguments, each evaluated when first read. */
  function argsOf(parts: CbsNode[][], separator: string, slot: string | null): CbsArgs {
    const list: CbsArg[] = [];
    let spliced = false;
    for (const part of parts.slice(1)) {
      const items = spread(part, slot);
      if (items) {
        list.push(...items);
        spliced = true;
      } else {
        list.push(argOf(part, slot));
      }
    }
    const rests = new Map<number, CbsArg>();
    return {
      length: list.length,
      at: (index) => list[index - 1],
      rest: (index) => {
        if (index < 1 || index > list.length) return undefined;
        if (index === list.length) return list[index - 1];
        let kept = rests.get(index);
        if (!kept) {
          if (spliced) {
            const tail = list.slice(index - 1);
            let joined: CbsValue | undefined;
            kept = {
              literal: false,
              value: () => {
                if (joined) return joined;
                const values = tail.map((arg) => arg.value());
                return (joined = derived(values.map((value) => value.text).join(separator), values));
              },
            };
          } else {
            const nodesFrom = parts.slice(index).flatMap((part, i) =>
              i === 0 ? part : [{ type: 'text', text: separator } as CbsText, ...part],
            );
            kept = argOf(nodesFrom, slot);
          }
          rests.set(index, kept);
        }
        return kept;
      },
    };
  }

  function macro(node: CbsMacro, mode: CbsMode, slot: string | null): CbsValue {
    const opening = lead(node);
    if (opening.startsWith('//')) return { text: '' };
    if (/^\?\s/.test(opening)) {
      const first = node.body[0] as CbsText;
      const rest = first.text.trimStart().slice(1);
      return expression(argOf([{ type: 'text', text: rest }, ...node.body.slice(1)], slot), node);
    }

    const { name: written, parts, separator } = splitMacro(node);
    if (written === null) return verbatim(node);
    // RisuAI's alias, resolved before any host is asked: one that answers `char` answers `bot`.
    const name = written === 'bot' ? 'char' : written;
    const args = argsOf(parts, separator, slot);

    // RisuAI reads `{{call::…}}` before any function, spelled exactly so.
    const first = node.body[0];
    if (name === 'call' && first?.type === 'text' && first.text.startsWith('call::')) {
      const called = callFunction(args, mode);
      if (called) return called.deferred ? deferred(node) : called;
    }

    const result = answer({ name, args, macro: node, mode, slot }) ?? verbatim(node);
    // An answer built on a variable the host does not have is no answer: the
    // macro is written as itself, inner text and all, for a later pass to decide.
    return result.deferred ? deferred(node) : result;
  }

  /**
   * A text of its own, evaluated in place — a function's body, or a field read
   * as CBS — the way RisuAI runs another parse: its own temporary variables, no
   * `#each` items or call arguments from around it, and a `{{return}}` that ends
   * it alone. In `out` mode its text is output already.
   */
  function invoke(body: string, list: CbsNode[], mode: CbsMode, frame: Invocation, args: CbsValue[]): CbsValue {
    const saved = { text, invocation, slots, callArgs };
    text = body;
    invocation = frame;
    slots = [];
    callArgs = args;
    try {
      const value = sequence(list, mode, null);
      if (mode === 'out') written.add(value);
      return value;
    } catch (error) {
      if (error instanceof Return) return error.value;
      throw error;
    } finally {
      ({ text, invocation, slots, callArgs } = saved);
    }
  }

  /**
   * `{{call::name::a::b}}`: a function `{{#func}}` defined earlier in this
   * evaluation, run with `{{arg::1}}` as `a` — and `{{arg::0}}` its name, as
   * upstream. RisuAI pastes the arguments into the body as text and reads it
   * again; here they are values, like an `#each` item. Undefined when no such
   * function was defined, which leaves the macro as written.
   */
  function callFunction(args: CbsArgs, mode: CbsMode): CbsValue | undefined {
    const name = args.at(1)?.value();
    const defined = name && !name.deferred ? invocation.functions?.get(name.text) : undefined;
    if (!name || !defined) return undefined;
    const values = [name, ...Array.from({ length: args.length - 1 }, (_, i) => args.at(i + 2)!.value())];
    if (values.some((value) => value.deferred)) return { text: '', deferred: true };
    if ((invocations += 1) > MAX_INVOCATIONS) return { text: CALL_LIMIT };
    defined.nodes ??= parseCbs(defined.source);
    return invoke(defined.source, defined.nodes, mode, { temps: null, functions: invocation.functions }, values);
  }

  /**
   * A field the host gave — a character's description, the persona, a prompt —
   * read as CBS, as RisuAI reads it, with the same host. Undefined when the host
   * gave none, which leaves the macro as written.
   */
  function reparse(field: string | undefined, mode: CbsMode): CbsValue | undefined {
    if (field === undefined) return undefined;
    if ((invocations += 1) > MAX_INVOCATIONS) return { text: CALL_LIMIT };
    return invoke(field, parseCbs(field), mode, { temps: null, functions: null }, []);
  }

  /** The host's macro, else the language's; undefined when neither knows the name. */
  function answer(call: CbsCall): CbsValue | undefined {
    return host.macro?.(call) ?? builtin(call);
  }

  /** A function of its arguments: marked when any argument it read was. */
  const derived = (text: string, values: CbsValue[]): CbsValue => ({
    text,
    untrusted: values.some((value) => value.untrusted),
    ...(values.some((value) => value.deferred) ? { deferred: true } : {}),
  });

  /** Every argument's value, in order. */
  const valuesOf = (args: CbsArgs): CbsValue[] =>
    Array.from({ length: args.length }, (_, i) => args.at(i + 1)!.value());

  /** Waiting on a variable the host does not have: `macro` writes the macro out whole. */
  const WAITING: CbsValue = { text: '', deferred: true };

  /**
   * One of RisuAI's functions of their arguments (`cbs/functions.ts`). One that
   * throws is left as written, as RisuAI's matcher leaves it; so is one past the
   * size a single function may build, or past what all of them together may.
   */
  function pure(run: CbsFunction, args: CbsArgs): CbsValue | undefined {
    const values = valuesOf(args);
    if (values.some((value) => value.deferred)) return WAITING;
    let out: string;
    try {
      out = run(values.map((value) => value.text));
    } catch {
      return undefined;
    }
    if (out.length > MAX_CBS_VALUE || (produced += out.length) > MAX_PRODUCED) return undefined;
    return derived(out, values);
  }

  /** RisuAI's draw for `{{pick}}`: one per evaluation, so every pick in a text agrees. */
  const pickValue = (seed: { key: string; length: number }): number =>
    (pickDraw ??= pickHashRand(seed.length, seed.key));

  /**
   * An argument written where markup is built: the author's text as written, a
   * value escaped — it is never markup. RisuAI writes a missing one as `undefined`.
   */
  const markupArg = (arg: CbsArg | undefined): string =>
    arg === undefined ? 'undefined' : arg.literal ? arg.value().text : escapeMarkup(arg.value().text);

  function builtin(call: CbsCall): CbsValue | undefined {
    const { name, args, macro: node } = call;
    const value = (index: number): CbsValue => args.at(index)?.value() ?? { text: '' };

    switch (name) {
      case 'getvar': {
        if (!host.variable) return deferred(node);
        // RisuAI reads the first argument alone; trimmed, as the fold writes keys.
        const key = args.at(1)?.value();
        if (key?.deferred) return WAITING;
        const read = host.variable(key?.text.trim() ?? '');
        return read === undefined ? { text: 'null', unset: true } : { text: read, untrusted: true };
      }
      case 'getglobalvar': {
        if (!host.globalVariable) return undefined;
        const key = value(1);
        if (key.deferred) return WAITING;
        return { text: host.globalVariable(key.text) ?? 'null', untrusted: true };
      }
      case 'calc':
        return expression(args.rest(1), node);
      case 'random':
      case 'pick': {
        const seed = name === 'pick' && !host.pick ? data?.seed : undefined;
        const draw = (): number => (seed ? pickValue(seed) : random());
        if (args.length === 0) {
          return { text: name === 'pick' && host.pick ? String(host.pick(1_000_000, node) / 1_000_000) : String(draw()) };
        }
        const { list, untrusted, deferred: waiting } = options(args);
        if (waiting) return WAITING;
        const index = name === 'pick' && host.pick ? host.pick(list.length, node) : Math.floor(draw() * list.length);
        return { text: list[index] ?? '', untrusted };
      }
      case 'roll':
      case 'rollp': {
        if (args.length === 0) return { text: '1' };
        const notation = value(1);
        if (notation.deferred) return WAITING;
        // `rollp`'s die i is RisuAI's pick draw i * 15 turns on.
        const seed = name === 'rollp' ? data?.seed : undefined;
        const draw = (die: number): number => (seed ? pickHashRand(seed.length + die * 15, seed.key) : random());
        return derived(rollDice(notation.text.trim().toLowerCase(), draw), [notation]);
      }
      case 'dice': {
        // `XdY`, both written: RisuAI's stricter roll.
        if (args.length === 0) return undefined;
        const notation = value(1);
        if (notation.deferred) return WAITING;
        const [count, sides] = notation.text.split('d').map(Number);
        if (count === undefined || sides === undefined || Number.isNaN(count) || Number.isNaN(sides) || count > MAX_DICE) {
          return derived('NaN', [notation]);
        }
        let total = 0;
        for (let die = 0; die < count; die += 1) total += Math.floor(random() * sides) + 1;
        return derived(total.toString(), [notation]);
      }
      case 'randint': {
        const values = valuesOf(args);
        if (values.some((one) => one.deferred)) return WAITING;
        const low = Number(values[0]?.text);
        const high = Number(values[1]?.text);
        if (Number.isNaN(low) || Number.isNaN(high)) return derived('NaN', values);
        return derived((Math.floor(random() * (high - low + 1)) + low).toString(), values);
      }
      case 'br':
      case 'newline':
      case 'space': {
        // `br` is RisuAI's own name for it and `newline` its alias; ST's takes a
        // count — a whole number, as ST checks it, or the macro is left as written.
        const unit = name === 'space' ? ' ' : '\n';
        if (args.length === 0) return { text: unit };
        const count = value(1);
        if (count.deferred) return derived('', [count]);
        const digits = count.text.trim();
        if (args.length > 1 || !/^\d+$/.test(digits) || Number(digits) > MAX_REPEAT) return undefined;
        return derived(unit.repeat(Number(digits)), [count]);
      }
      case 'noop':
        return args.length === 0 ? { text: '' } : undefined;
      case 'trim':
        // Bare, ST's: see TRIM_MARK. With an argument, RisuAI's string trim, below.
        if (args.length === 0) return { text: TRIM_MARK };
        break;
      case 'tempvar':
      case 'gettempvar': {
        // RisuAI's are text (`''` unset), and last as long as the evaluation.
        const key = args.length > 0 ? value(1).text : 'undefined';
        return invocation.temps?.get(key) ?? { text: '' };
      }
      case 'settempvar': {
        const key = args.length > 0 ? value(1).text : 'undefined';
        const stored = value(2);
        (invocation.temps ??= new Map()).set(key, { text: stored.text, untrusted: stored.untrusted });
        return { text: '' };
      }
      case 'return': {
        const returned = args.length > 0 ? value(1) : { text: 'null' };
        throw new Return({ text: returned.text, untrusted: returned.untrusted });
      }
      case 'bkspc':
      case 'erase': {
        // Edits what this macro's own block, argument or text has written so far.
        const buffer = buffers[buffers.length - 1];
        if (buffer) buffer.text = name === 'bkspc' ? backspace(buffer.text) : erase(buffer.text);
        return { text: '' };
      }
      case 'arg': {
        // RisuAI replaces exactly `{{arg::N}}` in a function's body; anything else stays.
        const index = /^\{\{arg::(0|[1-9]\d*)\}\}$/.exec(text.slice(node.start, node.end));
        const found = index ? callArgs[Number(index[1])] : undefined;
        return found ? { text: found.text, untrusted: found.untrusted } : undefined;
      }
      case 'slot': {
        if (args.length === 0) {
          const item = slots[slots.length - 1]?.item ?? call.slot;
          return item === null || item === undefined ? undefined : { text: item, untrusted: true };
        }
        // RisuAI pastes each item over its exact `{{slot::name}}`, outer blocks
        // first — so an outer name wins over an inner one of the same spelling.
        // Inside one of ours, any `{{slot::…}}` is the current item.
        const spelled = text.slice(node.start, node.end);
        const innermost = slots[slots.length - 1];
        const found =
          slots.find((one) => one.name !== null && spelled === `{{slot::${one.name}}}`) ??
          (innermost?.name === null ? innermost : undefined);
        return found ? { text: found.item, untrusted: true } : undefined;
      }
      case 'unixtime':
      case 'isotime':
      case 'isodate': {
        const clock = data?.clock;
        if (!clock) return undefined;
        return { text: name === 'unixtime' ? unixTime(clock) : name === 'isotime' ? isoTime(clock) : isoDate(clock) };
      }
      case 'date':
      case 'time':
      case 'datetimeformat': {
        const clock = data?.clock;
        if (!clock) return undefined;
        // Without arguments, `date` and `time` are the host's: ours speak the reader's language.
        if (args.length === 0) return name === 'datetimeformat' ? { text: localDate(clock) } : undefined;
        const values = valuesOf(args);
        if (values.some((one) => one.deferred)) return WAITING;
        let time = 0;
        if (values[1]?.text) {
          time = Number(values[1].text) / 1000;
          if (Number.isNaN(time)) time = 0;
        }
        try {
          return derived(dateTimeFormat(values[0]!.text, time, clock), values);
        } catch {
          return undefined;
        }
      }
      case 'ruby':
      case 'furigana':
        return {
          text: `<ruby>${markupArg(args.at(1))}<rp> (</rp><rt>${markupArg(args.at(2))}</rt><rp>) </rp></ruby>`,
          markup: true,
        };
      case 'codeblock': {
        if (args.length === 0) return undefined;
        const code = args
          .at(args.length)!
          .value()
          .text.replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        if (args.length === 1) return { text: `<pre><code>${code}</code></pre>`, markup: true };
        // Upstream's placeholder is for its own highlighter; a screen here has none,
        // and would only lose the tag.
        return data?.phase === 'display'
          ? { text: `<pre><code class="language-${markupArg(args.at(1))}">${code}</code></pre>`, markup: true }
          : { text: `<pre-hljs-placeholder lang="${value(1).text}">${code}</pre-hljs-placeholder>`, markup: true };
      }
      case 'comment':
        if (!data) return undefined;
        return data.phase === 'display'
          ? { text: `<div class="risu-comment">${markupArg(args.at(1))}</div>`, markup: true }
          : { text: '' };
      case 'file': {
        if (!data) return undefined;
        if (data.phase === 'display') {
          return { text: `<br><div class="risu-file">${markupArg(args.at(1))}</div><br>`, markup: true };
        }
        if (args.length < 2) return undefined;
        const encoded = value(2);
        if (encoded.deferred) return WAITING;
        return derived(decodeFile(encoded.text), [encoded]);
      }
    }
    const run = CBS_FUNCTIONS.get(name);
    if (run) return pure(run, args);
    return fromData(call);
  }

  /** `1` or `0`. */
  const flag = (holds: boolean): CbsValue => ({ text: holds ? '1' : '0' });

  /** The functions that answer from `data`: each one only if the host gave what it reads. */
  function fromData(call: CbsCall): CbsValue | undefined {
    if (!data) return undefined;
    const { name, mode } = call;
    switch (name) {
      case 'char':
        return data.char === undefined ? undefined : { text: data.char };
      case 'user':
        return data.user === undefined ? undefined : { text: data.user };
      case 'triggerid':
        return data.triggerId === undefined ? undefined : { text: data.triggerId ?? 'null' };
      case 'personality':
      case 'charpersona':
        return reparse(data.character?.personality, mode);
      case 'description':
      case 'chardesc':
        return reparse(data.character?.description, mode);
      case 'scenario':
        return reparse(data.character?.scenario, mode);
      case 'exampledialogue':
      case 'examplemessage':
        return reparse(data.character?.exampleDialogue, mode);
      case 'persona':
      case 'userpersona':
        return reparse(data.persona, mode);
      case 'mainprompt':
      case 'systemprompt':
        return reparse(data.prompts?.main, mode);
      case 'globalnote':
      case 'systemnote':
      case 'ujb':
        return reparse(data.prompts?.postHistory, mode);
      case 'authornote':
        return reparse(data.prompts?.authorNote, mode);
      case 'jb':
      case 'jailbreak':
        return reparse(data.prompts?.jailbreak?.text, mode);
      case 'jbtoggled':
        return data.prompts?.jailbreak ? flag(data.prompts.jailbreak.enabled) : undefined;
      case 'lorebook':
      case 'worldinfo':
        return data.lorebook ? { text: makeArray(data.lorebook().map((entry) => JSON.stringify(entry))) } : undefined;
      case 'role':
        return data.role === undefined ? undefined : { text: data.role };
      case 'isfirstmsg':
      case 'isfirstmessage':
        return data.firstMessage === undefined ? undefined : flag(data.firstMessage);
      case 'model':
        return data.model ? { text: data.model.id } : undefined;
      case 'axmodel':
        return data.model ? { text: data.model.auxiliary ?? '' } : undefined;
      case 'maxcontext':
        return data.model?.maxContext === undefined ? undefined : { text: data.model.maxContext.toString() };
      case 'prefillsupported':
      case 'prefill':
        return data.model?.prefill === undefined ? undefined : flag(data.model.prefill);
      case 'screenwidth':
      case 'screenheight':
        return data.screen
          ? { text: (name === 'screenwidth' ? data.screen.width : data.screen.height).toString() }
          : undefined;
      case 'assetlist':
      case 'emotionlist':
        return data.assets ? { text: makeArray(data.assets.names) } : undefined;
      case 'chardisplayasset':
        return data.assets ? { text: makeArray(data.assets.display ?? []) } : undefined;
      case 'moduleenabled':
      case 'moduleassetlist': {
        if (!data.modules) return undefined;
        const namespace = call.args.at(1)?.value().text;
        const module = data.modules.find((one) => one.namespace === namespace);
        if (name === 'moduleenabled') return flag(module !== undefined);
        return { text: module ? makeArray(module.assets) : '' };
      }
      case 'metadata':
        return metadata(call.args);
    }
    if (!CHAT_FUNCTIONS.has(name) || !data.chat) return undefined;
    return fromChat(call, (chat ??= data.chat()));
  }

  /** `{{metadata::key}}`: what RisuAI says about itself, answered for this app where it can be. */
  function metadata(args: CbsArgs): CbsValue | undefined {
    const key = args.at(1)?.value();
    if (!key) return undefined;
    if (key.deferred) return WAITING;
    const model = data?.model;
    const meta = data?.meta;
    let answer: string | undefined;
    switch (key.text.toLowerCase()) {
      case 'mobile':
        answer = meta?.mobile === undefined ? undefined : meta.mobile ? '1' : '0';
        break;
      // RisuAI's desktop app and its self-hosted server; this is neither.
      case 'local':
      case 'node':
        answer = '0';
        break;
      case 'version':
        answer = RISU_VERSION;
        break;
      case 'majorversion':
      case 'majorver':
      case 'major':
        answer = RISU_VERSION.split('.')[0];
        break;
      case 'language':
      case 'locale':
      case 'lang':
        answer = meta?.language;
        break;
      case 'browserlanguage':
      case 'browserlocale':
      case 'browserlang':
        answer = meta?.browserLanguage;
        break;
      case 'modelshortname':
        answer = model && (model.shortName ?? model.name ?? model.id);
        break;
      case 'modelname':
        answer = model && (model.name ?? model.id);
        break;
      case 'modelinternalid':
        answer = model && (model.internalId ?? model.id);
        break;
      case 'modelformat':
        answer = model?.format;
        break;
      case 'modelprovider':
        answer = model?.provider;
        break;
      case 'modeltokenizer':
        answer = model?.tokenizer;
        break;
      case 'imateapot':
        answer = '🫖';
        break;
      case 'risutype':
        answer = 'web';
        break;
      case 'maxcontext':
        answer = model?.maxContext?.toString();
        break;
      default:
        answer = `Error: ${key.text} is not a valid metadata key.`;
    }
    return answer === undefined ? undefined : derived(answer, [key]);
  }

  /**
   * RisuAI's chat functions over the branch the host built. A message is the
   * model's or the reader's words, so whatever carries one is marked; none is
   * ever read as CBS (upstream reads the history's again). A question about a
   * message that is not loaded is left as written rather than answered wrong.
   */
  function fromChat({ name, args }: CbsCall, branch: CbsChat): CbsValue | undefined {
    const at = (index: number): CbsMessage | undefined =>
      index >= branch.offset ? branch.messages[index - branch.offset] : undefined;
    const said = (message: CbsMessage): CbsValue => ({ text: message.data, untrusted: true });
    const greeting = (): CbsValue | undefined => (branch.greeting ? { text: branch.greeting.text } : undefined);
    /** Back from `from` to the latest message of `role`; none, and it is the greeting. */
    const latest = (from: number, role: CbsRole): CbsValue | undefined => {
      for (let index = from; index >= 0; index -= 1) {
        const message = at(index);
        if (!message) return undefined;
        if (message.role === role) return said(message);
      }
      return greeting();
    };
    const plain = (message: CbsMessage): string =>
      JSON.stringify({ role: message.role, data: message.data, ...(message.time === undefined ? {} : { time: message.time }) });
    const whole = branch.offset === 0;
    const older = { text: '[Cannot get time, message was sent in older version]' };

    switch (name) {
      case 'chatindex':
        return { text: branch.index.toString() };
      case 'firstmsgindex':
      case 'firstmessageindex':
        return branch.greeting ? { text: branch.greeting.index.toString() } : undefined;
      case 'lastmessageid':
      case 'lastmessageindex':
        return { text: (branch.length - 1).toString() };
      case 'lastmessage': {
        // An empty chat throws upstream, which leaves the macro as written.
        const last = at(branch.length - 1);
        return last ? said(last) : undefined;
      }
      case 'previouscharchat':
      case 'lastcharmessage':
        return latest(branch.index !== -1 ? branch.index - 1 : branch.length - 1, 'char');
      case 'previoususerchat':
      case 'lastusermessage':
        // Upstream answers nothing where the text belongs to no message.
        return branch.index === -1 ? { text: '' } : latest(branch.index - 1, 'user');
      case 'previouschatlog': {
        const index = Number(args.at(1)?.value().text);
        if (!Number.isInteger(index) || index < 0 || index >= branch.length) return { text: 'Out of range' };
        const message = at(index);
        return message ? said(message) : undefined;
      }
      case 'history':
      case 'messages': {
        if (!whole) return undefined;
        if (args.length === 0) {
          if (!branch.greeting) return undefined;
          const opening: CbsMessage = { role: 'char', data: branch.greeting.text };
          return { text: makeArray([opening, ...branch.messages].map(plain)), untrusted: true };
        }
        const roles = valuesOf(args).some((one) => one.text === 'role');
        return {
          text: makeArray(branch.messages.map((message) => (roles ? `${message.role}: ` : '') + message.data)),
          untrusted: true,
        };
      }
      case 'userhistory':
      case 'usermessages':
      case 'charhistory':
      case 'charmessages': {
        if (!whole) return undefined;
        const role = name.startsWith('user') ? 'user' : 'char';
        return {
          text: makeArray(branch.messages.filter((message) => message.role === role).map(plain)),
          untrusted: true,
        };
      }
      case 'messageunixtimearray':
        return whole ? { text: makeArray(branch.messages.map((message) => `${message.time ?? 0}`)) } : undefined;
      case 'messagetime':
      case 'messagedate': {
        if (branch.index === -1) return { text: '[Cannot get time]' };
        const message = at(branch.index);
        if (!message) return undefined;
        if (!message.time) return older;
        const clock = data?.clock;
        if (!clock) return undefined;
        const zone = { timeZone: clock.timeZone };
        const date = new Date(message.time);
        try {
          return {
            text:
              name === 'messagetime'
                ? date.toLocaleTimeString(clock.locale, zone)
                : date.toLocaleDateString(clock.locale, zone),
          };
        } catch {
          return undefined;
        }
      }
      case 'messageidleduration': {
        // From this message back: its user message and the one before that.
        if (branch.index === -1) return { text: '[Cannot get time]' };
        let last: CbsMessage | undefined;
        let before: CbsMessage | undefined;
        for (let index = branch.index; index >= 0; index -= 1) {
          const message = at(index);
          if (!message) return undefined;
          if (message.role !== 'user') continue;
          if (!last) {
            last = message;
          } else {
            before = message;
            break;
          }
        }
        if (!last) return { text: '[No user message found]' };
        if (!before) return { text: '[No previous user message found]' };
        if (!last.time) return older;
        if (!before.time) return { text: '[Cannot get time, previous message was sent in older version]' };
        return { text: duration(last.time - before.time) };
      }
    }
    return undefined;
  }

  let out: string;
  try {
    out = sequence(nodes, 'out', null).text;
  } catch (error) {
    if (!(error instanceof Return)) throw error;
    out = settle(error.value, 'out').text;
  }
  return out.includes(TRIM_MARK) ? out.replace(TRIM_RE, '') : out;
}

/* ------------------------------------------------------------------- assets */

/**
 * What RisuAI's asset macros draw: an image, the image's address, music — a
 * player (`audio`, RisuAI's `<audio controls autoplay loop>`) or background
 * music with no player at all (`bgm`, RisuAI's `risu-ctrl` that its DOM observer
 * plays) — a video, as a player (`video`, RisuAI's `<video controls autoplay
 * loop>`) or as a moving picture (`videoimg`, its `<video autoplay muted loop>`),
 * or something there is no counterpart for here (backgrounds, inlays, profile
 * pictures), which is dropped. `asset` is an image here; RisuAI draws it as the
 * moving picture when the asset is a video, which only a renderer holding the
 * assets can tell. Keys are normalized names — `video-img` is `videoimg`.
 */
const ASSET_MACROS: Record<string, AssetMacroKind> = {
  img: 'image',
  image: 'image',
  asset: 'image',
  emotion: 'image',
  raw: 'url',
  path: 'url',
  audio: 'audio',
  bgm: 'bgm',
  video: 'video',
  videoimg: 'videoimg',
  bg: 'drop',
  inlay: 'drop',
  inlayed: 'drop',
  inlayeddata: 'drop',
  source: 'drop',
};

export type AssetMacroKind = 'image' | 'url' | 'audio' | 'bgm' | 'video' | 'videoimg' | 'drop';

/** The kind of asset macro a normalized name is, or undefined for any other. */
export const assetMacroKind = (name: string): AssetMacroKind | undefined =>
  Object.prototype.hasOwnProperty.call(ASSET_MACROS, name) ? ASSET_MACROS[name] : undefined;

export interface AssetMacro {
  start: number;
  end: number;
  /** The normalized macro name — `img`, `inlay`, `videoimg` … */
  name: string;
  kind: AssetMacroKind;
  /** The asset it names, trimmed; null when the name is composed at render time. */
  ref: string | null;
}

/**
 * Every asset macro in `text`, outermost first and in order — inside blocks and
 * other macros' arguments too, since none of them may reach a screen as written
 * (the roleplay prompt is the one reader that gets them verbatim). One whose
 * name is built from other macros has no `ref`: only a renderer holding the
 * variables can say which image it means.
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
      found.push({ start: node.start, end: node.end, name: name!, kind, ref });
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
