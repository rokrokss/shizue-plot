/**
 * RisuAI's chat files, both ways — `importChat`, `exportChat` and
 * `exportAllChats` in `src/ts/characters.ts` (RisuAI main e773240).
 *
 * A RisuAI chat (`Chat` in `src/ts/storage/database.svelte.ts`) is a straight
 * line of messages — RisuAI keeps no swipes — beside what belongs to the chat as
 * a whole: its name, its author's note (`note`), its own lore (`localLore`), its
 * variables (`scriptstate`, each under a `$` before its name, as `setChatVar`
 * writes it) and which of the character's greetings it opened on (`fmIndex`: -1
 * the first message, k the k-th alternate greeting). The greeting is not one of
 * the messages: RisuAI shows and sends the character's own greeting at
 * `fmIndex` above them. A message keeps who said it (`role`: `user` or `char`,
 * and in a group `saying`, the character's id), when (`time`), and whether it is
 * left out of the prompt (`disabled`: `true` for itself, `'allBefore'` for
 * itself and everything above it — `makeMs` in `src/ts/process/index.svelte.ts`).
 *
 * RisuAI reads four shapes back: `{type: 'risuChat' | 'risuAllChats', ver: 2,
 * data, folders}` (one chat, or every chat of a character, with their folders),
 * the older `{type: 'risuAllChats', ver: 1, data: Chat[]}` and `{type:
 * 'risuChat', ver: 1, data: Chat}`, and the HTML page its export writes, whose
 * `.idat` element holds the chat as JSON (the page is the web's to read). A
 * SillyTavern `.jsonl` goes through `convertSillyTavernChat`, as the migration's
 * chats do.
 *
 * Pure: the browser converts what it is given, and the server writes the files
 * from what it has (`risuChatOf`).
 */

import { risuLoreBookEntry } from './card/risuModule.js';
import { risuLore } from './triggers/scripts.js';
import type { ImportedChatMessage, LoreEntry } from './types.js';
import {
  MAX_DELTA_CHARS,
  MAX_DELTA_KEYS,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  type Variables,
} from './variables.js';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** One message as RisuAI keeps it (`Message`), what this reads and writes of it. */
export interface RisuMessage {
  role: 'user' | 'char';
  data: string;
  /** The character that said it — every reply RisuAI writes names its character's `chaId`. */
  saying?: string;
  /** The message's own id. */
  chatId?: string;
  /** Epoch milliseconds. */
  time?: number;
  /** Who said it, where RisuAI keeps a name. Written here beside `saying` for a group reply. */
  name?: string;
  disabled?: boolean | 'allBefore';
}

/** One of RisuAI's lore entries (`loreBook`), as RisuAI's chat `localLore` holds them. */
export interface RisuLoreBook {
  key: string;
  secondkey: string;
  insertorder: number;
  comment: string;
  content: string;
  mode: 'normal';
  alwaysActive: boolean;
  selective: boolean;
  useRegex: boolean;
  extentions: { risu_case_sensitive: boolean };
}

/** A RisuAI chat (`Chat`), what this writes of it. */
export interface RisuChat {
  message: RisuMessage[];
  note: string;
  name: string;
  localLore: RisuLoreBook[];
  fmIndex: number;
  id: string;
  scriptstate: Record<string, string>;
  lastDate: number;
}

/** `exportChat`'s JSON (`risuChat` v2): one chat, and the folder it is in — never one here. */
export interface RisuChatFile {
  type: 'risuChat';
  ver: 2;
  data: RisuChat;
  folders: [];
}

/** `exportAllChats`'s JSON (`risuAllChats` v2): every chat of a character. */
export interface RisuAllChatsFile {
  type: 'risuAllChats';
  ver: 2;
  data: RisuChat[];
  folders: [];
}

/** Chats one file may bring; RisuAI has no limit, and a work's chat list is read whole. */
export const MAX_RISU_CHATS_PER_FILE = 500;

/**
 * The chats a RisuAI chat file holds, by RisuAI's own rules (`importChat`), or
 * null where RisuAI says there is nothing to import (`errors.noData`):
 *
 * - `risuChat` or `risuAllChats`, `ver` 2: `data`, one chat or an array of them;
 * - `risuAllChats`, `ver` 1: `data`, a non-empty array;
 * - `risuChat`, `ver` 1: `data`, with `message`, `note`, `name` and `localLore`
 *   all present.
 *
 * RisuAI takes whatever `data` holds; here a chat is an object whose `message`
 * is an array, and one that is not is passed over — the file's other chats
 * still come. Past `MAX_RISU_CHATS_PER_FILE` the rest are left out.
 */
export function readRisuChatFile(json: unknown): Json[] | null {
  if (!isObject(json)) return null;
  const { type, ver, data } = json;
  let chats: unknown[];
  if ((type === 'risuAllChats' || type === 'risuChat') && ver === 2) {
    chats = Array.isArray(data) ? data : [data];
  } else if (type === 'risuAllChats' && ver === 1) {
    if (!Array.isArray(data) || data.length === 0) return null;
    chats = data;
  } else if (type === 'risuChat' && ver === 1) {
    if (!isObject(data) || [data['message'], data['note'], data['name'], data['localLore']].some((v) => v == null)) {
      return null;
    }
    chats = [data];
  } else {
    return null;
  }
  const kept = chats.filter(isRisuChat).slice(0, MAX_RISU_CHATS_PER_FILE);
  return kept.length > 0 ? kept : null;
}

/** Whether `value` is a chat this can read: an object whose `message` is an array. */
export const isRisuChat = (value: unknown): value is Json => isObject(value) && Array.isArray(value['message']);

/** The work a chat comes into, as the conversion matches RisuAI's `saying` against it. */
export interface RisuCast {
  /** The roster, in order. With two or more, a reply that names one of them by id or name is tagged with it. */
  members: { id: string; name: string }[];
}

export interface RisuConvertedChat {
  /** The chat's name (RisuAI's `name`), trimmed; '' when it has none. */
  name: string;
  /**
   * Which of the work's openings the chat opens on: RisuAI's `fmIndex` + 1, so
   * 0 is the first message and k the k-th alternate greeting. RisuAI's greeting
   * is the character's, not the chat's, so the import puts the work's own there.
   */
  openingIndex: number;
  messages: ImportedChatMessage[];
  /** The author's note, without the U+0000 Postgres cannot store. */
  note: string;
  /** `scriptstate`'s chat variables (`$name`), each as RisuAI reads one back; null when it has none. */
  variables: Variables | null;
  /** The chat's own lore (`localLore`), in ours. */
  localLore: LoreEntry[];
  skipped: {
    /** Messages with no text. */
    empty: number;
    /** Messages that are not a RisuAI message: no `role` of `user` or `char`, or `data` not a string. */
    malformed: number;
    /** Replies in a work of several members whose `saying` names none of them, left untagged. */
    unknownSpeaker: number;
    /** Variables past the delta limits, or values that are not a string, a number or a boolean. */
    variables: number;
    /** Bookmarks: shizue has none to put them in. */
    bookmarks: number;
    /** Messages past `MAX_RISU_CHAT_MESSAGES`. */
    overLimit: number;
  };
}

/** Messages converted per chat, as a SillyTavern chat's are (`MAX_CHAT_MESSAGES`). */
export const MAX_RISU_CHAT_MESSAGES = 20_000;

const NUL = /\u0000/g;

/** RisuAI's `fmIndex`: -1, or the index of an alternate greeting. Anything else is the first message. */
function fmIndexOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= -1 ? value : -1;
}

/**
 * `scriptstate`'s chat variables. RisuAI keeps a chat variable under `$` and its
 * name (`setChatVar`) and reads it back with `toString()` (`getChatVar`), so a
 * number is its digits and a boolean `true` or `false`; a key without the `$`
 * is not a chat variable. Each is weighed against the limits a stored delta is
 * held to (`checkVariableDelta`) in the file's order, and one that does not fit
 * is left out and counted.
 */
function readScriptState(value: unknown): { variables: Variables | null; dropped: number } {
  if (!isObject(value)) return { variables: null, dropped: 0 };
  const variables = Object.create(null) as Variables;
  let kept = 0;
  let chars = 0;
  let dropped = 0;
  for (const key of Object.keys(value)) {
    if (!key.startsWith('$')) continue;
    const name = key.slice(1);
    const raw = value[key];
    const text =
      typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined;
    const size = name.length + (text?.length ?? 0);
    if (
      text === undefined ||
      !name ||
      name.length > MAX_VARIABLE_NAME_LENGTH ||
      text.length > MAX_VARIABLE_VALUE_LENGTH ||
      name.includes('\u0000') ||
      text.includes('\u0000') ||
      kept >= MAX_DELTA_KEYS ||
      chars + size > MAX_DELTA_CHARS
    ) {
      dropped += 1;
      continue;
    }
    variables[name] = text;
    kept += 1;
    chars += size;
  }
  return { variables: kept > 0 ? variables : null, dropped };
}

/** An epoch-milliseconds time as ISO 8601, or undefined where it is none. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * One RisuAI chat as the chat import takes it (`POST /api/chats/import`).
 *
 * Each message is one version, as RisuAI keeps one, its text as RisuAI stored it
 * — no speaker prefix, since a RisuAI reply is its character's whole, and
 * `{{char}}`, `{{user}}` and the rest stay macros, read where the chat is shown
 * and sent as RisuAI reads them there. `user` is the reader, `char` a reply. A
 * message RisuAI leaves out of the prompt comes in hidden from the AI: `disabled`
 * `true` that message, `'allBefore'` that one and every one above it. In a work
 * of two or more members a reply is tagged with the member its `saying` names —
 * by id, which only this work's own export carries, or by the `name` beside it —
 * and is otherwise left untagged and counted. RisuAI's comments (`isComment`)
 * are sent like any message there, so they come in as messages.
 *
 * What the chat keeps as a whole comes along for the import's completion: the
 * note, the variables (`readScriptState`) and the chat's lore. Bookmarks are
 * counted, as there is nothing to keep them in; folders, the memory RisuAI
 * built (`hypaV3Data` and the rest), the chat's modules, its bound persona and
 * its local toggles are not read. Never throws.
 */
export function convertRisuChat(chat: Json, cast: RisuCast): RisuConvertedChat {
  const skipped: RisuConvertedChat['skipped'] = {
    empty: 0,
    malformed: 0,
    unknownSpeaker: 0,
    variables: 0,
    bookmarks: Array.isArray(chat['bookmarks']) ? chat['bookmarks'].length : 0,
    overLimit: 0,
  };
  const group = cast.members.length >= 2;
  const byId = new Map(cast.members.map((member) => [member.id, member.id]));
  const byName = new Map(cast.members.map((member) => [member.name.trim(), member.id]));

  const source = Array.isArray(chat['message']) ? chat['message'] : [];
  // RisuAI's `makeMs` stops at the last `allBefore`: it and everything above it are left out.
  let hiddenThrough = -1;
  source.forEach((message, index) => {
    if (isObject(message) && message['disabled'] === 'allBefore') hiddenThrough = index;
  });

  const messages: ImportedChatMessage[] = [];
  source.forEach((raw, index) => {
    if (!isObject(raw) || (raw['role'] !== 'user' && raw['role'] !== 'char') || typeof raw['data'] !== 'string') {
      skipped.malformed += 1;
      return;
    }
    const text = raw['data'].replace(/\r\n?/g, '\n').replace(NUL, '');
    if (!text.trim()) {
      skipped.empty += 1;
      return;
    }
    if (messages.length >= MAX_RISU_CHAT_MESSAGES) {
      skipped.overLimit += 1;
      return;
    }
    const role = raw['role'] === 'user' ? 'user' : 'assistant';
    let speakerId: string | undefined;
    if (role === 'assistant' && group) {
      const saying = typeof raw['saying'] === 'string' ? raw['saying'] : '';
      const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
      speakerId = byId.get(saying) ?? (name ? byName.get(name) : undefined);
      if (!speakerId) skipped.unknownSpeaker += 1;
    }
    const createdAt = isoOf(raw['time']);
    const hidden = raw['disabled'] === true || index <= hiddenThrough;
    messages.push({
      role,
      versions: [text],
      selected: 0,
      ...(createdAt ? { createdAt } : {}),
      ...(speakerId ? { speakerId } : {}),
      ...(hidden ? { hidden: true } : {}),
    });
  });

  const { variables, dropped } = readScriptState(chat['scriptstate']);
  skipped.variables = dropped;
  const lore = Array.isArray(chat['localLore']) ? chat['localLore'] : [];
  return {
    name: typeof chat['name'] === 'string' ? chat['name'].trim() : '',
    openingIndex: fmIndexOf(chat['fmIndex']) + 1,
    messages,
    note: typeof chat['note'] === 'string' ? chat['note'].replace(NUL, '') : '',
    variables,
    localLore: lore.filter(isObject).map(risuLoreBookEntry),
    skipped,
  };
}

/* ------------------------------------------------------------------ export */

/** A message of the branch being written out, as `risuChatOf` reads it. */
export interface RisuExportMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  /** A group reply's member, and the name it goes by. */
  speaker?: { id: string; name: string };
  hidden?: boolean;
}

/** A lore entry of ours in RisuAI's shape (`loreBook`), as the chat's `localLore` keeps it. */
export const toRisuLoreBook = (entry: LoreEntry): RisuLoreBook => ({
  ...risuLore(entry),
  mode: 'normal',
  useRegex: entry.useRegex,
  extentions: { risu_case_sensitive: entry.caseSensitive },
});

/**
 * The chat as RisuAI keeps one (`Chat`), for its export: the branch the chat is
 * on as `message` — without its opening where the branch opens on one of the
 * work's (`fmIndex` then says which, as RisuAI numbers its greetings) — and the
 * chat's name, note, lore and variables. A group reply names its member as
 * `saying` and `name`; a message hidden from the AI is `disabled`.
 */
export function risuChatOf(chat: {
  id: string;
  name: string;
  note: string;
  /** -1 for the first opening, k for the k-th after it; -1 too where the branch opens on none. */
  fmIndex: number;
  messages: readonly RisuExportMessage[];
  localLore: readonly LoreEntry[];
  /** The chat's variables as RisuAI would hold them: what the chat set, not the work's defaults. */
  variables: Variables;
  lastDate: Date;
}): RisuChat {
  const scriptstate: Record<string, string> = {};
  for (const name of Object.keys(chat.variables)) scriptstate[`$${name}`] = chat.variables[name]!;
  return {
    message: chat.messages.map((message) => ({
      role: message.role === 'user' ? 'user' : 'char',
      data: message.content,
      chatId: message.id,
      time: message.createdAt.getTime(),
      ...(message.speaker ? { saying: message.speaker.id, name: message.speaker.name } : {}),
      ...(message.hidden ? { disabled: true } : {}),
    })),
    note: chat.note,
    name: chat.name,
    localLore: chat.localLore.map(toRisuLoreBook),
    fmIndex: chat.fmIndex,
    id: chat.id,
    scriptstate,
    lastDate: chat.lastDate.getTime(),
  };
}

/** `exportChat`'s JSON. */
export const risuChatFile = (chat: RisuChat): RisuChatFile => ({ type: 'risuChat', ver: 2, data: chat, folders: [] });

/** `exportAllChats`'s JSON. */
export const risuAllChatsFile = (chats: RisuChat[]): RisuAllChatsFile => ({
  type: 'risuAllChats',
  ver: 2,
  data: chats,
  folders: [],
});

/** Who said each message, as RisuAI's text and HTML exports head it. */
export interface RisuTranscriptNames {
  /** The character: the member of a work of one, else the work. */
  char: string;
  user: string;
  /** The greeting the chat opens on, written first; absent where it opens on none. */
  greeting?: string;
  /** A work of two or more members: RisuAI writes no greeting above a group chat's text. */
  group: boolean;
}

const speakerOf = (message: RisuMessage, names: RisuTranscriptNames): string =>
  message.name && message.saying ? message.name : message.role === 'char' ? names.char : names.user;

/**
 * `exportChat`'s text: each message under `--` and its speaker's name, a blank
 * line between, and — for a character, not a group — the greeting first under
 * the character's. RisuAI writes the card's first message there whichever
 * greeting the chat is on; this writes the one it is on.
 */
export function risuChatText(chat: RisuChat, names: RisuTranscriptNames): string {
  const body = chat.message.map((message) => `--${speakerOf(message, names)}\n${message.data}`).join('\n\n');
  return !names.group && names.greeting !== undefined ? `--${names.char}\n${names.greeting}\n\n${body}` : body;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A message's text as the HTML export shows it: escaped, its line breaks kept. */
const htmlText = (text: string): string => escapeHtml(text).replace(/\n/g, '<br>');

/**
 * `exportChat`'s HTML file: RisuAI's page — the greeting and then each message
 * under its speaker's name — with the chat itself as JSON in the hidden `.idat`
 * element, which RisuAI's import (and ours) reads back. RisuAI renders each
 * message as markdown; this writes the text as it is, escaped, so nothing a
 * message holds runs when the file is opened. `&` is escaped in the JSON too
 * (RisuAI escapes only the angle brackets), so the text an importer reads back
 * is the text written.
 */
export function risuChatHtml(chat: RisuChat, names: RisuTranscriptNames): string {
  const blocks = [
    ...(names.greeting !== undefined ? [{ name: names.char, text: names.greeting }] : []),
    ...chat.message.map((message) => ({ name: speakerOf(message, names), text: message.data })),
  ];
  const body = blocks
    .map(({ name, text }) => `<div class="chat">\n<h2>${escapeHtml(name)}</h2>\n<div>${htmlText(text)}</div>\n</div>`)
    .join('\n');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(names.char)} Chat</title>
<style>
body{font-family:Arial,sans-serif;display:flex;justify-content:center;}
.container{max-width:800px;padding:1rem;border-radius:10px;display:flex;flex-direction:column;gap:1rem;}
.chat{background:#f0f0f0;padding:1rem;border-radius:10px;display:flex;flex-direction:column;}
.idat{display:none;}
h2{margin:0;}
.chat div{margin-top:0.5rem;overflow-wrap:anywhere;}
</style>
</head>
<body>
<div class="container">
${body}
</div>
<div class="idat">${escapeHtml(JSON.stringify(chat))}</div>
</body>
</html>
`;
}

/**
 * The name RisuAI gives an export (`${name}_${date}_chat`, `${name}_all_chats_${date}`)
 * without the characters a file name cannot hold — nor `.` and `,`, which
 * RisuAI takes out too — and the extension after.
 */
export const risuExportFileName = (base: string, ext: 'json' | 'txt' | 'html'): string =>
  `${base.replace(/[<>:"/\\|?*.,\u0000-\u001f]/g, '')}.${ext}`;
