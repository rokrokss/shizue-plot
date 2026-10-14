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
 *      under `.shizue-msg`, every class namespaced `x-shizue-`, every declaration passed
 *      through a property and function allowlist, every at-rule that cannot be
 *      scoped dropped.
 *   2. DOMPurify against a tag/attribute whitelist — no script, no event handler,
 *      no framed or form element, no `javascript:` / `data:` URL.
 *   3. A DOM pass for what a string filter cannot see: classes namespaced, inline
 *      styles put through the same declaration filter, link and image targets
 *      re-checked, followed by a second DOMPurify pass so nothing that pass
 *      introduced escapes review.
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
 * member's messages, or claim its scope.
 */

import { CssTypes, parse, stringify, type CssAtRuleAST, type CssRuleAST } from '@adobe/css-tools';
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
];

const ALLOWED_ATTR = [
  'class', 'style', 'title', 'alt', 'src', 'href', 'target', 'rel',
  'colspan', 'rowspan', 'span', 'width', 'height',
  'value', 'max', 'min', 'low', 'high', 'optimum', 'open', 'type', 'datetime',
  // `<ol start>` from markdown; `<font color face size>` and `align` from cards.
  'start', 'color', 'face', 'size', 'align',
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
  'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
  'table-layout', 'border-collapse', 'border-spacing', 'caption-side',
  'transform', 'transform-origin', 'transition', 'background',
  // `::before { content: '' }` is how decorative shapes are drawn, so a status
  // window without it loses its bars and dividers. Safe here because the value
  // still goes through the function allowlist: `attr()` and `counter()` are not
  // in it, and `url()` is same-origin. A quoted string only writes text, which
  // the template could already do in markup.
  'content',
]);

/** Prefix families of the same. `border` covers `border-radius`, `border-color`, … */
const ALLOWED_PROPERTY_PREFIXES = [
  'background-', 'border', 'margin', 'padding', 'min-', 'max-',
  'font', 'text-', 'list-style', 'flex', 'grid', 'align-', 'justify-', 'place-',
  'overflow', 'transition-',
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

/** `position` values that stay inside the message. `fixed` and `sticky` do not. */
const ALLOWED_POSITIONS = new Set(['static', 'relative', 'absolute']);

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

const isAllowedProperty = (name: string): boolean =>
  ALLOWED_PROPERTIES.has(name) || ALLOWED_PROPERTY_PREFIXES.some((prefix) => name.startsWith(prefix));

const foldClass = (name: string): string => `${CLASS_PREFIX}${name.replace(/[^A-Za-z0-9_-]/g, '')}`;

/**
 * Scopes a selector under the message wrapper and namespaces its classes. Returns
 * null for a selector that should not exist at all — a selector that fails to
 * match is harmless, one that escapes its rule is not.
 */
function scopeSelector(selector: string, scope: string): string | null {
  const trimmed = selector.trim();
  if (!trimmed || SELECTOR_FORBIDDEN.test(trimmed)) return null;
  const renamed = trimmed.replace(SELECTOR_CLASS, (_match, name: string) => `.${foldClass(name)}`);
  return `${scope} ${renamed}`;
}

/**
 * Whether a declaration may stand, judged on its normalized text: an allowed
 * property, only allowed functions, and only same-origin `url()`.
 *
 * The two survivors of the allowlists still need a value check. `position` is
 * allowed but `fixed` is not — the wrapper's paint containment already traps it,
 * and one containment property is not a boundary worth resting on. And `url()`
 * is allowed but only pointing at us, which is what an asset macro produces.
 */
function isSafeDeclaration(property: string, value: string): boolean {
  const name = normalizeCss(property).trim().toLowerCase();
  const text = normalizeCss(value).trim();
  if (!name || !text) return false;
  if (!isAllowedProperty(name)) return false;

  CSS_FUNCTION.lastIndex = 0;
  for (let call = CSS_FUNCTION.exec(text); call; call = CSS_FUNCTION.exec(text)) {
    if (!ALLOWED_FUNCTIONS.has(call[1]!.toLowerCase())) return false;
    // Functions nest, and the scan must see the inner one too.
    CSS_FUNCTION.lastIndex = call.index + call[0].length - 1;
  }

  if (name === 'position' && !ALLOWED_POSITIONS.has(text.toLowerCase())) return false;

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

function rewriteRules(rules: readonly CssAtRuleAST[], scope: string): CssAtRuleAST[] {
  const kept: CssAtRuleAST[] = [];
  for (const rule of rules) {
    if (rule.type === CssTypes.rule) {
      const selectors = (rule.selectors ?? [])
        .map((selector) => scopeSelector(selector, scope))
        .filter((selector): selector is string => selector !== null);
      const declarations = rule.declarations.filter(
        (declaration) =>
          declaration.type === CssTypes.declaration &&
          isSafeDeclaration(declaration.property, declaration.value),
      );
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
    }
    // Everything else — @import, @keyframes, @font-face, @charset, @namespace,
    // @page, @document — is dropped. None of them can be scoped to a message.
  }
  return kept;
}

/** Rewrites a `<style>` body. Anything unparseable becomes no stylesheet at all. */
function rewriteStylesheet(css: string, scope: string): string {
  try {
    const ast = parse(css, { silent: true });
    if ((ast.stylesheet.parsingErrors?.length ?? 0) > 0) return '';
    const rules = rewriteRules(ast.stylesheet.rules, scope);
    if (rules.length === 0) return '';
    const output = stringify({ ...ast, stylesheet: { ...ast.stylesheet, rules } });
    // `<style>` is a raw-text element: a `<` in it would end the element early,
    // and no legitimate declaration needs one.
    return output.includes('<') ? '' : output;
  } catch {
    return '';
  }
}

/** The same declaration filter, applied to a `style="…"` attribute. */
function rewriteInlineStyle(css: string): string {
  try {
    const ast = parse(`*{${css}}`, { silent: true });
    if ((ast.stylesheet.parsingErrors?.length ?? 0) > 0) return '';
    const rule = ast.stylesheet.rules[0];
    if (!rule || rule.type !== CssTypes.rule) return '';
    return rule.declarations
      .filter(
        (declaration) =>
          declaration.type === CssTypes.declaration &&
          isSafeDeclaration(declaration.property, declaration.value),
      )
      .map((declaration) =>
        declaration.type === CssTypes.declaration
          ? `${declaration.property.trim()}: ${declaration.value.trim()}`
          : '',
      )
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
  const scope =
    options.member === undefined
      ? `.${MESSAGE_SCOPE_CLASS}`
      : `[${MEMBER_ATTRIBUTE}="${options.member.toLowerCase()}"] .${MESSAGE_SCOPE_CLASS}`;
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
