/**
 * Call codes: the `<StatusWindow hp={50} />` the model writes into its reply, and
 * the props it carries.
 *
 * This is the Elyn protocol — the model re-states the component's inputs in its
 * own output, so the platform can draw them. Two rules shape everything here:
 *
 *   1. **Nothing is evaluated.** A prop value is read by the literal parser below,
 *      which knows numbers, strings, booleans, null, arrays and objects and
 *      nothing else. `{count + 1}`, `{() => x}` and `{someVar}` are not values,
 *      they are rejected, and the component sees its own default instead. The
 *      parent origin never runs a character of creator or model code.
 *   2. **A partial call is not a call.** A reply arrives token by token, so
 *      `<StatusWindow hp={5` is on screen for a frame. Anything that does not
 *      close cleanly stays text and is re-examined on the next token, which is
 *      also what makes a model's typo degrade into visible prose rather than an
 *      error card.
 *
 * Only the self-closing form is a call code, because that is the form the protocol
 * asks for and the one that can be recognized without guessing where the element
 * ends.
 */

import type { PlatformContext } from './componentRuntime';
import type { Segment } from './displayScripts';

/** Longest message this scans; past that a message is prose, not a status block. */
const MAX_SCANNED_CHARS = 20_000;
/** Calls one message may mount. Each one is an iframe. */
const MAX_CALLS_PER_MESSAGE = 8;
/** Longest single prop value. */
const MAX_VALUE_CHARS = 5_000;
/** Deepest an array/object prop may nest. */
const MAX_VALUE_DEPTH = 8;
/** Props one call may carry. */
const MAX_PROPS = 64;

/** A recognized call code and where it sits in the message. */
interface ComponentCall {
  name: string;
  props: Record<string, unknown>;
  /** Names of the attributes whose values were not literals, so were dropped. */
  rejected: string[];
  start: number;
  /** Exclusive — `text.slice(start, end)` is the whole `<Name … />`. */
  end: number;
}

const NAME_START = /[A-Za-z_$]/;
const NAME_CHAR = /[A-Za-z0-9_$]/;
const ATTR_CHAR = /[A-Za-z0-9_$:-]/;

/* ----------------------------------------------------------- literal values */

/** A cursor over one `{…}` attribute body. */
class LiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  /** Parses the whole body as one literal, or returns undefined if it is not one. */
  static parse(source: string): unknown {
    if (source.length > MAX_VALUE_CHARS) return undefined;
    const parser = new LiteralParser(source);
    try {
      const value = parser.value(0);
      parser.skipSpace();
      // Trailing anything means this was an expression that merely starts like a
      // literal — `{1 + 1}`, `{[1].length}`.
      return parser.index === source.length ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private skipSpace(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index]!)) this.index += 1;
  }

  private expect(char: string): void {
    if (this.source[this.index] !== char) throw new Error(`expected ${char}`);
    this.index += 1;
  }

  private value(depth: number): unknown {
    if (depth > MAX_VALUE_DEPTH) throw new Error('too deep');
    this.skipSpace();
    const char = this.source[this.index];
    if (char === undefined) throw new Error('empty');
    if (char === '"' || char === "'") return this.string();
    if (char === '[') return this.array(depth);
    if (char === '{') return this.object(depth);

    const rest = this.source.slice(this.index);
    const word = /^(?:true|false|null)\b/.exec(rest);
    if (word) {
      this.index += word[0].length;
      return word[0] === 'true' ? true : word[0] === 'false' ? false : null;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      this.index += number[0].length;
      return Number(number[0]);
    }
    // An identifier, a call, an operator — not a literal, so not a prop we take.
    throw new Error('not a literal');
  }

  private string(): string {
    const quote = this.source[this.index]!;
    this.index += 1;
    let out = '';
    for (;;) {
      const char = this.source[this.index];
      if (char === undefined) throw new Error('unterminated string');
      this.index += 1;
      if (char === quote) return out;
      if (char !== '\\') {
        out += char;
        continue;
      }
      const escaped = this.source[this.index];
      if (escaped === undefined) throw new Error('unterminated escape');
      this.index += 1;
      out +=
        escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
    }
  }

  private array(depth: number): unknown[] {
    this.expect('[');
    const items: unknown[] = [];
    for (;;) {
      this.skipSpace();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return items;
      }
      if (items.length >= MAX_PROPS) throw new Error('too many items');
      items.push(this.value(depth + 1));
      this.skipSpace();
      if (this.source[this.index] === ',') this.index += 1;
      else if (this.source[this.index] !== ']') throw new Error('expected , or ]');
    }
  }

  private object(depth: number): Record<string, unknown> {
    this.expect('{');
    // Null prototype: a model writing `{__proto__: …}` stores a key, and does not
    // hand the component an object whose prototype it did not expect.
    const out = Object.create(null) as Record<string, unknown>;
    let count = 0;
    for (;;) {
      this.skipSpace();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return out;
      }
      if (count >= MAX_PROPS) throw new Error('too many keys');
      const char = this.source[this.index];
      let key: string;
      if (char === '"' || char === "'") key = this.string();
      else {
        const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.source.slice(this.index));
        if (!identifier) throw new Error('expected key');
        key = identifier[0];
        this.index += key.length;
      }
      this.skipSpace();
      this.expect(':');
      out[key] = this.value(depth + 1);
      count += 1;
      this.skipSpace();
      if (this.source[this.index] === ',') this.index += 1;
      else if (this.source[this.index] !== '}') throw new Error('expected , or }');
    }
  }
}

/* -------------------------------------------------------------- the scanner */

/** Reads a `{…}` attribute body, respecting braces and quotes inside it. */
function readBraced(text: string, start: number): { body: string; end: number } | null {
  let depth = 0;
  let quote = '';
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(start + 1, i), end: i + 1 };
    }
  }
  // Still open: the reply is mid-stream, or the model never closed it.
  return null;
}

/**
 * Parses one `<Name … />` starting at `start`, which must be the `<`. Returns null
 * when what follows is not a complete self-closing element — a partial stream, a
 * `<` that was only ever a less-than, an element with children.
 */
function parseCall(text: string, start: number, names: ReadonlySet<string>): ComponentCall | null {
  let i = start + 1;
  if (!NAME_START.test(text[i] ?? '')) return null;
  let name = '';
  while (i < text.length && NAME_CHAR.test(text[i]!)) {
    name += text[i];
    i += 1;
  }
  if (!names.has(name)) return null;

  const props = Object.create(null) as Record<string, unknown>;
  const rejected: string[] = [];

  for (;;) {
    const before = i;
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (text.startsWith('/>', i)) {
      return { name, props, rejected, start, end: i + 2 };
    }
    // `<Status>` with children is not the protocol's shape, and neither is a
    // truncated one; both stay text.
    if (i >= text.length || text[i] === '>') return null;
    // Two attributes must be separated by whitespace.
    if (i === before) return null;

    let attribute = '';
    while (i < text.length && ATTR_CHAR.test(text[i]!)) {
      attribute += text[i];
      i += 1;
    }
    if (!attribute) return null;
    if (Object.keys(props).length + rejected.length >= MAX_PROPS) return null;

    const afterName = i;
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (text[i] !== '=') {
      // A bare attribute is `true`, as in JSX.
      props[attribute] = true;
      i = afterName;
      continue;
    }
    i += 1;
    while (i < text.length && /\s/.test(text[i]!)) i += 1;

    const char = text[i];
    if (char === '"' || char === "'") {
      const close = text.indexOf(char, i + 1);
      if (close === -1) return null;
      props[attribute] = text.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (char === '{') {
      const braced = readBraced(text, i);
      if (!braced) return null;
      const value = LiteralParser.parse(braced.body);
      // A value we cannot read as a literal is dropped rather than guessed at:
      // the component falls back to its own default, which is exactly what the
      // authoring guide asks every prop to have.
      if (value === undefined) rejected.push(attribute);
      else props[attribute] = value;
      i = braced.end;
      continue;
    }
    return null;
  }
}

/**
 * Every call code in `text` for a component the card actually declares, left to
 * right and never overlapping. An unknown name is not a call: prose containing
 * `<Note />` stays prose, and a card with no components never matches anything.
 */
export function findComponentCalls(text: string, names: readonly string[]): ComponentCall[] {
  const calls: ComponentCall[] = [];
  if (names.length === 0 || text.length > MAX_SCANNED_CHARS) return calls;
  const set = new Set(names);

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '<') continue;
    const call = parseCall(text, i, set);
    if (!call) continue;
    calls.push(call);
    if (calls.length >= MAX_CALLS_PER_MESSAGE) break;
    i = call.end - 1;
  }
  return calls;
}

/* --------------------------------------------------------------- rendering */

/** A component the message asked for, in the place the call code stood. */
interface ComponentSegment {
  kind: 'component';
  name: string;
  props: Record<string, unknown>;
}

/** What a message body is made of once both layers have had a look at it. */
export type BodySegment = Segment | ComponentSegment;

/** Everything a message needs to mount the character's components. */
export interface ComponentContext {
  /** The card's whole component module. */
  code: string;
  /** Names declared in it — the only tags a call code may name. */
  names: string[];
  /** Platform state, injected as the `platform` prop. */
  platform: PlatformContext;
  /** Fills the composer when a component asks. */
  onSuggestInput?: (text: string) => void;
  /** Sends a turn when a component asks. Absent unless the card declared it. */
  onSendTurn?: (text: string, directions?: string) => void;
}

/**
 * Cuts the call codes out of the text runs and puts a component in their place.
 * The call code leaves the screen but not the message: the stored text and the
 * prompt keep it, so the model goes on observing its own protocol — the same deal
 * Layer 1's macros have.
 */
export function splitComponentCalls(
  segments: readonly Segment[],
  names: readonly string[],
): BodySegment[] {
  const out: BodySegment[] = [];
  for (const segment of segments) {
    // An earlier display script's output is finished markup, not text to scan.
    if (segment.kind !== 'text') {
      out.push(segment);
      continue;
    }
    const calls = findComponentCalls(segment.text, names);
    if (calls.length === 0) {
      out.push(segment);
      continue;
    }
    let cursor = 0;
    for (const call of calls) {
      if (call.start > cursor) out.push({ kind: 'text', text: segment.text.slice(cursor, call.start) });
      out.push({ kind: 'component', name: call.name, props: call.props });
      cursor = call.end;
    }
    if (cursor < segment.text.length) out.push({ kind: 'text', text: segment.text.slice(cursor) });
  }
  return out;
}
