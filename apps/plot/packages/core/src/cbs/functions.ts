/**
 * RisuAI's CBS functions that need nothing but their arguments, for `cbs.ts`.
 *
 * Each one is a port of its callback in RisuAI's `registerCBS` (src/ts/cbs.ts,
 * 2026.8.250), kept as close to the original as the language allows so that a
 * difference is easy to see. Arguments arrive as RisuAI's matcher hands them
 * over: the text between separators, `undefined` past the last one. Anything
 * that throws — `{{trim}}` with nothing to trim, `{{fixnum::1::101}}` — is
 * caught by the evaluator and leaves the macro as written, which is what
 * RisuAI's matcher does with a throw; several functions rely on it, and so do
 * the caps below, which throw rather than build something no card meant.
 *
 * Where this differs from RisuAI it says so, and for one of three reasons: a
 * value is never syntax here (so RisuAI's `::` mangling in `makeArray` has
 * nothing to protect against), a name a card never meant reaches the prototype
 * chain upstream, or upstream builds something unbounded.
 *
 * Dependency-free like the rest of `cbs.ts`: no `Buffer`, no DOM.
 */

/** A function of its arguments' text. */
export type CbsFunction = (args: string[]) => string;

/** What one function may build: past this it is a memory bomb rather than text. */
export const MAX_CBS_VALUE = 1_000_000;

/** Array functions stop here: `{{range::[1e9]}}` and `{{arrayassert::[]::1e9::x}}` are not lists anyone writes. */
export const MAX_CBS_ARRAY = 5_000;

/** `{{cbr::N}}`, like `{{newline::N}}`. */
const MAX_REPEAT = 100;

class TooLarge extends RangeError {}

const bit = (holds: boolean): string => (holds ? '1' : '0');

/* ------------------------------------------------------------------ arrays */

/**
 * RisuAI's `parseArray`: a JSON array, or anything else — invalid JSON, a
 * number, an object — split on `§`, its older list encoding. So `abc` is one
 * item and `a§b` two. Nothing passed (`undefined`) throws, as upstream.
 */
export function parseRisuArray(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON: the older encoding.
  }
  return text.split('§');
}

/** RisuAI's `parseDict`: whatever JSON says, or `{}`. */
function parseDict(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/**
 * RisuAI's `makeArray`, which upstream also rewrites every `::` in an item to
 * the twelve characters `::` — so its text-level parser does not split
 * the array as arguments when it is pasted into the next macro. Here a value is
 * never split, and the rewrite would only show as backslashes, so it is left out.
 */
export const makeArray = (items: readonly unknown[]): string => JSON.stringify(items);

/**
 * An own property — what RisuAI's `dict[key]` means for a card. Upstream reads
 * the prototype chain too, so `constructor` answers a function's source.
 * `null`, like upstream, throws.
 */
function own(value: unknown, key: string): unknown {
  if (value === null || value === undefined) throw new TypeError('no properties');
  return Object.prototype.hasOwnProperty.call(Object(value), key) ? (value as Record<string, unknown>)[key] : undefined;
}

/** Sets an own property, `__proto__` included, without touching a prototype. */
function setOwn(target: unknown, key: string, value: unknown): void {
  // Upstream is a strict-mode module: setting a property on a primitive throws.
  if (target === null || typeof target !== 'object') throw new TypeError('not an object');
  if (Array.isArray(target) && /^\d+$/.test(key) && Number(key) >= MAX_CBS_ARRAY) throw new TooLarge('sparse array');
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** An item written out as RisuAI does: objects as JSON, everything else as text. */
const itemText = (item: unknown): string => (typeof item === 'object' ? JSON.stringify(item) : String(item));

/** Several arguments, or the first read as an array — RisuAI's rule for the list functions. */
const listOf = (args: string[]): unknown[] => (args.length > 1 ? args : parseRisuArray(args[0]!));

/** Every item as a number, what is not one counting as 0. */
const numbersOf = (args: string[]): number[] =>
  listOf(args).map((item) => {
    const value = Number(item);
    return Number.isNaN(value) ? 0 : value;
  });

/** `Array.prototype.join`, after checking what it would build. */
function join(items: unknown[], separator: string | undefined): string {
  const sep = separator === undefined ? ',' : separator;
  let size = Math.max(0, items.length - 1) * sep.length;
  for (const item of items) size += item === null || item === undefined ? 0 : String(item).length;
  if (size > MAX_CBS_VALUE) throw new TooLarge('join');
  return items.join(sep);
}

/** `range`'s argument is a JSON array: `[end]`, `[start, end]` or `[start, end, step]`. */
function range(text: string): string {
  const bounds = parseRisuArray(text);
  const start = bounds.length > 1 ? Number(bounds[0]) : 0;
  const end = bounds.length > 1 ? Number(bounds[1]) : Number(bounds[0]);
  const step = bounds.length > 2 ? Number(bounds[2]) : 1;
  const out: string[] = [];
  // A step of 0 or less loops forever upstream; here it runs into the cap.
  for (let i = start; i < end; i += step) {
    if (out.length >= MAX_CBS_ARRAY) throw new TooLarge('range');
    out.push(i.toString());
  }
  return makeArray(out);
}

/**
 * `filter`: `nonempty`, `unique`, or — the default, and for any other word —
 * both. "Unique" keeps an item's first appearance, as upstream's `indexOf`
 * does, in one pass rather than a quadratic one.
 */
function filter(args: string[]): string {
  const items = parseRisuArray(args[0]!);
  const kind = Math.max(0, ['all', 'nonempty', 'unique'].indexOf(args[1]!));
  const seen = new Set<unknown>();
  return makeArray(
    items.filter((item) => {
      const first = typeof item === 'object' && item !== null ? true : !seen.has(item);
      seen.add(item);
      if (kind === 1) return item !== '';
      if (kind === 2) return first;
      return item !== '' && first;
    }),
  );
}

/**
 * `element`: walks into JSON one key per argument. Each step reads the text the
 * last one left — so a nested object has to be stored as JSON inside JSON, as
 * upstream. A missing or falsy step is `null`. Upstream hands a leaf that is not
 * text back as it is, which prints `undefined` or breaks the parse; here a
 * number is its digits and an object its JSON.
 */
function element(args: string[]): string {
  if (args[0] === undefined) throw new TypeError('nothing to read');
  try {
    let current: unknown = args[0];
    for (const key of args.slice(1)) {
      const parsed: unknown = JSON.parse(current as string);
      if (parsed === null || typeof parsed !== 'object') return 'null';
      current = own(parsed, key);
      if (!current) return 'null';
    }
    return typeof current === 'string' ? current : itemText(current);
  } catch {
    return 'null';
  }
}

/** `makedict`: each `key=value` argument, split at the first `=`; others are skipped. */
function makeDict(args: string[]): string {
  const out: Record<string, string> = {};
  for (const current of args) {
    const equal = current.indexOf('=');
    if (equal === -1) continue;
    setOwn(out, current.substring(0, equal), current.substring(equal + 1));
  }
  return JSON.stringify(out);
}

/* ----------------------------------------------------------------- strings */

/**
 * `replace`: JavaScript's `replaceAll`, `$&` and the other replacement patterns
 * included, as upstream — after checking what it would build, since `$\``
 * repeats everything before each match and an empty search matches everywhere.
 */
function replace(text: string, search: string | undefined, replacement: string | undefined): string {
  // A missing one is the word `undefined`, as `replaceAll` reads it upstream.
  const needle = String(search);
  const swap = String(replacement);
  const matches = needle === '' ? text.length + 1 : text.split(needle).length - 1;
  const each = swap.length + (swap.split('$').length - 1) * Math.max(text.length, needle.length);
  if (text.length + matches * each > MAX_CBS_VALUE) throw new TooLarge('replace');
  return text.replaceAll(needle, swap);
}

/** `crypt`: every UTF-16 unit shifted, by 32768 unless told otherwise — which undoes itself. */
function crypt(text: string, by: string | undefined): string {
  let shift = by ? Number(by) : 32768;
  if (Number.isNaN(shift)) shift = 32768;
  let result = '';
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i) + shift;
    if (code > 65535) code -= 65536;
    result += String.fromCharCode(code);
  }
  return result;
}

/* ------------------------------------------------------------ bytes, base64 */

interface Codec {
  TextEncoder: new () => { encode(text?: string): Uint8Array };
  TextDecoder: new (label?: string, options?: { ignoreBOM?: boolean }) => { decode(bytes: Uint8Array): string };
}
/** Present in every runtime this runs in; typed here because the core build has no DOM or Node types. */
const codec = globalThis as unknown as Codec;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64[a >> 2]! + BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : BASE64[c & 63]!;
  }
  return out;
}

/**
 * Node's `Buffer.from(text, 'base64')`, which upstream uses: both alphabets,
 * anything else skipped, and the first `=` ends it.
 */
function base64Decode(text: string): Uint8Array {
  const bytes: number[] = [];
  let bits = 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '=') break;
    const value = char === '-' ? 62 : char === '_' ? 63 : BASE64.indexOf(char);
    if (value === -1) continue;
    bits = (bits << 6) | value;
    count += 1;
    if (count === 4) {
      bytes.push((bits >> 16) & 255, (bits >> 8) & 255, bits & 255);
      bits = 0;
      count = 0;
    }
  }
  if (count === 2) bytes.push((bits >> 4) & 255);
  if (count === 3) bytes.push((bits >> 10) & 255, (bits >> 2) & 255);
  return Uint8Array.from(bytes);
}

const flip = (bytes: Uint8Array): Uint8Array => bytes.map((byte) => byte ^ 0xff);

/** `{{file::name::base64}}` outside the screen: the data as UTF-8, a BOM kept as Node keeps it. */
export const decodeFile = (data: string): string =>
  new codec.TextDecoder('utf-8', { ignoreBOM: true }).decode(base64Decode(data));

/* ------------------------------------------------------------------- seeds */

/** RisuAI's `sfc32` (src/ts/util.ts), a small seeded generator. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * RisuAI's `pickHashRand` (src/ts/util.ts): [0, 1) from a word, advanced `cid`
 * times. Copied operation for operation — the hash mixes int32 shifts with
 * double additions, and keeps running across the four seeds — because a card's
 * `{{hash}}` and `{{pick}}` must come out exactly as they did in RisuAI.
 */
export function pickHashRand(cid: number, word: string): number {
  let hash = 5515;
  const rand = (text: string): number => {
    for (let i = 0; i < text.length; i += 1) hash = (hash << 5) + hash + text.charCodeAt(i);
    return hash;
  };
  const next = sfc32(rand(word), rand(word), rand(word), rand(word));
  const skip = cid % 1000;
  for (let i = 0; i < skip; i += 1) next();
  return next();
}

/* ---------------------------------------------------------------- escapes */

/**
 * RisuAI's display escapes: U+E9B8–U+E9BF stand in for these eight characters,
 * so that text holding them is never read as syntax again — an intro is
 * expanded and stored, and history is expanded every turn.
 */
const DISPLAY_ESCAPES = '{}()<>:;';
const ESCAPE_BASE = 0xe9b8;

/** RisuAI's `risuEscape`, which `#escape` applies: braces and parentheses only. */
export const risuEscape = (text: string): string =>
  text.replace(/[{}()]/g, (char) => String.fromCharCode(ESCAPE_BASE + DISPLAY_ESCAPES.indexOf(char)));

/**
 * The display escapes turned back into what they stand for, once, where text
 * is finally shown — RisuAI's `risuUnescape`. As HTML the angle brackets are
 * entities, as upstream, and `#puredisplay`'s `\{\{`/`\}\}` (which RisuAI's
 * markdown reads back) are braces again; as text they are the characters.
 */
export function unescapeCbs(text: string, target: 'html' | 'text'): string {
  const out = text.replace(/[-]/g, (char) => {
    const plain = DISPLAY_ESCAPES[char.charCodeAt(0) - ESCAPE_BASE]!;
    if (target === 'text') return plain;
    return plain === '<' ? '&lt;' : plain === '>' ? '&gt;' : plain;
  });
  return target === 'html' ? out.replaceAll('\\{\\{', '{{').replaceAll('\\}\\}', '}}') : out;
}

const escapeChar = (char: string): (() => string) => {
  const code = String.fromCharCode(ESCAPE_BASE + DISPLAY_ESCAPES.indexOf(char));
  return () => code;
};

/** `#code`'s body: trimmed, its line breaks and tabs dropped, then `\uXXXX` and backslash escapes read. */
export function normalizeCode(text: string): string {
  return text
    .trim()
    .replaceAll('\n', '')
    .replaceAll('\t', '')
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(.)/g, (_match, char: string) => {
      switch (char) {
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        case 'b':
          return '\b';
        case 'f':
          return '\f';
        case 'v':
          return '\v';
        // Upstream writes `\a`, which JavaScript reads as a plain `a`.
        case 'a':
          return 'a';
        case 'x':
          return '\x00';
        default:
          return char;
      }
    });
}

/* ------------------------------------------------------------------- table */

const FUNCTIONS: [names: string[], run: CbsFunction][] = [
  // Comparison and logic: `1` or `0`.
  [['equal'], (a) => bit(a[0] === a[1])],
  [['notequal'], (a) => bit(a[0] !== a[1])],
  [['greater'], (a) => bit(Number(a[0]) > Number(a[1]))],
  [['less'], (a) => bit(Number(a[0]) < Number(a[1]))],
  [['greaterequal'], (a) => bit(Number(a[0]) >= Number(a[1]))],
  [['lessequal'], (a) => bit(Number(a[0]) <= Number(a[1]))],
  [['and'], (a) => bit(a[0] === '1' && a[1] === '1')],
  [['or'], (a) => bit(a[0] === '1' || a[1] === '1')],
  [['not'], (a) => bit(a[0] !== '1')],
  [['all'], (a) => bit(listOf(a).every((item) => item === '1'))],
  [['any'], (a) => bit(listOf(a).some((item) => item === '1'))],
  [['iserror'], (a) => bit(a[0]!.toLowerCase().startsWith('error:'))],

  // Strings. `lower`/`upper` without the locale upstream uses: the fold runs on
  // the server and in the reader's browser, which have to agree.
  [['startswith'], (a) => bit(a[0]!.startsWith(a[1]!))],
  [['endswith'], (a) => bit(a[0]!.endsWith(a[1]!))],
  [['contains'], (a) => bit(a[0]!.includes(a[1]!))],
  [['replace'], (a) => replace(a[0]!, a[1], a[2])],
  [['split'], (a) => makeArray(a[0]!.split(a[1]!))],
  [['join'], (a) => join(parseRisuArray(a[0]!), a[1])],
  // Standing alone, the items joined by `::`; as a whole argument, spliced in as
  // several (`cbs.ts`), which is what upstream's re-reading made of the `::`.
  [['spread'], (a) => join(parseRisuArray(a[0]!), '::')],
  [['trim'], (a) => a[0]!.trim()],
  [['length'], (a) => a[0]!.length.toString()],
  [['lower'], (a) => a[0]!.toLowerCase()],
  [['upper'], (a) => a[0]!.toUpperCase()],
  [['capitalize'], (a) => a[0]!.charAt(0).toUpperCase() + a[0]!.slice(1)],
  [['reverse'], (a) => [...(a[0] ?? '')].reverse().join('')],
  // Keeps what `Number` reads as a number on its own — a space is 0, so spaces stay.
  [['tonumber'], (a) => [...a[0]!].filter((char) => !Number.isNaN(Number(char)) || char === '.').join('')],
  [['unicodeencode'], (a) => a[0]!.charCodeAt(a[1] ? Number(a[1]) : 0).toString()],
  [['unicodedecode'], (a) => String.fromCharCode(Number(a[0]))],
  // `ue` is upstream's too, and decodes as well: misnamed there, kept as it is.
  [['u', 'unicodedecodefromhex', 'ue', 'unicodeencodefromhex'], (a) => String.fromCharCode(parseInt(a[0]!, 16))],
  [['fromhex'], (a) => Number.parseInt(a[0]!, 16).toString()],
  [['tohex'], (a) => Number.parseInt(a[0]!).toString(16)],
  [['xor', 'xorencrypt', 'xorencode', 'xore'], (a) => base64Encode(flip(new codec.TextEncoder().encode(a[0])))],
  [['xordecrypt', 'xordecode', 'xord'], (a) => new codec.TextDecoder().decode(flip(base64Decode(a[0]!)))],
  [['crypt', 'crypto', 'caesar', 'encrypt', 'decrypt'], (a) => crypt(a[0]!, a[1])],
  [['hash'], (a) => (pickHashRand(0, a[0]!) * 10_000_000 + 1).toFixed(0).padStart(7, '0')],
  [['tex', 'latex', 'katex'], (a) => `$$${a[0]}$$`],
  // The two characters `\` `n`. Upstream repeats the whole macro's text for a
  // count, a bug; here the count repeats the `\n`.
  [
    ['cbr', 'cnl', 'cnewline'],
    (a) => {
      if (a.length === 0) return '\\n';
      const count = Number(a[0]) < 1 ? 1 : Number(a[0]);
      if (count > MAX_REPEAT) throw new TooLarge('cbr');
      return '\\n'.repeat(count);
    },
  ],
  // Nothing. `risu` is upstream's logo, which has no place here; `declare`
  // marks a variable nothing ever reads (and upstream prints itself).
  [['blank', 'none', 'hiddenkey', 'risu', '__', 'declare'], () => ''],

  // Numbers, written as JavaScript writes them: `NaN` and `Infinity` included.
  [['round'], (a) => Math.round(Number(a[0])).toString()],
  [['floor'], (a) => Math.floor(Number(a[0])).toString()],
  [['ceil'], (a) => Math.ceil(Number(a[0])).toString()],
  [['abs'], (a) => Math.abs(Number(a[0])).toString()],
  [['remaind'], (a) => (Number(a[0]) % Number(a[1])).toString()],
  [['pow'], (a) => (Number(a[0]) ** Number(a[1])).toString()],
  [['min'], (a) => numbersOf(a).reduce((low, value) => Math.min(low, value), Infinity).toString()],
  [['max'], (a) => numbersOf(a).reduce((high, value) => Math.max(high, value), -Infinity).toString()],
  [['sum'], (a) => numbersOf(a).reduce((total, value) => total + value, 0).toString()],
  [
    ['average'],
    (a) => {
      const values = numbersOf(a);
      return (values.reduce((total, value) => total + value, 0) / values.length).toString();
    },
  ],
  // `toFixed` past 100 digits throws, as upstream.
  [['fixnum', 'fixnumber'], (a) => Number(a[0]).toFixed(Number(a[1]))],

  // Arrays and dictionaries.
  [['arraylength'], (a) => parseRisuArray(a[0]!).length.toString()],
  [['arrayelement'], (a) => itemText(parseRisuArray(a[0]!).at(Number(a[1])) ?? 'null')],
  [['dictelement', 'objectelement'], (a) => itemText(own(parseDict(a[0]!), a[1]!) ?? 'null')],
  [
    ['objectassert', 'dictassert'],
    (a) => {
      const dict = parseDict(a[0]!);
      if (!own(dict, a[1]!)) setOwn(dict, a[1]!, a[2]);
      return JSON.stringify(dict);
    },
  ],
  [['element', 'ele'], element],
  [
    ['arrayshift'],
    (a) => {
      const items = parseRisuArray(a[0]!);
      items.shift();
      return makeArray(items);
    },
  ],
  [
    ['arraypop'],
    (a) => {
      const items = parseRisuArray(a[0]!);
      items.pop();
      return makeArray(items);
    },
  ],
  [
    ['arraypush'],
    (a) => {
      const items = parseRisuArray(a[0]!);
      items.push(a[1]);
      return makeArray(items);
    },
  ],
  // Always inserts the fourth argument, even when there is none (JSON `null`), as upstream.
  [
    ['arraysplice'],
    (a) => {
      const items = parseRisuArray(a[0]!);
      items.splice(Number(a[1]), Number(a[2]), a[3]);
      return makeArray(items);
    },
  ],
  [
    ['arrayassert'],
    (a) => {
      const items = parseRisuArray(a[0]!);
      const index = Number(a[1]);
      if (index >= items.length) {
        if (Number.isInteger(index) && index >= MAX_CBS_ARRAY) throw new TooLarge('sparse array');
        (items as unknown as Record<number, unknown>)[index] = a[2];
      }
      return makeArray(items);
    },
  ],
  [['makearray', 'array', 'a'], (a) => makeArray(a)],
  [['makedict', 'dict', 'd', 'makeobject', 'object', 'o'], makeDict],
  [['range'], (a) => range(a[0]!)],
  [['filter'], filter],

  // Display escapes. `{{:}}` is dead upstream as well: a `:` opens block syntax.
  [['decbo', 'displayescapedcurlybracketopen'], escapeChar('{')],
  [['decbc', 'displayescapedcurlybracketclose'], escapeChar('}')],
  [['bo', 'ddecbo', 'doubledisplayescapedcurlybracketopen'], () => escapeChar('{')().repeat(2)],
  [['bc', 'ddecbc', 'doubledisplayescapedcurlybracketclose'], () => escapeChar('}')().repeat(2)],
  [['displayescapedbracketopen', 'debo', '('], escapeChar('(')],
  [['displayescapedbracketclose', 'debc', ')'], escapeChar(')')],
  [['displayescapedanglebracketopen', 'deabo', '<'], escapeChar('<')],
  [['displayescapedanglebracketclose', 'deabc', '>'], escapeChar('>')],
  [['displayescapedcolon', 'dec'], escapeChar(':')],
  [['displayescapedsemicolon', ';'], escapeChar(';')],
];

/** The functions by every name they answer to, normalized as macro names are. */
export const CBS_FUNCTIONS: ReadonlyMap<string, CbsFunction> = new Map(
  FUNCTIONS.flatMap(([names, run]) => names.map((name) => [name, run] as const)),
);
