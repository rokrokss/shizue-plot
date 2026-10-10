import { evaluateCbs, findAssetMacros, parseCbs, replaceAssetMacros } from './cbs.js';
import { readVariable, type Variables } from './variables.js';

export interface MacroContext {
  char: string;
  user: string;
  /**
   * Path-derived chat variables, for {{getvar::k}}, expressions and ST's
   * {{if .k}}. Omitted where there is no chat to derive them from (a greeting
   * expanded at chat creation), and then {{getvar}}, {{calc}} and {{? …}} are left
   * alone like any other unsupported macro.
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

/** The clock macros by normalized name, or undefined for a name that is not one of them. */
function clockMacro(name: string, clock: MacroClock): string | undefined {
  const format = (options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(clock.locale, { ...options, timeZone: clock.timeZone }).format(clock.now);
  if (name === 'date') return format({ dateStyle: 'long' });
  // 24-hour in every language: `timeStyle: 'short'` reads "PM 3:36" in Korean on
  // current ICU data and "오후 3:36" on older, and an intro stores what it gets.
  if (name === 'time') return format({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (name === 'weekday') return format({ weekday: 'long' });
  if (name === 'idleduration') return idleDuration(clock);
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

/**
 * Drops every asset reference — `{{img::…}}` and the rest of RisuAI's asset
 * macros, nested ones included. The token is client-side markup — the chat
 * renders it as the character's image — so it is noise to a model, while the
 * stored message keeps it. Prompt assembly is therefore the only caller;
 * `applyMacros` deliberately leaves the token alone, because it also runs where
 * the expanded text is what gets stored (greetings).
 */
export function stripImageMacros(text: string): string {
  return replaceAssetMacros(text, () => '');
}

/**
 * The images `text` references — slugs, or the names an imported card wrote —
 * in order of appearance and trimmed. A reference composed at render time
 * (`{{img::{{getvar::outfit}}.png}}`) names nothing until it is drawn and is
 * left out. Whoever asks resolves them (`assetResolver`) and decides what a
 * reference with no asset behind it means — the renderer drops it, the exporter
 * leaves it out.
 */
export function imageMacroRefs(text: string): string[] {
  return findAssetMacros(text)
    .filter((macro) => macro.kind === 'image' && macro.ref !== null)
    .map((macro) => macro.ref!);
}

/**
 * CBS for the prompt, on the shared evaluator (`cbs.ts`): {{char}}, {{user}},
 * {{getvar::k}}, {{random:a,b}} and {{random::a::b}}, {{pick::a,b}},
 * {{roll:dN}}, {{// comment}}, {{original}}, the clock's {{date}}, {{time}},
 * {{weekday}}, {{idle_duration}}, RisuAI's nesting, blocks ({{#if}},
 * {{#when}}) and functions ({{? …}}, {{calc}}, {{equal}}, {{sum}}, …), and
 * SillyTavern's {{if}}…{{else}}…{{/if}}, {{trim}}, {{newline}}, {{space}} and
 * {{noop}}. Macro names are case-insensitive; unsupported macros are left as-is,
 * arguments and all — which is what keeps {{setvar}}/{{addvar}}/{{incvar}}/
 * {{decvar}} in the prompt history, where the model needs to keep seeing its own
 * protocol. Never throws: a malformed template is repaired rather than refused.
 */
export function applyMacros(text: string, ctx: MacroContext): string {
  if (!text || !text.includes('{{')) return text;
  const rand = ctx.random ?? Math.random;
  const { variables, clock } = ctx;

  return evaluateCbs(text, parseCbs(text), {
    random: rand,
    ...(variables ? { variable: (name: string) => readVariable(variables, name) } : {}),
    // Seeded by the text and the macro's place in it, so two {{pick}}s in one text
    // choose independently while each one chooses the same way every time.
    pick: (count, macro) =>
      ctx.seed === undefined
        ? Math.floor(rand() * count)
        : fnv1a(`${ctx.seed}\u0000${text}\u0000${macro.start}`) % count,
    macro: ({ name }) => {
      if (name === 'char') return { text: ctx.char };
      if (name === 'user') return { text: ctx.user };
      if (name === 'original') return ctx.original === undefined ? undefined : { text: ctx.original };
      const value = clock ? clockMacro(name, clock) : undefined;
      return value === undefined ? undefined : { text: value };
    },
  });
}
