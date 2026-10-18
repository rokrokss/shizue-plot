/**
 * Prompt presets in RisuAI's shape (ARCHITECTURE §6 프리셋): the prompt fields of
 * its `botPreset` — the main prompt, jailbreak and global note, the order
 * `sendChat` sends its blocks in without a prompt template (`formatingOrder`),
 * and the prompt template that replaces that order when there is one — with
 * the two settings of a group chat's messages. The assembler builds every
 * request from one (`assemblePrompt`); a chat runs the built-in default unless
 * its reader picked a preset of their own, which replaces it, as picking a
 * preset does in PocketRisu.
 */
import { OAI2_MAIN, OAI2_PREFILL, OAI2_RESPONSE, OAI_JAILBREAK } from './oai2.js';

/** The role a template item is sent as: RisuAI's `PromptRole`. */
export type PromptItemRole = 'user' | 'bot' | 'system';

/** RisuAI's `PromptItemPlain`: text of the preset's own. */
export interface PromptItemPlain {
  type: 'plain' | 'jailbreak' | 'cot';
  /** `main` and `globalNote` are what a card's system prompt and global-note replacement stand in for. */
  type2: 'normal' | 'globalNote' | 'main';
  text: string;
  role: PromptItemRole;
  name?: string;
}

/** RisuAI's `PromptItemTyped`: a block of the chat's own, wrapped in `innerFormat`'s `{{slot}}`. */
export interface PromptItemTyped {
  type: 'persona' | 'description' | 'lorebook' | 'postEverything' | 'memory';
  innerFormat?: string;
  role2?: PromptItemRole;
  name?: string;
}

/** RisuAI's `PromptItemAuthorNote`. */
export interface PromptItemAuthorNote {
  type: 'authornote';
  innerFormat?: string;
  /** Sent in the note's place when the chat has none. */
  defaultText?: string;
  role2?: PromptItemRole;
  name?: string;
}

/** RisuAI's `PromptItemChat`: a stretch of the chat, `[rangeStart, rangeEnd)`, negative from the end. */
export interface PromptItemChat {
  type: 'chat';
  rangeStart: number;
  rangeEnd: number | 'end';
  chatAsOriginalOnSystem?: boolean;
  name?: string;
}

/** RisuAI's `PromptItemChatML`: messages written out in ChatML. Not sent yet. */
export interface PromptItemChatML {
  type: 'chatML';
  text: string;
  name?: string;
}

/** RisuAI's `PromptItemCache`: a Claude cache point. Our provider caches by itself, so it sends nothing. */
export interface PromptItemCache {
  type: 'cache';
  name?: string;
  depth: number;
  role: 'user' | 'assistant' | 'system' | 'all';
}

/** One item of a RisuAI prompt template (`PromptItem`). */
export type PromptTemplateItem =
  | PromptItemPlain
  | PromptItemTyped
  | PromptItemAuthorNote
  | PromptItemChat
  | PromptItemChatML
  | PromptItemCache;

/** RisuAI's `FormatingOrderItem`. */
export type FormatOrderItem =
  | 'main'
  | 'jailbreak'
  | 'chats'
  | 'lorebook'
  | 'globalNote'
  | 'authorNote'
  | 'lastChat'
  | 'description'
  | 'postEverything'
  | 'personaPrompt';

const FORMAT_ORDER_ITEMS: readonly FormatOrderItem[] = [
  'main',
  'jailbreak',
  'chats',
  'lorebook',
  'globalNote',
  'authorNote',
  'lastChat',
  'description',
  'postEverything',
  'personaPrompt',
];

/** RisuAI's default `formatingOrder` (`database.svelte.ts`); `sendChat` appends `postEverything`. */
export const RISU_DEFAULT_FORMATING_ORDER: readonly FormatOrderItem[] = [
  'main',
  'description',
  'personaPrompt',
  'chats',
  'lastChat',
  'jailbreak',
  'lorebook',
  'globalNote',
  'authorNote',
];

/** How a group chat sends another member's message (RisuAI's `groupOtherBotRole`, default `user`). */
export type GroupOtherBotRole = 'user' | 'assistant' | 'system';

/** RisuAI's default `groupTemplate`, which a preset's empty one falls back to. */
export const DEFAULT_GROUP_TEMPLATE = "<{{char}}'s Message>\n{{slot}}\n</{{char}}'s Message>";

/** A prompt preset: RisuAI's `botPreset`, the fields that make the prompt. */
export interface PromptPreset {
  mainPrompt: string;
  jailbreak: string;
  globalNote: string;
  formatingOrder: readonly FormatOrderItem[];
  /** RisuAI's `promptTemplate`: when there is one — even empty — the three texts and the order are not read. */
  promptTemplate: readonly PromptTemplateItem[] | null;
  /** RisuAI's `groupTemplate`; '' for its default (`DEFAULT_GROUP_TEMPLATE`). */
  groupTemplate: string;
  groupOtherBotRole: GroupOtherBotRole;
}

/**
 * The built-in preset every chat runs unless its reader picked one of their
 * own: PocketRisu's "Default Prompt" (OAI2), the template its "new preset"
 * clones, with the OAI preset's jailbreak after everything — the text the
 * owner had sent on every reply since 2026-10-18 (`oai2.ts`). A card's system
 * prompt is not read under it, as RisuAI reads none under a template.
 */
export const DEFAULT_PRESET: PromptPreset = {
  mainPrompt: '',
  jailbreak: '',
  globalNote: '',
  formatingOrder: RISU_DEFAULT_FORMATING_ORDER,
  promptTemplate: [
    { type: 'plain', type2: 'main', text: OAI2_MAIN, role: 'system' },
    { type: 'description', innerFormat: '[Roleplay Setting]\n{{slot}}\n' },
    { type: 'persona', innerFormat: '[{{user}} Character Profile]\n{{slot}}\n' },
    { type: 'plain', type2: 'normal', text: '[Supplementary Information]\n', role: 'system' },
    { type: 'lorebook' },
    { type: 'plain', type2: 'globalNote', text: '', role: 'system' },
    { type: 'authornote' },
    { type: 'memory', innerFormat: '[Roleplay Summary]\n{{slot}}\n' },
    { type: 'plain', type2: 'normal', text: OAI2_RESPONSE, role: 'system' },
    { type: 'chat', rangeStart: 0, rangeEnd: -2, chatAsOriginalOnSystem: true },
    { type: 'chat', rangeStart: -2, rangeEnd: 'end' },
    { type: 'postEverything' },
    { type: 'jailbreak', type2: 'normal', text: OAI_JAILBREAK, role: 'system' },
    { type: 'plain', type2: 'normal', text: OAI2_PREFILL, role: 'bot' },
  ],
  groupTemplate: '',
  groupOtherBotRole: 'user',
};

/**
 * RisuAI's utility-bot template (`sendChat`, `currentChar.utilityBot`): the
 * card's description, its lore, the whole chat and its global-note replacement,
 * with nothing of the preset's around them.
 */
export const UTILITY_TEMPLATE: readonly PromptTemplateItem[] = [
  { type: 'plain', type2: 'main', text: '', role: 'system' },
  { type: 'description' },
  { type: 'lorebook' },
  { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
  { type: 'plain', type2: 'globalNote', text: '', role: 'system' },
  { type: 'postEverything' },
];

/** The built-in presets, keyed by the id a chat stores. */
export const PRESETS = { default: DEFAULT_PRESET } as const satisfies Record<string, PromptPreset>;

export type PresetId = keyof typeof PRESETS;

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export function isPresetId(value: unknown): value is PresetId {
  // Own keys only: `in` would accept 'toString', '__proto__' and friends.
  return typeof value === 'string' && Object.hasOwn(PRESETS, value);
}

/** The built-in preset for a stored id, the default for anything else — the five style presets that were. */
export function getPreset(id: string | null | undefined): PromptPreset {
  return isPresetId(id) ? PRESETS[id] : DEFAULT_PRESET;
}

/**
 * The items a preset is sent by, and whether they stand for RisuAI's path
 * without a template (`legacy`): its `formatingOrder` in RisuAI's blocks, the
 * three texts in their places, `chats` the chat but its newest turn and
 * `lastChat` that turn — where a card's system prompt replaces the main prompt
 * and the start triggers' turns go around the newest one. `postEverything`
 * closes both, as `sendChat` appends it to either.
 */
export function templateOf(preset: PromptPreset): { items: PromptTemplateItem[]; legacy: boolean } {
  if (preset.promptTemplate) {
    const items = [...preset.promptTemplate];
    if (!items.some((item) => item.type === 'postEverything')) items.push({ type: 'postEverything' });
    return { items, legacy: false };
  }
  const items: PromptTemplateItem[] = [];
  for (const block of [...preset.formatingOrder, 'postEverything' as const]) {
    switch (block) {
      case 'main':
        items.push({ type: 'plain', type2: 'main', text: preset.mainPrompt, role: 'system' });
        break;
      case 'jailbreak':
        items.push({ type: 'jailbreak', type2: 'normal', text: preset.jailbreak, role: 'system' });
        break;
      case 'globalNote':
        items.push({ type: 'plain', type2: 'globalNote', text: preset.globalNote, role: 'system' });
        break;
      case 'chats':
        items.push({ type: 'chat', rangeStart: 0, rangeEnd: -1 });
        break;
      case 'lastChat':
        items.push({ type: 'chat', rangeStart: -1, rangeEnd: 'end' });
        break;
      case 'description':
        items.push({ type: 'description' });
        break;
      case 'personaPrompt':
        items.push({ type: 'persona' });
        break;
      case 'lorebook':
        items.push({ type: 'lorebook' });
        break;
      case 'authorNote':
        items.push({ type: 'authornote' });
        break;
      case 'postEverything':
        items.push({ type: 'postEverything' });
        break;
    }
  }
  return { items, legacy: true };
}

/* ------------------------------------------------------------ normalizing */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const nameOf = (value: unknown): { name?: string } => (typeof value === 'string' && value ? { name: value } : {});

/** RisuAI's `normalizePromptRole`: `assistant` and `char` are the bot, anything unknown the system. */
export function promptItemRole(role: unknown): PromptItemRole {
  if (role === 'user' || role === 'bot' || role === 'system') return role;
  if (role === 'assistant' || role === 'char') return 'bot';
  return 'system';
}

const optionalRole = (role: unknown): { role2?: PromptItemRole } =>
  role === undefined || role === null || role === '' ? {} : { role2: promptItemRole(role) };

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;

/** One stored or imported template item, in our shape, or null for a type RisuAI has not. */
export function promptTemplateItem(value: unknown): PromptTemplateItem | null {
  if (!isObject(value)) return null;
  const type = value['type'];
  switch (type) {
    case 'plain':
    case 'jailbreak':
    case 'cot': {
      const type2 = value['type2'];
      return {
        type,
        type2: type2 === 'main' || type2 === 'globalNote' ? type2 : 'normal',
        text: textOf(value['text']),
        role: promptItemRole(value['role']),
        ...nameOf(value['name']),
      };
    }
    case 'persona':
    case 'description':
    case 'lorebook':
    case 'postEverything':
    case 'memory': {
      const innerFormat = textOf(value['innerFormat']);
      return { type, ...(innerFormat ? { innerFormat } : {}), ...optionalRole(value['role2']), ...nameOf(value['name']) };
    }
    case 'authornote': {
      const innerFormat = textOf(value['innerFormat']);
      const defaultText = textOf(value['defaultText']);
      return {
        type,
        ...(innerFormat ? { innerFormat } : {}),
        ...(defaultText ? { defaultText } : {}),
        ...optionalRole(value['role2']),
        ...nameOf(value['name']),
      };
    }
    case 'chat':
      return {
        type,
        rangeStart: finiteOr(value['rangeStart'], 0),
        rangeEnd: value['rangeEnd'] === 'end' ? 'end' : finiteOr(value['rangeEnd'], 0),
        ...(value['chatAsOriginalOnSystem'] === true ? { chatAsOriginalOnSystem: true } : {}),
        ...nameOf(value['name']),
      };
    case 'chatML':
      return { type, text: textOf(value['text']), ...nameOf(value['name']) };
    case 'cache': {
      const role = value['role'];
      return {
        type,
        depth: finiteOr(value['depth'], 0),
        role: role === 'user' || role === 'assistant' || role === 'system' ? role : 'all',
        ...nameOf(value['name']),
      };
    }
    default:
      return null;
  }
}

/** A stored or imported template: its items in our shape (unknown ones dropped), or null for none. */
export function normalizePromptTemplate(value: unknown): PromptTemplateItem[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) => {
    const normalized = promptTemplateItem(item);
    return normalized ? [normalized] : [];
  });
}

/** A stored or imported `formatingOrder`: its known blocks once each, or RisuAI's default where there is none. */
export function normalizeFormatingOrder(value: unknown): FormatOrderItem[] {
  if (!Array.isArray(value)) return [...RISU_DEFAULT_FORMATING_ORDER];
  const seen = new Set<FormatOrderItem>();
  for (const item of value) {
    if (typeof item === 'string' && (FORMAT_ORDER_ITEMS as readonly string[]).includes(item)) seen.add(item as FormatOrderItem);
  }
  // `postEverything` is `sendChat`'s to append.
  seen.delete('postEverything');
  return [...seen];
}

/** A stored `groupOtherBotRole`, RisuAI's `user` for anything else. */
export function groupOtherBotRoleOf(value: unknown): GroupOtherBotRole {
  return value === 'assistant' || value === 'system' ? value : 'user';
}

/* ------------------------------------------------------------ speech protocol */

/**
 * The format rule a reply of one asked voice — a work of one member, or a
 * scene — is taught, so the chat can draw a character's lines as bubbles and
 * the rest as narration, Zeta's way (§6 발화 프로토콜, kept on 2026-10-18 when
 * the prompt went RisuAI's way). `speech.ts` reads exactly this shape. It is
 * no part of any preset: the assembler adds it at the end of the leading
 * system turns whatever the preset says, and leaves it out of a group turn,
 * whose reply is one member's whole, and of a utility bot.
 */
export function speechProtocol(names: readonly string[]): string {
  const list = names.filter((name) => name.trim()).join(', ');
  return `Speech rules:
- Write a character's words and actions on a line that starts with \`Name: \`${list ? `, the name written exactly as one of: ${list}` : ''}.
- Within that line, write actions, expressions and gestures as *descriptions wrapped in asterisks*; the rest is what that character says aloud.
- Write the scene, setting and situation on lines with no prefix. Those lines are this reply's own narration, written alongside the characters' words, and dialogue goes only on \`Name: \` lines.
- Several characters may take turns in one reply. Bring in only the characters the scene needs, and do not invent characters who do not exist.`;
}

/** The speech protocol as a one-line reminder, at the start of what follows the chat. */
export const SPEECH_PROTOCOL_REMINDER =
  "Write a character's words and actions on `Name: ` lines, the actions within those lines in *asterisks*, and the scene as this reply's own narration on lines with no prefix.";

/** RisuAI's line that closes a group speaker's request (`sendChat`, `postEverything`). */
export const groupSpeakerLine = (name: string): string => `[Write the next reply only as ${name}]`;
