import { RE2JS } from 're2js';
import { fnv1a } from './macro.js';
import type { LoreEntry } from './types.js';

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
    return (key) => {
      if (!key || key.length > MAX_REGEX_KEY_LENGTH) return false;
      try {
        // Never fall back to the backtracking JS engine for unsupported syntax.
        return RE2JS.compile(key, caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE).test(scan.raw);
      } catch {
        return false;
      }
    };
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
 * The most extra passes recursive scanning runs. Not what ends it: a pass that
 * activates nothing does, and every pass that goes on takes at least one entry
 * out of the running, so a book of N entries is done within N + 1 passes
 * whatever this says. RisuAI has no cap at all. This one is only a ceiling on
 * the work a hostile card can ask for — each pass rescans every entry still
 * waiting — set far past any chain a creator would write.
 */
const MAX_RECURSION_PASSES = 100;

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

function isTriggered(entry: LoreEntry, scan: ScanText, recursivePass: boolean, risuMatching: boolean): boolean {
  // Constant entries all activate on the first pass, so they never retrigger.
  if (entry.constant) return !recursivePass;
  const matches = keyMatcher(scan, entry.caseSensitive, entry.useRegex, risuMatching);
  if (!entry.keys.some(matches)) return false;
  if (!entry.selective || entry.secondaryKeys.length === 0) return true;
  const logic = entry.selectiveLogic;
  if (logic === 'and_all') return entry.secondaryKeys.every(matches);
  if (logic === 'not_any') return !entry.secondaryKeys.some(matches);
  if (logic === 'not_all') return !entry.secondaryKeys.every(matches);
  // `and_any`, which is also what an absent logic means.
  return entry.secondaryKeys.some(matches);
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
 * otherwise one member is drawn by `groupWeight`. An entry in several groups has
 * to survive all of them.
 */
function applyInclusionGroups(
  fresh: LoreEntry[],
  held: Set<string>,
  random: () => number,
): LoreEntry[] {
  let survivors = fresh.filter((entry) => !groupsOf(entry).some((label) => held.has(label)));
  const labels = [...new Set(survivors.flatMap(groupsOf))];
  for (const label of labels) {
    const members = survivors.filter((entry) => groupsOf(entry).includes(label));
    if (members.length < 2) continue;
    const total = members.reduce((sum, entry) => sum + (entry.groupWeight ?? 100), 0);
    let roll = random() * total;
    const winner =
      members.find((entry) => {
        roll -= entry.groupWeight ?? 100;
        return roll < 0;
      }) ?? members.at(-1)!;
    survivors = survivors.filter((entry) => entry === winner || !members.includes(entry));
  }
  return survivors;
}

/**
 * Where the branch stands for the timed effects (sticky, cooldown, delay). The
 * caller derives it from the whole branch, not the history the budget kept.
 */
export interface LoreTimedState {
  /** Messages on the branch before the one being generated — its index. */
  chatLength: number;
  /**
   * `loreEntryKey` → index of the latest assistant message that recorded the
   * entry as freshly triggered.
   */
  lastTriggered: Record<string, number>;
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
   * Whether an entry's keys look at the greeting too, as SillyTavern's do — its
   * depth then counts the greeting like any other message. Absent:
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
 * its sticky window, or matched in the content an earlier pass activated.
 */
export type LoreActivationVia = 'constant' | 'keyword' | 'sticky' | 'recursion';

/**
 * Selects lore entries triggered by the newest history, keeps what fits in
 * budgetTokens, and returns them ordered by insertionOrder.
 *
 * Each entry scans the newest `scanDepth` messages — or its own `scanDepth` —
 * the greeting left out of them unless the entry scans it (`scansGreeting`). With
 * recursiveScanning, the content activated by a pass is appended to every
 * entry's scan text and the remaining entries are scanned again, until a pass
 * activates nothing new (or MAX_RECURSION_PASSES extra passes have run, or the
 * book's `maxRecursionSteps` scans).
 *
 * The budget comes after all of that, as RisuAI spends it and as the V3 spec
 * describes `insertion_order`: the highest insertionOrder is paid for first, and
 * an entry that does not fit is skipped while the ones after it still get their
 * turn. Always-on entries take their place in that order like any other, and an
 * entry the budget leaves out has still done its recursive scanning — the budget
 * decides what is sent, not what the scan saw. The entries that made it go into
 * the prompt lowest insertionOrder first, the order the spec and RisuAI both
 * write them in. Ties go by the order the entries activated in — the book's,
 * within one pass — in the budget and in the prompt alike.
 *
 * Timed effects (SillyTavern's): a sticky entry stays active for `sticky`
 * messages after it triggers, without a scan and without counting as a new
 * trigger; a cooldown then keeps it from triggering for `cooldown` more; a delay
 * keeps it off until the chat holds `delay` messages. A triggered entry is then
 * subject to its `probability`, and to one-per-group among its inclusion groups
 * — where a group counts as taken once one of its members activates, whether or
 * not the budget then has room for it.
 */
export function activateLore(entries: LoreEntry[], input: ActivateLoreInput): LoreActivation {
  const {
    history,
    budgetTokens,
    countTokens,
    recursiveScanning = false,
    risuMatching = false,
    random = Math.random,
    textOf = (entry: LoreEntry) => entry.content,
  } = input;
  const chatLength = input.timed?.chatLength ?? history.length;
  const lastTriggered = input.timed?.lastTriggered ?? {};

  const keys = new Map<LoreEntry, string>();
  const keyOf = (entry: LoreEntry): string => {
    let key = keys.get(entry);
    if (key === undefined) keys.set(entry, (key = loreEntryKey(entry)));
    return key;
  };

  const sticky: LoreEntry[] = [];
  let pending: LoreEntry[] = [];
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const at = lastTriggered[keyOf(entry)];
    const stickyFor = entry.sticky ?? 0;
    if (at !== undefined) {
      if (chatLength - at <= stickyFor) {
        sticky.push(entry);
        continue;
      }
      if (chatLength <= at + stickyFor + (entry.cooldown ?? 0)) continue;
    }
    if (chatLength < (entry.delay ?? 0)) continue;
    pending.push(entry);
  }

  // The messages an entry that leaves the greeting out scans, its depth counted
  // in them.
  const { greeting, scansGreeting = (entry: LoreEntry) => entry.sillyTavern === true } = input;
  const afterGreeting = greeting === undefined ? history : history.filter((_, at) => at !== greeting);
  const withGreeting = (entry: LoreEntry): boolean => greeting !== undefined && scansGreeting(entry);
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
    const key = `${depth}:${greeted}`;
    let scan = passScans.get(key);
    if (scan === undefined) {
      scan = { raw: [historyScan(depth, greeted), ...recursion].filter((text) => text).join('\n') };
      passScans.set(key, scan);
    }
    return scan;
  };
  const passes = (entry: LoreEntry): boolean =>
    entry.probability === undefined || entry.probability >= 100 || random() * 100 < entry.probability;
  const byOrder = (a: LoreEntry, b: LoreEntry): number => a.insertionOrder - b.insertionOrder;

  /** Everything activated, pass by pass, each pass in insertionOrder. */
  const active: LoreEntry[] = [];
  const via = new Map<LoreEntry, LoreActivationVia>();
  const held = new Set<string>(sticky.flatMap(groupsOf));

  // SillyTavern's step limit counts the first scan, so 1 is no recursion at all.
  const steps = input.maxRecursionSteps;
  const passLimit = recursiveScanning
    ? Math.min(1 + MAX_RECURSION_PASSES, steps !== undefined && steps > 0 ? steps : Infinity)
    : 1;
  for (let pass = 0; pass < passLimit; pass += 1) {
    const matched = pending
      .filter((entry) => isTriggered(entry, scanFor(entry), pass > 0, risuMatching))
      .sort(byOrder);
    // A failed roll or a lost draw is final for this activation: the entry is not
    // rolled again on a later pass.
    const done = new Set(matched);
    pending = pending.filter((entry) => !done.has(entry));
    const fresh = applyInclusionGroups(matched.filter(passes), held, random);

    const activated = (pass === 0 ? [...sticky, ...fresh] : fresh).sort(byOrder);
    const isFresh = new Set(fresh);
    for (const entry of activated) {
      via.set(
        entry,
        !isFresh.has(entry) ? 'sticky' : entry.constant ? 'constant' : pass === 0 ? 'keyword' : 'recursion',
      );
      for (const label of groupsOf(entry)) held.add(label);
    }
    active.push(...activated);
    if (activated.length === 0 || pending.length === 0) break;

    recursion = [...recursion, ...activated.map(textOf)];
    passScans = new Map();
  }

  // Highest insertionOrder first; a stable sort, so ties keep the activation order.
  const kept = new Set<LoreEntry>();
  let used = 0;
  for (const entry of [...active].sort((a, b) => b.insertionOrder - a.insertionOrder)) {
    const cost = countTokens(textOf(entry));
    if (used + cost > budgetTokens) continue;
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
