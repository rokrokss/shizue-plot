/**
 * What a card's creator loads from other hosts, read off the work's markup and
 * stylesheets, and the same text with those addresses swapped — the pure half
 * of localizing them at import (`apps/api/src/localizeAssets.ts` fetches).
 *
 * RisuAI draws a card's HTML as written, so a status window whose portraits live
 * on an image CDN, or a stylesheet that `@import`s a web font, loads them from
 * there in the reader's browser. Here nothing a chat draws may reach a third
 * host (the sanitizer holds every `url()` and `src` to our origin): the reader's
 * address and reading time would go with it, and since the model's text is
 * evaluated as CBS inside a capture, a model could steer such a request. So the
 * import fetches what the creator wrote, once, on the server, and the work then
 * points at its own copies. What the model writes later stays blocked.
 *
 * Three spellings name a resource:
 *
 * - `@import url(…)` / `@import "…"` — a stylesheet, with the media list after it;
 * - `url(…)` — a picture or a font, in a stylesheet or a `style` attribute;
 * - `src=…` — a picture or music, on any tag.
 *
 * Only absolute addresses count: `https://`, `http://` (fetched as https, as a
 * browser upgrades it on a secure page) and `//host/…`. A `data:` URI, a path of
 * our own and an SVG's `xmlns` are none of these.
 *
 * An address may be a template. A display script's `out` writes its capture
 * into one (`…/Chemise/$2.png`), and a card draws among a fixed few with
 * `{{random::A::B}}`. Those cannot be fetched as written; `parseUrlTemplate`
 * reads the one slot such an address has, and `templateCandidates` names the
 * values the slot is known to take — the drawn words, what the script's own
 * pattern captures from the card's text (its greetings, the instructions that
 * show the model the format), and every item of a `[A, B, C]` list in that text
 * which holds one of those. The import fetches each and serves them by name, so
 * a capture the import did not foresee is a missing picture, not a request out.
 *
 * Every scan is linear: the finder is three literal alternatives, and each
 * address is read by hand with a bounded look-ahead — these run on the server
 * over stylesheets of hundreds of thousands of characters.
 */
import { RE2JS } from 're2js';

/** Which spelling named the resource. */
export type ExternalRefKind = 'import' | 'url' | 'src';

/** One reference to another host, as a text spells it. */
export interface ExternalRef {
  kind: ExternalRefKind;
  /** The address as written, between its quotes or parentheses. */
  address: string;
  /** The https URL to fetch, or null for a template (`parseUrlTemplate`). */
  url: string | null;
  /** `@import` only: the media list after the address, trimmed; '' for none. */
  media: string;
}

/** The longest address read; past it a reference is not one. */
const MAX_ADDRESS_LENGTH = 2048;
/** The longest `@import` media list read. */
const MAX_MEDIA_LENGTH = 512;

const FINDER = /@import\b|url\(|src\s*=/gi;
const WHITESPACE = /\s/;
const TEMPLATE_MARK = /\{\{|\$\d/;

/**
 * Whether an address names another host at all — the three absolute spellings —
 * or may, once its leading `{{getvar::…}}` is read: a card that keeps its host in
 * a variable (`src="{{getvar::cdn}}/face.png"`), which only its variables can say
 * (`parseUrlTemplate`).
 */
function isAbsolute(address: string): boolean {
  return /^(?:(?:https?:)?\/\/|\{\{\s*getvar::)/i.test(address);
}

/** The few entities an attribute's address may carry, decoded as the browser decodes them. */
const decodeEntities = (text: string): string =>
  text.replace(/&(amp|quot|apos|lt|gt|#39|#x27);/gi, (_entity, name: string) => {
    switch (name.toLowerCase()) {
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      default:
        return "'";
    }
  });

/**
 * The https URL an absolute address is fetched from, or null when it is not one
 * the browser would read as such (credentials, a bad host, no host).
 */
export function fetchUrlOf(address: string): string | null {
  let text = decodeEntities(address.trim());
  if (text.startsWith('//')) text = `https:${text}`;
  else if (/^http:\/\//i.test(text)) text = `https://${text.slice(7)}`;
  if (!/^https:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Skips whitespace from `at`. */
function skipSpace(text: string, at: number): number {
  let i = at;
  while (i < text.length && WHITESPACE.test(text[i]!)) i += 1;
  return i;
}

/** An address read off a text: where it starts, what it says, and where its token ends. */
interface Read {
  body: string;
  start: number;
  end: number;
}

/** A quoted string starting at `at` (the quote), bounded: its body and the index after the closing quote. */
function readQuoted(text: string, at: number): Read | null {
  const quote = text[at];
  const limit = Math.min(text.length, at + 1 + MAX_ADDRESS_LENGTH);
  for (let i = at + 1; i < limit; i += 1) {
    const char = text[i]!;
    if (char === quote) return { body: text.slice(at + 1, i), start: at + 1, end: i + 1 };
    if (char === '\n' || char === '\r') return null;
  }
  return null;
}

/** The body of a `url(` whose paren ends at `at`, and the index after its `)`. */
function readUrlFunction(text: string, at: number): Read | null {
  let i = skipSpace(text, at);
  let read: Read;
  if (text[i] === '"' || text[i] === "'") {
    const quoted = readQuoted(text, i);
    if (!quoted) return null;
    read = quoted;
    i = quoted.end;
  } else {
    const start = i;
    const limit = Math.min(text.length, start + MAX_ADDRESS_LENGTH);
    while (i < limit && !/[)\s'"(]/.test(text[i]!)) i += 1;
    read = { body: text.slice(start, i), start, end: i };
  }
  i = skipSpace(text, i);
  return text[i] === ')' ? { ...read, end: i + 1 } : null;
}

/** An `@import` statement whose keyword ends at `at`: its address, media list and end. */
function readImport(text: string, at: number): { body: string; media: string; end: number } | null {
  let i = skipSpace(text, at);
  let read: Read | null = null;
  if (/^url\(/i.test(text.slice(i, i + 4))) read = readUrlFunction(text, i + 4);
  else if (text[i] === '"' || text[i] === "'") read = readQuoted(text, i);
  if (!read) return null;
  i = read.end;
  const start = i;
  const limit = Math.min(text.length, start + MAX_MEDIA_LENGTH);
  while (i < limit && !/[;{}<]/.test(text[i]!)) i += 1;
  if (text[i] === '{' || (i === limit && i < text.length)) return null;
  const media = text.slice(start, i).trim();
  return { body: read.body, media, end: text[i] === ';' ? i + 1 : i };
}

/** A `src=` value whose `=` ends at `at`: its address and the index after it. */
function readSrc(text: string, at: number): Read | null {
  const i = skipSpace(text, at);
  if (text[i] === '"' || text[i] === "'") return readQuoted(text, i);
  let j = i;
  const limit = Math.min(text.length, i + MAX_ADDRESS_LENGTH);
  while (j < limit && !/[\s>"']/.test(text[j]!)) j += 1;
  return j > i ? { body: text.slice(i, j), start: i, end: j } : null;
}

/**
 * What a visitor answers for a reference: for `url` and `src` the address that
 * stands in its place, for `import` the text that stands in the whole
 * statement (the stylesheet inlined, or '' where it went elsewhere). Undefined
 * leaves it as written.
 */
export type ExternalVisitor = (ref: ExternalRef) => string | undefined;

/**
 * `text` with every reference to another host offered to `visit`, in order,
 * and replaced where it answers. A reference inside an `@import` is the
 * statement's, never a `url()` of its own.
 */
export function rewriteExternal(text: string, visit: ExternalVisitor): string {
  let out = '';
  let last = 0;
  // Its own finder: a visitor may scan another text meanwhile.
  const finder = new RegExp(FINDER.source, FINDER.flags);
  for (let found = finder.exec(text); found; found = finder.exec(text)) {
    const start = found.index;
    const after = start + found[0].length;
    const token = found[0].toLowerCase();
    let ref: ExternalRef | null = null;
    let end = after;
    let addressStart = -1;
    let addressEnd = -1;
    if (token === '@import') {
      const read = readImport(text, after);
      if (read && isAbsolute(read.body.trim())) {
        ref = { kind: 'import', address: read.body, url: null, media: read.media };
        end = read.end;
      }
    } else {
      // `src` is an attribute after whitespace — never `data-src` or a word ending in it.
      const before = text[start - 1];
      const read =
        token === 'url('
          ? readUrlFunction(text, after)
          : before === undefined || WHITESPACE.test(before)
            ? readSrc(text, after)
            : null;
      if (read && isAbsolute(read.body.trim())) {
        ref = { kind: token === 'url(' ? 'url' : 'src', address: read.body, url: null, media: '' };
        end = read.end;
        addressStart = read.start;
        addressEnd = read.start + read.body.length;
      }
    }
    if (!ref) continue;
    finder.lastIndex = end;
    ref.url = TEMPLATE_MARK.test(ref.address) ? null : fetchUrlOf(ref.address);
    const replacement = visit(ref);
    if (replacement === undefined) continue;
    if (ref.kind === 'import') {
      out += text.slice(last, start) + replacement;
    } else {
      out += text.slice(last, addressStart) + replacement + text.slice(addressEnd, end);
    }
    last = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Every reference to another host in `text`, in order. */
export function findExternal(text: string): ExternalRef[] {
  const refs: ExternalRef[] = [];
  rewriteExternal(text, (ref) => {
    refs.push(ref);
    return undefined;
  });
  return refs;
}

/* ------------------------------------------------------------ templates */

/** An address with one slot a value goes into, and what the slot is known to draw. */
export interface UrlTemplate {
  /**
   * The https URL up to the slot — '' where the slot opens the address, a
   * variable that holds the host (`variable`).
   */
  prefix: string;
  /** The slot as written: `$2`, `{{random::A::B}}`, `{{getvar::cdn}}`. */
  slot: string;
  /** After the slot, a query included. */
  suffix: string;
  /** Words the slot draws among. */
  literals: string[];
  /** Capture numbers whose text the slot is. */
  captures: number[];
  /**
   * The chat variable the slot reads (`{{getvar::name}}`): its values are what
   * the card sets it to — its default and every literal `setvar` (`cardVariableValues`).
   */
  variable?: string;
}

const SLOT = /\$(\d{1,2})|\{\{(random|pick)::([^{}]*)\}\}|\{\{\s*getvar::([^{}:]+?)\s*\}\}/g;
const CAPTURE_ITEM = /^\$(\d{1,2})$/;

/**
 * The one slot of a template address, or null for anything this cannot fetch:
 * no slot, two of them, a macro other than a draw, a slot in the host.
 */
export function parseUrlTemplate(address: string): UrlTemplate | null {
  const text = address.trim();
  const slots = [...text.matchAll(SLOT)];
  if (slots.length !== 1) return null;
  const slot = slots[0]!;
  const prefix = text.slice(0, slot.index);
  const suffix = text.slice(slot.index + slot[0].length);
  // Anything else that a renderer would evaluate, the fetch cannot know.
  if (TEMPLATE_MARK.test(prefix) || TEMPLATE_MARK.test(suffix) || /\}\}/.test(prefix + suffix)) return null;
  if (slot[4] !== undefined) {
    const variable = slot[4].trim();
    // The host in the variable, or the slot in the path of a URL of its own.
    if (prefix === '') return { prefix, slot: slot[0], suffix, literals: [], captures: [], variable };
    const head = fetchUrlOf(`${prefix}x`);
    if (!head || !/^(?:https?:)?\/\/[^/]+\/./i.test(`${prefix}x`)) return null;
    return { prefix: head.slice(0, -1), slot: slot[0], suffix, literals: [], captures: [], variable };
  }
  if (prefix === '') return null;
  const base = fetchUrlOf(`${prefix}x`);
  if (!base || !/^(?:https?:)?\/\/[^/]+\/./i.test(`${prefix}x`)) return null;
  const literals: string[] = [];
  const captures: number[] = [];
  if (slot[1] !== undefined) {
    captures.push(Number(slot[1]));
  } else {
    for (const raw of slot[3]!.split('::')) {
      const item = raw.trim();
      const capture = CAPTURE_ITEM.exec(item);
      if (capture) captures.push(Number(capture[1]));
      else if (item && !/[{}$]/.test(item)) literals.push(item);
      else return null;
    }
  }
  return { prefix: base.slice(0, -1), slot: slot[0], suffix, literals, captures };
}

/** A value fit to stand in a path segment: no separator, nothing a URL or a macro reads. */
const SAFE_VALUE = /^[^/\\?#%<>"'{}$:\u0000-\u001f]{1,64}$/;

/** `[A, B, C]` lists in a text — how a card shows the model which words it may write. */
const BRACKET_LIST = /\[([^[\]\n]{1,4000})\]/g;
/** The longest item of such a list. */
const MAX_LIST_ITEM = 40;

/** Every bracketed list of two or more short items in `texts`. */
export function bracketLists(texts: readonly string[]): string[][] {
  const lists: string[][] = [];
  for (const text of texts) {
    BRACKET_LIST.lastIndex = 0;
    for (let found = BRACKET_LIST.exec(text); found; found = BRACKET_LIST.exec(text)) {
      const items = found[1]!.split(',').map((item) => item.trim());
      if (items.length >= 2 && items.every((item) => item.length > 0 && item.length <= MAX_LIST_ITEM)) {
        lists.push(items);
      }
    }
  }
  return lists;
}

/**
 * What a display script's pattern captures in group `group` across `texts`,
 * matched with the linear engine — a card's pattern never runs on the
 * server's own. A pattern it cannot compile captures nothing. JavaScript's
 * `i`, `m` and `s` flags carry over; the rest mean nothing to a scan.
 */
export function linearCaptures(
  pattern: string,
  flags: string,
  texts: readonly string[],
  groups: readonly number[],
  limit = 500,
): Map<number, string[]> {
  const found = new Map<number, string[]>(groups.map((group) => [group, []]));
  let compiled: RE2JS;
  try {
    compiled = RE2JS.compile(
      pattern,
      (flags.includes('i') ? RE2JS.CASE_INSENSITIVE : 0) |
        (flags.includes('m') ? RE2JS.MULTILINE : 0) |
        (flags.includes('s') ? RE2JS.DOTALL : 0),
    );
  } catch {
    return found;
  }
  const count = compiled.groupCount();
  let total = 0;
  for (const text of texts) {
    const matcher = compiled.matcher(text);
    while (total < limit && matcher.find()) {
      total += 1;
      for (const group of groups) {
        if (group > count) continue;
        const value = matcher.group(group);
        if (value) found.get(group)!.push(value.trim());
      }
      // An empty match would find itself again.
      if (matcher.end() === matcher.start()) break;
    }
  }
  return found;
}

/**
 * Whether a display script's pattern matches some of `text` — a match of at
 * least one character, as an empty one (`\s*` between two letters) is no
 * placeholder — decided by the linear engine as `linearCaptures` is: a card's
 * pattern never runs on the server's own. Undefined for a pattern it cannot
 * compile (a lookaround or a backreference, which RE2 has no linear way to
 * run), which says nothing either way.
 */
export function linearMatches(pattern: string, flags: string, text: string): boolean | undefined {
  let compiled: RE2JS;
  try {
    compiled = RE2JS.compile(
      pattern,
      (flags.includes('i') ? RE2JS.CASE_INSENSITIVE : 0) |
        (flags.includes('m') ? RE2JS.MULTILINE : 0) |
        (flags.includes('s') ? RE2JS.DOTALL : 0),
    );
  } catch {
    return undefined;
  }
  const matcher = compiled.matcher(text);
  for (let tries = 0; tries < 1000 && matcher.find(); tries += 1) {
    if (matcher.end() > matcher.start()) return true;
  }
  return false;
}

/**
 * The values a template's slot is fetched with: its drawn words, the captures
 * it reads (`captured`, by capture number), and every item of a list in
 * `lists` that holds one of those already — once, as the model was told to
 * write them, held to what a path segment can be, at most `limit`. A variable's
 * slot takes what the card sets the variable to (`variables`, `cardVariableValues`):
 * a path segment's like the others, or — where it opens the address — a value
 * that makes the whole an https URL.
 */
export function templateCandidates(
  template: UrlTemplate,
  captured: ReadonlyMap<number, readonly string[]>,
  lists: readonly (readonly string[])[],
  limit = 200,
  variables: ReadonlyMap<string, readonly string[]> = new Map(),
): string[] {
  if (template.variable !== undefined) {
    const values = [...new Set(variables.get(template.variable) ?? [])];
    return values
      .filter((value) =>
        template.prefix === ''
          ? value.length <= MAX_ADDRESS_LENGTH && !/[\s"'<>{}]/.test(value) && templateUrl(template, value) !== null
          : SAFE_VALUE.test(value) && value !== '.' && value !== '..',
      )
      .slice(0, limit);
  }
  const seed = new Set<string>(template.literals);
  for (const group of template.captures) for (const value of captured.get(group) ?? []) seed.add(value);
  const known = new Set([...seed].map((value) => value.toLowerCase()));
  const values = [...seed];
  for (const list of lists) {
    if (!list.some((item) => known.has(item.toLowerCase()))) continue;
    for (const item of list) if (!seed.has(item)) (seed.add(item), values.push(item));
  }
  return values.filter((value) => SAFE_VALUE.test(value) && value !== '.' && value !== '..').slice(0, limit);
}

/**
 * The URL a template is fetched at for one value. A variable's value goes in
 * as the renderer writes it, and one that opens the address must make it an
 * https URL — null where it does not.
 */
export function templateUrl(template: UrlTemplate, value: string): string | null {
  if (template.variable !== undefined && template.prefix === '') return fetchUrlOf(`${value}${template.suffix}`);
  return `${template.prefix}${template.variable !== undefined ? value : encodeURIComponent(value)}${template.suffix}`;
}

/**
 * The name an asset fetched from `url` keeps (`plot_assets.name`): the address
 * without its query or fragment, its path decoded — what a by-name request,
 * which the browser percent-encodes, is decoded back to. An asset named this way
 * came from another host, and only such an asset is named with a scheme.
 */
export function localizedName(url: string): string {
  const parsed = new URL(url);
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Kept encoded: the request for it will be too.
  }
  return `https://${parsed.host}${path}`;
}

/** Whether an asset's name says it was fetched from another host at import (`localizedName`). */
export const isLocalizedAssetName = (name: string | null | undefined): boolean =>
  typeof name === 'string' && name.startsWith('https://');

/**
 * A template's name the same way, the slot left in where the value goes — what
 * the by-name address is written as, so the value the renderer puts in the slot
 * finds the asset fetched for it.
 */
export function localizedTemplateName(template: UrlTemplate): string {
  // The host in a variable: the by-name route takes the scheme off what the renderer writes there.
  if (template.prefix === '') return `${template.slot}${template.suffix.replace(/[?#].*$/, '')}`;
  const prefix = localizedName(`${template.prefix}x`).slice(0, -1);
  const suffix = template.suffix.replace(/[?#].*$/, '');
  return `${prefix}${template.slot}${suffix}`;
}

/* ---------------------------------------------------------- stylesheets */

/**
 * RisuAI's asset addresses, `{{raw::name}}` and `{{path::name}}` — what a
 * RisuAI card writes a picture or a font of its own into a stylesheet with
 * (`url({{raw::bg.png}})`), and what a charx export here writes for a plot
 * asset (`toRisuAssetRefs`). The one CBS a stylesheet can hold without being a
 * template: what it reads is the work's own assets rather than anything a chat
 * changes, so the import writes each as the asset's address once the assets
 * are stored (`rewriteAssetAddresses`) — a stylesheet is drawn as written.
 */
export const ASSET_ADDRESS_MACRO = /\{\{\s*(?:raw|path)::([^{}]*?)\s*\}\}/gi;

/** A text with each asset address `resolve` knows written as what it answers; one it does not know is left as it is. */
export const rewriteAssetAddresses = (text: string, resolve: (name: string) => string | undefined): string =>
  text.replace(ASSET_ADDRESS_MACRO, (macro, name: string) => resolve(name) ?? macro);

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const FONT_FACE = /@font-face\s*\{[^{}]*\}/gi;

/**
 * Whether a fetched stylesheet is a web font's — nothing but `@font-face`
 * rules, as Google Fonts and the like answer — which a work can declare once
 * rather than where each template asked for it.
 */
export function isFontStylesheet(css: string): boolean {
  const body = css.replace(CSS_COMMENT, '');
  return (body.match(FONT_FACE)?.length ?? 0) > 0 && body.replace(FONT_FACE, '').trim().length === 0;
}

/**
 * A fetched stylesheet as it may stand inside a creator's text: refused when
 * it holds a `<` (it would end the `<style>` it is inlined into) or a `{{`
 * (CBS the template would then evaluate — another host's text is not the
 * creator's). `@charset` goes; the rest is the sanitizer's at render.
 */
export function inlinableCss(css: string): string | null {
  if (css.includes('<') || css.includes('{{')) return null;
  return css.replace(/@charset\s+[^;]*;/gi, '').trim();
}

/**
 * A fetched sheet's `@font-face` sources without their `local(…)` items. A
 * font service offers the reader's installed copy first (cdnfonts:
 * `src: local('Muttiara'), url(…)`); the sanitizer keeps an `@font-face` only
 * when every source is a file of ours, so with the item the whole face would
 * go. Without it the work's copy is the one that loads — the same font.
 */
export const withoutLocalSources = (css: string): string =>
  css.replace(/\blocal\([^()]*\)\s*,\s*/gi, '').replace(/\s*,\s*local\([^()]*\)/gi, '');

/** An inlined stylesheet under the media list its `@import` named, as the browser would apply it. */
export const underMedia = (css: string, media: string): string =>
  media && media.toLowerCase() !== 'all' ? `@media ${media} {\n${css}\n}` : css;

/* ------------------------------------------------------------- variables */

/** RisuAI's literal writes of a variable in a text: `{{setvar::k::v}}`, `{{setdefaultvar::k::v}}`. */
const LITERAL_SETVAR = /\{\{\s*(?:setvar|setdefaultvar)::([^{}:]+?)::([^{}]*?)\s*\}\}/gi;

/**
 * What a card sets each chat variable to that the import can read without
 * playing it: its default variables (`defaults`), every literal `{{setvar}}` or
 * `{{setdefaultvar}}` in `texts`, and every trigger effect that sets one to a
 * written value (RisuAI's `setvar` with `=`, `v2SetVar` with a value) — the
 * values a `{{getvar::…}}` slot of an address is fetched with
 * (`templateCandidates`). Best effort: a value a script computes is not known.
 */
export function cardVariableValues(
  defaults: Readonly<Record<string, string>>,
  texts: readonly string[],
  triggers: readonly unknown[] = [],
): Map<string, string[]> {
  const values = new Map<string, string[]>();
  const add = (name: string, value: string): void => {
    const key = name.trim();
    const text = value.trim();
    if (!key || !text) return;
    const list = values.get(key) ?? [];
    if (!list.includes(text)) list.push(text);
    values.set(key, list);
  };
  for (const [name, value] of Object.entries(defaults)) add(name, value);
  for (const text of texts) {
    LITERAL_SETVAR.lastIndex = 0;
    for (let found = LITERAL_SETVAR.exec(text); found; found = LITERAL_SETVAR.exec(text)) add(found[1]!, found[2]!);
  }
  for (const trigger of triggers) {
    const effects = (trigger as { effect?: unknown })?.effect;
    if (!Array.isArray(effects)) continue;
    for (const effect of effects) {
      const step = (effect ?? {}) as Record<string, unknown>;
      if (step['type'] === 'setvar' && (step['operator'] ?? '=') === '=' && typeof step['var'] === 'string' && typeof step['value'] === 'string') {
        add(step['var'], step['value']);
      }
      if (step['type'] === 'v2SetVar' && step['valueType'] === 'value' && step['varType'] !== 'var' && typeof step['var'] === 'string' && typeof step['value'] === 'string' && (step['operator'] ?? '=') === '=') {
        add(step['var'], step['value']);
      }
    }
  }
  return values;
}
