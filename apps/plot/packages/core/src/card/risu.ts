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
 * and `ableFlag` says whether that field is read at all. Older cards spell the
 * actions `@@move_top` at the head of `out`, so both forms are read.
 *
 * `<order N>` does not mean what our `order` means. RisuAI runs the highest first,
 * and only once some script on the list carries one — until then the list runs as
 * it stands. Ours runs the lowest first, always. So the numbers are not carried
 * across in either direction: an import numbers the scripts in the sequence RisuAI
 * would run them, and an export writes them out in the sequence they run here.
 */

import { displayScriptPatternError } from '../displayScript.js';
import { ASSET_ADDRESS_MACRO, linearMatches } from './externalAssets.js';
import { compiledScriptFlags, parseScriptFlag } from '../promptScripts.js';
import { parseDefaultVariables, serializeDefaultVariables, type Variables } from '../variables.js';
import type { DisplayScript, DisplayScriptAction } from '../types.js';

/** `@@move_top` — the same directives as older cards write them, inside `out`. */
const OUT_ACTION = /@@(move_top|move_bottom|repeat_back)\b/i;
/**
 * `<order 3>` written into `out` rather than into `flag`. RisuAI never reads it
 * there, so it orders nothing; it is only taken out of the template.
 */
const OUT_ORDER = /<order[ \t]+(-?\d+)>/i;

/**
 * The actions a script can take, in the precedence RisuAI gives them: on a match
 * it moves to the top if anything said `move_top`, else to the bottom if anything
 * said `move_bottom`; `repeat_back` only acts when there is no match at all. A
 * script here takes one action, so a script that names a move and `repeat_back`
 * keeps the move.
 *
 * The flag field's directives and the flags RisuAI compiles are read by the
 * rules the prompt's `editprocess` scripts share (`parseScriptFlag`,
 * `compiledScriptFlags` in `promptScripts.ts`).
 */
const ACTIONS: readonly DisplayScriptAction[] = ['move_top', 'move_bottom', 'repeat_back'];

/** Reads the action an older card puts in `out`, and returns the template without its directives. */
function parseOutDirectives(out: string): { action?: DisplayScriptAction; template: string } {
  const action = OUT_ACTION.exec(out);
  return {
    ...(action ? { action: action[1]!.toLowerCase() as DisplayScriptAction } : {}),
    template: out.replace(OUT_ACTION, '').replace(OUT_ORDER, '').replace(/^\n+/, ''),
  };
}

/** A script before its place in the run is known, with the `<order N>` RisuAI would read. */
interface Unplaced {
  script: Omit<DisplayScript, 'order'>;
  rank: number | undefined;
}

function toDisplayScript(raw: Record<string, unknown>): Unplaced | null {
  const source = typeof raw['in'] === 'string' ? raw['in'] : '';
  if (!source) return null;

  // RisuAI reads the flag field only when ableFlag is on. Off, the script is a
  // plain global match, and a directive in the field is as dead as the letters
  // around it: the creator saw it render in place, in list order.
  const flag = typeof raw['flag'] === 'string' ? raw['flag'] : '';
  const fromFlag = parseScriptFlag(raw['ableFlag'] === true ? flag : '');

  // RisuAI stores the template with escaped newlines.
  const out = typeof raw['out'] === 'string' ? raw['out'].replaceAll('\\n', '\n') : '';
  const fromOut = parseOutDirectives(out);

  // Either place may name an action; RisuAI acts on what either says.
  const named: string[] = [...fromFlag.actions, ...(fromOut.action ? [fromOut.action] : [])];
  const action = ACTIONS.find((candidate) => named.includes(candidate));
  // An `@@move_top` in `out` takes the `g` away even with ableFlag off.
  const flags = compiledScriptFlags(fromFlag.rest, action === 'move_top' || action === 'move_bottom');

  return {
    script: {
      in: source,
      out: fromOut.template,
      ...(flags ? { flags } : {}),
      ...(action ? { action } : {}),
      // A pattern this build refuses to run is imported switched off rather than
      // dropped, so the creator can still see it and rewrite it.
      enabled: displayScriptPatternError(source) === null,
    },
    rank: fromFlag.order,
  };
}

/**
 * Maps `extensions.risuai.customScripts` onto display scripts, in the sequence
 * RisuAI runs them and numbered in it.
 *
 * RisuAI leaves the list as it stands until one script carries `<order N>`. From
 * then on it sorts the whole list by that number, highest first, a script without
 * one counting as 0 and a tie keeping its place. Handing those numbers to our
 * lowest-first sort would run an ordered card backwards, so the scripts are put in
 * RisuAI's sequence and numbered 0, 1, 2… down it — what the editor then shows.
 *
 * Only the `editdisplay` entries are looked at, though RisuAI sorts every type
 * together: the sort is stable, so the others cannot change where these fall
 * relative to each other.
 */
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
    .filter((entry): entry is Unplaced => entry !== null);
  if (mapped.some((entry) => entry.rank !== undefined)) {
    mapped.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  }
  // The rank stays beside the sequence: RisuAI sorts the card's scripts and its
  // modules' as one list (`orderedWithModules`). `order x` is NaN there, a tie.
  return mapped.length > 0
    ? mapped.map(({ script, rank }, order) => ({
        ...script,
        order,
        ...(rank !== undefined ? { rank: Number.isFinite(rank) ? rank : 0 } : {}),
      }))
    : undefined;
}

/**
 * Longest stylesheet a plot may carry. Most RisuAI cards' run to a few tens of
 * kilobytes; RisuRealm's largest run to about 260,000 characters (당나라 무협,
 * 도시 연대기 at 180,000), and a card's stylesheet is dropped whole when it is
 * over. The web fonts an import localizes land here too (`localizeAssets.ts`):
 * a Korean family is hundreds of `@font-face` slices — 당나라 무협's Noto Serif
 * KR and SC at three weights are a 626,000-character sheet on top of its own.
 * So the cap leaves room for both and then some; the sheet is sanitized once per
 * chat page, not per message.
 */
export const MAX_CREATOR_CSS_LENGTH = 1_500_000;

/**
 * Longest background a plot may draw behind its chats, past its `<style>`
 * elements (which are the stylesheet's, `MAX_CREATOR_CSS_LENGTH`). RisuAI holds
 * `backgroundHTML` to nothing, and a card's background over the cap is dropped
 * whole; the largest Realm's run to about 260,000 characters.
 */
export const MAX_BACKGROUND_HTML_LENGTH = 400_000;

/** A complete `<style>` element and its body. */
const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/**
 * The stylesheet a RisuAI card dresses its display scripts' markup in.
 *
 * RisuAI keeps it in `extensions.risuai.backgroundHTML`, HTML it injects behind
 * the whole chat. Only the `<style>` elements in it mean anything here: the
 * classes a display script's `out` writes are styled there, and a status window
 * without them is a column of bare text. Anything else in that HTML — a
 * decorative background, a script — is not taken. The extension itself is left
 * as it is, so the card still round-trips. Undefined when there is no stylesheet,
 * or one longer than this build will carry.
 */
export function creatorCssFromExtensions(extensions: Record<string, unknown>): string | undefined {
  const css = stylesheetOf(extensions);
  return css && css.length <= MAX_CREATOR_CSS_LENGTH ? css : undefined;
}

/** Whether a card has a stylesheet that `creatorCssFromExtensions` leaves behind for its length. */
export const creatorCssOverCap = (extensions: Record<string, unknown>): boolean =>
  (stylesheetOf(extensions)?.length ?? 0) > MAX_CREATOR_CSS_LENGTH;

/** The `<style>` bodies of a card's `backgroundHTML`, joined, whatever their length. */
function stylesheetOf(extensions: Record<string, unknown>): string | undefined {
  const risu = extensions['risuai'];
  if (risu === null || typeof risu !== 'object') return undefined;
  const html = (risu as Record<string, unknown>)['backgroundHTML'];
  if (typeof html !== 'string') return undefined;
  return [...html.matchAll(STYLE_ELEMENT)]
    .map((element) => element[1]!.trim())
    .filter((body) => body.length > 0)
    .join('\n\n');
}

/**
 * RisuAI's `backgroundHTML` as the card carries it: HTML RisuAI parses as CBS and
 * draws behind the whole chat. Undefined when there is none, or only whitespace.
 */
export function backgroundHtmlOf(extensions: Record<string, unknown>): string | undefined {
  const risu = extensions['risuai'];
  if (risu === null || typeof risu !== 'object') return undefined;
  const html = (risu as Record<string, unknown>)['backgroundHTML'];
  return typeof html === 'string' && html.trim() ? html : undefined;
}

/**
 * A card's background HTML without its `<style>` elements: what is left to draw
 * behind the chat once the stylesheet is the plot's (`creatorCssFromExtensions`,
 * which the creator may have edited since). Empty when it was all stylesheet.
 */
export const backgroundWithoutStyles = (html: string): string => html.replace(STYLE_ELEMENT, '').trim();

/**
 * Whether a background's `<style>` elements are its background pass's rather
 * than a stylesheet. RisuAI draws `backgroundHTML` whole through
 * `ParseMarkdown(…, 'back')` — its CBS, then the `editdisplay` scripts —
 * `<style>` and all, and a card may leave placeholders in its sheet for its own
 * scripts to fill: Renka's `border: 3px solid {border}`, which a script turns
 * into a colour. A stylesheet here is drawn as written, so a `<style>` either
 * would change belongs where they run: one with CBS in it other than an asset
 * address (`ASSET_ADDRESS_MACRO`, which the import resolves in a stylesheet once
 * the assets are stored), or one an enabled script's pattern matches some of. The patterns run
 * on the linear engine (`linearMatches`); one it cannot compile is passed over.
 */
export function stylesAreScripted(html: string, scripts: readonly DisplayScript[] | undefined): boolean {
  const styles = [...html.matchAll(STYLE_ELEMENT)].map((element) => element[0]);
  if (styles.some((style) => style.replace(ASSET_ADDRESS_MACRO, '').includes('{{'))) return true;
  const live = (scripts ?? []).filter((script) => script.enabled && script.in);
  return styles.some((style) => live.some((script) => linearMatches(script.in, script.flags ?? '', style) === true));
}

/** A RisuAI background as the import keeps it (`splitBackground`). */
export interface SplitBackground {
  /** The `<style>` bodies, the work's stylesheet. */
  css?: string;
  /** What is drawn behind the chat. */
  background?: string;
}

/**
 * A RisuAI background as the import keeps it: its `<style>` elements lifted
 * into the stylesheet and the rest drawn behind the chat — or, where the styles
 * are the background pass's (`stylesAreScripted`), the whole of it behind the
 * chat, `<style>` and all, as RisuAI draws it, so the same scripts fill the
 * same placeholders in the same order. All of them stay together then, so the
 * sheet's rules keep their order. Each part is left out past its cap
 * (`MAX_CREATOR_CSS_LENGTH`, `MAX_BACKGROUND_HTML_LENGTH`); a whole past the
 * background's is split all the same, which keeps at least the sheet's other rules.
 */
export function splitBackground(html: string | undefined, scripts?: readonly DisplayScript[]): SplitBackground {
  const whole = html?.trim() ?? '';
  if (!whole) return {};
  const styles = [...whole.matchAll(STYLE_ELEMENT)];
  if (styles.length > 0 && whole.length <= MAX_BACKGROUND_HTML_LENGTH && stylesAreScripted(whole, scripts)) {
    return { background: whole };
  }
  const css = styles
    .map((element) => element[1]!.trim())
    .filter((body) => body.length > 0)
    .join('\n\n');
  const shown = backgroundWithoutStyles(whole);
  return {
    ...(css && css.length <= MAX_CREATOR_CSS_LENGTH ? { css } : {}),
    ...(shown && shown.length <= MAX_BACKGROUND_HTML_LENGTH ? { background: shown } : {}),
  };
}

/**
 * The license a RisuAI card declares in `extensions.risuai.license` — `CC BY-NC 4.0`,
 * `private` and the like, as RisuRealm writes them. Undefined when the card says
 * nothing, which Realm stores as an empty string.
 */
export function cardLicense(extensions: Record<string, unknown>): string | undefined {
  const risu = extensions['risuai'];
  if (risu === null || typeof risu !== 'object') return undefined;
  const license = (risu as Record<string, unknown>)['license'];
  return typeof license === 'string' && license.trim() ? license.trim() : undefined;
}

/**
 * Whether a RisuAI card is a utility bot (`extensions.risuai.utilityBot`, the
 * character setting RisuAI's help calls "a bot made for utility, not for
 * roleplay"). RisuAI's `sendChat` then builds the request from a fixed template
 * of the card's own parts — description, lore, chat, the card's global-note
 * replacement and what goes after everything — and none of the reader's main
 * prompt, jailbreak, global note, persona or author's note; the assembler does
 * the same with its own (`assemblePrompt`). The flag rides in the extensions,
 * which the card keeps verbatim, so it round-trips with no field of ours.
 */
export function isUtilityBot(extensions: Record<string, unknown> | undefined): boolean {
  const risu = extensions?.['risuai'];
  return risu !== null && typeof risu === 'object' && (risu as Record<string, unknown>)['utilityBot'] === true;
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
 * the flags plus the action in `flag`. Our `order` does not go out — the caller
 * writes the scripts in the sequence they run here, which is the sequence RisuAI
 * runs a list without a directive in, and a re-import reads them back the same
 * way; our numbers would run backwards there, and the editor's need not even be
 * whole. RisuAI's own `<order N>` the import kept (`rank`) goes back where the
 * caller says it still agrees with that sequence (`ranked`), so a module's
 * scripts sort among the card's there as they did before. The range
 * (`minDepth`/`maxDepth`) does not go out: RisuAI's scripts have no such field,
 * so an exported script runs on every message there.
 */
function toCustomScript(script: DisplayScript, ranked: boolean): Record<string, unknown> {
  const flag = [
    script.flags ?? '',
    ...(script.action ? [`<${script.action}>`] : []),
    ...(ranked && script.rank !== undefined ? [`<order ${script.rank}>`] : []),
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
 * wholesale, because the editor owns them once the card is imported, and go out
 * in the sequence they run here — `order`, ties in list order. Disabled scripts
 * are dropped: they render nothing, so the exported card behaves the same.
 */
export function extensionsWithCustomUi(
  extensions: Record<string, unknown>,
  displayScripts: DisplayScript[] | undefined,
  defaultVariables: Variables | undefined,
): Record<string, unknown> {
  const enabled = (displayScripts ?? [])
    .filter((script) => script.enabled)
    .sort((a, b) => a.order - b.order);
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

  // The ranks go back only where RisuAI's sort by them, highest first and stable,
  // runs the scripts in the sequence they run here — none, once the creator moved one.
  const ranked =
    enabled.some((script) => script.rank !== undefined) &&
    enabled.every((script, at) => at === 0 || (enabled[at - 1]!.rank ?? 0) >= (script.rank ?? 0));
  const customScripts = [...kept, ...enabled.map((script) => toCustomScript(script, ranked))];
  if (customScripts.length > 0) risu['customScripts'] = customScripts;
  else delete risu['customScripts'];
  if (hasVariables) risu['defaultVariables'] = serializeDefaultVariables(defaultVariables);
  else delete risu['defaultVariables'];

  const next = { ...extensions };
  if (Object.keys(risu).length > 0) next['risuai'] = risu;
  else delete next['risuai'];
  return next;
}
