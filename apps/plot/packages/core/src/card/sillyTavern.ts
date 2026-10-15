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

import { coerceDisplayDepth, displayRoleOf, displayScriptPatternError, displaySidesOf } from '../displayScript.js';
import type { DisplayScript, DisplaySide, LoreEntry } from '../types.js';
import { roleFromSillyTavern } from './bookEntry.js';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** ST's `depth_prompt_depth_default`. */
const DEPTH_PROMPT_DEFAULT_DEPTH = 4;

/**
 * The character's note as a constant depth entry, which is what it is: text ST
 * injects N messages from the end on every turn. Ordered after the card's own
 * entries. Marked `depthPrompt`: ST injects it as an extension prompt, not as
 * World Info, so it is outside the book's budget and recursion
 * (`activateLore`), and an export writes it back to `depth_prompt`. Undefined
 * when the card has no note to carry.
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
    depthPrompt: true,
  };
}

/**
 * The extensions with the character's note written back where ST keeps it
 * (`depth_prompt: { prompt, depth, role }`, the role as ST's word), for a card
 * whose book holds it as an entry (`depthPromptEntry`). Unchanged without one.
 */
export function extensionsWithDepthPrompt(
  extensions: Record<string, unknown>,
  lorebook: readonly LoreEntry[],
): Record<string, unknown> {
  const note = lorebook.find((entry) => entry.depthPrompt);
  if (!note) return extensions;
  return {
    ...extensions,
    depth_prompt: { prompt: note.content, depth: note.depth ?? DEPTH_PROMPT_DEFAULT_DEPTH, role: note.role ?? 'system' },
  };
}

/** ST's `regex_placement.USER_INPUT`, `AI_OUTPUT` and `SLASH_COMMAND`. */
const USER_INPUT = 1;
const AI_OUTPUT = 2;
const SLASH_COMMAND = 3;
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
/** SillyTavern's `regex_placement` of what its screen draws, as the side a display script keeps to. */
const SIDE_OF_PLACEMENT: ReadonlyMap<number, DisplaySide> = new Map([
  [USER_INPUT, 'user'],
  [AI_OUTPUT, 'assistant'],
  [SLASH_COMMAND, 'narration'],
]);

const replacementTemplate = (replaceString: string): string =>
  replaceString.replace(/\{\{match\}\}/gi, '$$&').replace(/\$0(?!\d)/g, '$$&');

/**
 * Maps the card's display-only regex scripts onto display scripts, after the ones
 * already there (RisuAI's), skipping any that would duplicate one. Display-only is
 * ST's "Alter chat display": `markdownOnly`, not `promptOnly`, not disabled, on
 * the reader's input, the AI's output or the narrator's messages (`SLASH_COMMAND`)
 * — `messageFormatting` asks the first for the reader's messages, the last for
 * the narrator's and the second for the rest, so a script keeps to the sides it
 * is placed on (`DisplayScript.role`; here the narrator's are the narrations).
 * The rest stay in the
 * extensions untouched: the server reads them from there — the prompt-only ones
 * each time a prompt is built, the ones with neither flag each time a turn is
 * stored (`promptScripts.ts`). A pattern the screen refuses is skipped.
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
      typeof script['findRegex'] !== 'string'
    ) {
      continue;
    }
    const sides = placement.flatMap((at) => {
      const side = SIDE_OF_PLACEMENT.get(at as number);
      return side ? [side] : [];
    });
    if (sides.length === 0) continue;
    const { role } = displayRoleOf(sides);
    const { source, flags } = parseFindRegex(script['findRegex']);
    if (!source || displayScriptPatternError(source) !== null) continue;
    const out = replacementTemplate(
      typeof script['replaceString'] === 'string' ? script['replaceString'] : '',
    );
    // The same rewrite twice is kept once — a script our export also wrote into
    // RisuAI's list (which runs everywhere, as that list has no placement or
    // range) and comes back with this one; the same rewrite on several sides is
    // one on all of them.
    const known = result.findIndex((script) => script.in === source && script.out === out);
    if (known !== -1) {
      const { role: _sides, ...rest } = result[known]!;
      result[known] = { ...rest, ...displayRoleOf([...displaySidesOf(result[known]!), ...sides]) };
      continue;
    }
    // ST's min/max depth, which it applies to the screen as it does to the prompt.
    result.push({
      in: source,
      out,
      ...(flags ? { flags } : {}),
      order,
      enabled: true,
      ...coerceDisplayDepth(script),
      ...(role ? { role } : {}),
    });
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
