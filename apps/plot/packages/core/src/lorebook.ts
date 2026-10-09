import { RE2JS } from 're2js';
import { fnv1a } from './macro.js';
import type { LoreEntry } from './types.js';

/** Imported cards are untrusted; bound compilation as well as matching work. */
const MAX_REGEX_KEY_LENGTH = 512;

/** A key matcher over one scan text, which is lowercased once rather than per key. */
function keyMatcher(scanText: string, caseSensitive: boolean, useRegex: boolean): (key: string) => boolean {
  const haystack = caseSensitive || useRegex ? scanText : scanText.toLowerCase();
  return (key) => {
    if (!key) return false;
    if (useRegex) {
      if (key.length > MAX_REGEX_KEY_LENGTH) return false;
      try {
        // Never fall back to the backtracking JS engine for unsupported syntax.
        return RE2JS.compile(key, caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE).test(scanText);
      } catch {
        return false;
      }
    }
    return haystack.includes(caseSensitive ? key : key.toLowerCase());
  };
}

/** Extra passes run when recursive scanning is on. */
const MAX_RECURSION_PASSES = 2;

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

function isTriggered(entry: LoreEntry, scanText: string, recursivePass: boolean): boolean {
  // Constant entries all activate on the first pass, so they never retrigger.
  if (entry.constant) return !recursivePass;
  const matches = keyMatcher(scanText, entry.caseSensitive, entry.useRegex);
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
  /** The book's scan depth: how many of the newest messages are scanned. */
  scanDepth: number;
  budgetTokens: number;
  countTokens: (text: string) => number;
  recursiveScanning?: boolean;
  /** Absent: a branch with no records, as long as `history`. */
  timed?: LoreTimedState;
  /** Probability rolls and group draws. Returns [0, 1). */
  random?: () => number;
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
 * Selects lore entries triggered by the newest history, ordered by insertionOrder
 * and cut off at budgetTokens.
 *
 * Each entry scans the newest `scanDepth` messages — or its own `scanDepth`. With
 * recursiveScanning, the content activated by a pass is appended to every
 * entry's scan text and the remaining entries are scanned again, up to
 * MAX_RECURSION_PASSES extra passes. The budget spans all passes: the pass that
 * runs out of it stops there and ends the recursion.
 *
 * Timed effects (SillyTavern's): a sticky entry stays active for `sticky`
 * messages after it triggers, without a scan and without counting as a new
 * trigger; a cooldown then keeps it from triggering for `cooldown` more; a delay
 * keeps it off until the chat holds `delay` messages. A triggered entry is then
 * subject to its `probability`, and to one-per-group among its inclusion groups.
 */
export function activateLore(entries: LoreEntry[], input: ActivateLoreInput): LoreActivation {
  const { history, budgetTokens, countTokens, recursiveScanning = false, random = Math.random } = input;
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

  // `slice(-0)` would be the whole history, so depth 0 is spelled out: an entry
  // that scans nothing but what recursion adds.
  const scans = new Map<number, string>();
  const historyScan = (depth: number): string => {
    let scan = scans.get(depth);
    if (scan === undefined) {
      scan = depth > 0 ? history.slice(-depth).join('\n') : '';
      scans.set(depth, scan);
    }
    return scan;
  };
  let recursion: string[] = [];
  const scanFor = (entry: LoreEntry): string =>
    [historyScan(entry.scanDepth ?? input.scanDepth), ...recursion].filter((text) => text).join('\n');
  const passes = (entry: LoreEntry): boolean =>
    entry.probability === undefined || entry.probability >= 100 || random() * 100 < entry.probability;
  const byOrder = (a: LoreEntry, b: LoreEntry): number => a.insertionOrder - b.insertionOrder;

  const selected: LoreEntry[] = [];
  const triggered = new Set<string>();
  const via = new Map<LoreEntry, LoreActivationVia>();
  const held = new Set<string>(sticky.flatMap(groupsOf));
  let used = 0;

  for (let pass = 0; pass < (recursiveScanning ? 1 + MAX_RECURSION_PASSES : 1); pass += 1) {
    const matched = pending.filter((entry) => isTriggered(entry, scanFor(entry), pass > 0)).sort(byOrder);
    // A failed roll or a lost draw is final for this activation: the entry is not
    // rolled again on a later pass.
    const done = new Set(matched);
    pending = pending.filter((entry) => !done.has(entry));
    const fresh = applyInclusionGroups(matched.filter(passes), held, random);

    const candidates = (pass === 0 ? [...sticky, ...fresh] : fresh).sort(byOrder);
    const isFresh = new Set(fresh);
    const activated: LoreEntry[] = [];
    let exhausted = false;
    for (const entry of candidates) {
      const cost = countTokens(entry.content);
      if (used + cost > budgetTokens) {
        exhausted = true;
        break;
      }
      used += cost;
      activated.push(entry);
      // Only what reached the prompt is recorded: an entry the budget cut never
      // had an effect to keep.
      if (isFresh.has(entry)) triggered.add(keyOf(entry));
      via.set(
        entry,
        !isFresh.has(entry) ? 'sticky' : entry.constant ? 'constant' : pass === 0 ? 'keyword' : 'recursion',
      );
      for (const label of groupsOf(entry)) held.add(label);
    }
    selected.push(...activated);
    if (exhausted || activated.length === 0) break;

    recursion = [...recursion, ...activated.map((entry) => entry.content)];
  }

  return { entries: selected.sort(byOrder), triggered: [...triggered], via };
}
