import {
  evaluateCbs,
  findAssetMacros,
  parseCbs,
  replaceAssetMacros,
  type CbsCall,
  type CbsHostData,
  type CbsMessage,
  type CbsValue,
} from './cbs.js';
import { readVariable, runVariableMacro, type Variables } from './variables.js';

/**
 * What the prompt hands RisuAI's functions besides the names and the clock: the
 * card's own fields, the persona, the prompts, the branch, the model, the book,
 * the role of the text. Only the prompt has these — a reader's screen never
 * holds a card's internals — so only `assemblePrompt` passes them.
 */
export type MacroHostData = Pick<
  CbsHostData,
  'character' | 'persona' | 'prompts' | 'chat' | 'model' | 'lorebook' | 'role'
>;

/**
 * SillyTavern's macros that RisuAI has no name for, answered from the prompt's
 * own data: `{{charPrompt}}` and `{{charJailbreak}}` (the card's system prompt
 * and post-history instructions), and `{{group}}`/`{{charIfNotGroup}}` (who is
 * on the stage).
 */
export interface MacroTavernData {
  charPrompt?: string;
  charJailbreak?: string;
  /** The members on the stage, by roster name. One or none reads as `{{char}}`. */
  group?: readonly string[];
}

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
   * The reader's global variables on this plot, for RisuAI's {{getglobalvar}},
   * `@name` in an expression and `#when`'s toggles. Without it {{getglobalvar}}
   * is left as written, and the others read RisuAI's unset `null`.
   */
  globalVariables?: Variables;
  /**
   * SillyTavern's prompt: {{setvar}}, {{addvar}}, {{incvar}}, {{decvar}} and
   * RisuAI's {{setdefaultvar}} in this text run against `variables` — which is
   * then the caller's working map, changed in place — and leave nothing behind,
   * so a {{getvar}} later in the same prompt reads what they wrote. Everywhere
   * else, RisuAI's prompt included, they stay as written.
   */
  runVariableMacros?: boolean;
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
   * The chat id, which {{pick}} and {{rollp}} draw from. With `seedLength` it is
   * RisuAI's draw — one for every pick in a text, a new one each turn as the
   * branch grows, the same one again on a reroll. Alone it is the older rule a
   * screen may still use: the same seed, text and position always pick the same
   * option, for the whole chat. Without it {{pick}} behaves like {{random}}.
   */
  seed?: string;
  /**
   * How many messages follow the greeting on the branch — RisuAI's
   * `chat.message.length`, what its draw turns on. Only read together with `seed`.
   */
  seedLength?: number;
  /**
   * The names the plot's images go by in this chat — a card's own name where it
   * had one, the slug otherwise, open ones only — for RisuAI's {{assetlist}} and
   * {{emotionlist}}, which a card writes into its prompt to tell the model what
   * it may draw. A plot keeps one list of images, so both read the same names.
   * Without it both are left alone like any other unsupported macro.
   */
  assetNames?: readonly string[];
  /**
   * The prompt's data for RisuAI's functions (`MacroHostData`). Given, the text
   * is read as RisuAI reads a prompt: {{comment}} says nothing and {{file}}
   * decodes. Without it those two are left as written, for a screen to draw.
   */
  data?: MacroHostData;
  /** SillyTavern's own macros, where the prompt has what they read. */
  tavern?: MacroTavernData;
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

/**
 * SillyTavern's `{{time_UTC+9}}` / `{{time_UTC-5}}`: the time at that offset
 * from UTC. Read off the macro as written — the name the evaluator hands over has
 * lost the `-` — and only when it is one plain word.
 */
const TIME_UTC_RE = /^\s*time_utc([+-]\d{1,2}(?:\.\d+)?)\s*$/i;

/** The time `offset` hours from UTC, in the same 24-hour form as {{time}}. */
function timeAtOffset(clock: MacroClock, offset: number): string | undefined {
  if (!Number.isFinite(offset) || Math.abs(offset) > 14) return undefined;
  return new Intl.DateTimeFormat(clock.locale, {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(clock.now.getTime() + offset * HOUR_MS));
}

/**
 * The clock macros by normalized name, or undefined for a call that is not one
 * of them. `{{date}}` and `{{time}}` are ours only bare: with an argument they
 * are RisuAI's format strings (`{{date::YYYY-MM-DD}}`), which the evaluator answers.
 */
function clockMacro(call: CbsCall, clock: MacroClock): string | undefined {
  const { name } = call;
  const format = (options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(clock.locale, { ...options, timeZone: clock.timeZone }).format(clock.now);
  const bare = call.args.length === 0;
  if (name === 'date' && bare) return format({ dateStyle: 'long' });
  // 24-hour in every language: `timeStyle: 'short'` reads "PM 3:36" in Korean on
  // current ICU data and "오후 3:36" on older, and an intro stores what it gets.
  if (name === 'time' && bare) return format({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (name === 'weekday') return format({ weekday: 'long' });
  if (name === 'idleduration') return idleDuration(clock);
  if (name.startsWith('timeutc') && bare) {
    const only = call.macro.body.length === 1 ? call.macro.body[0] : undefined;
    const offset = only?.type === 'text' ? TIME_UTC_RE.exec(only.text)?.[1] : undefined;
    return offset === undefined ? undefined : timeAtOffset(clock, Number(offset));
  }
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
 * macros, nested ones included — for the surfaces that show or read a message
 * as plain words: list previews, the public intro, the memory and side-task
 * transcripts, the scene-image prompt.
 *
 * The roleplay prompt keeps them, as RisuAI's does: a card teaches the model to
 * draw a picture by writing the token into its description or lore, and the
 * model keeps doing it by seeing its own earlier ones in the history.
 */
export function stripImageMacros(text: string): string {
  return replaceAssetMacros(text, () => '');
}

const INLAY_MACROS = new Set(['inlay', 'inlayed', 'inlayeddata']);

/**
 * Drops RisuAI's inlay macros and leaves every other asset macro alone. An
 * inlay names a picture in the sender's own RisuAI storage, which this app
 * never has, and RisuAI takes them out of chat turns before the model reads
 * them (sending the picture as an image part where it can). Card text keeps
 * them, as RisuAI's does.
 */
export function stripInlayMacros(text: string): string {
  return replaceAssetMacros(text, (macro) =>
    INLAY_MACROS.has(macro.name) ? '' : text.slice(macro.start, macro.end),
  );
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

/** What `applyMacros` answers a macro it must leave as written with: the evaluator writes the macro out. */
const AS_WRITTEN: CbsValue = { text: '', deferred: true };

/**
 * How much longer than the text itself anything built while expanding it may
 * grow — an `#each` over a long list, values pasted in by `{{getvar}}` — before
 * it is not a prompt any more: ten of the longest values the fold lets a
 * variable hold. Over the text's own length, so a card that is simply long is
 * never cut by it.
 */
const MAX_EXPANDED_GROWTH = 1_000_000;

/** `#each` iterations one text may run, whatever its blocks are nested in. */
const MAX_EXPANDED_ITERATIONS = 2_000;

/** Thrown by the budget hooks, and caught in `applyMacros`. */
class ExpansionBudgetExhausted extends Error {}

/** Nested ST field macros at most this deep — `{{mesExamples}}` inside the examples. */
const MAX_TAVERN_DEPTH = 8;

/**
 * SillyTavern's macros that RisuAI has no name for, or answers otherwise in a
 * prompt. `{{lastUserMessage}}` is ST's "the latest user message": RisuAI's
 * same-named function says nothing in a prompt, which belongs to no message, and
 * is answered here first so it says what a SillyTavern card meant.
 */
function tavernMacro(call: CbsCall, ctx: MacroContext, depth: number): CbsValue | undefined {
  const { name } = call;
  if (call.args.length > 0) return undefined;
  const nested = (field: string | undefined): CbsValue | undefined =>
    field === undefined || depth >= MAX_TAVERN_DEPTH
      ? undefined
      : { text: expand(field, ctx, depth + 1) };
  switch (name) {
    case 'mesexamples':
      return nested(ctx.data?.character?.exampleDialogue);
    case 'charprompt':
      return nested(ctx.tavern?.charPrompt);
    case 'charjailbreak':
      return nested(ctx.tavern?.charJailbreak);
    case 'group':
    case 'groupnotmuted':
    case 'charifnotgroup': {
      const group = ctx.tavern?.group;
      if (!group) return undefined;
      return { text: group.length > 1 ? group.join(', ') : ctx.char };
    }
    case 'input':
      // The reader's unsent words; a prompt is built after they were sent.
      return ctx.data?.chat ? { text: '' } : undefined;
    case 'lastusermessage': {
      if (!ctx.data?.chat) return undefined;
      const branch = ctx.data.chat();
      const latest = branch.messages.findLast((message: CbsMessage) => message.role === 'user');
      if (latest) return { text: latest.data, untrusted: true };
      return branch.offset === 0 ? { text: '' } : undefined;
    }
  }
  return undefined;
}

/**
 * CBS for the prompt, on the shared evaluator (`cbs.ts`): {{char}}, {{user}},
 * {{getvar::k}}, {{random:a,b}} and {{random::a::b}}, {{pick::a,b}},
 * {{roll:dN}}, {{// comment}}, {{original}}, the clock's {{date}}, {{time}},
 * {{weekday}}, {{idle_duration}}, RisuAI's {{assetlist}} and {{emotionlist}},
 * RisuAI's nesting, blocks ({{#if}}, {{#when}}, {{#each}}) and functions
 * ({{? …}}, {{calc}}, {{equal}}, {{sum}}, …) — those that read the chat, the
 * card or the model where `data` gives them something to read — and
 * SillyTavern's {{if}}…{{else}}…{{/if}}, {{trim}}, {{newline}}, {{space}},
 * {{noop}}, {{time_UTC±N}} and the field macros `tavern` answers. Macro names
 * are case-insensitive; unsupported macros are left as-is, arguments and all —
 * which is what keeps {{setvar}}/{{addvar}}/{{incvar}}/{{decvar}} in the prompt
 * history, where the model needs to keep seeing its own protocol.
 *
 * Never throws: a malformed template is repaired rather than refused, and a text
 * whose expansion runs past the budget (`MAX_EXPANDED_GROWTH`, and
 * `MAX_EXPANDED_ITERATIONS` of `#each`) is sent as written — the creator's own
 * words, rather than a prompt cut off somewhere in the middle of one.
 *
 * What RisuAI's display escapes and `#puredisplay` leave behind stays inert here;
 * the prompt maps it back once, on the strings it sends (`unescapeCbs`), so
 * nothing stored from this ever turns back into syntax.
 */
export function applyMacros(text: string, ctx: MacroContext): string {
  return expand(text, ctx, 0);
}

function expand(text: string, ctx: MacroContext, depth: number): string {
  if (!text || (!text.includes('{{') && !text.includes('<') && !text.includes('{#'))) return text;
  const rand = ctx.random ?? Math.random;
  const { variables, globalVariables, clock } = ctx;
  const prompt = ctx.data !== undefined;
  // RisuAI's draw needs both halves; the chat id alone is the older, per-position rule.
  const risuSeed =
    ctx.seed !== undefined && ctx.seedLength !== undefined ? { key: ctx.seed, length: ctx.seedLength } : undefined;
  const data: CbsHostData = {
    ...ctx.data,
    ...(prompt ? { phase: 'prompt' as const } : {}),
    user: ctx.user,
    char: ctx.char,
    ...(clock ? { clock } : {}),
    ...(risuSeed ? { seed: risuSeed } : {}),
    ...(ctx.assetNames ? { assets: { names: ctx.assetNames } } : {}),
  };
  let iterations = 0;
  const limit = text.length + MAX_EXPANDED_GROWTH;

  try {
    return evaluateCbs(text, parseCbs(text), {
      random: rand,
      data,
      each: true,
      iterate: () => {
        if ((iterations += 1) > MAX_EXPANDED_ITERATIONS) throw new ExpansionBudgetExhausted();
      },
      grow: (length) => {
        if (length > limit) throw new ExpansionBudgetExhausted();
      },
      ...(variables ? { variable: (name: string) => readVariable(variables, name) } : {}),
      ...(globalVariables ? { globalVariable: (name: string) => readVariable(globalVariables, name) } : {}),
      // Seeded by the text and the macro's place in it, so two {{pick}}s in one text
      // choose independently while each one chooses the same way every time.
      ...(risuSeed
        ? {}
        : {
            pick: (count: number, macro: { start: number }) =>
              ctx.seed === undefined
                ? Math.floor(rand() * count)
                : fnv1a(`${ctx.seed}\u0000${text}\u0000${macro.start}`) % count,
          }),
      macro: (call) => {
        const { name } = call;
        if (name === 'char') return { text: ctx.char };
        if (name === 'user') return { text: ctx.user };
        if (name === 'original') return ctx.original === undefined ? undefined : { text: ctx.original };
        // A screen draws these; text that is stored or shown keeps them for it.
        if ((name === 'comment' || name === 'file') && !prompt) return AS_WRITTEN;
        if (ctx.runVariableMacros && variables) {
          const ran = runVariableMacro(call, variables);
          if (ran) return ran;
        }
        const tavern = tavernMacro(call, ctx, depth);
        if (tavern) return tavern;
        const value = clock ? clockMacro(call, clock) : undefined;
        return value === undefined ? undefined : { text: value };
      },
    });
  } catch (error) {
    if (error instanceof ExpansionBudgetExhausted) return text;
    throw error;
  }
}
