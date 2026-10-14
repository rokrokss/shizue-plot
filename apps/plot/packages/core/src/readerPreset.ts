/**
 * A reader's own additions to the prompt preset a chat runs with (§6 프리셋), and
 * the RisuAI and SillyTavern preset files they may be imported from.
 *
 * A reader keeps named presets on their account and picks one per chat. Each
 * holds two texts and nothing else: a main-instruction addition, which follows
 * our preset's main, and a global note, which follows its post-history block —
 * RisuAI's `mainPrompt` and `globalNote`, SillyTavern's Main Prompt. Where a
 * card brings its own system prompt or post-history instructions, the card's
 * win as RisuAI and ST let them win over the user's: the reader's text comes
 * back only through the card's `{{original}}` (`assemblePrompt`).
 *
 * An import takes those two texts and nothing else. Jailbreak and NSFW prompts
 * are always dropped, whatever they say, and the import says what it dropped and
 * what it ignored, so the reader is never left guessing.
 */
import { decompressSync } from 'fflate';
import { rpackDecode } from './card/risum.js';
import { decodeMsgpack } from './msgpack.js';

/** What a chat's reader preset adds to the prompt. Either may be blank. */
export interface ReaderAdditions {
  main: string;
  globalNote: string;
}

/** Presets one account may keep. */
export const MAX_READER_PRESETS = 50;
/** Characters a preset's name may hold. */
export const READER_PRESET_NAME_MAX = 60;
/**
 * Characters each of the two texts may hold. Both are sent every turn and are
 * never evicted, so a long one spends the history's budget — 10,000 is room
 * for a long RisuAI main prompt and still a fraction of the smallest budget.
 */
export const READER_PRESET_TEXT_MAX = 10_000;

export type ReaderPresetSource = 'risuai' | 'sillytavern';

/** What an import found in a file, for the reader to look over before saving. */
export interface ReaderPresetImport {
  source: ReaderPresetSource;
  /** The name the file gives the preset, else the file's own name. Cut to the cap. */
  name: string;
  main: string;
  globalNote: string;
  /** Jailbreak and NSFW prompts the file carried, in use or not: never taken. */
  dropped: ('jailbreak' | 'nsfw')[];
  /** Other prompt texts in use, which have no place among the additions — by the names the file gives them ('' for none). */
  ignoredPrompts: string[];
  /** Whether the file held anything more — model, sampling, the template's structure and the like. Always ignored. */
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

/** RisuAI's `normalizePromptRole`: what a template item is sent as, `system` for anything it does not know. */
function risuRole(role: unknown): 'user' | 'bot' | 'system' {
  if (role === 'user' || role === 'bot' || role === 'system') return role;
  if (role === 'assistant' || role === 'char') return 'bot';
  return 'system';
}

/** Keys of a RisuAI preset the import reads; any other one is a setting it ignores. */
const RISU_READ_KEYS = new Set(['name', 'mainPrompt', 'globalNote', 'jailbreak', 'promptTemplate']);

/**
 * A RisuAI `botPreset`. Without a prompt template RisuAI sends `mainPrompt` and
 * `globalNote` (and `jailbreak` when toggled on); with one — even an empty one —
 * it reads neither and sends the template's items instead, so the main is then
 * the template's `plain` items marked `main` and the note those marked
 * `globalNote`, each sent as a system turn. A `jailbreak` item is dropped like the
 * field, and every other item that carries text — a plain item of another kind or
 * role (an assistant prefill among them), chain of thought, ChatML, an inner
 * format — is ignored by name.
 */
function fromRisuPreset(preset: Json, fileName: string): ReaderPresetImport {
  const ignoredSettings = Object.keys(preset).some((key) => !RISU_READ_KEYS.has(key));
  const base = { source: 'risuai' as const, name: nameOf(preset['name'], fileName), ignoredSettings };
  const template = preset['promptTemplate'];

  if (!Array.isArray(template)) {
    return {
      ...base,
      main: textOf(preset['mainPrompt']).trim(),
      globalNote: textOf(preset['globalNote']).trim(),
      dropped: textOf(preset['jailbreak']).trim() ? ['jailbreak'] : [],
      ignoredPrompts: [],
    };
  }

  const main: string[] = [];
  const note: string[] = [];
  const ignoredPrompts: string[] = [];
  let jailbreak = false;
  for (const item of template) {
    if (!isObject(item)) continue;
    const type = item['type'];
    const name = textOf(item['name']).trim();
    if (type === 'plain' || type === 'jailbreak' || type === 'cot') {
      const text = textOf(item['text']);
      if (!text.trim()) continue;
      if (type === 'jailbreak') jailbreak = true;
      else if (type === 'plain' && risuRole(item['role']) === 'system' && item['type2'] === 'main') main.push(text);
      else if (type === 'plain' && risuRole(item['role']) === 'system' && item['type2'] === 'globalNote') note.push(text);
      else ignoredPrompts.push(name);
    } else if (type === 'chatML') {
      if (textOf(item['text']).trim()) ignoredPrompts.push(name);
    } else if (textOf(item['innerFormat']).replaceAll('{{slot}}', '').trim() || textOf(item['defaultText']).trim()) {
      // An inner format that is only the slot says nothing of its own.
      ignoredPrompts.push(name);
    }
  }
  return {
    ...base,
    main: joinTexts(main),
    globalNote: joinTexts(note),
    dropped: jailbreak ? ['jailbreak'] : [],
    ignoredPrompts,
    // The template's structure — chat ranges, the description's place, cache
    // points — is part of what is not taken.
    ignoredSettings: true,
  };
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

/**
 * A SillyTavern chat-completion preset. The prompts in use are the ones its
 * global prompt order has enabled, as RisuAI's own ST import reads them. `main`
 * is the Main Prompt. `jailbreak` is what ST now calls Post-History Instructions
 * and `nsfw` its Auxiliary Prompt — RisuAI's import makes both a jailbreak, and
 * both are dropped, enabled or not. The markers stand for the card's and the
 * chat's own text and carry none; every other prompt in use is ignored by name.
 */
function fromSillyTavernPreset(preset: Json, fileName: string): ReaderPresetImport {
  const orders = (preset['prompt_order'] as unknown[]).filter(isObject);
  const order = (orders.find((entry) => entry['character_id'] === ST_GLOBAL_ORDER_ID) ?? orders[0])!;
  const prompts = (preset['prompts'] as unknown[]).filter(isObject);
  const carries = (identifier: string): boolean =>
    prompts.some((prompt) => prompt['identifier'] === identifier && textOf(prompt['content']).trim().length > 0);

  let main = '';
  const ignoredPrompts: string[] = [];
  for (const entry of order['order'] as unknown[]) {
    if (!isObject(entry) || entry['enabled'] !== true) continue;
    const prompt = prompts.find((candidate) => candidate['identifier'] === entry['identifier']);
    if (!prompt) continue;
    const identifier = prompt['identifier'];
    const content = textOf(prompt['content']);
    if (typeof identifier === 'string' && ST_MARKERS.has(identifier)) continue;
    if (identifier === 'jailbreak' || identifier === 'nsfw' || !content.trim()) continue;
    if (identifier === 'main') main = content.trim();
    else ignoredPrompts.push(textOf(prompt['name']).trim());
  }
  return {
    source: 'sillytavern',
    name: nameOf(undefined, fileName),
    main,
    globalNote: '',
    dropped: [...(carries('jailbreak') ? ['jailbreak' as const] : []), ...(carries('nsfw') ? ['nsfw' as const] : [])],
    ignoredPrompts,
    ignoredSettings: true,
  };
}
