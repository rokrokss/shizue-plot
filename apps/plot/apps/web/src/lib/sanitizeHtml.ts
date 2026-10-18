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
 *      prefixed instead, and every reference to them rewritten to match. A rule
 *      or a declaration the parser refuses is dropped on its own, as the browser
 *      drops it, rather than the whole sheet (`repairPiece`).
 *   2. DOMPurify against what RisuAI's DOMPurify lets through — its default HTML,
 *      SVG and MathML, `data-*` and `aria-*`, every form control, a YouTube frame
 *      — less what cannot be made safe on a page that holds the owner's data
 *      (`HTML_TAGS`, `ALLOWED_ATTR`): no script, no event handler, no `<form>`, no
 *      popover or invoker that lifts a box into the top layer, no `javascript:`
 *      / `data:` URL.
 *   3. A DOM pass for what a string filter cannot see: classes, ids and every
 *      attribute that names one namespaced, inline styles put through the same
 *      declaration filter, every address re-checked — links, pictures, music, an
 *      SVG's references to its own gradients and filters, a frame's host — and
 *      the app's own data attributes taken off, followed by a second DOMPurify
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
 * on the row around the markup; nothing a template writes can carry it — every
 * `data-shizue-*` but the button bridge's is taken off (`APP_DATA_ATTRIBUTES`) —
 * so no card can dress another member's messages, claim its scope, or run its
 * buttons as that member's. Its animations and font families are
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

/*
 * What RisuAI lets through, and what of it we do not.
 *
 * RisuAI sanitizes a message with DOMPurify's defaults plus a frame and a few
 * attributes of its own (`trimPurifyConfig`, `src/ts/parser/parser.svelte.ts`).
 * The lists below are those defaults as DOMPurify 3.4.16 ships them
 * (`dist/purify.es.mjs`: `html$1`, `svg$1`, `svgFilters`, `mathMl$1`, and the
 * `html`, `svg`, `mathMl` and `xml` attribute lists), written out rather than
 * taken from the library, because `keepsElement` has to answer without a DOM
 * (`lib/markdown/html.ts` cuts a message on the server too), and because what is
 * left out has to be read somewhere. Each omission says why; everything that
 * stays is held to its address rules in `rewriteElement`.
 */

/**
 * DOMPurify's HTML elements, and RisuAI's `iframe` (`rewriteFrame`: YouTube's
 * player only). Left out:
 *
 * - `style` — lifted out and rebuilt before DOMPurify runs (`STYLE_BLOCK`);
 * - `html`, `head`, `body` — never kept in a fragment, and counted as open they
 *   would take the rest of a reply off the prose path (`keepsElement`);
 * - `form` — a form submits on Enter in a lone text field even with no submit
 *   button, and to the page's own address when it names none, so it is
 *   unwrapped and its controls kept with no form to belong to (the page's
 *   policy refuses every submission too: `form-action 'none'`);
 * - `template` — inert without a script, and its content is a fragment of its
 *   own that the DOM pass does not walk;
 * - `content`, `decorator`, `element`, `shadow`, `slot` — names from shadow-DOM
 *   drafts that no browser gives any behaviour in a page's own markup, so
 *   unwrapping them changes nothing on screen, while keeping them would move a
 *   reply that uses one as a wrapper off the prose path.
 */
const HTML_TAGS = [
  'a', 'abbr', 'acronym', 'address', 'area', 'article', 'aside', 'audio',
  'b', 'bdi', 'bdo', 'big', 'blink', 'blockquote', 'br', 'button',
  'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'dir', 'div', 'dl', 'dt',
  'em', 'fieldset', 'figcaption', 'figure', 'font', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li',
  'main', 'map', 'mark', 'marquee', 'menu', 'menuitem', 'meter', 'nav', 'nobr',
  'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'search', 'section', 'select', 'small', 'source', 'spacer',
  'span', 'strike', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'track', 'tt',
  'u', 'ul', 'var', 'video', 'wbr',
];

/**
 * DOMPurify's SVG elements and filter primitives — a status window's icons,
 * gauges and rings. DOMPurify already leaves out `script`, `foreignObject` (a
 * door back into HTML), `use`, `animate` and `set` (the `href` tricks), and so
 * does RisuAI; `style` is lifted out as in HTML. Four names in DOMPurify's list
 * (`enterkeyhint`, `exportparts`, `inputmode`, `part`) are attributes filed
 * there by mistake, not elements.
 */
const SVG_TAGS = [
  'svg', 'altGlyph', 'altGlyphDef', 'altGlyphItem', 'animateColor', 'animateMotion', 'animateTransform',
  'circle', 'clipPath', 'defs', 'desc', 'ellipse', 'filter', 'g', 'glyph', 'glyphRef', 'hkern',
  'image', 'line', 'linearGradient', 'marker', 'mask', 'metadata', 'mpath', 'path', 'pattern',
  'polygon', 'polyline', 'radialGradient', 'rect', 'stop', 'switch', 'symbol', 'text', 'textPath',
  'title', 'tref', 'tspan', 'view', 'vkern',
  'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood',
  'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge',
  'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence',
];

/**
 * DOMPurify's MathML. RisuAI adds `semantics` and `annotation` for the TeX
 * source KaTeX writes beside its formulas; nothing here renders KaTeX, so they
 * stay out, and so does `annotation-xml`, the one MathML element that takes
 * HTML inside it.
 */
const MATHML_TAGS = [
  'math', 'menclose', 'merror', 'mfenced', 'mfrac', 'mglyph', 'mi', 'mlabeledtr', 'mmultiscripts',
  'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mprescripts', 'mroot', 'mrow', 'ms', 'mspace',
  'msqrt', 'mstyle', 'msub', 'msubsup', 'msup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover',
];

const ALLOWED_TAGS = [...HTML_TAGS, ...SVG_TAGS, ...MATHML_TAGS];

/**
 * DOMPurify's HTML attributes. Left out:
 *
 * - `action`, `enctype`, `method`, `novalidate` — no form survives to use them;
 * - `popover`, `popovertarget`, `popovertargetaction`, `command`, `commandfor`
 *   — a popover, or a dialog an invoker opens as a modal, is drawn in the top
 *   layer, above every box the page holds a card's markup in (`.chat-stage`,
 *   ARCHITECTURE §8.1 떠 있는 것): over the header and the composer, and a modal
 *   one makes the rest of the page inert, its way out included;
 * - `srcset` — a list of addresses, none of which an asset macro writes; the
 *   `src` beside it is the one held to our origin;
 * - `nonce` — names a script the page might trust, and nothing here is one.
 */
const HTML_ATTRIBUTES = [
  'accept', 'align', 'alt', 'autocapitalize', 'autocomplete', 'autopictureinpicture', 'autoplay',
  'background', 'bgcolor', 'border', 'capture', 'cellpadding', 'cellspacing', 'checked', 'cite',
  'class', 'clear', 'color', 'cols', 'colspan', 'controls', 'controlslist', 'coords', 'crossorigin',
  'datetime', 'decoding', 'default', 'dir', 'disabled', 'disablepictureinpicture',
  'disableremoteplayback', 'download', 'draggable', 'enterkeyhint', 'exportparts', 'face', 'for',
  'headers', 'height', 'hidden', 'high', 'href', 'hreflang', 'id', 'inert', 'inputmode', 'integrity',
  'ismap', 'kind', 'label', 'lang', 'list', 'loading', 'loop', 'low', 'max', 'maxlength', 'media',
  'min', 'minlength', 'multiple', 'muted', 'name', 'noshade', 'nowrap', 'open', 'optimum', 'part',
  'pattern', 'placeholder', 'playsinline', 'poster', 'preload', 'pubdate', 'radiogroup', 'readonly',
  'rel', 'required', 'rev', 'reversed', 'role', 'rows', 'rowspan', 'spellcheck', 'scope', 'selected',
  'shape', 'size', 'sizes', 'slot', 'span', 'srclang', 'start', 'src', 'step', 'style', 'summary',
  'tabindex', 'title', 'translate', 'type', 'usemap', 'valign', 'value', 'width', 'wrap', 'xmlns',
];

/** DOMPurify's SVG attributes, whole. Every one that reads as CSS is held to the CSS rules (`svgAttributeValue`). */
const SVG_ATTRIBUTES = [
  'accent-height', 'accumulate', 'additive', 'alignment-baseline', 'amplitude', 'ascent',
  'attributename', 'attributetype', 'azimuth', 'basefrequency', 'baseline-shift', 'begin', 'bias',
  'by', 'class', 'clip', 'clippathunits', 'clip-path', 'clip-rule', 'color', 'color-interpolation',
  'color-interpolation-filters', 'color-profile', 'color-rendering', 'cx', 'cy', 'd', 'dx', 'dy',
  'diffuseconstant', 'direction', 'display', 'divisor', 'dominant-baseline', 'dur', 'edgemode',
  'elevation', 'end', 'exponent', 'fill', 'fill-opacity', 'fill-rule', 'filter', 'filterunits',
  'flood-color', 'flood-opacity', 'font-family', 'font-size', 'font-size-adjust', 'font-stretch',
  'font-style', 'font-variant', 'font-weight', 'fx', 'fy', 'g1', 'g2', 'glyph-name', 'glyphref',
  'gradientunits', 'gradienttransform', 'height', 'href', 'id', 'image-rendering', 'in', 'in2',
  'intercept', 'k', 'k1', 'k2', 'k3', 'k4', 'kerning', 'keypoints', 'keysplines', 'keytimes', 'lang',
  'lengthadjust', 'letter-spacing', 'kernelmatrix', 'kernelunitlength', 'lighting-color', 'local',
  'marker-end', 'marker-mid', 'marker-start', 'markerheight', 'markerunits', 'markerwidth',
  'maskcontentunits', 'maskunits', 'max', 'mask', 'mask-type', 'media', 'method', 'mode', 'min',
  'name', 'numoctaves', 'offset', 'operator', 'opacity', 'order', 'orient', 'orientation', 'origin',
  'overflow', 'paint-order', 'path', 'pathlength', 'patterncontentunits', 'patterntransform',
  'patternunits', 'pointer-events', 'points', 'preservealpha', 'preserveaspectratio',
  'primitiveunits', 'r', 'rx', 'ry', 'radius', 'refx', 'refy', 'repeatcount', 'repeatdur', 'restart',
  'result', 'rotate', 'scale', 'seed', 'shape-rendering', 'slope', 'specularconstant',
  'specularexponent', 'spreadmethod', 'startoffset', 'stddeviation', 'stitchtiles', 'stop-color',
  'stop-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-opacity', 'stroke', 'stroke-width', 'style', 'surfacescale',
  'systemlanguage', 'tabindex', 'tablevalues', 'targetx', 'targety', 'transform', 'transform-origin',
  'text-anchor', 'text-decoration', 'text-orientation', 'text-rendering', 'textlength', 'type', 'u1',
  'u2', 'unicode', 'values', 'vector-effect', 'viewbox', 'visibility', 'version', 'vert-adv-y',
  'vert-origin-x', 'vert-origin-y', 'width', 'word-spacing', 'wrap', 'writing-mode',
  'xchannelselector', 'ychannelselector', 'x', 'x1', 'x2', 'xmlns', 'y', 'y1', 'y2', 'z', 'zoomandpan',
];

/** DOMPurify's MathML attributes. Its `href` makes no link here (`rewriteElement`). */
const MATHML_ATTRIBUTES = [
  'accent', 'accentunder', 'align', 'bevelled', 'close', 'columnalign', 'columnlines',
  'columnspacing', 'columnspan', 'denomalign', 'depth', 'dir', 'display', 'displaystyle', 'encoding',
  'fence', 'frame', 'height', 'href', 'id', 'largeop', 'length', 'linethickness', 'lquote', 'lspace',
  'mathbackground', 'mathcolor', 'mathsize', 'mathvariant', 'maxsize', 'minsize', 'movablelimits',
  'notation', 'numalign', 'open', 'rowalign', 'rowlines', 'rowspacing', 'rowspan', 'rspace', 'rquote',
  'scriptlevel', 'scriptminsize', 'scriptsizemultiplier', 'selection', 'separator', 'separators',
  'stretchy', 'subscriptshift', 'supscriptshift', 'symmetric', 'voffset', 'width', 'xmlns',
];

/**
 * DOMPurify's namespaced attributes, less `xml:id`, an id the folding would
 * not see. `xlink:href` is read as `href` (`rewriteElement`).
 */
const XML_ATTRIBUTES = ['xlink:href', 'xlink:title', 'xml:space', 'xmlns:xlink'];

/**
 * RisuAI's frame attributes (`allow`, `allowfullscreen`, `frameborder`,
 * `scrolling`) and the two more `rewriteFrame` writes. A card's own `allow`,
 * `allowfullscreen` and `sandbox` never stand — `rewriteFrame` puts ours in
 * their place.
 */
const FRAME_ATTRIBUTES = ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'sandbox', 'referrerpolicy'];

const ALLOWED_ATTR = [
  ...new Set([
    ...HTML_ATTRIBUTES, ...SVG_ATTRIBUTES, ...MATHML_ATTRIBUTES, ...XML_ATTRIBUTES, ...FRAME_ATTRIBUTES,
    // Links leave in a tab of their own (`rewriteElement`).
    'target',
    // RisuAI's script buttons, under their own names for the first pass; ours
    // after it are data attributes (`SCRIPT_ATTRIBUTES`).
    'risu-trigger', 'risu-id', 'risu-btn',
  ]),
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
 * The attributes that name an element, a radio group or an image map, folded as
 * classes are (`foldClass`): a card's `id="composer"` is `x-shizue-composer`,
 * which no element of the page carries, so `#id` in a stylesheet can only match
 * one of the creator's own, and a radio `name` can only group with the creator's
 * radios. A card that wants one toggle per message writes `{{chat_index}}` into
 * its ids, as it must in RisuAI, where ids are page-wide too.
 */
const NAMED_ATTRIBUTES = ['id', 'name'] as const;

/**
 * The attributes that point at elements by id, each a list of them: a `<label
 * for>` can only flip one of the creator's own inputs, an `<input list>` offer
 * the creator's own options, and an `aria-labelledby` read the creator's own
 * words, because every id they name is folded the way the ids are.
 */
const ID_REFERENCE_ATTRIBUTES = [
  'for', 'list', 'headers',
  'aria-activedescendant', 'aria-controls', 'aria-describedby', 'aria-details',
  'aria-errormessage', 'aria-flowto', 'aria-labelledby', 'aria-owns',
] as const;

/**
 * The button bridge: the data attributes the chat page reads off a click
 * (`data-shizue-fill`, the script attributes under our names) and the music
 * marker `useBackgroundMusic` plays (`data-shizue-bgm`). The only `data-shizue-*`
 * that stand.
 */
const BRIDGE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'data-shizue-fill', 'data-shizue-bgm', ...SCRIPT_ATTRIBUTES.map(([, ours]) => ours),
]);

/**
 * The data attributes that are the app's own, which a card's `data-*` may not
 * be: our namespace (`data-shizue-member` and `data-shizue-spoken` say whose
 * scripts a button in a row runs), and the names the app finds its own elements
 * by or styles them by. App code that looks an element up by a data attribute
 * from inside a message names it `data-shizue-*`, or adds it here.
 */
const APP_DATA_PREFIX = 'data-shizue-';
const APP_DATA_ATTRIBUTES: ReadonlySet<string> = new Set([
  'data-testid', 'data-chat-image', 'data-image-group', 'data-message-list', 'data-hide-icons', 'data-dialogue',
]);

/**
 * Whether an element holds the rest of a block open when left unclosed
 * (`lib/markdown/html.ts`): one it keeps in HTML. An SVG or MathML element is
 * only ever inside its `<svg>` or `<math>`, which holds the block open itself;
 * outside one, the parser drops it, so a model's `<Text>` or `<Line>` is no
 * element at all.
 */
const KEPT_TAGS: ReadonlySet<string> = new Set([...HTML_TAGS, 'svg', 'math']);

/** Whether an element survives the whitelist — anything else is unwrapped, its text kept. */
export const keepsElement = (tag: string): boolean => KEPT_TAGS.has(tag.toLowerCase());

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // RisuAI's: a card's `data-*` and `aria-*`, which its stylesheet selects on.
  // The app's own come off in the DOM pass (`APP_DATA_ATTRIBUTES`).
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // Their values are free text (a trigger's name, a frame's permissions), not
  // URLs, so they must not be measured against the URI whitelist.
  ADD_URI_SAFE_ATTR: [...SCRIPT_ATTRIBUTES.flat(), 'allow', 'sandbox', 'referrerpolicy'],
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
/**
 * A selector that starts with a combinator. A browser drops it at the top of a
 * sheet, so no card relies on it; put under the scope it would become
 * `.shizue-msg ~ div` and reach the app's own markup beside the message.
 */
const SELECTOR_LEADING_COMBINATOR = /^[>+~]/;
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
/** Any function call in a value: the name immediately before an opening paren, in any case, as the browser reads it. */
const CSS_FUNCTION = /(?:^|[^\w-])(-?[a-z_][\w-]*)\s*\(/gi;
/** `\41`, `\000041 `, `\;` — a CSS escape, which the browser reads and a filter must too. */
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/g;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * The declarations a message may carry: visual properties whose worst outcome is
 * an ugly message. Default-deny, because the interesting attacks are always in
 * the property nobody thought about — `-moz-binding` ran script, `user-modify`
 * made the page editable, `behavior` loaded code. Each family below says why it
 * is only looks, and whatever value it takes still passes the function allowlist
 * and the same-origin `url()` check (`isSafeDeclaration`).
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
  // Compositing: how a box's pixels mix with what the message drew under it.
  // Ivy, The Vampire Maid draws its portrait through `multiply` and `screen`
  // layers of solid colour, which without them hide it. These were refused for
  // the 2016 pixel theft, which timed a blend over a cross-origin frame from a
  // script; a message has no such script — the one frame is YouTube's player,
  // which shows nothing of the reader's, every picture is our own origin, and
  // no script of the card's runs on the page — and everything they mix stays
  // inside the box that clips the message.
  'mix-blend-mode', 'isolation',
  // A blur, a tint, frosted glass behind a panel: the box's own pixels, or the
  // message's under it, filtered where they are drawn. A `url()` here names an
  // SVG filter, and only one of the card's own (`REFERENCE_PROPERTIES`).
  'filter', 'backdrop-filter',
  // A portrait cut to a circle or a polygon, or to a clip path of the card's
  // own SVG (`REFERENCE_PROPERTIES`). Clipping only ever hides.
  'clip-path',
  // Flip cards and tilted panels: where the 3-D transforms already allowed are
  // seen from, and whether a turned face shows.
  'perspective', 'perspective-origin', 'transform-style', 'backface-visibility', 'translate', 'rotate', 'scale',
  // How the reader's pointer and selection meet the creator's own boxes: a
  // pointer over a button, a decoration that lets clicks through. Inside the
  // message only, and a background's boxes lie under the conversation, which
  // takes the clicks. A cursor is a keyword — a picture of one (`url()`) could
  // stand in for the real pointer, and is refused (`isSafeDeclaration`).
  'cursor', 'pointer-events', 'user-select', 'touch-action',
  // A checkbox toggle drawn as the card's own, columns of text, vertical
  // Japanese, a box that is its own layout and paint island, scaled, or that
  // asks for the dark form controls.
  'appearance', 'columns', 'writing-mode', 'contain', 'zoom', 'color-scheme',
  // The `-webkit-box` clamp a card cuts a long line to three with.
  'line-clamp', 'box-orient',
  // Its own scrolling boxes' bars and their behaviour.
  'scroll-behavior', 'scrollbar-width', 'scrollbar-color', 'scrollbar-gutter',
  // An SVG's painting — a shape's fill, a gradient's stops, a filter's flood,
  // where its text sits — and its geometry, the ring a gauge draws with `r` and
  // a dash offset. Pixels only; a `url()` in the painting ones may name nothing
  // but the card's own gradient, pattern or marker (`REFERENCE_PROPERTIES`).
  'fill', 'fill-opacity', 'fill-rule', 'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
  'lighting-color', 'paint-order', 'vector-effect', 'shape-rendering', 'dominant-baseline',
  'alignment-baseline', 'baseline-shift', 'color-interpolation', 'color-interpolation-filters',
  'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'd',
]);

/**
 * Prefix families of the same. `border` covers `border-radius`, `border-color`, …;
 * `mask` the gradient fades a card softens a picture's edge with (`url()`s
 * only to its own SVG, `REFERENCE_PROPERTIES`); `outline` a focus ring of the
 * card's own; `column-` the rules between its columns; `overscroll-` its
 * scrolling boxes'; `stroke` an SVG line's width, dashes and ends; `marker` the
 * arrowheads on one.
 */
const ALLOWED_PROPERTY_PREFIXES = [
  'background-', 'border', 'margin', 'padding', 'min-', 'max-',
  'font', 'text-', 'list-style', 'flex', 'grid', 'align-', 'justify-', 'place-',
  'overflow', 'transition-', 'animation-', 'inset-',
  'mask', 'outline', 'column-', 'overscroll-', 'stroke', 'marker',
];

/**
 * The properties where a `url()` is not a picture but a reference to an SVG
 * element — a filter, a clip path, a mask, a gradient or pattern to paint
 * with, a marker. There it may only be a fragment, `url(#glow)`, which names an
 * element by id, and since every id is folded (`foldReferences`), only one of
 * the card's own: never a file, whatever its origin, and never the page's.
 */
const REFERENCE_PROPERTIES = /^(?:filter|backdrop-filter|clip-path|mask.*|fill|stroke|marker.*)$/;

/**
 * The name a declaration is judged by: its own, or — for a `-webkit-` one — the
 * standard property it spells, so `-webkit-backdrop-filter` and
 * `-webkit-mask-image` pass with theirs and `-webkit-user-modify` fails with
 * `user-modify`. Every value rule that follows the name (positions, animation
 * names, families, `url()`) follows it under its prefix too.
 */
const canonicalProperty = (name: string): string => (name.startsWith('-webkit-') ? name.slice(8) : name);

/**
 * The functions a value may call. Everything that can name a resource is either
 * here and URL-checked (`url`) or absent — `image-set()`, `-webkit-image-set()`,
 * `cross-fade()`, `element()` and `paint()` all fetch or sample without ever
 * spelling `url(`, which is why this is an allowlist and not a denylist. What
 * the families above take beyond the transforms and gradients: filter effects,
 * clip shapes, grid tracks and the browser's safe-area insets — numbers and
 * colours in, pixels out.
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
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  'inset', 'circle', 'ellipse', 'polygon', 'rect', 'xywh', 'path',
  'repeat', 'minmax', 'fit-content',
  'env',
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
  if (!trimmed || SELECTOR_FORBIDDEN.test(trimmed) || SELECTOR_LEADING_COMBINATOR.test(trimmed)) return null;
  const rename = (text: string): string =>
    text
      .replace(SELECTOR_CLASS, (_match, name: string) => `.${foldClass(name)}`)
      .replace(SELECTOR_ID, (_match, name: string) => `#${foldClass(name)}`);
  return `${scope.selector} ${outsideAttributeSelectors(trimmed, rename)}`;
}

/**
 * A selector with `rename` applied to everything but its attribute selectors.
 * What `[data-hp="0.5"]` holds is the card's value, not a class: folded, its dot
 * would have eaten the closing quote and taken the rule with it.
 */
function outsideAttributeSelectors(selector: string, rename: (text: string) => string): string {
  let out = '';
  let at = 0;
  for (let open = selector.indexOf('[', at); open >= 0; open = selector.indexOf('[', at)) {
    const close = selector.indexOf(']', open);
    if (close < 0) break;
    out += rename(selector.slice(at, open)) + selector.slice(open, close + 1);
    at = close + 1;
  }
  return out + rename(selector.slice(at));
}

/**
 * Whether a declaration may stand, judged on its normalized text: an allowed
 * property, only allowed functions, and only same-origin `url()`.
 *
 * The survivors of the allowlists still need a value check. `position` is
 * allowed but `sticky` is not (`ALLOWED_POSITIONS`). `url()` is allowed but
 * only pointing at us, which is what an asset macro produces — only at one of
 * the card's own SVG elements where it names one rather than a picture
 * (`REFERENCE_PROPERTIES`), and nowhere at all in a `cursor`, where a picture
 * would stand in for the reader's own pointer. And a value that leaves a
 * bracket or a string open is dropped as the browser would read it: open, it
 * would swallow the declarations and rules after it (`isBalanced`).
 */
function isSafeDeclaration(property: string, value: string): boolean {
  const name = canonicalProperty(normalizeCss(property).trim().toLowerCase());
  const text = normalizeCss(value).trim();
  if (!name || !text) return false;
  if (!isAllowedProperty(name)) return false;
  if (!isBalanced(value)) return false;
  if (!callsOnly(text, ALLOWED_FUNCTIONS)) return false;
  if (name === 'position' && !ALLOWED_POSITIONS.has(text.toLowerCase())) return false;
  if (name === 'cursor' && /url\(/i.test(text)) return false;
  if (REFERENCE_PROPERTIES.test(name)) return urlsAreFragments(text);
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

/** Whether every `url()` in a normalized value is one the browser reads as one address that `accept` takes. */
function urlsAre(text: string, accept: (address: string) => boolean): boolean {
  const opened = text.match(/url\(/gi)?.length ?? 0;
  if (opened === 0) return true;
  const urls = [...text.matchAll(URL_FUNCTION)];
  // A `url(` the matcher could not close is a malformed value; drop it rather
  // than hand a half-parsed one to the browser.
  if (urls.length !== opened) return false;
  return urls.every((match) => {
    const body = unquoteUrl(match[1]!);
    return body !== null && accept(body);
  });
}

/** Whether every `url()` in a normalized value is on our origin. */
const urlsAreOurs = (text: string): boolean => urlsAre(text, isSameOriginUrl);

/** A fragment: an element of this page by its id, which the browser reads as such only when it starts the address. */
const FRAGMENT = /^#[^\s#\\]*$/;

/** Whether every `url()` in a normalized value names an element by id — never a file. */
const urlsAreFragments = (text: string): boolean => urlsAre(text, (address) => FRAGMENT.test(address));

/** A `url(#id)` as a value spells it, quoted or not. Linear: no part of it can take what the next part matches. */
const FRAGMENT_URL = /url\(\s*(['"]?)#([^\s'"()\\]*)\1\s*\)/gi;

/**
 * A value with every `url(#id)` in it pointed at the id as the DOM pass folds
 * ids (`foldClass`), so a card's `fill: url(#glow)` still finds its own
 * `<linearGradient id="glow">`, and can find nothing of the page's. One spelled
 * with escapes is left as it is, and names nothing.
 */
const foldReferences = (value: string): string =>
  value.replace(FRAGMENT_URL, (_match, _quote, id: string) => `url(#${foldClass(id)})`);

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
 * animation, a font family or an element by id (`renameAnimations`,
 * `renameFamilies`, `foldReferences`) — or null where it may not stand at all
 * (`isSafeDeclaration`).
 */
function rewriteDeclaration(property: string, value: string, scope: Scope): string | null {
  if (!isSafeDeclaration(property, value)) return null;
  const name = canonicalProperty(normalizeCss(property).trim().toLowerCase());
  if (name === 'animation' || name === 'animation-name') {
    if (/var\(/i.test(normalizeCss(value))) return null;
    return renameAnimations(normalizeCss(value).trim(), name === 'animation', scope.names);
  }
  if (name === 'font-family') return renameFamilies(normalizeCss(value).trim(), value, scope.names);
  return foldReferences(value);
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
 * and they parse to the same rules (`sanitizeHtml.test.ts`). A `}` with no
 * block open is junk the browser reads into the next rule's selector, so it
 * stays with that rule, which goes with it.
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
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0) {
        pieces.push(css.slice(start, i + 1));
        start = i + 1;
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

/** The bracket each opening one is closed by. */
const CLOSER: Readonly<Record<string, string>> = { '{': '}', '(': ')', '[': ']' };

/**
 * Reads CSS as the browser's tokenizer nests it — strings, comments and escapes
 * passed over, `{`, `(` and `[` each open until its own partner closes it —
 * calling `visit` with each character outside all of them (the opening bracket
 * itself included). Answers whether everything opened was closed by the end. A
 * string ends at its quote or, unterminated, at the line's end, as a browser's
 * does; a comment left open runs to the end, which leaves nothing open.
 */
function scanCss(text: string, visit?: (char: string, at: number) => boolean | void): boolean {
  const open: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return open.length === 0;
      i = end + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let at = i + 1;
      while (at < text.length && text[at] !== char && text[at] !== '\n') at += text[at] === '\\' ? 2 : 1;
      if (at >= text.length || text[at] === '\n') return false;
      i = at;
      continue;
    }
    if (open.length === 0 && visit?.(char, i) === true) return true;
    const closer = CLOSER[char];
    if (closer) open.push(closer);
    else if (char === open[open.length - 1]) open.pop();
  }
  return open.length === 0;
}

/** Whether a value closes every bracket and string it opens — one that does not runs on past its declaration. */
const isBalanced = (value: string): boolean => scanCss(value);

/** Where the text has `char` outside every bracket, string and comment. */
function topLevel(text: string, chars: string): number[] {
  const at: number[] = [];
  scanCss(text, (char, index) => {
    if (chars.includes(char)) at.push(index);
  });
  return at;
}

/** The text without its comments — strings and escapes kept as they are; a comment left open takes the rest. */
function withoutComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '\\') {
      out += text.slice(i, i + 2);
      i += 1;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
    } else if (char === '"' || char === "'") {
      let at = i + 1;
      while (at < text.length && text[at] !== char && text[at] !== '\n') at += text[at] === '\\' ? 2 : 1;
      out += text.slice(i, at + 1);
      i = at;
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Where the block opened at `open` ends: the index of its own `}`, or the
 * text's length when the text ends first — which, in the browser, closes it.
 */
function blockEnd(text: string, open: number): number {
  let after = -1;
  const closed = scanCss(text.slice(open), (_char, at) => {
    if (at === 0) return false;
    after = at;
    return true;
  });
  if (after > 0) return open + after - 1;
  return closed ? text.length - 1 : text.length;
}

/**
 * The declarations of a block as the browser keeps them: each one up to a `;`
 * outside brackets and strings, and of those only the ones that are a name, a
 * colon and a value that closes what it opens. A declaration with a block in it
 * — Renka's `border: 3px solid {border}`, a placeholder for its scripts — or no
 * colon at all is dropped, and only it: the rest of the rule stands.
 */
function cleanDeclarations(body: string): string {
  const kept: string[] = [];
  let from = 0;
  for (const end of [...topLevel(body, ';'), body.length]) {
    const declaration = body.slice(from, end).trim();
    from = end + 1;
    if (!declaration || topLevel(declaration, '{}').length > 0 || !isBalanced(declaration)) continue;
    const colon = topLevel(declaration, ':')[0];
    if (colon === undefined || !/^-{0,2}[A-Za-z_\\][\w\\-]*$/.test(declaration.slice(0, colon).trim())) continue;
    if (!declaration.slice(colon + 1).trim()) continue;
    kept.push(declaration);
  }
  return kept.join(';\n');
}

/**
 * One top-level piece the parser refused, put the way the browser reads it, or
 * null where the browser drops all of it. A rule keeps its declarations but the
 * broken ones (`cleanDeclarations`); a block the sheet leaves open closes at its
 * end, as a browser closes it; `@media`, `@supports` and `@keyframes` keep every
 * rule inside that reads; a selector with a stray brace or `;` in it, and
 * anything with no block at all, go.
 */
function repairPiece(piece: string): string | null {
  const text = withoutComments(piece);
  const open = topLevel(text, '{')[0];
  if (open === undefined) return null;
  const prelude = text.slice(0, open).trim();
  if (!prelude || /[{};]/.test(prelude)) return null;
  const body = text.slice(open + 1, blockEnd(text, open));
  const at = /^@(-?[\w-]+)/.exec(prelude)?.[1]?.toLowerCase();
  if (at === undefined || at === 'font-face') return `${prelude} {\n${cleanDeclarations(body)}\n}`;
  if (at === 'media' || at === 'supports' || at.endsWith('keyframes')) {
    const inner = splitStylesheet(body)
      .map((rule) => (parsesClean(rule) ? rule : repairPiece(rule)))
      .filter((rule): rule is string => rule !== null && parsesClean(rule));
    return `${prelude} {\n${inner.join('\n')}\n}`;
  }
  return null;
}

/** Whether the parser reads a piece without one complaint. */
const parsesClean = (css: string): boolean => (parse(css, { silent: true }).stylesheet.parsingErrors?.length ?? 0) === 0;

/**
 * Rewrites a `<style>` body, one top-level piece at a time (`splitStylesheet`).
 * A piece the parser refuses is read again the way the browser would read it
 * (`repairPiece`), and dropped only if that fails too: as in the browser, a broken
 * declaration or rule costs itself and nothing after it — a RisuAI card's
 * stylesheet with one placeholder in it was otherwise no stylesheet at all.
 * Every piece kept was parsed without a complaint, and is rebuilt from that. The
 * pieces are joined as the library joins the rules of one sheet, so the output
 * is the one a whole parse would have given.
 */
function rewriteStylesheet(css: string, scope: Scope): string {
  const parts: string[] = [];
  for (const piece of splitStylesheet(css)) {
    try {
      let ast = parse(piece, { silent: true });
      if ((ast.stylesheet.parsingErrors?.length ?? 0) > 0) {
        const repaired = repairPiece(piece);
        if (repaired === null) continue;
        ast = parse(repaired, { silent: true });
        if ((ast.stylesheet.parsingErrors?.length ?? 0) > 0) continue;
      }
      const rules = rewriteRules(ast.stylesheet.rules, scope);
      if (rules.length === 0) continue;
      const output = stringify({ ...ast, stylesheet: { ...ast.stylesheet, rules } });
      // `<style>` is a raw-text element: a `<` in it would end the element early,
      // and no legitimate declaration needs one. The piece goes, not the sheet.
      if (!output.includes('<')) parts.push(output);
    } catch {
      // This piece only.
    }
  }
  return parts.join('\n\n');
}

/** The plain scope: every message's wrapper, and the namespace with no member in it. */
const MESSAGE_SCOPE: Scope = { selector: `.${MESSAGE_SCOPE_CLASS}`, names: CLASS_PREFIX };

/**
 * The same declaration filter, applied to a `style="…"` attribute — read, where
 * the parser refuses it, the way the browser reads one: the broken declarations
 * go and the rest stand (`cleanDeclarations`).
 */
function rewriteInlineStyle(css: string): string {
  try {
    let ast = parse(`*{${css}}`, { silent: true });
    if ((ast.stylesheet.parsingErrors?.length ?? 0) > 0) {
      ast = parse(`*{${cleanDeclarations(withoutComments(css))}}`, { silent: true });
      if ((ast.stylesheet.parsingErrors?.length ?? 0) > 0) return '';
    }
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

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** YouTube's player, the one frame RisuAI draws (`https://www.youtube.com/embed/…`), and its cookieless twin. */
const FRAME_HOSTS: ReadonlySet<string> = new Set(['www.youtube.com', 'www.youtube-nocookie.com']);
/** A video's or a playlist's player (`/embed/videoseries?list=…`), and no other page of the host. */
const FRAME_PATH = /^\/embed\/[A-Za-z0-9_-]{1,64}$/;
/**
 * What the player may do: run its own script under its own origin — which is
 * YouTube's, never ours, the host being checked — and play: autoplay, protected
 * video, full screen, picture in picture. No popup, no form, no navigating the
 * page, no camera, microphone or anything else a card might ask for.
 */
const FRAME_SANDBOX = 'allow-scripts allow-same-origin';
const FRAME_ALLOW = 'autoplay; encrypted-media; fullscreen; picture-in-picture';

/**
 * The address of the YouTube player a frame names, as the browser will load it,
 * or null for any other: decided on the parsed URL — `https:`, the host itself
 * with no port or credentials, the player's path after `..` and its encodings are
 * resolved — never on how the address starts.
 */
function frameUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || URL_FORBIDDEN_CHARS.test(value) || URL_FORBIDDEN_ENCODED.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !FRAME_HOSTS.has(url.hostname) || url.port || url.username || url.password) {
      return null;
    }
    return FRAME_PATH.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A YouTube player, or nothing: any other frame is removed, and so is one in a
 * block still being written (`live`), whose markup is drawn again on every token
 * and would load the player again with it. What it may do is ours to say, never
 * the card's (`FRAME_SANDBOX`, `FRAME_ALLOW`); the page's policy names the same
 * two hosts (`frame-src`). It sends our origin as its referrer, as every request
 * of the page does: the player refuses to play without one.
 */
function rewriteFrame(element: Element, live: boolean): void {
  const src = frameUrl(element.getAttribute('src') ?? '');
  if (src === null || live) {
    element.remove();
    return;
  }
  element.removeAttribute('allowfullscreen');
  element.setAttribute('src', src);
  element.setAttribute('sandbox', FRAME_SANDBOX);
  element.setAttribute('allow', FRAME_ALLOW);
  element.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  element.setAttribute('loading', 'lazy');
}

/** Ids, separated by whitespace, each folded as an `id` is. Empty when none is left. */
const foldIds = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map(foldClass)
    .filter((id) => id !== CLASS_PREFIX)
    .join(' ');

/** The SVG attributes that are not read as CSS: names, addresses and the style, which have rules of their own. */
const SVG_PLAIN_ATTRIBUTES: ReadonlySet<string> = new Set(['id', 'class', 'name', 'style', 'href']);

/**
 * An SVG attribute's value as it may stand, or null. Its presentation
 * attributes — `fill`, `filter`, `clip-path`, `mask`, `transform` — are read as
 * CSS, escapes and all, so they are held to the stylesheet's rules: only the
 * functions a style may call, and a `url()` only to one of the card's own
 * elements, pointed at its folded id (`foldReferences`). A value with no
 * parenthesis calls nothing and stands as written.
 */
function svgAttributeValue(value: string): string | null {
  if (!value.includes('(')) return value;
  const text = normalizeCss(value);
  if (!callsOnly(text, ALLOWED_FUNCTIONS) || !urlsAreFragments(text)) return null;
  return foldReferences(text);
}

/**
 * Where an SVG element other than a link points (`href`): one of the card's own
 * elements by its folded id — a gradient another inherits from, a text's path, a
 * motion's — or, for a picture (`<image>`, `<feImage>`), a file of our own
 * origin as an `<img>` may load. Anything else names a file elsewhere and goes:
 * the attribute, or the picture with it. Answers whether the element went.
 */
function rewriteSvgReference(element: Element, tag: string, href: string): boolean {
  const value = href.trim();
  if (value.startsWith('#')) {
    const id = foldClass(value.slice(1));
    if (id === CLASS_PREFIX) element.removeAttribute('href');
    else element.setAttribute('href', `#${id}`);
    return false;
  }
  if ((tag === 'image' || tag === 'feimage') && !isSameOriginUrl(value)) {
    element.remove();
    return true;
  }
  if (tag !== 'image' && tag !== 'feimage') element.removeAttribute('href');
  return false;
}

function rewriteElement(element: Element, live: boolean): void {
  const tag = element.tagName.toLowerCase();
  const svg = element.namespaceURI === SVG_NAMESPACE;
  const link = tag === 'a' || tag === 'area';

  // SVG's old spelling of an address, read as the one SVG 2 and every browser
  // now read — so the rules below, the link's included, see the one address.
  const legacy = element.getAttribute('xlink:href');
  if (legacy !== null) {
    element.removeAttribute('xlink:href');
    if (!element.hasAttribute('href')) element.setAttribute('href', legacy);
  }

  // Read the taint before it is stripped: this is the whole question for a link,
  // and it can only be asked of the finished value. Everywhere else the markers are
  // bookkeeping that has to come off before anything measures the string — a
  // control character inside a url would fail `isSameOriginUrl` on its own, and
  // inside a `style` it would fail the CSS parse.
  const taintedHref = link && isTainted(element.getAttribute('href') ?? '');
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

  // A card's `data-*` stands for its stylesheet; the app's own do not
  // (`APP_DATA_ATTRIBUTES`), nor does any attribute an SVG reads as CSS and the
  // CSS rules refuse.
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith(APP_DATA_PREFIX) ? !BRIDGE_ATTRIBUTES.has(name) : APP_DATA_ATTRIBUTES.has(name)) {
      element.removeAttribute(attribute.name);
    } else if (svg && !SVG_PLAIN_ATTRIBUTES.has(name) && !name.startsWith('data-') && !name.startsWith('aria-')) {
      const value = svgAttributeValue(attribute.value);
      if (value === null) element.removeAttribute(attribute.name);
      else if (value !== attribute.value) element.setAttribute(attribute.name, value);
    }
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
  for (const attribute of ID_REFERENCE_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value === null) continue;
    const folded = foldIds(value);
    if (folded) element.setAttribute(attribute, folded);
    else element.removeAttribute(attribute);
  }
  // An image map is named as a fragment (`usemap="#menu"`) and its `<map name>` folded.
  const usemap = element.getAttribute('usemap');
  if (usemap !== null) {
    const name = foldClass(usemap.trim().replace(/^#/, ''));
    if (name === CLASS_PREFIX) element.removeAttribute('usemap');
    else element.setAttribute('usemap', `#${name}`);
  }

  const style = element.getAttribute('style');
  if (style !== null) {
    const safe = rewriteInlineStyle(style);
    if (safe) element.setAttribute('style', safe);
    else element.removeAttribute('style');
  }

  if (link) {
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

  // Only a link goes anywhere: an SVG element's `href` names one of its own
  // (`rewriteSvgReference`), and a MathML one's would make a link the rules
  // above never saw.
  const href = element.getAttribute('href');
  if (href !== null) {
    if (!svg) element.removeAttribute('href');
    else if (rewriteSvgReference(element, tag, href)) return;
  }

  if (tag === 'iframe') {
    rewriteFrame(element, live);
    return;
  }

  if (tag === 'img') {
    if (!isSameOriginUrl(element.getAttribute('src') ?? '')) element.remove();
    return;
  }

  // Everything else that loads a file loads as a picture does, from our own
  // origin or not at all: music and video, their `<source>` and `<track>`, an
  // image button. A player may name its file on itself or on the `<source>`
  // inside it, so an absent `src` is no reason to drop it. A video's poster and
  // a table's old `background` picture are held to the same test, and so is the
  // background music's marker.
  const src = element.getAttribute('src');
  if (src !== null && !isSameOriginUrl(src)) {
    element.remove();
    return;
  }
  for (const attribute of ['poster', 'background', 'data-shizue-bgm']) {
    const value = element.getAttribute(attribute);
    if (value !== null && !isSameOriginUrl(value)) element.removeAttribute(attribute);
  }

  // Any kind of input, as RisuAI keeps them: a text field, a slider, a picker.
  // None has a form to submit (`HTML_TAGS`), and nothing of the app reads what
  // is typed into one.
  if (tag === 'input') {
    const type = element.getAttribute('type');
    if (type !== null) element.setAttribute('type', type.trim().toLowerCase());
    return;
  }

  // A button never submits: no form survives the whitelist, and the chat page
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
 * `member` that is not a member id sanitizes to nothing. `live` is markup still
 * being written, drawn again on every token: it holds no frame (`rewriteFrame`).
 */
export function sanitizeCustomHtml(html: string, options: { member?: string; live?: boolean } = {}): string {
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
      rewriteElement(element, options.live === true);
    }

    const body = DOMPurify.sanitize(holder.innerHTML, PURIFY_CONFIG);
    return sheets.length > 0 ? `<style>${sheets.join('\n')}</style>${body}` : body;
  } catch {
    return '';
  }
}
