/**
 * What a SillyTavern user directory holds, as the import's picker shows it: the
 * characters with their chats and linked worlds, the groups, the personas, and
 * the global world and regex settings. Field paths follow ST's source:
 *
 * - A character's linked world is `data.extensions.world` (`src/endpoints/characters.js`).
 * - settings.json is the client's `saveSettings` payload (`public/script.js`).
 *   World Info sits under `world_info_settings.world_info` — older files had it at
 *   the top level, which ST still reads (`setWorldInfoSettings(settings.world_info_settings ?? settings)`).
 *   There, `globalSelect` is the global worlds and `charLore` is
 *   `[{ name, extraBooks }]`, where `name` is the character's avatar file name
 *   without its extension (`getCharaFilename`, `public/scripts/utils.js`).
 * - Personas are `power_user.personas` (`{ [avatar]: name }`) with
 *   `power_user.persona_descriptions[avatar].description` (`public/scripts/personas.js`).
 * - Global regex scripts are `extension_settings.regex`
 *   (`public/scripts/extensions/regex/engine.js`).
 *
 * settings.json also holds API settings and, in places, credentials. It is parsed
 * here, in the browser, and only those five values leave this function; the file
 * itself is never part of the manifest, so it is never uploaded.
 */

import { readPngTextChunkBytes } from '../card/png.js';
import { FileTooLargeError } from './zip.js';
import { ST_CAPS, stFileKind, type StCaps, type StFile } from './files.js';

export interface StChatFile {
  file: StFile;
  /** File stem. */
  name: string;
}

export interface StCharacter {
  file: StFile;
  /** File name in `characters/`, e.g. 'Seraphina.png' — ST's id for the character. */
  avatar: string;
  name: string;
  /** The linked world, which wins over the card's embedded book. */
  worldName?: string;
  /** settings.json's additional books for this character. */
  extraWorlds: string[];
  chats: StChatFile[];
}

export interface StGroup {
  id: string;
  name: string;
  /** Avatar file names, as ST stores them. */
  members: string[];
  chats: StChatFile[];
}

export interface StPersona {
  avatar: string;
  name: string;
  description: string;
}

export type StSkipReason =
  /** Over its kind's cap. */
  | 'too_large'
  /** The read failed (I/O, a corrupt zip entry). */
  | 'unreadable'
  /** A character PNG without a card in it. */
  | 'not_a_card'
  | 'invalid_json'
  /** A chat folder no character's avatar names. */
  | 'no_character'
  /** A group chat no group lists. */
  | 'no_group'
  /** A world a character or settings.json names, with no file. */
  | 'missing';

export interface StManifest {
  characters: StCharacter[];
  groups: StGroup[];
  personas: StPersona[];
  /** By world name, which is the file stem. */
  worlds: Record<string, StFile>;
  /** settings.json `world_info.globalSelect`. */
  globalWorlds: string[];
  /** settings.json `extension_settings.regex`, ST's raw scripts. */
  globalRegex: unknown[];
  skipped: { path: string; reason: StSkipReason }[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item !== ''))]
    : [];

/** ST's ids are strings, or numbers in files old enough. */
const idsOf = (values: unknown[]): string[] => [
  ...new Set(
    values
      .filter((value) => typeof value === 'string' || typeof value === 'number')
      .map(String)
      .filter(Boolean),
  ),
];

const stemOf = (fileName: string, extension: string): string =>
  fileName.endsWith(extension) ? fileName.slice(0, -extension.length) : fileName;

const byName = <T extends { name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Base64 to bytes without Buffer, so this runs in the browser. */
function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A card's name and linked world, from the chunk ST reads first (`ccv3`, then `chara`). */
function cardSummary(png: Uint8Array): { name: string; world: string } | undefined {
  const chunks = readPngTextChunkBytes(png);
  const decoder = new TextDecoder('utf-8');
  for (const keyword of ['ccv3', 'chara']) {
    const payload = chunks.get(keyword);
    if (!payload?.length) continue;
    try {
      const card: unknown = JSON.parse(decoder.decode(base64Bytes(decoder.decode(payload))));
      if (!isObject(card)) continue;
      const data = isObject(card['data']) ? card['data'] : {};
      const extensions = isObject(data['extensions']) ? data['extensions'] : {};
      const name = [data['name'], card['name']].find((value) => typeof value === 'string' && value.trim());
      const world = extensions['world'];
      return {
        name: typeof name === 'string' ? name.trim() : '',
        world: typeof world === 'string' ? world.trim() : '',
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The five values the import takes from settings.json; the parsed object goes no further. */
interface SettingsValues {
  personas: StPersona[];
  charLore: Map<string, string[]>;
  globalWorlds: string[];
  globalRegex: unknown[];
}

function settingsValues(settings: Json): SettingsValues {
  const worldSettings = isObject(settings['world_info_settings'])
    ? settings['world_info_settings']
    : settings;
  const worldInfo = isObject(worldSettings['world_info']) ? worldSettings['world_info'] : {};

  const charLore = new Map<string, string[]>();
  for (const lore of Array.isArray(worldInfo['charLore']) ? worldInfo['charLore'] : []) {
    if (isObject(lore) && typeof lore['name'] === 'string') {
      charLore.set(lore['name'], stringsOf(lore['extraBooks']));
    }
  }

  const powerUser = isObject(settings['power_user']) ? settings['power_user'] : {};
  const names = isObject(powerUser['personas']) ? powerUser['personas'] : {};
  const descriptions = isObject(powerUser['persona_descriptions'])
    ? powerUser['persona_descriptions']
    : {};
  const personas: StPersona[] = [];
  for (const [avatar, name] of Object.entries(names)) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const entry = descriptions[avatar];
    const description =
      isObject(entry) && typeof entry['description'] === 'string' ? entry['description'] : '';
    personas.push({ avatar, name: name.trim(), description });
  }

  const extensionSettings = isObject(settings['extension_settings']) ? settings['extension_settings'] : {};
  const regex = extensionSettings['regex'];
  return {
    personas,
    charLore,
    globalWorlds: stringsOf(worldInfo['globalSelect']),
    globalRegex: Array.isArray(regex) ? regex.filter(isObject) : [],
  };
}

/**
 * ST stores a group chat as `sanitize(`${id}.jsonl`)` (`src/endpoints/groups.js`);
 * the characters `sanitize-filename` drops are the ones a chat id could carry.
 */
const sanitizeChatId = (id: string): string =>
  id.replace(/[/?<>\\:*|"\u0000-\u001f\u0080-\u009f]/g, '').replace(/[. ]+$/, '');

/**
 * Reads the directory's settings.json, character cards and groups — and nothing
 * else: chats and worlds are listed by path, for the importer to read the ones
 * the reader picks. Never throws on a bad file; it is skipped and named in
 * `skipped`. Chats and worlds over their cap are skipped up front, by size.
 */
export async function scanSillyTavern(
  files: StFile[],
  caps: Partial<StCaps> = {},
): Promise<StManifest> {
  const limits = { ...ST_CAPS, ...caps };
  const skipped: StManifest['skipped'] = [];
  const decoder = new TextDecoder('utf-8');

  /** The file's bytes, or undefined with the reason recorded. */
  const readOrSkip = async (file: StFile, cap: number): Promise<Uint8Array | undefined> => {
    if (file.size > cap) {
      skipped.push({ path: file.path, reason: 'too_large' });
      return undefined;
    }
    try {
      return await file.read();
    } catch (error) {
      const reason = error instanceof FileTooLargeError ? 'too_large' : 'unreadable';
      skipped.push({ path: file.path, reason });
      return undefined;
    }
  };
  const readJson = async (file: StFile, cap: number): Promise<Json | undefined> => {
    const bytes = await readOrSkip(file, cap);
    if (!bytes) return undefined;
    try {
      const json: unknown = JSON.parse(decoder.decode(bytes));
      if (isObject(json)) return json;
    } catch {
      // Reported below.
    }
    skipped.push({ path: file.path, reason: 'invalid_json' });
    return undefined;
  };

  const settingsFile = files.find((file) => file.path === 'settings.json');
  const settingsJson = settingsFile ? await readJson(settingsFile, limits.settings) : undefined;
  const settings = settingsValues(settingsJson ?? {});

  // Null-prototype: world names are the user's file names, `__proto__` included.
  const worlds: Record<string, StFile> = Object.create(null);
  const oversizedWorlds = new Set<string>();
  const characterChats = new Map<string, StChatFile[]>();
  const groupChats = new Map<string, StFile>();
  const pngs: StFile[] = [];
  const groupFiles: StFile[] = [];
  for (const file of files) {
    const kind = stFileKind(file.path);
    const parts = file.path.split('/');
    if (kind === 'character') pngs.push(file);
    else if (kind === 'group') groupFiles.push(file);
    else if (kind === 'world' || kind === 'chat') {
      if (file.size > limits[kind]) {
        skipped.push({ path: file.path, reason: 'too_large' });
        if (kind === 'world') oversizedWorlds.add(stemOf(parts[1]!, '.json'));
      } else if (kind === 'world') {
        worlds[stemOf(parts[1]!, '.json')] = file;
      } else if (parts[0] === 'chats') {
        const chats = characterChats.get(parts[1]!) ?? [];
        chats.push({ file, name: stemOf(parts[2]!, '.jsonl') });
        characterChats.set(parts[1]!, chats);
      } else {
        groupChats.set(stemOf(parts[1]!, '.jsonl'), file);
      }
    }
  }

  const characters: StCharacter[] = [];
  for (const file of pngs) {
    const bytes = await readOrSkip(file, limits.character);
    if (!bytes) continue;
    const card = cardSummary(bytes);
    if (!card) {
      skipped.push({ path: file.path, reason: 'not_a_card' });
      continue;
    }
    const avatar = file.path.slice('characters/'.length);
    // ST's own `.replace('.png', '')` (characters.js), for the chats folder and charLore alike.
    const stem = avatar.replace('.png', '');
    const chats = characterChats.get(stem) ?? [];
    characterChats.delete(stem);
    const extraWorlds = (settings.charLore.get(stem) ?? settings.charLore.get(avatar) ?? []).filter(
      (world) => world !== card.world,
    );
    characters.push({
      file,
      avatar,
      name: card.name || stem,
      ...(card.world ? { worldName: card.world } : {}),
      extraWorlds,
      chats: chats.sort(byName),
    });
  }
  for (const chats of characterChats.values()) {
    for (const chat of chats) skipped.push({ path: chat.file.path, reason: 'no_character' });
  }

  const groups: StGroup[] = [];
  const claimed = new Set<string>();
  for (const file of groupFiles) {
    const group = await readJson(file, limits.group);
    if (!group) continue;
    // An old group may name only its current chat, in `chat_id`.
    const chats: StChatFile[] = [];
    const chatIds = idsOf([...(Array.isArray(group['chats']) ? group['chats'] : []), group['chat_id']]);
    for (const chatId of chatIds) {
      const stem = sanitizeChatId(chatId);
      const chat = groupChats.get(stem);
      if (chat && !claimed.has(stem)) {
        claimed.add(stem);
        chats.push({ file: chat, name: stem });
      }
    }
    const id = idsOf([group['id']])[0] ?? stemOf(file.path.slice('groups/'.length), '.json');
    const name = typeof group['name'] === 'string' ? group['name'].trim() : '';
    groups.push({ id, name: name || id, members: stringsOf(group['members']), chats: chats.sort(byName) });
  }
  for (const [stem, file] of groupChats) {
    if (!claimed.has(stem)) skipped.push({ path: file.path, reason: 'no_group' });
  }

  const named = new Set([
    ...characters.flatMap((character) => [character.worldName ?? '', ...character.extraWorlds]),
    ...settings.globalWorlds,
  ]);
  for (const world of named) {
    if (world && !(world in worlds) && !oversizedWorlds.has(world)) {
      skipped.push({ path: `worlds/${world}.json`, reason: 'missing' });
    }
  }

  return {
    characters: characters.sort((a, b) => (a.avatar < b.avatar ? -1 : a.avatar > b.avatar ? 1 : 0)),
    groups: groups.sort(byName),
    personas: settings.personas,
    worlds,
    globalWorlds: settings.globalWorlds,
    globalRegex: settings.globalRegex,
    skipped,
  };
}
