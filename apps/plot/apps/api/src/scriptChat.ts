/**
 * What a card's scripts did to the chat, kept without losing a branch.
 *
 * RisuAI's triggers and Lua edit `chat.message` in place — a message appended,
 * cut away, rewritten, its role turned — and the chat they leave is the chat.
 * Here a chat is a tree whose branches share their past, and a script edit never
 * deletes a stored message or rewrites one another branch reads. A run's chat
 * (`ScriptChat` in @shizue/core: what it kept, changed and added, said against
 * the branch it read) becomes the branch the reader is on:
 *
 * - left as it was: nothing is written;
 * - the branch with messages after it: they are appended under its end;
 * - a front part of it: the head moves back to where that part ends, and the
 *   rest stays in the tree under it;
 * - anything else: what the run left the same up front stays shared, and from
 *   the first message it changed or dropped on, the rest of its chat is written
 *   as new messages under the last shared one — copy-on-write, as an edited
 *   scene forks. The old messages are a swipe away at that point.
 *
 * The one message rewritten where it stands is the head, and only while nothing
 * hangs under it: no branch but the reader's reads it. That is how a script's
 * rewrite of the reply it just finished has always been kept, and it keeps a
 * reply's output triggers from leaving a twin of every reply behind.
 *
 * The values a run left (`lastDelta`) go on the message the branch ends on. A
 * message other branches fold through keeps its own: one whose delta has to
 * change for this is copied for it, like a changed one — giving it the run's
 * values in place would fold them under the tail it already has, twice over.
 */
import type { VariableDelta } from '@shizue/core';
import type { ScriptChat, ScriptChatItem } from '@shizue/core/triggers';
import { chatAttachments, chats, messages, type Message, type MessageRole, type MessageSource, type NewMessage } from '@shizue/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { bindAttachments } from './attachments.js';
import type { Tx } from './deps.js';
import { badRequest } from './errors.js';
import { invalidateMemoryForEdit } from './memory.js';
import { storableDelta } from './scriptState.js';

/** A send's own turn — what `{turn: true}` stands for, as the send carries it. */
export interface ScriptTurn {
  content: string;
  source: MessageSource;
  directions?: string;
  attachmentIds: string[];
}

/** One message of the branch a run leaves. */
type Entry =
  | { kind: 'stored'; row: Message; role: MessageRole; content: string; changed: boolean }
  | { kind: 'new'; role: MessageRole; content: string }
  | { kind: 'turn' };

export interface ScriptChatOptions {
  /** The message the run may rewrite in place: the chat's head, when nothing hangs under it (`rewritableHead`). */
  inPlace: Message | null;
  /** The values the run left, for the message the branch ends on; undefined leaves every delta as it is. */
  lastDelta?: VariableDelta | null;
  /** A send's turn. Without a result, the branch as it was with the turn after it. */
  turn?: ScriptTurn;
  /** The message the branch ends on is rewritten afterwards (a continue), so it must be one this may rewrite. */
  ownLast?: boolean;
  /**
   * The member whose scripts ran, in a work of several: a character message they
   * add, or a message they turn into one, is stored as that member's
   * (`speaker_member_id`). Absent leaves it untagged — the lead's, as it has always been read.
   */
  memberId?: string;
}

/** What `applyScriptChat` writes, decided before anything is — every refusal comes from here. */
export interface ScriptChatPlan {
  /** The branch the run read, greeting first. */
  path: Message[];
  /** How much of it stays as it is. */
  shared: number;
  /** The head, rewritten where it stands. */
  rewrite: { row: Message; role: MessageRole; content: string; delta?: VariableDelta | null } | null;
  /** The messages written after the shared part, in order. */
  created: Entry[];
  lastDelta: VariableDelta | null | undefined;
  turn: ScriptTurn | undefined;
  /** Whether anything is written or moved. */
  changed: boolean;
  /** The role of the message the branch ends on; null for a branch with none. */
  lastRole: MessageRole | null;
  /** `ScriptChatOptions.memberId`. */
  memberId: string | undefined;
}

/** The greeting a branch opened on — the root reply — which RisuAI's `chat.message` leaves out. */
const opensOnGreeting = (path: readonly Message[]): boolean =>
  path[0] !== undefined && path[0].parentId === null && path[0].role === 'assistant';

/** The head, when a run may rewrite it where it stands: nothing hangs under it. */
export const rewritableHead = (all: readonly Message[], head: Message | undefined): Message | null =>
  head && !all.some((message) => message.parentId === head.id) ? head : null;

/**
 * Where a message's text came from once a run left it with `role`: a stored one
 * keeps its own while its role stands. One a script added as its character, or
 * turned into a character message, is the script's (`script`) — it names no
 * speaker, written as the script wrote it, and is drawn and sent as that
 * character's, as RisuAI draws it. One turned into the reader's is the reader's.
 */
const sourceOf = (role: MessageRole, row?: Message): MessageSource =>
  row && row.role === role ? row.source : role === 'assistant' ? 'script' : 'user';

/**
 * Who a message is said by once a run left it with `role` (the group-turn tags):
 * a stored one keeps its own while its role stands — a copy is the same turn —
 * and one turned into a character message, or added as one, is the member whose
 * scripts ran, in no round. A user turn has neither.
 */
const speakerOf = (
  role: MessageRole,
  memberId: string | undefined,
  row?: Message,
): { speakerMemberId: string | null; groupTurnId: string | null } =>
  row && row.role === role
    ? { speakerMemberId: row.speakerMemberId, groupTurnId: row.groupTurnId }
    : { speakerMemberId: role === 'assistant' ? (memberId ?? null) : null, groupTurnId: null };

/** Same names, same values — a message's delta as `lastDelta` would leave it. */
function sameDelta(a: VariableDelta | null | undefined, b: VariableDelta | null): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && right[key] === left[key]);
}

/**
 * Reads `chat` against `path`, the branch the run read. The ids it names have
 * to be messages of that branch after its greeting, each once and in branch
 * order (400 `invalid_request` otherwise) — a result made on another branch, or
 * one that would reorder the past, is a client to refuse rather than a chat to
 * guess at. `chat` null is the branch as it was (with a send's turn after it).
 */
export function planScriptChat(path: Message[], chat: ScriptChat | null, options: ScriptChatOptions): ScriptChatPlan {
  const start = opensOnGreeting(path) ? 1 : 0;
  const keep = chat ? chat.keep : path.length - start;
  if (start + keep > path.length) throw badRequest('invalid_request', 'chat keeps more messages than the branch holds');
  const items: ScriptChatItem[] = chat ? chat.messages : options.turn ? [{ turn: true }] : [];

  const position = new Map(path.map((row, index) => [row.id, index]));
  const entries: Entry[] = path
    .slice(0, start + keep)
    .map((row) => ({ kind: 'stored', row, role: row.role, content: row.content, changed: false }));
  let last = start + keep - 1;
  for (const item of items) {
    if ('turn' in item) {
      entries.push({ kind: 'turn' });
    } else if ('id' in item) {
      const at = position.get(item.id);
      if (at === undefined || at < start) {
        throw badRequest('invalid_request', 'chat names a message that is not on this branch after its greeting');
      }
      if (at <= last) throw badRequest('invalid_request', 'chat must name the messages it keeps once each, in branch order');
      last = at;
      const row = path[at]!;
      const role = item.role ?? row.role;
      const content = item.content ?? row.content;
      entries.push({ kind: 'stored', row, role, content, changed: role !== row.role || content !== row.content });
    } else {
      entries.push({ kind: 'new', role: item.role, content: item.content });
    }
  }

  // The longest stretch from the front the run left exactly as it was.
  let shared = 0;
  while (shared < entries.length && shared < path.length) {
    const entry = entries[shared]!;
    if (entry.kind !== 'stored' || entry.row.id !== path[shared]!.id || entry.changed) break;
    shared += 1;
  }

  const head = path.at(-1);
  const inPlace = head && options.inPlace?.id === head.id ? head : null;
  let rewrite: ScriptChatPlan['rewrite'] = null;
  const first = entries[shared];
  if (inPlace && shared === path.length - 1 && first?.kind === 'stored' && first.row.id === inPlace.id) {
    rewrite = { row: inPlace, role: first.role, content: first.content };
    shared += 1;
  }

  // The message the branch ends on, when it is one the branch already has.
  const lastAt = entries.length - 1;
  if (lastAt >= 0 && lastAt < shared) {
    const row = path[lastAt]!;
    const mine = inPlace?.id === row.id;
    const delta = options.lastDelta;
    if (delta !== undefined && !sameDelta(row.variableDelta, delta)) {
      if (mine) rewrite = { row, role: rewrite?.role ?? row.role, content: rewrite?.content ?? row.content, delta };
      else shared = lastAt;
    }
    if (options.ownLast && !mine) shared = Math.min(shared, lastAt);
  }

  const created = entries.slice(shared);
  const end = entries.at(-1);
  return {
    path,
    shared,
    rewrite,
    created,
    lastDelta: options.lastDelta,
    turn: options.turn,
    changed: created.length > 0 || rewrite !== null || shared < path.length,
    lastRole: !end ? null : end.kind === 'turn' ? 'user' : end.role,
    memberId: options.memberId,
  };
}

/** What a run's branch holds now. */
export interface AppliedScriptChat {
  /** The branch, greeting first; its last message is the head. */
  path: Message[];
  /** Every message of the chat, as `all` with what this wrote. */
  all: Message[];
  /** The row a send's turn was written as; null when the run cut it. */
  turn: Message | null;
  /** The text this wrote that no message had before: the head's rewrite, the changed copies and the new messages. */
  written: Message[];
}

/**
 * Writes `plan` in the caller's transaction: the rows, the head, and the memory
 * invalidation an edit of the past forces (`invalidateMemoryForEdit`, as an
 * edited scene and a rewritten head do). `all` is every message of the chat,
 * for the time stamps: a copy has to be the newest of its siblings, which is
 * where a swipe back to the branch lands (`deepestLeaf`).
 *
 * A copy carries everything its message did — role and text unless the run
 * changed them, who wrote it (`source`, `sourceOf`), who said it and in which
 * round (`speakerOf`), the ruling on it (`directions`, a user turn's only), the
 * lore it triggered, the values its scripts left, the model and the tokens, and
 * its images: a copy is the same turn on another branch, and
 * nothing runs again for it. It is never `pending` (its output scripts ran, or
 * were given up on, on the original) and starts its own script revision.
 */
export async function applyScriptChat(
  tx: Tx,
  chatId: string,
  plan: ScriptChatPlan,
  all: readonly Message[],
): Promise<AppliedScriptChat> {
  const kept = plan.path.slice(0, plan.shared);
  const written: Message[] = [];
  let replaced: Message | null = null;

  if (plan.rewrite) {
    const { row, role, content, delta } = plan.rewrite;
    const [updated] = await tx
      .update(messages)
      .set({
        role,
        content,
        ...(role !== row.role ? { source: sourceOf(role), directions: null, ...speakerOf(role, plan.memberId) } : {}),
        ...(delta !== undefined ? { variableDelta: storableDelta(delta) } : {}),
        scriptRev: sql`${messages.scriptRev} + 1`,
      })
      .where(eq(messages.id, row.id))
      .returning();
    replaced = updated!;
    kept[kept.length - 1] = replaced;
    if (role !== row.role || content !== row.content) {
      written.push(replaced);
      await invalidateMemoryForEdit(tx, chatId, row.id);
    }
  }

  const stamp = all.reduce((latest, message) => Math.max(latest, message.createdAt.getTime() + 1), Date.now());
  let parentId = kept.at(-1)?.id ?? null;
  const copies = new Map<string, string>();
  const rows = plan.created.map((entry, position): NewMessage & { id: string } => {
    const id = randomUUID();
    const base = { id, chatId, parentId, createdAt: new Date(stamp + position) };
    parentId = id;
    if (entry.kind === 'turn') {
      const turn = plan.turn!;
      return {
        ...base,
        role: 'user' as const,
        content: turn.content,
        source: turn.source,
        ...(turn.directions ? { directions: turn.directions } : {}),
      };
    }
    if (entry.kind === 'new') {
      return {
        ...base,
        role: entry.role,
        content: entry.content,
        source: sourceOf(entry.role),
        ...(entry.role === 'assistant' && plan.memberId !== undefined ? { speakerMemberId: plan.memberId } : {}),
      };
    }
    const { row } = entry;
    copies.set(row.id, id);
    const stillUser = entry.role === 'user' && row.role === 'user';
    return {
      ...base,
      role: entry.role,
      content: entry.content,
      source: sourceOf(entry.role, row),
      ...speakerOf(entry.role, plan.memberId, row),
      directions: stillUser ? row.directions : null,
      loreTriggers: row.loreTriggers,
      variableDelta: row.variableDelta,
      model: row.model,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
    };
  });
  if (rows.length > 0 && plan.lastDelta !== undefined) {
    rows[rows.length - 1] = { ...rows[rows.length - 1]!, variableDelta: storableDelta(plan.lastDelta) };
  }

  const turnId = rows[plan.created.findIndex((entry) => entry.kind === 'turn')]?.id ?? null;
  let created: Message[] = [];
  if (rows.length > 0) {
    const inserted = new Map((await tx.insert(messages).values(rows).returning()).map((row) => [row.id, row]));
    created = rows.map((row) => inserted.get(row.id)!);
    // The images go with the turn they belong to: new rows over the same stored
    // objects, which a delete only removes once no row names them.
    if (copies.size > 0) {
      const images = await tx.select().from(chatAttachments).where(inArray(chatAttachments.messageId, [...copies.keys()]));
      if (images.length > 0) {
        await tx
          .insert(chatAttachments)
          .values(images.map(({ id: _id, messageId, ...image }) => ({ ...image, messageId: copies.get(messageId!)! })));
      }
    }
    if (turnId && plan.turn!.attachmentIds.length > 0) {
      await bindAttachments(tx, chatId, turnId, plan.turn!.attachmentIds);
    }
    // From the first original the branch leaves behind: the summary must stop
    // standing for text the reader's branch no longer has.
    const left = plan.path[plan.shared];
    if (left) await invalidateMemoryForEdit(tx, chatId, left.id);
    written.push(
      ...created.filter((_, index) => {
        const entry = plan.created[index]!;
        return entry.kind !== 'stored' || entry.changed;
      }),
    );
  }

  const path = [...kept, ...created];
  await tx
    .update(chats)
    .set({ headMessageId: path.at(-1)?.id ?? null, updatedAt: new Date() })
    .where(eq(chats.id, chatId));
  return {
    path,
    all: [...all.map((message) => (message.id === replaced?.id ? replaced : message)), ...created],
    turn: created.find((row) => row.id === turnId) ?? null,
    written,
  };
}
