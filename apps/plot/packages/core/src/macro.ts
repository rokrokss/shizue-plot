import { readVariable, type Variables } from './variables.js';

export interface MacroContext {
  char: string;
  user: string;
  /**
   * Path-derived chat variables, for {{getvar::k}}. Omitted where there is no
   * chat to derive them from (a greeting expanded at chat creation), and then
   * {{getvar}} is left alone like any other unsupported macro.
   */
  variables?: Variables;
  /**
   * Replacement for {{original}}. Only substituted when provided — {{original}}
   * is meaningful solely while injecting a preset into a card override.
   */
  original?: string;
  /** Injectable randomness for deterministic tests. Returns [0, 1). */
  random?: () => number;
  /**
   * The reader's wall clock, for {{date}}/{{time}}/{{weekday}}/{{idle_duration}}.
   * Without it those macros are left alone like any other unsupported one.
   */
  clock?: MacroClock;
  /**
   * What makes {{pick}} stable: the same seed, text and position always pick the
   * same option, so a regenerate does not reroll the scene. The chat id. Without
   * it {{pick}} behaves like {{random}}.
   */
  seed?: string;
}

/** Content languages a clock formats in — a plot's `language`. */
export type MacroLocale = 'ko' | 'en' | 'ja';

export interface MacroClock {
  now: Date;
  /** IANA zone the reader is in. */
  timeZone: string;
  locale: MacroLocale;
  /**
   * How long the reader was away before this turn: the gap between the latest
   * user message and the one before it. Absent reads as "just now".
   */
  idleMs?: number;
}

/** {{idle_duration}} under a minute — and with nothing to measure. */
const JUST_NOW: Record<MacroLocale, string> = { ko: '방금', en: 'just now', ja: 'たった今' };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The largest whole unit of minutes, hours or days, written out in the locale. */
function idleDuration(clock: MacroClock): string {
  const ms = clock.idleMs ?? 0;
  if (ms < MINUTE_MS) return JUST_NOW[clock.locale];
  const [amount, unit] =
    ms >= DAY_MS
      ? [Math.floor(ms / DAY_MS), 'day']
      : ms >= HOUR_MS
        ? [Math.floor(ms / HOUR_MS), 'hour']
        : [Math.floor(ms / MINUTE_MS), 'minute'];
  return new Intl.NumberFormat(clock.locale, { style: 'unit', unit, unitDisplay: 'long' }).format(amount);
}

/** The clock macros, or undefined for a name that is not one of them. */
function clockMacro(name: string, clock: MacroClock): string | undefined {
  const format = (options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(clock.locale, { ...options, timeZone: clock.timeZone }).format(clock.now);
  if (name === 'date') return format({ dateStyle: 'long' });
  // 24-hour in every language: `timeStyle: 'short'` reads "PM 3:36" in Korean on
  // current ICU data and "오후 3:36" on older, and an intro stores what it gets.
  if (name === 'time') return format({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (name === 'weekday') return format({ weekday: 'long' });
  if (name === 'idle_duration') return idleDuration(clock);
  return undefined;
}

/**
 * 32-bit FNV-1a over the string's UTF-16 code units. Not a security hash — a
 * cheap, stable one, for picks that must come out the same every time and for
 * naming lore entries (`loreEntryKey`).
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const splitOptions = (arg: string): string[] => arg.split(',').map((option) => option.trim());

const MACRO_RE = /\{\{([^{}]*)\}\}/g;
const IMAGE_MACRO_RE = /\{\{\s*img\s*::([^{}]*)\}\}/gi;

/**
 * Drops every `{{img::slug}}` reference. The token is client-side markup — the
 * chat renders it as the character's image — so it is noise to a model, while the
 * stored message keeps it. Prompt assembly is therefore the only caller;
 * `applyMacros` deliberately leaves the token alone, because it also runs where
 * the expanded text is what gets stored (greetings).
 */
export function stripImageMacros(text: string): string {
  return text.replace(IMAGE_MACRO_RE, '');
}

/**
 * The slugs `text` references, in order of appearance and trimmed the way the
 * chat resolves them. Whoever asks then decides what a slug with no asset behind
 * it means — the renderer drops it, the exporter leaves it out.
 */
export function imageMacroSlugs(text: string): string[] {
  return [...text.matchAll(IMAGE_MACRO_RE)].map((match) => match[1]!.trim());
}

/**
 * CBS subset: {{char}}, {{user}}, {{getvar::k}}, {{random:a,b,...}},
 * {{pick::a,b,...}}, {{roll:dN}}, {{// comment}}, {{original}}, and the clock's
 * {{date}}, {{time}}, {{weekday}}, {{idle_duration}}. Macro names are
 * case-insensitive; unsupported macros are left as-is — which is what keeps
 * {{setvar}}/{{addvar}} in the prompt history, where the model needs to keep
 * seeing its own protocol.
 */
export function applyMacros(text: string, ctx: MacroContext): string {
  if (!text) return text;
  const rand = ctx.random ?? Math.random;
  // Seeded by the text and the macro's place in it, so two {{pick}}s in one text
  // choose independently while each one chooses the same way every time.
  const pick = (options: string[], offset: number): string | undefined =>
    ctx.seed === undefined
      ? options[Math.floor(rand() * options.length)]
      : options[fnv1a(`${ctx.seed}\u0000${text}\u0000${offset}`) % options.length];

  return text.replace(MACRO_RE, (match, body: string, offset: number) => {
    const inner = body.trim();
    const lower = inner.toLowerCase();

    if (lower.startsWith('//')) return '';
    if (lower === 'char') return ctx.char;
    if (lower === 'user') return ctx.user;
    if (lower === 'original') return ctx.original ?? match;
    if (ctx.clock) {
      const value = clockMacro(lower, ctx.clock);
      if (value !== undefined) return value;
    }

    // `::` is the CBS argument separator; it has to be tried before the single
    // colon, or `getvar::k` would parse as the argument `:k`.
    const separator = inner.indexOf('::');
    if (separator !== -1) {
      const name = inner.slice(0, separator).trim().toLowerCase();
      if (name === 'getvar' && ctx.variables) {
        return readVariable(ctx.variables, inner.slice(separator + 2).trim()) ?? '';
      }
      if (name === 'pick') return pick(splitOptions(inner.slice(separator + 2)), offset) ?? match;
      return match;
    }

    const colon = inner.indexOf(':');
    if (colon !== -1) {
      const name = inner.slice(0, colon).trim().toLowerCase();
      const arg = inner.slice(colon + 1);

      if (name === 'random') {
        const options = arg.split(',').map((o) => o.trim());
        if (options.length === 0) return match;
        return options[Math.floor(rand() * options.length)] ?? match;
      }

      if (name === 'pick') return pick(splitOptions(arg), offset) ?? match;

      if (name === 'roll') {
        const sides = Number.parseInt(arg.trim().replace(/^d/i, ''), 10);
        if (!Number.isFinite(sides) || sides < 1) return match;
        return String(Math.floor(rand() * sides) + 1);
      }
    }

    return match;
  });
}
