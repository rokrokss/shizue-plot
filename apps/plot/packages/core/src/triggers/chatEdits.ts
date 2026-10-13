/**
 * What a run did to the chat, as the server takes it.
 *
 * RisuAI's triggers and Lua edit `chat.message` in place — a message appended
 * (`impersonate`, `addChat`), cut away (`cutchat`, `removeChat`), rewritten
 * (`modifychat`, `setChat`, `setChatRole`) — and the chat they leave is the chat.
 * Here the chat is a tree on the server whose branches share their past, so what
 * travels is the run's final chat said against the one it was given, and the
 * server keeps it as the reader's branch without touching any other
 * (`apps/api/src/scriptChat.ts`):
 *
 * - `keep`: how many messages after the greeting the run left as they were —
 *   usually all but the last few, so they are counted rather than listed;
 * - then the rest in order: `{id}` a stored message as it was, `{id, role?,
 *   content?}` one whose role or text the run changed, `{role, content}` one the
 *   run added, and — for a send — `{turn: true}` where the reader's turn stands,
 *   its text being the send's own.
 *
 * Every operation a run has (push, splice, slice, a field set) keeps the stored
 * messages it did not drop in their order, so their ids come out in branch
 * order. One that would not — a message a script moved — goes as a new message
 * with its text.
 */

import type { TriggerMessage } from './interpreter.js';

export type ScriptChatRole = 'user' | 'assistant';

export type ScriptChatItem =
  /** A stored message: as it was, or with the role or the text the run gave it. */
  | { id: string; role?: ScriptChatRole; content?: string }
  /** A message the run added. */
  | { role: ScriptChatRole; content: string }
  /** Where a send's own turn stands. */
  | { turn: true };

export interface ScriptChat {
  /** The messages after the greeting the run left as they were, from the first. */
  keep: number;
  /** What follows them, in order. */
  messages: ScriptChatItem[];
}

/** Messages after the kept ones one result may list — the branch a run can rebuild in one go. */
export const MAX_SCRIPT_CHAT_MESSAGES = 2_000;
/** The longest text one message may be given, as long as an overlay's text. */
export const MAX_SCRIPT_CHAT_TEXT = 200_000;
/** All the text one result may carry. */
export const MAX_SCRIPT_CHAT_CHARS = 2_000_000;

const roleOf = (role: TriggerMessage['role']): ScriptChatRole => (role === 'user' ? 'user' : 'assistant');

/**
 * `after`, the chat a run left, against `before`, the chat it was given (stored
 * messages carry their `id`). `turnId` names the placeholder a send's turn
 * stands in as, which becomes `{turn: true}`. Null when the run left the chat as
 * it was — for a send, with its turn at the end.
 */
export function scriptChatOf(
  before: readonly TriggerMessage[],
  after: readonly TriggerMessage[],
  turnId?: string,
): ScriptChat | null {
  const stored = before.filter((message) => message.id !== undefined && message.id !== turnId);
  const at = new Map(stored.map((message, index) => [message.id!, index]));
  let last = -1;
  let turned = false;
  const items = after.map((message): ScriptChatItem => {
    if (turnId !== undefined && message.id === turnId && !turned) {
      turned = true;
      return { turn: true };
    }
    const index = message.id === undefined ? undefined : at.get(message.id);
    if (index !== undefined && index > last) {
      last = index;
      const was = stored[index]!;
      return {
        id: was.id!,
        ...(message.role !== was.role ? { role: roleOf(message.role) } : {}),
        ...(message.data !== was.data ? { content: message.data } : {}),
      };
    }
    return { role: roleOf(message.role), content: message.data };
  });

  let keep = 0;
  while (keep < items.length && keep < stored.length) {
    const item = items[keep]!;
    if (!('id' in item) || item.id !== stored[keep]!.id || 'role' in item || 'content' in item) break;
    keep += 1;
  }
  const messages = items.slice(keep);
  const asGiven =
    keep === stored.length &&
    (turnId === undefined ? messages.length === 0 : messages.length === 1 && 'turn' in messages[0]!);
  return asGiven ? null : { keep, messages };
}

export type ScriptChatCheck =
  | { ok: true; chat: ScriptChat | null }
  /** `limit` when it is the size that is wrong rather than the shape. */
  | { ok: false; error: string; limit: boolean };

/**
 * A result as the server takes it — its shape and its size, not whether the ids
 * are on the branch, which only the server can tell. `turn` allows the one
 * `{turn: true}` a send may place. Absent and `null` are no result.
 */
export function checkScriptChat(value: unknown, { turn = false }: { turn?: boolean } = {}): ScriptChatCheck {
  const fail = (error: string, limit = false): ScriptChatCheck => ({ ok: false, error, limit });
  if (value === undefined || value === null) return { ok: true, chat: null };
  if (typeof value !== 'object' || Array.isArray(value)) return fail('must be an object');
  const source = value as Record<string, unknown>;
  const keep = source['keep'] ?? 0;
  if (typeof keep !== 'number' || !Number.isSafeInteger(keep) || keep < 0) return fail('keep must be a count of messages');
  const raw = source['messages'];
  if (!Array.isArray(raw)) return fail('messages must be an array');
  if (raw.length > MAX_SCRIPT_CHAT_MESSAGES) {
    return fail(`may list at most ${MAX_SCRIPT_CHAT_MESSAGES} messages after the ones it keeps`, true);
  }

  const messages: ScriptChatItem[] = [];
  let chars = 0;
  let turns = 0;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return fail('messages must be objects');
    const item = entry as Record<string, unknown>;
    if (item['turn'] === true) {
      if (!turn) return fail('has no turn to place');
      if ((turns += 1) > 1) return fail('places the turn once at most');
      messages.push({ turn: true });
      continue;
    }
    const rawRole = item['role'];
    if (rawRole !== undefined && rawRole !== 'user' && rawRole !== 'assistant') return fail('a role is user or assistant');
    const role = rawRole as ScriptChatRole | undefined;
    const rawContent = item['content'];
    if (rawContent !== undefined && typeof rawContent !== 'string') return fail('content must be a string');
    const content = rawContent as string | undefined;
    if (content !== undefined) {
      if (content.includes('\u0000')) return fail('content must not contain U+0000');
      if (content.length > MAX_SCRIPT_CHAT_TEXT) return fail(`content may be at most ${MAX_SCRIPT_CHAT_TEXT} characters`, true);
      chars += content.length;
      if (chars > MAX_SCRIPT_CHAT_CHARS) return fail(`may carry at most ${MAX_SCRIPT_CHAT_CHARS} characters`, true);
    }
    const id = item['id'];
    if (id !== undefined) {
      if (typeof id !== 'string') return fail('id must be a message id');
      messages.push({ id, ...(role !== undefined ? { role } : {}), ...(content !== undefined ? { content } : {}) });
    } else {
      if (role === undefined || content === undefined) return fail('a new message needs a role and content');
      messages.push({ role, content });
    }
  }
  return { ok: true, chat: { keep, messages } };
}
