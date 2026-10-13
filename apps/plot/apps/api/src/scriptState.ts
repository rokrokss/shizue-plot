/**
 * What a card's scripts hand the server, and the reader's global variables.
 *
 * RisuAI cards carry scripts — triggers, Lua, editinput and editoutput regex —
 * that run in the reader's browser, not here. What they decide reaches the server
 * the way a game component's ruling does (`messages.directions`): as a value the
 * browser computed and the server stores. Nothing in it is a privilege the reader
 * did not already have — they can set any variable with a `{{setvar}}` of their
 * own and put any words in the prompt as a direction — so what is checked here is
 * the shape and the size, not where it came from.
 *
 * Three things arrive:
 * - a message's `variableDelta`: the values the scripts left on it, laid over its
 *   own macros wherever the branch is folded (`VariableDelta` in @shizue/core);
 * - the start triggers' writes for a generation that adds no user turn
 *   (`startDelta`), and the prompt text they asked for (`injections`);
 * - whether the browser will run output scripts over the reply (`postProcess`),
 *   which leaves the reply `pending` until it commits the result;
 * - the chat as the scripts left it (`chat`) — messages appended, cut, rewritten
 *   — which is kept as the reader's branch (`scriptChat.ts`);
 * - what the scripts rewrote of the work itself — a member's description, lore,
 *   global note, name, first message and background HTML, the reader's persona
 *   (`overlay`), and the chat note — kept
 *   on the chat (`chats.script_overlay`, `chats.note`) and laid over the work
 *   wherever that chat's prompt is assembled. The plot never changes.
 */
import { applyVariableDelta, checkVariableDelta, type VariableDelta, type Variables } from '@shizue/core';
import {
  checkScriptChat,
  MAX_OVERLAY_NAME_LENGTH,
  mergeScriptOverlay,
  overlayName,
  type MemberOverlay,
  type ScriptChat,
  type ScriptOverlay,
} from '@shizue/core/triggers';
import { chats, plotReaderVariables, type Chat, type ChatScriptOverlay } from '@shizue/db';
import { and, eq } from 'drizzle-orm';
import { coerceLorebook } from './card.js';
import type { AppDeps } from './deps.js';
import { ApiError, badRequest } from './errors.js';
import { isUuid, optionalBoolean } from './util.js';

/** Characters one injected block may hold — a system prompt, not a chapter. */
/**
 * A variable map as drizzle can store it. Core builds its maps without a
 * prototype — the names come from cards and model output, so `__proto__` is a
 * real name — and drizzle's value check reads `.constructor` off whatever it is
 * handed, which a prototype-less object has none of. Spreading copies the names
 * as own properties of a plain object, so a `__proto__` name stays a name.
 */
export const storableVariables = <T extends object>(map: T): T => ({ ...map });

/** The same for a delta that may be absent (null clears the column). */
export const storableDelta = (delta: VariableDelta | null): VariableDelta | null =>
  delta && storableVariables(delta);

export const MAX_INJECTION_LENGTH = 20_000;

/**
 * Where a start trigger asked its text to go, RisuAI's three places: just before
 * the last turn of the history, just after it, and at the very end of the prompt.
 * Never stored — like RisuAI's, they belong to the one request.
 */
export interface PromptInjections {
  start?: string;
  historyend?: string;
  promptend?: string;
}

const INJECTION_PLACES = ['start', 'historyend', 'promptend'] as const;

/**
 * What the browser brings to a generation from the card's scripts. Every field
 * is optional in the body; a request without any of them is a generation as it
 * always was.
 */
export interface GenerationScripts {
  /** What the start triggers changed, over the state of the branch they ran on. */
  startDelta: VariableDelta | null;
  injections: PromptInjections | null;
  /** The browser will run output scripts over the reply, so it is stored pending. */
  postProcess: boolean;
  /**
   * The head the scripts ran on — null for a chat with no message yet — and a
   * request made over another one is refused. Absent is not checked.
   */
  baseHeadId: string | null | undefined;
  /** Generate on over a head still pending, giving up its output scripts. */
  abandonPending: boolean;
  /**
   * What the scripts that ran for this generation rewrote of the work, laid over
   * the chat's overlay before the prompt is assembled and kept with it.
   */
  overlay: ScriptOverlay | null;
  /** The chat note as the scripts left it (`v2SetAuthorNote`); undefined when untouched. */
  note: string | undefined;
  /**
   * The chat as the scripts that ran for this generation left it (`ScriptChat`),
   * kept before the prompt is built (`scriptChat.ts`); null when they left it as
   * it was.
   */
  chat: ScriptChat | null;
}

export const NO_SCRIPTS: GenerationScripts = {
  startDelta: null,
  injections: null,
  postProcess: false,
  baseHeadId: undefined,
  abandonPending: false,
  overlay: null,
  note: undefined,
  chat: null,
};

/**
 * `body.chat`, what the scripts did to the chat, by its shape and its size (400
 * `invalid_request`, or `script_chat_limit` past the caps). Whether the messages
 * it names are on the branch is the route's to check (`planScriptChat`). `turn`
 * lets a send place its own turn.
 */
export function readScriptChat(body: Record<string, unknown>, { turn }: { turn: boolean }): ScriptChat | null {
  const check = checkScriptChat(body['chat'], { turn });
  if (check.ok) return check.chat;
  throw badRequest(check.limit ? 'script_chat_limit' : 'invalid_request', `chat ${check.error}`);
}

/** `body[key]` as a delta, or what is wrong with it. Absent and `null` are no delta. */
export function optionalVariableDelta(body: Record<string, unknown>, key: string): VariableDelta | null {
  const check = checkVariableDelta(body[key]);
  if (!check.ok) throw badRequest('invalid_request', `${key} ${check.error}`);
  return check.delta;
}

function optionalInjections(body: Record<string, unknown>): PromptInjections | null {
  const value = body['injections'];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_request', 'injections must be an object');
  }
  const source = value as Record<string, unknown>;
  const injections: PromptInjections = {};
  for (const place of INJECTION_PLACES) {
    const text = source[place];
    if (text === undefined || text === null) continue;
    if (typeof text !== 'string') throw badRequest('invalid_request', `injections.${place} must be a string`);
    if (text.length > MAX_INJECTION_LENGTH) {
      throw badRequest('invalid_request', `injections.${place} may be at most ${MAX_INJECTION_LENGTH} characters`);
    }
    if (text.trim()) injections[place] = text;
  }
  return Object.keys(injections).length > 0 ? injections : null;
}

/**
 * Reads the script fields of a generation body. `startDelta` is only read where
 * the generation adds no user turn of its own: a send carries the scripts' writes
 * on the user turn instead (`variableDelta`), since that is the message they ran
 * for — or, where they edited the chat, on the message it ends on.
 */
export function readGenerationScripts(
  body: Record<string, unknown>,
  { startDelta }: { startDelta: boolean },
): GenerationScripts {
  const baseHeadId = body['baseHeadId'];
  if (baseHeadId !== undefined && baseHeadId !== null && (typeof baseHeadId !== 'string' || !isUuid(baseHeadId))) {
    throw badRequest('invalid_request', 'baseHeadId must be a message id or null');
  }
  return {
    startDelta: startDelta ? optionalVariableDelta(body, 'startDelta') : null,
    injections: optionalInjections(body),
    postProcess: optionalBoolean(body, 'postProcess') ?? false,
    baseHeadId: baseHeadId as string | null | undefined,
    abandonPending: optionalBoolean(body, 'abandonPending') ?? false,
    overlay: optionalOverlay(body),
    note: optionalScriptNote(body),
    // A send places its own turn in it; the other generations add none.
    chat: readScriptChat(body, { turn: !startDelta }),
  };
}

/* ---------------------------------------------------------- the overlay */

/**
 * The longest text field an overlay may carry — a description, a global note, a
 * first message, a background, a persona — and the most lore entries. A card's own description is not capped
 * at import, but one a script built a step at a time is bounded the way a
 * variable is: by what the reader's tab could make of it.
 */
export const MAX_OVERLAY_TEXT_LENGTH = 200_000;
export const MAX_OVERLAY_LORE_ENTRIES = 2_000;
/** The whole overlay, serialized. It is read back on every generation of the chat. */
export const MAX_OVERLAY_CHARS = 2_000_000;

const overlayText = (value: unknown, path: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest('invalid_request', `${path} must be a string`);
  if (value.length > MAX_OVERLAY_TEXT_LENGTH) {
    throw badRequest('invalid_request', `${path} may be at most ${MAX_OVERLAY_TEXT_LENGTH} characters`);
  }
  if (value.includes('\u0000')) throw badRequest('invalid_request', `${path} must not contain U+0000`);
  return value;
};

/**
 * A rewrite of the work as the browser sends it (`ScriptOverlay` in
 * @shizue/core): per member id, the description, the lorebook — coerced the way
 * the studio's lorebook is — the post-history instructions, the name (one line,
 * trimmed, `overlayName`), the first message and the background HTML, and the
 * persona. Which members may be named is the route's to check, against the
 * plot's roster. Absent and `null` are no rewrite.
 */
export function readOverlay(value: unknown, path = 'overlay'): ScriptOverlay | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('invalid_request', `${path} must be an object`);
  const source = value as Record<string, unknown>;
  const members: Record<string, MemberOverlay> = {};
  const rawMembers = source['members'];
  if (rawMembers !== undefined && rawMembers !== null) {
    if (typeof rawMembers !== 'object' || Array.isArray(rawMembers)) {
      throw badRequest('invalid_request', `${path}.members must be an object`);
    }
    for (const [id, raw] of Object.entries(rawMembers as Record<string, unknown>)) {
      if (!isUuid(id)) throw badRequest('invalid_request', `${path}.members keys must be member ids`);
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw badRequest('invalid_request', `${path}.members.${id} must be an object`);
      }
      const fields = raw as Record<string, unknown>;
      const description = overlayText(fields['description'], `${path}.members.${id}.description`);
      const postHistoryInstructions = overlayText(
        fields['postHistoryInstructions'],
        `${path}.members.${id}.postHistoryInstructions`,
      );
      const firstMessage = overlayText(fields['firstMessage'], `${path}.members.${id}.firstMessage`);
      const backgroundHtml = overlayText(fields['backgroundHtml'], `${path}.members.${id}.backgroundHtml`);
      const rawName = fields['name'];
      let name: string | undefined;
      if (rawName !== undefined && rawName !== null) {
        const kept = typeof rawName === 'string' ? overlayName(rawName) : null;
        if (kept === null) {
          throw badRequest(
            'invalid_request',
            `${path}.members.${id}.name must be one line of 1 to ${MAX_OVERLAY_NAME_LENGTH} characters`,
          );
        }
        name = kept;
      }
      const rawLore = fields['lorebook'];
      if (rawLore !== undefined && rawLore !== null && !Array.isArray(rawLore)) {
        throw badRequest('invalid_request', `${path}.members.${id}.lorebook must be an array`);
      }
      if (Array.isArray(rawLore) && rawLore.length > MAX_OVERLAY_LORE_ENTRIES) {
        throw badRequest('invalid_request', `${path}.members.${id}.lorebook may hold at most ${MAX_OVERLAY_LORE_ENTRIES} entries`);
      }
      const member: MemberOverlay = {
        ...(description !== undefined ? { description } : {}),
        ...(Array.isArray(rawLore) ? { lorebook: coerceLorebook(rawLore) } : {}),
        ...(postHistoryInstructions !== undefined ? { postHistoryInstructions } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(firstMessage !== undefined ? { firstMessage } : {}),
        ...(backgroundHtml !== undefined ? { backgroundHtml } : {}),
      };
      if (Object.keys(member).length > 0) members[id] = member;
    }
  }
  const persona = overlayText(source['persona'], `${path}.persona`);
  const overlay: ScriptOverlay = {
    ...(Object.keys(members).length > 0 ? { members } : {}),
    ...(persona !== undefined ? { persona } : {}),
  };
  return Object.keys(overlay).length > 0 ? overlay : null;
}

function optionalOverlay(body: Record<string, unknown>): ScriptOverlay | null {
  return readOverlay(body['overlay']);
}

/** `note`, the chat note a script rewrote. Bounded like an overlay text. */
export function optionalScriptNote(body: Record<string, unknown>, key = 'note'): string | undefined {
  return overlayText(body[key], key);
}

/** The overlay a chat holds, as core reads it. The column's type is the database's loose one. */
export const overlayOf = (chat: Pick<Chat, 'scriptOverlay'>): ScriptOverlay | null =>
  (chat.scriptOverlay as ScriptOverlay | null) ?? null;

/**
 * The chat's overlay with `patch` laid over it, checked against the members the
 * plot really has — an id from another plot, or of a member since deleted, is a
 * stale client rather than something to keep — and against the size the column
 * may grow to.
 */
export function mergedOverlay(
  chat: Pick<Chat, 'scriptOverlay'>,
  patch: ScriptOverlay | null,
  memberIds: ReadonlySet<string>,
): ScriptOverlay | null {
  if (!patch) return overlayOf(chat);
  for (const id of Object.keys(patch.members ?? {})) {
    if (!memberIds.has(id)) throw badRequest('invalid_request', 'overlay names a member this plot does not have');
  }
  const merged = mergeScriptOverlay(overlayOf(chat), patch);
  if (merged && JSON.stringify(merged).length > MAX_OVERLAY_CHARS) {
    throw badRequest('script_overlay_limit', `A chat's script overlay may hold at most ${MAX_OVERLAY_CHARS} characters`);
  }
  return merged;
}

/**
 * Keeps what the scripts of a generation rewrote: the merged overlay, and the
 * note. Called inside the generation slot once the request has passed every
 * check, so a refused generation writes neither.
 */
export async function saveScriptWrites(
  deps: AppDeps,
  chatId: string,
  overlay: ScriptOverlay | null,
  note: string | undefined,
  changed: boolean,
): Promise<void> {
  if (!changed && note === undefined) return;
  await deps.db
    .update(chats)
    .set({
      ...(changed ? { scriptOverlay: overlay as ChatScriptOverlay | null } : {}),
      ...(note !== undefined ? { note } : {}),
    })
    .where(eq(chats.id, chatId));
}

/** What a request made over a head that has since moved is refused with. */
export const headMoved = (): ApiError =>
  new ApiError(409, 'head_moved', 'The chat has moved on from the message the scripts ran on');

/** What a script commit computed on a revision of the turn that is gone is refused with. */
export const scriptRevMoved = (): ApiError =>
  new ApiError(409, 'script_rev_moved', 'The message changed after the scripts read it');

/* ------------------------------------------------------ global variables */

/**
 * One reader's global variables on one plot: how many names, and how many
 * characters in all. Smaller than a message's delta — the whole map rides on
 * every chat state, and none of it is ever evicted.
 */
export const MAX_GLOBAL_VARIABLE_KEYS = 256;
export const MAX_GLOBAL_VARIABLE_CHARS = 256_000;

const GLOBAL_LIMITS = { keys: MAX_GLOBAL_VARIABLE_KEYS, chars: MAX_GLOBAL_VARIABLE_CHARS };

/** The reader's global variables for the plot; empty until something set one. */
export async function loadGlobalVariables(deps: AppDeps, userId: string, plotId: string): Promise<Variables> {
  const [row] = await deps.db
    .select({ variables: plotReaderVariables.variables })
    .from(plotReaderVariables)
    .where(and(eq(plotReaderVariables.userId, userId), eq(plotReaderVariables.plotId, plotId)))
    .limit(1);
  return applyVariableDelta(row?.variables ?? {}, null);
}

/**
 * Merges `patch` into the reader's global variables — a string sets, `null`
 * unsets — and answers with the whole map. The row is created on the first
 * write and locked for the read-merge-write, so two writes at once each land on
 * top of the other rather than one undoing it; the cap is a property of the
 * merged map, checked under that lock.
 */
export async function mergeGlobalVariables(
  deps: AppDeps,
  userId: string,
  plotId: string,
  patch: unknown,
): Promise<Variables> {
  const check = checkVariableDelta(patch, GLOBAL_LIMITS);
  if (!check.ok) throw badRequest('invalid_request', `variables ${check.error}`);
  const delta = check.delta;
  if (!delta) return loadGlobalVariables(deps, userId, plotId);

  return deps.db.transaction(async (tx) => {
    await tx.insert(plotReaderVariables).values({ userId, plotId }).onConflictDoNothing();
    const where = and(eq(plotReaderVariables.userId, userId), eq(plotReaderVariables.plotId, plotId));
    const [row] = await tx
      .select({ variables: plotReaderVariables.variables })
      .from(plotReaderVariables)
      .where(where)
      .for('update');
    const merged = applyVariableDelta(row?.variables ?? {}, delta);
    // The merge, read as a delta from nothing, is held to the same caps.
    if (!checkVariableDelta(merged, GLOBAL_LIMITS).ok) {
      throw badRequest(
        'global_variables_limit',
        `Global variables may hold at most ${MAX_GLOBAL_VARIABLE_KEYS} names and ${MAX_GLOBAL_VARIABLE_CHARS} characters`,
      );
    }
    await tx
      .update(plotReaderVariables)
      .set({ variables: storableVariables(merged), updatedAt: new Date() })
      .where(where);
    return merged;
  });
}
