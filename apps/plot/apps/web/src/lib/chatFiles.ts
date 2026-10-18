/**
 * A chat file brought into a work from its chat list, as RisuAI's chat list
 * imports one (`importChat` in RisuAI's `src/ts/characters.ts`): a RisuAI chat
 * as JSON (`risuChat` v1 and v2, `risuAllChats` v1 and v2) or as the HTML page
 * RisuAI's export writes, and a SillyTavern chat (`.jsonl`). The browser reads
 * and converts it — `convertRisuChat`, and for SillyTavern the migration's own
 * `convertSillyTavernChat` — and sends each chat through the chat import the
 * migration uses (`POST /api/chats/import`, its batches, its completion). A
 * RisuAI chat opens on the work's own greeting at its `fmIndex`
 * (`openingIndex`); a SillyTavern one brings its greeting as its first message.
 *
 * RisuAI's file picker takes `.txt` too, but reads nothing from it; the text
 * export is for reading, so this takes no `.txt`.
 */
import {
  convertRisuChat,
  isRisuChat,
  readRisuChatFile,
  type ImportedChatMessage,
  type LoreEntry,
  type Variables,
} from '@shizue/core';
import { convertSillyTavernChat, noteSettingsOfSt } from '@shizue/core/sillytavern';
import { ApiError, apiSend, toApiError } from './api';
import {
  batchMessages,
  capVersions,
  fitRows,
  MAX_IMPORT_NOTE_LENGTH,
  MAX_IMPORT_VERSION_LENGTH,
  MAX_IMPORTED_ROWS,
  sha256Hex,
} from './sillytavern/import';

/** What the file picker offers. */
export const CHAT_FILE_ACCEPT = '.json,.jsonl,.html,.htm';

/** The work a chat comes into: its roster, in order. */
export interface ChatFileCast {
  members: { id: string; name: string }[];
}

/** One chat of a file, converted, ready to send. */
export interface PreparedChat {
  /** The chat's title, where the file names one. */
  title: string;
  /** What a second run recognizes it by: the chat's own JSON, or the SillyTavern file's bytes. */
  sha256: string;
  messages: ImportedChatMessage[];
  /** RisuAI's greeting, as one of the work's openings; absent for a chat that brings its own. */
  openingIndex?: number;
  note?: string;
  noteSettings?: unknown;
  variables?: Variables;
  localLore?: LoreEntry[];
  /** What did not come over, for the reader: bookmarks, swipes past the cap, speakers no member matched. */
  dropped: { bookmarks: number; swipes: number; unknownSpeaker: number };
}

/** A file this cannot read: none of the shapes RisuAI's import reads. */
export class ChatFileError extends Error {}

const encoder = new TextEncoder();

/** The chat RisuAI's HTML export keeps in its `.idat` element, as RisuAI's import reads it back. */
function htmlChat(text: string): unknown {
  const holder = new DOMParser().parseFromString(text, 'text/html').querySelector('.idat');
  if (!holder?.textContent) return null;
  try {
    return JSON.parse(holder.textContent);
  } catch {
    return null;
  }
}

/** Within what one imported message and one imported chat may hold; refused otherwise, as the API would. */
function fit(messages: ImportedChatMessage[]): { messages: ImportedChatMessage[]; swipes: number } {
  let swipes = 0;
  const capped = messages.map((source) => {
    const { message, dropped } = capVersions(source);
    swipes += dropped;
    return message;
  });
  const fitted = capped.length > 0 ? fitRows(capped) : { messages: capped, dropped: 0 };
  if (!fitted) throw new ApiError(0, 'message_limit', `An imported chat holds at most ${MAX_IMPORTED_ROWS} messages`);
  if (fitted.messages.some((message) => message.versions.some((one) => one.length > MAX_IMPORT_VERSION_LENGTH))) {
    throw new ApiError(0, 'message_too_long', `One imported message is at most ${MAX_IMPORT_VERSION_LENGTH} characters`);
  }
  return { messages: fitted.messages, swipes: swipes + fitted.dropped };
}

/**
 * The chats a file holds, converted against the work's roster, in the file's
 * order. A chat with no message is left out, as there is nothing to bring:
 * RisuAI keeps an empty chat for each new one. Throws `ChatFileError` for a file
 * RisuAI would say holds nothing (`errors.noData`).
 */
export async function prepareChatFile(name: string, text: string, cast: ChatFileCast): Promise<PreparedChat[]> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.jsonl')) {
    const converted = convertSillyTavernChat(text, { members: cast.members });
    if (converted.messages.length === 0) throw new ChatFileError('no messages');
    const { messages, swipes } = fit(converted.messages);
    const note = converted.authorNote;
    const noteSettings = note ? noteSettingsOfSt(note) : null;
    return [
      {
        title: name.replace(/\.jsonl$/i, ''),
        sha256: await sha256Hex(encoder.encode(text)),
        messages,
        ...(note ? { note: note.text.slice(0, MAX_IMPORT_NOTE_LENGTH) } : {}),
        ...(noteSettings ? { noteSettings } : {}),
        ...(converted.variables ? { variables: converted.variables } : {}),
        dropped: { bookmarks: 0, swipes, unknownSpeaker: converted.skipped.unknownSpeaker },
      },
    ];
  }

  let chats: Record<string, unknown>[] | null = null;
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const chat = htmlChat(text);
    chats = isRisuChat(chat) ? [chat] : null;
  } else {
    try {
      chats = readRisuChatFile(JSON.parse(text));
    } catch {
      chats = null;
    }
  }
  if (!chats) throw new ChatFileError('not a RisuAI chat file');

  const prepared: PreparedChat[] = [];
  for (const chat of chats) {
    const converted = convertRisuChat(chat, cast);
    if (converted.messages.length === 0) continue;
    const { messages, swipes } = fit(converted.messages);
    prepared.push({
      title: converted.name,
      sha256: await sha256Hex(encoder.encode(JSON.stringify(chat))),
      messages,
      openingIndex: converted.openingIndex,
      ...(converted.note ? { note: converted.note.slice(0, MAX_IMPORT_NOTE_LENGTH) } : {}),
      ...(converted.variables ? { variables: converted.variables } : {}),
      ...(converted.localLore.length > 0 ? { localLore: converted.localLore } : {}),
      dropped: { bookmarks: converted.skipped.bookmarks, swipes, unknownSpeaker: converted.skipped.unknownSpeaker },
    });
  }
  if (prepared.length === 0) throw new ChatFileError('no messages');
  return prepared;
}

/** How one chat of a file went. */
export type ChatFileResult =
  | { status: 'done'; chatId: string; title: string; dropped: PreparedChat['dropped'] }
  | { status: 'already_imported'; chatId?: string; title: string }
  | { status: 'failed'; title: string; error: ApiError };

/**
 * Sends one prepared chat: created with its first batch, filled with the rest,
 * completed with what the chat keeps as a whole. A chat a run brought before is
 * not brought twice (`already_imported`).
 */
async function sendChat(plotId: string, fileName: string, chat: PreparedChat): Promise<ChatFileResult> {
  const [head = [], ...rest] = batchMessages(chat.messages);
  const res = await fetch('/api/chats/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      plotId,
      fileName,
      sha256: chat.sha256,
      ...(chat.title ? { title: chat.title } : {}),
      ...(chat.openingIndex !== undefined ? { openingIndex: chat.openingIndex } : {}),
      messages: head,
    }),
  });
  if (res.status === 409) {
    const body = (await res.clone().json().catch(() => null)) as { code?: string; chatId?: string } | null;
    if (body?.code === 'already_imported') {
      return { status: 'already_imported', title: chat.title, ...(body.chatId ? { chatId: body.chatId } : {}) };
    }
  }
  if (!res.ok) throw await toApiError(res);
  const created = (await res.json()) as { chat: { id: string } };
  const chatId = created.chat.id;
  for (const batch of rest) await apiSend('POST', `/api/chats/${chatId}/import`, { messages: batch });
  await apiSend('POST', `/api/chats/${chatId}/import/complete`, {
    backfillMemory: false,
    ...(chat.note ? { note: chat.note } : {}),
    ...(chat.noteSettings ? { noteSettings: chat.noteSettings } : {}),
    ...(chat.variables ? { variables: chat.variables } : {}),
    ...(chat.localLore ? { localLore: chat.localLore } : {}),
  });
  return { status: 'done', chatId, title: chat.title, dropped: chat.dropped };
}

/**
 * Every chat of a prepared file into the work, one after another. One that
 * fails is reported and the rest still go — but where no model is set, nothing
 * can be started at all, so the run stops there.
 */
export async function importChatFile(plotId: string, fileName: string, chats: PreparedChat[]): Promise<ChatFileResult[]> {
  const results: ChatFileResult[] = [];
  for (const chat of chats) {
    try {
      results.push(await sendChat(plotId, fileName, chat));
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : new ApiError(0, 'unknown', String(caught));
      results.push({ status: 'failed', title: chat.title, error });
      if (error.code === 'model_unavailable') break;
    }
  }
  return results;
}
