import type { CharacterCardV3, LorebookEntry } from '@risuai/ccardlib';
import type { LoreEntry, NarratorConfig, NormalizedCard, PlotCustomUi } from '../types.js';
import { extensionsWithComponentCode } from './componentCode.js';
import { extensionsWithIntro } from './intro.js';
import { extensionsWithNarrator } from './narrator.js';
import { extensionsWithCustomUi } from './risu.js';

/** depth/role have no V3 field of their own, so they go back out as decorators. */
function toContent(entry: LoreEntry): string {
  if (entry.depth === undefined) return entry.content;
  const decorators = [`@@depth ${entry.depth}`];
  if (entry.role) decorators.push(`@@role ${entry.role}`);
  return `${decorators.join('\n')}\n${entry.content}`;
}

function toLorebookEntry(entry: LoreEntry, index: number): LorebookEntry {
  return {
    keys: entry.keys,
    secondary_keys: entry.secondaryKeys,
    selective: entry.selective,
    content: toContent(entry),
    extensions: {},
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
 * What the import lifted off the card and onto the plot — the narrator and the
 * custom UI, which belong to the work rather than to one of its members. Export
 * writes them back so a card round-trips: import wraps a card into a plot,
 * export unwraps that plot's member back into a card.
 */
export interface CardPlotOverlay {
  narrator?: NarratorConfig;
  customUi?: PlotCustomUi;
}

/**
 * Exports to a CCv3 JSON card. PNG export is out of scope for the MVP.
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

  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: card.name,
      nickname: card.nickname ?? '',
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.firstMes,
      alternate_greetings: card.alternateGreetings,
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
        entries: card.lorebook.map(toLorebookEntry),
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
