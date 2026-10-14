import { CCardLib, type CharacterCardV3 } from '@risuai/ccardlib';
import { DEFAULT_LORE_SETTINGS, type CardSpec, type LoreSettings, type NormalizedCard } from '../types.js';
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

/** RisuAI's insertion order for a lore entry that has none (`addLorebook`). */
const DEFAULT_INSERTION_ORDER = 100;

/**
 * SillyTavern's cards fail ccardlib's V2/V3 schema as ST writes them: its `ccv3`
 * PNG chunk is its V2 JSON with the spec relabelled, so there is no
 * `group_only_greetings`, and a lorebook ST built itself has no book-level
 * `extensions`. Worse than refused, such a card passes as V1 — ST repeats the V1
 * fields at the top — and everything under `data` would be lost. The gaps are
 * filled in on a copy, so `raw` stays what arrived; a card without them is
 * returned as is.
 *
 * RisuAI leaves one more: a lore entry it exports with `insertion_order: null`
 * (an entry whose order field was never set), which RisuAI itself imports
 * without a word. It gets RisuAI's default for a new entry, 100 — the number
 * ccardlib's own conversion fills in too.
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
  if (isObject(book)) {
    let next: Json = book;
    if (book['extensions'] == null) next = { ...next, extensions: {} };
    const entries = book['entries'];
    if (Array.isArray(entries) && entries.some((entry) => isObject(entry) && entry['insertion_order'] == null)) {
      next = {
        ...next,
        entries: entries.map((entry) =>
          isObject(entry) && entry['insertion_order'] == null
            ? { ...entry, insertion_order: DEFAULT_INSERTION_ORDER }
            : entry,
        ),
      };
    }
    if (next !== book) {
      data['character_book'] = next;
      filled = true;
    }
  }
  return filled ? { ...card, data } : raw;
}


type Book = CharacterCardV3['data']['character_book'];

/**
 * Whether the card's lorebook was last written by RisuAI. Its exporter puts
 * `risu_fullWordMatching` in the book's own `extensions` on every V2 and V3 card,
 * and nothing else writes that. An older RisuAI card has only its
 * `extensions.risuai` block to go by, which is not enough alone: our own export
 * writes one too (for display scripts), and SillyTavern keeps one on a card it
 * got from RisuAI — but both rewrite every entry in ST's terms, with a numeric
 * `extensions.position`, which an entry made in RisuAI does not have. So the
 * block counts once some entry is not written that way.
 */
function isRisuAiBook(book: Book, cardExtensions: Json): boolean {
  if (!book) return false;
  if (isObject(book.extensions) && typeof book.extensions['risu_fullWordMatching'] === 'boolean') return true;
  return (
    isObject(cardExtensions['risuai']) &&
    (book.entries ?? []).some(
      (entry) => !(isObject(entry.extensions) && typeof entry.extensions['position'] === 'number'),
    )
  );
}

/**
 * The book's settings, each the card's own where it has one.
 *
 * A RisuAI book differs in two ways, so it runs as its creator tested it. Its
 * plain keys are matched RisuAI's way (`risuMatching`) — unless the book asks
 * for RisuAI's whole-word matching, which is not implemented, and to which exact
 * matching is the nearer. And it scans recursively unless it says otherwise in
 * RisuAI's terms: RisuAI takes `recursive_scanning` only together with
 * `scan_depth` and `token_budget` (all three or none, `convertCharbook`), and
 * without them recursion is on — a fixed default there, not a reader's setting.
 * Its depth and budget without them are the reader's settings there (5 messages
 * and 800 tokens by default), so ours stand in for those: depth 4 and the
 * automatic budget.
 */
function loreSettingsOf(book: Book, cardExtensions: Json): LoreSettings {
  const risu = isRisuAiBook(book, cardExtensions);
  const allThree = book?.scan_depth != null && book.token_budget != null && book.recursive_scanning != null;
  return {
    scanDepth: book?.scan_depth ?? DEFAULT_LORE_SETTINGS.scanDepth,
    // Only the card's own number: without one the budget is the automatic one.
    ...(typeof book?.token_budget === 'number' ? { tokenBudget: book.token_budget } : {}),
    recursiveScanning:
      risu && !allThree ? true : (book?.recursive_scanning ?? DEFAULT_LORE_SETTINGS.recursiveScanning),
    ...(risu && book?.extensions?.['risu_fullWordMatching'] !== true ? { risuMatching: true } : {}),
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
    ...(data.group_only_greetings?.length ? { groupOnlyGreetings: data.group_only_greetings } : {}),
    mesExample: data.mes_example ?? '',
    systemPrompt: data.system_prompt ?? '',
    postHistoryInstructions: data.post_history_instructions ?? '',
    creatorNotes: data.creator_notes ?? '',
    tags: data.tags ?? [],
    creator: data.creator ?? '',
    characterVersion: data.character_version ?? '',
    lorebook: note ? [...ownLore, note] : ownLore,
    loreSettings: loreSettingsOf(book, data.extensions ?? {}),
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
