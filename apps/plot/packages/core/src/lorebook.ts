import { RE2JS } from 're2js';
import { fnv1a } from './macro.js';
import {
  LORE_MATCH_SOURCES,
  type LoreEntry,
  type LoreInsertionStrategy,
  type LoreMatchSource,
  type LoreTrigger,
} from './types.js';

/** Imported cards are untrusted; bound compilation as well as matching work. */
const MAX_REGEX_KEY_LENGTH = 512;

/**
 * The text one depth scans on one pass, with the foldings the plain-key matchers
 * ask for made once, on first use, rather than once per entry.
 */
interface ScanText {
  raw: string;
  lower?: string;
  risu?: string;
}

/**
 * A scan text as RisuAI matches plain keys against it (`searchMatch` in its
 * `lorebook.svelte.ts`): lowercased, its `{{// …}}` and `{{comment: …}}` macros
 * taken out — the V3 spec says neither is to be matched — and then every space
 * removed. Only the space character goes, not tabs or line breaks, and a comment
 * ends at its line, as there.
 */
const risuFold = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\{\{\/\/(.+?)\}\}/g, '')
    .replace(/\{\{comment:(.+?)\}\}/g, '')
    .replace(/ /g, '');

/** Compiled key patterns, by flags and source: a book's keys are tested on every pass of every turn. */
const compiledKeys = new Map<string, RE2JS | null>();
const MAX_COMPILED_KEYS = 512;

/**
 * A regex key compiled on the linear-time engine, or null where it cannot be:
 * too long, or syntax RE2 does not have (lookaround, backreferences). Never the
 * backtracking JS engine — this runs on the server, over untrusted cards.
 */
function compileKey(source: string, flags: number): RE2JS | null {
  if (!source || source.length > MAX_REGEX_KEY_LENGTH) return null;
  const id = `${flags}/${source}`;
  if (compiledKeys.has(id)) return compiledKeys.get(id)!;
  let compiled: RE2JS | null;
  try {
    compiled = RE2JS.compile(source, flags);
  } catch {
    compiled = null;
  }
  if (compiledKeys.size >= MAX_COMPILED_KEYS) compiledKeys.delete(compiledKeys.keys().next().value!);
  compiledKeys.set(id, compiled);
  return compiled;
}

/**
 * A key matcher over one scan text.
 *
 * `risuMatching` is RisuAI's plain-key matching, for a book that came from there:
 * the key and the text both lowercased with their spaces taken out, so `마왕 성`
 * finds `마왕성` and the other way round, and the entry's `caseSensitive` is not
 * read — RisuAI never reads it on this path. A key that is nothing but spaces is
 * no key. Regex keys keep their own terms either way, on the text as written.
 */
function keyMatcher(
  scan: ScanText,
  caseSensitive: boolean,
  useRegex: boolean,
  risuMatching: boolean,
): (key: string) => boolean {
  if (useRegex) {
    return (key) => compileKey(key, caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE)?.test(scan.raw) ?? false;
  }
  if (risuMatching) {
    const haystack = (scan.risu ??= risuFold(scan.raw));
    return (key) => {
      const needle = key.trim().toLowerCase().replace(/ /g, '');
      return needle.length > 0 && haystack.includes(needle);
    };
  }
  const haystack = caseSensitive ? scan.raw : (scan.lower ??= scan.raw.toLowerCase());
  return (key) => key.length > 0 && haystack.includes(caseSensitive ? key : key.toLowerCase());
}

/**
 * Whether one of an entry's derived aliases (`ActivateLoreInput.aliases`) is in
 * the scan. Always RisuAI's plain matching (`risuFold`): lowercased, spaces out
 * of both sides, a substring anywhere — whatever the entry's own case, regex or
 * whole-word settings and whichever engine runs the book, since an alias is
 * Korean and a whole-word boundary means nothing before a particle (`덤블도어가`).
 */
function aliasMatches(scan: ScanText, aliases: readonly string[] | undefined): boolean {
  if (!aliases || aliases.length === 0) return false;
  const haystack = (scan.risu ??= risuFold(scan.raw));
  return aliases.some((alias) => {
    const needle = alias.trim().toLowerCase().replace(/ /g, '');
    return needle.length > 0 && haystack.includes(needle);
  });
}

/**
 * SillyTavern's `parseRegexFromString`: `/pattern/flags` with no unescaped `/`
 * inside, flags from `gimsuy`. Null for anything else, which ST reads as plain
 * text.
 */
function slashRegex(key: string): { source: string; flags: string } | null {
  const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(key);
  if (!match || /(^|[^\\])\//.test(match[1]!)) return null;
  return { source: match[1]!.replace('\\/', '/'), flags: match[2]! };
}

/** The flags of a slash key that change what RE2 matches; `g`, `u` and `y` do not change a test. */
function re2Flags(flags: string): number {
  return (
    (flags.includes('i') ? RE2JS.CASE_INSENSITIVE : 0) |
    (flags.includes('m') ? RE2JS.MULTILINE : 0) |
    (flags.includes('s') ? RE2JS.DOTALL : 0)
  );
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The book's settings an ST key reads where the entry leaves them to the book. */
interface TavernMatchSettings {
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
}

/** Whether an ST entry's plain keys keep their case: its own setting, or the book's where it left that to the book. */
const tavernCase = (entry: LoreEntry, settings: TavernMatchSettings): boolean =>
  entry.caseSensitiveFromBook ? (settings.caseSensitive ?? entry.caseSensitive) : entry.caseSensitive;

/**
 * SillyTavern's key matching (`WorldInfoBuffer.matchKeys`), one key at a time:
 * the key is expanded first (`substituteParams`, through `keyText`) and trimmed,
 * and an empty one matches nothing. A key written `/pattern/flags` is a regex
 * with its own flags, tested on the scan as it is; any other key is plain text,
 * under the entry's case — or the book's — and, with `matchWholeWords`, a key of
 * one word only matches between non-word characters (ST's own boundary,
 * `(?:^|\W)key(?:$|\W)`, so punctuation and line starts count) while a key of
 * several words is still a plain search.
 *
 * An entry stored before keys were kept as ST wrote them carries them as one
 * regex entry (`useRegex`, plain keys escaped); those are read as they always
 * were.
 */
function tavernMatcher(
  scan: ScanText,
  entry: LoreEntry,
  settings: TavernMatchSettings,
  keyText: (key: string) => string,
): (key: string) => boolean {
  const caseSensitive = tavernCase(entry, settings);
  if (entry.useRegex) {
    return (key) => compileKey(keyText(key).trim(), caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE)?.test(scan.raw) ?? false;
  }
  const wholeWords = entry.matchWholeWords ?? settings.matchWholeWords ?? false;
  return (key) => {
    const text = keyText(key).trim();
    if (!text) return false;
    const regex = slashRegex(text);
    if (regex) return compileKey(regex.source, re2Flags(regex.flags))?.test(scan.raw) ?? false;
    const haystack = caseSensitive ? scan.raw : (scan.lower ??= scan.raw.toLowerCase());
    const needle = caseSensitive ? text : text.toLowerCase();
    if (!wholeWords || needle.split(/\s+/).length > 1) return haystack.includes(needle);
    // A literal between two optional boundaries: linear, whatever the key says.
    return new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`).test(haystack);
  };
}

/**
 * The most extra passes recursive scanning runs. Not what ends it: a pass that
 * activates nothing does, and every pass that goes on takes at least one entry
 * out of the running, so a book of N entries is done within N + 1 passes
 * whatever this says. RisuAI has no cap at all. This one is only a ceiling on
 * the work a hostile card can ask for — each pass rescans every entry still
 * waiting — set far past any chain a creator would write.
 */
const MAX_RECURSION_PASSES = 100;

/**
 * How many times SillyTavern's minimum activations may reach one message further
 * back (`world_info_min_activations`). ST goes on to the start of the chat; each
 * step rescans every waiting entry over a longer text, so a long chat with a
 * setting no book reaches would cost a scan per message. A ceiling on that work,
 * past any depth a creator sets (`world_info_min_activations_depth_max`).
 */
const MAX_MIN_ACTIVATION_STEPS = 100;

/** SillyTavern's `MAX_SCAN_DEPTH`: no scan reaches further back than this many messages. */
const MAX_SCAN_DEPTH = 1000;

/**
 * An entry's identity across turns, for the timed effects a branch records
 * (`messages.lore_triggers`). Derived from what the entry matches and says rather
 * than from its place in the book, so reordering keeps it — and editing the
 * entry starts it over, the way SillyTavern clears an edited entry's effects.
 */
export function loreEntryKey(entry: LoreEntry): string {
  return fnv1a(JSON.stringify([entry.keys, entry.secondaryKeys, entry.content]))
    .toString(16)
    .padStart(8, '0');
}

/**
 * Whether the keys say the entry is triggered by the scan: one primary key — or
 * one of its aliases (`aliasHit`), which stands in for a primary key — and the
 * secondary keys by the entry's logic — `and_any` (one of them, also what an
 * absent logic means), `and_all`, `not_any`, `not_all`. Secondary keys count
 * only on a selective entry that has some.
 */
function keysMatch(entry: LoreEntry, matches: (key: string) => boolean, aliasHit = false): boolean {
  if (!aliasHit && !entry.keys.some(matches)) return false;
  if (!entry.selective || entry.secondaryKeys.length === 0) return true;
  const logic = entry.selectiveLogic;
  if (logic === 'and_all') return entry.secondaryKeys.every(matches);
  if (logic === 'not_any') return !entry.secondaryKeys.some(matches);
  if (logic === 'not_all') return !entry.secondaryKeys.every(matches);
  return entry.secondaryKeys.some(matches);
}

/**
 * SillyTavern's group score (`WorldInfoBuffer.getScore`): how many primary keys
 * matched, plus the secondary keys that matched where the logic is a positive
 * one — all of them for `and_any`, and for `and_all` only once every one did.
 * No primary keys, no score. An alias hit counts as one more primary key.
 */
function keyScore(entry: LoreEntry, matches: (key: string) => boolean, aliasHit = false): number {
  if (entry.keys.length === 0) return 0;
  const primary = entry.keys.filter(matches).length + (aliasHit ? 1 : 0);
  if (entry.secondaryKeys.length === 0) return primary;
  const secondary = entry.secondaryKeys.filter(matches).length;
  const logic = entry.selectiveLogic ?? 'and_any';
  if (logic === 'and_any') return primary + secondary;
  if (logic === 'and_all') return secondary === entry.secondaryKeys.length ? primary + secondary : primary;
  return primary;
}

/** An entry's inclusion group labels. */
const groupsOf = (entry: LoreEntry): string[] =>
  (entry.group ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);

/**
 * One entry per inclusion group. A group an entry already activated this time
 * holds — a sticky one, or one from an earlier pass — drops every fresh member;
 * otherwise one member is chosen: where some score (`useGroupScoring`), the ones
 * whose keys matched less than the best drop out first; then an entry that
 * overrides the group (`groupOverride`) wins, the highest insertionOrder first;
 * otherwise one is drawn by `groupWeight`. An entry in several groups has to
 * survive all of them.
 */
function applyInclusionGroups(
  fresh: LoreEntry[],
  held: Set<string>,
  random: () => number,
  scored: (entry: LoreEntry) => boolean,
  scoreOf: (entry: LoreEntry) => number,
): LoreEntry[] {
  let survivors = fresh.filter((entry) => !groupsOf(entry).some((label) => held.has(label)));
  const labels = [...new Set(survivors.flatMap(groupsOf))];
  for (const label of labels) {
    let members = survivors.filter((entry) => groupsOf(entry).includes(label));
    if (members.length < 2) continue;
    if (members.some(scored)) {
      const scores = new Map(members.map((entry) => [entry, scoreOf(entry)]));
      const best = Math.max(...scores.values());
      const losers = new Set(members.filter((entry) => scored(entry) && scores.get(entry)! < best));
      survivors = survivors.filter((entry) => !losers.has(entry));
      members = members.filter((entry) => !losers.has(entry));
      if (members.length < 2) continue;
    }
    const override = members
      .filter((entry) => entry.groupOverride)
      .sort((a, b) => b.insertionOrder - a.insertionOrder)[0];
    let winner = override;
    if (!winner) {
      const total = members.reduce((sum, entry) => sum + (entry.groupWeight ?? 100), 0);
      let roll = random() * total;
      winner =
        members.find((entry) => {
          roll -= entry.groupWeight ?? 100;
          return roll < 0;
        }) ?? members.at(-1)!;
    }
    survivors = survivors.filter((entry) => entry === winner || !members.includes(entry));
  }
  return survivors;
}

/**
 * Where the branch stands for the timed effects (sticky, cooldown, delay). The
 * caller derives it from the whole branch, not the history the budget kept —
 * counting, as SillyTavern counts its `coreChat`, only the messages the AI is
 * sent.
 */
export interface LoreTimedState {
  /** Messages on the branch before the one being generated — its index. */
  chatLength: number;
  /**
   * `loreEntryKey` → index of the latest assistant message that recorded the
   * entry as freshly triggered.
   */
  lastTriggered: Record<string, number>;
  /**
   * The indices the branch's replies were generated at, ascending: where ST ran
   * its scans, one of which is the one that saw a sticky effect end and started
   * the entry's cooldown. Absent: a scan is taken to have run the moment the
   * sticky effect ended.
   */
  evaluatedAt?: number[];
}

/** Where an entry stands in its timed effects at `chatLength`. */
interface TimedStatus {
  sticky: boolean;
  cooldown: boolean;
  delay: boolean;
}

/**
 * SillyTavern's timed effects (`WorldInfoTimedEffects`), worked out from the
 * branch rather than kept in the chat's metadata. An activation at index `i`
 * starts an effect `{start: i, end: i + n}`; it holds while the chat is longer
 * than `start` and shorter than `end`. So `sticky` S keeps the entry on for the
 * scans at `i < g < i + S`, and `cooldown` C keeps it off for `i < g < i + C` —
 * or, after a sticky effect, from the first scan that saw the sticky end, for C
 * more. `delay` D keeps it off while the chat is shorter than D.
 */
function timedStatus(entry: LoreEntry, at: number | undefined, timed: LoreTimedState): TimedStatus {
  const { chatLength } = timed;
  const sticky = entry.sticky ?? 0;
  const cooldown = entry.cooldown ?? 0;
  let isSticky = false;
  let isCooldown = false;
  // ST drops an effect when the chat has not moved past where it started.
  if (at !== undefined && chatLength > at) {
    if (sticky > 0 && chatLength < at + sticky) {
      isSticky = true;
    } else if (cooldown > 0) {
      if (sticky > 0) {
        // The scan that saw the sticky effect end: an earlier reply's, or this one.
        const ended = timed.evaluatedAt
          ? (timed.evaluatedAt.find((g) => g >= at + sticky && g < chatLength) ?? chatLength)
          : at + sticky;
        isCooldown = chatLength < ended + cooldown;
      } else {
        isCooldown = chatLength < at + cooldown;
      }
    }
  }
  return { sticky: isSticky, cooldown: isCooldown, delay: chatLength < (entry.delay ?? 0) };
}

/** The character a generation answers as, for SillyTavern's character filter. */
export interface LoreCharacter {
  /** What the character is called: the roster name, the card's name. */
  names: string[];
  /** The card's tags. */
  tags: string[];
}

/**
 * SillyTavern's character filter (`checkWorldInfo`): with names, the entry is for
 * those characters only — or, excluding, for everyone else; then the same for
 * tags. A filter on tags filters nothing when there is no character at all.
 */
function passesCharacterFilter(entry: LoreEntry, character: LoreCharacter | undefined): boolean {
  const filter = entry.characterFilter;
  if (!filter) return true;
  if (filter.names && filter.names.length > 0) {
    const named = character?.names.some((name) => filter.names!.includes(name)) ?? false;
    if (filter.exclude ? named : !named) return false;
  }
  if (filter.tags && filter.tags.length > 0 && character) {
    const own = new Set(character.tags.map((tag) => tag.trim().toLowerCase()));
    const tagged = filter.tags.some((tag) => own.has(tag.trim().toLowerCase()));
    if (filter.exclude ? tagged : !tagged) return false;
  }
  return true;
}

export interface ActivateLoreInput {
  /** Branch message texts, newest last. */
  history: string[];
  /**
   * Which of `history` is the branch's greeting, when it holds it. RisuAI scans
   * only the messages after the greeting (`loadLoreBookV3Prompt` reads
   * `chat.message`, which never holds it), so an entry that does not scan it
   * (`scansGreeting`) has it taken out before its depth counts. Absent: every
   * message is scanned.
   */
  greeting?: number;
  /**
   * Whether an entry is SillyTavern's: its keys look at the greeting too, as
   * ST's do — its depth then counts the greeting like any other message — and
   * are matched as ST matches them (`tavernMatcher`). Absent:
   * `LoreEntry.sillyTavern`.
   */
  scansGreeting?: (entry: LoreEntry) => boolean;
  /** The book's scan depth: how many of the newest messages are scanned. */
  scanDepth: number;
  budgetTokens: number;
  countTokens: (text: string) => number;
  recursiveScanning?: boolean;
  /**
   * The book's `LoreSettings.maxRecursionSteps`: how many scans a recursive
   * activation may run, the first included. Absent: until nothing new activates.
   */
  maxRecursionSteps?: number;
  /** The book's `LoreSettings.risuMatching`: plain keys matched as RisuAI does. */
  risuMatching?: boolean;
  /** Absent: a branch with no records, as long as `history`. */
  timed?: LoreTimedState;
  /** Probability rolls and group draws. Returns [0, 1). */
  random?: () => number;
  /**
   * What an active entry says once the caller has expanded it — what its cost is
   * counted on and what a recursive pass scans. Absent: the raw content. A
   * `{{#if}}` that comes out empty then costs nothing, rather than spending the
   * budget on text the model never reads. The entry's key stays on the raw text.
   */
  textOf?: (entry: LoreEntry) => string;
  /**
   * The entries a search by meaning found (SillyTavern's vectorized activation,
   * the API's `vectors.ts`): each activates as a keyword match would, without
   * its keys being read — ST's external activation, which comes after the timed
   * effects and the recursion settings have had their say and before constant,
   * sticky and keys. Still subject to its probability, its inclusion groups and
   * the budget, and its text is scanned by recursion like any other's. Absent:
   * none.
   */
  vectorMatched?: (entry: LoreEntry) => boolean;
  /**
   * Derived keys in the reader's language for an entry whose own keys are in
   * another (the API's Korean alias pass, `loreAliases.ts`) — never the
   * entry's, never exported. One in the scan counts as a primary key match
   * (`aliasMatches`), on both engines, whatever the entry's matching settings;
   * the secondary keys, groups, probability, budget, recursion and timed
   * effects then go as for a key. Absent: none.
   */
  aliases?: (entry: LoreEntry) => readonly string[] | undefined;
  /**
   * The book runs as SillyTavern runs World Info (`checkWorldInfo`) rather than
   * as RisuAI and the V3 spec do — see `activateLore`. Set where the book is
   * ST's: its first member's card was written there, or every entry was.
   */
  sillyTavern?: boolean;
  /** The kind of generation (ST's generation type), for entries' `triggers`. Absent: `normal`. */
  trigger?: LoreTrigger;
  /** The character the generation answers as, for entries' `characterFilter`. */
  character?: LoreCharacter;
  /** The texts entries' `matchSources` add to their scan. */
  scanData?: Partial<Record<LoreMatchSource, string>>;
  /**
   * A key as SillyTavern reads it, macros expanded (`substituteParams`). Only an
   * ST entry's keys go through it. Absent: as written.
   */
  keyText?: (entry: LoreEntry, key: string) => string;
  /** The book's settings ST entries leave to it (`LoreSettings`). */
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  useGroupScoring?: boolean;
  /** An ST book's `LoreSettings.minActivations` and `minActivationsDepthMax`. */
  minActivations?: number;
  minActivationsDepthMax?: number;
  /**
   * Where an entry of an ST book comes from, for the order it is considered
   * (and so paid for) in: the chat's own lore first, then the character's and the
   * rest by `insertionStrategy`. Absent: every entry is the book's own.
   */
  source?: (entry: LoreEntry) => 'chat' | 'character' | 'global';
  insertionStrategy?: LoreInsertionStrategy;
}

export interface LoreActivation {
  /** The entries to inject, in insertionOrder. */
  entries: LoreEntry[];
  /**
   * Keys of the entries that triggered this time — not the ones a sticky effect
   * carried over. What the new assistant message records.
   */
  triggered: string[];
  /** Why each of `entries` is active — what the creator's prompt inspector shows. */
  via: Map<LoreEntry, LoreActivationVia>;
}

/**
 * How an entry came to be active: always on, matched in the history, carried by
 * its sticky window, matched in the content an earlier pass activated, or found
 * by meaning (`ActivateLoreInput.vectorMatched`).
 */
export type LoreActivationVia = 'constant' | 'keyword' | 'sticky' | 'recursion' | 'vector';

/** What both engines work out the same way before they scan. */
interface Prepared {
  keyOf: (entry: LoreEntry) => string;
  status: (entry: LoreEntry) => TimedStatus;
  /** Switched on, of a kind this generation asks for, and for this character. */
  considered: (entry: LoreEntry) => boolean;
  isTavern: (entry: LoreEntry) => boolean;
  /** A key as an ST entry reads it, expanded once per entry and key. */
  keyText: (entry: LoreEntry) => (key: string) => string;
  /** The scan texts `matchSources` add, in ST's order. */
  sources: (entry: LoreEntry) => string[];
}

function prepare(input: ActivateLoreInput, historyLength: number): Prepared {
  const timed: LoreTimedState = {
    chatLength: input.timed?.chatLength ?? historyLength,
    lastTriggered: input.timed?.lastTriggered ?? {},
    ...(input.timed?.evaluatedAt ? { evaluatedAt: input.timed.evaluatedAt } : {}),
  };
  const keys = new Map<LoreEntry, string>();
  const keyOf = (entry: LoreEntry): string => {
    let key = keys.get(entry);
    if (key === undefined) keys.set(entry, (key = loreEntryKey(entry)));
    return key;
  };
  const trigger = input.trigger ?? 'normal';
  const expanded = new Map<LoreEntry, Map<string, string>>();
  return {
    keyOf,
    status: (entry) => timedStatus(entry, timed.lastTriggered[keyOf(entry)], timed),
    considered: (entry) =>
      entry.enabled &&
      !(entry.triggers && entry.triggers.length > 0 && !entry.triggers.includes(trigger)) &&
      passesCharacterFilter(entry, input.character),
    isTavern: input.scansGreeting ?? ((entry) => entry.sillyTavern === true),
    keyText: (entry) => {
      const expand = input.keyText;
      if (!expand) return (key) => key;
      let cache = expanded.get(entry);
      if (!cache) expanded.set(entry, (cache = new Map()));
      return (key) => {
        let text = cache!.get(key);
        if (text === undefined) cache!.set(key, (text = expand(entry, key)));
        return text;
      };
    },
    sources: (entry) =>
      LORE_MATCH_SOURCES.filter((source) => entry.matchSources?.includes(source))
        .map((source) => input.scanData?.[source] ?? '')
        .filter((text) => text.length > 0),
  };
}

/**
 * Selects lore entries triggered by the newest history, keeps what fits in
 * budgetTokens, and returns them ordered by insertionOrder.
 *
 * Each entry scans the newest `scanDepth` messages — or its own `scanDepth` —
 * the greeting left out of them unless the entry scans it (`scansGreeting`),
 * and the texts its `matchSources` name. With recursiveScanning, the content
 * activated by a pass is appended to every entry's scan text and the remaining
 * entries are scanned again, until a pass activates nothing new (or
 * MAX_RECURSION_PASSES extra passes have run, or the book's `maxRecursionSteps`
 * scans). An entry delayed until recursion waits for a recursive pass of its
 * level; one excluded from recursion never activates on one; one that prevents
 * recursion activates without its text being scanned.
 *
 * The budget comes after all of that, as RisuAI spends it and as the V3 spec
 * describes `insertion_order`: the highest insertionOrder is paid for first, and
 * an entry that does not fit is skipped while the ones after it still get their
 * turn — an entry that ignores the budget (`ignoreBudget`) is never skipped.
 * Always-on entries take their place in that order like any other, and an
 * entry the budget leaves out has still done its recursive scanning — the budget
 * decides what is sent, not what the scan saw. The entries that made it go into
 * the prompt lowest insertionOrder first, the order the spec and RisuAI both
 * write them in. Ties go by the order the entries activated in — the book's,
 * within one pass — in the budget and in the prompt alike.
 *
 * Timed effects (SillyTavern's, `timedStatus`): a sticky entry stays active for a
 * while after it triggers, without a scan and without counting as a new
 * trigger; a cooldown then keeps it from triggering; a delay keeps it off until
 * the chat is long enough. A triggered entry is then subject to its
 * `probability`, and to one-per-group among its inclusion groups — where a group
 * counts as taken once one of its members activates, whether or not the budget
 * then has room for it.
 *
 * An entry a search by meaning found (`vectorMatched`) is one more way in: it
 * activates whatever its keys say, after the timed effects and before everything
 * else that follows here, exactly as a keyword match does.
 *
 * An entry's derived aliases (`aliases`) are one more primary key each, matched
 * as RisuAI matches plain keys on either engine (`aliasMatches`).
 *
 * A book that is SillyTavern's (`sillyTavern`) runs as ST's `checkWorldInfo`
 * runs instead — see `activateSillyTavern`.
 *
 * A character's note (`LoreEntry.depthPrompt`) is no World Info in ST but an
 * extension prompt of its own: it is on whenever it is switched on, outside the
 * scan, the budget and the recursion.
 */
export function activateLore(entries: LoreEntry[], input: ActivateLoreInput): LoreActivation {
  const book = entries.filter((entry) => !entry.depthPrompt);
  const result = input.sillyTavern ? activateSillyTavern(book, input) : activateBook(book, input);
  if (book.length === entries.length) return result;
  const notes = entries.filter((entry) => entry.depthPrompt && entry.enabled);
  for (const note of notes) result.via.set(note, 'constant');
  return {
    ...result,
    // Stable, so the book's own order stands among equals.
    entries: [...result.entries, ...notes].sort((a, b) => a.insertionOrder - b.insertionOrder),
  };
}

/** RisuAI's and the V3 spec's activation, with SillyTavern's per-entry settings honoured where an entry has them. */
function activateBook(entries: LoreEntry[], input: ActivateLoreInput): LoreActivation {
  const {
    history,
    budgetTokens,
    countTokens,
    recursiveScanning = false,
    risuMatching = false,
    random = Math.random,
    textOf = (entry: LoreEntry) => entry.content,
    vectorMatched = () => false,
  } = input;
  const prepared = prepare(input, history.length);
  const { keyOf, isTavern } = prepared;

  const sticky: LoreEntry[] = [];
  let pending: LoreEntry[] = [];
  for (const entry of entries) {
    if (!prepared.considered(entry)) continue;
    const status = prepared.status(entry);
    if (status.sticky) {
      sticky.push(entry);
      continue;
    }
    if (status.cooldown || status.delay) continue;
    pending.push(entry);
  }

  // The messages an entry that leaves the greeting out scans, its depth counted
  // in them.
  const { greeting } = input;
  const afterGreeting = greeting === undefined ? history : history.filter((_, at) => at !== greeting);
  const withGreeting = (entry: LoreEntry): boolean => greeting !== undefined && isTavern(entry);
  // `slice(-0)` would be the whole history, so depth 0 is spelled out: an entry
  // that scans nothing but what recursion adds. Keyed by depth and by whether
  // the greeting is among the messages.
  const scans = new Map<string, string>();
  const historyScan = (depth: number, greeted: boolean): string => {
    const key = `${depth}:${greeted}`;
    let scan = scans.get(key);
    if (scan === undefined) {
      scan = depth > 0 ? (greeted ? history : afterGreeting).slice(-depth).join('\n') : '';
      scans.set(key, scan);
    }
    return scan;
  };
  let recursion: string[] = [];
  // The recursion text stands still within a pass, so each depth's scan text is
  // built once per pass rather than once per entry.
  let passScans = new Map<string, ScanText>();
  const scanFor = (entry: LoreEntry): ScanText => {
    const depth = entry.scanDepth ?? input.scanDepth;
    const greeted = withGreeting(entry);
    const sources = prepared.sources(entry);
    const key = `${depth}:${greeted}:${entry.matchSources?.join(',') ?? ''}`;
    let scan = passScans.get(key);
    if (scan === undefined) {
      scan = { raw: [historyScan(depth, greeted), ...sources, ...recursion].filter((text) => text).join('\n') };
      passScans.set(key, scan);
    }
    return scan;
  };
  const matcherFor = (entry: LoreEntry): ((key: string) => boolean) =>
    isTavern(entry)
      ? tavernMatcher(scanFor(entry), entry, input, prepared.keyText(entry))
      : keyMatcher(scanFor(entry), entry.caseSensitive, entry.useRegex, risuMatching);
  const aliasHit = (entry: LoreEntry): boolean => aliasMatches(scanFor(entry), input.aliases?.(entry));
  const passes = (entry: LoreEntry): boolean =>
    entry.probability === undefined || entry.probability >= 100 || random() * 100 < entry.probability;
  const byOrder = (a: LoreEntry, b: LoreEntry): number => a.insertionOrder - b.insertionOrder;

  /** Everything activated, pass by pass, each pass in insertionOrder. */
  const active: LoreEntry[] = [];
  const via = new Map<LoreEntry, LoreActivationVia>();
  const held = new Set<string>(sticky.flatMap(groupsOf));

  // SillyTavern's delay levels, every entry's counted as ST counts them — the
  // first is open from the first recursive pass on, and each next one opens
  // when a pass would otherwise have been the last.
  const levels = [...new Set(entries.map((entry) => entry.delayUntilRecursion ?? 0).filter((level) => level > 0))].sort(
    (a, b) => a - b,
  );
  let level = levels.shift() ?? 0;
  // SillyTavern's step limit counts the first scan, so 1 is no recursion at all.
  const steps = input.maxRecursionSteps;
  const passLimit = Math.min(1 + MAX_RECURSION_PASSES, steps !== undefined && steps > 0 ? steps : Infinity);
  for (let pass = 0; pass < passLimit; pass += 1) {
    const recursive = pass > 0;
    const eligible = pending.filter((entry) => {
      const delayed = entry.delayUntilRecursion ?? 0;
      if (delayed > 0 && (!recursive || delayed > level)) return false;
      return !(recursive && recursiveScanning && entry.excludeRecursion);
    });
    // ST checks an external activation before the entry's constant flag and keys.
    const byMeaning = new Set(eligible.filter(vectorMatched));
    const matched = eligible
      .filter((entry) => byMeaning.has(entry) || entry.constant || keysMatch(entry, matcherFor(entry), aliasHit(entry)))
      .sort(byOrder);
    // A failed roll or a lost draw is final for this activation: the entry is not
    // rolled again on a later pass.
    const done = new Set(matched);
    pending = pending.filter((entry) => !done.has(entry));
    const fresh = applyInclusionGroups(
      matched.filter(passes),
      held,
      random,
      (entry) => entry.useGroupScoring ?? input.useGroupScoring ?? false,
      (entry) => keyScore(entry, matcherFor(entry), aliasHit(entry)),
    );

    const activated = (pass === 0 ? [...sticky, ...fresh] : fresh).sort(byOrder);
    const isFresh = new Set(fresh);
    for (const entry of activated) {
      via.set(
        entry,
        !isFresh.has(entry)
          ? 'sticky'
          : byMeaning.has(entry)
            ? 'vector'
            : entry.constant
              ? 'constant'
              : pass === 0
                ? 'keyword'
                : 'recursion',
      );
      for (const label of groupsOf(entry)) held.add(label);
    }
    active.push(...activated);

    const feeding = activated.filter((entry) => !entry.preventRecursion);
    let next = recursiveScanning && feeding.length > 0 && pending.length > 0;
    if (!next && levels.length > 0) {
      level = levels.shift()!;
      next = pending.length > 0;
    }
    if (!next) break;
    recursion = [...recursion, ...feeding.map(textOf)];
    passScans = new Map();
  }

  // Highest insertionOrder first; a stable sort, so ties keep the activation order.
  const kept = new Set<LoreEntry>();
  let used = 0;
  for (const entry of [...active].sort((a, b) => b.insertionOrder - a.insertionOrder)) {
    const cost = countTokens(textOf(entry));
    if (!entry.ignoreBudget && used + cost > budgetTokens) continue;
    used += cost;
    kept.add(entry);
  }

  const selected = active.filter((entry) => kept.has(entry));
  for (const entry of active) if (!kept.has(entry)) via.delete(entry);
  // Only what reached the prompt is recorded: an entry the budget cut never had
  // an effect to keep.
  const triggered = new Set(selected.filter((entry) => via.get(entry) !== 'sticky').map(keyOf));
  return { entries: selected.sort(byOrder), triggered: [...triggered], via };
}

/* ------------------------------------------------- SillyTavern's own scan */

/** `scan_state` in ST's `world-info.js`. */
const enum ScanState {
  None,
  Initial,
  Recursion,
  MinActivations,
}

/**
 * ST's `getSortedEntries`: highest order first within each source, the chat's
 * own lore ahead of everything, then the character's and the rest as the
 * strategy says — `evenly` sorts the two together, the book's own first among
 * equals. A stable sort, so the book's order decides ties.
 */
function tavernOrder(entries: LoreEntry[], input: ActivateLoreInput): LoreEntry[] {
  const desc = (list: LoreEntry[]): LoreEntry[] => [...list].sort((a, b) => b.insertionOrder - a.insertionOrder);
  const source = input.source ?? (() => 'global' as const);
  const chat = entries.filter((entry) => source(entry) === 'chat');
  const character = entries.filter((entry) => source(entry) === 'character');
  const global = entries.filter((entry) => source(entry) === 'global');
  const rest =
    input.insertionStrategy === 'evenly'
      ? desc([...global, ...character])
      : input.insertionStrategy === 'global_first'
        ? [...desc(global), ...desc(character)]
        : [...desc(character), ...desc(global)];
  return [...desc(chat), ...rest];
}

/**
 * One loop's inclusion groups as ST's `filterByInclusionGroups` settles them, in
 * place on `fresh` — before any probability is rolled. Groups are the labels of
 * `group` split on commas (ST's `/,\s*`/, so a space before a comma stays in the
 * label). A group with a sticky member keeps its sticky members only. Scoring
 * (`useGroupScoring`, the entry's or the book's) then drops the scored members
 * whose keys matched less than the best. A group is then taken outright where an
 * entry already active has exactly that `group` — ST compares the whole field,
 * so `a,b` does not take `a` — and every fresh member goes; otherwise a group of
 * two or more keeps its override (`groupOverride`, highest order first) or the
 * one drawn by weight, where the draw lands on the first entry whose running
 * weight reaches the roll.
 *
 * ST removes a loser with `splice(indexOf(...), 1)`, which for an entry another
 * group already removed takes the last entry of the loop instead; here such an
 * entry is simply gone already.
 */
function tavernGroups(
  fresh: LoreEntry[],
  active: readonly LoreEntry[],
  isSticky: (entry: LoreEntry) => boolean,
  scored: (entry: LoreEntry) => boolean,
  scoreOf: (entry: LoreEntry) => number,
  bookScoring: boolean,
  random: () => number,
): void {
  const grouped = new Map<string, LoreEntry[]>();
  for (const entry of fresh) {
    if (!entry.group) continue;
    for (const label of entry.group.split(/,\s*/).filter((part) => part)) {
      grouped.set(label, [...(grouped.get(label) ?? []), entry]);
    }
  }
  if (grouped.size === 0) return;
  const remove = (entry: LoreEntry): void => {
    const at = fresh.indexOf(entry);
    if (at >= 0) fresh.splice(at, 1);
  };
  const removeAllBut = (group: LoreEntry[], chosen: LoreEntry | null): void => {
    for (const entry of group) if (entry !== chosen) remove(entry);
  };

  const hasSticky = new Map<string, boolean>();
  for (const [label, group] of grouped) {
    const stuck = group.filter(isSticky);
    hasSticky.set(label, stuck.length > 0);
    if (stuck.length > 0) for (const entry of group) if (!stuck.includes(entry)) remove(entry);
  }

  for (const [label, group] of grouped) {
    if (!bookScoring && !group.some((entry) => entry.useGroupScoring)) continue;
    if (hasSticky.get(label)) continue;
    const scores = group.map(scoreOf);
    const best = Math.max(...scores);
    for (let i = 0; i < group.length; i += 1) {
      if (!scored(group[i]!)) continue;
      if (scores[i]! < best) {
        remove(group[i]!);
        group.splice(i, 1);
        scores.splice(i, 1);
        i -= 1;
      }
    }
  }

  for (const [label, group] of grouped) {
    if (hasSticky.get(label)) continue;
    if (active.some((entry) => entry.group === label)) {
      removeAllBut(group, null);
      continue;
    }
    if (group.length <= 1) continue;
    const override = group.filter((entry) => entry.groupOverride).sort((a, b) => b.insertionOrder - a.insertionOrder)[0];
    if (override) {
      removeAllBut(group, override);
      continue;
    }
    const total = group.reduce((sum, entry) => sum + (entry.groupWeight ?? 100), 0);
    const roll = random() * total;
    let running = 0;
    const winner = group.find((entry) => (running += entry.groupWeight ?? 100) >= roll);
    if (winner) removeAllBut(group, winner);
  }
}

/**
 * SillyTavern's World Info, as `checkWorldInfo` runs it, for a book that is
 * ST's. Where this differs from `activateBook`:
 *
 * - **The scan text** is ST's buffer: the newest message first, each trimmed and
 *   behind a `\x01`, the next joined by `\n\x01` — so a `^` in a regex key never
 *   meets a message's first letter — then the entry's `matchSources`, then what
 *   recursion added (not on a minimum-activations scan). An entry's own scan
 *   depth of 0 scans nothing at all. Every key is ST's (`tavernMatcher`). The
 *   caller passes each message as ST scans it (`name: text` with
 *   `world_info_include_names`, after the prompt's regex scripts).
 * - **Order**: entries are considered in ST's sorted order (`tavernOrder`), and a
 *   loop's matches are taken sticky ones first, then in that order.
 * - **Groups before chance**: inclusion groups are settled before the
 *   probability is rolled (`tavernGroups`), a roll passes at `<=`, and a sticky
 *   entry never rolls. A group's loser is not out of the running: a later loop
 *   may match it again.
 * - **The budget is paid as the scan goes**, loop by loop in that order: the
 *   running cost is what earlier loops activated that recursion could see plus
 *   everything this loop has taken so far, and the first entry that brings it to
 *   the budget (`>=`) ends it — only entries that ignore the budget go on after
 *   that, and no recursion follows.
 * - **Recursion** runs while a loop activates something recursion may see, and
 *   delay levels open one by one when it would stop — even with recursion off.
 * - **Minimum activations**: while fewer than `minActivations` entries are
 *   active and nothing else would follow, the next scan reaches one message
 *   further back, up to `minActivationsDepthMax` or the start of the chat.
 *
 * The result is in ST's prompt order: ascending order, ties the other way round
 * from the order they activated in.
 */
function activateSillyTavern(entries: LoreEntry[], input: ActivateLoreInput): LoreActivation {
  const {
    history,
    budgetTokens,
    countTokens,
    recursiveScanning = false,
    random = Math.random,
    textOf = (entry: LoreEntry) => entry.content,
    vectorMatched = () => false,
  } = input;
  const prepared = prepare(input, history.length);
  const sorted = tavernOrder(entries, input);
  const index = new Map(sorted.map((entry, at) => [entry, at]));
  const statuses = new Map<LoreEntry, TimedStatus>();
  const status = (entry: LoreEntry): TimedStatus => {
    let found = statuses.get(entry);
    if (!found) statuses.set(entry, (found = prepared.status(entry)));
    return found;
  };
  const isSticky = (entry: LoreEntry): boolean => status(entry).sticky;

  const { greeting } = input;
  const scansGreeting = input.scansGreeting ?? (() => true);
  const newestFirst = (greeted: boolean): string[] =>
    (greeted || greeting === undefined ? history : history.filter((_, at) => at !== greeting))
      .map((text) => text.trim())
      .reverse();
  const messages = { true: newestFirst(true), false: newestFirst(false) };

  const MATCHER = '\u0001';
  const JOINER = `\n${MATCHER}`;
  let skew = 0;
  const recurse: string[] = [];
  let loopScans = new Map<string, ScanText>();
  const scanFor = (entry: LoreEntry, state: ScanState): ScanText => {
    let depth = entry.scanDepth ?? input.scanDepth + skew;
    const greeted = greeting === undefined || scansGreeting(entry);
    const key = `${depth}:${greeted}:${entry.matchSources?.join(',') ?? ''}`;
    let scan = loopScans.get(key);
    if (scan === undefined) {
      let raw = '';
      if (depth > 0) {
        depth = Math.min(depth, MAX_SCAN_DEPTH);
        raw = MATCHER + messages[`${greeted}`].slice(0, depth).join(JOINER);
        for (const text of prepared.sources(entry)) raw += JOINER + text;
        if (recurse.length > 0 && state !== ScanState.MinActivations) raw += JOINER + recurse.join(JOINER);
      }
      scan = { raw };
      loopScans.set(key, scan);
    }
    return scan;
  };
  const matcherFor = (entry: LoreEntry, state: ScanState): ((key: string) => boolean) =>
    tavernMatcher(scanFor(entry, state), entry, input, prepared.keyText(entry));
  const aliasHit = (entry: LoreEntry, state: ScanState): boolean =>
    aliasMatches(scanFor(entry, state), input.aliases?.(entry));

  const activated = new Map<LoreEntry, LoreActivationVia>();
  const failed = new Set<LoreEntry>();
  let overflowed = false;
  let allActivatedText = '';
  // Every entry's delay level counts, a switched-off one's too, as ST collects them.
  const levels = [...new Set(entries.map((entry) => entry.delayUntilRecursion ?? 0).filter((level) => level > 0))].sort(
    (a, b) => a - b,
  );
  let level = levels.shift() ?? 0;
  const steps = input.maxRecursionSteps;
  const minActivations = input.minActivations ?? 0;
  const depthMax = input.minActivationsDepthMax ?? 0;
  let state = ScanState.Initial;
  let count = 0;
  let recursions = 0;

  while (state !== ScanState.None) {
    if (steps && steps <= count) break;
    count += 1;
    const current = state;
    let next = ScanState.None;

    const now: LoreEntry[] = [];
    const nowVia = new Map<LoreEntry, LoreActivationVia>();
    for (const entry of sorted) {
      if (failed.has(entry) || activated.has(entry)) continue;
      if (!prepared.considered(entry)) continue;
      const { sticky, cooldown, delay } = status(entry);
      if (delay) continue;
      if (cooldown && !sticky) continue;
      const delayed = entry.delayUntilRecursion ?? 0;
      if (current !== ScanState.Recursion && delayed > 0 && !sticky) continue;
      if (current === ScanState.Recursion && delayed > level && !sticky) continue;
      if (current === ScanState.Recursion && recursiveScanning && entry.excludeRecursion && !sticky) continue;
      // `@@activate` and `@@dont_activate` were read into `constant` and `enabled`.
      let how: LoreActivationVia | undefined;
      if (vectorMatched(entry)) how = 'vector';
      else if (entry.constant) how = 'constant';
      else if (sticky) how = 'sticky';
      else if (entry.keys.length > 0 && keysMatch(entry, matcherFor(entry, current), aliasHit(entry, current))) {
        how = current === ScanState.Recursion ? 'recursion' : 'keyword';
      }
      if (how) {
        now.push(entry);
        nowVia.set(entry, how);
      }
    }

    const fresh = now.sort(
      (a, b) => Number(isSticky(b)) - Number(isSticky(a)) || index.get(a)! - index.get(b)!,
    );
    const spent = countTokens(allActivatedText);
    tavernGroups(
      fresh,
      [...activated.keys()],
      isSticky,
      (entry) => entry.useGroupScoring ?? input.useGroupScoring ?? false,
      (entry) => keyScore(entry, matcherFor(entry, current), aliasHit(entry, current)),
      input.useGroupScoring ?? false,
      random,
    );

    let ignoring = fresh.filter((entry) => entry.ignoreBudget).length;
    let newContent = '';
    for (const entry of fresh) {
      if (entry.ignoreBudget) ignoring -= 1;
      if (overflowed && !entry.ignoreBudget) {
        if (ignoring > 0) continue;
        break;
      }
      const chance = entry.probability;
      if (chance !== undefined && chance < 100 && !isSticky(entry) && !(random() * 100 <= chance)) {
        failed.add(entry);
        continue;
      }
      newContent += `${textOf(entry)}\n`;
      if (!entry.ignoreBudget && spent + countTokens(newContent) >= budgetTokens) {
        overflowed = true;
        continue;
      }
      activated.set(entry, nowVia.get(entry)!);
    }

    // What recursion may scan: everything this loop took that did not fail its
    // roll — an entry the budget turned away included, as in ST — less the ones
    // that prevent it.
    const feeding = fresh.filter((entry) => !failed.has(entry) && !entry.preventRecursion);
    if (recursiveScanning && !overflowed && feeding.length > 0) next = ScanState.Recursion;
    if (recursiveScanning && !overflowed && current === ScanState.MinActivations && recurse.length > 0) {
      next = ScanState.Recursion;
    }
    if (next === ScanState.None && !overflowed && minActivations > 0 && activated.size < minActivations) {
      const depth = input.scanDepth + skew;
      const overMax = (depthMax > 0 && depth > depthMax) || depth > history.length;
      if (!overMax && skew < MAX_MIN_ACTIVATION_STEPS) {
        next = ScanState.MinActivations;
        skew += 1;
      }
    }
    if (next === ScanState.None && levels.length > 0) {
      next = ScanState.Recursion;
      level = levels.shift()!;
    }
    if (next === ScanState.Recursion && (recursions += 1) > MAX_RECURSION_PASSES) next = ScanState.None;
    state = next;
    if (state !== ScanState.None) {
      const text = feeding.map(textOf).join('\n');
      if (text) {
        recurse.push(text);
        allActivatedText = `${text}\n${allActivatedText}`;
      }
      loopScans = new Map();
    }
  }

  const order = [...activated.keys()];
  const entriesOut = order.sort((a, b) => b.insertionOrder - a.insertionOrder).reverse();
  const triggered = new Set(entriesOut.filter((entry) => activated.get(entry) !== 'sticky').map(prepared.keyOf));
  return { entries: entriesOut, triggered: [...triggered], via: activated };
}
