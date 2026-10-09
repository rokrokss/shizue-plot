/**
 * RisuAI interop for the two custom-UI card fields.
 *
 * RisuAI keeps display transforms in `extensions.risuai.customScripts`, a list of
 * `{ in, out, type, ableFlag, flag }` entries. Only `type === 'editdisplay'` is a
 * display transform; every other type (`editinput`, `edittrigger`, …) is left
 * where it is — `NormalizedCard.extensions` is preserved verbatim, so an unmapped
 * entry survives a round trip untouched.
 *
 * `in` is the bare regular expression source. `flag` carries the regex flags with
 * `<…>` directives mixed into them — a real card writes `gi<move_top><order 3>` —
 * and `ableFlag` says whether the flag letters are meant to be used at all. Older
 * cards spell the same directives `@@move_top` at the head of `out`, so both forms
 * are read.
 */

import { displayScriptPatternError } from '../displayScript.js';
import { parseDefaultVariables, serializeDefaultVariables, type Variables } from '../variables.js';
import type { DisplayScript, DisplayScriptAction } from '../types.js';

/** Regex flags a script may carry. Anything else in `flag` is not a flag. */
const NATIVE_FLAGS = 'dgimsuvy';

/** `<move_top>`, `<order 3>`, `<cbs>`, … — a directive inside the flag field. */
const FLAG_DIRECTIVE = /<([a-z_]+)(?:[ \t]+(-?\d+))?>/gi;
/** `@@move_top` — the same directives as older cards write them, inside `out`. */
const OUT_ACTION = /@@(move_top|move_bottom|repeat_back)\b/i;
/** `<order 3>` written into `out` rather than into `flag`. */
const OUT_ORDER = /<order[ \t]+(-?\d+)>/i;

const ACTIONS = ['move_top', 'move_bottom', 'repeat_back'];

interface Directives {
  action?: DisplayScriptAction;
  order?: number;
}

/**
 * Splits the flag field into regex flags and directives. An unknown directive
 * (`<cbs>`) is dropped rather than mistaken for flag letters — that is the whole
 * reason the directives come out first.
 */
function parseFlagField(flag: string): Directives & { flags: string } {
  let action: DisplayScriptAction | undefined;
  let order: number | undefined;

  const rest = flag.replace(FLAG_DIRECTIVE, (_directive, name: string, argument?: string) => {
    const key = name.toLowerCase();
    if (ACTIONS.includes(key)) action ??= key as DisplayScriptAction;
    else if (key === 'order' && argument !== undefined) order ??= Number.parseInt(argument, 10);
    return '';
  });

  const flags = [...new Set(rest)].filter((letter) => NATIVE_FLAGS.includes(letter)).join('');
  return { flags, ...(action ? { action } : {}), ...(order !== undefined ? { order } : {}) };
}

/** Reads the directives an older card puts in `out`, and returns the template without them. */
function parseOutDirectives(out: string): Directives & { template: string } {
  const action = OUT_ACTION.exec(out);
  const order = OUT_ORDER.exec(out);
  return {
    ...(action ? { action: action[1]!.toLowerCase() as DisplayScriptAction } : {}),
    ...(order ? { order: Number.parseInt(order[1]!, 10) } : {}),
    template: out.replace(OUT_ACTION, '').replace(OUT_ORDER, '').replace(/^\n+/, ''),
  };
}

function toDisplayScript(raw: Record<string, unknown>, index: number): DisplayScript | null {
  const source = typeof raw['in'] === 'string' ? raw['in'] : '';
  if (!source) return null;

  const flag = typeof raw['flag'] === 'string' ? raw['flag'] : '';
  const fromFlag = parseFlagField(flag);
  // RisuAI falls back to a plain global match when ableFlag is off, so the letters
  // are only honoured when it is on. The directives are read either way.
  const flags = raw['ableFlag'] === true ? fromFlag.flags : '';

  // RisuAI stores the template with escaped newlines.
  const out = typeof raw['out'] === 'string' ? raw['out'].replaceAll('\\n', '\n') : '';
  const fromOut = parseOutDirectives(out);

  const action = fromFlag.action ?? fromOut.action;
  const order = fromFlag.order ?? fromOut.order ?? index;

  return {
    in: source,
    out: fromOut.template,
    ...(flags ? { flags } : {}),
    order,
    ...(action ? { action } : {}),
    // A pattern this build refuses to run is imported switched off rather than
    // dropped, so the creator can still see it and rewrite it.
    enabled: displayScriptPatternError(source) === null,
  };
}

/** Maps `extensions.risuai.customScripts` onto display scripts. */
export function displayScriptsFromExtensions(
  extensions: Record<string, unknown>,
): DisplayScript[] | undefined {
  const risu = extensions['risuai'];
  if (risu === null || typeof risu !== 'object') return undefined;
  const scripts = (risu as Record<string, unknown>)['customScripts'];
  if (!Array.isArray(scripts)) return undefined;

  const mapped = scripts
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null &&
        typeof entry === 'object' &&
        (entry as Record<string, unknown>)['type'] === 'editdisplay',
    )
    .map(toDisplayScript)
    .filter((script): script is DisplayScript => script !== null);
  return mapped.length > 0 ? mapped : undefined;
}

/** Maps `extensions.risuai.defaultVariables` (a `key=value` block, or an object). */
export function defaultVariablesFromExtensions(
  extensions: Record<string, unknown>,
): Variables | undefined {
  const risu = extensions['risuai'];
  if (risu === null || typeof risu !== 'object') return undefined;
  return parseDefaultVariables((risu as Record<string, unknown>)['defaultVariables']);
}

/**
 * Back to RisuAI's own schema: bare source in `in`, bare template in `out`, and
 * the flags plus the directives in `flag`. The order directive always goes out, so
 * a re-import reproduces the ordering rather than inferring it from position.
 */
function toCustomScript(script: DisplayScript): Record<string, unknown> {
  const flag = [
    script.flags ?? '',
    ...(script.action ? [`<${script.action}>`] : []),
    `<order ${script.order}>`,
  ].join('');
  return {
    comment: '',
    in: script.in,
    out: script.out,
    type: 'editdisplay',
    ableFlag: true,
    flag,
  };
}

/**
 * Writes the two fields back into a copy of the card's extensions. Existing
 * non-`editdisplay` scripts are kept in place; the `editdisplay` ones are replaced
 * wholesale, because the editor owns them once the card is imported. Disabled
 * scripts are dropped: they render nothing, so the exported card behaves the same.
 */
export function extensionsWithCustomUi(
  extensions: Record<string, unknown>,
  displayScripts: DisplayScript[] | undefined,
  defaultVariables: Variables | undefined,
): Record<string, unknown> {
  const enabled = (displayScripts ?? []).filter((script) => script.enabled);
  const hasVariables = defaultVariables && Object.keys(defaultVariables).length > 0;

  const previous = extensions['risuai'];
  const risu: Record<string, unknown> =
    previous !== null && typeof previous === 'object'
      ? { ...(previous as Record<string, unknown>) }
      : {};
  const kept = Array.isArray(risu['customScripts'])
    ? (risu['customScripts'] as unknown[]).filter(
        (entry) =>
          entry === null ||
          typeof entry !== 'object' ||
          (entry as Record<string, unknown>)['type'] !== 'editdisplay',
      )
    : [];

  const customScripts = [...kept, ...enabled.map(toCustomScript)];
  if (customScripts.length > 0) risu['customScripts'] = customScripts;
  else delete risu['customScripts'];
  if (hasVariables) risu['defaultVariables'] = serializeDefaultVariables(defaultVariables);
  else delete risu['defaultVariables'];

  const next = { ...extensions };
  if (Object.keys(risu).length > 0) next['risuai'] = risu;
  else delete next['risuai'];
  return next;
}
