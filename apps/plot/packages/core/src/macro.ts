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
import { momentFormat } from './cbs/momentFormat.js';
import {
  applyVariableDelta,
  diffVariables,
  readVariable,
  runVariableMacro,
  type VariableDelta,
  type Variables,
} from './variables.js';

/**
 * What the prompt hands RisuAI's functions besides the names and the clock: the
 * card's own fields, the persona, the prompts, the branch, the model, the book,
 * the role of the text, the work's modules. Only the prompt has these — a
 * reader's screen never holds a card's internals — so only `assemblePrompt`
 * passes them.
 */
export type MacroHostData = Pick<
  CbsHostData,
  'character' | 'persona' | 'prompts' | 'chat' | 'model' | 'lorebook' | 'role' | 'modules'
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
  /**
   * The text was written for SillyTavern — a member card ST wrote, an entry of
   * its World Info. Where a macro's name means one thing to RisuAI and another
   * to ST, ST's meaning wins, and ST's own macros that RisuAI has no name for
   * answer (`tavernOnlyMacro`); every other text keeps RisuAI's reading, byte for
   * byte. The fields below are what those macros read.
   */
  sillyTavern?: boolean;
  /** The card's `character_version`, for `{{charVersion}}`. */
  charVersion?: string;
  /** The card's `creator_notes`, for `{{charCreatorNotes}}`. */
  creatorNotes?: string;
  /** The character's note (`depth_prompt`), for `{{charDepthPrompt}}`. */
  depthPrompt?: string;
  /** The card's `first_mes` and alternates, for `{{charFirstMessage::N}}`. */
  firstMessage?: string;
  alternateGreetings?: readonly string[];
  /** Context and response sizes in tokens, for `{{maxPrompt}}`, `{{maxContext}}`, `{{maxResponse}}`. */
  maxContext?: number;
  maxResponse?: number;
  /** The last message's versions — how many, and which one is shown (0 the first) — for the swipe macros. */
  swipes?: { count: number; current: number };
  /** ST's index (the greeting 0) of the first message the prompt sends, for `{{firstIncludedMessageId}}`. */
  firstIncludedMessageId?: number;
  /** ST's generation type, for `{{lastGenerationType}}`. */
  generationType?: string;
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
   * else, RisuAI's prompt included, they stay as written. In SillyTavern's own
   * text (`MacroTavernData.sillyTavern`) they run as ST runs them
   * (`tavernVariableMacro`), its global ones on `globalVariables` likewise.
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
 * ST's clock in a moment format (`momentFormat`): the reader's wall clock, or
 * the time `offsetHours` from UTC as `moment().utc().utcOffset(n)` reads one —
 * moment takes a number under 16 as hours.
 */
function tavernTime(clock: MacroClock, format: string, offsetHours?: number): string {
  if (offsetHours === undefined || !Number.isFinite(offsetHours)) return momentFormat(format, clock.now, clock.timeZone);
  return momentFormat(format, clock.now, clock.timeZone, Math.abs(offsetHours) < 16 ? offsetHours * 60 : offsetHours);
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

/** ST's `getLocalVariable`: a number-like value comes back as that number, an unset one as ''. */
function tavernValue(value: string | undefined): string {
  if (value === undefined) return '';
  return value.trim() === '' || Number.isNaN(Number(value)) ? value : String(Number(value));
}

/** ST's `{{roll}}` (droll): `XdY`, `dY` (one die), `XdY+Z`, `XdY-Z`, or a bare `N` for `1dN`. */
const TAVERN_ROLL = /^(\d*)d(\d+)(?:([+-])(\d+))?$/i;

/** moment's `humanize()` thresholds, in English as ST's moment speaks by default. */
function humanizeDuration(ms: number, suffix: boolean): string {
  const seconds = Math.round(Math.abs(ms) / 1000);
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  const months = Math.round(days / 30.4375);
  const years = Math.round(days / 365.25);
  const text =
    seconds < 45
      ? 'a few seconds'
      : seconds < 90
        ? 'a minute'
        : minutes < 45
          ? `${minutes} minutes`
          : minutes < 90
            ? 'an hour'
            : hours < 22
              ? `${hours} hours`
              : hours < 36
                ? 'a day'
                : days < 26
                  ? `${days} days`
                  : days < 46
                    ? 'a month'
                    : days < 320
                      ? `${months} months`
                      : days < 548
                        ? 'a year'
                        : `${years} years`;
  if (!suffix) return text;
  return ms > 0 ? `in ${text}` : `${text} ago`;
}

/**
 * SillyTavern's macros in its own text (`MacroTavernData.sillyTavern`), where ST
 * answers otherwise than RisuAI or answers where RisuAI has no name. The names
 * that collide, and what each side means:
 *
 * - `lastMessage` / `lastMessageId`: RisuAI counts the messages after the
 *   greeting (`{{lastmessageid}}` 0 for the first reply); ST's chat holds the
 *   greeting at 0, so its id is one more, and its last message may be the
 *   greeting itself.
 * - `lastCharMessage`: both the latest character message; ST's may be the greeting.
 * - `maxContext`: RisuAI's model context; ST's the same size — the context here.
 * - `pick`: RisuAI draws anew each turn; ST keeps one choice per chat and place
 *   (`expand` gives it the per-place seed).
 * - `roll`: ST's droll formulas take a `+Z`/`-Z` and answer '' to what they
 *   cannot read, where RisuAI's answer `NaN`.
 * - `time::UTC±N`: ST's spelling of `time_UTC±N`; RisuAI reads an argument to
 *   `time` as a format.
 * - `getvar`/`getglobalvar`: an unset one is '' in ST and `null` in RisuAI, and
 *   ST writes a number-like value as the number.
 *
 * And ST's own, which RisuAI leaves as written: `charInstruction`,
 * `charDescription`, `charPersonality`, `charScenario`, `mesExamplesRaw`,
 * `charDepthPrompt`, `charCreatorNotes`, `charFirstMessage`/`greeting`,
 * `charVersion`, `notChar`, `groupNotMuted`, `maxPrompt`, `maxResponse`,
 * `banned`, `isMobile`, `lastGenerationType`, `hasExtension`, `allChatRange`,
 * `firstIncludedMessageId`, `firstDisplayedMessageId`, `currentSwipeId`,
 * `lastSwipeId`, `timeDiff`.
 */
function tavernOnlyMacro(call: CbsCall, ctx: MacroContext, depth: number): CbsValue | undefined {
  const tavern = ctx.tavern;
  if (!tavern?.sillyTavern) return undefined;
  const { name } = call;
  const bare = call.args.length === 0;
  const arg = (index: number): CbsValue | undefined => call.args.at(index)?.value();
  const nested = (field: string | undefined): CbsValue =>
    field === undefined || depth >= MAX_TAVERN_DEPTH ? { text: '' } : { text: expand(field, ctx, depth + 1) };
  const chat = ctx.data?.chat?.();
  // ST's chat: the greeting at 0, then every message after it.
  const greeted = chat?.greeting ? 1 : 0;
  const total = chat ? chat.length + greeted : 0;
  const number = (value: number | undefined): CbsValue | undefined =>
    value === undefined ? undefined : { text: String(value) };

  if (name.startsWith('timeutc') && bare && ctx.clock) {
    // The old `{{time_UTC±N}}`, which ST's engine reads as `{{time::UTC±N}}`.
    const only = call.macro.body.length === 1 ? call.macro.body[0] : undefined;
    const offset = only?.type === 'text' ? TIME_UTC_RE.exec(only.text)?.[1] : undefined;
    if (offset !== undefined && /^[+-]\d+$/.test(offset)) {
      return { text: tavernTime(ctx.clock, 'LT', Number.parseInt(offset, 10)) };
    }
  }
  switch (name) {
    case 'lastmessage': {
      if (!chat) return undefined;
      const last = chat.messages.at(-1);
      if (last && chat.offset + chat.messages.length === chat.length) return { text: last.data, untrusted: true };
      return chat.length === 0 ? { text: chat.greeting?.text ?? '', untrusted: true } : undefined;
    }
    case 'lastmessageid':
      return chat ? { text: total > 0 ? String(total - 1) : '' } : undefined;
    case 'lastcharmessage': {
      if (!chat) return undefined;
      const latest = chat.messages.findLast((message) => message.role === 'char');
      if (latest) return { text: latest.data, untrusted: true };
      return chat.offset === 0 ? { text: chat.greeting?.text ?? '', untrusted: true } : undefined;
    }
    case 'allchatrange':
      return chat ? { text: total > 0 ? `0-${total - 1}` : '' } : undefined;
    case 'firstincludedmessageid':
    case 'firstdisplayedmessageid':
      return number(tavern.firstIncludedMessageId);
    case 'currentswipeid':
      return tavern.swipes ? { text: String(tavern.swipes.current + 1) } : { text: '' };
    case 'lastswipeid':
      return tavern.swipes ? { text: String(tavern.swipes.count) } : { text: '' };
    case 'charinstruction':
      return bare ? nested(tavern.charJailbreak) : undefined;
    case 'chardescription':
      return bare ? nested(ctx.data?.character?.description) : undefined;
    case 'charpersonality':
      return bare ? nested(ctx.data?.character?.personality) : undefined;
    case 'charscenario':
      return bare ? nested(ctx.data?.character?.scenario) : undefined;
    case 'mesexamplesraw':
      return bare ? nested(ctx.data?.character?.exampleDialogue) : undefined;
    case 'chardepthprompt':
      return bare ? nested(tavern.depthPrompt) : undefined;
    case 'charcreatornotes':
    case 'creatornotes':
      return bare ? nested(tavern.creatorNotes) : undefined;
    case 'charversion':
    case 'version':
      return bare ? { text: tavern.charVersion ?? '' } : undefined;
    case 'charfirstmessage':
    case 'greeting': {
      const index = bare ? 0 : Number(arg(1)?.text.trim());
      if (!Number.isInteger(index) || index < 0) return { text: '' };
      return nested(index === 0 ? tavern.firstMessage : (tavern.alternateGreetings?.[index - 1] ?? ''));
    }
    case 'notchar': {
      const group = tavern.group ?? [];
      if (group.length <= 1) return { text: ctx.user };
      return { text: group.filter((member) => member !== ctx.char).join(', ') };
    }
    case 'groupnotmuted': {
      const group = tavern.group ?? [];
      return { text: group.length > 1 ? group.join(', ') : ctx.char };
    }
    case 'maxcontext':
    case 'maxcontexttokens':
      return number(tavern.maxContext);
    case 'maxresponse':
    case 'maxresponsetokens':
      return number(tavern.maxResponse);
    case 'maxprompt':
    case 'maxprompttokens':
      return tavern.maxContext !== undefined && tavern.maxResponse !== undefined
        ? { text: String(tavern.maxContext - tavern.maxResponse) }
        : undefined;
    case 'banned':
      // Bans a word on Text Generation WebUI's backend; on every other, nothing.
      return { text: '' };
    case 'ismobile':
    case 'hasextension':
      return { text: 'false' };
    case 'lastgenerationtype':
      return { text: tavern.generationType ?? 'normal' };
    case 'roll': {
      if (bare) return undefined;
      const value = arg(1);
      if (!value || value.deferred) return undefined;
      let formula = value.text.trim();
      if (/^\d+$/.test(formula)) formula = `1d${formula}`;
      const match = TAVERN_ROLL.exec(formula);
      if (!match) return { text: '' };
      const count = match[1] ? Number(match[1]) : 1;
      const sides = Number(match[2]);
      if (count < 1 || sides < 1 || count > 1000) return { text: '' };
      const random = ctx.random ?? Math.random;
      let total = 0;
      for (let die = 0; die < count; die += 1) total += Math.floor(random() * sides) + 1;
      if (match[3]) total += (match[3] === '-' ? -1 : 1) * Number(match[4]);
      return { text: String(total) };
    }
    // ST's clock (`time-macros.js`), in moment's English whatever the reader's
    // language, as ST never sets moment's locale (`momentFormat`).
    case 'time': {
      if (!ctx.clock) return undefined;
      // `{{time::UTC±N}}` at that offset; any other argument is the local time there too.
      const offset = bare ? undefined : /^UTC([+-]\d+)$/.exec(arg(1)?.text.trim() ?? '')?.[1];
      return { text: tavernTime(ctx.clock, 'LT', offset === undefined ? undefined : Number.parseInt(offset, 10)) };
    }
    case 'date':
      return bare && ctx.clock ? { text: tavernTime(ctx.clock, 'LL') } : undefined;
    case 'weekday':
      return ctx.clock ? { text: tavernTime(ctx.clock, 'dddd') } : undefined;
    case 'isotime':
      return ctx.clock ? { text: tavernTime(ctx.clock, 'HH:mm') } : undefined;
    case 'isodate':
      return ctx.clock ? { text: tavernTime(ctx.clock, 'YYYY-MM-DD') } : undefined;
    case 'datetimeformat': {
      if (bare || !ctx.clock) return undefined;
      const format = arg(1);
      if (!format || format.deferred) return undefined;
      return { text: tavernTime(ctx.clock, format.text) };
    }
    case 'idleduration':
      // ST's `getTimeSinceLastMessage`: moment's `humanize()`, and "just now" with nothing to measure.
      return ctx.clock ? { text: ctx.clock.idleMs === undefined ? 'just now' : humanizeDuration(ctx.clock.idleMs, false) } : undefined;
    case 'timediff': {
      if (call.args.length < 2) return undefined;
      const left = Date.parse(arg(1)?.text.trim() ?? '');
      const right = Date.parse(arg(2)?.text.trim() ?? '');
      if (Number.isNaN(left) || Number.isNaN(right)) return { text: 'Invalid date' };
      return { text: humanizeDuration(left - right, true) };
    }
  }
  return undefined;
}

/**
 * SillyTavern's variable macros (`variable-macros.js` over `variables.js`), for
 * its own text when its prompt runs them (`runVariableMacros`): the chat's on
 * `variables`, the global ones on `globalVariables`, both the caller's working
 * maps. Where ST differs from the fold every other text gets (`runVariableMacro`):
 * `{{addvar}}` pushes onto a JSON array, adds numbers, and otherwise appends the
 * text; `{{incvar}}`/`{{decvar}}` write the new value in their place; and ST's
 * `hasvar`, `deletevar` and the JSON `setvarkey`/`getvarkey` are there too.
 */
function tavernVariableMacro(call: CbsCall, ctx: MacroContext): CbsValue | undefined {
  if (!ctx.tavern?.sillyTavern) return undefined;
  // `varexists` and `globalvarexists` are ST's other names for `hasvar` and `hasglobalvar`.
  const spelled = call.name === 'varexists' ? 'hasvar' : call.name === 'globalvarexists' ? 'hasglobalvar' : call.name;
  const match = /^(set|add|inc|dec|get|has|delete|flush)(global)?var(key|index)?$/.exec(spelled);
  if (!match) return undefined;
  const [, verb, global, suffix] = match;
  const store = global ? ctx.globalVariables : ctx.variables;
  if (!store) return undefined;
  const writes = verb !== 'get' && verb !== 'has';
  if (writes && !ctx.runVariableMacros) return undefined;
  const values = Array.from({ length: call.args.length }, (_, i) => call.args.at(i + 1)!.value());
  if (values.some((value) => value.deferred)) return undefined;
  const name = values[0]?.text.trim() ?? '';
  const keyed = suffix !== undefined;
  const current = (): string | undefined => readVariable(store, name);

  if (verb === 'has') return { text: current() === undefined ? 'false' : 'true' };
  if (!name) return { text: '' };
  if (verb === 'get') {
    if (!keyed) return { text: tavernValue(current()), untrusted: true };
    const index = values[1]?.text ?? '';
    try {
      const parsed: unknown = JSON.parse(current() ?? '');
      const item = (parsed as Record<string, unknown>)?.[Number.isNaN(Number(index)) ? index : Number(index)];
      if (item === undefined || item === null) return { text: '' };
      return { text: typeof item === 'object' ? JSON.stringify(item) : tavernValue(String(item)), untrusted: true };
    } catch {
      return { text: tavernValue(current()), untrusted: true };
    }
  }
  if (verb === 'delete' || verb === 'flush') {
    delete store[name];
    return { text: '' };
  }
  if (verb === 'set') {
    if (!keyed) {
      store[name] = values.slice(1).map((value) => value.text).join('::');
      return { text: '' };
    }
    const index = values[1]?.text ?? '';
    const value = values.slice(2).map((one) => one.text).join('::');
    try {
      let parsed: unknown = JSON.parse(current() ?? 'null');
      const numeric = !Number.isNaN(Number(index));
      parsed ??= numeric ? [] : {};
      (parsed as Record<string, unknown>)[numeric ? Number(index) : index] = value;
      store[name] = JSON.stringify(parsed);
    } catch {
      // ST leaves a value it cannot read as JSON alone.
    }
    return { text: '' };
  }
  // add, inc, dec: ST's `addLocalVariable`.
  const delta = verb === 'inc' ? '1' : verb === 'dec' ? '-1' : values.slice(1).map((one) => one.text).join('::');
  const before = tavernValue(current());
  try {
    const parsed: unknown = JSON.parse(before || '0');
    if (Array.isArray(parsed)) {
      parsed.push(delta);
      store[name] = JSON.stringify(parsed);
      return { text: verb === 'add' ? '' : store[name]! };
    }
  } catch {
    // Not an array.
  }
  const base = before === '' ? '0' : before;
  const next =
    Number.isNaN(Number(delta)) || Number.isNaN(Number(base))
      ? `${before}${delta}`
      : formatTavernNumber(Number(base) + Number(delta));
  store[name] = next;
  return { text: verb === 'add' ? '' : next };
}

/** A sum as JavaScript writes it — `String(n)`, which is how ST stores one. */
const formatTavernNumber = (value: number): string => String(value);

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

/** A text as SillyTavern stores it (`expandTavernStored`), and what its macros wrote. */
export interface TavernStored {
  text: string;
  /** The chat variables its `{{setvar}}` and the like wrote, over `ctx.variables`; null for none. */
  variableWrites: VariableDelta | null;
  /** The reader's globals its `{{setglobalvar}}` and the like wrote, over `ctx.globalVariables`; null for none. */
  globalVariableWrites: VariableDelta | null;
}

/**
 * A text SillyTavern stores with its macros already expanded — the reader's
 * turn as it is sent (`sendMessageAsUser`), a narrator's message
 * (`sendNarratorMessage`) and an edit (`updateMessage`), each put through
 * `substituteParams` before it is kept — read as ST reads its own text
 * (`MacroTavernData.sillyTavern`), its variable macros run as ST runs them.
 * What they wrote comes back beside the text, over the maps given (which are
 * not touched), for the caller to keep where it keeps the message's variables
 * and the reader's. A macro this context cannot answer — one that reads the
 * chat or the card `data` would give it, an unknown one — stays as written.
 */
export function expandTavernStored(text: string, ctx: MacroContext): TavernStored {
  const variables = applyVariableDelta(ctx.variables ?? {}, null);
  const globals = ctx.globalVariables ? applyVariableDelta(ctx.globalVariables, null) : undefined;
  const expanded = applyMacros(text, {
    ...ctx,
    variables,
    ...(globals ? { globalVariables: globals } : {}),
    tavern: { ...ctx.tavern, sillyTavern: true },
    runVariableMacros: true,
  });
  return {
    text: expanded,
    variableWrites: diffVariables(variables, ctx.variables ?? {}),
    globalVariableWrites: globals && ctx.globalVariables ? diffVariables(globals, ctx.globalVariables) : null,
  };
}

function expand(text: string, ctx: MacroContext, depth: number): string {
  if (!text || (!text.includes('{{') && !text.includes('<') && !text.includes('{#'))) return text;
  const rand = ctx.random ?? Math.random;
  const { variables, globalVariables, clock } = ctx;
  const prompt = ctx.data !== undefined;
  // RisuAI's draw needs both halves; the chat id alone is the older, per-position
  // rule — which is also SillyTavern's `{{pick}}`, one choice per chat and place.
  const risuSeed =
    !ctx.tavern?.sillyTavern && ctx.seed !== undefined && ctx.seedLength !== undefined
      ? { key: ctx.seed, length: ctx.seedLength }
      : undefined;
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
      ...(ctx.tavern?.sillyTavern ? { sillyTavern: true } : {}),
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
        // SillyTavern's own text reads ST's meaning first (`MacroTavernData.sillyTavern`).
        const tavernOwn = tavernVariableMacro(call, ctx) ?? tavernOnlyMacro(call, ctx, depth);
        if (tavernOwn) return tavernOwn;
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
