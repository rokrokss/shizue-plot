/**
 * Reading a work in another language (ARCHITECTURE §6 언어 모드, §7.8).
 *
 * A chat is in one of three modes:
 *
 * - `off` — 원문 그대로: nothing changes. The default where the work's content
 *   language is the reader's.
 * - `instruct` — 답장 언어 지시: the model is told to reply in the reader's
 *   language (`replyLanguageInstruction`, a trailing system line), so the replies
 *   need no translating; only the openings, fixed text in the card's language,
 *   are translated for display. The default where the two languages differ.
 * - `translate` — 번역 (RisuAI 방식): the model writes in the card's language as it
 *   always did, and what the reader sees is translated on the chat's auxiliary
 *   model, as RisuAI's LLM translator does — and, if the reader asks, what they
 *   write is translated into the card's language before it is sent.
 *
 * Everything here is pure: the cut of a message into the texts to translate, the
 * batches RisuAI sends them in, the prompt, and the mode a chat is in.
 */
import type { MacroLocale } from './macro.js';
import type { DisplayScript } from './types.js';
import { hasTriggersFor } from './triggers/interpreter.js';
import { luaScriptsOf, type EditScript, type TranslationScript, type TriggerScript } from './triggers/scripts.js';

export type TranslationMode = 'off' | 'instruct' | 'translate';
export const TRANSLATION_MODES: readonly TranslationMode[] = ['off', 'instruct', 'translate'];

/** The languages a reader reads in: the UI's, which are the content languages too. */
export type TranslationLanguage = MacroLocale;
export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = ['ko', 'en', 'ja'];

export const isTranslationLanguage = (value: unknown): value is TranslationLanguage =>
  typeof value === 'string' && (TRANSLATION_LANGUAGES as readonly string[]).includes(value);

/**
 * `chats.translation`: what the reader chose, where they chose. A key left out is
 * decided for them — the mode by the work's language against theirs, the language
 * by the UI they read in.
 */
export interface ChatTranslationSettings {
  mode?: TranslationMode;
  /** The language the reader reads in; absent, the UI's. */
  language?: TranslationLanguage;
  /** RisuAI's input translation: what the reader writes goes out in the card's language. `translate` only. */
  input?: boolean;
}

/**
 * The stored form: unknown keys and values are dropped rather than refused, as
 * every chat setting's are, and nothing chosen at all is null.
 */
export function coerceTranslationSettings(value: unknown): ChatTranslationSettings | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: ChatTranslationSettings = {};
  if (typeof raw['mode'] === 'string' && (TRANSLATION_MODES as readonly string[]).includes(raw['mode'])) {
    out.mode = raw['mode'] as TranslationMode;
  }
  if (isTranslationLanguage(raw['language'])) out.language = raw['language'];
  if (raw['input'] === true) out.input = true;
  return Object.keys(out).length > 0 ? out : null;
}

/** The mode a chat is in until the reader picks one: whether the work is in their language. */
export const defaultTranslationMode = (
  plotLanguage: TranslationLanguage,
  readerLanguage: TranslationLanguage,
): TranslationMode => (plotLanguage === readerLanguage ? 'off' : 'instruct');

export interface ResolvedTranslation {
  /** What is in force. Always `off` where the reader reads the work's own language. */
  mode: TranslationMode;
  /** The language the reader reads in; null where neither the chat nor the request says. */
  language: TranslationLanguage | null;
  /** Whether the reader's turns are translated before they are sent. */
  input: boolean;
  /** Whether the mode was decided for the reader rather than picked. */
  auto: boolean;
}

/**
 * The mode a chat is in for a reader. The reader's language is the chat's where
 * they set one, else the UI's (`readerLocale`, which the server is told per
 * request). A chat whose reader reads the work's own language has nothing to do
 * whatever was picked — translating Korean into Korean is a call for nothing —
 * and a request that does not say the reader's language changes nothing either.
 */
export function resolveTranslation(
  settings: ChatTranslationSettings | null | undefined,
  plotLanguage: TranslationLanguage,
  readerLocale?: TranslationLanguage | null,
): ResolvedTranslation {
  const language = settings?.language ?? readerLocale ?? null;
  const auto = settings?.mode === undefined;
  if (language === null || language === plotLanguage) return { mode: 'off', language, input: false, auto };
  const mode = settings?.mode ?? defaultTranslationMode(plotLanguage, language);
  return { mode, language, input: mode === 'translate' && settings?.input === true, auto };
}

/**
 * Which messages are translated for display. In `translate` mode, every one —
 * RisuAI's `autoTranslate` reads every message the chat draws, the reader's own
 * included. In `instruct` mode the replies are already in the reader's language,
 * so only what the card wrote in its own language is: the openings, and the
 * messages its scripts wrote (`source` `script`) — fixed text no model was asked
 * to write in the reader's language.
 */
export function translatesMessage(mode: TranslationMode, message: { intro: boolean; scripted?: boolean }): boolean {
  if (mode === 'translate') return true;
  if (mode === 'instruct') return message.intro || message.scripted === true;
  return false;
}

/** How the trailing line names each language: English, which every model reads, and the language's own name. */
const LANGUAGE_NAMES: Record<TranslationLanguage, string> = {
  ko: 'Korean (한국어)',
  en: 'English',
  ja: 'Japanese (日本語)',
};

/**
 * `instruct` mode's line, sent as a system turn at the very end of the request
 * (after post-history and the card's own instructions, which cannot replace it).
 * A speaker's `이름:` prefix is how a reply is attributed (§6 발화 프로토콜), so
 * the names stay as written while the prose changes language.
 */
export function replyLanguageInstruction(language: TranslationLanguage): string {
  return (
    `[Reply language] Write your reply in ${LANGUAGE_NAMES[language]}, whatever language the character ` +
    'descriptions, the opening and the earlier messages are written in. Keep every name prefix of a ' +
    'speaking line (`Name:`) exactly as it is written.'
  );
}

/**
 * RisuAI's `defaultTranslatorPrompt` (translator/presets.ts), word for word.
 * `{{slot}}` is the target language's code, as RisuAI's `db.translator` holds it.
 */
export const DEFAULT_TRANSLATOR_PROMPT =
  'You are a translator. translate the following html or text into {{slot}}. do not output anything other than the translation.';

/**
 * RisuAI's separator for the texts one request carries
 * (`translateTranslationChunks`: `chunks.join('\n■\n')`, split back on `■`).
 */
export const TRANSLATION_SEPARATOR = '■';

/**
 * Said only when one request carries several texts: RisuAI's prompt was written
 * for one, and a model asked to translate a page of `■` lines may well tidy them
 * away — which is what the count check below catches, at the price of a retry.
 */
const SEPARATOR_NOTE = `Lines holding only ${TRANSLATION_SEPARATOR} separate the parts: keep each of them where it is.`;

/** RisuAI's super-chunk limit: texts are gathered into one request while it stays under this many characters. */
export const TRANSLATION_BATCH_CHARS = 5000;

/** The system prompt and the user turn of one translation request. */
export function translationTurns(texts: readonly string[], language: TranslationLanguage): { system: string; user: string } {
  const prompt = DEFAULT_TRANSLATOR_PROMPT.replaceAll('{{slot}}', language);
  return {
    system: texts.length > 1 ? `${prompt}\n${SEPARATOR_NOTE}` : prompt,
    user: texts.join(`\n${TRANSLATION_SEPARATOR}\n`),
  };
}

/**
 * The model's answer to `translationTurns`, cut back into one text per text sent;
 * null where the count does not match — RisuAI then translates them one by one.
 */
export function splitTranslation(answer: string, count: number): string[] | null {
  const parts = answer.split(TRANSLATION_SEPARATOR).map((part) => part.trim());
  if (count === 1) return [answer.trim()];
  return parts.length === count ? parts : null;
}

/**
 * The texts in the requests RisuAI would send them in: gathered in order while
 * the joined request stays under `limit` characters. A text longer than that is a
 * request of its own, and one that holds the separator itself always is.
 */
export function translationBatches(texts: readonly string[], limit = TRANSLATION_BATCH_CHARS): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let length = 0;
  let alone = false;
  for (const text of texts) {
    const own = text.includes(TRANSLATION_SEPARATOR);
    if (current.length > 0 && (own || alone || length + 3 + text.length >= limit)) {
      batches.push(current);
      current = [];
      length = 0;
    }
    length += (current.length > 0 ? 3 : 0) + text.length;
    current.push(text);
    alone = own;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** A stretch of a message, and whether it is text a translator may change. */
export interface TextPart {
  text: string;
  translate: boolean;
}

/** Only a stretch with a letter in it says anything to translate; `30 / 100` and `♥` do not. */
const HAS_LETTER = /\p{L}/u;

/** Text parts keep their surrounding whitespace out of the translation, as RisuAI trims each chunk it sends. */
function pushText(parts: TextPart[], text: string): void {
  if (!text) return;
  // Macros the renderer did not resolve stay exactly as written.
  for (const piece of text.split(/(\{\{[^{}]*\}\})/)) {
    if (!piece) continue;
    if (piece.startsWith('{{') || !HAS_LETTER.test(piece)) {
      parts.push({ text: piece, translate: false });
      continue;
    }
    const lead = /^\s*/.exec(piece)![0];
    const trail = /\s*$/.exec(piece)![0];
    if (lead) parts.push({ text: lead, translate: false });
    parts.push({ text: piece.slice(lead.length, piece.length - trail.length), translate: true });
    if (trail) parts.push({ text: trail, translate: false });
  }
}

/** Joins neighbouring parts of one kind, so the text a part holds is never cut where nothing changes. */
function merged(parts: TextPart[]): TextPart[] {
  const out: TextPart[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (last && last.translate === part.translate && !part.translate) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

/** Elements that never close: their tag opens nothing a `translate="no"` could cover. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

/** The end of the tag that starts at `start` (`<`), reading quoted attribute values whole. */
function tagEnd(markup: string, start: number): number {
  let quote: string | null = null;
  for (let at = start + 1; at < markup.length; at += 1) {
    const char = markup[at]!;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return at;
  }
  return -1;
}

const TRANSLATE_NO = /\stranslate\s*=\s*(["']?)no\1(?=[\s/>]|$)/i;

/**
 * A piece of HTML cut into its text and its markup, by RisuAI's DOM rules
 * (`translateHTML`'s `translateNode`): the text of the elements is translated;
 * tags and their attributes, comments, `<script>` and `<style>` are never read,
 * and neither is anything inside an element marked `translate="no"`.
 *
 * It reads the string rather than a parsed tree so the markup comes back exactly
 * as it was written — a parser would close, move and re-quote what a card wrote,
 * and the card's layout is the creator's.
 */
export function markupParts(markup: string): TextPart[] {
  const parts: TextPart[] = [];
  /** Open elements, and whether each one keeps its content from the translator. */
  const open: { name: string; no: boolean }[] = [];
  const shielded = () => open.some((element) => element.no);
  let text = '';
  const flush = () => {
    if (!text) return;
    if (shielded()) parts.push({ text, translate: false });
    else pushText(parts, text);
    text = '';
  };
  let at = 0;
  while (at < markup.length) {
    const char = markup[at]!;
    if (char !== '<') {
      text += char;
      at += 1;
      continue;
    }
    if (markup.startsWith('<!--', at)) {
      flush();
      const end = markup.indexOf('-->', at + 4);
      const stop = end === -1 ? markup.length : end + 3;
      parts.push({ text: markup.slice(at, stop), translate: false });
      at = stop;
      continue;
    }
    const name = /^<\/?([A-Za-z][\w:-]*)/.exec(markup.slice(at, at + 64));
    const end = name || markup[at + 1] === '!' || markup[at + 1] === '?' ? tagEnd(markup, at) : -1;
    if (end === -1) {
      // A lone `<` is text, as a browser reads it.
      text += char;
      at += 1;
      continue;
    }
    flush();
    const tag = markup.slice(at, end + 1);
    const tagName = name?.[1]?.toLowerCase();
    if (tagName && !tag.startsWith('</') && (tagName === 'script' || tagName === 'style')) {
      // Raw text: everything up to the closing tag is code, never prose.
      const close = markup.toLowerCase().indexOf(`</${tagName}`, end + 1);
      const closeEnd = close === -1 ? -1 : tagEnd(markup, close);
      const stop = closeEnd === -1 ? markup.length : closeEnd + 1;
      parts.push({ text: markup.slice(at, stop), translate: false });
      at = stop;
      continue;
    }
    parts.push({ text: tag, translate: false });
    if (tagName) {
      if (tag.startsWith('</')) {
        const index = open.map((element) => element.name).lastIndexOf(tagName);
        if (index !== -1) open.length = index;
      } else if (!VOID_TAGS.has(tagName) && !tag.endsWith('/>')) {
        open.push({ name: tagName, no: TRANSLATE_NO.test(tag) });
      }
    }
    at = end + 1;
  }
  flush();
  return merged(parts);
}

/** A fenced block: code, never prose. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/**
 * What a line of prose keeps as written: a picture or a link (its address
 * especially), an address, an inline code span, a macro the renderer left.
 */
const PROTECTED_RE = /(!?\[[^\]\n]*\]\([^)\n]*\)|<https?:[^>\s]+>|https?:\/\/[^\s)]+|`[^`\n]+`|\{\{[^{}]*\}\})/;
/**
 * RisuAI's `runTranslator` passes these lines through untranslated, and breaks
 * the text it sends at them: an asset on its own line, and an empty line. The
 * same holds for a line that is only a picture once the asset is resolved.
 */
const MEDIA_LINE_RE = /^\s*(?:\{\{(?:img|raw|video)|\{\{audio[^\n]*\}\}\s*$|(?:!\[[^\]\n]*\]\([^)\n]*\)\s*)+$)/;

/** A stretch of prose cut around what it keeps as written (`PROTECTED_RE` captures, so those are the odd pieces). */
function lineParts(parts: TextPart[], text: string): void {
  text.split(PROTECTED_RE).forEach((piece, index) => {
    if (!piece) return;
    if (index % 2 === 1) parts.push({ text: piece, translate: false });
    else pushText(parts, piece);
  });
}

/**
 * Text cut by line: a line `keep` says is kept as written (and breaks the text
 * around it), a line with a `prefixOf` keeps that prefix, and every other run of
 * lines is one text to translate.
 */
function lineRuns(
  text: string,
  keep: (line: string) => boolean,
  prefixOf: (line: string) => string | undefined = () => undefined,
): TextPart[] {
  const parts: TextPart[] = [];
  const lines = text.split('\n');
  let run: string[] = [];
  lines.forEach((line, index) => {
    const prefix = prefixOf(line);
    if (prefix === undefined && !keep(line)) {
      run.push(line);
      const next = lines[index + 1];
      // The newline between two lines of one run is the run's own.
      if (next !== undefined && prefixOf(next) === undefined && !keep(next)) return;
      lineParts(parts, run.join('\n'));
      run = [];
    } else if (prefix !== undefined) {
      parts.push({ text: prefix, translate: false });
      lineParts(parts, line.slice(prefix.length));
    } else parts.push({ text: line, translate: false });
    if (index < lines.length - 1) parts.push({ text: '\n', translate: false });
  });
  return merged(parts);
}

const keptLine = (line: string): boolean => line.trim() === '' || MEDIA_LINE_RE.test(line);

/**
 * A block of a message's prose — markdown not yet drawn, which is where RisuAI
 * translates (`ParseMarkdown(…, 'pretranslate')` and only then the markdown) —
 * cut into what is translated and what is kept: a fenced block whole, a picture
 * or empty line as `runTranslator` keeps it, and within a line the addresses,
 * code spans and macros. The rest of the block, its lines together, is one text,
 * so the translator reads a paragraph as a paragraph.
 */
export function proseParts(block: string): TextPart[] {
  if (FENCE_RE.test(block)) return [{ text: block, translate: false }];
  return lineRuns(block, keptLine);
}

/** A reader's line written as someone else (`@이름:`, `@:`): the prefix is the protocol, not the words. */
const READER_PREFIX_RE = /^@[^\n:：]{0,40}[:：][ \t]*/;

/**
 * What the reader wrote, cut as RisuAI's input translation (`translate(…, true)`
 * → `runTranslator`) cuts it — by line, empty lines and asset lines kept and
 * breaking the text — with a writing-as prefix (`@리안:`) kept as written, since
 * it names a member by the roster's own name.
 */
export function inputParts(text: string): TextPart[] {
  return lineRuns(text, keptLine, (line) => READER_PREFIX_RE.exec(line)?.[0]);
}

/** The texts `parts` asks to have translated, in order and once each. */
export const partTexts = (parts: readonly TextPart[]): string[] => [
  ...new Set(parts.filter((part) => part.translate).map((part) => part.text)),
];

/** `parts` put back together with what arrived; a text with no translation yet stays as it was. */
export const applyParts = (parts: readonly TextPart[], translated: ReadonlyMap<string, string>): string =>
  parts.map((part) => (part.translate ? (translated.get(part.text) ?? part.text) : part.text)).join('');

/** One `edittrans` script as RisuAI reads its flag field. */
interface ParsedTranslationScript {
  script: TranslationScript;
  flag: string;
  order: number;
  actions: string[];
}

/**
 * RisuAI's `applyEdittransRegex`: a translation through the card's `edittrans`
 * scripts, run on what the translator returned and before it is shown — never
 * on the original, and never on what the reader sends. Read the way RisuAI
 * reads them, which is not quite how it reads the other regex scripts: the flag
 * field's `<…>` directives are `<order N>` (the list sorted highest first once
 * any script carries one), `move_top`/`move_bottom` (every match taken out and
 * put on a line of its own at the top or the bottom) and `cbs` (the pattern read
 * as CBS first — the caller's `cbs`; without one it stays as written); the
 * replacement is a plain `String.replace` one (`$1`, `$&`), never read as CBS,
 * with `$n` a line break; and a script that throws is skipped.
 */
export function applyTranslationScripts(
  text: string,
  scripts: readonly TranslationScript[],
  options: { cbs?: (pattern: string) => string } = {},
): string {
  const parsed: ParsedTranslationScript[] = [];
  let ordered = false;
  for (const script of scripts) {
    if (!script.in) continue;
    let flag = script.ableFlag ? script.flag || 'g' : 'g';
    let order = 0;
    const actions: string[] = [];
    flag = flag.replace(/<(.+?)>/g, (_whole, inner: string) => {
      for (const meta of inner.split(',').map((part) => part.trim())) {
        if (meta.startsWith('order ')) {
          order = parseInt(meta.substring(6));
          ordered = true;
        } else actions.push(meta);
      }
      return '';
    });
    if (actions.includes('move_top') || actions.includes('move_bottom')) flag = flag.replace('g', '');
    flag = flag
      .trim()
      .replace(/[^dgimsuvy]/g, '')
      .split('')
      .filter((char, index, all) => all.indexOf(char) === index)
      .join('');
    parsed.push({ script, flag: flag || 'u', order, actions });
  }
  // A stable sort, as RisuAI's: equal orders keep the list's sequence.
  if (ordered) parsed.sort((a, b) => b.order - a.order);

  let data = text;
  for (const { script, flag, actions } of parsed) {
    try {
      const regex = new RegExp(actions.includes('cbs') && options.cbs ? options.cbs(script.in) : script.in, flag);
      const out = script.out.replaceAll('$n', '\n');
      if (!actions.includes('move_top') && !actions.includes('move_bottom')) {
        data = data.replace(regex, out);
        continue;
      }
      const found = flag.includes('g') ? [...data.matchAll(regex)] : [data.match(regex)];
      data = data.replace(regex, '');
      for (const match of found) {
        if (!match) continue;
        // RisuAI's own reading of the replacement here — a group it has not is
        // `undefined`, and `$<name>` looks the name up by `parseInt`, which only
        // a group named `NaN` answers — kept as it reads.
        const moved = out
          .replace(/(?<!\$)\$[0-9]+/g, (token) => {
            const index = parseInt(token.substring(1));
            return index < match.length ? String(match[index]) : token;
          })
          .replace(/\$&/g, match[0])
          .replace(/(?<!\$)\$<([^>]+)>/g, (token) => match.groups?.[String(parseInt(token.substring(2, token.length - 1)))] || token);
        data = actions.includes('move_top') ? `${moved}\n${data}` : `${data}\n${moved}`;
      }
    } catch {
      // RisuAI logs the error and goes on to the next script.
    }
  }
  return data;
}

/** What the recommendation reads of a work: its display scripts, and each scripted member's scripts. */
export interface TranslationScriptInput {
  displayScripts?: readonly Pick<DisplayScript, 'in' | 'enabled'>[] | undefined;
  scripts?: readonly { triggers: readonly TriggerScript[]; editScripts: readonly Pick<EditScript, 'type' | 'in'>[] }[] | undefined;
}

/** A Lua listener on the reply's text or its display — or the Lua output trigger. */
const LUA_OUTPUT_RE = /listenEdit\s*\(\s*(["'])(?:editOutput|editDisplay)\1|\bonOutput\b/;

/**
 * Whether the work's scripts read what the model writes: a display script, an
 * `editoutput` regex, an output or display trigger, a Lua `editOutput`/
 * `editDisplay` listener or `onOutput`. Such a card was written against replies
 * in its own language — a status window found by its Korean labels, a variable
 * read off an English line — so a model told to reply in another language
 * (`instruct`) breaks it, and `translate`, where the model keeps the card's
 * language, is the mode to recommend.
 */
export function recommendsTranslateMode(input: TranslationScriptInput): boolean {
  if (input.displayScripts?.some((script) => script.enabled !== false && script.in !== '')) return true;
  return (input.scripts ?? []).some(
    (scripts) =>
      scripts.editScripts.some((script) => script.type === 'editoutput' && script.in !== '') ||
      hasTriggersFor(scripts.triggers, 'output') ||
      hasTriggersFor(scripts.triggers, 'display') ||
      luaScriptsOf(scripts.triggers).some((code) => LUA_OUTPUT_RE.test(code)),
  );
}
