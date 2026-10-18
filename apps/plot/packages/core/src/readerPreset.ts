/**
 * A reader's own prompt presets (§6 프리셋), and the RisuAI and SillyTavern
 * preset files they may be imported from.
 *
 * A reader keeps named presets on their account and picks one per chat, where
 * it replaces the built-in default (`DEFAULT_PRESET`) as picking a preset does
 * in PocketRisu. Each is RisuAI's `botPreset`, the fields that make the prompt
 * (`PromptPreset`): its main prompt, jailbreak and global note, its
 * `formatingOrder` and prompt template, its group chat settings — and three
 * RisuAI settings that travel in its presets: its toggles
 * (`customPromptTemplateToggle`, drawn first in the chat's toggles, their
 * values the `toggle_<key>` globals the texts may read), its module integration
 * (`moduleIntergration`, the namespaces whose library modules the chat turns
 * on — `moduleIntegrationNames`) and its default variables
 * (`templateDefaultVariables`, what a chat on it reads for a variable nothing
 * set — `presetDefaultVariables`).
 *
 * An import keeps what the file's app sends: a RisuAI preset's template whole,
 * or its three texts and order; a SillyTavern preset's Main and Auxiliary
 * Prompts as the main prompt and its Post-History Instructions as the global
 * note. It says what it took and what it ignored, so the reader is never left
 * guessing.
 */
import { decompressSync } from 'fflate';
import { rpackDecode } from './card/risum.js';
import { decodeMsgpack } from './msgpack.js';
import {
  groupOtherBotRoleOf,
  normalizeFormatingOrder,
  normalizePromptTemplate,
  RISU_DEFAULT_FORMATING_ORDER,
  type FormatOrderItem,
  type GroupOtherBotRole,
  type PromptPreset,
  type PromptTemplateItem,
} from './presets.js';
import { parseDefaultVariables, type Variables } from './variables.js';

/** Presets one account may keep. */
export const MAX_READER_PRESETS = 50;
/** Characters a preset's name may hold. */
export const READER_PRESET_NAME_MAX = 60;
/**
 * Characters each of a preset's texts may hold — a prompt, a template item's
 * text, its toggles. Room for the longest RisuAI preset we have met many times
 * over: a cap that dropped a preset's text would send another prompt than the
 * one the reader chose.
 */
export const READER_PRESET_TEXT_MAX = 200_000;
/** Items a preset's prompt template may hold. */
export const READER_PRESET_TEMPLATE_ITEMS_MAX = 500;
/** Characters a preset's module integration may hold — a comma list of namespaces. */
export const READER_PRESET_INTEGRATION_MAX = 2_000;

/** A reader preset as it is stored (`reader_presets`), the prompt's part of it. */
export interface StoredReaderPrompt {
  main: string;
  globalNote: string;
  jailbreak: string;
  formatingOrder: unknown;
  promptTemplate: unknown;
  groupTemplate: string;
  groupOtherBotRole: string;
}

/**
 * The prompt preset a stored reader preset is. A row without a template or an
 * order — every one written before presets were RisuAI's whole, when they held
 * a main-prompt addition and a global note — is RisuAI's preset without a
 * template, in its default order.
 */
export function readerPromptPreset(stored: StoredReaderPrompt): PromptPreset {
  return {
    mainPrompt: stored.main,
    jailbreak: stored.jailbreak,
    globalNote: stored.globalNote,
    formatingOrder: stored.formatingOrder == null ? RISU_DEFAULT_FORMATING_ORDER : normalizeFormatingOrder(stored.formatingOrder),
    promptTemplate: normalizePromptTemplate(stored.promptTemplate),
    groupTemplate: stored.groupTemplate,
    groupOtherBotRole: groupOtherBotRoleOf(stored.groupOtherBotRole),
  };
}

/**
 * The names a preset's module integration turns on, read as RisuAI's
 * `getModules` reads `moduleIntergration`: split on commas and trimmed. Each
 * matches a library module's namespace or its id (`getModuleByIds`); a blank
 * one matches nothing.
 */
export function moduleIntegrationNames(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * A preset's default variables over a work's, as RisuAI reads a variable nothing
 * set (`getChatVar`, and its triggers' `getvar`): the character's
 * `defaultVariables` first, then the preset's `templateDefaultVariables` — so
 * the work's win and the preset's fill in the rest. The preset's are its
 * `key=value` lines (`parseDefaultVariables`). Undefined for neither.
 */
export function presetDefaultVariables(
  work: Variables | null | undefined,
  preset: string | null | undefined,
): Variables | undefined {
  const own = parseDefaultVariables(preset ?? '');
  if (!own) return work ?? undefined;
  return Object.assign(Object.create(null) as Variables, own, work ?? {});
}

export type ReaderPresetSource = 'risuai' | 'sillytavern';

/** A prompt an import took: what the file calls it, and where it went. */
export interface ReaderPresetPart {
  /**
   * Which of its app's prompts it is: the main prompt, RisuAI's global note,
   * RisuAI's jailbreak or SillyTavern's Post-History Instructions (`jailbreak`),
   * SillyTavern's Auxiliary Prompt (`nsfw`), another text of a RisuAI template
   * (`normal`).
   */
  kind: 'main' | 'globalNote' | 'jailbreak' | 'nsfw' | 'normal';
  /** The name the file gives it — a SillyTavern prompt's, a RisuAI template item's — '' where it gives none. */
  name: string;
  /** The preset's field it went into, or `template` for an item of the template, kept where it stands. */
  into: 'main' | 'globalNote' | 'jailbreak' | 'template';
}

/** What an import found in a file, for the reader to look over before saving. */
export interface ReaderPresetImport {
  source: ReaderPresetSource;
  /** The name the file gives the preset, else the file's own name. Cut to the cap. */
  name: string;
  /** RisuAI's `mainPrompt`. */
  main: string;
  globalNote: string;
  jailbreak: string;
  formatingOrder: FormatOrderItem[];
  /** RisuAI's prompt template, whole; null for a file with none. */
  promptTemplate: PromptTemplateItem[] | null;
  groupTemplate: string;
  groupOtherBotRole: GroupOtherBotRole;
  /** RisuAI's `customPromptTemplateToggle`, as written — '' for a file with none. */
  toggles: string;
  /** RisuAI's `moduleIntergration`, as written — '' for a file with none. */
  moduleIntegration: string;
  /** RisuAI's `templateDefaultVariables`, its `key=value` lines as written — '' for a file with none. */
  defaultVariables: string;
  /** The prompts taken, in the file's order, and where each went. */
  imported: ReaderPresetPart[];
  /** Prompt texts in use that are not sent — ChatML and chain-of-thought items, others of SillyTavern's — by the names the file gives them ('' for none). */
  ignoredPrompts: string[];
  /** Whether the file held anything more — model, sampling, prompt settings, its regex and the like. Always ignored. */
  ignoredSettings: boolean;
}

/**
 * Why a file could not be read: `unreadable` is not a preset file at all (or a
 * damaged one), `unsupported` is a file of another kind — a character card,
 * NovelAI's presets, a SillyTavern text-completion preset.
 */
export class ReaderPresetImportError extends Error {
  constructor(readonly reason: 'unreadable' | 'unsupported') {
    super(`reader preset import: ${reason}`);
    this.name = 'ReaderPresetImportError';
  }
}

/** Bigger than any preset; a guard against a stray file, not a limit anyone meets. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Blocks joined as RisuAI joins its prompt parts, the blank ones left out. */
const joinTexts = (texts: string[]): string =>
  texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n');

const fileStem = (fileName: string): string => fileName.replace(/\.[^./\\]+$/, '').trim();

const nameOf = (value: unknown, fileName: string): string =>
  (textOf(value).trim() || fileStem(fileName)).slice(0, READER_PRESET_NAME_MAX);

/**
 * Reads a preset file the way RisuAI's `importPreset` tells them apart: `.risup`
 * (RPack over the next), `.risupreset` (deflate → MessagePack → AES-GCM under
 * RisuAI's fixed key → MessagePack), and anything else as JSON — a SillyTavern
 * chat-completion preset when it has `prompts` and `prompt_order`, a RisuAI
 * preset otherwise.
 */
export async function readReaderPresetFile(fileName: string, bytes: Uint8Array): Promise<ReaderPresetImport> {
  if (bytes.length > MAX_FILE_BYTES) throw new ReaderPresetImportError('unreadable');
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.risup') || lower.endsWith('.risupreset')) {
    const preset = await readRisuPresetFile(lower.endsWith('.risup') ? rpackDecode(bytes) : bytes);
    return fromRisuPreset(preset, fileName);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch {
    throw new ReaderPresetImportError('unreadable');
  }
  return readReaderPresetJson(parsed, fileName);
}

/** A preset file's JSON, already parsed. */
export function readReaderPresetJson(value: unknown, fileName: string): ReaderPresetImport {
  if (!isObject(value)) throw new ReaderPresetImportError('unsupported');
  // RisuAI reads `presetVersion` 3 and up as NovelAI's: sampling only.
  if (typeof value['presetVersion'] === 'number' && value['presetVersion'] >= 3) {
    throw new ReaderPresetImportError('unsupported');
  }
  const order = value['prompt_order'];
  if (Array.isArray(order) && isObject(order[0]) && Array.isArray(order[0]['order']) && Array.isArray(value['prompts'])) {
    return fromSillyTavernPreset(value, fileName);
  }
  if (looksLikeRisuPreset(value)) return fromRisuPreset(value, fileName);
  throw new ReaderPresetImportError('unsupported');
}

/** A RisuAI `botPreset`: it has at least one of the fields only a preset has. */
function looksLikeRisuPreset(value: Json): boolean {
  return (
    typeof value['mainPrompt'] === 'string' ||
    typeof value['globalNote'] === 'string' ||
    typeof value['jailbreak'] === 'string' ||
    Array.isArray(value['promptTemplate']) ||
    Array.isArray(value['formatingOrder'])
  );
}

/** RisuAI's `.risupreset` container down to the `botPreset` inside it. */
async function readRisuPresetFile(bytes: Uint8Array): Promise<Json> {
  let outer: unknown;
  try {
    outer = decodeMsgpack(decompressSync(bytes));
  } catch {
    throw new ReaderPresetImportError('unreadable');
  }
  if (!isObject(outer) || outer['type'] !== 'preset' || (outer['presetVersion'] !== 0 && outer['presetVersion'] !== 2)) {
    throw new ReaderPresetImportError('unsupported');
  }
  const sealed = outer['preset'] ?? outer['pres'];
  if (!(sealed instanceof Uint8Array)) throw new ReaderPresetImportError('unreadable');

  let inner: unknown;
  try {
    inner = decodeMsgpack(new Uint8Array(await risuDecrypt(sealed)));
  } catch {
    throw new ReaderPresetImportError('unreadable');
  }
  if (!isObject(inner)) throw new ReaderPresetImportError('unreadable');
  return inner;
}

/**
 * RisuAI's `decryptBuffer(data, 'risupreset')`: AES-GCM under the SHA-256 of the
 * word, with a zero IV. An obfuscation every RisuAI install shares, not a secret.
 */
async function risuDecrypt(sealed: Uint8Array): Promise<ArrayBuffer> {
  const subtle = globalThis.crypto.subtle;
  const keyBytes = await subtle.digest('SHA-256', new TextEncoder().encode('risupreset'));
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  return subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, sealed.slice());
}

/** Keys of a RisuAI preset the import reads; any other one is a setting it ignores. */
const RISU_READ_KEYS = new Set([
  'name',
  'mainPrompt',
  'globalNote',
  'jailbreak',
  'formatingOrder',
  'promptTemplate',
  'groupTemplate',
  'groupOtherBotRole',
  'customPromptTemplateToggle',
  'moduleIntergration',
  'templateDefaultVariables',
]);

/** A template item's kind of text, as the import's notice names it. */
const partKind = (item: PromptTemplateItem): ReaderPresetPart['kind'] | null => {
  if (item.type === 'jailbreak') return 'jailbreak';
  if (item.type !== 'plain') return null;
  return item.type2 === 'main' ? 'main' : item.type2 === 'globalNote' ? 'globalNote' : 'normal';
};

/**
 * A RisuAI `botPreset`, kept as RisuAI sends it. With a template — even an
 * empty one — the template is the prompt, whole: its items, their roles and
 * order, the chat's stretches, the inner formats; RisuAI reads none of the
 * three texts then, and neither do we, though they are kept. Without one the
 * three texts are the prompt, in its `formatingOrder` (RisuAI's default where
 * it carries none). A ChatML or chain-of-thought item is kept but not sent yet,
 * and the notice names it.
 *
 * RisuAI sends a jailbreak only while its jailbreak toggle is on. That toggle is
 * a setting of the RisuAI install, never saved in a preset, so a file cannot say
 * it was off: its jailbreak text is sent, and the notice names it.
 */
function fromRisuPreset(preset: Json, fileName: string): ReaderPresetImport {
  const promptTemplate = normalizePromptTemplate(preset['promptTemplate']);
  const base = {
    source: 'risuai' as const,
    name: nameOf(preset['name'], fileName),
    main: textOf(preset['mainPrompt']),
    globalNote: textOf(preset['globalNote']),
    jailbreak: textOf(preset['jailbreak']),
    formatingOrder: normalizeFormatingOrder(preset['formatingOrder']),
    promptTemplate,
    groupTemplate: textOf(preset['groupTemplate']),
    groupOtherBotRole: groupOtherBotRoleOf(preset['groupOtherBotRole']),
    // Kept whatever the template: RisuAI saves and loads both beside it.
    toggles: textOf(preset['customPromptTemplateToggle']),
    moduleIntegration: textOf(preset['moduleIntergration']),
    defaultVariables: textOf(preset['templateDefaultVariables']),
    ignoredSettings: Object.keys(preset).some((key) => !RISU_READ_KEYS.has(key)),
  };

  if (!promptTemplate) {
    const imported: ReaderPresetPart[] = [];
    if (base.main.trim()) imported.push({ kind: 'main', name: '', into: 'main' });
    if (base.globalNote.trim()) imported.push({ kind: 'globalNote', name: '', into: 'globalNote' });
    if (base.jailbreak.trim() && base.formatingOrder.includes('jailbreak')) {
      imported.push({ kind: 'jailbreak', name: '', into: 'jailbreak' });
    }
    return { ...base, imported, ignoredPrompts: [] };
  }

  const imported: ReaderPresetPart[] = [];
  const ignoredPrompts: string[] = [];
  for (const item of promptTemplate) {
    if (item.type === 'cot' || item.type === 'chatML') {
      if (item.text.trim()) ignoredPrompts.push(item.name ?? '');
      continue;
    }
    const kind = partKind(item);
    if (kind && 'text' in item && item.text.trim()) imported.push({ kind, name: item.name ?? '', into: 'template' });
  }
  return { ...base, imported, ignoredPrompts };
}

/** ST's own prompts that hold the card's and the chat's text, not the preset's. */
const ST_MARKERS = new Set([
  'chatHistory',
  'dialogueExamples',
  'worldInfoBefore',
  'worldInfoAfter',
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
]);

/** ST's global prompt order — `PromptManager`'s `dummyId` — else the first, as RisuAI reads it. */
const ST_GLOBAL_ORDER_ID = 100000;

/** ST's own names for its three prompts (`chatCompletionDefaultPrompts`), for a file that names one nothing. */
const ST_NAMES = { main: 'Main Prompt', nsfw: 'Auxiliary Prompt', jailbreak: 'Post-History Instructions' } as const;

/**
 * A SillyTavern chat-completion preset. The prompts in use are the ones its
 * global prompt order has enabled, as RisuAI's own ST import reads them; a
 * disabled one is not sent and not taken. `main` is the Main Prompt. `nsfw` —
 * ST's Auxiliary Prompt, a general-purpose slot despite the identifier ST keeps
 * for compatibility — follows it in the main, as ST's default order sends it
 * ahead of the chat history. `jailbreak` — Post-History Instructions — is the
 * global note: ST sends it after the history, as RisuAI's default order sends
 * its global note, and a card's `post_history_instructions` replaces it there
 * in both. The preset is RisuAI's without a template, in that order. The
 * markers stand for the card's and the chat's own text and carry none; every
 * other prompt in use is ignored by name.
 */
function fromSillyTavernPreset(preset: Json, fileName: string): ReaderPresetImport {
  const orders = (preset['prompt_order'] as unknown[]).filter(isObject);
  const order = (orders.find((entry) => entry['character_id'] === ST_GLOBAL_ORDER_ID) ?? orders[0])!;
  const prompts = (preset['prompts'] as unknown[]).filter(isObject);

  const enabled: Json[] = [];
  const ignoredPrompts: string[] = [];
  for (const entry of order['order'] as unknown[]) {
    if (!isObject(entry) || entry['enabled'] !== true) continue;
    const prompt = prompts.find((candidate) => candidate['identifier'] === entry['identifier']);
    if (!prompt) continue;
    const identifier = prompt['identifier'];
    if (typeof identifier === 'string' && ST_MARKERS.has(identifier)) continue;
    if (!textOf(prompt['content']).trim()) continue;
    if (identifier === 'main' || identifier === 'nsfw' || identifier === 'jailbreak') enabled.push(prompt);
    else ignoredPrompts.push(textOf(prompt['name']).trim());
  }

  const texts: Record<'main' | 'globalNote', string[]> = { main: [], globalNote: [] };
  const imported: ReaderPresetPart[] = [];
  const take = (identifier: 'main' | 'nsfw' | 'jailbreak', into: 'main' | 'globalNote') => {
    const prompt = enabled.find((candidate) => candidate['identifier'] === identifier);
    if (!prompt) return;
    texts[into].push(textOf(prompt['content']));
    imported.push({ kind: identifier, name: textOf(prompt['name']).trim() || ST_NAMES[identifier], into });
  };
  take('main', 'main');
  take('nsfw', 'main');
  take('jailbreak', 'globalNote');
  return {
    source: 'sillytavern',
    name: nameOf(undefined, fileName),
    main: joinTexts(texts.main),
    globalNote: joinTexts(texts.globalNote),
    jailbreak: '',
    // RisuAI's own order: the main prompt ahead of the chat, the global note after it, as ST sends the two.
    formatingOrder: [...RISU_DEFAULT_FORMATING_ORDER],
    promptTemplate: null,
    groupTemplate: '',
    groupOtherBotRole: 'user',
    // ST has neither: its prompt toggles are the prompts' own `enabled`, read above.
    toggles: '',
    moduleIntegration: '',
    defaultVariables: '',
    imported,
    ignoredPrompts,
    ignoredSettings: true,
  };
}
