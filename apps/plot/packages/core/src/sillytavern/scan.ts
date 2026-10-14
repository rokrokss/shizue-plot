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
 *   `power_user.persona_descriptions[avatar].description` (`public/scripts/personas.js`);
 *   the avatar is the picture's file name in `User Avatars/` (`USER_DIRECTORY_TEMPLATE`).
 * - Global regex scripts are `extension_settings.regex`
 *   (`public/scripts/extensions/regex/engine.js`).
 * - The World Info settings sit beside `world_info`, as `world_info_depth`,
 *   `world_info_budget` and the rest (`getWorldInfoSettings`, `world-info.js`).
 * - A group's turn-taking is its `activation_strategy` and `disabled_members`,
 *   and each member's card `talkativeness` (`public/scripts/group-chats.js`).
 *
 * settings.json also holds API settings and, in places, credentials. It is parsed
 * here, in the browser, and only those six values leave this function; the file
 * itself is never part of the manifest, so it is never uploaded.
 */

import { readPngTextChunkBytes } from '../card/png.js';
import {
  coerceTalkativeness,
  DEFAULT_GROUP_SETTINGS,
  MAX_GROUP_SPEAKERS,
  type GroupSettings,
} from '../group.js';
import type { LoreSettings } from '../types.js';
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
  /**
   * The card's talkativeness — ST's 0..1, as a 대화량 0..100. Absent when the
   * card has none, which ST reads as its default, the same 50 as here.
   */
  talkativeness?: number;
  chats: StChatFile[];
}

/** ST's `group_activation_strategy`, numbered 0..3 in that order. */
export type StActivationStrategy = 'natural' | 'list' | 'manual' | 'pooled';

export interface StGroup {
  id: string;
  name: string;
  /** Avatar file names, as ST stores them. */
  members: string[];
  /** `activation_strategy`; natural where the file has none (ST's default) or one ST does not know. */
  strategy: StActivationStrategy;
  /** `disabled_members` — the members ST leaves out of every round — by avatar file name. */
  disabled: string[];
  /** How the plot made of the group picks a round's speakers (`groupSettingsOf`). */
  settings: GroupSettings;
  chats: StChatFile[];
}

export interface StPersona {
  avatar: string;
  name: string;
  description: string;
  /** The persona's picture, `User Avatars/<avatar>`, where the directory has it within its cap. */
  image?: StFile;
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
  /** settings.json's World Info settings, read as a book's. Absent without a settings.json. */
  worldInfoSettings?: StWorldInfoSettings;
  skipped: { path: string; reason: StSkipReason }[];
}

/**
 * ST's global World Info settings as far as a book's lore settings say the same
 * thing — they decide every chat's lore there, and a book here carries its own
 * (the first member's card, for a plot) — and the ones nothing here does.
 */
export interface StWorldInfoSettings {
  /** What every imported plot's book takes over. */
  lore: Pick<LoreSettings, 'scanDepth' | 'budgetPercent' | 'recursiveScanning' | 'maxRecursionSteps'>;
  /**
   * The settings left behind, by ST's own name — only those set away from ST's
   * default: at the default, what shizue does instead is what every import gets.
   */
  dropped: string[];
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

/**
 * ST's talkativeness, 0..1, as a 대화량 0..100. ST reads it with `Number()`
 * (`activateNaturalOrder`), and its card editor saves the slider's string, so a
 * numeric string counts as much as a number; anything else is no value.
 */
function talkativenessOf(value: unknown): number | undefined {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? coerceTalkativeness(number * 100) : undefined;
}

/**
 * A card's name, linked world and talkativeness, from the chunk ST reads first
 * (`ccv3`, then `chara`). The talkativeness is `data.extensions.talkativeness`,
 * else the V1 copy at the top level — ST's `readFromV2` lets the first win.
 */
function cardSummary(png: Uint8Array): { name: string; world: string; talkativeness?: number } | undefined {
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
      const talkativeness = talkativenessOf(extensions['talkativeness'] ?? card['talkativeness']);
      return {
        name: typeof name === 'string' ? name.trim() : '',
        world: typeof world === 'string' ? world.trim() : '',
        ...(talkativeness !== undefined ? { talkativeness } : {}),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The six values the import takes from settings.json; the parsed object goes no further. */
interface SettingsValues {
  personas: StPersona[];
  charLore: Map<string, string[]>;
  globalWorlds: string[];
  globalRegex: unknown[];
  worldInfoSettings: StWorldInfoSettings;
}

/** A whole number from `floor` up, or undefined. */
const wholeAtLeast = (value: unknown, floor: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= floor ? Math.floor(value) : undefined;

/**
 * ST's World Info settings (`world_info_*`), each read with ST's own default
 * where the file has none, as a book's lore settings:
 *
 *   - `world_info_depth` (2) is the scan depth;
 *   - `world_info_budget` (25, percent of the context) the automatic budget's
 *     share, left out at 25, which is the share here too;
 *   - `world_info_recursive` (on) recursive scanning, and
 *     `world_info_max_recursion_steps` (0, no limit) its step limit.
 *
 * What a book here cannot say: the budget's token cap, scanning with names,
 * case sensitivity and whole-word matching as the default of an entry that sets
 * none (an entry here always carries its own), the minimum activations, the
 * group scoring, and the insertion strategy (a merged book here is one book in
 * insertion order). Those are named in `dropped` when they are set away from
 * ST's default.
 */
function worldInfoSettingsOf(settings: Json): StWorldInfoSettings {
  const depth = wholeAtLeast(settings['world_info_depth'], 0) ?? 2;
  const budget = wholeAtLeast(settings['world_info_budget'], 1) ?? 25;
  const recursive = typeof settings['world_info_recursive'] === 'boolean' ? settings['world_info_recursive'] : true;
  const steps = wholeAtLeast(settings['world_info_max_recursion_steps'], 0) ?? 0;

  const dropped: string[] = [];
  const awayFrom = (key: string, fallback: unknown): void => {
    const value = settings[key];
    if (value !== undefined && value !== null && value !== fallback) dropped.push(key);
  };
  awayFrom('world_info_budget_cap', 0);
  awayFrom('world_info_include_names', true);
  awayFrom('world_info_case_sensitive', false);
  awayFrom('world_info_match_whole_words', false);
  awayFrom('world_info_min_activations', 0);
  awayFrom('world_info_use_group_scoring', false);
  awayFrom('world_info_character_strategy', 1);

  return {
    lore: {
      scanDepth: depth,
      ...(budget !== 25 ? { budgetPercent: Math.min(100, budget) } : {}),
      recursiveScanning: recursive,
      ...(recursive && steps > 0 ? { maxRecursionSteps: steps } : {}),
    },
    dropped,
  };
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
    worldInfoSettings: worldInfoSettingsOf(worldSettings),
  };
}

const STRATEGIES: readonly StActivationStrategy[] = ['natural', 'list', 'manual', 'pooled'];

/**
 * A group's turn-taking as a plot's round settings.
 *
 * - Natural and list order are ours too. ST caps neither — every member whose
 *   roll passes, or every enabled member, answers — so the cap is the members ST
 *   could have called on, and never below the default.
 * - Manual and pooled have no order here, and both have one member answer at a
 *   time: manual waits for the reader to pick one, pooled picks one who has not
 *   spoken since the reader. Each becomes natural order with one speaker a round:
 *   the reader may pick who, else the mentions and the roll do, and a round the
 *   reader did not start passes over whoever just spoke.
 */
function groupSettingsOf(strategy: StActivationStrategy, enabled: number): GroupSettings {
  if (strategy === 'manual' || strategy === 'pooled') return { order: 'natural', maxSpeakers: 1 };
  return {
    order: strategy,
    maxSpeakers: Math.min(MAX_GROUP_SPEAKERS, Math.max(DEFAULT_GROUP_SETTINGS.maxSpeakers, enabled)),
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
 * else: chats, worlds and persona pictures are listed by path, for the importer
 * to read the ones the reader picks. Never throws on a bad file; it is skipped
 * and named in `skipped`. Chats, worlds and persona pictures over their cap are
 * skipped up front, by size.
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
  const avatars = new Map<string, StFile>();
  for (const file of files) {
    const kind = stFileKind(file.path);
    const parts = file.path.split('/');
    if (kind === 'character') pngs.push(file);
    else if (kind === 'group') groupFiles.push(file);
    else if (kind === 'avatar') avatars.set(parts[1]!, file);
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
      ...(card.talkativeness !== undefined ? { talkativeness: card.talkativeness } : {}),
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
    const members = stringsOf(group['members']);
    const disabled = stringsOf(group['disabled_members']).filter((avatar) => members.includes(avatar));
    const number = group['activation_strategy'];
    const strategy = (typeof number === 'number' && STRATEGIES[number]) || 'natural';
    groups.push({
      id,
      name: name || id,
      members,
      strategy,
      disabled,
      settings: groupSettingsOf(strategy, members.length - disabled.length),
      chats: chats.sort(byName),
    });
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

  // A persona's picture is listed, not read: only the ones the reader picks are.
  // One past its cap is said up front, by size; one no persona names is not ours.
  const personas = settings.personas.map((persona): StPersona => {
    const image = avatars.get(persona.avatar);
    if (!image) return persona;
    if (image.size > limits.avatar) {
      skipped.push({ path: image.path, reason: 'too_large' });
      return persona;
    }
    return { ...persona, image };
  });

  return {
    characters: characters.sort((a, b) => (a.avatar < b.avatar ? -1 : a.avatar > b.avatar ? 1 : 0)),
    groups: groups.sort(byName),
    personas,
    worlds,
    globalWorlds: settings.globalWorlds,
    globalRegex: settings.globalRegex,
    ...(settingsJson ? { worldInfoSettings: settings.worldInfoSettings } : {}),
    skipped,
  };
}
