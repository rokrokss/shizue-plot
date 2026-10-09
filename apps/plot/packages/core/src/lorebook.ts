import { RE2JS } from 're2js';
import type { LoreEntry } from './types.js';

/** Imported cards are untrusted; bound compilation as well as matching work. */
const MAX_REGEX_KEY_LENGTH = 512;

function matchesAnyKey(keys: string[], scanText: string, caseSensitive: boolean, useRegex: boolean): boolean {
  const haystack = caseSensitive ? scanText : scanText.toLowerCase();
  return keys.some((key) => {
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
  });
}

/** Extra passes run when recursive scanning is on. */
const MAX_RECURSION_PASSES = 2;

function isTriggered(entry: LoreEntry, scanText: string, recursivePass: boolean): boolean {
  // Constant entries all activate on the first pass, so they never retrigger.
  if (entry.constant) return !recursivePass;
  if (!matchesAnyKey(entry.keys, scanText, entry.caseSensitive, entry.useRegex)) return false;
  if (entry.selective && entry.secondaryKeys.length > 0) {
    return matchesAnyKey(entry.secondaryKeys, scanText, entry.caseSensitive, entry.useRegex);
  }
  return true;
}

/**
 * Selects lore entries triggered by scanText, ordered by insertionOrder and cut
 * off at budgetTokens.
 *
 * With recursiveScanning, the content activated by a pass is appended to the scan
 * text and the remaining entries are scanned again, up to MAX_RECURSION_PASSES
 * extra passes. The budget spans all passes: the pass that runs out of it stops
 * there and ends the recursion.
 */
export function activateLore(
  entries: LoreEntry[],
  scanText: string,
  budgetTokens: number,
  countTokens: (text: string) => number,
  recursiveScanning = false,
): LoreEntry[] {
  let pending = entries.filter((entry) => entry.enabled);
  const selected: LoreEntry[] = [];
  let scan = scanText;
  let used = 0;

  for (let pass = 0; pass < (recursiveScanning ? 1 + MAX_RECURSION_PASSES : 1); pass += 1) {
    const triggered = pending
      .filter((entry) => isTriggered(entry, scan, pass > 0))
      .sort((a, b) => a.insertionOrder - b.insertionOrder);

    const activated: LoreEntry[] = [];
    let exhausted = false;
    for (const entry of triggered) {
      const cost = countTokens(entry.content);
      if (used + cost > budgetTokens) {
        exhausted = true;
        break;
      }
      used += cost;
      activated.push(entry);
    }
    selected.push(...activated);
    if (exhausted || activated.length === 0) break;

    const active = new Set(activated);
    pending = pending.filter((entry) => !active.has(entry));
    scan = [scan, ...activated.map((entry) => entry.content)].join('\n');
  }

  return selected.sort((a, b) => a.insertionOrder - b.insertionOrder);
}
