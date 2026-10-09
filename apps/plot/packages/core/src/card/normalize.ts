import { CCardLib, type CharacterCardV3, type LorebookEntry } from '@risuai/ccardlib';
import {
  DEFAULT_LORE_SETTINGS,
  type CardSpec,
  type LoreEntry,
  type LorePosition,
  type LoreRole,
  type NormalizedCard,
} from '../types.js';
import { componentCapabilitiesFromExtensions, componentCodeFromExtensions } from './componentCode.js';
import { introFromExtensions } from './intro.js';
import { narratorFromExtensions } from './narrator.js';
import { defaultVariablesFromExtensions, displayScriptsFromExtensions } from './risu.js';

export class CardParseError extends Error {}

/** The V3 decorator subset this implementation understands. */
export interface LoreDecorators {
  constant?: boolean;
  depth?: number;
  role?: LoreRole;
  position?: LorePosition;
}

/** `@@name arg`. `@@@name` (a fallback decorator) does not match and is stripped. */
const DECORATOR_LINE = /^@@([a-z_]+)(?:[ \t]+(.*))?$/;

/**
 * Splits the leading `@@`-prefixed decorator lines of a V3 lorebook entry off its
 * content and interprets the supported subset. Unsupported decorators are
 * stripped without effect, per spec.
 */
export function parseDecorators(content: string): { decorators: LoreDecorators; body: string } {
  const lines = content.split('\n');
  const decorators: LoreDecorators = {};
  let start = 0;
  for (; start < lines.length; start += 1) {
    const line = lines[start]!.trim();
    if (!line.startsWith('@@')) break;
    const match = DECORATOR_LINE.exec(line);
    if (!match) continue;
    const arg = (match[2] ?? '').trim().toLowerCase();
    switch (match[1]) {
      case 'constant':
        decorators.constant = true;
        break;
      case 'depth': {
        const depth = Number.parseInt(arg, 10);
        if (Number.isFinite(depth) && depth >= 0) decorators.depth = depth;
        break;
      }
      case 'role':
        if (arg === 'user' || arg === 'assistant' || arg === 'system') decorators.role = arg;
        break;
      case 'position':
        if (arg === 'before_desc') decorators.position = 'before_char';
        else if (arg === 'after_desc') decorators.position = 'after_char';
        break;
      default:
        break;
    }
  }
  return { decorators, body: lines.slice(start).join('\n') };
}

function toLoreEntry(entry: LorebookEntry): LoreEntry {
  const { decorators, body } = parseDecorators(entry.content ?? '');
  // Per spec, `@@position` takes precedence over `@@depth`.
  const depth = decorators.position === undefined ? decorators.depth : undefined;
  return {
    keys: entry.keys ?? [],
    secondaryKeys: entry.secondary_keys ?? [],
    selective: entry.selective ?? false,
    content: body,
    enabled: entry.enabled ?? true,
    constant: decorators.constant ?? entry.constant ?? false,
    insertionOrder: entry.insertion_order ?? 0,
    caseSensitive: entry.case_sensitive ?? false,
    useRegex: entry.use_regex ?? false,
    position:
      decorators.position ?? (entry.position === 'after_char' ? 'after_char' : 'before_char'),
    ...(depth === undefined ? {} : { depth }),
    ...(depth !== undefined && decorators.role ? { role: decorators.role } : {}),
  };
}

/**
 * Detects the card spec and normalizes it. V1/V2 are lifted to V3 by ccardlib
 * first, so there is a single mapping path.
 */
export function normalizeCard(raw: unknown): NormalizedCard {
  if (raw === null || typeof raw !== 'object') {
    throw new CardParseError('Card must be a JSON object');
  }

  const spec = CCardLib.character.check(raw);
  if (spec === 'unknown') {
    throw new CardParseError('Unrecognized character card format');
  }

  const v3 =
    spec === 'v3'
      ? (raw as CharacterCardV3)
      : CCardLib.character.convert(raw as never, { to: 'v3' });
  const data = v3.data;
  const book = data.character_book;
  const extensions = data.extensions ?? {};
  const displayScripts = displayScriptsFromExtensions(extensions);
  const defaultVariables = defaultVariablesFromExtensions(extensions);
  const componentCode = componentCodeFromExtensions(extensions);
  const componentCapabilities = componentCapabilitiesFromExtensions(extensions);
  // Only our own cards carry one, so an imported stranger's card simply has none.
  const narrator = narratorFromExtensions(extensions);
  const intro = introFromExtensions(extensions);

  return {
    spec: spec as CardSpec,
    name: data.name ?? '',
    ...(data.nickname ? { nickname: data.nickname } : {}),
    ...(intro ? { intro } : {}),
    description: data.description ?? '',
    personality: data.personality ?? '',
    scenario: data.scenario ?? '',
    firstMes: data.first_mes ?? '',
    alternateGreetings: data.alternate_greetings ?? [],
    mesExample: data.mes_example ?? '',
    systemPrompt: data.system_prompt ?? '',
    postHistoryInstructions: data.post_history_instructions ?? '',
    creatorNotes: data.creator_notes ?? '',
    tags: data.tags ?? [],
    creator: data.creator ?? '',
    characterVersion: data.character_version ?? '',
    lorebook: (book?.entries ?? []).map(toLoreEntry),
    loreSettings: {
      scanDepth: book?.scan_depth ?? DEFAULT_LORE_SETTINGS.scanDepth,
      tokenBudget: book?.token_budget ?? DEFAULT_LORE_SETTINGS.tokenBudget,
      recursiveScanning: book?.recursive_scanning ?? DEFAULT_LORE_SETTINGS.recursiveScanning,
    },
    ...(displayScripts ? { displayScripts } : {}),
    ...(defaultVariables ? { defaultVariables } : {}),
    ...(componentCode ? { componentCode } : {}),
    ...(componentCapabilities ? { componentCapabilities } : {}),
    ...(narrator ? { narrator } : {}),
    extensions,
    raw,
  };
}

/** Empty card used when a character is created without an import. */
export function emptyCard(name: string): NormalizedCard {
  return {
    spec: 'v3',
    name,
    description: '',
    personality: '',
    scenario: '',
    firstMes: '',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    tags: [],
    creator: '',
    characterVersion: '',
    lorebook: [],
    loreSettings: { ...DEFAULT_LORE_SETTINGS },
    extensions: {},
    raw: null,
  };
}
