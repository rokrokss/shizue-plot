import {
  backgroundHtmlOf,
  coerceDisplayDepth,
  coerceDisplayRole,
  coerceNarrator,
  COMPONENT_CAPABILITIES,
  creatorCssFromExtensions,
  DEFAULT_LORE_SETTINGS,
  displayScriptPatternError,
  orderedWithModules,
  emotionModeOf,
  extensionsWithEmotionMode,
  LORE_MATCH_SOURCES,
  LORE_POSITIONS,
  LORE_TRIGGERS,
  emptyCard,
  emptyVariables,
  MAX_BACKGROUND_HTML_LENGTH,
  MAX_COMPONENT_CODE_LENGTH,
  MAX_CREATOR_CSS_LENGTH,
  MAX_DISPLAY_PATTERN_LENGTH,
  MAX_INTRO_LENGTH,
  splitBackground,
  type ComponentCapability,
  type DisplayScript,
  type EmotionImage,
  type EmotionMode,
  type LoreEntry,
  type LoreInsertionStrategy,
  type LoreMatchSource,
  type LorePosition,
  type LoreSelectiveLogic,
  type LoreTrigger,
  type NormalizedCard,
  type PlotCustomUi,
  type Variables,
} from '@shizue/core';
import { badRequest } from './errors.js';
import { isUuid } from './util.js';

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;
const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const strArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const SELECTIVE_LOGICS: readonly LoreSelectiveLogic[] = ['and_any', 'and_all', 'not_any', 'not_all'];

/** `{ [key]: n }` for a number the client sent, rounded into `min`–`max`; nothing otherwise. */
const wholeIn = <K extends string>(value: unknown, min: number, max: number, key: K): Partial<Record<K, number>> =>
  typeof value === 'number' && Number.isFinite(value)
    ? ({ [key]: Math.min(max, Math.max(min, Math.round(value))) } as Partial<Record<K, number>>)
    : {};

/**
 * The advanced activation fields, each only where the client sent one: absent
 * is the default, so nothing here is written out to mean "unchanged". Numbers
 * are rounded and clamped to a range the engine can act on.
 */
function coerceLoreActivation(raw: Record<string, unknown>): Partial<LoreEntry> {
  const int = (key: string, min: number, max: number): Partial<LoreEntry> => {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return {};
    return { [key]: Math.min(max, Math.max(min, Math.round(value))) };
  };
  const logic = raw['selectiveLogic'];
  const group = str(raw['group']).trim();
  return {
    ...(SELECTIVE_LOGICS.includes(logic as LoreSelectiveLogic)
      ? { selectiveLogic: logic as LoreSelectiveLogic }
      : {}),
    ...int('probability', 0, 100),
    ...(group ? { group } : {}),
    ...int('groupWeight', 1, 1000),
    ...int('scanDepth', 0, 1000),
    ...int('sticky', 0, 10_000),
    ...int('cooldown', 0, 10_000),
    ...int('delay', 0, 10_000),
    ...coerceTavernLore(raw),
  };
}

const LORE_INSERTION_STRATEGIES: readonly LoreInsertionStrategy[] = ['evenly', 'character_first', 'global_first'];

/** Names in a character filter: labels, not sentences, and not many. */
const MAX_FILTER_ITEMS = 100;
const MAX_FILTER_ITEM_LENGTH = 200;

/**
 * SillyTavern's per-entry settings (`LoreEntry`), each only where the client sent
 * a meaningful one — an absent flag is ST's default — so an ST entry keeps them
 * through every save, the studio's included.
 */
function coerceTavernLore(raw: Record<string, unknown>): Partial<LoreEntry> {
  const flag = <K extends keyof LoreEntry>(key: K): Partial<LoreEntry> => (raw[key] === true ? { [key]: true } : {});
  const tristate = <K extends keyof LoreEntry>(key: K): Partial<LoreEntry> =>
    typeof raw[key] === 'boolean' ? { [key]: raw[key] } : {};
  const delayed = raw['delayUntilRecursion'];
  const sources = strArray(raw['matchSources']).filter((source): source is LoreMatchSource =>
    LORE_MATCH_SOURCES.includes(source as LoreMatchSource),
  );
  const triggers = strArray(raw['triggers']).filter((trigger): trigger is LoreTrigger =>
    LORE_TRIGGERS.includes(trigger as LoreTrigger),
  );
  const filter = raw['characterFilter'] as Record<string, unknown> | undefined;
  const list = (value: unknown): string[] =>
    strArray(value)
      .map((item) => item.trim().slice(0, MAX_FILTER_ITEM_LENGTH))
      .filter((item) => item.length > 0)
      .slice(0, MAX_FILTER_ITEMS);
  const names = filter && typeof filter === 'object' ? list(filter['names']) : [];
  const tags = filter && typeof filter === 'object' ? list(filter['tags']) : [];
  return {
    ...flag('ignoreBudget'),
    ...flag('preventRecursion'),
    ...flag('excludeRecursion'),
    ...(typeof delayed === 'number' && Number.isFinite(delayed) && delayed >= 1
      ? { delayUntilRecursion: Math.min(1000, Math.floor(delayed)) }
      : {}),
    ...flag('groupOverride'),
    ...tristate('useGroupScoring'),
    ...tristate('matchWholeWords'),
    ...flag('caseSensitiveFromBook'),
    ...(sources.length > 0 ? { matchSources: [...new Set(sources)] } : {}),
    ...(triggers.length > 0 ? { triggers: [...new Set(triggers)] } : {}),
    ...(names.length > 0 || tags.length > 0
      ? {
          characterFilter: {
            ...(names.length > 0 ? { names } : {}),
            ...(tags.length > 0 ? { tags } : {}),
            ...(filter!['exclude'] === true ? { exclude: true as const } : {}),
          },
        }
      : {}),
    ...flag('depthPrompt'),
  };
}

/** An outlet's name — what `{{outlet::name}}` reads — a label rather than a sentence. */
const MAX_OUTLET_NAME_LENGTH = 100;

function coerceLoreEntry(value: unknown): LoreEntry {
  const raw = (value ?? {}) as Record<string, unknown>;
  const depth = num(raw['depth'], -1);
  const role = raw['role'];
  const name = str(raw['name']).trim();
  const position = LORE_POSITIONS.includes(raw['position'] as LorePosition)
    ? (raw['position'] as LorePosition)
    : 'before_char';
  const outletName = str(raw['outletName']).trim().slice(0, MAX_OUTLET_NAME_LENGTH);
  return {
    ...(name ? { name } : {}),
    keys: strArray(raw['keys']),
    secondaryKeys: strArray(raw['secondaryKeys']),
    selective: bool(raw['selective'], false),
    content: str(raw['content']),
    enabled: bool(raw['enabled'], true),
    constant: bool(raw['constant'], false),
    insertionOrder: num(raw['insertionOrder'], 0),
    caseSensitive: bool(raw['caseSensitive'], false),
    useRegex: bool(raw['useRegex'], false),
    position,
    // The name only means something on an outlet.
    ...(position === 'outlet' && outletName ? { outletName } : {}),
    // role only means something on a depth-injected entry.
    ...(depth >= 0
      ? {
          depth: Math.floor(depth),
          ...(role === 'user' || role === 'assistant' || role === 'system' ? { role } : {}),
        }
      : {}),
    ...coerceLoreActivation(raw),
    // Where the entry came from decides whether its scan reads the greeting
    // (`LoreEntry.sillyTavern`), so a save keeps it.
    ...(raw['sillyTavern'] === true ? { sillyTavern: true as const } : {}),
    // SillyTavern's vectorized flag, kept only so an export writes it back (`LoreEntry.vectorized`).
    ...(raw['vectorized'] === true ? { vectorized: true as const } : {}),
  };
}

/** Normalizes a client-supplied lorebook — a character card's, or a plot's. */
export function coerceLorebook(value: unknown): LoreEntry[] {
  return Array.isArray(value) ? value.map(coerceLoreEntry) : [];
}

/** Regex flags a display script may carry; anything else is dropped. */
const DISPLAY_SCRIPT_FLAGS = /^[dgimsuvy]*$/;

function coerceDisplayScript(value: unknown, index: number): DisplayScript {
  const raw = (value ?? {}) as Record<string, unknown>;
  const flags = str(raw['flags']);
  const action = raw['action'];
  const memberId = raw['memberId'];
  return {
    in: str(raw['in']),
    out: str(raw['out']),
    ...(flags && DISPLAY_SCRIPT_FLAGS.test(flags) ? { flags } : {}),
    order: num(raw['order'], index),
    // RisuAI's `<order N>` the import kept (`DisplayScript.rank`), for sorting with modules' scripts.
    ...(typeof raw['rank'] === 'number' && Number.isFinite(raw['rank']) ? { rank: raw['rank'] } : {}),
    ...(action === 'move_top' || action === 'move_bottom' || action === 'repeat_back'
      ? { action }
      : {}),
    enabled: bool(raw['enabled'], true),
    // The member the script is for (`DisplayScript.memberId`). Whether it is one
    // of this plot's is the route's to check, holding the roster.
    ...(typeof memberId === 'string' && isUuid(memberId) ? { memberId: memberId.toLowerCase() } : {}),
    // The messages it runs on, by depth; absent bounds limit nothing.
    ...coerceDisplayDepth(raw),
    // And by who wrote them (SillyTavern's placement); absent, every message.
    ...coerceDisplayRole(raw),
  };
}

/** What a rejected pattern is called back to the client. */
const PATTERN_REJECTION: Record<string, string> = {
  too_long: `A display script pattern may be at most ${MAX_DISPLAY_PATTERN_LENGTH} characters`,
  invalid: 'A display script pattern must be a valid regular expression',
  unsafe_repetition:
    'A display script pattern may not repeat a group whose own repeat is not closed by a character it cannot match, or whose choice is not between plain words none of which starts another — it could hang the reader',
};

/**
 * A script with no pattern renders nothing, so it is not worth storing. A pattern
 * that could hang a reader's tab is refused outright rather than stored and
 * bounded later: the author is right here, and can be told.
 */
function coerceDisplayScripts(value: unknown): DisplayScript[] {
  if (!Array.isArray(value)) return [];
  const scripts = value.map(coerceDisplayScript).filter((script) => script.in.length > 0);
  for (const script of scripts) {
    const rejection = displayScriptPatternError(script.in);
    if (rejection) throw badRequest('invalid_request', PATTERN_REJECTION[rejection]!);
  }
  return scripts;
}

/**
 * Key-value map of strings; every other value shape is dropped. Null-prototype,
 * so a card declaring a `__proto__` default keeps it as a variable instead of
 * having the assignment silently swallowed.
 */
function coerceVariables(value: unknown): Variables {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyVariables();
  const variables = emptyVariables();
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && key.trim()) variables[key.trim()] = entry;
  }
  return variables;
}

/**
 * Component code is stored as written: it runs in a worker inside a sandboxed
 * iframe on an opaque origin, so nothing in it can reach this server or another
 * reader, and screening it here would only reject the Elyn-authored components we
 * want to be able to host. The subset is reported in the editor and enforced where
 * the code runs. Only the size is refused, because the card is jsonb and every
 * reader downloads it.
 */
/** Refused over the cap rather than cut: half a stylesheet is a broken one. */
function coerceCreatorCss(value: unknown): string {
  const css = str(value);
  if (css.length > MAX_CREATOR_CSS_LENGTH) {
    throw badRequest('invalid_request', `css may be at most ${MAX_CREATOR_CSS_LENGTH} characters`);
  }
  return css.trim() ? css : '';
}

/**
 * Each member's stylesheet, by member id, held to the plot stylesheet's cap one
 * by one. Keys that are not member ids and empty sheets are not kept; whether a
 * key is one of this plot's members is the route's to check.
 */
function coerceMemberCss(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const sheets: Record<string, string> = {};
  for (const [memberId, css] of Object.entries(value as Record<string, unknown>)) {
    if (!isUuid(memberId)) continue;
    const sheet = coerceCreatorCss(css);
    if (sheet) sheets[memberId.toLowerCase()] = sheet;
  }
  return sheets;
}

/**
 * The work's background. Kept when it is text, '' included — an emptied field
 * is the creator's word that nothing is drawn, where a plot without the field
 * draws its scripted card's (`PlotCustomUi.backgroundHtml`). Refused over the
 * cap rather than cut, as the stylesheet is.
 */
function coerceBackgroundHtml(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length > MAX_BACKGROUND_HTML_LENGTH) {
    throw badRequest('invalid_request', `backgroundHtml may be at most ${MAX_BACKGROUND_HTML_LENGTH} characters`);
  }
  return value.trim() ? value : '';
}

function coerceComponentCode(value: unknown): string {
  const code = str(value);
  if (code.length > MAX_COMPONENT_CODE_LENGTH) {
    throw badRequest(
      'invalid_request',
      `Component code may be at most ${MAX_COMPONENT_CODE_LENGTH} characters`,
    );
  }
  return code.trim() ? code : '';
}

/**
 * What the card's components may ask the chat for. An unknown name is refused
 * rather than dropped: a creator who misspells a capability would otherwise save a
 * card that silently grants nothing. Order and duplicates come from our own list.
 */
function coerceComponentCapabilities(value: unknown): ComponentCapability[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw badRequest('invalid_request', 'componentCapabilities must be an array');
  }
  for (const entry of value) {
    if (!COMPONENT_CAPABILITIES.includes(entry as ComponentCapability)) {
      throw badRequest('invalid_request', `Unknown component capability: ${String(entry)}`);
    }
  }
  return COMPONENT_CAPABILITIES.filter((capability) => value.includes(capability));
}

/**
 * The reader-facing intro. Refused rather than truncated, the way the component
 * code is: the author is right here, and a silently halved intro is a worse
 * answer than being told it is too long.
 */
function coerceIntro(value: unknown): string {
  const intro = str(value).trim();
  if (intro.length > MAX_INTRO_LENGTH) {
    throw badRequest('invalid_request', `intro may be at most ${MAX_INTRO_LENGTH} characters`);
  }
  return intro;
}

/**
 * The plot's custom UI, normalized on the same whitelists the card's own fields
 * pass through — it is the same four settings, one level up. Every key is
 * optional and an empty one is left out, so a plot that declares nothing stores
 * a config with no keys rather than four empty ones.
 */
export function coerceCustomUi(value: unknown): PlotCustomUi {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const displayScripts = coerceDisplayScripts(raw['displayScripts']);
  const css = coerceCreatorCss(raw['css']);
  const defaultVariables = coerceVariables(raw['defaultVariables']);
  const componentCode = coerceComponentCode(raw['componentCode']);
  const componentCapabilities = coerceComponentCapabilities(raw['componentCapabilities']);
  const memberCss = coerceMemberCss(raw['memberCss']);
  const backgroundHtml = coerceBackgroundHtml(raw['backgroundHtml']);
  return {
    ...(displayScripts.length > 0 ? { displayScripts } : {}),
    ...(css ? { css } : {}),
    ...(Object.keys(defaultVariables).length > 0 ? { defaultVariables } : {}),
    ...(componentCode ? { componentCode } : {}),
    ...(componentCapabilities.length > 0 ? { componentCapabilities } : {}),
    ...(Object.keys(memberCss).length > 0 ? { memberCss } : {}),
    ...(backgroundHtml !== undefined ? { backgroundHtml } : {}),
  };
}

/**
 * A custom UI the creator sent (`coerceCustomUi`, which never takes `modules`)
 * with the modules the plot holds put back: the module routes alone write them,
 * so a studio save neither carries nor clears them. Null stays null only where
 * there are none to keep.
 */
export function withStoredModules(sent: PlotCustomUi | null, stored: PlotCustomUi | null | undefined): PlotCustomUi | null {
  const modules = stored?.modules;
  if (!modules?.length) return sent;
  return { ...(sent ?? {}), modules };
}

/** A plot's custom UI without its modules: what the studio's editors hold and send back. */
export function customUiWithoutModules(customUi: PlotCustomUi | null): PlotCustomUi | null {
  if (!customUi?.modules) return customUi;
  const { modules: _modules, ...rest } = customUi;
  return rest;
}

/**
 * What a reader's chat draws of the work with its modules, as RisuAI stacks a
 * module on the chat: the work's display scripts and then each module's
 * (`customscript.concat(getModuleRegexScripts())`), untagged by member — a
 * module is every member's — and sorted together by RisuAI's `<order N>` once
 * any of them carries one (`orderedWithModules`); the work's stylesheet and
 * then each module's; and the background with each module's after it
 * (`backgroundHTML + '\n' + moduleBackgroundEmbedding`). The reader's own
 * modules join on their page (`GET /api/chats/:id/modules`), the same way.
 */
export function readerCustomUi(
  customUi: PlotCustomUi | null,
  background: string,
): { displayScripts: DisplayScript[]; css: string; backgroundHtml: string } {
  const own = customUi?.displayScripts ?? [];
  const modules = customUi?.modules ?? [];
  return {
    displayScripts: modules.length > 0 ? orderedWithModules(own, modules.map((module) => module.displayScripts ?? [])) : own,
    css: [customUi?.css ?? '', ...modules.map((module) => module.css ?? '')].filter((css) => css.trim()).join('\n\n'),
    backgroundHtml: [background, ...modules.map((module) => module.backgroundHtml ?? '')]
      .filter((html) => html.trim())
      .join('\n'),
  };
}

/**
 * A plot's custom UI held to its roster: a script tagged with, or a stylesheet
 * kept for, a member the plot no longer has is dropped — that member speaks no
 * message, so it would never be drawn — the way the member's removal drops them
 * (`withoutMember`).
 */
export function customUiOfRoster(customUi: PlotCustomUi, memberIds: ReadonlySet<string>): PlotCustomUi {
  const { displayScripts, memberCss, ...rest } = customUi;
  const scripts = (displayScripts ?? []).filter((script) => script.memberId === undefined || memberIds.has(script.memberId));
  const sheets = Object.fromEntries(Object.entries(memberCss ?? {}).filter(([memberId]) => memberIds.has(memberId)));
  return {
    ...rest,
    ...(scripts.length > 0 ? { displayScripts: scripts } : {}),
    ...(Object.keys(sheets).length > 0 ? { memberCss: sheets } : {}),
  };
}

/** A plot's custom UI without what came with one member: its tagged scripts and its stylesheet. */
export const withoutMember = (customUi: PlotCustomUi, memberId: string): PlotCustomUi => {
  const { displayScripts, memberCss, ...rest } = customUi;
  const scripts = (displayScripts ?? []).filter((script) => script.memberId !== memberId);
  const { [memberId]: _gone, ...sheets } = memberCss ?? {};
  return {
    ...rest,
    ...(scripts.length > 0 ? { displayScripts: scripts } : {}),
    ...(Object.keys(sheets).length > 0 ? { memberCss: sheets } : {}),
  };
};

/**
 * What the import lifts off a card onto the plot that wraps it. The stylesheet is
 * read straight off the card's RisuAI extension rather than carried on the card:
 * the extension already travels with it, so the card round-trips as it came. So
 * is the rest of its `backgroundHTML`, which becomes the work's background — all
 * of it, `<style>` included, where the card's scripts or its CBS would change
 * the styles, as RisuAI's background pass does (`splitBackground`).
 * `memberId` is the member the card becomes, whose own its display scripts are
 * (`DisplayScript.memberId`): in a work of several they dress its messages and
 * the ones no member speaks.
 */
export function customUiOfCard(card: NormalizedCard, memberId: string): PlotCustomUi {
  const { css, background: backgroundHtml } = splitBackground(backgroundHtmlOf(card.extensions), card.displayScripts);
  return {
    ...(card.displayScripts?.length
      ? { displayScripts: card.displayScripts.map((script) => ({ ...script, memberId })) }
      : {}),
    ...(css ? { css } : {}),
    ...(backgroundHtml ? { backgroundHtml } : {}),
    ...(card.defaultVariables && Object.keys(card.defaultVariables).length > 0
      ? { defaultVariables: card.defaultVariables }
      : {}),
    ...(card.componentCode ? { componentCode: card.componentCode } : {}),
    ...(card.componentCapabilities?.length
      ? { componentCapabilities: card.componentCapabilities }
      : {}),
  };
}

/**
 * What a companion's card brings to the work it joins (`/characters/import`):
 * its display scripts, tagged as its own (`DisplayScript.memberId`) and run after
 * the work's; its stylesheet, as its own (`memberCss`); and its default
 * variables, merged into the one namespace the work's members share — a name the
 * work already has keeps its value. `conflicts` are the names whose values
 * differ, for the studio to say so.
 */
export function liftCompanion(
  customUi: PlotCustomUi,
  card: NormalizedCard,
  memberId: string,
): { customUi: PlotCustomUi; conflicts: string[] } {
  const scripts = customUi.displayScripts ?? [];
  const after = scripts.reduce((last, script) => Math.max(last, script.order), -1) + 1;
  const added = (card.displayScripts ?? []).map((script, index) => ({ ...script, order: after + index, memberId }));
  const css = creatorCssFromExtensions(card.extensions);
  const variables = emptyVariables();
  Object.assign(variables, customUi.defaultVariables ?? {});
  const conflicts: string[] = [];
  for (const [name, value] of Object.entries(card.defaultVariables ?? {})) {
    if (!Object.hasOwn(variables, name)) variables[name] = value;
    else if (variables[name] !== value) conflicts.push(name);
  }
  return {
    customUi: {
      ...customUi,
      ...(added.length > 0 ? { displayScripts: [...scripts, ...added] } : {}),
      ...(css ? { memberCss: { ...(customUi.memberCss ?? {}), [memberId]: css } } : {}),
      ...(Object.keys(variables).length > 0 ? { defaultVariables: variables } : {}),
    },
    conflicts,
  };
}

/** As many emotion pictures as a plot holds images (`MAX_ASSETS_PER_PLOT`). */
const MAX_EMOTION_IMAGES = 1000;

/**
 * The card's emotion pictures as the client sent them back: the import wrote
 * them (`NormalizedCard.emotionImages`) and the studio only carries them, so
 * this keeps what has the shape and drops what does not.
 */
function coerceEmotionImages(value: unknown): EmotionImage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is EmotionImage =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>)['name'] === 'string' &&
        typeof (entry as Record<string, unknown>)['slug'] === 'string' &&
        (entry as Record<string, unknown>)['slug'] !== '',
    )
    .slice(0, MAX_EMOTION_IMAGES)
    .map(({ name, slug }) => ({ name, slug }));
}

/**
 * Normalizes a client-supplied card (already in NormalizedCard shape) so that a
 * malformed field can never break prompt assembly later.
 */
export function coerceCard(value: unknown, fallbackName: string): NormalizedCard {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return emptyCard(fallbackName);
  }
  const raw = value as Record<string, unknown>;
  const spec = raw['spec'];
  const lore = (raw['loreSettings'] ?? {}) as Record<string, unknown>;
  const tokenBudget = lore['tokenBudget'];
  const nickname = raw['nickname'];
  // Absent rather than empty when unused: an untouched card has to export
  // byte-identical to what was imported, and a materialized empty field would
  // show up in that output.
  const displayScripts = coerceDisplayScripts(raw['displayScripts']);
  const defaultVariables = coerceVariables(raw['defaultVariables']);
  const componentCode = coerceComponentCode(raw['componentCode']);
  const componentCapabilities = coerceComponentCapabilities(raw['componentCapabilities']);
  const narrator = coerceNarrator(raw['narrator']);
  const intro = coerceIntro(raw['intro']);
  const groupOnlyGreetings = strArray(raw['groupOnlyGreetings']);
  const emotionImages = coerceEmotionImages(raw['emotionImages']);

  return {
    spec: spec === 'v1' || spec === 'v2' ? spec : 'v3',
    name: str(raw['name'], fallbackName),
    ...(typeof nickname === 'string' && nickname ? { nickname } : {}),
    ...(intro ? { intro } : {}),
    description: str(raw['description']),
    personality: str(raw['personality']),
    scenario: str(raw['scenario']),
    firstMes: str(raw['firstMes']),
    alternateGreetings: strArray(raw['alternateGreetings']),
    ...(groupOnlyGreetings.length > 0 ? { groupOnlyGreetings } : {}),
    mesExample: str(raw['mesExample']),
    systemPrompt: str(raw['systemPrompt']),
    postHistoryInstructions: str(raw['postHistoryInstructions']),
    creatorNotes: str(raw['creatorNotes']),
    tags: strArray(raw['tags']),
    creator: str(raw['creator']),
    characterVersion: str(raw['characterVersion']),
    lorebook: coerceLorebook(raw['lorebook']),
    loreSettings: {
      scanDepth: num(lore['scanDepth'], DEFAULT_LORE_SETTINGS.scanDepth),
      // Absent is the automatic budget, so only a number the client sent is kept.
      ...(typeof tokenBudget === 'number' && Number.isFinite(tokenBudget) ? { tokenBudget } : {}),
      ...wholeIn(lore['budgetPercent'], 1, 100, 'budgetPercent'),
      recursiveScanning: bool(lore['recursiveScanning'], DEFAULT_LORE_SETTINGS.recursiveScanning),
      ...wholeIn(lore['maxRecursionSteps'], 1, 1000, 'maxRecursionSteps'),
      ...(lore['risuMatching'] === true ? { risuMatching: true } : {}),
      // SillyTavern's global World Info settings, which a book that runs as ST's reads.
      ...wholeIn(lore['budgetCap'], 1, 1_000_000, 'budgetCap'),
      ...wholeIn(lore['minActivations'], 1, 1000, 'minActivations'),
      ...wholeIn(lore['minActivationsDepthMax'], 1, 1000, 'minActivationsDepthMax'),
      ...(typeof lore['caseSensitive'] === 'boolean' ? { caseSensitive: lore['caseSensitive'] } : {}),
      ...(typeof lore['matchWholeWords'] === 'boolean' ? { matchWholeWords: lore['matchWholeWords'] } : {}),
      ...(typeof lore['useGroupScoring'] === 'boolean' ? { useGroupScoring: lore['useGroupScoring'] } : {}),
      ...(typeof lore['includeNames'] === 'boolean' ? { includeNames: lore['includeNames'] } : {}),
      ...(LORE_INSERTION_STRATEGIES.includes(lore['insertionStrategy'] as LoreInsertionStrategy)
        ? { insertionStrategy: lore['insertionStrategy'] as LoreInsertionStrategy }
        : {}),
    },
    ...(displayScripts.length > 0 ? { displayScripts } : {}),
    ...(Object.keys(defaultVariables).length > 0 ? { defaultVariables } : {}),
    ...(componentCode ? { componentCode } : {}),
    ...(componentCapabilities.length > 0 ? { componentCapabilities } : {}),
    ...(Object.keys(narrator).length > 0 ? { narrator } : {}),
    ...(emotionImages.length > 0 ? { emotionImages } : {}),
    extensions:
      raw['extensions'] && typeof raw['extensions'] === 'object' && !Array.isArray(raw['extensions'])
        ? (raw['extensions'] as Record<string, unknown>)
        : {},
    raw: raw['raw'] ?? null,
  };
}

/**
 * Every field a card has: the keys `mergeCard` may take from a sent card. Typed
 * against the card, so a field added there has to be named here.
 */
const CARD_FIELDS = Object.keys({
  spec: true,
  name: true,
  nickname: true,
  intro: true,
  description: true,
  personality: true,
  scenario: true,
  firstMes: true,
  alternateGreetings: true,
  groupOnlyGreetings: true,
  mesExample: true,
  systemPrompt: true,
  postHistoryInstructions: true,
  creatorNotes: true,
  tags: true,
  creator: true,
  characterVersion: true,
  lorebook: true,
  loreSettings: true,
  displayScripts: true,
  defaultVariables: true,
  componentCode: true,
  componentCapabilities: true,
  narrator: true,
  emotionImages: true,
  extensions: true,
  raw: true,
} satisfies Record<keyof NormalizedCard, true>);

/**
 * A member's card with the fields the client sent laid over the stored one
 * (`PATCH /:id/characters/:characterId`). Each sent field passes `coerceCard`
 * as it would in a whole card, and one it leaves out — an emptied intro — is
 * taken off. A field not sent is the stored one as it was, so a save need not
 * carry the original card (`raw`, `extensions`) back.
 */
export function mergeCard(stored: NormalizedCard, sent: unknown, fallbackName: string): NormalizedCard {
  if (sent === null || typeof sent !== 'object' || Array.isArray(sent)) {
    throw badRequest('invalid_request', 'card must be an object');
  }
  const coerced: Record<string, unknown> = { ...coerceCard(sent, fallbackName) };
  const merged: Record<string, unknown> = { ...stored };
  for (const key of CARD_FIELDS) {
    if (!Object.hasOwn(sent, key)) continue;
    if (Object.hasOwn(coerced, key)) merged[key] = coerced[key];
    else delete merged[key];
  }
  return merged as unknown as NormalizedCard;
}

/**
 * The two RisuAI settings the studio sets on a member — its emotion screen and
 * its utility-bot switch — written into the card's extensions where RisuAI keeps
 * them. They travel as values rather than as `extensions.risuai`, which also
 * holds the card's scripts and triggers. A value the card already has changes
 * nothing: setting the emotion mode drops `newGenData`, as RisuAI's switch does,
 * and only a switch should.
 */
export function extensionsWithSettings(
  extensions: Record<string, unknown>,
  { emotionMode, utilityBot }: { emotionMode?: EmotionMode | null; utilityBot?: boolean },
): Record<string, unknown> {
  let next = extensions;
  if (emotionMode !== undefined && emotionMode !== emotionModeOf({ extensions })) {
    next = extensionsWithEmotionMode(next, emotionMode);
  }
  const held = next['risuai'];
  const risu = held !== null && typeof held === 'object' && !Array.isArray(held) ? (held as Record<string, unknown>) : {};
  if (utilityBot !== undefined && (risu['utilityBot'] === true) !== utilityBot) {
    next = { ...next, risuai: { ...risu, utilityBot } };
  }
  return next;
}
