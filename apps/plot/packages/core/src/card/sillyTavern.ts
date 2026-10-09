/**
 * SillyTavern interop for the two card-level extensions that have a counterpart
 * here: the character's note (`depth_prompt`) and the regex scripts.
 *
 * Field names and enums follow SillyTavern's source: `depth_prompt` is
 * `{ prompt, depth, role }` with a role word (`src/endpoints/characters.js`), and
 * a regex script is `{ findRegex, replaceString, placement, markdownOnly,
 * promptOnly, disabled, … }` with `regex_placement.AI_OUTPUT = 2`
 * (`public/scripts/extensions/regex/engine.js`).
 */

import { displayScriptPatternError } from '../displayScript.js';
import type { DisplayScript, LoreEntry } from '../types.js';
import { roleFromSillyTavern } from './bookEntry.js';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** ST's `depth_prompt_depth_default`. */
const DEPTH_PROMPT_DEFAULT_DEPTH = 4;

/**
 * The character's note as a constant depth entry, which is what it is: text ST
 * injects N messages from the end on every turn. Ordered after the card's own
 * entries. Undefined when the card has no note to carry.
 */
export function depthPromptEntry(
  extensions: Record<string, unknown>,
  lorebook: LoreEntry[],
): LoreEntry | undefined {
  const note = extensions['depth_prompt'];
  if (!isObject(note) || typeof note['prompt'] !== 'string' || !note['prompt'].trim()) {
    return undefined;
  }
  const depth = note['depth'];
  const role = roleFromSillyTavern(note['role']);
  return {
    keys: [],
    secondaryKeys: [],
    selective: false,
    content: note['prompt'],
    enabled: true,
    constant: true,
    insertionOrder: lorebook.reduce((max, entry) => Math.max(max, entry.insertionOrder + 1), 0),
    caseSensitive: false,
    useRegex: false,
    position: 'before_char',
    depth:
      typeof depth === 'number' && Number.isFinite(depth) && depth >= 0
        ? Math.floor(depth)
        : DEPTH_PROMPT_DEFAULT_DEPTH,
    ...(role ? { role } : {}),
  };
}

/** ST's `regex_placement.AI_OUTPUT`. */
const AI_OUTPUT = 2;
/** Regex flags a display script may carry. */
const NATIVE_FLAGS = 'dgimsuvy';

/** ST's `regexFromString`: `/pattern/flags`, or the whole string as a bare pattern. */
function parseFindRegex(findRegex: string): { source: string; flags: string } {
  const match = /^\/([\s\S]+)\/([a-zA-Z]*)$/.exec(findRegex);
  if (!match) return { source: findRegex, flags: '' };
  const flags = [...new Set(match[2]!)].filter((letter) => NATIVE_FLAGS.includes(letter)).join('');
  return { source: match[1]!, flags };
}

/**
 * ST binds the whole match as `{{match}}`, which it rewrites to `$0` and then
 * resolves itself — `$0` is not a JavaScript replacement pattern, `$&` is.
 */
const replacementTemplate = (replaceString: string): string =>
  replaceString.replace(/\{\{match\}\}/gi, '$$&').replace(/\$0(?!\d)/g, '$$&');

/**
 * Maps the card's display-only regex scripts onto display scripts, after the ones
 * already there (RisuAI's), skipping any that would duplicate one. Display-only is
 * ST's "Alter chat display" on AI output: `markdownOnly`, not `promptOnly`, not
 * disabled. Scripts that change the prompt or the stored text have no
 * counterpart here — a display script only ever rewrites what is drawn — and are
 * left in the extensions untouched. A pattern the screen refuses is skipped.
 */
export function displayScriptsWithRegexScripts(
  extensions: Record<string, unknown>,
  existing: DisplayScript[] | undefined,
): DisplayScript[] | undefined {
  const scripts = extensions['regex_scripts'];
  if (!Array.isArray(scripts)) return existing;

  const result = [...(existing ?? [])];
  let order = result.reduce((max, script) => Math.max(max, script.order + 1), 0);
  for (const script of scripts) {
    if (!isObject(script)) continue;
    const placement = script['placement'];
    if (
      script['markdownOnly'] !== true ||
      script['promptOnly'] === true ||
      script['disabled'] === true ||
      !Array.isArray(placement) ||
      !placement.includes(AI_OUTPUT) ||
      typeof script['findRegex'] !== 'string'
    ) {
      continue;
    }
    const { source, flags } = parseFindRegex(script['findRegex']);
    if (!source || displayScriptPatternError(source) !== null) continue;
    const out = replacementTemplate(
      typeof script['replaceString'] === 'string' ? script['replaceString'] : '',
    );
    if (result.some((known) => known.in === source && known.out === out)) continue;
    result.push({ in: source, out, ...(flags ? { flags } : {}), order, enabled: true });
    order += 1;
  }
  return result.length > 0 ? result : undefined;
}

/** The extensions without the character's note, once it has become a lore entry. */
export function extensionsWithoutDepthPrompt(
  extensions: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...extensions };
  delete rest['depth_prompt'];
  return rest;
}
