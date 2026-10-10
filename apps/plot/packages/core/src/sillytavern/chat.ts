/**
 * A SillyTavern chat file as the chat import takes it. The file is JSONL: a
 * header line (`{ user_name, character_name, create_date?, chat_metadata }`) and
 * then one message per line (`{ name, is_user, is_system, send_date, mes,
 * swipes?, swipe_id?, extra?, original_avatar? }`) — `saveChat` in
 * `public/script.js`, `saveReply` for the swipes.
 *
 * Who said what goes into our speech protocol here (`speech.ts`): a character's
 * lines are prefixed with their roster name, and ST's narrator (`/sys`,
 * `extra.type === 'narrator'`, `sendNarratorMessage` in
 * `public/scripts/slash-commands.js`) stays unprefixed, which is our narrator.
 * Messages ST keeps out of the prompt (`is_system`: hidden by the reader,
 * comments, tool calls) are left out.
 */

import type { ImportedChatMessage } from '../types.js';

export interface StCast {
  /** The plot's roster, under the names it was imported with. */
  members: { name: string; avatar?: string }[];
}

export interface StConvertedChat {
  /** The persona name the chat was written under; '' when the file never says. */
  userName: string;
  characterName: string;
  /** ISO 8601, from an old header's `create_date`. */
  createdAt?: string;
  messages: ImportedChatMessage[];
  skipped: {
    /** `is_system` messages — hidden, comments, tool calls. */
    hidden: number;
    /** Messages with no text in any version. */
    empty: number;
    /** Character messages kept unprefixed because no roster member matched. */
    unknownSpeaker: number;
    /** Lines that are not a JSON object. */
    malformed: number;
    /** Messages past `MAX_CHAT_MESSAGES`. */
    overLimit: number;
  };
}

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

/** A speaker prefix the speech parser would read as this name (`SPEAKER_RE` in `speech.ts`). */
function startsAs(line: string, name: string): boolean {
  const match = /^([^:\n]{1,40}):/.exec(line);
  return match !== null && match[1]!.trim() === name;
}

/** The roster name a character message is attributed to (see `convertSillyTavernChat`). */
function speakerOf(cast: StCast, avatar: unknown, name: string): string | undefined {
  const member =
    (typeof avatar === 'string' && avatar ? cast.members.find((m) => m.avatar === avatar) : undefined) ??
    cast.members.find((m) => m.name.trim() === name) ??
    (cast.members.length === 1 ? cast.members[0] : undefined);
  return member?.name.trim() || undefined;
}

/** Every line with text becomes the speaker's; blank lines stay as spacing. */
const spokenBy = (text: string, name: string): string =>
  text
    .split('\n')
    .map((line) => (!line.trim() || startsAs(line, name) ? line : `${name}: ${line}`))
    .join('\n');

/**
 * The versions a message carries: its swipes when it has any, else its text.
 * `mes` is what ST shows and edits, so it fills the selected swipe's slot even
 * where the swipes array fell out of step. Blank versions are dropped, and the
 * selection follows the one it pointed at, or the first left when that is gone.
 */
function versionsOf(message: Json): { versions: string[]; selected: number } {
  const mes = textOf(message['mes']);
  const swipes = Array.isArray(message['swipes']) ? message['swipes'].map(textOf) : [];
  if (swipes.length === 0) return { versions: [mes], selected: 0 };

  const swipeId = message['swipe_id'];
  const selected =
    typeof swipeId === 'number' && Number.isInteger(swipeId)
      ? Math.min(Math.max(swipeId, 0), swipes.length - 1)
      : 0;
  if (typeof message['mes'] === 'string') swipes[selected] = mes;

  const kept = swipes.map((text, index) => ({ text, index })).filter(({ text }) => text.trim());
  const at = kept.findIndex(({ index }) => index === selected);
  return { versions: kept.map(({ text }) => text), selected: Math.max(at, 0) };
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
 * Converts one chat file. Never throws: a line that is not JSON is counted and
 * passed over. The character's speaker is the roster member whose avatar is the
 * message's `original_avatar` (group chats record it), else whose name is the
 * message's `name`, else the only member; failing all three the lines stay
 * unprefixed — narration, by our protocol — and are counted.
 */
export function convertSillyTavernChat(jsonl: string, cast: StCast): StConvertedChat {
  const skipped = { hidden: 0, empty: 0, unknownSpeaker: 0, malformed: 0, overLimit: 0 };
  const messages: ImportedChatMessage[] = [];
  let userName = '';
  let characterName = '';
  let createdAt: string | undefined;
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
        continue;
      }
    }

    const extra = isObject(parsed['extra']) ? parsed['extra'] : {};
    const narrator = extra['type'] === 'narrator';
    if (parsed['is_system'] === true && !narrator) {
      skipped.hidden += 1;
      continue;
    }
    if (messages.length >= MAX_CHAT_MESSAGES) {
      skipped.overLimit += 1;
      continue;
    }

    const name = typeof parsed['name'] === 'string' ? parsed['name'].trim() : '';
    const isUser = parsed['is_user'] === true;
    const { versions: texts, selected } = versionsOf(parsed);
    let versions = texts;
    if (versions.length === 0 || versions.every((text) => !text.trim())) {
      skipped.empty += 1;
      continue;
    }

    if (isUser) {
      if (!userName && name) userName = name;
    } else if (!narrator) {
      if (!characterName && name) characterName = name;
      const speaker = speakerOf(cast, parsed['original_avatar'], name);
      if (speaker) versions = versions.map((text) => spokenBy(text, speaker));
      else skipped.unknownSpeaker += 1;
    }

    const at = parseSillyTavernDate(parsed['send_date']);
    messages.push({
      role: isUser ? 'user' : 'assistant',
      versions,
      selected,
      ...(at ? { createdAt: at } : {}),
    });
  }

  return { userName, characterName, ...(createdAt ? { createdAt } : {}), messages, skipped };
}
