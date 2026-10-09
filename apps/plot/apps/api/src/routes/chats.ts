import type { ChatExport, ChatExportVariableSnapshot } from '@shizue/contracts';
import {
  applyMacros,
  coerceNarrator,
  computeVariables,
  DEFAULT_USER_NAME,
  getPreset,
  imageMacroSlugs,
  isNarration,
  isPresetId,
  isSceneMessage,
  MAX_COMPONENT_TURN_LENGTH,
  MAX_DIRECTIONS_LENGTH,
  NARRATION_PREFIX,
  readVariable,
  stripImageMacros,
  stripVariableMacros,
  withNarrationPrefix,
  type HistoryMessage,
  type LoreTimedState,
  type MacroClock,
  type MacroContext,
  type NarratorConfig,
  type PromptCharacter,
  type PromptPlot,
  type Variables,
} from '@shizue/core';
import {
  chatAttachments,
  chatNoteLinks,
  chats,
  MAX_MEMORY_RETRIEVAL_COUNT,
  MEMORY_CONTEXT_BUDGETS,
  MEMORY_SUMMARY_THRESHOLDS,
  messages,
  personas,
  plots,
  plotAssets,
  type Character,
  type Chat,
  type ChatAttachment,
  type ChatMemorySettings,
  type Message,
  type MessageRole,
  type MessageSource,
  type Persona,
  type Plot,
} from '@shizue/db';
import { getModel } from '@shizue/llm';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { assetUrl, coerceAssetPreview } from '../assets.js';
import {
  attachmentsByMessage,
  attachmentUrl,
  bindAttachments,
  countUnboundAttachments,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_UNBOUND_ATTACHMENTS,
  saveAttachment,
  sweepStaleAttachments,
  toAttachmentJson,
  withTurnImages,
} from '../attachments.js';
import type { AppDeps, AppEnv } from '../deps.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import {
  acquireChatSlot,
  HEARTBEAT_MS,
  inspectGeneration,
  isGenerating,
  rejectBusyChat,
  releaseChatSlot,
  renewChatSlot,
  withGenerationSlot,
  type GenerationPlan,
} from '../generation.js';
import { avatarUrl, coverUrl, loadMembers, loadVisiblePlot, visibleToViewer } from '../hub.js';
import { buildMemoryInput, invalidateMemoryForEdit, memorySettingsOf } from '../memory.js';
import {
  attachedNoteIds,
  attachedNoteIdsByChat,
  loadAuthorNote,
  loadOwnedNote,
  MAX_CHAT_NOTES,
} from '../notes.js';
import { buildRelationshipText } from '../relationship.js';
import { drawSceneEnabled, generateSceneImage, sceneImagePrompt } from '../sceneImage.js';
import { deleteQuietly } from '../storage.js';
import { toPromptCharacters, toPromptPlot } from '../plots.js';
import { suggestReplies } from '../suggest.js';
import { buildPath, deepestLeaf, siblingInfo } from '../tree.js';
import { assetLocks } from '../unlocks.js';
import {
  isUuid,
  optionalBoolean,
  optionalString,
  readJsonBody,
  requireString,
  requireUuidParam,
} from '../util.js';

const toChatJson = (chat: Chat, noteIds: string[]) => ({
  id: chat.id,
  plotId: chat.plotId,
  personaId: chat.personaId,
  title: chat.title,
  model: chat.model,
  note: chat.note,
  preset: chat.preset,
  headMessageId: chat.headMessageId,
  memory: chat.memory,
  memorySettings: chat.memorySettings,
  relationship: chat.relationship,
  relationshipEnabled: chat.relationshipEnabled,
  /** This chat's narrator override; null leaves the plot's own in force. */
  narrator: chat.narrator,
  /** Whether this chat's components may send turns; the reader grants it once. */
  allowComponentTurns: chat.allowComponentTurns,
  /**
   * The reader's half of the plot's two style features. Both stand on their own
   * only while the plot asks for the feature at all — a chat on a plot with no
   * status window carries a true nobody ever sees.
   */
  statusWindowEnabled: chat.statusWindowEnabled,
  choicesEnabled: chat.choicesEnabled,
  /** One of the model's advertised efforts, or null to send none. */
  reasoningEffort: chat.reasoningEffort,
  /**
   * Members the reader sent off the stage; empty while the whole roster is on.
   * An id whose member has since been deleted may linger here — it matches
   * nobody, so it is simply ignored.
   */
  absentCharacterIds: chat.absentCharacterIds ?? [],
  /** Reusable notes attached to this chat, in injection order. */
  noteIds,
  createdAt: chat.createdAt.toISOString(),
  updatedAt: chat.updatedAt.toISOString(),
});

const toMessageJson = (message: Message, attachments: ChatAttachment[] = []) => ({
  id: message.id,
  parentId: message.parentId,
  role: message.role,
  content: message.content,
  /** 'component' when a card component sent this turn for the reader. */
  source: message.source,
  /** The turn's stage directions, or null. Never part of the rendered text. */
  directions: message.directions,
  model: message.model,
  promptTokens: message.promptTokens,
  completionTokens: message.completionTokens,
  /** Images the reader attached to this turn; empty on all but a few of them. */
  attachments: attachments.map(toAttachmentJson),
  createdAt: message.createdAt.toISOString(),
});

/** Loads a chat owned by the caller; other users' rows are simply not found. */
export async function loadOwnedChat(deps: AppDeps, id: string, userId: string): Promise<Chat> {
  const [chat] = await deps.db
    .select()
    .from(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .limit(1);
  if (!chat) throw notFound('Chat not found');
  return chat;
}

async function loadMessages(deps: AppDeps, chatId: string): Promise<Message[]> {
  return deps.db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt));
}

/**
 * How much of a branch one read returns when the caller does not say. Long enough
 * that no ordinary chat is ever paged, short enough that a very long one does not
 * arrive as a single megabyte.
 */
const DEFAULT_PATH_LIMIT = 200;
/** Ceiling for an explicit `limit`; a larger one is silently clamped to this. */
const MAX_PATH_LIMIT = 500;

/**
 * The slice of the branch a read wants. The cursor is a message id *on the current
 * branch* — the client pages backwards by asking again with the first id of the
 * window it already holds — and the window is the `limit` messages that end just
 * before it, or at the head when it is absent.
 */
interface PathWindow {
  before?: string;
  limit: number;
}

/** The window's messages, and the stretch of the branch it left behind in front. */
function windowPath(path: Message[], window: PathWindow): { path: Message[]; earlier: Message[] } {
  const end = window.before === undefined ? path.length : path.findIndex((m) => m.id === window.before);
  // A cursor that is not on this branch is the client asking about a branch it no
  // longer has: answering with the newest window instead would look like history.
  if (end === -1) throw badRequest('invalid_request', 'before is not a message on the current branch');
  const start = Math.max(0, end - window.limit);
  return { path: path.slice(start, end), earlier: path.slice(0, start) };
}

/**
 * The variable fold the window starts from: the branch's macros up to its first
 * message, over the plot's defaults.
 *
 * The prompt is assembled from the whole branch and never needed this, but the
 * client folds only what it loaded — so a `{{setvar}}` in the stretch it paged
 * past would silently drop out of the status window it drives. Sent only where
 * something really was left behind; an unwindowed read starts from the defaults
 * the client already has.
 */
async function windowVariableDefaults(
  deps: AppDeps,
  chat: Chat,
  earlier: Message[],
): Promise<Variables> {
  const plot = await loadChatPlot(deps, chat, chat.userId);
  return computeVariables(
    earlier.map((message) => message.content),
    plot?.customUi?.defaultVariables,
  );
}

/**
 * `{ chat, path, siblings }` — the view of the currently selected branch. A
 * `window` narrows `path` to its newest stretch and adds `hasMore` — plus
 * `variableDefaults` where it really cut something; `siblings` is still computed
 * against every message in the chat, so a windowed read carries whole swipe
 * groups even where the sibling's parent fell outside the window.
 */
async function chatState(deps: AppDeps, chat: Chat, window?: PathWindow): Promise<unknown> {
  const all = await loadMessages(deps, chat.id);
  const full = buildPath(all, chat.headMessageId);
  const windowed = window ? windowPath(full, window) : null;
  const path = windowed ? windowed.path : full;
  // A user turn carries what the reader attached; an assistant one carries a
  // scene the reader had drawn, so both are asked about.
  const attachments = await attachmentsByMessage(deps, path.map((message) => message.id));
  return {
    chat: toChatJson(chat, await attachedNoteIds(deps, chat.id)),
    path: path.map((message) => toMessageJson(message, attachments.get(message.id) ?? [])),
    siblings: siblingInfo(all, path),
    /**
     * What this chat may show of the plot's images: every asset, whether it is
     * open here, and — for the ones that are not — which kind of condition it
     * waits on. The condition itself never travels; the creator's own chats see
     * everything open.
     */
    assetLocks: await assetLocks(deps, chat),
    ...(windowed ? { hasMore: windowed.earlier.length > 0 } : {}),
    ...(windowed && windowed.earlier.length > 0
      ? { variableDefaults: await windowVariableDefaults(deps, chat, windowed.earlier) }
      : {}),
    /**
     * What this deployment can do beyond the base chat. An env-gated action
     * answers here rather than 404ing a button the reader can already see —
     * without a fal credential `drawScene` is off and the action is not offered.
     */
    capabilities: { drawScene: drawSceneEnabled(deps) },
    /**
     * Whether the reader is also the plot's creator — the one person the
     * chat's assembled prompt may be shown to (`GET /:id/inspect`).
     */
    isPlotOwner: await ownsPlot(deps, chat.plotId, chat.userId),
  };
}

/** Whether the user is the plot's creator, whatever its visibility. */
async function ownsPlot(deps: AppDeps, plotId: string, userId: string): Promise<boolean> {
  const [plot] = await deps.db
    .select({ ownerId: plots.ownerId })
    .from(plots)
    .where(eq(plots.id, plotId))
    .limit(1);
  return plot?.ownerId === userId;
}

/** Reads the `before`/`limit` query pair a branch read may narrow itself with. */
function pathWindow(c: Context<AppEnv>): PathWindow {
  const before = c.req.query('before');
  if (before !== undefined && !isUuid(before)) {
    throw badRequest('invalid_request', 'before must be a uuid');
  }
  const raw = c.req.query('limit');
  const limit = raw === undefined ? DEFAULT_PATH_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw badRequest('invalid_request', 'limit must be a positive integer');
  }
  return { ...(before === undefined ? {} : { before }), limit: Math.min(limit, MAX_PATH_LIMIT) };
}

async function requireEnabledModel(deps: AppDeps, userId: string, model: string): Promise<string> {
  const entry = await getModel(model, deps.env, deps.chatgpt?.accounts.forUser(userId));
  if (!entry) {
    throw badRequest('model_unavailable', `Model not available: ${model}`);
  }
  return model;
}

/**
 * The reasoning effort a PATCH leaves the chat with; undefined leaves it alone. A
 * requested effort must be one the chat's model advertises — the new model, when
 * the same body switches it — and null clears it. A model switch on its own keeps
 * the stored effort only where the new model offers it too, so the setting never
 * names something the selector cannot show.
 */
async function patchedReasoningEffort(
  deps: AppDeps,
  userId: string,
  body: Record<string, unknown>,
  chat: Chat,
  model: string | undefined,
): Promise<string | null | undefined> {
  const offered = async (id: string): Promise<string[]> =>
    (await getModel(id, deps.env, deps.chatgpt?.accounts.forUser(userId)))?.reasoningEfforts ?? [];
  const requested = body['reasoningEffort'];
  if (requested === null) return null;
  if (requested === undefined) {
    if (model === undefined || chat.reasoningEffort === null) return undefined;
    return (await offered(model)).includes(chat.reasoningEffort) ? undefined : null;
  }
  if (typeof requested !== 'string') {
    throw badRequest('invalid_request', 'reasoningEffort must be a string or null');
  }
  const target = model ?? chat.model;
  if (!(await offered(target)).includes(requested)) {
    throw badRequest('invalid_request', `Reasoning effort not offered by ${target}: ${requested}`);
  }
  return requested;
}

/** Validates an optional preset id against the catalog @shizue/core owns. */
function optionalPreset(body: Record<string, unknown>): string | undefined {
  const value = body['preset'];
  if (value === undefined) return undefined;
  if (!isPresetId(value)) throw badRequest('invalid_request', `Unknown preset: ${String(value)}`);
  return value;
}

/**
 * Validates `memorySettings`. Every key is optional and only the whitelisted
 * values pass; keys the pipeline does not know are dropped rather than stored, so
 * the column never grows a setting nothing reads. `null` resets the chat to the
 * pipeline defaults.
 */
function optionalMemorySettings(body: Record<string, unknown>): ChatMemorySettings | null | undefined {
  const value = body['memorySettings'];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_request', 'memorySettings must be an object or null');
  }
  const input = value as Record<string, unknown>;

  const pick = <T extends number>(key: string, allowed: readonly T[]): T | undefined => {
    const setting = input[key];
    if (setting === undefined) return undefined;
    if (!allowed.includes(setting as T)) {
      throw badRequest('invalid_request', `Unsupported ${key}: ${String(setting)}`);
    }
    return setting as T;
  };

  const contextBudget = pick('contextBudget', MEMORY_CONTEXT_BUDGETS);
  const summaryThreshold = pick('summaryThreshold', MEMORY_SUMMARY_THRESHOLDS);
  const retrievalCount = input['retrievalCount'];
  if (
    retrievalCount !== undefined &&
    (typeof retrievalCount !== 'number' ||
      !Number.isInteger(retrievalCount) ||
      retrievalCount < 0 ||
      retrievalCount > MAX_MEMORY_RETRIEVAL_COUNT)
  ) {
    throw badRequest(
      'invalid_request',
      `retrievalCount must be an integer between 0 and ${MAX_MEMORY_RETRIEVAL_COUNT}`,
    );
  }

  return {
    ...(contextBudget !== undefined ? { contextBudget } : {}),
    ...(summaryThreshold !== undefined ? { summaryThreshold } : {}),
    ...(retrievalCount !== undefined ? { retrievalCount: retrievalCount as number } : {}),
  };
}

/**
 * Validates the per-chat `narrator` override, on the same whitelist the plot's
 * own setting passes through. `null` clears the column and hands the chat back to
 * the plot's narrator; so does an object whose fields all fail the whitelist,
 * since storing `{}` would only mean the same thing in a shape nothing reads.
 */
function optionalNarrator(body: Record<string, unknown>): NarratorConfig | null | undefined {
  const value = body['narrator'];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_request', 'narrator must be an object or null');
  }
  const narrator = coerceNarrator(value);
  return Object.keys(narrator).length > 0 ? narrator : null;
}

/** Validates an optional personaId: it must belong to the caller. */
async function resolvePersona(deps: AppDeps, userId: string, value: unknown): Promise<Persona | null> {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest('invalid_request', 'personaId must be a string or null');
  if (!isUuid(value)) throw notFound('Persona not found');
  const [persona] = await deps.db
    .select()
    .from(personas)
    .where(and(eq(personas.id, value), eq(personas.userId, userId)))
    .limit(1);
  if (!persona) throw notFound('Persona not found');
  return persona;
}

/**
 * The persona a chat starts with. The reader either points at one of their own or
 * picks one of the plot's recommended profiles, never both: a profile is
 * **copied** into their personas the moment they pick it, so what the chat points
 * at is always a row the reader owns and may edit afterwards like any other.
 *
 * The copy is made per chat start and never deduplicated — it is one cheap row,
 * and two chats started on the same profile are two personas the reader may take
 * in different directions.
 */
async function startPersona(
  deps: AppDeps,
  userId: string,
  plot: Plot,
  body: Record<string, unknown>,
): Promise<Persona | null> {
  const profileId = body['profileId'];
  if (profileId === undefined || profileId === null) {
    return resolvePersona(deps, userId, body['personaId']);
  }
  if (body['personaId'] !== undefined && body['personaId'] !== null) {
    throw badRequest('invalid_request', 'personaId and profileId are mutually exclusive');
  }
  if (typeof profileId !== 'string') {
    throw badRequest('invalid_request', 'profileId must be a string or null');
  }
  const profile = (plot.profiles ?? []).find((entry) => entry.id === profileId);
  if (!profile) throw notFound('Profile not found');

  const [created] = await deps.db
    .insert(personas)
    .values({ userId, name: profile.name, description: profile.description })
    .returning();
  return created!;
}

async function loadPersona(deps: AppDeps, chat: Chat): Promise<Persona | null> {
  if (!chat.personaId) return null;
  const [persona] = await deps.db
    .select()
    .from(personas)
    .where(eq(personas.id, chat.personaId))
    .limit(1);
  return persona ?? null;
}

/** Plot, roster, persona and branch history — what every generation mode needs. */
async function loadGenerationContext(
  deps: AppDeps,
  chat: Chat,
): Promise<{
  plot: PromptPlot;
  /** The whole roster, the members the reader sent off the stage marked absent. */
  characters: PromptCharacter[];
  /** The members still on the stage — the ones a reply may be asked to center on. */
  onStage: Character[];
  /** The row itself, for the settings that are the plot's rather than the prompt's. */
  row: Plot;
  personaText: string;
  userName: string;
  authorNote: string;
  narrator: NarratorConfig | undefined;
  all: Message[];
}> {
  // Re-checked on every generation, not just at chat creation: unpublishing a
  // plot has to stop other users' chats with it from generating further.
  const row = await loadVisiblePlot(deps.db, chat.plotId, chat.userId);
  // In the creator's order, which is the order the prompt blocks are written in.
  const members = await loadMembers(deps.db, row.id);
  const absent = new Set(chat.absentCharacterIds ?? []);

  const persona = await loadPersona(deps, chat);
  return {
    // Crossed with this chat's own toggles: the style the assembler compiles is
    // the creator's, minus the two features this reader turned off.
    plot: toPromptPlot(row, chat),
    characters: toPromptCharacters(members, absent),
    onStage: members.filter((member) => !absent.has(member.id)),
    row,
    personaText: persona?.description ?? '',
    userName: persona?.name ?? DEFAULT_USER_NAME,
    // The narrator in force: the chat's own if it set one, the plot's
    // otherwise. Whole rather than field by field — a reader who overrides the
    // voice is describing a narrator, not patching the creator's.
    narrator: chat.narrator ?? row.narrator ?? undefined,
    // The chat's own note plus the reusable notes attached to it.
    authorNote: await loadAuthorNote(deps, chat),
    all: await loadMessages(deps, chat.id),
  };
}

const toHistory = (path: Message[]): HistoryMessage[] =>
  path.map((message) => ({ role: message.role, content: message.content }));

/** Header the web client names the reader's IANA time zone in. */
const TIME_ZONE_HEADER = 'x-shizue-tz';

/**
 * The reader's time zone as the client reported it. Anything Intl refuses — or
 * nothing at all — is UTC: a clock macro must never be what fails a turn.
 */
function requestTimeZone(c: Context<AppEnv>): string {
  const zone = c.req.header(TIME_ZONE_HEADER);
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/**
 * The reader's clock for the time macros, in the plot's content language. The
 * idle time is the gap between the branch's latest user message and the one
 * before it — how long the reader was away before this turn — so a regenerate
 * of the same turn reads the same value.
 */
function requestClock(c: Context<AppEnv>, plot: Plot, branch: Message[] = []): MacroClock {
  const user = branch.findLastIndex((message) => message.role === 'user');
  const idleMs =
    user > 0 ? branch[user]!.createdAt.getTime() - branch[user - 1]!.createdAt.getTime() : undefined;
  return {
    now: new Date(),
    timeZone: requestTimeZone(c),
    locale: plot.language,
    ...(idleMs !== undefined ? { idleMs } : {}),
  };
}

/**
 * The lore records of the branch a new message is about to end, for the timed
 * effects: the whole branch, since a sticky entry outlives the history the
 * memory trims, and the new message's index is its length.
 */
function loreStateOf(branch: Message[]): LoreTimedState {
  const lastTriggered: Record<string, number> = {};
  branch.forEach((message, index) => {
    for (const key of message.loreTriggers ?? []) lastTriggered[key] = index;
  });
  return { chatLength: branch.length, lastTriggered };
}

/**
 * The branch as the model reads it: the turns, plus the images the turn being
 * answered carries — or, for a model without vision, the note that says it
 * carried them. Every mode goes through here, `send` included: it appends the
 * turn it has just stored to the history and lets this find its uploads.
 */
const promptHistory = (deps: AppDeps, userId: string, model: string, source: Message[]): Promise<HistoryMessage[]> =>
  withTurnImages(deps, userId, model, source, toHistory(source));

/**
 * Chat variables of a branch. Folded over the *whole* branch rather than the
 * history the budget left room for: a variable set fifty turns ago must survive
 * its message being evicted, and the client derives the same map from the same
 * messages, so both sides agree without either storing anything.
 */
const pathVariables = (plot: Plot, texts: string[]): Variables =>
  computeVariables(texts, plot.customUi?.defaultVariables);

/** Same keys, same values — what "the fold did not move" means for a snapshot. */
function sameVariables(a: Variables, b: Variables): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => readVariable(a, key) === readVariable(b, key))
  );
}

/**
 * The variable fold as it stood at each assistant message of the branch, kept
 * only where it moved: an importer replays change points, and a branch on which
 * no macro ever fired carries none at all. `defaults` is the state the first
 * snapshot is compared against, so a plot that merely declares variables nobody
 * touches produces an empty timeline — and a withdrawn plot contributes no
 * defaults at all, leaving only what the conversation itself set.
 */
function variableTimeline(
  defaults: Variables | undefined,
  path: Message[],
): ChatExportVariableSnapshot[] {
  const timeline: ChatExportVariableSnapshot[] = [];
  // Folded message by message instead of re-reading the prefix at every step;
  // `computeVariables` takes the state so far as its defaults, so each result is
  // exactly what `pathVariables` would return for that prefix.
  let variables = computeVariables([], defaults);
  let previous = variables;
  for (const message of path) {
    variables = computeVariables([message.content], variables);
    if (message.role !== 'assistant' || sameVariables(previous, variables)) continue;
    timeline.push({ messageId: message.id, variables });
    previous = variables;
  }
  return timeline;
}

/**
 * Stands in for the name of a withdrawn plot when the chat row has no title of
 * its own to fall back on — a chat is titled with the plot's name when it is
 * created, so this is only reached for a plot that never had one.
 */
const WITHDRAWN_PLOT_NAME = '알 수 없는 작품';

/**
 * The chat's plot if the caller may still read it, and null once they may not —
 * unpublished, safety-gated, or gone. Unlike `loadVisiblePlot` this does not
 * throw: a chat stays the user's own record whatever the creator later does with
 * the work, so the caller degrades what the plot contributes rather than
 * refusing the whole request.
 */
async function loadChatPlot(deps: AppDeps, chat: Chat, userId: string): Promise<Plot | null> {
  const [plot] = await deps.db
    .select()
    .from(plots)
    .where(and(eq(plots.id, chat.plotId), visibleToViewer(userId)))
    .limit(1);
  return plot ?? null;
}

/** How much of the last message the chat list carries. */
const LAST_MESSAGE_PREVIEW_LENGTH = 200;

/**
 * Covers of the chats' plots, by plot id. A work the caller may no longer read
 * contributes nothing — the same rule the export applies, for the same reason:
 * the picture is the creator's to withdraw, the conversation is not.
 */
async function chatCovers(
  deps: AppDeps,
  rows: Chat[],
  userId: string,
): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.map((chat) => chat.plotId))];
  if (ids.length === 0) return new Map();
  const found = await deps.db
    .select({ id: plots.id, coverPath: plots.coverPath })
    .from(plots)
    .where(and(inArray(plots.id, ids), visibleToViewer(userId)));
  return new Map(found.map((plot) => [plot.id, coverUrl(plot)]));
}

/**
 * How each chat currently reads, by chat id: the head message, cut to a preview.
 * Stripped before the cut, like the greeting preview — slicing first can leave
 * half a reference behind, and the macros are protocol rather than prose.
 */
async function lastMessages(deps: AppDeps, rows: Chat[]): Promise<Map<string, string>> {
  const heads = rows.map((chat) => chat.headMessageId).filter((id): id is string => id !== null);
  if (heads.length === 0) return new Map();
  const found = await deps.db
    .select({ chatId: messages.chatId, content: messages.content })
    .from(messages)
    .where(inArray(messages.id, heads));
  return new Map(
    found.map((message) => [
      message.chatId,
      stripVariableMacros(stripImageMacros(message.content)).slice(0, LAST_MESSAGE_PREVIEW_LENGTH),
    ]),
  );
}

/**
 * The plot's assets the branch actually shows, in the order the asset list uses.
 * A `{{img::slug}}` naming an asset that has since been deleted exports nothing —
 * the same thing the chat renders for it.
 */
async function referencedAssets(
  deps: AppDeps,
  plotId: string,
  path: Message[],
): Promise<ChatExport['assets']> {
  const referenced = new Set(path.flatMap((message) => imageMacroSlugs(message.content)));
  if (referenced.size === 0) return [];
  const rows = await deps.db
    .select()
    .from(plotAssets)
    .where(eq(plotAssets.plotId, plotId))
    .orderBy(asc(plotAssets.createdAt), asc(plotAssets.slug));
  return rows
    .filter((asset) => referenced.has(asset.slug))
    .map((asset) => ({ slug: asset.slug, url: assetUrl(plotId, asset.slug), mime: asset.mime }));
}

const lastUserMessage = (path: Message[]): Message | undefined =>
  [...path].reverse().find((message) => message.role === 'user');

/** Retrieval query for the memory layer. */
const lastUserText = (path: Message[]): string => lastUserMessage(path)?.content ?? '';

/**
 * Stage directions of the turn being answered. Only the last user message's are
 * injected, so a regenerate re-applies exactly what the original turn carried and
 * an earlier turn's ruling never comes back.
 */
const lastUserDirections = (path: Message[]): string => lastUserMessage(path)?.directions ?? '';

/**
 * A component turn is only the reader's turn if the reader agreed to it.
 *
 * The browser gates this three ways already, but the browser is the half a
 * component has influence over, and the label is what makes a turn a component's:
 * anything holding a session cookie can post one. So both halves of the grant are
 * re-read from the database on every send — consent from the chat row, the
 * capability from the plot as it stands right now — and a consent revoked in
 * another tab, or a capability the creator has since removed, stops the very next
 * request rather than the next reload.
 */
function requireComponentTurnAllowed(chat: Chat, plot: Plot): void {
  if (!chat.allowComponentTurns) {
    throw forbidden('component_turns_not_allowed', 'This chat has not allowed component turns');
  }
  if (!plot.customUi?.componentCapabilities?.includes('sendTurn')) {
    throw forbidden(
      'component_turns_not_allowed',
      'This plot does not declare the sendTurn capability',
    );
  }
}

/** Who is sending a turn. Anything but the two known values is a client bug. */
function optionalSource(body: Record<string, unknown>): MessageSource | undefined {
  const value = body['source'];
  if (value === undefined) return undefined;
  if (value !== 'user' && value !== 'component') {
    throw badRequest('invalid_request', 'source must be "user" or "component"');
  }
  return value;
}

/**
 * Stage directions to store with a turn. They are user-trust-level input — the
 * reader already controls every word of their own message, and a component only
 * ever acts inside a chat they consented to — so only the length is checked.
 */
function optionalDirections(body: Record<string, unknown>): string | undefined {
  const value = optionalString(body, 'directions');
  if (value === undefined) return undefined;
  if (value.length > MAX_DIRECTIONS_LENGTH) {
    throw badRequest(
      'invalid_request',
      `directions may be at most ${MAX_DIRECTIONS_LENGTH} characters`,
    );
  }
  return value;
}

/**
 * Uploads a send is claiming for its turn. Whether they are this chat's own, and
 * still unclaimed, is settled by the write itself (`bindAttachments`); this is
 * the shape and the count.
 */
function optionalAttachmentIds(body: Record<string, unknown>): string[] {
  const value = body['attachmentIds'];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('invalid_request', 'attachmentIds must be an array');
  const ids = value.map((id) => {
    if (typeof id !== 'string' || !isUuid(id)) {
      throw badRequest('invalid_request', 'attachmentIds must be attachment ids');
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw badRequest('invalid_request', 'attachmentIds must not repeat an id');
  }
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw badRequest(
      'attachment_limit',
      `A message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} images`,
    );
  }
  return ids;
}

/** A list of member ids in a body, shape only and without repeats; absent is empty. */
function optionalMemberIds(body: Record<string, unknown>, key: string): string[] | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw badRequest('invalid_request', `${key} must be an array of character ids`);
  }
  return [...new Set(value as string[])];
}

/**
 * The members a PATCH sends off the stage. Every id must be one of the plot's
 * members as the roster stands — read whatever became of the plot's visibility,
 * since the setting is the reader's own — and an empty list is stored as null:
 * the whole roster on, the same as a chat that never touched it.
 */
async function patchedAbsentIds(
  deps: AppDeps,
  body: Record<string, unknown>,
  chat: Chat,
): Promise<string[] | null | undefined> {
  const ids = optionalMemberIds(body, 'absentCharacterIds');
  if (!ids?.length) return ids === undefined ? undefined : null;
  const members = new Set((await loadMembers(deps.db, chat.plotId)).map((member) => member.id));
  if (ids.some((id) => !members.has(id))) {
    throw badRequest('invalid_request', 'absentCharacterIds must name members of the plot');
  }
  return ids;
}

/**
 * The names of the members a turn asked to center on, in roster order. Only a
 * member on the stage can be asked for: one the reader sent away is not in the
 * scene to speak, and the prompt already says so.
 */
function focusNamesOf(onStage: Character[], ids: string[]): string[] {
  if (ids.some((id) => !onStage.some((member) => member.id === id))) {
    throw badRequest('invalid_request', 'focusCharacterIds must name members who are in the scene');
  }
  return onStage.filter((member) => ids.includes(member.id)).map((member) => member.name);
}

/**
 * The body of a generation POST that needs none. The client sends one only to
 * name the next speaker, so no body at all is an empty request rather than a
 * malformed one.
 */
async function optionalJsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  // Hono caches the body it read, so the JSON parse below reads the same text.
  if (!(await c.req.text()).trim()) return {};
  return readJsonBody(c);
}

/**
 * The length a component turn declares. The worker, the frame and the bridge all
 * truncate to it, so a longer one did not come through the runtime — and a program
 * is held to the contract it published. A reader typing in the composer is not:
 * their own message has never had a cap and does not get one here.
 */
function requireComponentTurnLength(content: string): void {
  if (content.length > MAX_COMPONENT_TURN_LENGTH) {
    throw badRequest(
      'invalid_request',
      `content may be at most ${MAX_COMPONENT_TURN_LENGTH} characters`,
    );
  }
}

/**
 * One message of a scene as the editor hands it back. A block that came from a
 * message carries its id, so the server — and not the browser — decides where the
 * rewrite stopped matching the branch.
 */
interface SceneBlock {
  originId?: string;
  kind: 'narration' | 'dialogue';
  /** Narration is edited as its body alone; the prefix stays the server's to write. */
  content: string;
}

/** The scene being rewritten: message ids of the branch, oldest first. */
function requireMessageIds(body: Record<string, unknown>): string[] {
  const value = body['messageIds'];
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('invalid_request', 'messageIds must be a non-empty array');
  }
  return value.map((id) => {
    if (typeof id !== 'string' || !isUuid(id)) {
      throw badRequest('invalid_request', 'messageIds must be message ids');
    }
    return id;
  });
}

/** The scene as it should now read. Shape only; the branch is checked separately. */
function requireSceneBlocks(body: Record<string, unknown>): SceneBlock[] {
  const value = body['blocks'];
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('invalid_request', 'blocks must be a non-empty array');
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw badRequest('invalid_request', 'Each block must be an object');
    }
    const block = entry as Record<string, unknown>;
    const kind = block['kind'];
    if (kind !== 'narration' && kind !== 'dialogue') {
      throw badRequest('invalid_request', 'block kind must be "narration" or "dialogue"');
    }
    const content = requireString(block, 'content');
    if (!content.trim()) throw badRequest('invalid_request', 'block content must not be empty');
    const originId = block['originId'];
    if (originId !== undefined && (typeof originId !== 'string' || !isUuid(originId))) {
      throw badRequest('invalid_request', 'block originId must be a message id');
    }
    return { kind, content, ...(originId === undefined ? {} : { originId: originId as string }) };
  });
}

/**
 * What a regenerate of the chat would generate from, right now. The route runs it
 * inside the generation slot; the creator's prompt inspector runs it bare, since
 * building a plan writes nothing.
 */
async function regeneratePlan(
  c: Context<AppEnv>,
  deps: AppDeps,
  chat: Chat,
  focusIds: string[] = [],
): Promise<GenerationPlan> {
  await requireEnabledModel(deps, chat.userId, chat.model);
  const context = await loadGenerationContext(deps, chat);
  const focusNames = focusNamesOf(context.onStage, focusIds);
  const path = buildPath(context.all, chat.headMessageId);
  const head = path[path.length - 1];
  if (!head) throw badRequest('invalid_state', 'The chat has no messages to generate from');

  // An assistant head is replaced by a sibling; a user head (edit fork, or a
  // failed generation) gets a fresh assistant child instead.
  const isAssistantHead = head.role === 'assistant';
  // Regenerating a narration asks for a narration again. Without this the
  // replacement would come back as ordinary dialogue and the swipe would move
  // between two different kinds of turn.
  const narration = isAssistantHead && isNarration(head.content);
  // Memory is applied to the whole path first — it only ever trims the front,
  // so the mode-specific trim of the last turn still lines up.
  const memory = await buildMemoryInput(deps, chat, path, lastUserText(path));
  // The head is about to be replaced, so whatever it set is not part of the
  // state the replacement is generated from.
  const kept = isAssistantHead ? path.slice(0, -1) : path;

  return {
    chatId: chat.id,
    model: chat.model,
    plot: context.plot,
    characters: context.characters,
    personaText: context.personaText,
    userName: context.userName,
    history: await promptHistory(
      deps,
      chat.userId,
      chat.model,
      isAssistantHead ? memory.history.slice(0, -1) : memory.history,
    ),
    memoryText: memory.memoryText,
    relationshipText: buildRelationshipText(chat),
    authorNote: context.authorNote,
    ...(context.narrator ? { narrator: context.narrator } : {}),
    // The user turn being answered is still on the branch, so its ruling comes
    // back with it — a regenerate is the same turn, judged the same way.
    directions: lastUserDirections(kept),
    preset: getPreset(chat.preset),
    variables: pathVariables(context.row, kept.map((message) => message.content)),
    clock: requestClock(c, context.row, kept),
    seed: chat.id,
    // Without the head being replaced: its records belong to the swipe this
    // generation is an alternative to.
    loreState: loreStateOf(kept),
    contextBudget: memorySettingsOf(chat).contextBudget,
    focusNames,
    ...(narration
      ? {
          trailingSystem: applyMacros(NARRATION_NUDGE, {
            char: context.plot.name,
            user: context.userName,
          }),
          narration: true,
        }
      : {}),
    target: { kind: 'new', parentId: isAssistantHead ? head.parentId : head.id },
  };
}

export function chatRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // The reader's own chats, newest activity first. Each row carries what a list
  // of conversations is read by — the plot's cover and how the chat currently
  // ends — beside the chat itself.
  app.get('/', async (c) => {
    const userId = c.get('userId');
    const plotId = c.req.query('plotId');
    if (plotId !== undefined && !isUuid(plotId)) {
      throw badRequest('invalid_request', 'plotId must be a uuid');
    }
    const rows = await deps.db
      .select()
      .from(chats)
      .where(
        plotId ? and(eq(chats.userId, userId), eq(chats.plotId, plotId)) : eq(chats.userId, userId),
      )
      .orderBy(desc(chats.updatedAt));
    const noteIds = await attachedNoteIdsByChat(deps, rows.map((chat) => chat.id));
    const covers = await chatCovers(deps, rows, userId);
    const previews = await lastMessages(deps, rows);
    return c.json(
      rows.map((chat) => ({
        ...toChatJson(chat, noteIds.get(chat.id) ?? []),
        coverUrl: covers.get(chat.plotId) ?? null,
        /** null for a chat that has no message on its branch yet. */
        lastMessage: previews.get(chat.id) ?? null,
      })),
    );
  });

  app.post('/', async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody(c);

    const plotId = requireString(body, 'plotId');
    if (!isUuid(plotId)) throw notFound('Plot not found');
    // Public plots are referenced in place: the chat points at the creator's
    // row, so later edits reach it.
    const plot = await loadVisiblePlot(deps.db, plotId, userId);

    const model = await requireEnabledModel(deps, c.get('userId'), requireString(body, 'model'));
    const persona = await startPersona(deps, userId, plot, body);

    // `{{char}}` in a plot's own writing is the work, not one of its members.
    // The clock is the reader's at the moment the chat opens. There is no seed:
    // the chat id is minted by the insert below, and an intro is expanded once.
    const intros = introTexts(plot, {
      char: plot.name,
      user: persona?.name ?? DEFAULT_USER_NAME,
      clock: requestClock(c, plot),
    });
    const chosen = pickIntroIndex(intros.length, body['introIndex']);

    const [created] = await deps.db
      .insert(chats)
      .values({
        userId,
        plotId,
        personaId: persona?.id ?? null,
        title: plot.name,
        model,
      })
      .returning();
    let chat = created!;

    // Popularity counts other people's chats only.
    if (plot.ownerId !== userId) {
      await deps.db
        .update(plots)
        .set({ chatCount: sql`${plots.chatCount} + 1` })
        .where(eq(plots.id, plotId));
    }

    // An empty chosen intro simply means the chat starts without a root message.
    if (intros[chosen]) {
      // Every intro becomes a root sibling so the chat opens on the chosen one
      // and the existing swipe mechanism moves between them.
      const stored = intros
        .map((content, index) => ({ content, index }))
        .filter((entry) => entry.content.length > 0);
      const stamp = Date.now();
      const values = stored.map((entry, position) => ({
        // Ids are minted here so the head does not depend on the order RETURNING
        // happens to use.
        id: randomUUID(),
        chatId: chat.id,
        parentId: null,
        role: 'assistant' as const,
        content: entry.content,
        model,
        // Distinct timestamps: siblings are ordered by creation, and one bulk
        // insert would otherwise share a timestamp and fall back to ordering by id.
        createdAt: new Date(stamp + position),
      }));
      await deps.db.insert(messages).values(values);

      const head = values[stored.findIndex((entry) => entry.index === chosen)]!;
      const [updated] = await deps.db
        .update(chats)
        .set({ headMessageId: head.id })
        .where(eq(chats.id, chat.id))
        .returning();
      chat = updated!;
    }

    return c.json(await chatState(deps, chat), 201);
  });

  // The selected branch, newest stretch first: `?limit=` how many messages and
  // `?before=` which message to end at. Without either it is the whole branch up to
  // DEFAULT_PATH_LIMIT, and `hasMore` says whether anything older was left behind.
  app.get('/:id', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    return c.json(await chatState(deps, chat, pathWindow(c)));
  });

  /**
   * The current branch in the export format described in docs/PLATFORM.md.
   * The rights boundary is the payload's shape: the reader's own conversation, and
   * the images the plot already serves to everyone who may read it. Nothing of
   * the work's definition — description, lorebook, system prompt, example dialogs,
   * the members' cards — has a field to travel in.
   *
   * Ownership of the chat is the only gate. The two rights are separate: the
   * conversation is the reader's record, while the name, the cover, the roster and
   * the images are the creator's to withdraw — so a plot that is no longer
   * readable takes its own contribution out of the payload and leaves the
   * conversation whole, rather than making the reader's own transcript
   * unreachable.
   */
  app.get('/:id/export', async (c) => {
    const userId = c.get('userId');
    const chat = await loadOwnedChat(deps, requireUuidParam(c), userId);
    const plot = await loadChatPlot(deps, chat, userId);
    const path = buildPath(await loadMessages(deps, chat.id), chat.headMessageId);
    // The reader's own images — the ones they attached and the scenes they had
    // drawn. Unlike the plot's assets these are not the creator's to withdraw,
    // so they travel whatever became of the work.
    const attachments = await attachmentsByMessage(deps, path.map((message) => message.id));

    const payload: ChatExport = {
      version: 1,
      chat: {
        id: chat.id,
        // The chat row's own copy of the plot id and name, so a withdrawn work
        // is never read to fill these in.
        plotId: chat.plotId,
        plotName: plot?.name ?? (chat.title.trim() || WITHDRAWN_PLOT_NAME),
        exportedAt: new Date().toISOString(),
      },
      messages: path.map((message) => ({
        id: message.id,
        role: message.role,
        // Stored verbatim, macros and all: this is the conversation as it was
        // recorded, not as it was rendered.
        text: message.content,
        createdAt: message.createdAt.toISOString(),
        // Carried only where it says something — every other turn is the reader's.
        ...(message.source === 'component' ? { source: message.source } : {}),
        ...(attachments.has(message.id)
          ? {
              attachments: attachments
                .get(message.id)!
                .map(({ id, mime }) => ({ id, url: attachmentUrl(chat.id, id), mime })),
            }
          : {}),
      })),
      // All three are the creator's to give, so all three go away with the plot.
      // The urls would 404 for this reader anyway — the asset, avatar and cover
      // routes apply the same rule.
      assets: plot ? await referencedAssets(deps, plot.id, path) : [],
      // The roster, in the creator's order: the names are the speaker prefixes the
      // transcript carries, so an importer can tell whose lines are whose.
      characters: plot
        ? (await loadMembers(deps.db, plot.id)).map((member) => ({
            id: member.id,
            name: member.name,
            avatarUrl: avatarUrl(member),
          }))
        : [],
      coverUrl: plot ? coverUrl(plot) : null,
      // The plot is read for its variable defaults and for nothing else; without one, the
      // fold starts empty and reflects only what the conversation itself set.
      variableTimeline: variableTimeline(plot?.customUi?.defaultVariables, path),
    };
    return c.json(payload);
  });

  // Chat settings. Switching the model mid-generation would split one exchange
  // across two providers, so a busy generation slot blocks the change. The author's
  // note is only read while a prompt is assembled and could safely be written
  // during a generation, but it takes the same slot: one rule for the endpoint
  // beats semantics that depend on which fields the body happens to carry, and the
  // client disables the note panel while a reply streams anyway.
  app.patch('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    // Hold the slot for the whole update: merely checking it would let a
    // generation start on the old settings while this handler awaits.
    if (!(await acquireChatSlot(deps, id, userId))) {
      // Same busy chat as a generation would report, told as a conflict: this
      // request is not one the caller retries by waiting for a stream.
      await loadOwnedChat(deps, id, userId);
      throw new ApiError(409, 'generation_in_progress', 'A generation is running for this chat');
    }
    try {
      const chat = await loadOwnedChat(deps, id, userId);
      const body = await readJsonBody(c);

      const model =
        body['model'] === undefined ? undefined : await requireEnabledModel(deps, c.get('userId'), requireString(body, 'model'));
      const personaId =
        'personaId' in body ? ((await resolvePersona(deps, userId, body['personaId']))?.id ?? null) : undefined;
      const note = optionalString(body, 'note');
      const preset = optionalPreset(body);
      const relationshipEnabled = optionalBoolean(body, 'relationshipEnabled');
      const memorySettings = optionalMemorySettings(body);
      const allowComponentTurns = optionalBoolean(body, 'allowComponentTurns');
      const statusWindowEnabled = optionalBoolean(body, 'statusWindowEnabled');
      const choicesEnabled = optionalBoolean(body, 'choicesEnabled');
      const narrator = optionalNarrator(body);
      const reasoningEffort = await patchedReasoningEffort(deps, userId, body, chat, model);
      const absentCharacterIds = await patchedAbsentIds(deps, body, chat);

      if (
        model === undefined &&
        personaId === undefined &&
        note === undefined &&
        preset === undefined &&
        relationshipEnabled === undefined &&
        memorySettings === undefined &&
        allowComponentTurns === undefined &&
        statusWindowEnabled === undefined &&
        choicesEnabled === undefined &&
        narrator === undefined &&
        reasoningEffort === undefined &&
        absentCharacterIds === undefined
      ) {
        return c.json(await chatState(deps, chat));
      }

      const [updated] = await deps.db
        .update(chats)
        .set({
          ...(model !== undefined ? { model } : {}),
          ...(personaId !== undefined ? { personaId } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(preset !== undefined ? { preset } : {}),
          ...(relationshipEnabled !== undefined ? { relationshipEnabled } : {}),
          ...(memorySettings !== undefined ? { memorySettings } : {}),
          ...(allowComponentTurns !== undefined ? { allowComponentTurns } : {}),
          ...(statusWindowEnabled !== undefined ? { statusWindowEnabled } : {}),
          ...(choicesEnabled !== undefined ? { choicesEnabled } : {}),
          ...(narrator !== undefined ? { narrator } : {}),
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          ...(absentCharacterIds !== undefined ? { absentCharacterIds } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(chats.id, id), eq(chats.userId, userId)))
        .returning();
      return c.json(await chatState(deps, updated!));
    } finally {
      await releaseChatSlot(deps, id);
    }
  });

  app.delete('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadOwnedChat(deps, id, userId);
    // Read before the delete cascades the rows away; the files are ours to clean
    // up, exactly as a plot's assets are.
    const attachments = await deps.db
      .select({ path: chatAttachments.path })
      .from(chatAttachments)
      .where(eq(chatAttachments.chatId, id));
    await deps.db.delete(chats).where(and(eq(chats.id, id), eq(chats.userId, userId)));
    for (const attachment of attachments) await deleteQuietly(deps.storage, attachment.path);
    return c.body(null, 204);
  });

  // User-edited summary. The anchor is kept: it says which turns the summary
  // stands for, and the user is only rewriting the text.
  app.put('/:id/memory', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    const body = await readJsonBody(c);
    const summary = requireString(body, 'summary');

    const updated = await deps.db.transaction(async (tx) => {
      // Re-read under the row lock: a concurrent covered edit may have just
      // cleared the memory, and writing back the copy read outside the lock
      // would resurrect the invalidated summary.
      const [locked] = await tx
        .select({ memory: chats.memory })
        .from(chats)
        .where(eq(chats.id, chat.id))
        .for('update');
      if (!locked?.memory) throw badRequest('invalid_state', 'This chat has no memory yet');

      const [row] = await tx
        .update(chats)
        .set({
          memory: { ...locked.memory, summary, updatedAt: new Date().toISOString() },
          // Any refresh already in flight is now writing about the old summary.
          memoryRevision: sql`${chats.memoryRevision} + 1`,
        })
        .where(eq(chats.id, chat.id))
        .returning();
      return row!;
    });
    return c.json(await chatState(deps, updated));
  });

  // Attaching a reusable note. Idempotent: re-attaching an attached note is a
  // no-op rather than a conflict, so a double click cannot fail the request.
  app.post('/:id/notes/:noteId', async (c) => {
    const userId = c.get('userId');
    const chat = await loadOwnedChat(deps, requireUuidParam(c), userId);
    const note = await loadOwnedNote(deps, requireUuidParam(c, 'noteId'), userId);

    // The cap is a count, and a count only means something while nothing else can
    // insert: the chat row is locked for the whole check-then-write, so two
    // attaches racing at the cap cannot both see room. Overshooting it would grow
    // the author's-note slot, which is never evicted from the prompt.
    await deps.db.transaction(async (tx) => {
      await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, chat.id)).for('update');

      const links = await tx
        .select({ noteId: chatNoteLinks.noteId })
        .from(chatNoteLinks)
        .where(eq(chatNoteLinks.chatId, chat.id));
      if (links.some((link) => link.noteId === note.id)) return;
      if (links.length >= MAX_CHAT_NOTES) {
        throw badRequest('note_limit', `A chat may have at most ${MAX_CHAT_NOTES} notes attached`);
      }
      await tx.insert(chatNoteLinks).values({ chatId: chat.id, noteId: note.id });
    });
    return c.json(await chatState(deps, chat));
  });

  app.delete('/:id/notes/:noteId', async (c) => {
    const userId = c.get('userId');
    const chat = await loadOwnedChat(deps, requireUuidParam(c), userId);
    const note = await loadOwnedNote(deps, requireUuidParam(c, 'noteId'), userId);

    await deps.db
      .delete(chatNoteLinks)
      .where(and(eq(chatNoteLinks.chatId, chat.id), eq(chatNoteLinks.noteId, note.id)));
    return c.json(await chatState(deps, chat));
  });

  // Branch switch: head moves to the deepest (newest) leaf under the given message.
  app.post('/:id/head', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    const body = await readJsonBody(c);
    const messageId = requireString(body, 'messageId');
    if (!isUuid(messageId)) throw notFound('Message not found');

    const all = await loadMessages(deps, chat.id);
    if (!all.some((message) => message.id === messageId)) throw notFound('Message not found');

    const [updated] = await deps.db
      .update(chats)
      .set({ headMessageId: deepestLeaf(all, messageId), updatedAt: new Date() })
      .where(eq(chats.id, chat.id))
      .returning();
    return c.json(await chatState(deps, updated!));
  });

  /**
   * Deleting a turn, and with it everything grown from it.
   *
   * The unit of a delete on a branching chat is the subtree, not the row: a child
   * left behind would point at a parent that is gone, and no path could ever reach
   * it again. Siblings are untouched, so the versions a swipe goes between survive
   * a delete of one of them.
   *
   * The head only moves when it was inside what was pruned, and then to the
   * deleted message's parent — the branch ends where the delete cut it. A pruned
   * root has no parent to fall back to, so the chat opens on the deepest leaf under
   * the newest greeting it still has. The one delete that is refused is the one
   * that would leave the chat with no message at all: deleting the chat is what one
   * does to be rid of the last opening.
   */
  app.delete('/:id/messages/:messageId', async (c) => {
    const userId = c.get('userId');
    const chat = await loadOwnedChat(deps, requireUuidParam(c), userId);
    const messageId = requireUuidParam(c, 'messageId');

    // A prune computed beside a running generation would race the rows the
    // stream is about to add — a new reply hung under a parent this request is
    // taking away. Holding the chat's claim serializes the delete with
    // generation and with every other claim-holding mutation; the snapshot
    // below is only read once the claim is ours.
    if (!(await acquireChatSlot(deps, chat.id, userId))) {
      await rejectBusyChat(deps, chat.id, userId);
    }
    try {
      const all = await loadMessages(deps, chat.id);
      const target = all.find((message) => message.id === messageId);
      if (!target) throw notFound('Message not found');

      const children = new Map<string, string[]>();
      for (const message of all) {
        if (!message.parentId) continue;
        const group = children.get(message.parentId);
        if (group) group.push(message.id);
        else children.set(message.parentId, [message.id]);
      }
      const pruned = new Set<string>();
      const pending = [messageId];
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (pruned.has(current)) continue;
        pruned.add(current);
        pending.push(...(children.get(current) ?? []));
      }

      const remaining = all.filter((message) => !pruned.has(message.id));
      if (remaining.length === 0) {
        throw badRequest('invalid_state', 'A chat cannot be left without a message');
      }

      // `remaining` rather than `all`, so the fallback never walks into the subtree
      // this request is about to take away.
      const newestRoot = remaining.filter((message) => message.parentId === null).at(-1);
      const fallbackHead =
        target.parentId ?? (newestRoot ? deepestLeaf(remaining, newestRoot.id) : null);

      // Read while the rows are still there: deleting a message cascades its
      // attachment rows away, and the objects behind them are ours to sweep up.
      const orphaned = await deps.db
        .select({ path: chatAttachments.path })
        .from(chatAttachments)
        .where(inArray(chatAttachments.messageId, [...pruned]));

      // One transaction, as the edits are: the summary must stop standing for text
      // that is gone at the same moment the text goes.
      const updated = await deps.db.transaction(async (tx) => {
        // Before the rows are gone — the check reads the tree the delete removes.
        await invalidateMemoryForEdit(tx, chat.id, messageId);
        await tx
          .delete(messages)
          .where(and(eq(messages.chatId, chat.id), inArray(messages.id, [...pruned])));
        // The head is judged against what it is *now*, not what it was when this
        // request read the chat: a swipe that moved it meanwhile must not be
        // overwritten with a decision made about the old one.
        const [fresh] = await tx
          .select({ headMessageId: chats.headMessageId })
          .from(chats)
          .where(eq(chats.id, chat.id))
          .limit(1);
        const currentHead = fresh?.headMessageId ?? null;
        const head =
          currentHead === null || !pruned.has(currentHead) ? currentHead : fallbackHead;
        const [row] = await tx
          .update(chats)
          .set({ headMessageId: head, updatedAt: new Date() })
          .where(eq(chats.id, chat.id))
          .returning();
        return row!;
      });
      // Outside the transaction: an object only becomes garbage once the row that
      // pointed at it is really gone.
      for (const attachment of orphaned) await deleteQuietly(deps.storage, attachment.path);
      return c.json(await chatState(deps, updated));
    } finally {
      await releaseChatSlot(deps, chat.id);
    }
  });

  /**
   * Rewriting a whole scene — the run of narration and replies the reader reads as
   * one — in a single edit.
   *
   * It forks rather than overwrites: the run is re-inserted from the first block
   * that stopped matching — and never later than the scene's last message, so a
   * rewrite that only added to the end or cut it short forks as well — leaving
   * what the scene used to say in the tree as a sibling branch a swipe can go back
   * to, and whatever followed the scene on the old path behind it exactly as
   * editing a user message leaves it. Each
   * rebuilt block keeps the turn its original was — a narration the reader wrote is
   * still theirs — while the text is now human-authored, so no rebuilt row carries
   * a model or a token count.
   */
  app.post('/:id/edit-scene', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const messageIds = requireMessageIds(body);
    const blocks = requireSceneBlocks(body);

    const chat = await loadOwnedChat(deps, id, userId);
    const path = buildPath(await loadMessages(deps, chat.id), chat.headMessageId);

    // The scene has to be a run of the branch as it stands right now, and every
    // message on it one a scene is made of. Maximality is the editor's business: a
    // sub-run of a scene is still a scene to rewrite.
    const start = path.findIndex((message) => message.id === messageIds[0]);
    const scene = start < 0 ? [] : path.slice(start, start + messageIds.length);
    if (scene.length !== messageIds.length || scene.some((m, i) => m.id !== messageIds[i])) {
      throw badRequest('invalid_request', 'messageIds must be a contiguous run of the current branch');
    }
    if (!scene.every((message) => isSceneMessage(message))) {
      throw badRequest('invalid_request', 'Only narration and character turns make up a scene');
    }

    const originIndex = new Map(messageIds.map((messageId, index) => [messageId, index]));
    let previous = -1;
    for (const block of blocks) {
      if (block.originId === undefined) continue;
      const index = originIndex.get(block.originId);
      // Each original at most once and in the order it stands on the branch: a
      // scene may lose or gain messages, but its own are not shuffled.
      if (index === undefined || index <= previous) {
        throw badRequest('invalid_request', 'originId must name a scene message once, in order');
      }
      previous = index;
      if ((block.kind === 'narration') !== isNarration(scene[index]!.content)) {
        throw badRequest('invalid_request', 'A block cannot change the kind of the message it came from');
      }
    }

    const contents = blocks.map((block) =>
      block.kind === 'narration' ? withNarrationPrefix(block.content) : block.content.trim(),
    );

    // How much of the scene the rewrite left standing, in stored form: the fork
    // point, so an edit of the last line forks at the last line.
    let kept = 0;
    while (
      kept < blocks.length &&
      kept < scene.length &&
      blocks[kept]!.originId === messageIds[kept] &&
      contents[kept] === scene[kept]!.content
    ) {
      kept += 1;
    }
    // Nothing moved — the branch is already what the editor is asking for.
    if (kept === blocks.length && kept === scene.length) return c.json(await chatState(deps, chat));

    // Every save has to leave the old scene one swipe away, so the run always
    // starts a sibling of a message that is on the branch. Only a rewrite that
    // merely added to the end of the scene, or dropped the end of it, can reach
    // past that bound: a real divergence is already inside it. The last matching
    // block is re-inserted as a copy of itself, which is what the fork costs.
    kept = Math.min(kept, blocks.length - 1, messageIds.length - 1);

    const stamp = Date.now();
    let parentId = kept > 0 ? messageIds[kept - 1]! : scene[0]!.parentId;
    const rebuilt = blocks.slice(kept).map((block, position) => {
      const original =
        block.originId === undefined ? undefined : scene[originIndex.get(block.originId)!]!;
      const role: MessageRole = original?.role ?? (block.kind === 'narration' ? 'user' : 'assistant');
      const row = {
        // Minted here so the run can be chained before any of it is written.
        id: randomUUID(),
        chatId: chat.id,
        parentId,
        role,
        content: contents[kept + position]!,
        ...(original ? { source: original.source } : {}),
        ...(original?.directions ? { directions: original.directions } : {}),
        // The copy is the same turn, so it keeps the lore it triggered: timed
        // effects read the branch's records, and a typo fix must not end them.
        ...(original?.loreTriggers ? { loreTriggers: original.loreTriggers } : {}),
        // Distinct stamps, like the greeting roots: siblings order by creation, and
        // one insert's rows would otherwise share the transaction's `now()`.
        createdAt: new Date(stamp + position),
      };
      parentId = row.id;
      return row;
    });

    // The run always has a last message: the bound above leaves at least one block
    // to write, whatever the rewrite did.
    const head = rebuilt[rebuilt.length - 1]!.id;

    // One transaction, like the in-place edit: the rewrite and the memory
    // invalidation it forces must not be observable apart. The edit is felt from
    // the first original turn the branch now leaves behind.
    const updated = await deps.db.transaction(async (tx) => {
      await tx.insert(messages).values(rebuilt);
      await invalidateMemoryForEdit(tx, chat.id, scene[kept]!.id);
      const [row] = await tx
        .update(chats)
        .set({ headMessageId: head, updatedAt: new Date() })
        .where(eq(chats.id, chat.id))
        .returning();
      return row!;
    });
    return c.json(await chatState(deps, updated));
  });

  /**
   * An image for a turn that has not been written yet. The upload comes first
   * because the composer shows a thumbnail before the reader has finished typing;
   * the row it creates carries no message id until a send claims it.
   *
   * The bytes are sniffed rather than believed — the declared type is not read at
   * all — and the 8MB cap is enforced here as well as by the body limit in front
   * of the route, which bounds the multipart parse.
   */
  app.post('/:id/attachments', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw badRequest('invalid_request', 'Expected multipart/form-data with a file field');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('invalid_request', 'file field is required');
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw badRequest(
        'attachment_too_large',
        `An image may be at most ${MAX_ATTACHMENT_BYTES} bytes`,
      );
    }
    // The same measurement a plot asset carries, validated the same way.
    const preview = coerceAssetPreview(form.get('width'), form.get('height'), form.get('thumbhash'));

    const attachmentId = randomUUID();
    const stored = await saveAttachment(
      deps.storage,
      attachmentId,
      new Uint8Array(await file.arrayBuffer()),
    );
    if (!stored) throw badRequest('invalid_attachment', 'Unsupported image file');

    // Drafts nobody sent are cleaned up by the next upload, and what is left
    // after that is capped: an upload is the one way to put bytes in this chat's
    // store without ever writing a message. Sweep, count and insert hold the
    // chat's row lock as one decision — two uploads racing below the cap would
    // otherwise both count room and both land past it.
    let row: ChatAttachment;
    let swept: string[];
    try {
      ({ row, swept } = await deps.db.transaction(async (tx) => {
        await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, chat.id)).for('update');
        const sweptPaths = await sweepStaleAttachments(tx, chat.id);
        if ((await countUnboundAttachments(tx, chat.id)) >= MAX_UNBOUND_ATTACHMENTS) {
          throw badRequest(
            'attachment_limit',
            `A chat may hold at most ${MAX_UNBOUND_ATTACHMENTS} unsent images`,
          );
        }
        const [inserted] = await tx
          .insert(chatAttachments)
          .values({
            id: attachmentId,
            chatId: chat.id,
            path: stored.key,
            mime: stored.mime,
            width: preview?.width ?? null,
            height: preview?.height ?? null,
            thumbhash: preview?.thumbhash ?? null,
          })
          .returning();
        return { row: inserted!, swept: sweptPaths };
      }));
    } catch (error) {
      // The bytes are already in the store and no row will ever point at them;
      // nothing else would ever come back for them either.
      await deleteQuietly(deps.storage, stored.key);
      throw error;
    }
    // Outside the transaction, as everywhere: an object only becomes garbage
    // once the row that pointed at it is really gone.
    for (const path of swept) await deleteQuietly(deps.storage, path);
    return c.json(toAttachmentJson(row), 201);
  });

  /**
   * The bytes, streamed through the API like a plot asset — but for one
   * reader only. An attachment is the reader's own picture in their own chat, so
   * ownership of the chat is the whole rule, and unlike an asset there is no
   * public visibility that could ever widen it.
   */
  app.get('/:id/attachments/:attachmentId', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    const [attachment] = await deps.db
      .select()
      .from(chatAttachments)
      .where(
        and(
          eq(chatAttachments.id, requireUuidParam(c, 'attachmentId')),
          eq(chatAttachments.chatId, chat.id),
        ),
      )
      .limit(1);
    if (!attachment) throw notFound('Attachment not found');

    const object = await deps.storage.get(attachment.path);
    if (!object) throw notFound('Attachment file is missing');
    return new Response(object.body, {
      headers: {
        'Content-Type': attachment.mime,
        'Content-Length': String(object.size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });

  /**
   * Taking a thumbnail out of the composer again. Only an upload no turn has
   * claimed can go this way: once a message carries it, the message is what
   * deletes it.
   */
  app.delete('/:id/attachments/:attachmentId', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    const [deleted] = await deps.db
      .delete(chatAttachments)
      .where(
        and(
          eq(chatAttachments.id, requireUuidParam(c, 'attachmentId')),
          eq(chatAttachments.chatId, chat.id),
          isNull(chatAttachments.messageId),
        ),
      )
      .returning();
    if (!deleted) throw notFound('Attachment not found');
    await deleteQuietly(deps.storage, deleted.path);
    return c.body(null, 204);
  });

  app.post('/:id/messages', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const content = requireString(body, 'content');
    if (!content.trim()) throw badRequest('invalid_request', 'content must not be empty');
    // A component turn is still the reader's turn — it is only labelled as one,
    // so the chat can show where it came from and the rate limit can find it.
    const source = optionalSource(body) ?? 'user';
    if (source === 'component') requireComponentTurnLength(content);
    const directions = optionalDirections(body);
    const attachmentIds = optionalAttachmentIds(body);
    const focusIds = optionalMemberIds(body, 'focusCharacterIds') ?? [];

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> => {
      const chat = await loadOwnedChat(deps, id, userId);
      // Fail before any write: a 400 here must leave the chat untouched, otherwise
      // the client resends a turn that was already persisted.
      await requireEnabledModel(deps, userId, chat.model);
      const context = await loadGenerationContext(deps, chat);
      // Still before any write, and it needs the card the context just loaded.
      if (source === 'component') requireComponentTurnAllowed(chat, context.row);
      const focusNames = focusNamesOf(context.onStage, focusIds);

      // One transaction, because the uploads are part of the turn: an id that is
      // not this chat's own — or that another turn already claimed — must leave
      // no message behind for the client to find on its retry.
      const userMessage = await deps.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(messages)
          .values({
            chatId: chat.id,
            parentId: chat.headMessageId,
            role: 'user',
            content,
            source,
            // Stored on the turn rather than on the request, so a regenerate of it
            // re-applies the same ruling.
            ...(directions ? { directions } : {}),
          })
          .returning();
        await bindAttachments(tx, chat.id, created!.id, attachmentIds);
        await tx
          .update(chats)
          .set({ headMessageId: created!.id, updatedAt: new Date() })
          .where(eq(chats.id, chat.id));
        return created!;
      });

      const path = buildPath(context.all, chat.headMessageId);
      const memory = await buildMemoryInput(deps, chat, path, content);
      // The turn just written is the last of the history, and the images ride on
      // it; the rest of the branch's are not re-sent (see `withTurnImages`).
      const history = await promptHistory(deps, c.get('userId'), chat.model, [...memory.history, userMessage]);

      return {
        chatId: chat.id,
        model: chat.model,
        plot: context.plot,
        characters: context.characters,
        personaText: context.personaText,
        userName: context.userName,
        history,
        memoryText: memory.memoryText,
        relationshipText: buildRelationshipText(chat),
        authorNote: context.authorNote,
        ...(context.narrator ? { narrator: context.narrator } : {}),
        ...(directions ? { directions } : {}),
        preset: getPreset(chat.preset),
        variables: pathVariables(context.row, [
          ...path.map((message) => message.content),
          content,
        ]),
        clock: requestClock(c, context.row, [...path, userMessage]),
        seed: chat.id,
        loreState: loreStateOf([...path, userMessage]),
        contextBudget: memorySettingsOf(chat).contextBudget,
        focusNames,
        target: { kind: 'new', parentId: userMessage.id },
      };
    });
  });

  app.post('/:id/regenerate', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const focusIds = optionalMemberIds(await optionalJsonBody(c), 'focusCharacterIds') ?? [];

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> =>
      regeneratePlan(c, deps, await loadOwnedChat(deps, id, userId), focusIds),
    );
  });

  /**
   * The prompt a regenerate would send right now, block by block — the creator's
   * debugging view of their own work. Only for a chat that is the caller's own on
   * a plot that is the caller's own: anywhere else the prompt is someone else's
   * writing or someone else's conversation, so the chat is simply not found.
   *
   * It builds the plan and stops: no slot, no model, no write.
   */
  app.get('/:id/inspect', async (c) => {
    const userId = c.get('userId');
    const chat = await loadOwnedChat(deps, requireUuidParam(c), userId);
    if (!(await ownsPlot(deps, chat.plotId, userId))) throw notFound('Chat not found');
    const plan = await regeneratePlan(c, deps, chat);
    return c.json(await inspectGeneration(deps, plan, deps.chatgpt?.accounts.forUser(userId)));
  });

  app.post('/:id/continue', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const focusIds = optionalMemberIds(await optionalJsonBody(c), 'focusCharacterIds') ?? [];

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> => {
      const chat = await loadOwnedChat(deps, id, userId);
      await requireEnabledModel(deps, userId, chat.model);
      const context = await loadGenerationContext(deps, chat);
      const focusNames = focusNamesOf(context.onStage, focusIds);
      const path = buildPath(context.all, chat.headMessageId);
      const head = path[path.length - 1];
      if (!head || head.role !== 'assistant') {
        throw badRequest('invalid_state', 'The current head is not an assistant message');
      }
      const memory = await buildMemoryInput(deps, chat, path, lastUserText(path));
      // The partial assistant turn must stay last for the model to resume it, so it
      // is re-attached when the summary swallowed it.
      const history = memory.history.length > 0 ? memory.history : [head];

      return {
        chatId: chat.id,
        model: chat.model,
        plot: context.plot,
        characters: context.characters,
        personaText: context.personaText,
        userName: context.userName,
        history: await promptHistory(deps, c.get('userId'), chat.model, history),
        memoryText: memory.memoryText,
        relationshipText: buildRelationshipText(chat),
        authorNote: context.authorNote,
        ...(context.narrator ? { narrator: context.narrator } : {}),
        // Continue finishes the reply to the last user turn, so that turn's ruling
        // is still the one in force. Auto-continue, below, is a beat past it.
        directions: lastUserDirections(path),
        preset: getPreset(chat.preset),
        variables: pathVariables(context.row, path.map((message) => message.content)),
        clock: requestClock(c, context.row, path),
        seed: chat.id,
        // The message being generated is the head itself, so the branch before it
        // is what it was first generated on — its own record must not read as a
        // trigger from the turn before.
        loreState: loreStateOf(path.slice(0, -1)),
        contextBudget: memorySettingsOf(chat).contextBudget,
        focusNames,
        target: { kind: 'continue', message: head },
      };
    });
  });

  // Auto-continue: one more assistant turn with no user message in between. The
  // nudge that asks for it is appended to the prompt and never stored, so the
  // branch holds nothing but the two assistant messages.
  app.post('/:id/auto', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const focusIds = optionalMemberIds(await optionalJsonBody(c), 'focusCharacterIds') ?? [];

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> => {
      const chat = await loadOwnedChat(deps, id, userId);
      await requireEnabledModel(deps, userId, chat.model);
      const context = await loadGenerationContext(deps, chat);
      const focusNames = focusNamesOf(context.onStage, focusIds);
      const path = buildPath(context.all, chat.headMessageId);
      const head = path[path.length - 1];
      if (!head || head.role !== 'assistant') {
        throw badRequest('invalid_state', 'The current head is not an assistant message');
      }
      const memory = await buildMemoryInput(deps, chat, path, lastUserText(path));
      // The scene to continue must be in the prompt, so the head is re-attached
      // when the summary swallowed it.
      const history = memory.history.length > 0 ? memory.history : [head];

      return {
        chatId: chat.id,
        model: chat.model,
        plot: context.plot,
        characters: context.characters,
        personaText: context.personaText,
        userName: context.userName,
        history: await promptHistory(deps, c.get('userId'), chat.model, history),
        memoryText: memory.memoryText,
        relationshipText: buildRelationshipText(chat),
        authorNote: context.authorNote,
        ...(context.narrator ? { narrator: context.narrator } : {}),
        preset: getPreset(chat.preset),
        variables: pathVariables(context.row, path.map((message) => message.content)),
        clock: requestClock(c, context.row, path),
        seed: chat.id,
        loreState: loreStateOf(path),
        contextBudget: memorySettingsOf(chat).contextBudget,
        focusNames,
        trailingSystem: applyMacros(AUTO_CONTINUE_NUDGE, {
          char: context.plot.name,
          user: context.userName,
        }),
        // A child of the assistant head: two assistant turns in a row, which the
        // adapters merge for providers that require alternating roles.
        target: { kind: 'new', parentId: head.id },
      };
    });
  });

  // A narration turn: the scene moves, and nobody speaks. Unlike auto-continue it
  // is allowed under a user head too — answering a turn with the scene rather than
  // with the plot's characters is the ordinary way to use it. The stored turn carries the
  // narration prefix, which is what makes it one; the nudge that asked for it is
  // appended to the prompt and never stored.
  app.post('/:id/narrate', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const focusIds = optionalMemberIds(await optionalJsonBody(c), 'focusCharacterIds') ?? [];

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> => {
      const chat = await loadOwnedChat(deps, id, userId);
      await requireEnabledModel(deps, userId, chat.model);
      const context = await loadGenerationContext(deps, chat);
      const focusNames = focusNamesOf(context.onStage, focusIds);
      const path = buildPath(context.all, chat.headMessageId);
      const head = path[path.length - 1];
      if (!head) throw badRequest('invalid_state', 'The chat has no messages to narrate from');
      const memory = await buildMemoryInput(deps, chat, path, lastUserText(path));
      // The scene to narrate must be in the prompt, so the head is re-attached
      // when the summary swallowed it.
      const history = memory.history.length > 0 ? memory.history : [head];

      return {
        chatId: chat.id,
        model: chat.model,
        plot: context.plot,
        characters: context.characters,
        personaText: context.personaText,
        userName: context.userName,
        history: await promptHistory(deps, c.get('userId'), chat.model, history),
        memoryText: memory.memoryText,
        relationshipText: buildRelationshipText(chat),
        authorNote: context.authorNote,
        ...(context.narrator ? { narrator: context.narrator } : {}),
        preset: getPreset(chat.preset),
        variables: pathVariables(context.row, path.map((message) => message.content)),
        clock: requestClock(c, context.row, path),
        seed: chat.id,
        loreState: loreStateOf(path),
        contextBudget: memorySettingsOf(chat).contextBudget,
        focusNames,
        trailingSystem: applyMacros(NARRATION_NUDGE, {
          char: context.plot.name,
          user: context.userName,
        }),
        narration: true,
        target: { kind: 'new', parentId: head.id },
      };
    });
  });

  /**
   * Three things the reader could say next. Reader-initiated and reader-owned:
   * these are the reader's own half of the conversation, unlike the creator's
   * 선택지, which the plot's characters offer inside a reply.
   *
   * Nothing is stored — a suggestion the reader ignores must leave no trace —
   * so this does not take the generation slot either. It only stands back while
   * one is running: what it is suggesting is an answer to a turn that has not
   * finished arriving.
   */
  app.post('/:id/suggest', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const chat = await loadOwnedChat(deps, id, userId);
    if (isGenerating(chat)) {
      throw new ApiError(429, 'generation_in_progress', 'A generation is running for this chat');
    }
    // One in flight per chat, in its own guard: a reader leaning on the button
    // must not pay for a second call the first one is about to answer.
    if (deps.suggesting.has(chat.id)) {
      throw new ApiError(429, 'suggestion_in_progress', 'Suggestions are already being written');
    }
    deps.suggesting.add(chat.id);
    try {
      // The same load a generation does, so a plot the creator has withdrawn
      // stops suggestions exactly where it stops turns.
      const context = await loadGenerationContext(deps, chat);
      return c.json({
        suggestions: await suggestReplies(deps, {
          userId: chat.userId,
          recent: buildPath(context.all, chat.headMessageId),
          plotName: context.plot.name,
          userName: context.userName,
          personaText: context.personaText,
        }),
      });
    } finally {
      deps.suggesting.delete(chat.id);
    }
  });

  /**
   * Draws the scene as it currently stands, and hangs the picture on the branch.
   *
   * Mounted only where the deployment has an image provider, so a request for a
   * capability that is off is a 404 rather than a 501 — and `capabilities` on
   * every chat read is what keeps the client from offering the action at all.
   *
   * The result is a narration turn carrying the image as its attachment: the same
   * rows, the same grid, the same branching, export and deletion the reader's own
   * pictures already get. Nothing about it is a plot asset — a drawn scene
   * belongs to this conversation, not to the work.
   *
   * The generation slot is taken for the whole call, so drawing and generating
   * cannot both run on one chat; every failure releases it.
   */
  if (drawSceneEnabled(deps)) {
    app.post('/:id/draw-scene', async (c) => {
      const id = requireUuidParam(c);
      const userId = c.get('userId');
      if (!(await acquireChatSlot(deps, id, userId))) await rejectBusyChat(deps, id, userId);

      // The provider call, the download it may require and the storage write can
      // together outlive the claim's staleness window; renewing on the stream's
      // own heartbeat keeps another instance from reclaiming the chat while this
      // scene is still on its way in.
      const keepAlive = setInterval(() => void renewChatSlot(deps, id), HEARTBEAT_MS);
      try {
        const chat = await loadOwnedChat(deps, id, userId);
        const context = await loadGenerationContext(deps, chat);
        const path = buildPath(context.all, chat.headMessageId);
        const head = path[path.length - 1];
        if (!head) throw badRequest('invalid_state', 'The chat has no scene to draw yet');

        const image = await (deps.generateSceneImage ?? generateSceneImage)(
          deps,
          // Only who is on the stage: a member sent off it is not in the picture.
          sceneImagePrompt(
            context.plot,
            context.characters.filter((member) => !member.absent),
            path,
          ),
        );
        const attachmentId = randomUUID();
        const stored = await saveAttachment(deps.storage, attachmentId, image.bytes);
        if (!stored) throw new ApiError(502, 'image_failed', 'The image provider returned no image');

        // One transaction: a turn whose picture did not land would render as an
        // empty narration, and an attachment with no turn is unreachable.
        const created = await deps.db.transaction(async (tx) => {
          const [message] = await tx
            .insert(messages)
            .values({
              chatId: chat.id,
              parentId: head.id,
              role: 'assistant',
              // The scene moved and nobody spoke, and the picture is the whole of
              // what it says — so the narration carries the prefix and no words.
              content: NARRATION_PREFIX,
            })
            .returning();
          await tx.insert(chatAttachments).values({
            id: attachmentId,
            chatId: chat.id,
            messageId: message!.id,
            path: stored.key,
            mime: stored.mime,
            // What the provider reported, when it reported anything. No thumbhash:
            // it is measured in a browser, and nothing here decodes an image.
            width: image.width,
            height: image.height,
            thumbhash: null,
          });
          await tx
            .update(chats)
            .set({ headMessageId: message!.id, updatedAt: new Date() })
            .where(eq(chats.id, chat.id));
          return message!;
        });

        return c.json(await chatState(deps, { ...chat, headMessageId: created.id }));
      } finally {
        // The interval first, so no renewal starts after this point; release then
        // waits out one still in flight before it clears the claim.
        clearInterval(keepAlive);
        await releaseChatSlot(deps, id);
      }
    });
  }

  return app;
}

/** Asks for the next beat of the scene; appended to the prompt, never persisted. */
const AUTO_CONTINUE_NUDGE =
  '(유저 개입 없이 현재 장면을 자연스럽게 이어간다. 장면 전환이나 시간 경과가 필요하면 대사 없이 서술 위주로 이어가도 된다. {{user}}의 반응이 필요한 지점에서 멈춘다)';

/**
 * Asks for the scene alone. The prefix that marks the answer as narration is the
 * server's to write, so the model is only told what to produce — a model that
 * writes the prefix as well is deduplicated on the way in.
 */
const NARRATION_NUDGE =
  '(다음 응답은 {{char}}의 등장인물이 말하거나 움직이는 장면이 아니라 나레이터의 장면 서술만 출력한다. 접두사 없는 줄로만 쓴다. 나레이터 설정(문체·시점)이 있으면 따른다. 유저나 등장인물의 대사를 만들지 않는다)';

/** Intro roots a chat may hold — a plot offering more is truncated here too. */
const MAX_INTRO_ROOTS = 10;

/** The plot's openings in the creator's order, macro-expanded and capped. */
function introTexts(plot: Plot, macro: MacroContext): string[] {
  return plot.intros
    .slice(0, MAX_INTRO_ROOTS)
    .map((intro) => applyMacros(intro, macro).trim());
}

/** Which opening the chat starts on; the first one when the reader did not say. */
function pickIntroIndex(total: number, index: unknown): number {
  if (index === undefined || index === null) return 0;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw badRequest('invalid_request', 'introIndex must be a non-negative integer');
  }
  // Intros past the cap are not stored, so they cannot be started on either.
  if (index >= total) throw badRequest('invalid_request', 'introIndex is out of range');
  return index;
}

/** PATCH /api/messages/:id — edit a message; user edits fork a new branch. */
export function messageRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.patch('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const content = requireString(body, 'content');

    const [row] = await deps.db
      .select({ message: messages, chat: chats })
      .from(messages)
      .innerJoin(chats, eq(messages.chatId, chats.id))
      .where(and(eq(messages.id, id), eq(chats.userId, userId)))
      .limit(1);
    if (!row) throw notFound('Message not found');

    if (row.message.role === 'assistant') {
      // One transaction: the edit and the memory invalidation it forces must not be
      // observable apart, or a refresh could snapshot the old text and still win.
      await deps.db.transaction(async (tx) => {
        await tx.update(messages).set({ content }).where(eq(messages.id, id));
        await invalidateMemoryForEdit(tx, row.chat.id, id);
      });
      return c.json({ messageId: id });
    }

    // User message: fork a sibling branch and drop the history that followed.
    const [sibling] = await deps.db
      .insert(messages)
      .values({
        chatId: row.chat.id,
        parentId: row.message.parentId,
        role: 'user',
        content,
      })
      .returning();
    await deps.db
      .update(chats)
      .set({ headMessageId: sibling!.id, updatedAt: new Date() })
      .where(eq(chats.id, row.chat.id));
    return c.json({ messageId: sibling!.id });
  });

  return app;
}
