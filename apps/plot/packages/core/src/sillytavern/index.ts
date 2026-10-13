/**
 * SillyTavern migration (`@shizue/core/sillytavern`): reads ST's "Download
 * Backup" zip or a picked user-data folder in the browser, lists what can be
 * imported, and converts chats. Buffer-free and kept off the package root, so
 * only the page that imports pulls it in. Lorebooks go through
 * `fromLorebookFile` (`./world-info`), which already reads ST's World Info files.
 */

import { displayScriptsWithRegexScripts } from '../card/sillyTavern.js';
import { promptScriptsOfCard } from '../promptScripts.js';
import type { DisplayScript } from '../types.js';

export * from './zip.js';
export * from './files.js';
export * from './scan.js';
export * from './chat.js';

/**
 * ST's global regex scripts (settings.json `extension_settings.regex`) as display
 * scripts — the display-only ones, by the same mapping a card's `regex_scripts`
 * take on import.
 */
export function regexScriptsToDisplayScripts(scripts: unknown[]): DisplayScript[] {
  return displayScriptsWithRegexScripts({ regex_scripts: scripts }, undefined) ?? [];
}

/**
 * ST's global regex scripts that alter the outgoing prompt, as ST wrote them —
 * the ones the prompt runs (`promptScripts.ts`). A plot has no regex of its own
 * to keep them in, so the migration puts them ahead of its first member's
 * `regex_scripts`, where the prompt reads a card's and ST runs its global ones
 * first; that card's export then carries them as the card's own.
 */
export function promptRegexScripts(scripts: unknown[]): unknown[] {
  return scripts.filter((script) => promptScriptsOfCard({ regex_scripts: [script] }).length > 0);
}
