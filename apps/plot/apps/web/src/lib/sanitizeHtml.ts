/**
 * The trust boundary for creator-authored markup.
 *
 * Everything a display script produces, and every block of a message or a plot's
 * intro that carries HTML of its own (`lib/markdown/html.ts`), passes through
 * `sanitizeCustomHtml` before it reaches the DOM, and nothing else may. The
 * shape is the one RisuAI and
 * SillyTavern converged on, because it is the one that has actually been attacked:
 *
 *   1. `<style>` is lifted out and rebuilt from a CSS AST: every selector scoped
 *      under `.shizue-msg`, every class and id namespaced `x-shizue-`, every
 *      declaration passed through a property and function allowlist, every
 *      at-rule that cannot be scoped dropped. The two page-wide names a sheet can
 *      declare — an `@keyframes` animation and an `@font-face` family — are
 *      prefixed instead, and every reference to them rewritten to match.
 *   2. DOMPurify against a tag/attribute whitelist — no script, no event handler,
 *      no framed or form element, no input but a checkbox or a radio, no
 *      `javascript:` / `data:` URL.
 *   3. A DOM pass for what a string filter cannot see: classes, ids, label targets
 *      and radio groups namespaced, inline styles put through the same declaration
 *      filter, link and image targets re-checked, followed by a second DOMPurify
 *      pass so nothing that pass introduced escapes review.
 *
 * The DOM pass is also where a link's *destination* is judged rather than its
 * spelling. A template may compose an `href` out of `{{getvar}}`, and a chat
 * variable is whatever the model wrote — so the template engine marks interpolated
 * content as it substitutes it (`lib/taint.ts`) and an `<a>` whose final href
 * carries a mark is turned into text with its address written out beside it. The
 * marks come off everything on the way out.
 *
 * Two rules run through all of it. Nothing is decided on a raw string: CSS is
 * unescaped and de-commented first, because `position:f\69xed` and `u\72l(…)` are
 * the same declarations spelled differently. And nothing is decided on a URL by
 * pattern: every one is resolved against the page origin, because `/\evil.test/p`
 * looks root-relative and is not.
 *
 * It never throws and never returns markup it could not fully process: on any
 * failure the answer is the empty string, and the caller falls back to plain text.
 *
 * In a work of several members a member's own stylesheet is scoped further, to
 * the rows of that member's messages (`member`): every selector under
 * `[data-shizue-member="<id>"] .shizue-msg`. The attribute is the chat page's,
 * on the row around the markup; nothing a template writes can carry it — data
 * attributes do not survive the whitelist — so no card can dress another
 * member's messages, or claim its scope. Its animations and font families are
 * that member's too: prefixed with its id, so another member's sheet can neither
 * use them nor redefine them.
 */

import {
  CssTypes,
  parse,
  stringify,
  type CssAtRuleAST,
  type CssDeclarationAST,
  type CssFontFaceAST,
  type CssKeyframeAST,
  type CssKeyframesAST,
  type CssRuleAST,
} from '@adobe/css-tools';
import DOMPurify from 'dompurify';
import { isTainted, stripTaint } from './taint';

/** Wrapper class the chat puts around sanitized markup; every selector is scoped to it. */
export const MESSAGE_SCOPE_CLASS = 'shizue-msg';
/** Namespace every creator class is folded into, so nothing can target app chrome. */
const CLASS_PREFIX = 'x-shizue-';
/** The attribute the chat page puts on a message row in a work of several members, naming whose message it is. */
export const MEMBER_ATTRIBUTE = 'data-shizue-member';
/** A member id, which is all a member scope may name: it goes into a selector. */
const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_TAGS = [
  'div', 'span', 'p', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'img', 'a', 'button', 'progress', 'meter', 'details', 'summary',
  'figure', 'figcaption', 'mark', 'time', 'abbr', 'wbr',
  // What a message's own markdown makes (`~~취소~~` is a <del>), and the inert
  // presentational and sectioning tags RisuAI cards are written with. None of
  // them can load, run or navigate anything; dropped, they took their layout
  // with them and left a greeting reading as one run-on line.
  'del', 'ins', 'strike', 'big', 'center', 'font', 'q', 'cite', 'kbd', 'ruby', 'rt', 'rp',
  'section', 'article', 'header', 'footer', 'aside', 'nav',
  // A card's music, which loads from our own origin only (`rewriteElement`).
  'audio', 'source',
  // RisuAI's CSS-only toggles: a checkbox or a radio, a `<label>` that flips it,
  // and a `:checked ~ …` rule that shows a panel or switches a tab. Only those two
  // kinds of input survive (`rewriteElement`), and with no form to belong to
  // neither can submit anything.
  'input', 'label',
];

const ALLOWED_ATTR = [
  'class', 'style', 'title', 'alt', 'src', 'href', 'target', 'rel',
  'colspan', 'rowspan', 'span', 'width', 'height',
  'value', 'max', 'min', 'low', 'high', 'optimum', 'open', 'type', 'datetime',
  // `<ol start>` from markdown; `<font color face size>` and `align` from cards.
  'start', 'color', 'face', 'size', 'align',
  // The toggles' wiring. `id`, `for` and `name` are folded into our namespace
  // (`NAMED_ATTRIBUTES`), so they can only ever name the creator's own elements.
  'id', 'for', 'name', 'checked',
  'data-shizue-fill',
  // RisuAI's script buttons, under their own names for the first pass and under
  // ours after it (`SCRIPT_ATTRIBUTES`).
  'risu-trigger', 'risu-id', 'risu-btn',
  'data-shizue-trigger', 'data-shizue-trigger-id', 'data-shizue-btn',
  // A card's music: RisuAI's player (`{{audio::…}}`, or one the card writes out)
  // and the background music the chat page plays (`{{bgm::…}}`, `useBackgroundMusic`).
  'controls', 'autoplay', 'loop', 'muted', 'preload', 'data-shizue-bgm',
];

/**
 * RisuAI's script attributes and the names they are kept under. `risu-trigger`
 * names a manual trigger a click runs, `risu-id` is what that run reads as
 * `{{trigger_id}}`, and `risu-btn` is a Lua button's data. Each is only a word
 * the chat page reads on a click (`lib/scripts`): it names one of the creator's
 * own scripts and runs nothing by itself, so it is kept — renamed into our
 * namespace, so nothing but the page's one delegated handler reads it.
 */
const SCRIPT_ATTRIBUTES: readonly (readonly [string, string])[] = [
  ['risu-trigger', 'data-shizue-trigger'],
  ['risu-id', 'data-shizue-trigger-id'],
  ['risu-btn', 'data-shizue-btn'],
];

/**
 * The attributes that name an element or a radio group, folded as classes are
 * (`foldClass`): a card's `id="composer"` is `x-shizue-composer`, which no element
 * of the page carries, so a `<label for>` can only flip one of the creator's own
 * inputs, `#id` in a stylesheet can only match one, and a radio `name` can only
 * group with the creator's radios. A card that wants one toggle per message writes
 * `{{chat_index}}` into its ids, as it must in RisuAI, where ids are page-wide too.
 */
const NAMED_ATTRIBUTES = ['id', 'for', 'name'] as const;

/** The only inputs a message may hold: the two a CSS-only toggle is built from. */
const TOGGLE_TYPES: ReadonlySet<string> = new Set(['checkbox', 'radio']);

const KEPT_TAGS: ReadonlySet<string> = new Set(ALLOWED_TAGS);

/** Whether an element survives the whitelist — anything else is unwrapped, its text kept. */
export const keepsElement = (tag: string): boolean => KEPT_TAGS.has(tag.toLowerCase());

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // Only the data attributes the button bridge reads get through.
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // Their values are free text (a message to put in the composer, a trigger's
  // name), not URLs, so they must not be measured against the URI whitelist.
  ADD_URI_SAFE_ATTR: ['data-shizue-fill', ...SCRIPT_ATTRIBUTES.flat()],
  RETURN_DOM: false as const,
  RETURN_DOM_FRAGMENT: false as const,
};

/** Links leave the app, so nothing but http(s) is a link at all. */
const EXTERNAL_URL = /^https?:\/\//i;

/**
 * Whether an address may be a link in a message, its intro, or a display
 * script's markup: an absolute http(s) one, opened in a new tab with
 * `rel="noopener noreferrer nofollow"`. Everything else — a path into the app,
 * `mailto:`, a fragment — is drawn as its label. The markdown renderers ask this
 * too, so a link reads the same whether it was written as `[…](…)` or `<a>`.
 */
export const isExternalUrl = (href: string): boolean => EXTERNAL_URL.test(href.trim());

/** A backslash, a control character, or whitespace anywhere inside a URL. */
const URL_FORBIDDEN_CHARS = /[\\\u0000-\u0020\u007f]/;
/**
 * The same characters percent-encoded. Today's URL parser leaves `%5c` encoded,
 * so this is not the hole `\` is — but no asset path needs an encoded separator
 * or control character, and anything downstream that decodes before it resolves
 * would turn one into that hole.
 */
const URL_FORBIDDEN_ENCODED = /%(?:5c|2f|00|09|0a|0d|7f)/i;

/**
 * Whether a URL loads from our own origin, decided the way the browser decides it
 * rather than by shape. Every resource a message loads has to pass: a foreign
 * image url is a beacon reporting the reader's address and reading time to
 * whoever wrote the card, and every asset macro (`{{img::…}}`'s `<img>`, the
 * address `{{raw::…}}` gives) produces exactly this form.
 *
 * A prefix test is not enough. `/\evil.test/p` starts with a slash and resolves
 * to `//evil.test/p`, because the browser folds backslashes into slashes; so do
 * `%5c` once decoded and `htt\np:` once whitespace is stripped. Those spellings
 * are refused outright, and whatever survives is resolved and compared.
 */
export function isSameOriginUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || URL_FORBIDDEN_CHARS.test(value) || URL_FORBIDDEN_ENCODED.test(value)) return false;
  // No document means no origin to be same as — and no way to sanitize at all.
  if (typeof location === 'undefined') return false;
  try {
    return new URL(value, location.origin).origin === location.origin;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------- css */

/** Anything that could terminate a selector and start something else. */
const SELECTOR_FORBIDDEN = /[{}<;@]/;
/** A class token in a selector. Escapes are folded away rather than interpreted. */
const SELECTOR_CLASS = /\.([^\s.#[\]:,>+~()]+)/g;
/** An id token in a selector, folded the same way. A quote ends it, for `[href="#x"]`. */
const SELECTOR_ID = /#([^\s.#[\]:,>+~()"']+)/g;
/**
 * The body of a `url()`, up to the first paren that closes it.
 *
 * Deliberately unambiguous: one greedy class that cannot overlap what follows it,
 * so the engine never has a choice to backtrack over. The obvious spelling —
 * `url\(\s*(['"]?)([^)'"]*)\1\s*\)` — has `\s*` and `[^)'"]*` both able to eat a
 * space, so on `url(` followed by a long run of whitespace and no closing paren
 * the engine tries every way of splitting the run: measured at 1.4s for 2,000
 * spaces and 81s for 8,000, on a value a card can produce inside the 100,000-char
 * template budget. That is the reader's tab, hung by a stylesheet. The quoting is
 * checked below instead, where it costs nothing.
 */
const URL_FUNCTION = /url\(([^()]*)\)/gi;
/** Any function call in a value: the name immediately before an opening paren. */
const CSS_FUNCTION = /(?:^|[^\w-])(-?[a-z_][\w-]*)\s*\(/g;
/** `\41`, `\000041 `, `\;` — a CSS escape, which the browser reads and a filter must too. */
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/g;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * The declarations a message may carry: visual properties whose worst outcome is
 * an ugly message. Default-deny, because the interesting attacks are always in
 * the property nobody thought about — `-moz-binding` ran script, `mix-blend-mode`
 * read pixels back, `user-modify` made the page editable.
 */
const ALLOWED_PROPERTIES = new Set([
  'color', 'opacity', 'display', 'visibility', 'gap', 'row-gap', 'column-gap',
  'width', 'height', 'aspect-ratio', 'object-fit', 'object-position',
  'vertical-align', 'line-height', 'letter-spacing', 'word-spacing', 'word-break',
  'white-space', 'overflow-wrap', 'box-sizing', 'box-shadow', 'order',
  'position', 'top', 'right', 'bottom', 'left', 'inset', 'z-index', 'float', 'clear',
  'table-layout', 'border-collapse', 'border-spacing', 'caption-side',
  'transform', 'transform-origin', 'transition', 'background',
  // `::before { content: '' }` is how decorative shapes are drawn, so a status
  // window without it loses its bars and dividers. Safe here because the value
  // still goes through the function allowlist: `attr()` and `counter()` are not
  // in it, and `url()` is same-origin. A quoted string only writes text, which
  // the template could already do in markup.
  'content',
  // Only ever naming the sheet's own `@keyframes` (`renameAnimations`), whose
  // frames are held to this same list.
  'animation',
]);

/** Prefix families of the same. `border` covers `border-radius`, `border-color`, … */
const ALLOWED_PROPERTY_PREFIXES = [
  'background-', 'border', 'margin', 'padding', 'min-', 'max-',
  'font', 'text-', 'list-style', 'flex', 'grid', 'align-', 'justify-', 'place-',
  'overflow', 'transition-', 'animation-', 'inset-',
];

/**
 * The functions a value may call. Everything that can name a resource is either
 * here and URL-checked (`url`) or absent — `image-set()`, `-webkit-image-set()`,
 * `cross-fade()`, `element()` and `paint()` all fetch or sample without ever
 * spelling `url(`, which is why this is an allowlist and not a denylist.
 */
const ALLOWED_FUNCTIONS = new Set([
  'url', 'var', 'calc', 'min', 'max', 'clamp',
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb',
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient',
  'translate', 'translatex', 'translatey', 'translate3d',
  'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d',
  'scale', 'scalex', 'scaley', 'scale3d', 'skew', 'skewx', 'skewy',
  'matrix', 'matrix3d', 'perspective', 'cubic-bezier', 'steps',
]);

/**
 * `position` values that stay inside the box the markup is drawn in. `fixed` is
 * one of them because every box sanitized markup goes into is a containing block
 * for it and clips it (`globals.css`: a message's `.message-body`, and
 * `.shizue-msg` everywhere else — the chat's background, a plot's intro), so a
 * RisuAI card's floating menu floats over its own message and nothing past it.
 * `sticky` sticks to the chat's scroller, which no box of ours contains.
 */
const ALLOWED_POSITIONS = new Set(['static', 'relative', 'absolute', 'fixed']);

/**
 * Reads a CSS token the way the browser will: comments gone, escapes resolved.
 * Without this every check below is a check on one spelling out of many —
 * `position:f\69xed` and `u\72l(https://evil/x)` are the ones that matter.
 */
function normalizeCss(text: string): string {
  return text.replace(CSS_COMMENT, '').replace(CSS_ESCAPE, (_escape, hex?: string, literal?: string) => {
    if (hex === undefined) return literal ?? '';
    const code = Number.parseInt(hex, 16);
    // Per spec, a null or out-of-range escape becomes the replacement character.
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
  });
}

/**
 * A custom property (`--asset-bg`): a value a rule then reads with `var()`. Ivy,
 * The Vampire Maid sets its portrait's layered `url()`s on one in a `style`
 * attribute and draws it from its sheet. Its value passes the same function
 * and same-origin `url()` checks as any declaration's, and whatever reads it is
 * itself a declaration held to this list — `position: var(--x)` is still not
 * one of the allowed positions — so it carries nothing the template could not
 * write out directly. Scoped like everything else: it reaches only the markup
 * under the message it is set in.
 */
const CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]+$/;

const isAllowedProperty = (name: string): boolean =>
  ALLOWED_PROPERTIES.has(name) ||
  ALLOWED_PROPERTY_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
  CUSTOM_PROPERTY.test(name);

const foldClass = (name: string): string => `${CLASS_PREFIX}${name.replace(/[^A-Za-z0-9_-]/g, '')}`;

/**
 * Where a stylesheet reaches. `selector` is what every rule is put under;
 * `names` is the prefix of the two names a sheet declares for the whole page, an
 * animation's and a font family's, which no selector can scope — the plain
 * namespace, or a member's own where the sheet is a member's.
 */
interface Scope {
  selector: string;
  names: string;
}

/**
 * Scopes a selector under the message wrapper and namespaces its classes and ids.
 * Returns null for a selector that should not exist at all — a selector that fails
 * to match is harmless, one that escapes its rule is not.
 */
function scopeSelector(selector: string, scope: Scope): string | null {
  const trimmed = selector.trim();
  if (!trimmed || SELECTOR_FORBIDDEN.test(trimmed)) return null;
  const renamed = trimmed
    .replace(SELECTOR_CLASS, (_match, name: string) => `.${foldClass(name)}`)
    .replace(SELECTOR_ID, (_match, name: string) => `#${foldClass(name)}`);
  return `${scope.selector} ${renamed}`;
}

/**
 * Whether a declaration may stand, judged on its normalized text: an allowed
 * property, only allowed functions, and only same-origin `url()`.
 *
 * The two survivors of the allowlists still need a value check. `position` is
 * allowed but `sticky` is not (`ALLOWED_POSITIONS`). And `url()` is allowed but
 * only pointing at us, which is what an asset macro produces.
 */
function isSafeDeclaration(property: string, value: string): boolean {
  const name = normalizeCss(property).trim().toLowerCase();
  const text = normalizeCss(value).trim();
  if (!name || !text) return false;
  if (!isAllowedProperty(name)) return false;
  if (!callsOnly(text, ALLOWED_FUNCTIONS)) return false;
  if (name === 'position' && !ALLOWED_POSITIONS.has(text.toLowerCase())) return false;
  return urlsAreOurs(text);
}

/** Whether every function a normalized value calls is one of `allowed`. */
function callsOnly(text: string, allowed: ReadonlySet<string>): boolean {
  CSS_FUNCTION.lastIndex = 0;
  for (let call = CSS_FUNCTION.exec(text); call; call = CSS_FUNCTION.exec(text)) {
    if (!allowed.has(call[1]!.toLowerCase())) return false;
    // Functions nest, and the scan must see the inner one too.
    CSS_FUNCTION.lastIndex = call.index + call[0].length - 1;
  }
  return true;
}

/** Whether every `url()` in a normalized value is one the browser reads as one address, on our origin. */
function urlsAreOurs(text: string): boolean {
  const opened = text.match(/url\(/gi)?.length ?? 0;
  if (opened === 0) return true;
  const urls = [...text.matchAll(URL_FUNCTION)];
  // A `url(` the matcher could not close is a malformed value; drop it rather
  // than hand a half-parsed one to the browser.
  if (urls.length !== opened) return false;
  return urls.every((match) => {
    const body = unquoteUrl(match[1]!);
    return body !== null && isSameOriginUrl(body);
  });
}

/**
 * The address inside a `url()`, or null when the quoting is not something the
 * browser would read as one string — an opening quote with no partner, or a quote
 * in the middle of an unquoted url. Refusing those is this function's job rather
 * than the pattern's, which is what lets the pattern stay linear.
 */
function unquoteUrl(body: string): string | null {
  const trimmed = body.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== quote) return null;
    const inner = trimmed.slice(1, -1);
    return inner.includes(quote) ? null : inner;
  }
  return /['"]/.test(trimmed) ? null : trimmed;
}

/* ------------------------------------------------- animations and font families */

/** A CSS identifier as a keyframe name may be one. ASCII, so it folds as a class does. */
const IDENTIFIER = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
/** A word of a font family's name written without quotes — Korean and Japanese names included. */
const FAMILY_WORD = /^-?[A-Za-z_\u00A0-\uFFFF][A-Za-z0-9_\u00A0-\uFFFF-]*$/;
/** What a value may be when it is not a list at all. */
const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
/** The words of an `animation` shorthand that are not a name. */
const ANIMATION_KEYWORDS = new Set([
  'none', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end',
  'infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse',
  'forwards', 'backwards', 'both', 'running', 'paused',
]);
/** A time, a count or a delay in an `animation` shorthand. */
const ANIMATION_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:m?s)?$/i;
/** An easing function in one: its arguments are numbers and a step position, nothing that can call or name anything. */
const ANIMATION_EASING = /^(?:cubic-bezier|steps)\(\s*[0-9.,%\s+-]*(?:,\s*(?:jump-start|jump-end|jump-none|jump-both|start|end)\s*)?\)$/i;
/** The families every browser has, which a sheet's own fonts never shadow. */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong',
]);

/** A value cut at its top-level `separator`s — none inside parentheses or quotes. */
function splitTopLevel(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && separator.test(char)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * An animation's value with every name it gives put under the sheet's prefix
 * (`scope.names`), the way `@keyframes` names are — so a card animates with its
 * own keyframes and never the page's. Rebuilt token by token from what was
 * recognised, never passed through: the value has been unescaped, and an escaped
 * `;` that comes out as a real one must not reach the stylesheet. Null for
 * anything it cannot read, which drops the declaration — a `var()` included,
 * since the page's own properties hold the names of the page's own animations.
 */
function renameAnimations(text: string, shorthand: boolean, names: string): string | null {
  const lower = text.toLowerCase();
  if (CSS_WIDE.has(lower) || lower === 'none') return lower;
  const layers = splitTopLevel(text, /,/);
  const rebuilt: string[] = [];
  for (const layer of layers) {
    const tokens = shorthand ? splitTopLevel(layer, /\s/) : [layer];
    let named = false;
    const out: string[] = [];
    for (const token of tokens) {
      const word = token.toLowerCase();
      if (ANIMATION_NUMBER.test(token) || (shorthand && ANIMATION_EASING.test(token))) out.push(token);
      else if (!IDENTIFIER.test(token)) return null;
      else if (word === 'none' || (shorthand && ANIMATION_KEYWORDS.has(word))) out.push(word);
      else if (named) return null;
      else {
        named = true;
        out.push(`${names}${token}`);
      }
    }
    if (out.length === 0) return null;
    rebuilt.push(out.join(' '));
  }
  return rebuilt.length > 0 ? rebuilt.join(', ') : null;
}

/**
 * One family of a list: its name, and how to write it back — quoted as it was
 * quoted, bare as it was bare, since `-apple-system` only works bare. Null for
 * anything that is neither a clean quoted name nor bare words.
 */
function familyName(item: string): { name: string; spelled: string } | null {
  const quote = item[0];
  if (quote === '"' || quote === "'") {
    if (item.length < 2 || item[item.length - 1] !== quote) return null;
    const inner = item.slice(1, -1).trim();
    // Nothing that could end the string we put it back into, or the stylesheet.
    if (!inner || /["'\\<>{};\u0000-\u001F\u007F]/.test(inner)) return null;
    return { name: inner, spelled: `"${inner}"` };
  }
  const words = item.split(/\s+/);
  if (!words.every((word) => FAMILY_WORD.test(word))) return null;
  const name = words.join(' ');
  return { name, spelled: name };
}

/**
 * A `font-family` list that tries the sheet's own `@font-face` of each name first
 * (`"x-shizue-Name", Name`), falling back to the font the reader has under that
 * name, as it did before. A sheet's own families are declared under the prefix,
 * so they can only ever stand in for its own text — never for the page's. A list
 * it cannot read is left as it was: still safe, only without the sheet's fonts.
 */
function renameFamilies(text: string, original: string, names: string): string {
  const items = splitTopLevel(text, /,/);
  const rebuilt: string[] = [];
  for (const item of items) {
    const lower = item.toLowerCase();
    if (GENERIC_FAMILIES.has(lower) || CSS_WIDE.has(lower)) {
      rebuilt.push(lower);
      continue;
    }
    const family = familyName(item);
    if (family === null) return original;
    rebuilt.push(`"${names}${family.name}"`, family.spelled);
  }
  return rebuilt.length > 0 ? rebuilt.join(', ') : original;
}

/**
 * A declaration as it may stand — its value rewritten where it names an
 * animation or a font family (`renameAnimations`, `renameFamilies`) — or null
 * where it may not stand at all (`isSafeDeclaration`).
 */
function rewriteDeclaration(property: string, value: string, scope: Scope): string | null {
  if (!isSafeDeclaration(property, value)) return null;
  const name = normalizeCss(property).trim().toLowerCase();
  if (name === 'animation' || name === 'animation-name') {
    if (/var\(/i.test(normalizeCss(value))) return null;
    return renameAnimations(normalizeCss(value).trim(), name === 'animation', scope.names);
  }
  if (name === 'font-family') return renameFamilies(normalizeCss(value).trim(), value, scope.names);
  return value;
}

function rewriteDeclarations(declarations: readonly CssDeclarationAST[] | undefined, scope: Scope): CssDeclarationAST[] {
  const kept: CssDeclarationAST[] = [];
  for (const declaration of declarations ?? []) {
    if (declaration.type !== CssTypes.declaration) continue;
    const value = rewriteDeclaration(declaration.property, declaration.value, scope);
    if (value !== null) kept.push({ ...declaration, value });
  }
  return kept;
}

/** A keyframe's offset: `from`, `to`, or a percentage. */
const KEYFRAME_OFFSET = /^(?:from|to|\d+(?:\.\d+)?%)$/;

/**
 * An `@keyframes` rule under the sheet's prefix, each frame held to the same
 * declaration filter as any rule — `position: sticky` is no safer for arriving
 * halfway through an animation. Null when its name is not one a value could
 * name, or nothing of it is left.
 */
function rewriteKeyframes(rule: CssKeyframesAST, scope: Scope): CssKeyframesAST | null {
  const name = normalizeCss(rule.name ?? '').trim();
  if (!IDENTIFIER.test(name) || ANIMATION_KEYWORDS.has(name.toLowerCase())) return null;
  const keyframes: CssKeyframeAST[] = [];
  for (const frame of rule.keyframes ?? []) {
    if (frame.type !== CssTypes.keyframe) continue;
    const values = frame.values.map((value) => normalizeCss(value).trim().toLowerCase());
    if (values.length === 0 || !values.every((value) => KEYFRAME_OFFSET.test(value))) continue;
    const declarations = rewriteDeclarations(frame.declarations as CssDeclarationAST[], scope);
    if (declarations.length > 0) keyframes.push({ ...frame, values, declarations });
  }
  return keyframes.length > 0 ? { ...rule, name: `${scope.names}${name}`, keyframes } : null;
}

/** The descriptors an `@font-face` may carry. */
const FONT_FACE_DESCRIPTORS = new Set([
  'font-family', 'src', 'font-style', 'font-weight', 'font-stretch', 'font-display', 'unicode-range',
  'font-feature-settings', 'font-variation-settings', 'size-adjust', 'ascent-override',
  'descent-override', 'line-gap-override',
]);
/** What a font's `src` may call: an address of ours, and what kind of file is at it. `local()` is not one. */
const FONT_SOURCE_FUNCTIONS: ReadonlySet<string> = new Set(['url', 'format', 'tech']);

/**
 * An `@font-face` whose every source is our own origin — a plot asset, as an
 * image is — under the sheet's prefix, or null. A foreign font is a request to a
 * stranger's server like a foreign image, and stays refused. `local()` is refused
 * too: it names no file, only a font of the reader's, which is what a family of
 * the page's own name would have been — and under a family the prefix keeps out
 * of the page's way, the family is only ever the sheet's.
 */
function rewriteFontFace(rule: CssFontFaceAST, scope: Scope): CssFontFaceAST | null {
  let family: string | null = null;
  let source = false;
  const declarations: CssDeclarationAST[] = [];
  for (const declaration of rule.declarations ?? []) {
    if (declaration.type !== CssTypes.declaration) continue;
    const property = normalizeCss(declaration.property).trim().toLowerCase();
    const value = normalizeCss(declaration.value).trim();
    if (!FONT_FACE_DESCRIPTORS.has(property) || !value) continue;
    if (property === 'font-family') {
      family = familyName(value)?.name ?? null;
      if (family === null) return null;
      continue;
    }
    if (property === 'src') {
      if (!/url\(/i.test(value) || !callsOnly(value, FONT_SOURCE_FUNCTIONS) || !urlsAreOurs(value)) return null;
      source = true;
    } else if (/[(<]/.test(value)) continue;
    declarations.push({ ...declaration, property });
  }
  if (family === null || !source) return null;
  return {
    ...rule,
    declarations: [{ type: CssTypes.declaration, property: 'font-family', value: `"${scope.names}${family}"` }, ...declarations],
  };
}

function rewriteRules(rules: readonly CssAtRuleAST[], scope: Scope): CssAtRuleAST[] {
  const kept: CssAtRuleAST[] = [];
  for (const rule of rules) {
    if (rule.type === CssTypes.rule) {
      const selectors = (rule.selectors ?? [])
        .map((selector) => scopeSelector(selector, scope))
        .filter((selector): selector is string => selector !== null);
      const declarations = rewriteDeclarations(rule.declarations as CssDeclarationAST[], scope);
      if (selectors.length > 0 && declarations.length > 0) {
        kept.push({ ...rule, selectors, declarations } as CssRuleAST);
      }
      continue;
    }
    // Conditional groups are transparent: keep the condition, rewrite the inside.
    if (rule.type === CssTypes.media || rule.type === CssTypes.supports) {
      const condition = rule.type === CssTypes.media ? rule.media : rule.supports;
      if (SELECTOR_FORBIDDEN.test(condition ?? '')) continue;
      const inner = rewriteRules((rule.rules ?? []) as CssAtRuleAST[], scope);
      if (inner.length > 0) kept.push({ ...rule, rules: inner } as CssAtRuleAST);
      continue;
    }
    if (rule.type === CssTypes.keyframes) {
      const keyframes = rewriteKeyframes(rule, scope);
      if (keyframes) kept.push(keyframes);
      continue;
    }
    if (rule.type === CssTypes.fontFace) {
      const face = rewriteFontFace(rule, scope);
      if (face) kept.push(face);
      continue;
    }
    // Everything else — @import, @charset, @namespace, @page, @document, @layer,
    // @property — is dropped. None of them can be scoped to a message.
  }
  return kept;
}

/**
 * A stylesheet cut at its top level: each rule with its block, each at-rule with
 * its block (whatever it nests), each `@import …;`-style statement — so each is
 * parsed on its own. `@adobe/css-tools` slows down faster than a sheet grows: a
 * RisuAI card's 262,000-character sheet took 1.0–1.3s to parse whole on the
 * reader's thread as the chat opened, and 22–55ms in pieces.
 *
 * Only where the parser itself would end a top-level node: comments and quoted
 * strings are passed over (a `{` in either is not a block), and an escaped
 * character is never a delimiter. The pieces put back together are the sheet,
 * and they parse to the same rules (`sanitizeHtml.test.ts`); what the parser
 * refuses in one piece it refused in the whole, and the sheet is dropped all the
 * same.
 */
export function splitStylesheet(css: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    if (char === '\\') {
      i += 1;
    } else if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      // An unterminated comment runs to the end, and so does its piece.
      if (end === -1) break;
      i = end + 1;
    } else if (char === '"' || char === "'") {
      let at = i + 1;
      while (at < css.length && css[at] !== char && css[at] !== '\n') at += css[at] === '\\' ? 2 : 1;
      i = at;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth <= 0) {
        pieces.push(css.slice(start, i + 1));
        start = i + 1;
        depth = 0;
      }
    } else if (char === ';' && depth === 0 && css.slice(start, i).trimStart().startsWith('@')) {
      // An at-statement ends here. A `;` anywhere else at the top level is junk the
      // parser reads into the next rule's selector, so it stays with that rule.
      pieces.push(css.slice(start, i + 1));
      start = i + 1;
    }
  }
  pieces.push(css.slice(start));
  return pieces.filter((piece) => piece.trim() !== '');
}

/**
 * Rewrites a `<style>` body, one top-level piece at a time (`splitStylesheet`).
 * Anything unparseable becomes no stylesheet at all. The pieces are joined as the
 * library joins the rules of one sheet, so the output is the one a whole parse
 * would have given.
 */
function rewriteStylesheet(css: string, scope: Scope): string {
  try {
    const parts: string[] = [];
    for (const piece of splitStylesheet(css)) {
      const ast = parse(piece, { silent: true });
      if ((ast.stylesheet.parsingErrors?.length ?? 0) > 0) return '';
      const rules = rewriteRules(ast.stylesheet.rules, scope);
      if (rules.length > 0) parts.push(stringify({ ...ast, stylesheet: { ...ast.stylesheet, rules } }));
    }
    if (parts.length === 0) return '';
    const output = parts.join('\n\n');
    // `<style>` is a raw-text element: a `<` in it would end the element early,
    // and no legitimate declaration needs one.
    return output.includes('<') ? '' : output;
  } catch {
    return '';
  }
}

/** The plain scope: every message's wrapper, and the namespace with no member in it. */
const MESSAGE_SCOPE: Scope = { selector: `.${MESSAGE_SCOPE_CLASS}`, names: CLASS_PREFIX };

/** The same declaration filter, applied to a `style="…"` attribute. */
function rewriteInlineStyle(css: string): string {
  try {
    const ast = parse(`*{${css}}`, { silent: true });
    if ((ast.stylesheet.parsingErrors?.length ?? 0) > 0) return '';
    const rule = ast.stylesheet.rules[0];
    if (!rule || rule.type !== CssTypes.rule) return '';
    return rewriteDeclarations(rule.declarations as CssDeclarationAST[], MESSAGE_SCOPE)
      .map((declaration) => `${declaration.property.trim()}: ${declaration.value.trim()}`)
      .join('; ');
  } catch {
    return '';
  }
}

/* ---------------------------------------------------------------------- dom */

/** How much of a refused destination is shown. Long enough to read, short enough not to reflow. */
const DESTINATION_LIMIT = 120;

function rewriteElement(element: Element): void {
  const tag = element.tagName.toLowerCase();

  // Read the taint before it is stripped: this is the whole question for an `<a>`,
  // and it can only be asked of the finished value. Everywhere else the markers are
  // bookkeeping that has to come off before anything measures the string — a
  // control character inside a url would fail `isSameOriginUrl` on its own, and
  // inside a `style` it would fail the CSS parse.
  const taintedHref = tag === 'a' && isTainted(element.getAttribute('href') ?? '');
  for (const attribute of Array.from(element.attributes)) {
    if (isTainted(attribute.value)) {
      element.setAttribute(attribute.name, stripTaint(attribute.value));
    }
  }

  for (const [risu, ours] of SCRIPT_ATTRIBUTES) {
    const value = element.getAttribute(risu);
    if (value === null) continue;
    element.removeAttribute(risu);
    element.setAttribute(ours, value);
  }

  const classes = element.getAttribute('class');
  if (classes !== null) {
    const folded = classes.split(/\s+/).filter(Boolean).map(foldClass).join(' ');
    if (folded) element.setAttribute('class', folded);
    else element.removeAttribute('class');
  }

  // Into the same namespace, so `#id`, `for` and a radio group meet only their own
  // kind (`NAMED_ATTRIBUTES`). A name with nothing left once folded names nothing.
  for (const attribute of NAMED_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value === null) continue;
    const folded = foldClass(value.trim());
    if (folded === CLASS_PREFIX) element.removeAttribute(attribute);
    else element.setAttribute(attribute, folded);
  }

  const style = element.getAttribute('style');
  if (style !== null) {
    const safe = rewriteInlineStyle(style);
    if (safe) element.setAttribute('style', safe);
    else element.removeAttribute('style');
  }

  if (tag === 'a') {
    const href = element.getAttribute('href') ?? '';
    const external = isExternalUrl(href);
    if (taintedHref) {
      // Part of this destination was written by the model. The link becomes text:
      // the label stands, the anchor stops being one, and the address it would
      // have gone to is spelled out where the reader can read it. Refusing it
      // outright would hide that the card meant to send them somewhere, which is
      // the thing worth knowing; leaving it clickable would put a stranger's
      // origin one click away behind a label the stranger also chose.
      element.removeAttribute('href');
      element.removeAttribute('target');
      element.removeAttribute('rel');
      if (external) {
        const shown = href.trim().slice(0, DESTINATION_LIMIT);
        element.appendChild(element.ownerDocument.createTextNode(` (${shown})`));
      }
      return;
    }
    if (external) {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer nofollow');
    } else {
      element.removeAttribute('href');
      element.removeAttribute('target');
    }
    return;
  }

  if (tag === 'img') {
    if (!isSameOriginUrl(element.getAttribute('src') ?? '')) element.remove();
    return;
  }

  // Music loads as a picture does, from our own origin or not at all. A player
  // may name its file on itself or on the `<source>` inside it, so an absent
  // `src` is no reason to drop it; the background music's marker is held to the
  // same test.
  if (tag === 'audio' || tag === 'source') {
    const src = element.getAttribute('src');
    if (src !== null && !isSameOriginUrl(src)) element.remove();
  }
  const bgm = element.getAttribute('data-shizue-bgm');
  if (bgm !== null && !isSameOriginUrl(bgm)) element.removeAttribute('data-shizue-bgm');

  // A checkbox or a radio, or nothing: a text field would take the reader's
  // typing, and an image input loads its `src` like an `<img>` unchecked.
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? '').trim().toLowerCase();
    if (TOGGLE_TYPES.has(type)) element.setAttribute('type', type);
    else element.remove();
    return;
  }

  // A button never submits: forms cannot survive the whitelist, and the chat page
  // is the only thing that reads `data-shizue-fill` and the script attributes.
  if (tag === 'button') element.setAttribute('type', 'button');
}

/** A complete `<style>` element. An unpaired one is left for DOMPurify to remove. */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/**
 * Sanitizes creator-authored HTML for insertion into a `.shizue-msg` container.
 * Returns '' when the markup cannot be processed — including on the server, where
 * there is no DOM and therefore no way to sanitize anything. With `member` its
 * stylesheets reach only that member's message rows (`MEMBER_ATTRIBUTE`); a
 * `member` that is not a member id sanitizes to nothing.
 */
export function sanitizeCustomHtml(html: string, options: { member?: string } = {}): string {
  if (!html) return '';
  if (options.member !== undefined && !MEMBER_ID.test(options.member)) return '';
  const member = options.member?.toLowerCase();
  const scope: Scope =
    member === undefined
      ? MESSAGE_SCOPE
      : { selector: `[${MEMBER_ATTRIBUTE}="${member}"] .${MESSAGE_SCOPE_CLASS}`, names: `${CLASS_PREFIX}${member}-` };
  try {
    if (!DOMPurify.isSupported) return '';

    // The stylesheets come out before the HTML parser ever sees them. DOMPurify
    // deliberately discards the contents of a raw-text element, so a `<style>`
    // left in place would arrive here empty; and what goes back in has been
    // rebuilt declaration by declaration from an AST and proven free of '<', so
    // it cannot reopen markup. Everything else keeps DOMPurify's own defaults.
    const sheets: string[] = [];
    const markup = html.replace(STYLE_BLOCK, (_element, css: string) => {
      // A stylesheet has no navigable attribute in it, and the one thing that can
      // name a resource — `url()` — is held to our own origin whoever wrote it. So
      // the markers are of no use here and would only fail the parse.
      const rewritten = rewriteStylesheet(stripTaint(css), scope);
      if (rewritten) sheets.push(rewritten);
      return '';
    });

    const first = DOMPurify.sanitize(markup, PURIFY_CONFIG);

    // A detached <template>, so the markup is inspected without being live: an
    // <img> does not load while its src is still being checked.
    const holder = document.createElement('template');
    holder.innerHTML = first;
    // Text first: nothing reads it, and it must not leave with markers in it.
    const text = document.createTreeWalker(holder.content, NodeFilter.SHOW_TEXT);
    for (let node = text.nextNode(); node; node = text.nextNode()) {
      if (node.nodeValue && isTainted(node.nodeValue)) node.nodeValue = stripTaint(node.nodeValue);
    }
    for (const element of Array.from(holder.content.querySelectorAll('*'))) {
      rewriteElement(element);
    }

    const body = DOMPurify.sanitize(holder.innerHTML, PURIFY_CONFIG);
    return sheets.length > 0 ? `<style>${sheets.join('\n')}</style>${body}` : body;
  } catch {
    return '';
  }
}
