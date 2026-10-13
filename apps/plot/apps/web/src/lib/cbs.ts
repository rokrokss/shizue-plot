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
 * marked (`lib/taint.ts`), every step paid for, `{{rel}}`, `{{turn}}`,
 * `{{button}}` (a manual trigger where the plot defines one), the plot's images, and what the browser can tell RisuAI's
 * functions about the chat (`CbsHostData`). There is no `eval` anywhere.
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
  unescapeCbs,
  type AssetMacroKind,
  type CbsCall,
  type CbsExpressionValue,
  type CbsHost,
  type CbsHostData,
  type CbsMessage,
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
  /**
   * The reader's global variables on the plot, for `{{getglobalvar}}`, `@name` in
   * an expression and `#when`'s toggles. Unset, `getglobalvar` stays as written.
   */
  globalVariables?: Record<string, string>;
  /**
   * The loaded messages after the greeting, oldest first, numbered as `chatIndex`
   * numbers them — so `messages[chatIndex]` is this message, and its role is
   * `{{role}}`. The greeting is not among them; RisuAI keeps it apart too.
   */
  messages?: readonly CbsMessage[];
  /**
   * Whether `messages` is the whole branch. Only then are RisuAI's chat functions
   * (`{{lastmessage}}`, `{{history}}`, …) answered: with earlier messages unread,
   * a question about the branch would be answered about the part of it on screen,
   * and a wrong answer is worse than the macro as written.
   */
  wholeBranch?: boolean;
  /** The chat id: `{{pick}}`'s seed, as RisuAI seeds it with its chat's. */
  chatId?: string;
  /** The reader's interface language, for `{{metadata::language}}`. */
  locale?: string;
  /**
   * The manual triggers the plot's scripts define, by name. A `{{button}}` whose
   * target is one of them runs it, as RisuAI's does; any other fills the composer.
   */
  triggerNames?: ReadonlySet<string>;
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
/**
 * `{{#each}}` iterations in one render, every block together. Kept below the
 * core's own cap (5,000), which is a different kind of bound: the core simply
 * stops iterating there and hands back what it has, and a status window cut off
 * at its 5,000th row is a lie about the state rather than a missing decoration.
 * Running out here throws instead, before the core's cap is ever reached, so the
 * whole island is given up as every other exhausted budget gives it up.
 */
const MAX_EACH_ITERATIONS = 4_000;

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
 * macros said; `{{slot}}` is an `{{#each}}` item, usually a variable; a global
 * variable is the card's scripts' as much as a chat one; a message the chat
 * functions read (`{{lastmessage}}`, `{{history}}`) is the model's words or the
 * reader's; a RisuAI function (`equal`, `random`, …) is marked when an argument
 * it read was — a capture or a variable passes its mark on. The core marks all
 * of these itself, and `emit` below escapes and marks whatever it was told is
 * untrusted. The rest are not the model's to choose: `{{char}}` is the card's
 * name, `{{user}}` the reader's persona, `{{turn}}` a count we keep, `{{rel}}` an
 * axis we compute, the clock and the screen the reader's, and an image an
 * address out of our own asset map — even when the model chose *which* of the
 * card's images, the address is still ours, and marking it would make ordinary
 * links inert for no gain.
 *
 * An unset variable reads as unset, and `{{getvar}}` writes RisuAI's `null` for
 * it — which is what a RisuAI card's status window shows before the model has
 * set anything. SillyTavern's `{{if}}` still finds it false: the core keeps the
 * word and the fact that nothing was set apart.
 */
function host(ctx: CbsContext, budget: Budget, attributes: Set<CbsNode>): CbsHost {
  // Own-property reads throughout: a variable may legitimately be called
  // `toString`, and inheriting one would put a function where a string belongs.
  const variable = (name: string): string | undefined => {
    const value = readVariable(ctx.variables, name);
    return value === undefined ? undefined : read(value, budget);
  };
  const globals = ctx.globalVariables;
  const globalVariable = globals
    ? (name: string): string | undefined => {
        const value = readVariable(globals, name);
        return value === undefined ? undefined : read(value, budget);
      }
    : undefined;

  /** Our own `{{#if expr}}`: an expression over bare names, or failing that, text. */
  const expressionHolds = (source: string): boolean => {
    let value: CbsExpressionValue;
    try {
      value = evaluateExpression(source, variable, globalVariable);
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

  return {
    variable,
    ...(globalVariable ? { globalVariable } : {}),
    data: hostData(ctx),
    // `{{#each}}` is the core's — RisuAI's `{{#each LIST as name}}…{{slot::name}}`
    // and our `{{#each 목록}}…{{slot}}` both — and every iteration is paid for here.
    each: true,
    iterate: () => {
      budget.iterations -= 1;
      if (budget.iterations < 0) throw new RenderBudgetExhausted('too many iterations');
    },
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
    macro: (call) => {
      switch (call.name) {
        case 'char':
          return { text: read(ctx.char, budget) };
        case 'user':
          return { text: read(ctx.user, budget) };
        case 'turn':
          return { text: String(ctx.turn) };
        // RisuAI cards show a panel or a picture on the last few turns only
        // (`{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-2}}}}`). Answered
        // here rather than from `data.chat`, so they count the same way whether the
        // whole branch is loaded or only its latest stretch.
        case 'chatindex':
          return ctx.chatIndex === undefined ? undefined : { text: String(ctx.chatIndex) };
        case 'lastmessageid':
        case 'lastmessageindex':
          return ctx.lastMessageId === undefined ? undefined : { text: String(ctx.lastMessageId) };
        case 'rel': {
          const axis = call.args.rest(1)?.value().text.trim().toLowerCase() ?? '';
          if (!(REL_AXES as readonly string[]).includes(axis)) return undefined;
          return { text: String(ctx.relationship?.[axis] ?? 0) };
        }
        case 'button': {
          // The only interactive element a template can produce. It carries no
          // behaviour of its own — the chat page delegates on its attribute. RisuAI's
          // `{{button::label::trigger}}` runs the plot's manual trigger of that name
          // (`risu-trigger`, which the sanitizer keeps under our name); a target that
          // names none is text, and the click puts it in the composer.
          const label = call.args.at(1)?.value().text ?? '';
          const fill = call.args.rest(2)?.value().text ?? label;
          const attribute = ctx.triggerNames?.has(fill) ? 'risu-trigger' : 'data-shizue-fill';
          return {
            text: `<button type="button" ${attribute}="${escapeHtml(fill)}">${escapeHtml(label)}</button>`,
            markup: true,
          };
        }
      }
      const kind = assetMacroKind(call.name);
      return kind ? asset(call, kind) : undefined;
    },
  };
}

/** RisuAI's own test for a phone, which `{{metadata::mobile}}` answers with. */
const MOBILE_RE = /iPad|iPhone|iPod|Android|webOS/i;

/**
 * What the browser can tell RisuAI's functions, and nothing it cannot.
 *
 * The screen, the clock and the browser's language are read when the message is
 * drawn, as RisuAI reads them. The chat is what the page has loaded: `{{role}}`
 * and `{{isfirstmsg}}` are this message's own, the chat functions answer only over
 * a whole branch (`wholeBranch`), and `{{pick}}` draws as RisuAI draws it — the
 * chat and the branch's length, so a pick holds through a reroll and moves on with
 * the next turn. The greeting is not handed over: which of the plot's openings it
 * was (`{{firstmsgindex}}`) is not something the page can tell, so the functions
 * that would fall back to it stay as written there. Nor are the card's internals —
 * a reader's screen never has them to give.
 */
function hostData(ctx: CbsContext): CbsHostData {
  const data: CbsHostData = { phase: 'display' };
  const index = ctx.chatIndex;
  const messages = ctx.messages;
  if (index !== undefined) {
    data.firstMessage = index === -1;
    // The greeting is the character's; any other message says whose it is.
    const role = index === -1 ? 'char' : messages?.[index]?.role;
    if (role) data.role = role;
    if (messages && ctx.wholeBranch) {
      data.chat = () => ({ messages, offset: 0, length: messages.length, index });
    }
  }
  if (ctx.chatId !== undefined && ctx.lastMessageId !== undefined) {
    data.seed = { key: ctx.chatId, length: ctx.lastMessageId + 1 };
  }
  // A plot keeps one list of images, so RisuAI's emotion list and its display
  // assets are the same one: the open images, by the names the card asks for them by.
  if (ctx.assetNames) data.assets = { names: ctx.assetNames, display: ctx.assetNames };
  const zone = Intl.DateTimeFormat().resolvedOptions();
  data.clock = { now: new Date(), timeZone: zone.timeZone, locale: zone.locale };
  if (typeof window !== 'undefined') {
    // RisuAI cards lay out by them. The size when the message was drawn.
    data.screen = { width: window.innerWidth, height: window.innerHeight };
  }
  const browser = typeof navigator === 'undefined' ? undefined : navigator;
  data.meta = {
    ...(ctx.locale ? { language: ctx.locale } : {}),
    ...(browser?.language ? { browserLanguage: browser.language } : {}),
    ...(browser?.userAgent ? { mobile: MOBILE_RE.test(browser.userAgent) } : {}),
  };
  return data;
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
 *
 * The last step is RisuAI's display unescape (`unescapeCbs`), once: what `#escape`
 * and the display-escape functions (`{{decbo}}`, `{{<}}`, …) put in as stand-ins
 * so that nothing reads them as syntax, and `#puredisplay`'s backslashed braces,
 * come back as the characters they stand for — `<` and `>` as entities, so a
 * stand-in is only ever text. It has to happen here, before the sanitizer and not
 * after it: the sanitizer judges the characters it is shown, and an address or a
 * stylesheet that gained its `:` or its `(` after being judged
 * (`src="https{{dec}}//…"`, `url{{(}}…`) would be one it never saw. The result is
 * never read as CBS again, so the restored braces stay braces.
 */
export function renderTemplate(
  template: string,
  ctx: CbsContext,
  charge: (chars: number) => void,
): string {
  const budget: Budget = { nodes: MAX_RENDERED_NODES, iterations: MAX_EACH_ITERATIONS, charge };
  try {
    const nodes = parseCbs(template, { strict: true });
    return unescapeCbs(evaluateCbs(template, nodes, host(ctx, budget, attributePositions(nodes))), 'html');
  } catch (error) {
    if (error instanceof RenderBudgetExhausted) throw error;
    return escapeHtml(template);
  }
}
