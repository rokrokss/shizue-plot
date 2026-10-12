/**
 * The CBS a display script's OUT template is written in.
 *
 * Client-side by design: a template is a *presentation* of a message, so it is
 * evaluated where the message is drawn and never where it is stored or prompted.
 * That also keeps the whole thing reactive — a swipe or a streaming delta changes
 * the derived variables, and the next render simply picks them up.
 *
 * The language itself — nesting, `{{#if}}`/`{{#when}}`, RisuAI's functions,
 * `{{? …}}`/`{{calc}}` — is `@shizue/core/cbs`, shared with the prompt. What is
 * this file's is everything about the page: values escaped, the model's values
 * marked (`lib/taint.ts`), every step paid for, our own `{{#each}}`, `{{rel}}`,
 * `{{turn}}`, `{{button}}`, and the plot's images. There is no `eval` anywhere.
 * A malformed template is never fatal — it falls back to its own escaped
 * source, so the message still reads.
 */

import {
  assetMacroKind,
  evaluateCbs,
  evaluateExpression,
  expressionTruthy,
  isCbsTrue,
  parseCbs,
  type AssetMacroKind,
  type CbsBlock,
  type CbsBlockScope,
  type CbsCall,
  type CbsExpressionValue,
  type CbsHost,
  type CbsNode,
  type CbsValue,
} from '@shizue/core/cbs';
import { readVariable } from '@shizue/core/variables';
import { lookupAsset, type AssetResolver } from './assets';
import { isTainted, stripTaint, taint } from './taint';

/** The relationship axes `{{rel::axis}}` exposes; mirrors RELATIONSHIP_AXES. */
const REL_AXES = ['affection', 'obsession', 'trust', 'liking', 'disgust', 'fear'] as const;

export interface CbsContext {
  /** Path-derived chat variables, for `{{getvar::k}}`, `$k` and bare identifiers. */
  variables: Record<string, string>;
  /** Character asset urls by slug, for `{{img::…}}` and RisuAI's other asset macros. */
  assets: ReadonlyMap<string, string>;
  /** Resolves a reference by an imported card's own image names too; slugs only without it. */
  resolveAsset?: AssetResolver;
  /** Relationship axes 0-100, or null while the chat has none. */
  relationship: Record<string, number> | null;
  /** User turns taken on this branch, for `{{turn}}`. */
  turn: number;
  char: string;
  user: string;
  /**
   * This message's place on the branch as RisuAI counts it, for `{{chat_index}}`:
   * the greeting is -1 and the first message after it 0. Counted within the loaded
   * stretch when earlier messages have not been read. Unset, the macro stays as written.
   */
  chatIndex?: number;
  /** The last message's place, counted the same way, for `{{lastmessageid}}`. */
  lastMessageId?: number;
  /** The names the plot's open images go by, for `{{assetlist}}` and `{{emotionlist}}`. */
  assetNames?: readonly string[];
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

/* -------------------------------------------------------------- the budget */

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

/* ------------------------------------------------------------ RisuAI's #each */

/**
 * RisuAI's `parseArray`: a JSON array, or anything else split on `§` — kept
 * whole, empties and all. An item that is not a string is written as JSON.
 */
function risuArray(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.split('§');
  }
  if (!Array.isArray(parsed)) return text.split('§');
  return parsed.map((item: unknown) => (typeof item === 'string' ? item : JSON.stringify(item)));
}

/** RisuAI's `trimLines`, which its `#each` body gets: every line's indent and both ends off. */
const unindent = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trimStart())
    .join('\n')
    .trim();

/* ------------------------------------------------------------ image context */

/**
 * The macros that sit inside a tag or a stylesheet of the creator's markup.
 *
 * An image reference means two things. In a RisuAI card, `<div>{{img::face.png}}</div>`
 * is a picture; in ours, `<img src="{{img::face}}">` and `url({{img::face}})` are
 * its address — and `{{raw::…}}` is the address everywhere. Where the macro stands
 * tells them apart: inside a tag's attributes or a `<style>`, only an address
 * makes sense. It is read off the template's own text, never off a substituted
 * value (escaped, a value holds no `<`), so nothing the model writes moves a
 * reference from one side to the other — and a misreading is a broken picture the
 * sanitizer then removes, not a hole.
 */
function attributePositions(nodes: CbsNode[]): Set<CbsNode> {
  const inside = new Set<CbsNode>();
  let state: 'text' | 'tag' | 'quoted' | 'style' = 'text';
  let quote = '';
  let tag = '';
  let naming = false;

  const scan = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]!;
      if (state === 'text') {
        if (char === '<' && /[A-Za-z/]/.test(text[i + 1] ?? '')) {
          state = 'tag';
          tag = '';
          naming = true;
        }
      } else if (state === 'tag') {
        if (naming && /[A-Za-z0-9/]/.test(char)) tag += char.toLowerCase();
        else naming = false;
        if (char === '"' || char === "'") {
          state = 'quoted';
          quote = char;
        } else if (char === '>') {
          state = tag === 'style' ? 'style' : 'text';
        }
      } else if (state === 'quoted') {
        if (char === quote) state = 'tag';
      } else if (char === '<' && text.slice(i, i + 7).toLowerCase() === '</style') {
        state = 'tag';
        tag = '/style';
        naming = false;
      }
    }
  };

  const walk = (list: CbsNode[]): void => {
    for (const node of list) {
      if (node.type === 'text') scan(node.text);
      else if (node.type === 'macro') {
        if (state !== 'text') inside.add(node);
      } else {
        walk(node.body);
        if (node.otherwise) walk(node.otherwise);
      }
    }
  };
  walk(nodes);
  return inside;
}

/* ---------------------------------------------------------------- the host */

/**
 * The page's side of the evaluation.
 *
 * Which values are marked, and why: `{{getvar}}`, `{{? …}}` and `{{calc}}` read
 * chat variables, and chat variables are whatever the model's `{{setvar}}`
 * macros said; `{{slot}}` is an `{{#each}}` item, usually a variable; a RisuAI
 * function (`equal`, `random`, …) is marked when an argument it read was — a
 * capture or a variable passes its mark on. The rest are not the model's to
 * choose: `{{char}}` is the card's name, `{{user}}` the reader's persona,
 * `{{turn}}` a count we keep, `{{rel}}` an axis we compute, and an image an
 * address out of our own asset map — even when the model chose *which* of the
 * card's images, the address is still ours, and marking it would make ordinary
 * links inert for no gain.
 */
function host(ctx: CbsContext, budget: Budget, attributes: Set<CbsNode>): CbsHost {
  // Own-property reads throughout: a variable may legitimately be called
  // `toString`, and inheriting one would put a function where a string belongs.
  const variable = (name: string): string => read(readVariable(ctx.variables, name) ?? '', budget);

  /** Our own `{{#if expr}}`: an expression over bare names, or failing that, text. */
  const expressionHolds = (source: string): boolean => {
    let value: CbsExpressionValue;
    try {
      value = evaluateExpression(source, variable);
    } catch (error) {
      // An exhausted budget is not a malformed expression, and treating it as one
      // would turn a megabyte read into a silently truthy condition.
      if (error instanceof RenderBudgetExhausted) throw error;
      // Not an expression — fall back to the raw text, so `{{#if some text}}` is
      // simply truthy rather than an error that eats the whole message.
      value = source;
    }
    return expressionTruthy(value);
  };

  const asset = (call: CbsCall, kind: AssetMacroKind): CbsValue => {
    if (kind === 'drop') return { text: '' };
    const found = lookupAsset(call.args.rest(1)?.value().text ?? '', ctx.assets, ctx.resolveAsset);
    if (!found) return { text: '' };
    const src = read(found.src, budget);
    if (kind === 'url' || call.mode === 'arg' || attributes.has(call.macro)) return { text: src };
    return { text: `<img src="${escapeHtml(src)}" alt="${escapeHtml(found.slug)}">`, markup: true };
  };

  /**
   * The `{{#each}}` items being rendered, innermost last, under the name RisuAI's
   * form gives them — null for one of ours, which names none. `{{slot::name}}` looks
   * a name up from the inside out, so an inner block's name shadows an outer one's.
   */
  const slots: { name: string | null; item: string }[] = [];

  /**
   * `{{#each}}`, in two dialects told apart by an ` as `.
   *
   * RisuAI's is `{{#each LIST as name}}…{{slot::name}}…{{/each}}`, read as RisuAI
   * reads it: LIST is a JSON array, or failing that text split on `§` — so a bare
   * name is one item, its own spelling, and `a,b` is one item too. An item that is
   * not a string is written as JSON. Its whitespace is RisuAI's as well: every
   * line of the body is unindented and the whole is trimmed, unless the block opens
   * `{{#each::keep …}}`. A list that came to nothing (`{{#each {{getvar::none}} as
   * x}}`) renders nothing. One difference is deliberate: RisuAI pastes the item
   * into the body and reads the result as CBS, so an item holding a macro runs;
   * here an item is a value, escaped like any other, and never syntax.
   *
   * Ours is `{{#each 목록}}…{{slot}}…{{/each}}` over a comma-separated list: a bare
   * name is a variable holding one (empty when unset, so a typo renders nothing
   * rather than itself), anything else is the list written out inline.
   *
   * RisuAI's older `{{#each LIST name}}`, which names the item after the last
   * space, is not read: it cannot be told from a list of ours with spaces in it.
   */
  const each = (scope: CbsBlockScope, block: CbsBlock): CbsValue => {
    let head = scope.head.value().text.trim();
    const keep = head.startsWith('::keep ');
    if (keep) head = head.slice(7).trim();

    // What is left of `LIST as name` once LIST came to nothing.
    if (/^as +\S+$/.test(head)) return { text: '' };

    const at = head.lastIndexOf(' as ');
    let name: string | null = null;
    let items: string[];
    if (at !== -1) {
      name = head.slice(at + 4).trim();
      items = risuArray(head.slice(0, at));
    } else {
      const source = /^[A-Za-z_][A-Za-z0-9_]*$/.test(head) ? variable(head) : head;
      items = source
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    let text = '';
    let untrusted = false;
    for (const item of items) {
      budget.iterations -= 1;
      if (budget.iterations < 0) throw new RenderBudgetExhausted('too many iterations');
      slots.push({ name, item });
      let value: CbsValue;
      try {
        value = scope.render(block.body, item);
      } finally {
        slots.pop();
      }
      text += name === null || keep ? value.text : unindent(value.text);
      if (value.untrusted) untrusted = true;
      if (text.length > MAX_RENDERED_CHARS) throw new RenderBudgetExhausted('output too large');
    }
    return { text: name === null || keep ? text : text.trim(), untrusted };
  };

  /** `{{slot::name}}`: the named item, else — inside a block of ours — the current one. */
  const namedSlot = (name: string): string | undefined => {
    for (let i = slots.length - 1; i >= 0; i -= 1) if (slots[i]!.name === name) return slots[i]!.item;
    // Ours names no item, and has always answered any `{{slot::…}}` with the current one.
    const innermost = slots[slots.length - 1];
    return innermost && innermost.name === null ? innermost.item : undefined;
  };

  return {
    variable,
    visit: () => {
      budget.nodes -= 1;
      if (budget.nodes < 0) throw new RenderBudgetExhausted('too many nodes');
    },
    // Checking each intermediate bounds the final string too, since it is one.
    grow: (length) => {
      if (length > MAX_RENDERED_CHARS) throw new RenderBudgetExhausted('output too large');
    },
    // A capture bound into a macro argument — `{{calc::$1 / 2}}`, `{{#if $2}}` —
    // arrives marked, and an argument is read rather than shown: the marks would
    // only make the expression unparseable. So they come off, and the mark moves
    // to the value; what the macro *emits* is marked again on the way out, so the
    // taint follows the value rather than the spelling.
    text: (raw) => ({ text: stripTaint(raw), untrusted: isTainted(raw) }),
    emit: (value) =>
      value.markup ? value.text : value.untrusted ? taint(escapeHtml(value.text)) : escapeHtml(value.text),
    // A condition written as RisuAI writes it — with a macro inside — is RisuAI's
    // (`1` or `true`); one written out is ours, an expression.
    condition: (head) => (head.literal ? expressionHolds(head.value().text) : isCbsTrue(head.value().text)),
    block: (block, scope) => (block.kind === 'each' ? each(scope, block) : undefined),
    macro: (call) => {
      switch (call.name) {
        case 'char':
          return { text: read(ctx.char, budget) };
        case 'user':
          return { text: read(ctx.user, budget) };
        case 'turn':
          return { text: String(ctx.turn) };
        case 'slot': {
          // A name no block around it gave is left as written, as RisuAI leaves it.
          const name = call.args.rest(1)?.value().text;
          const item = name === undefined ? (call.slot ?? '') : namedSlot(name);
          return item === undefined ? undefined : { text: read(item, budget), untrusted: true };
        }
        case 'screenwidth':
          // RisuAI cards lay out by it. The width when the message was drawn.
          return typeof window === 'undefined' ? undefined : { text: String(window.innerWidth) };
        // RisuAI cards show a panel or a picture on the last few turns only
        // (`{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-2}}}}`).
        case 'chatindex':
          return ctx.chatIndex === undefined ? undefined : { text: String(ctx.chatIndex) };
        case 'lastmessageid':
        case 'lastmessageindex':
          return ctx.lastMessageId === undefined ? undefined : { text: String(ctx.lastMessageId) };
        // …and ask whether an image exists before drawing it
        // (`{{contains::{{assetlist}}::name}}`). The plot's own names, not the model's.
        // A plot keeps one list of images, so RisuAI's emotion list is the same one.
        case 'assetlist':
        case 'emotionlist':
          return { text: read(JSON.stringify(ctx.assetNames ?? []), budget) };
        case 'rel': {
          const axis = call.args.rest(1)?.value().text.trim().toLowerCase() ?? '';
          if (!(REL_AXES as readonly string[]).includes(axis)) return undefined;
          return { text: String(ctx.relationship?.[axis] ?? 0) };
        }
        case 'button': {
          // The only interactive element a template can produce. It carries no
          // behaviour of its own — the chat page delegates on `data-shizue-fill` and
          // does nothing but put the text in the composer.
          const label = call.args.at(1)?.value().text ?? '';
          const fill = call.args.rest(2)?.value().text ?? label;
          return {
            text: `<button type="button" data-shizue-fill="${escapeHtml(fill)}">${escapeHtml(label)}</button>`,
            markup: true,
          };
        }
      }
      const kind = assetMacroKind(call.name);
      return kind ? asset(call, kind) : undefined;
    },
  };
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
    const nodes = parseCbs(template, { strict: true });
    return evaluateCbs(template, nodes, host(ctx, budget, attributePositions(nodes)));
  } catch (error) {
    if (error instanceof RenderBudgetExhausted) throw error;
    return escapeHtml(template);
  }
}
