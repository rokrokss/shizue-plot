/**
 * HTML written into a message, drawn the way RisuAI draws it.
 *
 * RisuAI renders every message as markdown with raw HTML enabled and then puts
 * the result through DOMPurify, so a greeting's status panel, a `<br>`, a
 * `<details>` fold or a `<span style="color:…">` in a reply comes out as what it
 * says rather than as tag text. Here the same text has a second reader — the
 * React path that draws speakers, dialogue, the word reveal and the plot's own
 * pictures — and that path cannot take raw markup without giving up the trust
 * boundary. So the choice is made per top-level block:
 *
 *   - A block with no HTML in it stays on the React path, untouched.
 *   - A block with HTML in it is rendered as markdown with HTML enabled, the way
 *     RisuAI renders it, and then held to exactly what a display script's output
 *     is held to: `sanitizeCustomHtml`, inside the message's scope.
 *
 * An element can outlive its block: `<div>` on one line, two paragraphs, `</div>`
 * — markdown ends the HTML at the blank line and goes back to prose, and the
 * browser then puts the prose inside the div. So a block that leaves an element
 * open takes the blocks after it along until the element closes, and the whole
 * stretch is drawn as one piece, as RisuAI's single render of the message does.
 */
import { replaceAssetMacros } from '@shizue/core/cbs';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { isVideoSrc, lookupAsset, readLockKind, type AssetResolver } from '../assets';
import { mediaMarkup } from '../cbs';
import { keepsElement, sanitizeCustomHtml } from '../sanitizeHtml';
import { splitBlocks } from './blocks';
import type { HastNode } from './hast';

/* ------------------------------------------------------------ indented code */

/**
 * Turns off markdown's indented code block, as RisuAI does (`md.disable('code')`).
 *
 * Roleplay text indents paragraphs and lines of verse with spaces, and a reader
 * who wrote four of them meant an indent, not a grey box with a copy button.
 * Fenced code is unaffected; so are lists, whose continuation lines are indented
 * for a different reason.
 */
export function remarkNoIndentedCode(this: { data(): Record<string, unknown> }): undefined {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push({ disable: { null: ['codeIndented'] } });
  return undefined;
}

/* ----------------------------------------------------------------- chunking */

/** A stretch of a message, drawn by one path or the other. */
export interface MarkupChunk {
  /** True when the stretch holds HTML and is drawn as sanitized markup. */
  html: boolean;
  /** Whole top-level blocks, so `chunks.map((c) => c.text).join('')` is the input. */
  text: string;
}

/** Elements with no content: a tag that opens one leaves nothing open. */
const VOID_TAGS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

/**
 * Elements whose end the browser infers at the next sibling. A `<p>` or `<li>`
 * written without its closer wraps nothing past its own block, and counting it
 * as open would pull the rest of the message off the prose path for no reason.
 */
const IMPLIED_END_TAGS: ReadonlySet<string> = new Set([
  'p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'option', 'optgroup', 'rt', 'rp',
]);

/** Raw-text elements: after the opening tag nothing is markup until the closing one. */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set([
  'style', 'script', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript',
]);

/**
 * A comment opener, or a whole tag: a name that starts with a letter and is
 * followed by attributes, `/` or `>`. `<https://…>` and `<a@b.c>` are markdown's
 * autolinks and `<3` is a heart, and none of them is a tag; a tag without its
 * `>` yet is text until the `>` arrives, as it is to markdown.
 */
const TAG_RE = /<!--|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s[^<>]*)?\/?)>/g;

/** A fence line, the same shape `splitBlocks` keeps whole. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A backslash-escaped punctuation character, which markdown prints as itself. */
const ESCAPE_RE = /\\[!-/:-@[-`{-~]/g;
/** A run of backticks, which opens or closes a code span. */
const BACKTICKS_RE = /`+/g;

/**
 * The text with its code spans taken out. A run of backticks opens a span that
 * the next run of exactly the same length closes; a run nothing closes is
 * literal, and the search goes on from the run after it — CommonMark's rule.
 * Done by pairing runs rather than by a pattern, which would backtrack over
 * every unclosed run and turn a reply full of stray backticks quadratic.
 */
function withoutCodeSpans(text: string): string {
  const runs = [...text.matchAll(BACKTICKS_RE)].map((run) => ({
    start: run.index,
    end: run.index + run[0].length,
    length: run[0].length,
  }));
  if (runs.length < 2) return text;
  // For each run, the next one of the same length — one pass from the end.
  const next = new Array<number>(runs.length).fill(-1);
  const seen = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    next[i] = seen.get(runs[i]!.length) ?? -1;
    seen.set(runs[i]!.length, i);
  }
  let out = '';
  let cursor = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const close = next[i]!;
    if (close < 0) continue;
    out += text.slice(cursor, runs[i]!.start);
    cursor = runs[close]!.end;
    i = close;
  }
  return out + text.slice(cursor);
}

/**
 * What of a block markdown would read as markup at all: fenced code, code spans
 * and escaped characters are text whatever they spell, so `<div>` in a code
 * sample neither makes its block HTML nor opens anything.
 */
function markupOf(block: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of block.split('\n')) {
    const match = FENCE_RE.exec(line);
    if (fence !== null) {
      if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length && !match[2]!.trim()) {
        fence = null;
      }
      continue;
    }
    if (match) {
      fence = match[1]!;
      continue;
    }
    kept.push(line);
  }
  return withoutCodeSpans(kept.join('\n').replace(ESCAPE_RE, ''));
}

/** What is left open at the end of what has been read so far. */
interface OpenMarkup {
  /** Elements opened and not yet closed, outermost first. */
  stack: string[];
  /** The raw-text element being read, `--` inside a comment, or null. */
  raw: string | null;
}

/**
 * Reads one block's tags into `open`, and says whether it held any.
 *
 * Only an element that the sanitizer keeps is counted as open: one it unwraps
 * cannot wrap anything on screen, so `<Thoughts>` left unclosed does not take
 * the rest of the reply with it. A closing tag closes everything opened inside
 * the element it names, as the browser closes it; one that names nothing open
 * is ignored, as the browser ignores it.
 */
function readTags(block: string, open: OpenMarkup): boolean {
  // Most blocks of a reply have no `<` at all, and every block is read again on
  // every token of a stream.
  if (open.raw === null && !block.includes('<')) return false;
  const text = open.raw === null ? markupOf(block) : block;
  const lower = text.toLowerCase();
  let found = false;
  let at = 0;
  while (at < text.length) {
    if (open.raw !== null) {
      found = true;
      const closer =
        open.raw === '--' ? lower.indexOf('-->', at) : lower.indexOf(`</${open.raw}`, at);
      if (closer < 0) return true;
      const end = open.raw === '--' ? closer + 2 : lower.indexOf('>', closer);
      if (end < 0) return true;
      open.raw = null;
      at = end + 1;
      continue;
    }
    TAG_RE.lastIndex = at;
    const tag = TAG_RE.exec(text);
    if (!tag) break;
    found = true;
    at = TAG_RE.lastIndex;
    if (tag[0] === '<!--') {
      open.raw = '--';
      continue;
    }
    const name = tag[2]!.toLowerCase();
    if (tag[1]) {
      const index = open.stack.lastIndexOf(name);
      if (index >= 0) open.stack.length = index;
      continue;
    }
    if (tag[3]!.endsWith('/') || VOID_TAGS.has(name)) continue;
    if (RAW_TEXT_TAGS.has(name)) open.raw = name;
    else if (!IMPLIED_END_TAGS.has(name) && keepsElement(name)) open.stack.push(name);
  }
  return found;
}

/**
 * A message's text cut into prose and markup, by top-level block.
 *
 * Consecutive prose blocks are one chunk, so the speaker split still reads a
 * run of lines as one run. Markup blocks are a chunk each — so a settled one is
 * never sanitized again when the next arrives — except where an element is
 * still open, which joins the blocks after it until it closes. An element never
 * closed takes the rest of the text, as it does in the browser.
 */
export function markupChunks(md: string): MarkupChunk[] {
  const chunks: MarkupChunk[] = [];
  const open: OpenMarkup = { stack: [], raw: null };
  for (const block of splitBlocks(md)) {
    const continued = open.stack.length > 0 || open.raw !== null;
    const html = readTags(block, open) || continued;
    const last = chunks.at(-1);
    if (last && last.html === html && (continued || !html)) last.text += block;
    else chunks.push({ html, text: block });
  }
  return chunks;
}

/* ------------------------------------------------------------------- images */

/** A macro standing inside a tag's attributes, where only an address makes sense. */
const IN_TAG_RE = /<[A-Za-z/][^<>]*$/;

/**
 * Whether the macro at `start` is an address rather than a picture: inside a
 * tag (`<img src="{{img::face}}">`) or a stylesheet (`url({{img::face}})`), as
 * the display templates read it. Read off the text before it, which in a
 * message is all one writer's.
 */
function isAddressPosition(content: string, start: number): boolean {
  const before = content.slice(0, start);
  if (IN_TAG_RE.test(before)) return true;
  const lower = before.toLowerCase();
  return lower.lastIndexOf('<style') > lower.lastIndexOf('</style');
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * `renderImageTokens` for a markup chunk: the reference becomes an `<img>`,
 * because markdown's `![…](…)` is not read inside an HTML block — or the bare
 * address, where it stands in a tag or a stylesheet. RisuAI writes its asset
 * macros out the same way, music and video included (`mediaMarkup`).
 *
 * A picture this chat has not opened yet is left out entirely. Its stand-in is
 * a component, and markup cannot hold one; the marker it resolves to is an
 * address on our origin, and handed to an `<img>` it would ask the page for
 * itself.
 *
 * RisuAI's `{{source::user}}` is the reader's persona picture (`userImage`), an
 * address like `{{raw::…}}`'s and drawn where one is; `{{source::char}}` stays
 * dropped (`CbsContext.userImage`).
 */
export function renderImageTokensAsHtml(
  content: string,
  assets: ReadonlyMap<string, string>,
  resolve?: AssetResolver,
  userImage?: string | null,
): string {
  return replaceAssetMacros(content, (macro) => {
    if (macro.name === 'source') {
      const own = macro.ref?.toLowerCase() === 'user' ? userImage : null;
      return own && isAddressPosition(content, macro.start) ? own : '';
    }
    if (macro.kind === 'drop' || macro.ref === null) return '';
    const found = lookupAsset(macro.ref, assets, resolve, macro.name);
    if (!found || readLockKind(found.src)) return '';
    if (isAddressPosition(content, macro.start)) return found.src;
    if (macro.kind === 'audio' || macro.kind === 'bgm' || macro.kind === 'video' || macro.kind === 'videoimg') {
      return mediaMarkup(macro.kind, found.src);
    }
    if (macro.kind !== 'image') return '';
    // RisuAI's `{{asset::…}}` plays a video asset as a moving picture.
    if (macro.name === 'asset' && isVideoSrc(found.src)) return mediaMarkup('videoimg', found.src);
    return `<img src="${escapeAttribute(found.src)}" alt="${escapeAttribute(found.slug)}">`;
  });
}

/**
 * RisuAI's music and video in a message's own text, as its
 * `parseAdditionalAssets` writes them wherever they stand — `{{video::…}}`,
 * `{{video-img::…}}`, `{{audio::…}}`, `{{bgm::…}}`, and `{{asset::…}}` naming a
 * video — their players (`mediaMarkup`), run before the text is cut into prose
 * and markup (`markupChunks`) so the block holding one is drawn as the markup
 * it now is. Pictures are left to `renderImageTokens`, and a macro standing in a
 * tag or a stylesheet to `renderImageTokensAsHtml`, which writes its address
 * there. One the chat has no asset for, or has not opened yet, is nothing.
 */
export function renderMediaTokens(
  content: string,
  assets: ReadonlyMap<string, string>,
  resolve?: AssetResolver,
): string {
  return replaceAssetMacros(content, (macro) => {
    const kept = content.slice(macro.start, macro.end);
    const media = macro.kind === 'audio' || macro.kind === 'bgm' || macro.kind === 'video' || macro.kind === 'videoimg';
    if ((!media && macro.name !== 'asset') || macro.ref === null || isAddressPosition(content, macro.start)) return kept;
    const found = lookupAsset(macro.ref, assets, resolve, macro.name);
    if (!found || readLockKind(found.src)) return media ? '' : kept;
    if (media) return mediaMarkup(macro.kind as 'audio' | 'bgm' | 'video' | 'videoimg', found.src);
    return isVideoSrc(found.src) ? mediaMarkup('videoimg', found.src) : kept;
  });
}

/* ---------------------------------------------------------------- rendering */

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A hast property name as the attribute it stands for: `className` → `class`, `dataFootnoteRef` → `data-footnote-ref`. */
function attributeName(property: string): string {
  if (property === 'className') return 'class';
  if (property === 'htmlFor') return 'for';
  if (/^(?:data|aria)[A-Z]/.test(property)) return property.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
  return property.toLowerCase();
}

function attributes(properties: Record<string, unknown> | undefined): string {
  let out = '';
  for (const [property, value] of Object.entries(properties ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    const name = attributeName(property);
    if (value === true) {
      out += ` ${name}`;
      continue;
    }
    const text = Array.isArray(value) ? value.join(' ') : String(value);
    out += ` ${name}="${escapeAttribute(text)}"`;
  }
  return out;
}

/**
 * The tree as an HTML string, its raw nodes written out as they came.
 *
 * The little of hast-util-to-html that the markdown pipeline's output needs.
 * What it writes is not trusted by anyone: it goes straight to the sanitizer,
 * which parses it the way the browser would.
 */
export function toHtml(node: HastNode): string {
  const inner = (): string => (node.children ?? []).map(toHtml).join('');
  switch (node.type) {
    case 'root':
      return inner();
    case 'text':
      return escapeText(node.value ?? '');
    case 'raw':
      return node.value ?? '';
    case 'element': {
      const tag = node.tagName ?? 'span';
      const opening = `<${tag}${attributes(node.properties)}>`;
      return VOID_TAGS.has(tag) ? opening : `${opening}${inner()}</${tag}>`;
    }
    default:
      // Comments and doctypes: nothing the reader would see.
      return '';
  }
}

/** The plugins markup chunks are read with: the prose path's, so markdown means the same in both. */
export const markupRemarkPlugins = [remarkGfm, remarkBreaks, remarkNoIndentedCode];

/** A `<style>` element and its sheet, to where the browser ends it. */
const STYLE_ELEMENT_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
/** The stand-in a sheet waits behind while markdown reads around it, by its number. */
const SHEET_SLOT_RE = /(\d+)/g;
const SHEET_SLOT_CHARS_RE = /[]/g;

/**
 * `render` over markdown whose stylesheets it never reads, as RisuAI keeps them
 * out of its markdown (`encodeStyle`). A sheet is not markdown: a `*` or a `_` in
 * it is not emphasis, and a blank line in a sheet inside a `<div>` would end
 * markdown's HTML block there and read the rest of the sheet as paragraphs —
 * which the stylesheet parser then refuses, sheet and all. So each sheet's text
 * waits behind a one-line stand-in while markdown runs and is put back after,
 * its `<style>` tags left where they were so the blocks around them read as
 * before. The stand-in's characters are taken out of the input first, so no text
 * can name a sheet.
 */
function withSheetsKept(md: string, render: (text: string) => string): string {
  if (!/<style/i.test(md)) return render(md);
  const sheets: string[] = [];
  const held = md.replace(SHEET_SLOT_CHARS_RE, '').replace(STYLE_ELEMENT_RE, (_element, open: string, sheet: string, close: string) => {
    sheets.push(sheet);
    return `${open}${sheets.length - 1}${close}`;
  });
  return render(held).replace(SHEET_SLOT_RE, (_slot, index: string) => sheets[Number(index)] ?? '');
}

/**
 * Markdown with raw HTML enabled, written out by `write` as an unsanitized
 * string — markdown-it's `html: true`, which is what RisuAI renders with.
 *
 * react-markdown is the parser the rest of the message already uses, and it
 * carries raw HTML through its pipeline as `raw` nodes until the very end, where
 * it would print them as text. This takes the tree before that and writes it
 * out instead; the element react-markdown builds from the emptied tree is
 * thrown away. It holds no hooks, so calling it outside a render is calling a
 * function.
 */
function renderTree(md: string, write: (tree: HastNode) => string): string {
  let html = '';
  const capture = () => (tree: HastNode): undefined => {
    html = write(tree);
    tree.children = [];
    return undefined;
  };
  Markdown({ children: md, remarkPlugins: markupRemarkPlugins, rehypePlugins: [capture] });
  return html;
}

/** Markdown with raw HTML enabled, as an unsanitized string (`renderTree`). */
export const markdownToHtml = (md: string): string => withSheetsKept(md, (text) => renderTree(text, toHtml));

/**
 * A markup chunk as it may reach the DOM: rendered, then sanitized like any
 * display script's output. Empty where there is no DOM to sanitize with.
 */
export const renderMarkup = (md: string): string => sanitizeCustomHtml(markdownToHtml(md));

/** A mark (`lib/taint`) as markdown percent-encoded it into a link's or a picture's address. */
const ENCODED_MARK_RE = /%0([1-3])/g;

/**
 * Puts back the marks markdown encoded away. An address written as markdown —
 * `[보기](<{{getvar::url}}>)`, `[보기](<$1>)` — is percent-encoded on its way into
 * the tree, and `%01` is no longer the mark the sanitizer reads a model's link by
 * (`lib/sanitizeHtml`). A `%01` the model wrote itself comes back as a mark too,
 * which only ever makes its link text.
 */
function restoreMarks(node: HastNode): void {
  const properties = node.properties;
  if (properties) {
    for (const name of ['href', 'src']) {
      const value = properties[name];
      if (typeof value === 'string') {
        properties[name] = value.replace(ENCODED_MARK_RE, (_code, digit: string) => String.fromCharCode(Number(digit)));
      }
    }
  }
  for (const child of node.children ?? []) restoreMarks(child);
}

/**
 * A display script's island as RisuAI draws its output: RisuAI's `ParseMarkdown`
 * runs the scripts and then markdown over what they made, so prose a template
 * wraps — `<div class="body">\n\n$&\n\n</div>` — reads as paragraphs, emphasis
 * and the rest, as the message's own HTML does (`markdownToHtml`).
 *
 * Two things are the island's own. Its marks are kept on the addresses markdown
 * builds (`restoreMarks`), so a link a template makes of the model's words is
 * still the model's link. And an island that markdown makes one paragraph of —
 * `<span class="q">"…"</span>`, the words of a line in a colour — is the
 * paragraph's content: in RisuAI it is a run of the paragraph around it, and
 * here it stands in that paragraph's bubble (`MessageBody`), which a `<p>` of its
 * own would take it out of.
 */
export function islandToHtml(html: string): string {
  return withSheetsKept(html, (text) =>
    renderTree(text, (tree) => {
      restoreMarks(tree);
      const top = (tree.children ?? []).filter((node) => node.type !== 'text' || (node.value ?? '').trim() !== '');
      const only = top.length === 1 ? top[0]! : null;
      return only?.type === 'element' && only.tagName === 'p'
        ? toHtml({ type: 'root', children: only.children ?? [] })
        : toHtml(tree);
    }),
  );
}

/** An island as it may reach the DOM: rendered (`islandToHtml`), then sanitized. */
export const renderIsland = (html: string): string => sanitizeCustomHtml(islandToHtml(html));
