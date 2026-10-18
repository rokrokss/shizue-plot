/**
 * What a card's scripts hand the server, and the work's global variables.
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
 *   global note, name, first message and background HTML, the persona
 *   (`overlay`) — written into the work's own rows, as RisuAI's scripts rewrite
 *   the character object, so every chat with it reads it from then on
 *   (`writeScriptRewrite`); and what RisuAI keeps on the chat — the chat note
 *   (`note`) and the lore Lua's `upsertLocalLoreBook` wrote (`localLore`,
 *   RisuAI's chat `localLore`) — kept on the chat (`chats.note`,
 *   `chats.local_lore`).
 */
import {
  applyVariableDelta,
  checkVariableDelta,
  type LoreEntry,
  type NormalizedCard,
  type VariableDelta,
  type Variables,
} from '@shizue/core';
import {
  checkScriptChat,
  MAX_OVERLAY_NAME_LENGTH,
  overlaidCard,
  overlayName,
  type MemberOverlay,
  type ScriptChat,
  type ScriptOverlay,
} from '@shizue/core/triggers';
import { characters, chats, personas, plotReaderVariables, plots, type Chat } from '@shizue/db';
import { and, eq, sql } from 'drizzle-orm';
import { coerceLorebook } from './card.js';
import type { AppDeps, Tx } from './deps.js';
import { ApiError, badRequest } from './errors.js';
import { invalidateMemoryForEdit } from './memory.js';
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
   * What the scripts that ran for this generation rewrote of the work: laid over
   * it before the prompt is assembled, and written into it (`writeScriptRewrite`).
   */
  overlay: ScriptOverlay | null;
  /** The chat note as the scripts left it (`v2SetAuthorNote`); undefined when untouched. */
  note: string | undefined;
  /** The chat's own lore as the scripts left it (Lua's `upsertLocalLoreBook`); undefined when untouched. */
  localLore: LoreEntry[] | undefined;
  /**
   * The chat as the scripts that ran for this generation left it (`ScriptChat`),
   * kept before the prompt is built (`scriptChat.ts`); null when they left it as
   * it was.
   */
  chat: ScriptChat | null;
  /**
   * The member whose scripts wrote `chat`, in a work of several: a character
   * message they add is that member's (`ScriptChatOptions.memberId`). Shape only
   * here; the route holds it to the roster (`scriptMemberOf`).
   */
  memberId: string | undefined;
}

export const NO_SCRIPTS: GenerationScripts = {
  startDelta: null,
  injections: null,
  postProcess: false,
  baseHeadId: undefined,
  abandonPending: false,
  overlay: null,
  note: undefined,
  localLore: undefined,
  chat: null,
  memberId: undefined,
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
    localLore: optionalLocalLore(body),
    // A send places its own turn in it; the other generations add none.
    chat: readScriptChat(body, { turn: !startDelta }),
    memberId: optionalMemberId(body),
  };
}

/** `body.memberId`, the member whose scripts ran: a member id, or absent. */
export function optionalMemberId(body: Record<string, unknown>): string | undefined {
  const value = body['memberId'];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !isUuid(value)) throw badRequest('invalid_request', 'memberId must be a member id');
  return value;
}

/**
 * The member a body's `memberId` names, held to the roster (400 otherwise);
 * undefined when it names none.
 */
export function scriptMemberOf<T extends { id: string }>(memberId: string | undefined, members: readonly T[]): T | undefined {
  if (memberId === undefined) return undefined;
  const member = members.find((candidate) => candidate.id === memberId);
  if (!member) throw badRequest('invalid_request', 'memberId must name a member of the plot');
  return member;
}

/* -------------------------------------------------- the work's rewrites */

/**
 * The longest text field a rewrite may carry — a description, a global note, a
 * first message, a background, a persona — and the most lore entries. A card's
 * own description is not capped at import, but one a script built a step at a
 * time is bounded the way a variable is: by what the reader's tab could make of it.
 */
export const MAX_OVERLAY_TEXT_LENGTH = 200_000;
export const MAX_OVERLAY_LORE_ENTRIES = 2_000;
/** The chat's own lore, serialized. It is read back on every generation of the chat. */
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

/**
 * The chat's own lore as the browser sends it (`localLore`, RisuAI's chat
 * `localLore`, which Lua's `upsertLocalLoreBook` writes) — the whole list, held
 * to what an overlay's lorebook is held to and coerced the way the studio's is.
 * Absent leaves it as it is; `null` empties it.
 */
export function readLocalLore(value: unknown, path = 'localLore'): LoreEntry[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) throw badRequest('invalid_request', `${path} must be an array`);
  if (value.length > MAX_OVERLAY_LORE_ENTRIES) {
    throw badRequest('invalid_request', `${path} may hold at most ${MAX_OVERLAY_LORE_ENTRIES} entries`);
  }
  const lore = coerceLorebook(value);
  if (JSON.stringify(lore).length > MAX_OVERLAY_CHARS) {
    throw badRequest('script_overlay_limit', `A chat's own lore may hold at most ${MAX_OVERLAY_CHARS} characters`);
  }
  return lore;
}

function optionalLocalLore(body: Record<string, unknown>): LoreEntry[] | undefined {
  return readLocalLore(body['localLore']);
}

/** The chat's own lore, as core reads it: empty until a script wrote some. */
export const localLoreOf = (chat: Pick<Chat, 'localLore'>): LoreEntry[] => chat.localLore ?? [];

/**
 * A request's rewrite of the work, held to the members the plot really has — an
 * id from another plot, or of a member since deleted, is a stale client rather
 * than something to write. What the prompt reads before the write lands.
 */
export function checkScriptRewrite(patch: ScriptOverlay | null, memberIds: ReadonlySet<string>): ScriptOverlay | null {
  if (!patch) return null;
  for (const id of Object.keys(patch.members ?? {})) {
    if (!memberIds.has(id)) throw badRequest('invalid_request', 'overlay names a member this plot does not have');
  }
  return patch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A member's card as a rewrite leaves it: RisuAI's `char.desc`, `globalLore`,
 * `replaceGlobalNote`, `name`, `firstMessage` and `backgroundHTML`, each
 * the card's own field.
 */
export function rewrittenCard(card: NormalizedCard, fields: MemberOverlay): NormalizedCard {
  const next = overlaidCard(card, fields);
  const risu = isRecord(next.extensions['risuai']) ? next.extensions['risuai'] : {};
  return {
    ...next,
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.firstMessage !== undefined ? { firstMes: fields.firstMessage } : {}),
    ...(fields.backgroundHtml !== undefined
      ? { extensions: { ...next.extensions, risuai: { ...risu, backgroundHTML: fields.backgroundHtml } } }
      : {}),
  };
}

/**
 * Writes what a card's scripts rewrote into the work itself, in the caller's
 * transaction, as RisuAI's scripts rewrite the character object — so every
 * chat with the work reads it from then on, and the studio shows it:
 *
 * - a member's description, lore, post-history instructions, name, first
 *   message and background go to its card, its name to the roster too — and
 *   to the work's, in a work of one member, which is that character;
 * - the lead's — the scripted member's (`scriptedMember`), RisuAI's one
 *   character — background is also what the work draws behind its chats
 *   (`customUi.backgroundHtml`), and its first message the work's first
 *   opening — what a new chat starts on — and the first greeting of every chat
 *   of the work, as RisuAI draws a chat's first greeting from its character.
 *   A greeting whose words change is edited in place, and the summaries
 *   covering it go as an edit's do (`invalidateMemoryForEdit`). Another
 *   member's stay on its own card, as the page reads them only for the lead;
 * - the persona goes to the chat's persona, RisuAI's being the reader's own for
 *   every character — and nowhere for a chat without one.
 *
 * Each field is a whole value: the latest write of it stands. Members are held
 * to the plot (`checkScriptRewrite`) by the caller. Answers the chats whose
 * summaries the greeting's rewrite dropped. The chat the write was made in is
 * refreshed as its turn or its commit is; the others summarize the stretch
 * again on their own next refresh, so one chat's script does not start a
 * summary call for every chat of the work (§7.3).
 */
export async function writeScriptRewrite(
  tx: Tx,
  chat: Pick<Chat, 'plotId' | 'personaId'>,
  patch: ScriptOverlay,
  /** The scripted member, whose background and first message are the work's; undefined when none is. */
  lead: string | undefined,
): Promise<string[]> {
  const rewrites = Object.entries(patch.members ?? {});
  for (const [id, fields] of rewrites) {
    const [member] = await tx
      .select({ name: characters.name, card: characters.card })
      .from(characters)
      .where(and(eq(characters.id, id), eq(characters.plotId, chat.plotId)))
      .for('update');
    if (!member) continue;
    await tx
      .update(characters)
      .set({
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        card: rewrittenCard(member.card, fields),
        updatedAt: new Date(),
      })
      .where(eq(characters.id, id));
  }
  const leading = lead === undefined ? undefined : patch.members?.[lead];
  const background = leading?.backgroundHtml;
  const firstMessage = leading?.firstMessage;
  const renamed = rewrites.findLast(([, fields]) => fields.name !== undefined)?.[1].name;
  if (background !== undefined || firstMessage !== undefined || renamed !== undefined) {
    const [plot] = await tx
      .select({ customUi: plots.customUi, intros: plots.intros })
      .from(plots)
      .where(eq(plots.id, chat.plotId))
      .for('update');
    const [roster] =
      renamed === undefined
        ? []
        : await tx.select({ count: sql<number>`count(*)::int` }).from(characters).where(eq(characters.plotId, chat.plotId));
    if (plot) {
      await tx
        .update(plots)
        .set({
          ...(background !== undefined ? { customUi: { ...(plot.customUi ?? {}), backgroundHtml: background } } : {}),
          ...(firstMessage !== undefined ? { intros: [firstMessage, ...plot.intros.slice(1)] } : {}),
          ...(renamed !== undefined && roster?.count === 1 ? { name: renamed } : {}),
          updatedAt: new Date(),
        })
        .where(eq(plots.id, chat.plotId));
    }
  }
  const dropped: string[] = [];
  if (firstMessage !== undefined) {
    // Each chat's oldest root, where it is a greeting: the first opening it has.
    // Its revision moves, as a script commit's does, so a commit made over the old
    // text is refused rather than written over the new one.
    const { rows: greetings } = await tx.execute<{ id: string; chat_id: string; was: string }>(sql`
      update messages set content = ${firstMessage}, script_rev = script_rev + 1
      from (
        select distinct on (m.chat_id) m.id, m.content from messages m join chats c on c.id = m.chat_id
        where c.plot_id = ${chat.plotId} and m.parent_id is null
        order by m.chat_id, m.created_at, m.id
      ) greeting
      where messages.id = greeting.id and messages.role = 'assistant'
      returning messages.id, messages.chat_id, greeting.content as was`);
    // Only a greeting whose words changed: a script that writes the same first
    // message on every turn leaves the memory as it was.
    for (const greeting of greetings) {
      if (greeting.was === firstMessage) continue;
      if ((await invalidateMemoryForEdit(tx, greeting.chat_id, greeting.id)) > 0) dropped.push(greeting.chat_id);
    }
  }
  if (patch.persona !== undefined && chat.personaId) {
    await tx.update(personas).set({ description: patch.persona }).where(eq(personas.id, chat.personaId));
  }
  return dropped;
}

/**
 * Keeps what the scripts of a generation rewrote: the work's rewrites written
 * into it, the note and the chat's lore, in one transaction. Called inside the
 * generation slot once the request has passed every check, so a refused
 * generation writes none of it.
 */
export async function saveScriptWrites(
  deps: AppDeps,
  chat: Pick<Chat, 'id' | 'plotId' | 'personaId'>,
  scripts: Pick<GenerationScripts, 'overlay' | 'note' | 'localLore'>,
  /** The scripted member (`writeScriptRewrite`). */
  lead: string | undefined,
): Promise<void> {
  const { overlay, note, localLore } = scripts;
  if (!overlay && note === undefined && localLore === undefined) return;
  await deps.db.transaction(async (tx) => {
    if (note !== undefined || localLore !== undefined) {
      await tx
        .update(chats)
        .set({
          ...(note !== undefined ? { note } : {}),
          ...(localLore !== undefined ? { localLore: localLore.length > 0 ? localLore : null } : {}),
        })
        .where(eq(chats.id, chat.id));
    }
    if (overlay) await writeScriptRewrite(tx, chat, overlay, lead);
  });
}

/** What a request made over a head that has since moved is refused with. */
export const headMoved = (): ApiError =>
  new ApiError(409, 'head_moved', 'The chat has moved on from the message the scripts ran on');

/** What a script commit computed on a revision of the turn that is gone is refused with. */
export const scriptRevMoved = (): ApiError =>
  new ApiError(409, 'script_rev_moved', 'The message changed after the scripts read it');

/* ------------------------------------------------------ global variables */

/**
 * A work's global variables: how many names, and how many characters in all.
 * Smaller than a message's delta — the whole map rides on every chat state,
 * and none of it is ever evicted.
 */
export const MAX_GLOBAL_VARIABLE_KEYS = 256;
export const MAX_GLOBAL_VARIABLE_CHARS = 256_000;

const GLOBAL_LIMITS = { keys: MAX_GLOBAL_VARIABLE_KEYS, chars: MAX_GLOBAL_VARIABLE_CHARS };

/** What a write that would take the global variables past `GLOBAL_LIMITS` is refused with. */
const globalVariablesLimit = (): ApiError =>
  badRequest(
    'global_variables_limit',
    `Global variables may hold at most ${MAX_GLOBAL_VARIABLE_KEYS} names and ${MAX_GLOBAL_VARIABLE_CHARS} characters`,
  );

/** The work's global variables; empty until something set one. */
export async function loadGlobalVariables(deps: AppDeps, plotId: string): Promise<Variables> {
  const [row] = await deps.db
    .select({ variables: plotReaderVariables.variables })
    .from(plotReaderVariables)
    .where(eq(plotReaderVariables.plotId, plotId))
    .limit(1);
  return applyVariableDelta(row?.variables ?? {}, null);
}

/**
 * The global variables as a chat reads them — RisuAI's `getGlobalChatVar`: the
 * chat's own value of a name (its "Local Toggles" values,
 * `chats.local_global_variables`) wherever it is set and neither blank nor
 * `'null'`, else the work's. Read so whether the chat's switch is on or off, as
 * RisuAI reads `GLGlobalVariables` either way.
 */
export function withLocalGlobals(globals: Variables, local: Variables | null | undefined): Variables {
  if (!local) return globals;
  const kept: VariableDelta = Object.create(null) as VariableDelta;
  for (const key of Object.keys(local)) {
    const value = local[key];
    if (typeof value === 'string' && value !== '' && value !== 'null') kept[key] = value;
  }
  return applyVariableDelta(globals, kept);
}

/** The work's global variables as one chat on it reads them (`withLocalGlobals`). */
export async function loadChatGlobalVariables(
  deps: AppDeps,
  chat: Pick<Chat, 'plotId' | 'localGlobalVariables'>,
): Promise<Variables> {
  return withLocalGlobals(await loadGlobalVariables(deps, chat.plotId), chat.localGlobalVariables);
}

/**
 * A write of the chat's toggles — RisuAI's `setGlobalChatVar`, which only its
 * toggles sidebar calls: with the chat's "Local Toggles" on, into the chat's own
 * values; off, into the work's globals, the chat's own value of each name
 * written taken away first so the global one shows. Answers the globals as the
 * chat now reads them.
 */
export async function writeChatToggles(
  deps: AppDeps,
  chat: Pick<Chat, 'id' | 'plotId'>,
  patch: unknown,
): Promise<Variables> {
  const check = checkVariableDelta(patch, GLOBAL_LIMITS);
  if (!check.ok) throw badRequest('invalid_request', `variables ${check.error}`);
  const delta = check.delta;
  const { localToggles, local } = await deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ localToggles: chats.localToggles, local: chats.localGlobalVariables })
      .from(chats)
      .where(eq(chats.id, chat.id))
      .for('update');
    const own = locked?.local ?? null;
    if (!locked || !delta) return { localToggles: locked?.localToggles ?? false, local: own };
    let next: Variables | null;
    if (locked.localToggles) {
      next = applyVariableDelta(own ?? {}, delta);
      if (!checkVariableDelta(next, GLOBAL_LIMITS).ok) throw globalVariablesLimit();
    } else {
      const cleared: VariableDelta = Object.create(null) as VariableDelta;
      for (const key of Object.keys(delta)) cleared[key] = null;
      next = own ? applyVariableDelta(own, cleared) : null;
    }
    const stored = next && Object.keys(next).length > 0 ? storableVariables(next) : null;
    await tx.update(chats).set({ localGlobalVariables: stored }).where(eq(chats.id, chat.id));
    return { localToggles: locked.localToggles, local: stored };
  });
  const globals =
    delta && !localToggles
      ? await mergeGlobalVariables(deps, chat.plotId, delta)
      : await loadGlobalVariables(deps, chat.plotId);
  return withLocalGlobals(globals, local);
}

/**
 * Merges `patch` into the work's global variables — a string sets, `null`
 * unsets — and answers with the whole map. The row is created on the first
 * write and locked for the read-merge-write, so two writes at once each land on
 * top of the other rather than one undoing it; the cap is a property of the
 * merged map, checked under that lock.
 */
export async function mergeGlobalVariables(deps: AppDeps, plotId: string, patch: unknown): Promise<Variables> {
  const check = checkVariableDelta(patch, GLOBAL_LIMITS);
  if (!check.ok) throw badRequest('invalid_request', `variables ${check.error}`);
  const delta = check.delta;
  if (!delta) return loadGlobalVariables(deps, plotId);

  return deps.db.transaction(async (tx) => {
    await tx.insert(plotReaderVariables).values({ plotId }).onConflictDoNothing();
    const where = eq(plotReaderVariables.plotId, plotId);
    const [row] = await tx
      .select({ variables: plotReaderVariables.variables })
      .from(plotReaderVariables)
      .where(where)
      .for('update');
    const merged = applyVariableDelta(row?.variables ?? {}, delta);
    // The merge, read as a delta from nothing, is held to the same caps.
    if (!checkVariableDelta(merged, GLOBAL_LIMITS).ok) throw globalVariablesLimit();
    await tx
      .update(plotReaderVariables)
      .set({ variables: storableVariables(merged), updatedAt: new Date() })
      .where(where);
    return merged;
  });
}
