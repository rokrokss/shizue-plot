/**
 * A reader's own additions to the prompt preset a chat runs with (§6 프리셋), and
 * the RisuAI and SillyTavern preset files they may be imported from.
 *
 * A reader keeps named presets on their account and picks one per chat. Each
 * holds two texts and nothing else: a main-instruction addition, which follows
 * our preset's main, and a global note, which follows its post-history block —
 * RisuAI's `mainPrompt` and `globalNote`, SillyTavern's Main Prompt and
 * Post-History Instructions. Where a
 * card brings its own system prompt or post-history instructions, the card's
 * win as RisuAI and ST let them win over the user's: the reader's text comes
 * back only through the card's `{{original}}` (`assemblePrompt`).
 *
 * An import fills those two texts with the prompts the file sends where they
 * send: its main prompt, its global note, and the general-purpose slots RisuAI
 * calls the jailbreak and SillyTavern Post-History Instructions and the
 * Auxiliary Prompt, each in the field that stands where its app sends it. The
 * import says what it took and into which field, and what it ignored, so the
 * reader is never left guessing.
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

/** A prompt an import took: what the file calls it, and which text it went into. */
export interface ReaderPresetPart {
  /**
   * Which of its app's prompts it is: the main prompt, RisuAI's global note,
   * RisuAI's jailbreak or SillyTavern's Post-History Instructions (`jailbreak`),
   * SillyTavern's Auxiliary Prompt (`nsfw`).
   */
  kind: 'main' | 'globalNote' | 'jailbreak' | 'nsfw';
  /** The name the file gives it — a SillyTavern prompt's, a RisuAI template item's — '' where it gives none. */
  name: string;
  into: 'main' | 'globalNote';
}

/** What an import found in a file, for the reader to look over before saving. */
export interface ReaderPresetImport {
  source: ReaderPresetSource;
  /** The name the file gives the preset, else the file's own name. Cut to the cap. */
  name: string;
  main: string;
  globalNote: string;
  /** The prompts taken, in the file's order, and where each went. */
  imported: ReaderPresetPart[];
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

/** RisuAI's default `formatingOrder` (`database.svelte.ts`), for a preset that carries none. */
const RISU_DEFAULT_ORDER = ['main', 'description', 'personaPrompt', 'chats', 'lastChat', 'jailbreak', 'lorebook', 'globalNote', 'authorNote'];

/** Texts gathered for the two fields, in the order the file sends them, with what each was. */
class Gathered {
  readonly main: string[] = [];
  readonly globalNote: string[] = [];
  readonly imported: ReaderPresetPart[] = [];

  add(into: ReaderPresetPart['into'], kind: ReaderPresetPart['kind'], name: string, text: string): void {
    if (!text.trim()) return;
    this[into].push(text);
    this.imported.push({ kind, name, into });
  }
}

/**
 * A RisuAI `botPreset`. Without a prompt template RisuAI sends `mainPrompt`,
 * `globalNote` and `jailbreak` in its `formatingOrder` — by default `main, …,
 * chats, lastChat, jailbreak, lorebook, globalNote, …` — so the jailbreak goes
 * behind the history into the global note, ahead of the note's own text; an
 * order that puts it before the chats puts it in the main, and one without it
 * never sends it. With a template — even an empty one — RisuAI reads none of
 * those fields and sends the template's items in their order instead: the main
 * is the template's system `plain` items marked `main`, the note those marked
 * `globalNote`, and a system `jailbreak` item joins the main where it comes
 * before the template's first chat and the note where it comes after. Every
 * other item that carries text — a plain item of another kind or role (an
 * assistant prefill among them), chain of thought, ChatML, an inner format — is
 * ignored by name.
 *
 * RisuAI sends a jailbreak only while its jailbreak toggle is on. That toggle is
 * a setting of the RisuAI install, never saved in a preset, so a file cannot say
 * it was off: its jailbreak text is taken, and the notice names it.
 */
function fromRisuPreset(preset: Json, fileName: string): ReaderPresetImport {
  const ignoredSettings = Object.keys(preset).some((key) => !RISU_READ_KEYS.has(key));
  const base = { source: 'risuai' as const, name: nameOf(preset['name'], fileName), ignoredSettings };
  const template = preset['promptTemplate'];
  const taken = new Gathered();

  if (!Array.isArray(template)) {
    const order = Array.isArray(preset['formatingOrder']) ? (preset['formatingOrder'] as unknown[]) : RISU_DEFAULT_ORDER;
    const at = (item: string): number => order.indexOf(item);
    const jailbreak = at('jailbreak');
    const into = at('chats') !== -1 && jailbreak < at('chats') ? 'main' : 'globalNote';
    // Ahead of its field's own text or behind it, as the order sends the two.
    const first = into === 'main' ? jailbreak < at('main') : at('globalNote') === -1 || jailbreak < at('globalNote');
    const addJailbreak = (here: ReaderPresetPart['into'], ahead: boolean) => {
      if (jailbreak !== -1 && into === here && first === ahead) taken.add(into, 'jailbreak', '', textOf(preset['jailbreak']));
    };
    addJailbreak('main', true);
    taken.add('main', 'main', '', textOf(preset['mainPrompt']));
    addJailbreak('main', false);
    addJailbreak('globalNote', true);
    taken.add('globalNote', 'globalNote', '', textOf(preset['globalNote']));
    addJailbreak('globalNote', false);
    return { ...base, main: joinTexts(taken.main), globalNote: joinTexts(taken.globalNote), imported: taken.imported, ignoredPrompts: [] };
  }

  const ignoredPrompts: string[] = [];
  let pastChat = false;
  for (const item of template) {
    if (!isObject(item)) continue;
    const type = item['type'];
    const name = textOf(item['name']).trim();
    if (type === 'chat') pastChat = true;
    if (type === 'plain' || type === 'jailbreak' || type === 'cot') {
      const text = textOf(item['text']);
      if (!text.trim()) continue;
      const system = risuRole(item['role']) === 'system';
      if (type === 'jailbreak' && system) taken.add(pastChat ? 'globalNote' : 'main', 'jailbreak', name, text);
      else if (type === 'plain' && system && item['type2'] === 'main') taken.add('main', 'main', name, text);
      else if (type === 'plain' && system && item['type2'] === 'globalNote') taken.add('globalNote', 'globalNote', name, text);
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
    main: joinTexts(taken.main),
    globalNote: joinTexts(taken.globalNote),
    imported: taken.imported,
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

/** ST's own names for its three prompts (`chatCompletionDefaultPrompts`), for a file that names one nothing. */
const ST_NAMES = { main: 'Main Prompt', nsfw: 'Auxiliary Prompt', jailbreak: 'Post-History Instructions' } as const;

/**
 * A SillyTavern chat-completion preset. The prompts in use are the ones its
 * global prompt order has enabled, as RisuAI's own ST import reads them; a
 * disabled one is not sent and not taken. `main` is the Main Prompt. `nsfw` —
 * ST's Auxiliary Prompt, a general-purpose slot despite the identifier ST keeps
 * for compatibility — follows it in the main, as ST's default order sends it
 * ahead of the chat history. `jailbreak` — Post-History Instructions — is the
 * global note: ST sends it after the history, and a card's
 * `post_history_instructions` replaces it there as it replaces our post-history
 * block. The markers stand for the card's and the chat's own text and carry
 * none; every other prompt in use is ignored by name.
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

  const taken = new Gathered();
  const take = (identifier: 'main' | 'nsfw' | 'jailbreak', into: ReaderPresetPart['into']) => {
    const prompt = enabled.find((candidate) => candidate['identifier'] === identifier);
    if (!prompt) return;
    const name = textOf(prompt['name']).trim() || ST_NAMES[identifier];
    taken.add(into, identifier, name, textOf(prompt['content']));
  };
  take('main', 'main');
  take('nsfw', 'main');
  take('jailbreak', 'globalNote');
  return {
    source: 'sillytavern',
    name: nameOf(undefined, fileName),
    main: joinTexts(taken.main),
    globalNote: joinTexts(taken.globalNote),
    imported: taken.imported,
    ignoredPrompts,
    ignoredSettings: true,
  };
}
