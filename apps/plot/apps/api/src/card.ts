import {
  coerceNarrator,
  COMPONENT_CAPABILITIES,
  DEFAULT_LORE_SETTINGS,
  displayScriptPatternError,
  emptyCard,
  emptyVariables,
  MAX_COMPONENT_CODE_LENGTH,
  MAX_DISPLAY_PATTERN_LENGTH,
  MAX_INTRO_LENGTH,
  type ComponentCapability,
  type DisplayScript,
  type LoreEntry,
  type LoreSelectiveLogic,
  type NormalizedCard,
  type PlotCustomUi,
  type Variables,
} from '@shizue/core';
import { badRequest } from './errors.js';

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;
const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const strArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const SELECTIVE_LOGICS: readonly LoreSelectiveLogic[] = ['and_any', 'and_all', 'not_any', 'not_all'];

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
  };
}

function coerceLoreEntry(value: unknown): LoreEntry {
  const raw = (value ?? {}) as Record<string, unknown>;
  const depth = num(raw['depth'], -1);
  const role = raw['role'];
  return {
    keys: strArray(raw['keys']),
    secondaryKeys: strArray(raw['secondaryKeys']),
    selective: bool(raw['selective'], false),
    content: str(raw['content']),
    enabled: bool(raw['enabled'], true),
    constant: bool(raw['constant'], false),
    insertionOrder: num(raw['insertionOrder'], 0),
    caseSensitive: bool(raw['caseSensitive'], false),
    useRegex: bool(raw['useRegex'], false),
    position: raw['position'] === 'after_char' ? 'after_char' : 'before_char',
    // role only means something on a depth-injected entry.
    ...(depth >= 0
      ? {
          depth: Math.floor(depth),
          ...(role === 'user' || role === 'assistant' || role === 'system' ? { role } : {}),
        }
      : {}),
    ...coerceLoreActivation(raw),
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
  return {
    in: str(raw['in']),
    out: str(raw['out']),
    ...(flags && DISPLAY_SCRIPT_FLAGS.test(flags) ? { flags } : {}),
    order: num(raw['order'], index),
    ...(action === 'move_top' || action === 'move_bottom' || action === 'repeat_back'
      ? { action }
      : {}),
    enabled: bool(raw['enabled'], true),
  };
}

/** What a rejected pattern is called back to the client. */
const PATTERN_REJECTION: Record<string, string> = {
  too_long: `A display script pattern may be at most ${MAX_DISPLAY_PATTERN_LENGTH} characters`,
  invalid: 'A display script pattern must be a valid regular expression',
  unsafe_repetition:
    'A display script pattern may not repeat a group that itself repeats or offers a choice — it would hang the reader',
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
  const defaultVariables = coerceVariables(raw['defaultVariables']);
  const componentCode = coerceComponentCode(raw['componentCode']);
  const componentCapabilities = coerceComponentCapabilities(raw['componentCapabilities']);
  return {
    ...(displayScripts.length > 0 ? { displayScripts } : {}),
    ...(Object.keys(defaultVariables).length > 0 ? { defaultVariables } : {}),
    ...(componentCode ? { componentCode } : {}),
    ...(componentCapabilities.length > 0 ? { componentCapabilities } : {}),
  };
}

/** What the import lifts off a card onto the plot that wraps it. */
export const customUiOfCard = (card: NormalizedCard): PlotCustomUi => ({
  ...(card.displayScripts?.length ? { displayScripts: card.displayScripts } : {}),
  ...(card.defaultVariables && Object.keys(card.defaultVariables).length > 0
    ? { defaultVariables: card.defaultVariables }
    : {}),
  ...(card.componentCode ? { componentCode: card.componentCode } : {}),
  ...(card.componentCapabilities?.length
    ? { componentCapabilities: card.componentCapabilities }
    : {}),
});

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
      tokenBudget: num(lore['tokenBudget'], DEFAULT_LORE_SETTINGS.tokenBudget),
      recursiveScanning: bool(lore['recursiveScanning'], DEFAULT_LORE_SETTINGS.recursiveScanning),
    },
    ...(displayScripts.length > 0 ? { displayScripts } : {}),
    ...(Object.keys(defaultVariables).length > 0 ? { defaultVariables } : {}),
    ...(componentCode ? { componentCode } : {}),
    ...(componentCapabilities.length > 0 ? { componentCapabilities } : {}),
    ...(Object.keys(narrator).length > 0 ? { narrator } : {}),
    extensions:
      raw['extensions'] && typeof raw['extensions'] === 'object' && !Array.isArray(raw['extensions'])
        ? (raw['extensions'] as Record<string, unknown>)
        : {},
    raw: raw['raw'] ?? null,
  };
}
