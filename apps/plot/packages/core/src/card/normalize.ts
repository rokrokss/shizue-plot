import { CCardLib, type CharacterCardV3 } from '@risuai/ccardlib';
import { DEFAULT_LORE_SETTINGS, type CardSpec, type NormalizedCard } from '../types.js';
import { loreEntryFromBook } from './bookEntry.js';
import { componentCapabilitiesFromExtensions, componentCodeFromExtensions } from './componentCode.js';
import { introFromExtensions } from './intro.js';
import { narratorFromExtensions } from './narrator.js';
import { defaultVariablesFromExtensions, displayScriptsFromExtensions } from './risu.js';
import {
  depthPromptEntry,
  displayScriptsWithRegexScripts,
  extensionsWithoutDepthPrompt,
} from './sillyTavern.js';

export { parseDecorators, type LoreDecorators } from './bookEntry.js';

export class CardParseError extends Error {}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * SillyTavern's cards fail ccardlib's V2/V3 schema as ST writes them: its `ccv3`
 * PNG chunk is its V2 JSON with the spec relabelled, so there is no
 * `group_only_greetings`, and a lorebook ST built itself has no book-level
 * `extensions`. Worse than refused, such a card passes as V1 — ST repeats the V1
 * fields at the top — and everything under `data` would be lost. The two gaps are
 * filled in on a copy, so `raw` stays what arrived; a card without them is
 * returned as is.
 */
function withSillyTavernGaps(raw: object): object {
  const card = raw as Json;
  const spec = card['spec'];
  if ((spec !== 'chara_card_v2' && spec !== 'chara_card_v3') || !isObject(card['data'])) return raw;
  const data: Json = { ...card['data'] };
  let filled = false;
  if (spec === 'chara_card_v3' && data['group_only_greetings'] == null) {
    data['group_only_greetings'] = [];
    filled = true;
  }
  const book = data['character_book'];
  if (isObject(book) && book['extensions'] == null) {
    data['character_book'] = { ...book, extensions: {} };
    filled = true;
  }
  return filled ? { ...card, data } : raw;
}

/**
 * Detects the card spec and normalizes it. V1/V2 are lifted to V3 by ccardlib
 * first, so there is a single mapping path.
 */
export function normalizeCard(raw: unknown): NormalizedCard {
  if (raw === null || typeof raw !== 'object') {
    throw new CardParseError('Card must be a JSON object');
  }

  const source = withSillyTavernGaps(raw);
  const spec = CCardLib.character.check(source);
  if (spec === 'unknown') {
    throw new CardParseError('Unrecognized character card format');
  }

  const v3 =
    spec === 'v3'
      ? (source as CharacterCardV3)
      : CCardLib.character.convert(source as never, { to: 'v3' });
  const data = v3.data;
  const book = data.character_book;
  const ownLore = (book?.entries ?? []).map((entry) => loreEntryFromBook(entry));
  // SillyTavern's character's note becomes a lore entry, and leaves the
  // extensions so an export (which writes the entry back) cannot double it.
  const note = depthPromptEntry(data.extensions ?? {}, ownLore);
  const extensions = note
    ? extensionsWithoutDepthPrompt(data.extensions ?? {})
    : (data.extensions ?? {});
  const displayScripts = displayScriptsWithRegexScripts(
    extensions,
    displayScriptsFromExtensions(extensions),
  );
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
    lorebook: note ? [...ownLore, note] : ownLore,
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
