import { CCardLib, type CharacterCardV3, type LorebookEntry } from '@risuai/ccardlib';
import type { LoreEntry, NarratorConfig, NormalizedCard, PlotCustomUi } from '../types.js';
import { bookExtensionsOf, FOREVER_MESSAGES, keysForSillyTavern } from './bookEntry.js';
import { extensionsWithComponentCode } from './componentCode.js';
import { extensionsWithIntro } from './intro.js';
import { extensionsWithNarrator } from './narrator.js';
import { insertPngTextChunks, placeholderPng, stripPngTextChunks } from './png.js';
import { extensionsWithCustomUi } from './risu.js';

/**
 * depth/role have no V3 field of their own, so they go back out as decorators,
 * and so does a sticky or cooldown long enough to be the "after match" ones.
 */
function toContent(entry: LoreEntry): string {
  const decorators: string[] = [];
  if (entry.depth !== undefined) {
    decorators.push(`@@depth ${entry.depth}`);
    if (entry.role) decorators.push(`@@role ${entry.role}`);
  }
  if ((entry.sticky ?? 0) >= FOREVER_MESSAGES) decorators.push('@@keep_activate_after_match');
  if ((entry.cooldown ?? 0) >= FOREVER_MESSAGES) decorators.push('@@dont_activate_after_match');
  return decorators.length > 0 ? `${decorators.join('\n')}\n${entry.content}` : entry.content;
}

/**
 * Everything V3 has no field for also goes out as SillyTavern's per-entry
 * extensions, which is where ST reads it and where our own import reads it back;
 * only the settings `toContent` names are decorators too, so the content stays
 * clean. A regex entry's
 * keys are spelled `/source/flags`, the one form ST reads as a regex.
 */
function toLorebookEntry(entry: LoreEntry, index: number): LorebookEntry {
  const { keys, secondaryKeys } = keysForSillyTavern(entry);
  return {
    keys,
    secondary_keys: secondaryKeys,
    selective: entry.selective,
    content: toContent(entry),
    extensions: bookExtensionsOf(entry),
    enabled: entry.enabled,
    constant: entry.constant,
    insertion_order: entry.insertionOrder,
    case_sensitive: entry.caseSensitive,
    use_regex: entry.useRegex,
    position: entry.position,
    id: index,
  };
}

/**
 * What the import lifted off the card and onto the plot — the narrator, the
 * custom UI, the openings — and the plot's own lorebook, which belong to the work
 * rather than to one of its members. Export writes them back so a card
 * round-trips: import wraps a card into a plot, export unwraps that plot's member
 * back into a card.
 */
export interface CardPlotOverlay {
  narrator?: NarratorConfig;
  customUi?: PlotCustomUi;
  /** The plot's openings: the first becomes `first_mes`, the rest the alternates. */
  intros?: string[];
  /** The plot's lorebook, appended after the card's own entries. */
  lorebook?: LoreEntry[];
}

/**
 * Exports to a CCv3 JSON card.
 *
 * The overlay wins over whatever the stored card still carries: the plot is
 * where those fields are edited, so the card's copies are the import's leftovers.
 */
export function exportCardV3(card: NormalizedCard, overlay: CardPlotOverlay = {}): CharacterCardV3 {
  const narrator = overlay.narrator ?? card.narrator;
  const customUi = overlay.customUi;
  const displayScripts = customUi ? customUi.displayScripts : card.displayScripts;
  const defaultVariables = customUi ? customUi.defaultVariables : card.defaultVariables;
  const componentCode = customUi ? customUi.componentCode : card.componentCode;
  const componentCapabilities = customUi
    ? customUi.componentCapabilities
    : card.componentCapabilities;
  // A plot with no openings has nothing to say about them, so the card's stand.
  const intros = overlay.intros?.length ? overlay.intros : undefined;
  const lorebook = [...card.lorebook, ...(overlay.lorebook ?? [])];

  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: card.name,
      nickname: card.nickname ?? '',
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: intros ? intros[0]! : card.firstMes,
      alternate_greetings: intros ? intros.slice(1) : card.alternateGreetings,
      group_only_greetings: [],
      mes_example: card.mesExample,
      system_prompt: card.systemPrompt,
      post_history_instructions: card.postHistoryInstructions,
      creator_notes: card.creatorNotes,
      tags: card.tags,
      creator: card.creator,
      character_version: card.characterVersion,
      character_book: {
        extensions: {},
        scan_depth: card.loreSettings.scanDepth,
        token_budget: card.loreSettings.tokenBudget,
        recursive_scanning: card.loreSettings.recursiveScanning,
        entries: lorebook.map(toLorebookEntry),
      },
      // Display scripts and default variables live in the RisuAI extension block,
      // which is where an importing client expects to find them; the component
      // code, the narrator and the reader-facing intro have no prior art anywhere,
      // so they go under our own namespace, which they share.
      extensions: extensionsWithIntro(
        extensionsWithNarrator(
          extensionsWithComponentCode(
            extensionsWithCustomUi(card.extensions, displayScripts, defaultVariables),
            componentCode,
            componentCapabilities,
          ),
          narrator,
        ),
        card.intro,
      ),
    },
  };
}

const base64Json = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');

/**
 * The card as a PNG: `image` with its text chunks stripped (or a placeholder when
 * there is none, it is not a PNG, or it cannot be walked), carrying the card the
 * way every reader looks for it — `ccv3` with the V3 JSON, and `chara` with the
 * V2 backfill for readers that predate V3. The backfill is ccardlib's, which also
 * removes the decorators from entry content, as the V3 spec asks of a backfill;
 * depth and role survive it in the SillyTavern entry extensions.
 */
export function exportCardPng(card: CharacterCardV3, image?: Uint8Array): Uint8Array {
  const stripped = image ? stripPngTextChunks(image) : null;
  const v2 = CCardLib.character.convert(card, { from: 'v3', to: 'v2' });
  return insertPngTextChunks(stripped ?? placeholderPng(), [
    ['chara', base64Json(v2)],
    ['ccv3', base64Json(card)],
  ]);
}
