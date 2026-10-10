/**
 * SillyTavern migration (`@shizue/core/sillytavern`): reads ST's "Download
 * Backup" zip or a picked user-data folder in the browser, lists what can be
 * imported, and converts chats. Buffer-free and kept off the package root, so
 * only the page that imports pulls it in. Lorebooks go through
 * `fromLorebookFile` (`./world-info`), which already reads ST's World Info files.
 */

import { displayScriptsWithRegexScripts } from '../card/sillyTavern.js';
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
