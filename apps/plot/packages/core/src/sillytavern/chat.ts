/**
 * A SillyTavern chat file as the chat import takes it. The file is JSONL: a
 * header line (`{ user_name, character_name, create_date?, chat_metadata }`) and
 * then one message per line (`{ name, is_user, is_system, send_date, mes,
 * swipes?, swipe_id?, extra?, original_avatar? }`) — `saveChat` in
 * `public/script.js`, `saveReply` for the swipes.
 *
 * Who said what goes into our speech protocol here (`speech.ts`): a character's
 * lines are prefixed with their roster name — or, in a group chat going into a
 * work of two or more members, the message is tagged with its speaker and keeps
 * its text, as a group turn's reply does (`group.ts`) — and ST's narrator (`/sys`,
 * `extra.type === 'narrator'`, `sendNarratorMessage` in
 * `public/scripts/slash-commands.js`) becomes our narration (`@:`,
 * `narration.ts`). An unprefixed line is no longer the narrator's: in a work of
 * one member it is that character's own 지문.
 * A message ST keeps out of the prompt (`is_system`) arrives hidden from the AI
 * (`ImportedChatMessage.hidden`): one the reader hid (`/hide`, the ghost), and a
 * comment (`/comment`, `extra.type === 'comment'`), which is nobody's line and
 * comes in as a narration. What ST writes itself — its notices
 * (`systemUserName`, `public/scripts/system-messages.js`) and its tool calls
 * (`extra.tool_invocations`) — is not the conversation and is left out.
 *
 * The header's `chat_metadata` is where ST keeps what belongs to the chat rather
 * than to any one message, and three parts of it come along: the chat's
 * variables (`variables`, `public/scripts/variables.js`), its author's note
 * (`note_prompt` and the four `note_*` placement keys, `public/scripts/authors-note.js`)
 * and the World Info file bound to it (`world_info`, ST's "Chat Lore"). What
 * becomes of each is the import's to decide; this only reads them.
 */

import { AUTHOR_NOTE_MAX, coerceAuthorNoteSettings, type AuthorNoteRole, type AuthorNoteSettings } from '../authorNote.js';
import { withNarrationPrefix } from '../narration.js';
import { spokenBy } from '../speech.js';
import type { ImportedChatMessage, ImportedMessageExtra } from '../types.js';
import {
  MAX_DELTA_CHARS,
  MAX_DELTA_KEYS,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
  type Variables,
} from '../variables.js';

export interface StCast {
  /**
   * The plot's roster, under the names it was imported with. With the member ids
   * of two or more, the chat is a group chat going into a work of group turns:
   * each character message is tagged with its speaker (`speakerId`) rather than
   * prefixed. With fewer, every message is prefixed, as before group turns.
   */
  members: { name: string; avatar?: string; id?: string }[];
}

/**
 * The chat's author's note as ST keeps it in `chat_metadata`, each placement key
 * read as a number and filled with ST's own default where the file has none
 * (`loadSettings` in `authors-note.js` does the same, from the reader's defaults
 * in `settings.json` first — which this cannot see).
 */
export interface StAuthorNote {
  /** `note_prompt`. */
  text: string;
  /** `note_interval`: inserted on every this-many-th user turn; 0 (or less) never. */
  interval: number;
  /** `note_position`: 0 after the story string, 1 in the chat at `depth`, 2 before the story string. */
  position: number;
  /** `note_depth`: messages from the end, for position 1. */
  depth: number;
  /** `note_role`: 0 system, 1 user, 2 assistant. */
  role: number;
}

/**
 * ST's defaults for a chat's author's note — in the chat, four messages from the
 * end, as a system message, every turn. They are a chat's default note settings
 * here too (`AUTHOR_NOTE_DEFAULTS`), so a note that keeps them comes over with
 * no settings of its own.
 */
export const ST_AUTHOR_NOTE_DEFAULTS = { interval: 1, position: 1, depth: 4, role: 0 } as const;

/** `note_role` by number, as ST's `extension_prompt_roles` counts them. */
const ST_NOTE_ROLES: readonly AuthorNoteRole[] = ['system', 'user', 'assistant'];

/**
 * Whether the note keeps ST's place once it is ours: position 1, in the chat at
 * its depth, is the one place both have. Before or after the story string
 * (positions 2 and 0, or a number ST never writes) has no match here.
 */
export const stNoteInChat = (note: StAuthorNote): boolean => note.position === 1;

/**
 * The note's settings as the chat keeps them (`chats.note_settings`): ST's depth,
 * its interval as the frequency (0 or less is never, as in ST) and its role by
 * number (one ST never writes is a system message). A note ST put before or
 * after the story string (`stNoteInChat`) goes as deep as a note can, which the
 * prompt clamps to the start of the history — the nearest the history comes to
 * the story string. Coerced as any stored settings are, so a note that keeps
 * ST's defaults has none.
 */
export const noteSettingsOfSt = (note: StAuthorNote): AuthorNoteSettings | null =>
  coerceAuthorNoteSettings({
    depth: stNoteInChat(note) ? note.depth : AUTHOR_NOTE_MAX,
    frequency: note.interval,
    role: ST_NOTE_ROLES[note.role] ?? 'system',
  });

export interface StConvertedChat {
  /** The persona name the chat was written under; '' when the file never says. */
  userName: string;
  characterName: string;
  /** ISO 8601, from an old header's `create_date`. */
  createdAt?: string;
  messages: ImportedChatMessage[];
  /**
   * The chat's variables as ST reads them back, within the limits a stored
   * variable delta is held to (`checkVariableDelta`); null when it has none. A
   * null-prototype map, since the names are whatever a card or a script chose.
   */
  variables: Variables | null;
  /** The author's note; absent when `note_prompt` is blank or missing. */
  authorNote?: StAuthorNote;
  /** The World Info file bound to this chat (`world_info`), by name. */
  worldName?: string;
  skipped: {
    /** What ST wrote itself — its notices and tool calls (`is_system`, see `convertSillyTavernChat`). */
    system: number;
    /** Messages with no text in any version. */
    empty: number;
    /** Character messages kept unprefixed and untagged because no roster member matched. */
    unknownSpeaker: number;
    /** Lines that are not a JSON object. */
    malformed: number;
    /** Messages past `MAX_CHAT_MESSAGES`. */
    overLimit: number;
    /** Chat variables past the delta limits — a name or a value too long, too many, too much in all. */
    variables: number;
  };
}

/** ST's name for the messages it writes itself (`systemUserName` in `public/script.js`). */
const ST_SYSTEM_NAME = 'SillyTavern System';

/** Messages converted per chat; the rest are counted in `overLimit`. */
export const MAX_CHAT_MESSAGES = 20_000;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const textOf = (value: unknown): string => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '');

/** `humanizedDateTime`, with and without the spaces older versions put in. */
const HUMANIZED_RE = /(\d{4})-(\d{1,2})-(\d{1,2}) ?@(\d{1,2})h ?(\d{1,2})m ?(\d{1,2})s(?: ?(\d{1,3})ms)?/;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function utc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
  ms = 0,
): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms)).toISOString();
}

function isoOf(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The shapes ST has written a time in, as its own `parseTimestamp` reads them
 * (`public/scripts/utils.js`): epoch milliseconds, ISO 8601 (what it writes now),
 * `June 19, 2023 2:20pm`, and `humanizedDateTime`'s — `2024-07-12@01h31m37s123ms`,
 * `2024-7-12@01h31m37s`, `2024-6-5 @14h 56m 50s 682ms`. The last two kinds carry
 * no zone; ST reads the humanized ones as UTC, and so does this, and the
 * meridiem one with them. Anything else is undefined.
 */
export function parseSillyTavernDate(value: unknown): string | undefined {
  if (typeof value === 'number') return value >= 0 ? isoOf(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return isoOf(Number(text));
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(text)) return isoOf(Date.parse(text));

  const meridiem = /([a-z]+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i.exec(text);
  if (meridiem) {
    const [, monthName, day, year, hour, minute, half] = meridiem;
    const month = MONTHS.indexOf(monthName!.slice(0, 3).toLowerCase()) + 1;
    const hour12 = Number(hour) % 12;
    const hour24 = half!.toLowerCase() === 'pm' ? hour12 + 12 : hour12;
    return month && Number(hour) <= 12
      ? utc(Number(year), month, Number(day), hour24, Number(minute))
      : undefined;
  }
  const humanized = HUMANIZED_RE.exec(text);
  if (humanized) {
    const [year, month, day, hour, minute, second, ms] = humanized.slice(1).map((part) => Number(part ?? 0));
    return utc(year!, month!, day!, hour!, minute!, second!, ms!);
  }
  return undefined;
}

/** The roster member a character message is attributed to (see `convertSillyTavernChat`). */
function speakerOf(cast: StCast, avatar: unknown, name: string): StCast['members'][number] | undefined {
  return (
    (typeof avatar === 'string' && avatar ? cast.members.find((m) => m.avatar === avatar) : undefined) ??
    cast.members.find((m) => m.name.trim() === name) ??
    (cast.members.length === 1 ? cast.members[0] : undefined)
  );
}

/** A string field of `extra`, without the U+0000 Postgres cannot store; undefined when blank. */
function extraText(extra: Json, key: string): string | undefined {
  const text = textOf(extra[key]).replace(/\u0000/g, '');
  return text.trim() ? text : undefined;
}

/**
 * What a message keeps of one version's `extra` (`ImportedMessageExtra`), or
 * null for none: the text ST shows in its place (`display_text`, which ST draws
 * as `extra.display_text || mes`, so a blank one is none), the reasoning, and the
 * bias.
 */
function extraOf(extra: unknown): ImportedMessageExtra | null {
  if (!isObject(extra)) return null;
  const displayText = extraText(extra, 'display_text');
  const reasoning = extraText(extra, 'reasoning');
  const bias = extraText(extra, 'bias');
  if (displayText === undefined && reasoning === undefined && bias === undefined) return null;
  return {
    ...(displayText !== undefined ? { displayText } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(bias !== undefined ? { bias } : {}),
  };
}

/**
 * The versions a message carries: its swipes when it has any, else its text.
 * `mes` is what ST shows and edits, so it fills the selected swipe's slot even
 * where the swipes array fell out of step. Blank versions are dropped, and the
 * selection follows the one it pointed at, or the first left when that is gone.
 *
 * Each version's `extra` comes with it: the message's own for the selected one
 * — ST keeps the live swipe's there — and `swipe_info[i].extra` for the others,
 * where ST keeps what each swipe had (`syncMesToSwipe`).
 */
function versionsOf(message: Json): { versions: string[]; selected: number; extras: (ImportedMessageExtra | null)[] } {
  const mes = textOf(message['mes']);
  const swipes = Array.isArray(message['swipes']) ? message['swipes'].map(textOf) : [];
  if (swipes.length === 0) return { versions: [mes], selected: 0, extras: [extraOf(message['extra'])] };

  const swipeId = message['swipe_id'];
  const selected =
    typeof swipeId === 'number' && Number.isInteger(swipeId)
      ? Math.min(Math.max(swipeId, 0), swipes.length - 1)
      : 0;
  if (typeof message['mes'] === 'string') swipes[selected] = mes;
  const info = Array.isArray(message['swipe_info']) ? message['swipe_info'] : [];
  const extras = swipes.map((_, index) => {
    if (index === selected) return extraOf(message['extra']);
    const swipe = info[index];
    return isObject(swipe) ? extraOf(swipe['extra']) : null;
  });

  const kept = swipes.map((text, index) => ({ text, index })).filter(({ text }) => text.trim());
  const at = kept.findIndex(({ index }) => index === selected);
  return {
    versions: kept.map(({ text }) => text),
    selected: Math.max(at, 0),
    extras: kept.map(({ index }) => extras[index] ?? null),
  };
}

/**
 * A header is the line with `chat_metadata`, or ST's two names without a message
 * text. Group chats older than ST's metadata migration
 * (`migrateGroupChatsMetadataFormat`, `src/endpoints/groups.js`) start with a
 * message instead.
 */
const isHeader = (line: Json): boolean =>
  'chat_metadata' in line || (('user_name' in line || 'character_name' in line) && !('mes' in line));

/** ST now writes 'unused' for both header names (`saveChat`). */
const headerName = (value: unknown): string =>
  typeof value === 'string' && value.trim() && value !== 'unused' ? value.trim() : '';

/**
 * A chat variable's value as a string, the way ST reads it back. ST's own writes
 * leave strings and numbers — `{{addvar}}` stores the sum as a number — and its
 * `getLocalVariable` reads anything that is a number to JavaScript as that
 * number: so `5` is `'5'`, `true` is `'1'`, and `null` (only an extension writes
 * one) is `'0'`. A string stays as it was written, though ST reads a numeric one
 * the same way (`'007'` comes back as 7): it is the reader's text, and the fold
 * does its own arithmetic on it.
 *
 * Arrays and objects are written out as JSON. ST would print them through
 * `String()` — `[object Object]` — which carries nothing; JSON is also what its
 * own indexed variables are stored as. And `String()` on parsed JSON is not safe
 * here: an object with a `toString` or `valueOf` key of its own throws.
 */
function stVariableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value === null || value === undefined) return '0';
  return JSON.stringify(value);
}

/**
 * `chat_metadata.variables`, within the limits a stored delta is held to
 * (`checkVariableDelta`). The check refuses a whole delta for one bad entry, so
 * each variable is weighed here on its own, in the file's order: one whose name
 * or value is too long, or that holds U+0000 (which Postgres cannot store), is
 * left out, and so is every one past the count or the total size — counted, so
 * the reader is told.
 */
function readVariables(value: unknown): { variables: Variables | null; dropped: number } {
  if (!isObject(value)) return { variables: null, dropped: 0 };
  const variables = Object.create(null) as Variables;
  let kept = 0;
  let chars = 0;
  let dropped = 0;
  for (const name of Object.keys(value)) {
    const text = stVariableValue(value[name]);
    const size = name.length + text.length;
    if (
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

/** A `note_*` placement key as a number; ST writes them as numbers, a hand edit may not. */
function noteNumber(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : fallback;
}

/** The note, without the U+0000 Postgres cannot store — the API refuses a note that has one. */
function readAuthorNote(meta: Json): StAuthorNote | undefined {
  const text = textOf(meta['note_prompt']).replace(/\u0000/g, '');
  if (!text.trim()) return undefined;
  return {
    text,
    interval: noteNumber(meta['note_interval'], ST_AUTHOR_NOTE_DEFAULTS.interval),
    position: noteNumber(meta['note_position'], ST_AUTHOR_NOTE_DEFAULTS.position),
    depth: noteNumber(meta['note_depth'], ST_AUTHOR_NOTE_DEFAULTS.depth),
    role: noteNumber(meta['note_role'], ST_AUTHOR_NOTE_DEFAULTS.role),
  };
}

/**
 * The chat a chat file is a branch or a checkpoint of: `chat_metadata.main_chat`,
 * the name ST saved it under — the file's stem — when it made this one from it
 * (`createBranch`, `createNewBookmark` in `public/scripts/bookmarks.js`).
 * Undefined for a chat of its own, and for a file whose header cannot be read.
 */
export function stChatMainChat(jsonl: string): string | undefined {
  const body = jsonl.charCodeAt(0) === 0xfeff ? jsonl.slice(1) : jsonl;
  const line = body.split(/\r?\n/, 64).find((one) => one.trim());
  if (!line) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || !isHeader(parsed) || !isObject(parsed['chat_metadata'])) return undefined;
  const main = parsed['chat_metadata']['main_chat'];
  return typeof main === 'string' && main.trim() ? main.trim() : undefined;
}

/**
 * Converts one chat file. Never throws: a line that is not JSON is counted and
 * passed over. The character's speaker is the roster member whose avatar is the
 * message's `original_avatar` (group chats record it), else whose name is the
 * message's `name`, else the only member. In a group chat (`StCast`) the message
 * then carries that member's id and its text as ST stored it — one speaker's
 * whole reply, which is what ST's group chats hold; otherwise each line is
 * prefixed with the member's name. Failing all three the lines stay unprefixed
 * and untagged — the scene's, by our protocol — and are counted.
 */
export function convertSillyTavernChat(jsonl: string, cast: StCast): StConvertedChat {
  const skipped = { system: 0, empty: 0, unknownSpeaker: 0, malformed: 0, overLimit: 0, variables: 0 };
  const grouped = cast.members.filter((member) => member.id).length >= 2;
  const messages: ImportedChatMessage[] = [];
  let userName = '';
  let characterName = '';
  let createdAt: string | undefined;
  let variables: Variables | null = null;
  let authorNote: StAuthorNote | undefined;
  let worldName: string | undefined;
  let first = true;

  // A BOM some editors leave on a re-saved file would make the header unreadable.
  const body = jsonl.charCodeAt(0) === 0xfeff ? jsonl.slice(1) : jsonl;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed)) {
      skipped.malformed += 1;
      first = false;
      continue;
    }
    if (first) {
      first = false;
      if (isHeader(parsed)) {
        userName = headerName(parsed['user_name']);
        characterName = headerName(parsed['character_name']);
        createdAt = parseSillyTavernDate(parsed['create_date']);
        const meta = isObject(parsed['chat_metadata']) ? parsed['chat_metadata'] : {};
        const read = readVariables(meta['variables']);
        variables = read.variables;
        skipped.variables = read.dropped;
        authorNote = readAuthorNote(meta);
        const world = meta['world_info'];
        if (typeof world === 'string' && world.trim()) worldName = world.trim();
        continue;
      }
    }

    const extra = isObject(parsed['extra']) ? parsed['extra'] : {};
    const narrator = extra['type'] === 'narrator';
    const comment = extra['type'] === 'comment';
    const name = typeof parsed['name'] === 'string' ? parsed['name'].trim() : '';
    // Kept out of ST's prompt: hidden from the AI here. Unless ST wrote it itself
    // — a notice (any other `extra.type`) or a tool call — which is not the
    // conversation at all.
    const hidden = parsed['is_system'] === true;
    if (
      hidden &&
      (name === ST_SYSTEM_NAME ||
        Array.isArray(extra['tool_invocations']) ||
        (typeof extra['type'] === 'string' && !narrator && !comment))
    ) {
      skipped.system += 1;
      continue;
    }
    if (messages.length >= MAX_CHAT_MESSAGES) {
      skipped.overLimit += 1;
      continue;
    }

    const isUser = parsed['is_user'] === true;
    const { versions: texts, selected, extras: read } = versionsOf(parsed);
    let versions = texts;
    if (versions.length === 0 || versions.every((text) => !text.trim())) {
      skipped.empty += 1;
      continue;
    }

    // What a version's text becomes here — a narration's prefix, a speaker's
    // lines — and the text shown in its place with it, so the two read alike.
    let spoken = (text: string): string => text;
    let speakerId: string | undefined;
    if (isUser) {
      if (!userName && name) userName = name;
    } else if (narrator || comment) {
      spoken = withNarrationPrefix;
    } else {
      if (!characterName && name) characterName = name;
      const member = speakerOf(cast, parsed['original_avatar'], name);
      const speaker = member?.name.trim();
      if (grouped && member?.id) speakerId = member.id;
      else if (speaker) spoken = (text) => spokenBy(text, speaker);
      else skipped.unknownSpeaker += 1;
    }
    versions = versions.map(spoken);
    const extras = read.map((extra) =>
      extra?.displayText !== undefined ? { ...extra, displayText: spoken(extra.displayText) } : extra,
    );

    const at = parseSillyTavernDate(parsed['send_date']);
    messages.push({
      role: isUser ? 'user' : 'assistant',
      versions,
      selected,
      ...(at ? { createdAt: at } : {}),
      ...(speakerId ? { speakerId } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(extras.some((extra) => extra !== null) ? { extras } : {}),
    });
  }

  return {
    userName,
    characterName,
    ...(createdAt ? { createdAt } : {}),
    messages,
    variables,
    ...(authorNote ? { authorNote } : {}),
    ...(worldName ? { worldName } : {}),
    skipped,
  };
}
