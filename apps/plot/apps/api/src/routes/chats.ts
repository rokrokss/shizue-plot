import type { ChatExport, ChatExportVariableSnapshot } from '@shizue/contracts';
import {
  applyMacros,
  applyVariableDelta,
  assetResolver,
  authorNoteSettingsOf,
  backgroundHtmlOf,
  characterName,
  coerceAuthorNoteSettings,
  coerceNarrator,
  coerceTranslationSettings,
  isTranslationLanguage,
  resolveTranslation,
  type TranslationLanguage,
  computeVariables,
  DEFAULT_USER_NAME,
  getPreset,
  HYPA_V3_DEFAULTS,
  MAX_CHATS_PER_SUMMARY,
  MAX_QUERY_CHAT_COUNT,
  MAX_SUMMARIZATION_PROMPT_LENGTH,
  imageMacroRefs,
  isNarration,
  isPresetId,
  isSceneMessage,
  MAX_COMPONENT_TURN_LENGTH,
  MAX_DIRECTIONS_LENGTH,
  NARRATION_PREFIX,
  NARRATOR_SPEAKER,
  readVariable,
  stripImageMacros,
  stripVariableMacros,
  withNarrationPrefix,
  type HistoryMessage,
  type LoreEntry,
  type LoreTimedState,
  type MacroClock,
  type MacroContext,
  type NarratorConfig,
  type NarratorSpeaker,
  type PlotModule,
  type PlotStyle,
  type FoldItem,
  type FoldOptions,
  type PromptBranch,
  type PromptCharacter,
  type PromptPlot,
  type ReaderAdditions,
  type Variables,
} from '@shizue/core';
import {
  chatAttachments,
  chatNoteLinks,
  chats,
  MEMORY_CONTEXT_BUDGETS,
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
import { contentText, getModel, type ChatMessage } from '@shizue/llm';
import {
  cardScripts,
  hasTriggersFor,
  overlaidCard,
  scriptedMember,
  type CardScripts,
  type ScriptOverlay,
} from '@shizue/core/triggers';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { assetUrl, coerceAssetPreview } from '../assets.js';
import {
  attachmentsByMessage,
  attachmentUrl,
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
  openUnlocks,
  rejectBusyChat,
  releaseChatSlot,
  renewChatSlot,
  requestTriggerInput,
  scheduleBackgroundUpdates,
  withGenerationSlot,
  type GenerationPlan,
  type ScriptView,
} from '../generation.js';
import { avatarUrl, coverUrl, loadMembers, loadVisiblePlot, visibleToViewer } from '../hub.js';
import { emotionNamed, replyMemberOf } from '../emotion.js';
import { auxiliaryModelOf, buildMemoryInput, invalidateMemoryForEdit, memorySettingsOf, scheduleMemoryUpdate } from '../memory.js';
import {
  attachedNoteIds,
  attachedNoteIdsByChat,
  loadAuthorNote,
  loadOwnedNote,
  MAX_CHAT_NOTES,
} from '../notes.js';
import { loadReaderAdditions, resolveReaderPresetId } from '../readerPresets.js';
import { buildRelationshipText } from '../relationship.js';
import { drawSceneEnabled, generateSceneImage, sceneImagePrompt } from '../sceneImage.js';
import {
  headMoved,
  loadGlobalVariables,
  loadReaderOverlay,
  localLoreOf,
  mergeGlobalVariables,
  mergeReaderOverlay,
  NO_SCRIPTS,
  optionalMemberId,
  optionalScriptNote,
  optionalVariableDelta,
  overlaidWith,
  readGenerationScripts,
  readLocalLore,
  readOverlay,
  readScriptChat,
  saveScriptWrites,
  scriptMemberOf,
  scriptRevMoved,
  storableDelta,
  type GenerationScripts,
} from '../scriptState.js';
import {
  applyScriptChat,
  planScriptChat,
  rewritableHead,
  type AppliedScriptChat,
  type ScriptChatPlan,
} from '../scriptChat.js';
import { deleteQuietly } from '../storage.js';
import { toPromptCharacters, toPromptPlot } from '../plots.js';
import { editRequestTurns } from '../requestTriggers.js';
import { createScriptFetch } from '../scriptFetch.js';
import { readScriptLlmMessages, readScriptLlmModel, runScriptLlm } from '../scriptLlm.js';
import { suggestReplies } from '../suggest.js';
import { buildPath, deepestLeaf, roundStart, siblingInfo, visibleToAi } from '../tree.js';
import { assetLocks, openAssetNames } from '../unlocks.js';
import {
  isUuid,
  optionalBoolean,
  optionalString,
  readJsonBody,
  requireString,
  requireUuidParam,
} from '../util.js';
import { personaAvatarUrl } from './personas.js';

export const toChatJson = (chat: Chat, noteIds: string[]) => ({
  id: chat.id,
  plotId: chat.plotId,
  personaId: chat.personaId,
  title: chat.title,
  model: chat.model,
  /**
   * The auxiliary model the reader picked for scripts' auxiliary calls and the
   * background work; null runs them on the first model of the owner's catalog.
   */
  subModel: chat.subModel,
  note: chat.note,
  /** Where the note goes and how often (SillyTavern's depth, frequency and role), the defaults filled in. */
  noteSettings: authorNoteSettingsOf(chat.noteSettings),
  /**
   * What the reader chose of the language mode, as stored: a key left out is
   * decided by the plot's language against the reader's (`resolveTranslation`),
   * which only the reader's browser knows — so it resolves it.
   */
  translation: chat.translation ?? {},
  preset: chat.preset,
  /** The reader's own preset on top of `preset`; null adds nothing. */
  readerPresetId: chat.readerPresetId,
  headMessageId: chat.headMessageId,
  memorySettings: chat.memorySettings,
  /** Moves with every edit, hide and delete of a message: the memory's summaries may have changed with it. */
  memoryRevision: chat.memoryRevision,
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
  /**
   * True while an import is still writing the history in batches. The chat takes
   * no other write until the import completes — it can only be read or deleted.
   */
  importing: chat.importing,
  /** The chat file a conversation brought over from another app came from; null for one started here. */
  importedFrom: chat.importedFrom,
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
  /**
   * What the card's scripts left on this turn, laid over its macros wherever the
   * branch is folded — the reader's screen included, so it has to travel.
   */
  variableDelta: message.variableDelta,
  /** 'pending' while the browser still owes this turn its output scripts. */
  scriptState: message.scriptState,
  /** The revision a script commit to this turn has to name. */
  scriptRev: message.scriptRev,
  /**
   * A group turn's reply: the member who says it whole (null for the narrator's,
   * and once the member is deleted), and the round it belongs to — the id of the
   * round's first reply. Both null on every other message.
   */
  speakerMemberId: message.speakerMemberId,
  groupTurnId: message.groupTurnId,
  /** Hidden from the AI: on screen, never in what a model reads (`PUT …/messages/:id/hidden`). */
  hiddenFromPrompt: message.hiddenFromPrompt,
  /**
   * The name of the emotion picture its member wears after this reply, or null
   * (`messages.emotion`) — what the chat's emotion screen draws.
   */
  emotion: message.emotion,
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

/** What a write to a chat an import is still filling is refused with. */
export const chatImporting = (): ApiError =>
  new ApiError(409, 'chat_importing', 'This chat is still being imported');

/**
 * `loadOwnedChat` for a route that writes. A chat an import is still filling takes
 * no writes but the import's own batches (§5): a turn, a swipe or an edit landing
 * in the middle would hang the rest of the history under something the import
 * never chose. Reads stay open, and so does deleting the whole chat — that is how
 * an import is abandoned.
 */
export async function loadWritableChat(deps: AppDeps, id: string, userId: string): Promise<Chat> {
  const chat = await loadOwnedChat(deps, id, userId);
  if (chat.importing) throw chatImporting();
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
 * The variable fold the window starts from: the branch's macros and script
 * deltas up to its first message, over the plot's defaults.
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
  const fold = foldOptionsOf(plot?.name ?? chat.title, await loadPersona(deps, chat));
  return computeVariables(earlier, plot?.customUi?.defaultVariables, fold);
}

/**
 * The names every fold of this chat answers `{{user}}` and `{{char}}` with
 * (`FoldOptions`): the persona's name, and the plot's — a message is the work's
 * text, where `{{char}}` is the work. The reader's screen has to fold with the
 * same two, or a value nesting either reads one way there and another here.
 */
const foldOptionsOf = (plotName: string, persona: Persona | null): FoldOptions => ({
  user: persona?.name ?? DEFAULT_USER_NAME,
  char: plotName,
});

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
     * The reader's global variables on this plot, shared by all their chats on
     * it and not by branch — what the card's scripts read as `getglobalvar`.
     */
    globalVariables: await loadGlobalVariables(deps, chat.userId, chat.plotId),
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
 * The auxiliary model a start opens the chat with or a PATCH leaves it with;
 * undefined leaves it alone (a start: no pick). A model is held to the reader's
 * catalog exactly as the chat's own is, and null clears the pick, handing the
 * side work back to the default (`auxiliaryModelOf`).
 */
async function optionalSubModel(
  deps: AppDeps,
  userId: string,
  body: Record<string, unknown>,
): Promise<string | null | undefined> {
  const value = body['subModel'];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw badRequest('invalid_request', 'subModel must be a string or null');
  return requireEnabledModel(deps, userId, value);
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
 * Validates `memorySettings`: the context budget from its whitelist, and
 * HypaV3's settings (`HypaV3Settings`) in their ranges — the two shares of the
 * memory budget together at most all of it, the extra summarization at most
 * what the memory leaves. Every key is optional; keys the pipeline does not
 * know (the retired `summaryThreshold` and `retrievalCount` among them) are
 * dropped rather than stored, so the column never grows a setting nothing
 * reads. `null` resets the chat to the defaults.
 */
/**
 * A settings object the PATCH replaces whole — the author's note's placement,
 * the language mode. What the setting does not know is dropped by its coercion,
 * as the narrator's is; only something that is not an object at all is refused.
 * `null`, and an object left with nothing, store null: every default.
 */
function optionalSettings<T>(
  body: Record<string, unknown>,
  key: string,
  coerce: (value: unknown) => T | null,
): T | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    throw badRequest('invalid_request', `${key} must be an object or null`);
  }
  return coerce(value);
}

function optionalMemorySettings(body: Record<string, unknown>): ChatMemorySettings | null | undefined {
  const value = body['memorySettings'];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_request', 'memorySettings must be an object or null');
  }
  const input = value as Record<string, unknown>;
  const invalid = (key: string, rule: string) => badRequest('invalid_request', `${key} must be ${rule}`);

  const contextBudget = input['contextBudget'];
  if (contextBudget !== undefined && !MEMORY_CONTEXT_BUDGETS.includes(contextBudget as never)) {
    throw badRequest('invalid_request', `Unsupported contextBudget: ${String(contextBudget)}`);
  }
  const ratio = (key: string, max = 1): number | undefined => {
    const setting = input[key];
    if (setting === undefined) return undefined;
    if (typeof setting !== 'number' || !Number.isFinite(setting) || setting < 0 || setting > max + 1e-9) {
      throw invalid(key, `a number between 0 and ${max}`);
    }
    return setting;
  };
  const count = (key: string, max: number): number | undefined => {
    const setting = input[key];
    if (setting === undefined) return undefined;
    if (typeof setting !== 'number' || !Number.isInteger(setting) || setting < 1 || setting > max) {
      throw invalid(key, `an integer between 1 and ${max}`);
    }
    return setting;
  };

  const memoryTokensRatio = ratio('memoryTokensRatio');
  const extraSummarizationRatio = ratio(
    'extraSummarizationRatio',
    1 - (memoryTokensRatio ?? HYPA_V3_DEFAULTS.memoryTokensRatio),
  );
  const recentMemoryRatio = ratio('recentMemoryRatio');
  const similarMemoryRatio = ratio('similarMemoryRatio');
  // HypaV3 refuses the two shares adding up to more than the budget. With a
  // hair of slack: 0.7 + 0.3 is over 1 in floating point.
  const shares =
    (recentMemoryRatio ?? HYPA_V3_DEFAULTS.recentMemoryRatio) + (similarMemoryRatio ?? HYPA_V3_DEFAULTS.similarMemoryRatio);
  if (shares > 1 + 1e-9) {
    throw badRequest('invalid_request', 'recentMemoryRatio and similarMemoryRatio must add up to at most 1');
  }
  const maxChatsPerSummary = count('maxChatsPerSummary', MAX_CHATS_PER_SUMMARY);
  const queryChatCount = count('queryChatCount', MAX_QUERY_CHAT_COUNT);
  const doNotSummarizeUserMessage = input['doNotSummarizeUserMessage'];
  if (doNotSummarizeUserMessage !== undefined && typeof doNotSummarizeUserMessage !== 'boolean') {
    throw invalid('doNotSummarizeUserMessage', 'a boolean');
  }
  const summarizationPrompt = input['summarizationPrompt'];
  if (
    summarizationPrompt !== undefined &&
    (typeof summarizationPrompt !== 'string' ||
      summarizationPrompt.length > MAX_SUMMARIZATION_PROMPT_LENGTH ||
      summarizationPrompt.includes('\u0000'))
  ) {
    throw invalid('summarizationPrompt', `a string of at most ${MAX_SUMMARIZATION_PROMPT_LENGTH} characters, without U+0000`);
  }

  return {
    ...(contextBudget !== undefined ? { contextBudget: contextBudget as ChatMemorySettings['contextBudget'] } : {}),
    ...(memoryTokensRatio !== undefined ? { memoryTokensRatio } : {}),
    ...(extraSummarizationRatio !== undefined ? { extraSummarizationRatio } : {}),
    ...(maxChatsPerSummary !== undefined ? { maxChatsPerSummary } : {}),
    ...(recentMemoryRatio !== undefined ? { recentMemoryRatio } : {}),
    ...(similarMemoryRatio !== undefined ? { similarMemoryRatio } : {}),
    ...(queryChatCount !== undefined ? { queryChatCount } : {}),
    ...(doNotSummarizeUserMessage !== undefined ? { doNotSummarizeUserMessage } : {}),
    // An empty prompt is the default one, which a missing key already says.
    ...(typeof summarizationPrompt === 'string' && summarizationPrompt.trim() !== '' ? { summarizationPrompt } : {}),
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
export async function resolvePersona(deps: AppDeps, userId: string, value: unknown): Promise<Persona | null> {
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

/**
 * What the scripted member's Lua reads that the prompt does not carry, as
 * `GET /:id/scripts` and the chat hand the browser's: `note` the chat's own,
 * and the chat's persona's picture, as the page has it from `/api/personas`.
 */
function scriptViewOf(
  member: Character,
  overlay: ScriptOverlay | null,
  note: string,
  persona: Persona | null,
): ScriptView {
  const own = overlay?.members?.[member.id];
  return {
    memberId: member.id,
    note,
    ...(own?.firstMessage !== undefined ? { firstMessage: own.firstMessage } : {}),
    backgroundHtml: own?.backgroundHtml ?? backgroundHtmlOf(member.card.extensions) ?? '',
    avatarUrl: avatarUrl(member),
    personaAvatarUrl: persona ? personaAvatarUrl(persona) : null,
  };
}

/**
 * Plot, roster, persona and branch history — what every generation mode needs.
 *
 * The reader's script overlay on the plot is laid over the work here
 * (`plot_reader_overlays`, `ScriptOverlay` in @shizue/core): what the card's
 * scripts rewrote of a member's card or of the reader's persona — in this chat
 * or any other of theirs on the plot, as RisuAI's rewrite of the character
 * reaches every chat with it — is what this chat's prompt reads, while the plot
 * and the persona rows stay as they are. A renamed member goes by its new name
 * everywhere the prompt names it — and a plot of that one member is that
 * character, so its `{{char}}` follows too (`PromptPlot.char`). The scripted
 * member's first message is what the first opening is sent as (`promptBranch`),
 * and the chat's own lore (`chats.local_lore`) is activated after its book. A
 * generation whose own scripts just rewrote something brings it as `scripts`
 * and reads it already — RisuAI's input and start triggers run before its
 * prompt is built — and the route keeps it once the request has passed its
 * checks (`keepScriptWrites`).
 */
async function loadGenerationContext(
  deps: AppDeps,
  chat: Chat,
  scripts: Pick<GenerationScripts, 'overlay' | 'note' | 'localLore'> = NO_SCRIPTS,
): Promise<{
  plot: PromptPlot;
  /** The whole roster, the members the reader sent off the stage marked absent. */
  characters: PromptCharacter[];
  /** The members still on the stage — the ones a reply may be asked to center on, or of. */
  onStage: Character[];
  /** The whole roster as this chat reads it — renamed and rewritten by the reader's overlay — parallel to `characters`. */
  members: Character[];
  /** The row itself, for the settings that are the plot's rather than the prompt's. */
  row: Plot;
  personaText: string;
  userName: string;
  authorNote: string;
  /** The chat's reader preset (`chats.reader_preset_id`), the chat owner's own. */
  readerAdditions: ReaderAdditions | undefined;
  narrator: NarratorConfig | undefined;
  /** The names this chat's open images go by, for `{{assetlist}}` in the prompt. */
  assetNames: string[];
  /** The chat's auxiliary model as it resolves now, for `{{axmodel}}` (see `auxiliaryModelOf`). */
  auxiliaryModel: string;
  /** What every fold of the chat answers `{{user}}` and `{{char}}` with. */
  fold: FoldOptions;
  /** The reader's global variables on this plot. */
  globalVariables: Variables;
  /** The reader's script overlay on the plot with this request's rewrites laid over it. */
  overlay: ScriptOverlay | null;
  /** The plot's members, which an overlay may name. */
  memberIds: ReadonlySet<string>;
  /** The chat's own lore (RisuAI's `localLore`), as this request's scripts left it. */
  localLore: LoreEntry[];
  /** The plot's first opening as the reader's scripts rewrote it (`setCharacterFirstMessage`). */
  firstMessage: string | undefined;
  /** What the scripted member's Lua reads beyond the prompt (`GenerationPlan.scriptView`). */
  scriptView: ScriptView | undefined;
  /** The same for any member — a group turn's speaker, whose scripts run for its reply. */
  scriptViewFor: (member: Character) => ScriptView;
  /** Who says a character message a card's script wrote (`HistoryMessage.speaker`); undefined when no one can. */
  scriptSpeaker: string | undefined;
  all: Message[];
}> {
  // Re-checked on every generation, not just at chat creation: unpublishing a
  // plot has to stop other users' chats with it from generating further.
  const row = await loadVisiblePlot(deps.db, chat.plotId, chat.userId);
  // In the creator's order, which is the order the prompt blocks are written in.
  const members = await loadMembers(deps.db, row.id);
  const absent = new Set(chat.absentCharacterIds ?? []);
  const memberIds = new Set(members.map((member) => member.id));
  const overlay = overlaidWith(await loadReaderOverlay(deps.db, chat.userId, chat.plotId), scripts.overlay, memberIds);
  const rewritten = overlay?.members
    ? members.map((member) => {
        const own = overlay.members?.[member.id];
        return { ...member, name: own?.name ?? member.name, card: overlaidCard(member.card, own) };
      })
    : members;
  // A plot of one member is that character: RisuAI's `{{char}}` follows its rename.
  const only = rewritten.length === 1 ? rewritten[0]! : undefined;
  const plotChar = only && overlay?.members?.[only.id]?.name !== undefined ? characterName(only) : undefined;
  const scripted = scriptedMember(members, row.customUi?.modules)?.member;

  const persona = await loadPersona(deps, chat);
  return {
    // Crossed with this chat's own toggles: the style the assembler compiles is
    // the creator's, minus the two features this reader turned off.
    plot: { ...toPromptPlot(row, chat), ...(plotChar !== undefined ? { char: plotChar } : {}) },
    characters: toPromptCharacters(rewritten, absent),
    onStage: rewritten.filter((member) => !absent.has(member.id)),
    members: rewritten,
    row,
    personaText: overlay?.persona ?? persona?.description ?? '',
    userName: persona?.name ?? DEFAULT_USER_NAME,
    // The narrator in force: the chat's own if it set one, the plot's
    // otherwise. Whole rather than field by field — a reader who overrides the
    // voice is describing a narrator, not patching the creator's.
    narrator: chat.narrator ?? row.narrator ?? undefined,
    // The chat's own note plus the reusable notes attached to it — the note as
    // this request's scripts left it, when they rewrote it.
    authorNote: await loadAuthorNote(deps, scripts.note === undefined ? chat : { ...chat, note: scripts.note }),
    readerAdditions: await loadReaderAdditions(deps, chat),
    assetNames: await openAssetNames(deps, chat),
    auxiliaryModel: await auxiliaryModelOf(deps, chat),
    fold: foldOptionsOf(row.name, persona),
    globalVariables: await loadGlobalVariables(deps, chat.userId, chat.plotId),
    overlay,
    memberIds,
    localLore: scripts.localLore ?? localLoreOf(chat),
    firstMessage: scripted ? overlay?.members?.[scripted.id]?.firstMessage : undefined,
    scriptView: scripted ? scriptViewOf(scripted, overlay, scripts.note ?? chat.note, persona) : undefined,
    scriptViewFor: (member) => scriptViewOf(member, overlay, scripts.note ?? chat.note, persona),
    // The member whose scripts run, under its name in this chat — or a plot's one
    // member, should its scripts be gone. As the page draws it.
    scriptSpeaker: (scripted ? rewritten.find((member) => member.id === scripted.id) : only)?.name,
    all: await loadMessages(deps, chat.id),
  };
}

/**
 * Keeps what a generation's scripts rewrote — the overlay they sent, merged into
 * the reader's under its lock, the note and the chat's lore — once the request
 * has passed the head checks. Before any other write of the turn, so a turn that
 * fails part-way still leaves the work as its scripts left it, as RisuAI's
 * rewrite of the card would stand.
 */
async function keepScriptWrites(
  deps: AppDeps,
  chat: Chat,
  context: { memberIds: ReadonlySet<string> },
  scripts: Pick<GenerationScripts, 'overlay' | 'note' | 'localLore'>,
): Promise<void> {
  await saveScriptWrites(deps, chat, scripts, context.memberIds);
}

/**
 * What the scripts that ran for a generation did to the chat, kept before its
 * plan is built (`scriptChat.ts`) — after the head checks and the overlay, like
 * every other write of the turn: the prompt, the variables and the reply read
 * the branch as the scripts left it, as RisuAI's request reads the chat its
 * start triggers returned. One transaction, a send's turn written in it; nothing
 * at all when nothing changed.
 */
async function keepScriptChat(
  deps: AppDeps,
  chat: Chat,
  plan: ScriptChatPlan,
  all: Message[],
): Promise<AppliedScriptChat> {
  if (!plan.changed) return { path: plan.path, all, turn: null, written: [] };
  return deps.db.transaction((tx) => applyScriptChat(tx, chat.id, plan, all));
}

/**
 * The branch as the assembler takes it: a group reply names its member
 * (`speakerId`), and an untagged character message a script wrote is said by
 * `speaker`.
 */
const toHistory = (path: Message[], speaker: string | undefined): HistoryMessage[] =>
  path.map((message) => ({
    role: message.role,
    content: message.content,
    id: message.id,
    createdAt: message.createdAt.getTime(),
    ...(message.speakerMemberId !== null ? { speakerId: message.speakerMemberId } : {}),
    ...(speaker !== undefined && message.role === 'assistant' && message.source === 'script' ? { speaker } : {}),
    // Left in, so the chat functions read the stored chat; the assembler sends none of it.
    ...(message.hiddenFromPrompt ? { hidden: true } : {}),
  }));

/**
 * Where a history sits on `branch`, the messages the turn is generated on: its
 * length, and the intro it opened on — a root the chat's openings were written
 * as, numbered by its place among them, the first being -1 as RisuAI numbers
 * them. Approximate where a reroll of the opening added a root of its own.
 *
 * On the first one, the greeting reads as `firstMessage` where the scripts
 * rewrote it (`setCharacterFirstMessage`): RisuAI sends its greeting from the
 * character while the chat is on the first (`fmIndex` -1), and only then.
 */
function promptBranch(all: Message[], branch: Message[], firstMessage?: string): PromptBranch {
  const root = branch[0];
  if (!root || root.parentId !== null || root.role !== 'assistant') return { length: branch.length };
  const openings = all.filter((message) => message.parentId === null && message.role === 'assistant');
  const index = openings.indexOf(root) - 1;
  const text = index === -1 && firstMessage !== undefined ? firstMessage : root.content;
  return { length: branch.length, greeting: { text, index } };
}

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

/** Header the web client names the reader's UI language in. */
const LOCALE_HEADER = 'x-shizue-locale';

/** The reader's UI language as the client reported it; undefined where it said none the server knows. */
export function readerLocale(c: Context<AppEnv>): TranslationLanguage | undefined {
  const locale = c.req.header(LOCALE_HEADER);
  return isTranslationLanguage(locale) ? locale : undefined;
}

/**
 * The reader's side of how the prompt is put together: where the chat's author's
 * note goes and how often, and — in the `instruct` language mode — the language
 * the reply is asked for (§6 언어 모드). The mode is resolved per request: an
 * unset one follows the plot's language against the UI the reader reads in now.
 */
function readerPromptSettings(
  c: Context<AppEnv>,
  chat: Chat,
  plot: Plot,
): Pick<GenerationPlan, 'authorNoteSettings' | 'replyLanguage'> {
  const language = resolveTranslation(chat.translation, plot.language, readerLocale(c));
  return {
    ...(chat.noteSettings ? { authorNoteSettings: chat.noteSettings } : {}),
    ...(language.mode === 'instruct' && language.language ? { replyLanguage: language.language } : {}),
  };
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
const promptHistory = (
  deps: AppDeps,
  userId: string,
  model: string,
  source: Message[],
  speaker: string | undefined,
): Promise<HistoryMessage[]> => withTurnImages(deps, userId, model, source, toHistory(source, speaker));

/**
 * Chat variables of a branch. Folded over the *whole* branch rather than the
 * history the budget left room for: a variable set fifty turns ago must survive
 * its message being evicted, and the client derives the same map from the same
 * messages — macros and script deltas both — so both sides agree.
 */
const pathVariables = (plot: Plot, branch: readonly FoldItem[], fold: FoldOptions): Variables =>
  computeVariables(branch, plot.customUi?.defaultVariables, fold);

/**
 * What a generation checks of the head before it writes anything, for the card's
 * scripts: that it is still the head the browser ran them on, and that the
 * browser is not still owed it. A turn left `pending` is one whose output scripts
 * never ran, and generating on from it would build on text the commit is about
 * to change — so the browser finishes it first, or says it gives up on it
 * (`abandonPending`), which clears the mark.
 *
 * A regenerate asks only the first: it replaces the head rather than building on
 * it, and the pending turn it leaves behind as a sibling is finished whenever a
 * swipe makes it the head again.
 */
async function settleHead(
  deps: AppDeps,
  chat: Chat,
  head: Message | undefined,
  scripts: GenerationScripts,
  buildsOnHead: boolean,
): Promise<void> {
  if (scripts.baseHeadId !== undefined && scripts.baseHeadId !== chat.headMessageId) throw headMoved();
  if (!buildsOnHead || head?.scriptState !== 'pending') return;
  if (!scripts.abandonPending) {
    throw new ApiError(
      409,
      'post_processing_pending',
      'The last reply is still waiting for the scripts of the card to finish it',
    );
  }
  await deps.db.update(messages).set({ scriptState: null }).where(eq(messages.id, head.id));
}

/**
 * The plan's view of the start triggers' writes: the state the prompt reads with
 * them laid over `base`, and the fields that carry them to `persist`.
 */
function startedFrom(
  base: Variables,
  scripts: GenerationScripts,
): Pick<GenerationPlan, 'variables' | 'turnBase' | 'startDelta' | 'injections' | 'postProcess'> {
  return {
    variables: applyVariableDelta(base, scripts.startDelta),
    turnBase: base,
    ...(scripts.startDelta ? { startDelta: scripts.startDelta } : {}),
    ...(scripts.injections ? { injections: scripts.injections } : {}),
    ...(scripts.postProcess ? { postProcess: true } : {}),
  };
}

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
  fold: FoldOptions,
): ChatExportVariableSnapshot[] {
  const timeline: ChatExportVariableSnapshot[] = [];
  // Folded message by message instead of re-reading the prefix at every step;
  // `computeVariables` takes the state so far as its defaults, so each result is
  // exactly what `pathVariables` would return for that prefix.
  let variables = computeVariables([], defaults, fold);
  let previous = variables;
  for (const message of path) {
    variables = computeVariables([message], variables, fold);
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
 * A reference is resolved the way the chat resolves it — by slug, or by the name
 * an imported card gave the image — and one naming an asset that has since been
 * deleted exports nothing, the same thing the chat renders for it. So does one
 * this chat has not unlocked yet: the chat draws a locked card in its place, and
 * the reveal is not the reader's to take away before it happens.
 */
async function referencedAssets(
  deps: AppDeps,
  chat: Chat,
  plotId: string,
  path: Message[],
): Promise<ChatExport['assets']> {
  const refs = path.flatMap((message) => imageMacroRefs(message.content));
  if (refs.length === 0) return [];
  const rows = await deps.db
    .select()
    .from(plotAssets)
    .where(eq(plotAssets.plotId, plotId))
    .orderBy(asc(plotAssets.createdAt), asc(plotAssets.slug));
  const slugOf = assetResolver(rows);
  const referenced = new Set(refs.map(slugOf));
  const locked = new Set(
    (await assetLocks(deps, chat)).filter((lock) => lock.locked).map((lock) => lock.assetId),
  );
  return rows
    .filter((asset) => referenced.has(asset.slug) && !locked.has(asset.id))
    .map((asset) => ({ slug: asset.slug, url: assetUrl(plotId, asset.slug), mime: asset.mime }));
}

const lastUserMessage = (path: Message[]): Message | undefined =>
  [...path].reverse().find((message) => message.role === 'user');

/**
 * Stage directions of the turn being answered. Only the last user message's are
 * injected, so a regenerate re-applies exactly what the original turn carried and
 * an earlier turn's ruling never comes back — nor its own, once it is hidden from the AI.
 */
const lastUserDirections = (path: Message[]): string => {
  const last = lastUserMessage(path);
  return last && !last.hiddenFromPrompt ? (last.directions ?? '') : '';
};

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

/** `body.speakerId`, shape only: a member id, or the narrator's marker. */
function optionalSpeakerId(body: Record<string, unknown>): string | undefined {
  const value = body['speakerId'];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || (value !== NARRATOR_SPEAKER && !isUuid(value))) {
    throw badRequest('invalid_request', `speakerId must be a member id or "${NARRATOR_SPEAKER}"`);
  }
  return value;
}

/** Who a group turn's reply is asked of: `GenerationPlan.speaker`, and the member, or null for the narrator. */
interface GroupVoice {
  speaker: number | NarratorSpeaker;
  member: Character | null;
}

/**
 * The speaker a group-turn request names, held to the work. Group turns are a
 * work of two or more members' (the whole roster counted, on the stage or not)
 * — a work of one answers as it always has, so a `speakerId` there is a client
 * bug. A member must be on the stage. The narrator speaks only on the narration
 * button (`/narrate`), so it is named only where a round that button opened is
 * redone (`narrator`).
 */
function groupVoiceOf(
  context: { members: Character[]; onStage: Character[] },
  speakerId: string,
  { narrator }: { narrator: boolean },
): GroupVoice {
  if (context.members.length < 2) {
    throw badRequest('invalid_request', 'speakerId is only for a work of two or more members');
  }
  if (speakerId === NARRATOR_SPEAKER) {
    if (!narrator) throw badRequest('invalid_request', 'The narrator speaks only on the narration button');
    return { speaker: NARRATOR_SPEAKER, member: null };
  }
  const index = context.members.findIndex((member) => member.id === speakerId);
  if (index < 0 || !context.onStage.some((member) => member.id === speakerId)) {
    throw badRequest('invalid_request', 'speakerId must name a member who is in the scene');
  }
  return { speaker: index, member: context.members[index]! };
}

/** The names a member speaker's own `이름: ` prefixes go by: its name in this chat, then its nickname. */
const speakerNamesOf = (member: Character): string[] => {
  const nickname = member.card.nickname?.trim();
  return [member.name, ...(nickname ? [nickname] : [])];
};

/**
 * What a group voice adds to a plan: the speaker, the names its own prefixes
 * come off by, where the reply is stored (`round`, null opening a new one), the
 * Lua view of whoever's scripts run for it, and — for the narrator — the
 * narration it writes. `notLast` is the round's speakers before the last
 * (`finalSpeaker: false`): the status window and the choices are the last one's.
 */
function voicePlan(
  context: {
    scriptView: ScriptView | undefined;
    scriptViewFor: (member: Character) => ScriptView;
    plot: PromptPlot;
    userName: string;
  },
  voice: GroupVoice,
  groupTurnId: string | null,
  notLast: boolean,
  trailing: string[] = [],
): Pick<GenerationPlan, 'speaker' | 'speakerNames' | 'round' | 'scriptView' | 'narration' | 'trailingSystem'> {
  const macro = { char: context.plot.char ?? context.plot.name, user: context.userName };
  const lines = [
    ...(voice.member ? trailing : [NARRATION_NUDGE]),
    ...(notLast && closesWithState(context.plot.style) ? [NOT_LAST_SPEAKER_NUDGE] : []),
  ].map((line) => applyMacros(line, macro));
  return {
    speaker: voice.speaker,
    ...(voice.member ? { speakerNames: speakerNamesOf(voice.member) } : {}),
    round: { speakerMemberId: voice.member?.id ?? null, groupTurnId },
    scriptView: voice.member ? context.scriptViewFor(voice.member) : context.scriptView,
    ...(voice.member ? {} : { narration: true }),
    ...(lines.length > 0 ? { trailingSystem: lines.join('\n') } : {}),
  };
}

/** Whether this chat's replies end on a status window or choices (`chatStyle`, crossed with the reader's toggles). */
const closesWithState = (style: PlotStyle | undefined): boolean =>
  style?.statusWindow === true || (style?.choices !== undefined && style.choices !== 'off');

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
 *
 * With a `group` speaker it redoes the round the chat ends on ("턴 다시"): every
 * reply of it goes, and the new one — the round's first speaker's — is a sibling
 * of the round's first reply, opening a round of its own. The browser asks the
 * rest of the round after it (`/reply`). A head in no round is the round, and a
 * user head is answered, as without one.
 */
async function regeneratePlan(
  c: Context<AppEnv>,
  deps: AppDeps,
  chat: Chat,
  focusIds: string[] = [],
  scripts: GenerationScripts = NO_SCRIPTS,
  group?: { speakerId: string; notLast: boolean },
): Promise<GenerationPlan> {
  await requireEnabledModel(deps, chat.userId, chat.model);
  const context = await loadGenerationContext(deps, chat, scripts);
  const focusNames = focusNamesOf(context.onStage, focusIds);
  // A round the narration button opened is redone by the narrator.
  const voice = group ? groupVoiceOf(context, group.speakerId, { narrator: true }) : null;
  const scriptMember = scriptMemberOf(scripts.memberId, context.members);
  const path = buildPath(context.all, chat.headMessageId);
  const head = path[path.length - 1];
  if (!head) throw badRequest('invalid_state', 'The chat has no messages to generate from');
  await settleHead(deps, chat, head, scripts, false);

  // An assistant head is replaced by a sibling — a group head with the rest of
  // its round; a user head (edit fork, or a failed generation) gets a fresh
  // assistant child instead.
  const isAssistantHead = head.role === 'assistant';
  // Regenerating a narration asks for a narration again. Without this the
  // replacement would come back as ordinary dialogue and the swipe would move
  // between two different kinds of turn. A group speaker says what it is.
  const narration = !voice && isAssistantHead && isNarration(head.content);
  // The head is about to be replaced, so whatever it set is not part of the
  // state the replacement is generated from — and the start triggers ran on the
  // branch without it, so what they did to the chat is said against that. Its
  // end is not the head when the head is replaced, so nothing there is rewritten
  // in place: an edit of it forks, and the reply follows the fork.
  const replaced = path.slice(0, voice ? roundStart(path) : isAssistantHead ? -1 : path.length);
  const edit = scripts.chat
    ? planScriptChat(replaced, scripts.chat, {
        inPlace: isAssistantHead ? null : rewritableHead(context.all, head),
        ...(scriptMember ? { memberId: scriptMember.id } : {}),
      })
    : null;
  await keepScriptWrites(deps, chat, context, scripts);
  const edited = edit ? await keepScriptChat(deps, chat, edit, context.all) : null;
  const kept = edited ? edited.path : replaced;
  const all = edited ? edited.all : context.all;
  // Memory is applied to the whole path first — it only ever trims the front,
  // so the mode-specific trim of the replaced turns at the end still lines up.
  const memory = await buildMemoryInput(deps, chat, edited ? kept : path, kept);
  const gone = path.length - replaced.length;
  // A member's round answers what stands before it, as `/reply` asked it: the
  // reader's turn, with its ruling — or a reply, the scene going on without the
  // reader (이어가기), which is told so again rather than handed an older turn's ruling.
  const answersReader = !voice?.member || kept.at(-1)?.role === 'user';

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
      gone > 0 && !edited ? memory.history.slice(0, Math.max(0, memory.history.length - gone)) : memory.history,
      context.scriptSpeaker,
    ),
    wholeBranch: kept,
    memoryText: memory.memoryText,
    relationshipText: buildRelationshipText(chat),
    authorNote: context.authorNote,
    ...readerPromptSettings(c, chat, context.row),
    ...(context.narrator ? { narrator: context.narrator } : {}),
    // The user turn being answered is still on the branch, so its ruling comes
    // back with it — a regenerate is the same turn, judged the same way.
    ...(answersReader ? { directions: lastUserDirections(kept) } : {}),
    preset: getPreset(chat.preset),
    readerAdditions: context.readerAdditions,
    // The kept branch only: the head being replaced takes its delta with it, so
    // a regenerate starts from where the turn before it left things.
    ...startedFrom(pathVariables(context.row, kept, context.fold), scripts),
    fold: context.fold,
    globalVariables: context.globalVariables,
    clock: requestClock(c, context.row, kept),
    seed: chat.id,
    branch: promptBranch(all, kept, context.firstMessage),
    // Without the head being replaced: its records belong to the swipe this
    // generation is an alternative to.
    loreState: loreStateOf(kept),
    assetNames: context.assetNames,
    scriptView: context.scriptView,
    localLore: context.localLore,
    auxiliaryModel: context.auxiliaryModel,
    contextBudget: memorySettingsOf(chat).contextBudget,
    focusNames,
    ...(narration
      ? {
          trailingSystem: applyMacros(NARRATION_NUDGE, {
            char: context.plot.char ?? context.plot.name,
            user: context.userName,
          }),
          narration: true,
        }
      : {}),
    ...(voice ? voicePlan(context, voice, null, group!.notLast, answersReader ? [] : [AUTO_CONTINUE_NUDGE]) : {}),
    // The head's parent or the head — the round's first reply's parent for a
    // round — or where the scripts left the branch.
    target: { kind: 'new', parentId: kept.at(-1)?.id ?? null },
  };
}

/**
 * A script's model call (`script-llm`) as the card's request triggers leave it,
 * since RisuAI runs them before every request it sends. The request is the
 * script's own turns, in order, as RisuAI's triggers see a script's
 * (`editRequestTurns`); the chat they read is the branch as stored now, with the
 * variables, the overlay and the reader's side of things a generation on it
 * would have. Unedited where the run fails, as a generation's. The triggers are
 * those of the member whose script called (`memberId`), else the scripted member's.
 */
async function withScriptRequestTriggers(
  c: Context<AppEnv>,
  deps: AppDeps,
  chat: Chat,
  messages: ChatMessage[],
  memberId: string | undefined,
): Promise<ChatMessage[]> {
  const context = await loadGenerationContext(deps, chat);
  const path = buildPath(context.all, chat.headMessageId);
  const index = memberId === undefined ? -1 : context.members.findIndex((member) => member.id === memberId);
  const input = requestTriggerInput({
    plot: context.plot,
    characters: context.characters,
    ...(index >= 0 ? { speaker: index } : {}),
    wholeBranch: path,
    branch: promptBranch(context.all, path, context.firstMessage),
    authorNote: context.authorNote,
    personaText: context.personaText,
    userName: context.userName,
    variables: pathVariables(context.row, path, context.fold),
    globalVariables: context.globalVariables,
    clock: requestClock(c, context.row, path),
    seed: chat.id,
    assetNames: context.assetNames,
  });
  if (!input) return messages;
  const turns = messages.map((message) => ({ role: message.role, content: contentText(message.content) }));
  const edited = await editRequestTurns(turns, input, { run: deps.runRequestTriggers, label: chat.id });
  return edited ? edited.map(({ role, content }) => ({ role, content })) : messages;
}

/**
 * The scripts a script's call is held to: those of the member whose runtime
 * made it (`memberId`, which must be on the roster — 400 otherwise), else the
 * scripted member's, the lead's (`scriptedMember`). Null where that member
 * carries none.
 */
function callingScripts(
  members: Character[],
  memberId: string | undefined,
  modules: readonly PlotModule[] = [],
): { member: Character; scripts: CardScripts } | null {
  const named = scriptMemberOf(memberId, members);
  if (!named) return scriptedMember(members, modules);
  const scripts = cardScripts(named.card, modules);
  return scripts ? { member: named, scripts } : null;
}

/**
 * One member's scripts as the reader's browser runs them (`GET /:id/scripts`):
 * its triggers and `editinput`/`editoutput` regex, the parts of its card the
 * scripts may read, and what the reader's scripts rewrote of it on this plot
 * (its slice of the overlay, and the persona's), with the chat's own lore.
 */
function scriptBundleOf(
  member: Character,
  scripts: CardScripts,
  overlay: ScriptOverlay | null,
  chat: Chat,
) {
  const card = member.card;
  const own = overlay?.members?.[member.id] ?? null;
  const nickname = card.nickname?.trim() ?? '';
  return {
    memberId: member.id,
    // `{{char}}` in a card's own text: its nickname where it sets one, else its
    // name as the reader's scripts left it.
    name: nickname || own?.name || member.name,
    triggers: scripts.triggers,
    editScripts: scripts.editScripts,
    lowLevelAccess: scripts.lowLevelAccess,
    character: {
      // RisuAI's `char.name` (Lua's `getName`), and the nickname `{{char}}` stays.
      name: member.name,
      nickname,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      exampleDialogue: card.mesExample,
      lorebook: card.lorebook,
      postHistoryInstructions: card.postHistoryInstructions,
      // What `/test_lorebook` and Lua's `loadLoreBooks` activate the book by, as the prompt does.
      loreSettings: card.loreSettings,
      // RisuAI's `backgroundHTML` whole, styles and all, as Lua's `getBackgroundEmbedding` reads it.
      backgroundHtml: backgroundHtmlOf(card.extensions) ?? '',
      // RisuAI's `char.image`, for Lua's `getCharacterImage`: a same-origin address, or null.
      avatarUrl: avatarUrl(member),
    },
    overlay: {
      member: own,
      persona: overlay?.persona ?? null,
    },
    localLore: localLoreOf(chat),
  };
}

export function chatRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const scriptFetch = deps.scriptFetch ?? createScriptFetch({ ownOrigins: deps.webOrigin ? [deps.webOrigin] : [] });

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
    // Checked before the persona: a profile pick copies a row, and a refused
    // start must leave nothing behind.
    const subModel = await optionalSubModel(deps, userId, body);
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
        subModel: subModel ?? null,
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
    // The roster is the creator's to withdraw, and with it who said a group reply.
    const members = plot ? await loadMembers(deps.db, plot.id) : [];
    const memberNames = new Map(members.map((member) => [member.id, member.name]));

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
        // A group reply carries no `이름:` prefix of its own: who said it travels beside it.
        ...(message.speakerMemberId !== null && memberNames.has(message.speakerMemberId)
          ? { speaker: { id: message.speakerMemberId, name: memberNames.get(message.speakerMemberId)! } }
          : {}),
        // Only on a message the reader hid from the AI.
        ...(message.hiddenFromPrompt ? { hiddenFromPrompt: true } : {}),
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
      assets: plot ? await referencedAssets(deps, chat, plot.id, path) : [],
      // The roster, in the creator's order: the names are the speaker prefixes the
      // transcript carries, so an importer can tell whose lines are whose.
      characters: members.map((member) => ({
        id: member.id,
        name: member.name,
        avatarUrl: avatarUrl(member),
      })),
      coverUrl: plot ? coverUrl(plot) : null,
      // The plot is read for its variable defaults and for nothing else; without one, the
      // fold starts empty and reflects only what the conversation itself set.
      variableTimeline: variableTimeline(
        plot?.customUi?.defaultVariables,
        path,
        foldOptionsOf(plot?.name ?? chat.title, await loadPersona(deps, chat)),
      ),
    };
    return c.json(payload);
  });

  // Chat settings. Switching the model mid-generation would split one exchange
  // across two providers, so a busy generation slot blocks the change. The author's
  // note is only read while a prompt is assembled and could safely be written
  // during a generation, but it takes the same slot: one rule for the endpoint
  // beats semantics that depend on which fields the body happens to carry, and the
  // client disables the note panel while a reply streams anyway. The auxiliary
  // model is under the same rule — a script's call on it holds the slot too, so
  // it is never switched in the middle of one.
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
      const chat = await loadWritableChat(deps, id, userId);
      const body = await readJsonBody(c);

      const model =
        body['model'] === undefined ? undefined : await requireEnabledModel(deps, c.get('userId'), requireString(body, 'model'));
      const subModel = await optionalSubModel(deps, userId, body);
      const personaId =
        'personaId' in body ? ((await resolvePersona(deps, userId, body['personaId']))?.id ?? null) : undefined;
      const note = optionalString(body, 'note');
      const preset = optionalPreset(body);
      const readerPresetId =
        'readerPresetId' in body ? await resolveReaderPresetId(deps, userId, body['readerPresetId']) : undefined;
      const relationshipEnabled = optionalBoolean(body, 'relationshipEnabled');
      const memorySettings = optionalMemorySettings(body);
      const allowComponentTurns = optionalBoolean(body, 'allowComponentTurns');
      const statusWindowEnabled = optionalBoolean(body, 'statusWindowEnabled');
      const choicesEnabled = optionalBoolean(body, 'choicesEnabled');
      const narrator = optionalNarrator(body);
      const reasoningEffort = await patchedReasoningEffort(deps, userId, body, chat, model);
      const absentCharacterIds = await patchedAbsentIds(deps, body, chat);
      const noteSettings = optionalSettings(body, 'noteSettings', coerceAuthorNoteSettings);
      const translation = optionalSettings(body, 'translation', coerceTranslationSettings);

      if (
        noteSettings === undefined &&
        translation === undefined &&
        model === undefined &&
        subModel === undefined &&
        personaId === undefined &&
        note === undefined &&
        preset === undefined &&
        readerPresetId === undefined &&
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
          ...(subModel !== undefined ? { subModel } : {}),
          ...(personaId !== undefined ? { personaId } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(preset !== undefined ? { preset } : {}),
          ...(readerPresetId !== undefined ? { readerPresetId } : {}),
          ...(relationshipEnabled !== undefined ? { relationshipEnabled } : {}),
          ...(memorySettings !== undefined ? { memorySettings } : {}),
          ...(allowComponentTurns !== undefined ? { allowComponentTurns } : {}),
          ...(statusWindowEnabled !== undefined ? { statusWindowEnabled } : {}),
          ...(choicesEnabled !== undefined ? { choicesEnabled } : {}),
          ...(narrator !== undefined ? { narrator } : {}),
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          ...(absentCharacterIds !== undefined ? { absentCharacterIds } : {}),
          ...(noteSettings !== undefined ? { noteSettings } : {}),
          ...(translation !== undefined ? { translation } : {}),
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

  // Attaching a reusable note. Idempotent: re-attaching an attached note is a
  // no-op rather than a conflict, so a double click cannot fail the request.
  app.post('/:id/notes/:noteId', async (c) => {
    const userId = c.get('userId');
    const chat = await loadWritableChat(deps, requireUuidParam(c), userId);
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
    const chat = await loadWritableChat(deps, requireUuidParam(c), userId);
    const note = await loadOwnedNote(deps, requireUuidParam(c, 'noteId'), userId);

    await deps.db
      .delete(chatNoteLinks)
      .where(and(eq(chatNoteLinks.chatId, chat.id), eq(chatNoteLinks.noteId, note.id)));
    return c.json(await chatState(deps, chat));
  });

  // Branch switch: head moves to the deepest (newest) leaf under the given message.
  app.post('/:id/head', async (c) => {
    const chat = await loadWritableChat(deps, requireUuidParam(c), c.get('userId'));
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
    const chat = await loadWritableChat(deps, requireUuidParam(c), userId);
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

      // One transaction, as the edits are: a summary must stop standing for text
      // that is gone at the same moment the text goes — every message the
      // delete takes, since a summary may cover only the later ones.
      let dropped = 0;
      const updated = await deps.db.transaction(async (tx) => {
        dropped = await invalidateMemoryForEdit(tx, chat.id, [...pruned]);
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
      // pointed at it is really gone — every row: a script's copy of a turn on
      // another branch names the same image (`scriptChat.ts`).
      const paths = [...new Set(orphaned.map((attachment) => attachment.path))];
      const shared =
        paths.length > 0
          ? new Set(
              (
                await deps.db
                  .select({ path: chatAttachments.path })
                  .from(chatAttachments)
                  .where(and(eq(chatAttachments.chatId, chat.id), inArray(chatAttachments.path, paths)))
              ).map((attachment) => attachment.path),
            )
          : new Set<string>();
      for (const path of paths) if (!shared.has(path)) await deleteQuietly(deps.storage, path);
      // What the dropped summaries covered and is still on a branch is summarized again.
      if (dropped > 0) scheduleMemoryUpdate(deps, chat.id);
      return c.json(await chatState(deps, updated));
    } finally {
      await releaseChatSlot(deps, chat.id);
    }
  });

  /**
   * Hides one message from the AI, or shows it to the AI again — SillyTavern's
   * /hide and /unhide. The message stays on screen; what a model reads leaves it
   * out (the prompt, the lore scan, the memory, suggestions). The flag is the
   * node's, so every branch through it shares it.
   *
   * The memory is invalidated as an in-place edit invalidates it, in the same
   * transaction: a summary that already covers the message is dropped, and the
   * refresh scheduled once it commits writes it again with the message in or
   * out. Like an edit it takes no generation claim — a refresh racing it loses
   * on the revision.
   */
  app.put('/:id/messages/:messageId/hidden', async (c) => {
    const userId = c.get('userId');
    const chat = await loadWritableChat(deps, requireUuidParam(c), userId);
    const messageId = requireUuidParam(c, 'messageId');
    const body = await readJsonBody(c);
    const hidden = optionalBoolean(body, 'hidden');
    if (hidden === undefined) throw badRequest('invalid_request', 'hidden must be a boolean');

    let changed = false;
    await deps.db.transaction(async (tx) => {
      const [message] = await tx
        .select({ hidden: messages.hiddenFromPrompt })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.chatId, chat.id)))
        .limit(1);
      if (!message) throw notFound('Message not found');
      // Already so: nothing the memory read has changed.
      if (message.hidden === hidden) return;
      await tx.update(messages).set({ hiddenFromPrompt: hidden }).where(eq(messages.id, messageId));
      await invalidateMemoryForEdit(tx, chat.id, messageId);
      changed = true;
    });
    // Either way the memory has a stretch to summarize again: the one a dropped
    // summary covered, or a message shown again among covered ones.
    if (changed) scheduleMemoryUpdate(deps, chat.id);
    return c.json(await chatState(deps, await loadOwnedChat(deps, chat.id, userId)));
  });

  /**
   * The emotion picture a reply left its member wearing (`messages.emotion`), by
   * name, or null while none is chosen. The choice is made after the turn is done
   * (`emotion.ts`), so the page asks here for the one reply it is waiting on
   * rather than reading the whole chat again.
   */
  app.get('/:id/messages/:messageId/emotion', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    const [message] = await deps.db
      .select({ emotion: messages.emotion })
      .from(messages)
      .where(and(eq(messages.id, requireUuidParam(c, 'messageId')), eq(messages.chatId, chat.id)))
      .limit(1);
    if (!message) throw notFound('Message not found');
    return c.json({ emotion: message.emotion });
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

    const chat = await loadWritableChat(deps, id, userId);
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
        // …and what its scripts left: they ran once, for the turn the copy still
        // is, and nothing runs them again for a rewording.
        ...(original?.variableDelta ? { variableDelta: original.variableDelta } : {}),
        // …and who said it in which round: a reworded group reply is still theirs.
        ...(original ? { speakerMemberId: original.speakerMemberId, groupTurnId: original.groupTurnId } : {}),
        // …and whether the AI reads it.
        ...(original?.hiddenFromPrompt ? { hiddenFromPrompt: true } : {}),
        // …and the face its member wore after it, which a rewording does not change.
        ...(original?.role === 'assistant' && role === 'assistant' && original.emotion
          ? { emotion: original.emotion }
          : {}),
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
    let dropped = 0;
    const updated = await deps.db.transaction(async (tx) => {
      await tx.insert(messages).values(rebuilt);
      dropped = await invalidateMemoryForEdit(tx, chat.id, scene[kept]!.id);
      const [row] = await tx
        .update(chats)
        .set({ headMessageId: head, updatedAt: new Date() })
        .where(eq(chats.id, chat.id))
        .returning();
      return row!;
    });
    if (dropped > 0) scheduleMemoryUpdate(deps, chat.id);
    return c.json(await chatState(deps, updated));
  });

  /**
   * What the reader's browser runs for this chat: for every member that carries
   * scripts, in roster order (`members`), its triggers and `editinput`/
   * `editoutput` regex scripts and the parts of its card the scripts may read —
   * its name and nickname, its description and the rest of its character text,
   * its lorebook and the book's settings, its post-history instructions, its
   * background HTML and its avatar — with what the reader's scripts rewrote of it
   * on this plot beside it (its slice of the overlay every chat of theirs on it
   * reads, and the persona's), and the chat's own lore (`localLore`, what Lua's
   * `upsertLocalLoreBook` wrote in this chat) — `scriptBundleOf`. `name` is
   * `{{char}}` as it stands for the reader: the nickname, else the name the
   * scripts left. `scripts` is the first of them, the scripted member
   * (`scriptedMember`), which is all a page from before group turns reads.
   *
   * This is the one place a reader receives a member's card internals, and only
   * for a plot that carries scripts: RisuAI's scripts read the card they belong
   * to, so a card that plays in RisuAI has to be able to read it here too. The
   * creator is told so when they publish such a plot. Everything else a reader
   * gets of the work stays as it was — `{ scripts: null, members: [] }` for a
   * plot without.
   */
  app.get('/:id/scripts', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    // The same gate as generating: a plot withdrawn from the reader runs nothing.
    const plot = await loadVisiblePlot(deps.db, chat.plotId, chat.userId);
    // A work's modules ride in every member's scripts, after the card's own: in a
    // group RisuAI runs them for whichever character it asks.
    const modules = plot.customUi?.modules ?? [];
    const scripted = (await loadMembers(deps.db, plot.id)).flatMap((member) => {
      const scripts = cardScripts(member.card, modules);
      return scripts ? [{ member, scripts }] : [];
    });
    if (scripted.length === 0) return c.json({ scripts: null, members: [] });
    const overlay = await loadReaderOverlay(deps.db, chat.userId, chat.plotId);
    const members = scripted.map(({ member, scripts }) => scriptBundleOf(member, scripts, overlay, chat));
    return c.json({ scripts: members[0]!, members });
  });

  /**
   * What the card's scripts made of the head, written back: the values they left
   * (`variableDelta`, which replaces the turn's; null clears it), the text the
   * output scripts turned the reply into (`content`, in place — a script's edit is
   * not the reader's and forks nothing), and `clearPending`, which says the turn
   * the browser owed its output scripts is now finished. What they rewrote of the
   * work rides along too — `overlay`, merged into the reader's on the plot
   * (`ScriptOverlay`) — and what they rewrote of the chat — `note`, the chat
   * note, and `localLore`, the chat's own lore — in the same transaction as the
   * turn.
   *
   * Only the head: a button the reader clicked acts on the chat as it stands, and
   * the reply the output scripts run over is the one that was just generated. A
   * head that moved on meanwhile is a 409, and so is a revision other than the one
   * the scripts ran on — a second tab finishing the same turn, or a hand edit or a
   * continue that changed it since — so nothing the scripts did is applied twice
   * or applied to text they never read. The browser refetches and runs again.
   *
   * What the scripts did to the rest of the chat — a message appended after the
   * reply, the chat cut, an older message rewritten — comes as `chat`
   * (`ScriptChat`), said against the branch with the head as `content` left it,
   * and is kept as the reader's branch in the same transaction (`scriptChat.ts`).
   * `variableDelta` is then the delta of the message that branch ends on.
   *
   * It takes the generation slot, as a delete does: a commit landing under a
   * running stream would change the state that stream was planned on.
   */
  app.post('/:id/script-commit', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const messageId = requireString(body, 'messageId');
    if (!isUuid(messageId)) throw badRequest('invalid_request', 'messageId must be a message id');
    const scriptRev = body['scriptRev'];
    if (typeof scriptRev !== 'number' || !Number.isInteger(scriptRev) || scriptRev < 0) {
      throw badRequest('invalid_request', 'scriptRev must be the revision the scripts ran on');
    }
    const variableDelta = 'variableDelta' in body ? optionalVariableDelta(body, 'variableDelta') : undefined;
    const content = optionalString(body, 'content');
    const clearPending = optionalBoolean(body, 'clearPending') ?? false;
    // What the scripts rewrote of the work, the chat note and the chat's lore (see `ScriptOverlay`).
    const overlay = readOverlay(body['overlay']);
    const note = optionalScriptNote(body);
    const localLore = readLocalLore(body['localLore']);
    const edits = readScriptChat(body, { turn: false });
    // The member whose runtime ran: a character message its scripts add is its own.
    const memberId = optionalMemberId(body);
    // The emotion picture an `@@emo` script named for the reply (`emotion.ts`).
    const emotion = optionalString(body, 'emotion');
    if (
      variableDelta === undefined &&
      content === undefined &&
      emotion === undefined &&
      !clearPending &&
      !overlay &&
      note === undefined &&
      localLore === undefined &&
      !edits
    ) {
      throw badRequest('invalid_request', 'Nothing to commit');
    }

    const chat = await loadWritableChat(deps, id, userId);
    const roster =
      overlay || memberId !== undefined || emotion !== undefined ? await loadMembers(deps.db, chat.plotId) : [];
    const memberIds = overlay ? new Set(roster.map((member) => member.id)) : null;
    scriptMemberOf(memberId, roster);
    if (!(await acquireChatSlot(deps, chat.id, userId))) await rejectBusyChat(deps, chat.id, userId);
    let committed: { chat: Chat; message: Message; written: Message[] };
    let dropped = 0;
    try {
      committed = await deps.db.transaction(async (tx) => {
        // Both rows locked, the message first: a hand edit takes no slot, and it
        // locks the message and then the chat, so taking them in the same order
        // is what keeps the two from deadlocking. The chat's lock is what a
        // branch switch waits on, so the head read here is the head this lands on.
        const [current] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, messageId), eq(messages.chatId, chat.id)))
          .for('update');
        const [locked] = await tx
          .select({ headMessageId: chats.headMessageId })
          .from(chats)
          .where(eq(chats.id, chat.id))
          .for('update');
        if (!current || locked?.headMessageId !== messageId) throw headMoved();
        if (current.scriptRev !== scriptRev) throw scriptRevMoved();
        if (clearPending && current.scriptState !== 'pending') {
          throw new ApiError(409, 'not_pending', 'This turn is not waiting for the scripts of the card');
        }
        // Kept only as one of the reply's own member's pictures, as RisuAI's
        // `@@emo` sets one only where the character has it; any other is no choice.
        const owner = emotion === undefined ? undefined : replyMemberOf(current, roster);
        const chosen = owner && emotion !== undefined ? emotionNamed(owner.card.emotionImages ?? [], emotion) : undefined;

        const [message] = await tx
          .update(messages)
          .set({
            // With a chat, the delta is the one of the message the chat ends on.
            ...(variableDelta !== undefined && !edits ? { variableDelta: storableDelta(variableDelta) } : {}),
            ...(content !== undefined ? { content } : {}),
            ...(clearPending ? { scriptState: null } : {}),
            ...(chosen ? { emotion: chosen.name } : {}),
            scriptRev: sql`${messages.scriptRev} + 1`,
          })
          .where(eq(messages.id, messageId))
          .returning();
        if (content !== undefined && content !== current.content) {
          dropped = await invalidateMemoryForEdit(tx, chat.id, messageId);
        }
        // Checked against the branch as it stands under the lock; a refusal
        // rolls the rest of the commit back with it.
        let written: Message[] = [];
        if (edits) {
          const all = await tx.select().from(messages).where(eq(messages.chatId, chat.id));
          const plan = planScriptChat(buildPath(all, messageId), edits, {
            inPlace: rewritableHead(all, message!),
            ...(variableDelta !== undefined ? { lastDelta: variableDelta } : {}),
            ...(memberId !== undefined ? { memberId } : {}),
          });
          if (plan.changed) written = (await applyScriptChat(tx, chat.id, plan, all)).written;
        }
        const [row] = await tx
          .update(chats)
          .set({
            ...(note !== undefined ? { note } : {}),
            ...(localLore !== undefined ? { localLore: localLore.length > 0 ? localLore : null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(chats.id, chat.id))
          .returning();
        // Merged under the overlay row's own lock — after the chat's, as every
        // writer takes them — so a commit here and a write from another of the
        // reader's chats on the plot each land on the other's.
        if (overlay && memberIds) await mergeReaderOverlay(tx, chat.userId, chat.plotId, overlay, memberIds);
        return { chat: row!, message: message!, written };
      });
    } finally {
      await releaseChatSlot(deps, chat.id);
    }

    // The text the reader will keep is the one the unlocks are asked about too —
    // and the replies the scripts wrote or rewrote; they only ever open, so asking
    // again after the raw text cost nothing.
    const unlockText = [
      ...(content !== undefined ? [committed.message.content] : []),
      ...committed.written.filter((message) => message.role === 'assistant').map((message) => message.content),
    ];
    const unlockedAssetIds = unlockText.length > 0 ? await openUnlocks(deps, chat.id, unlockText.join('\n')) : [];
    // The turn is finished, so the work it held back can start.
    if (clearPending) scheduleBackgroundUpdates(deps, chat.id, messageId);
    else if (dropped > 0) scheduleMemoryUpdate(deps, chat.id);
    const state = (await chatState(deps, committed.chat)) as Record<string, unknown>;
    return c.json({ ...state, ...(unlockedAssetIds.length > 0 ? { unlockedAssetIds } : {}) });
  });

  /** The reader's global variables on this chat's plot (see `plotReaderVariables`). */
  app.get('/:id/global-variables', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    return c.json({ variables: await loadGlobalVariables(deps, chat.userId, chat.plotId) });
  });

  /**
   * Merges into them: `{ variables: { name: value | null } }`, null unsetting, and
   * answers with the whole map. They are the reader's own on the plot rather than
   * the chat's, so a chat an import is still filling may write them too.
   */
  app.patch('/:id/global-variables', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    const body = await readJsonBody(c);
    if (!('variables' in body)) throw badRequest('invalid_request', 'variables is required');
    return c.json({
      variables: await mergeGlobalVariables(deps, chat.userId, chat.plotId, body['variables']),
    });
  });

  /**
   * A model call a card's script asks for (Lua `LLM`, `axLLM`, `simpleLLM`;
   * triggers' `runLLM`, `v2RunLLM`): `{ messages: [{ role, content }], model? }`
   * in, `{ result }` out — on the reader's own account, nothing stored
   * (`scriptLlm.ts`). `model` is `'main'` (the default), the chat's own model, or
   * `'sub'`, its auxiliary model, resolved as the background work resolves it.
   *
   * Held as RisuAI holds the functions: the card of the member whose runtime
   * called (`memberId`, a roster member; the plot's scripted member without one)
   * must grant low-level access (403 `script_llm_forbidden` otherwise), and its
   * request triggers are the ones that run over the call. Held as a turn is:
   * the reader's writable chat on a plot still visible to them, and the
   * generation slot for the length of the call (429 `generation_in_progress`),
   * renewed as a stream renews it. No count limit — the reader's account pays.
   */
  app.post('/:id/script-llm', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const messages = readScriptLlmMessages(body['messages']);
    const which = readScriptLlmModel(body['model']);
    const memberId = optionalMemberId(body);
    const chat = await loadWritableChat(deps, id, userId);
    const plot = await loadVisiblePlot(deps.db, chat.plotId, chat.userId);
    const scripted = callingScripts(await loadMembers(deps.db, plot.id), memberId, plot.customUi?.modules);
    if (!scripted?.scripts.lowLevelAccess) {
      throw forbidden('script_llm_forbidden', "This plot's scripts may not call the model");
    }
    if (!(await acquireChatSlot(deps, chat.id, userId))) await rejectBusyChat(deps, chat.id, userId);
    const keepAlive = setInterval(() => void renewChatSlot(deps, chat.id), HEARTBEAT_MS);
    try {
      // An owner with no catalog resolves to '', and the adapter then says why,
      // as it does for the chat's own model.
      const model = which === 'sub' ? await auxiliaryModelOf(deps, chat) : chat.model;
      // RisuAI runs the request triggers over a script's call as over any request it sends.
      const sent = hasTriggersFor(scripted.scripts.triggers, 'request')
        ? await withScriptRequestTriggers(c, deps, chat, messages, scripted.member.id)
        : messages;
      return c.json({
        result: await runScriptLlm(deps, { userId, model, messages: sent, signal: c.req.raw.signal }),
      });
    } finally {
      clearInterval(keepAlive);
      await releaseChatSlot(deps, chat.id);
    }
  });

  /**
   * Lua `request`: `{ url }` in, RisuAI's `{ status, data }` out (`scriptFetch.ts`).
   * This server makes the GET, as RisuAI's proxy does on the web, so the address
   * sees this server and never the reader. Every answer RisuAI gives — its rate
   * limit (429), a long URL (413), a refused one (400), `internal error`, and the
   * target's own status — is a 200 here with that answer as the body; only this
   * route's own refusals are HTTP errors.
   *
   * Held as RisuAI holds it: the calling member's card (`memberId`, else the
   * scripted member's) must grant low-level access, the same gate and the same
   * 403 as `script-llm`. The chat must be the
   * reader's and writable. It does not take the generation slot: it writes
   * nothing and spends nothing of the reader's account, and a script may have
   * several in flight at once in RisuAI (deps' `suggesting` is the same rule).
   * Nothing is stored.
   */
  app.post('/:id/script-fetch', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const memberId = optionalMemberId(body);
    const chat = await loadWritableChat(deps, id, userId);
    const plot = await loadVisiblePlot(deps.db, chat.plotId, chat.userId);
    if (!callingScripts(await loadMembers(deps.db, plot.id), memberId, plot.customUi?.modules)?.scripts.lowLevelAccess) {
      throw forbidden('script_fetch_forbidden', "This plot's scripts may not make requests");
    }
    // The URL is not checked here: what RisuAI answers for one that is not text is part of its answer.
    return c.json(await scriptFetch.request(userId, body['url'], c.req.raw.signal));
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
    const chat = await loadWritableChat(deps, requireUuidParam(c), c.get('userId'));

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
    const chat = await loadWritableChat(deps, requireUuidParam(c), c.get('userId'));
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
    // What the card's input and start triggers left, over the state this turn's
    // own macros fold to — stored on the turn, which is the message they ran for.
    // Where they edited the chat around it, it is the message the chat ends on.
    const variableDelta = optionalVariableDelta(body, 'variableDelta');
    const scripts = readGenerationScripts(body, { startDelta: false });
    // A start trigger said not to send (`stop`): the turn is stored as a send
    // stores it, and nothing is generated (see `stopped` below).
    const stopped = optionalBoolean(body, 'stopped') ?? false;
    // A work of several members: the round's first speaker, whose reply opens it.
    const speakerId = optionalSpeakerId(body);
    const notLast = optionalBoolean(body, 'finalSpeaker') === false;

    /**
     * Everything a send writes before its prompt is planned: the head checks, the
     * overlay and the note, and the turn where the scripts left it. Nothing is
     * written until every check has passed.
     */
    const storeTurn = async (chat: Chat) => {
      const context = await loadGenerationContext(deps, chat, scripts);
      // Still before any write, and it needs the card the context just loaded.
      if (source === 'component') requireComponentTurnAllowed(chat, context.row);
      const focusNames = focusNamesOf(context.onStage, focusIds);
      const voice = speakerId === undefined ? null : groupVoiceOf(context, speakerId, { narrator: false });
      const scriptMember = scriptMemberOf(scripts.memberId, context.members);
      const path = buildPath(context.all, chat.headMessageId);
      await settleHead(deps, chat, path.at(-1), scripts, true);
      // The turn goes where the scripts left it — after the branch, unless they
      // edited the chat around it, or cut it (RisuAI then sends without it).
      const edit = planScriptChat(path, scripts.chat, {
        inPlace: rewritableHead(context.all, path.at(-1)),
        lastDelta: variableDelta,
        // Stored on the turn rather than on the request, so a regenerate of it
        // re-applies the same ruling.
        turn: { content, source, ...(directions ? { directions } : {}), attachmentIds },
        ...(scriptMember ? { memberId: scriptMember.id } : {}),
      });
      await keepScriptWrites(deps, chat, context, scripts);

      // One transaction, because the uploads are part of the turn: an id that is
      // not this chat's own — or that another turn already claimed — must leave
      // no message behind for the client to find on its retry.
      const edited = await keepScriptChat(deps, chat, edit, context.all);
      return { context, focusNames, edited, voice };
    };

    /**
     * RisuAI's `sendMain` pushes the turn onto the chat and `sendChat` then runs
     * the start triggers, so a `stop` there leaves the turn in the chat with no
     * reply. Here the browser ran them already and says so: the turn, its delta,
     * what the runs did to the chat and the work are kept exactly as a send keeps
     * them, and the answer is the chat as it now stands rather than a stream. The
     * slot is held for the write, as a commit holds it. No model is asked for
     * anything, so the chat's model is not checked either.
     */
    if (stopped) {
      if (!(await acquireChatSlot(deps, id, userId))) await rejectBusyChat(deps, id, userId);
      try {
        await storeTurn(await loadWritableChat(deps, id, userId));
      } finally {
        await releaseChatSlot(deps, id);
      }
      return c.json(await chatState(deps, await loadOwnedChat(deps, id, userId)));
    }

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> => {
      const chat = await loadWritableChat(deps, id, userId);
      // Fail before any write: a 400 here must leave the chat untouched, otherwise
      // the client resends a turn that was already persisted.
      await requireEnabledModel(deps, userId, chat.model);
      const { context, focusNames, edited, voice } = await storeTurn(chat);
      const branch = edited.path;

      const memory = await buildMemoryInput(deps, chat, branch.slice(0, -1), branch);
      // The turn just written is the last of the history, and the images ride on
      // it; the rest of the branch's are not re-sent (see `withTurnImages`).
      const history = await promptHistory(
        deps,
        c.get('userId'),
        chat.model,
        [...memory.history, ...branch.slice(-1)],
        context.scriptSpeaker,
      );

      return {
        chatId: chat.id,
        model: chat.model,
        plot: context.plot,
        characters: context.characters,
        personaText: context.personaText,
        userName: context.userName,
        history,
        wholeBranch: branch,
        memoryText: memory.memoryText,
        relationshipText: buildRelationshipText(chat),
        authorNote: context.authorNote,
        ...readerPromptSettings(c, chat, context.row),
        ...(context.narrator ? { narrator: context.narrator } : {}),
        ...(directions && edited.turn ? { directions } : {}),
        preset: getPreset(chat.preset),
        readerAdditions: context.readerAdditions,
        // The stored rows, so the turn's delta is folded with its text.
        ...startedFrom(pathVariables(context.row, branch, context.fold), scripts),
        fold: context.fold,
        globalVariables: context.globalVariables,
        clock: requestClock(c, context.row, branch),
        seed: chat.id,
        branch: promptBranch(edited.all, branch, context.firstMessage),
        loreState: loreStateOf(branch),
        assetNames: context.assetNames,
        scriptView: context.scriptView,
        localLore: context.localLore,
        auxiliaryModel: context.auxiliaryModel,
        contextBudget: memorySettingsOf(chat).contextBudget,
        focusNames,
        // The round's first reply, which is the round's id.
        ...(voice ? voicePlan(context, voice, null, notLast) : {}),
        target: { kind: 'new', parentId: branch.at(-1)?.id ?? null },
      };
    });
  });

  // In a work of several members, with `speakerId`: the whole round again, from
  // its first speaker (`regeneratePlan`). Without it, the head as it always was.
  app.post('/:id/regenerate', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await optionalJsonBody(c);
    const focusIds = optionalMemberIds(body, 'focusCharacterIds') ?? [];
    const scripts = readGenerationScripts(body, { startDelta: true });
    const speakerId = optionalSpeakerId(body);
    const group =
      speakerId === undefined ? undefined : { speakerId, notLast: optionalBoolean(body, 'finalSpeaker') === false };

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> =>
      regeneratePlan(c, deps, await loadWritableChat(deps, id, userId), focusIds, scripts, group),
    );
  });

  /**
   * One more reply in a work of several members: `speakerId`'s, an assistant
   * child of the head. With `groupTurnId` it joins that round, whose reply the
   * head must be — the next speaker of a round a send or a regenerate opened.
   * Without it, it opens a round of its own: after a reply, the scene goes on
   * without the reader (an "auto" round), and under the reader's turn it answers
   * it. The narrator is not asked here; it has the narration button.
   *
   * It takes what the other generations take of the card's scripts, and checks
   * the head as they do — a head the browser still owes its output scripts is a
   * 409 `post_processing_pending`, so the next speaker's start triggers never run
   * before the last reply is finished.
   */
  app.post('/:id/reply', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const speakerId = optionalSpeakerId(body);
    if (speakerId === undefined) throw badRequest('invalid_request', 'speakerId is required');
    const groupTurnId = body['groupTurnId'];
    if (groupTurnId !== undefined && groupTurnId !== null && (typeof groupTurnId !== 'string' || !isUuid(groupTurnId))) {
      throw badRequest('invalid_request', 'groupTurnId must be a round id');
    }
    const round = (groupTurnId ?? null) as string | null;
    const notLast = optionalBoolean(body, 'finalSpeaker') === false;
    const scripts = readGenerationScripts(body, { startDelta: true });

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> => {
      const chat = await loadWritableChat(deps, id, userId);
      await requireEnabledModel(deps, userId, chat.model);
      const context = await loadGenerationContext(deps, chat, scripts);
      const voice = groupVoiceOf(context, speakerId, { narrator: false });
      const scriptMember = scriptMemberOf(scripts.memberId, context.members);
      const before = buildPath(context.all, chat.headMessageId);
      const head = before.at(-1);
      if (!head) throw badRequest('invalid_state', 'The chat has no messages to reply to');
      if (round !== null && (head.role !== 'assistant' || head.groupTurnId !== round)) {
        throw badRequest('invalid_state', 'The head is not a reply of that round');
      }
      await settleHead(deps, chat, head, scripts, true);
      // What the round answers: the message before its first reply, or the head
      // for a round this reply opens. The reader's turn brings its ruling; a reply
      // means the scene goes on without the reader.
      const answered = round === null ? head : before[roundStart(before) - 1];
      const answersReader = answered?.role === 'user';
      // The reply follows whatever the start triggers left last.
      const edit = scripts.chat
        ? planScriptChat(before, scripts.chat, {
            inPlace: rewritableHead(context.all, head),
            ...(scriptMember ? { memberId: scriptMember.id } : {}),
          })
        : null;
      await keepScriptWrites(deps, chat, context, scripts);
      const edited = edit ? await keepScriptChat(deps, chat, edit, context.all) : null;
      const path = edited ? edited.path : before;
      const end = path.at(-1);
      const memory = await buildMemoryInput(deps, chat, path, path);
      // The turn being answered must be in the prompt, so the end is re-attached
      // when the summary swallowed it.
      const history = memory.history.length > 0 || !end ? memory.history : [end];

      return {
        chatId: chat.id,
        model: chat.model,
        plot: context.plot,
        characters: context.characters,
        personaText: context.personaText,
        userName: context.userName,
        history: await promptHistory(deps, c.get('userId'), chat.model, history, context.scriptSpeaker),
        wholeBranch: path,
        memoryText: memory.memoryText,
        relationshipText: buildRelationshipText(chat),
        authorNote: context.authorNote,
        ...readerPromptSettings(c, chat, context.row),
        ...(context.narrator ? { narrator: context.narrator } : {}),
        ...(answersReader ? { directions: lastUserDirections(path) } : {}),
        preset: getPreset(chat.preset),
        readerAdditions: context.readerAdditions,
        ...startedFrom(pathVariables(context.row, path, context.fold), scripts),
        fold: context.fold,
        globalVariables: context.globalVariables,
        clock: requestClock(c, context.row, path),
        seed: chat.id,
        branch: promptBranch(edited?.all ?? context.all, path, context.firstMessage),
        loreState: loreStateOf(path),
        assetNames: context.assetNames,
        scriptView: context.scriptView,
        localLore: context.localLore,
        auxiliaryModel: context.auxiliaryModel,
        contextBudget: memorySettingsOf(chat).contextBudget,
        ...voicePlan(context, voice, round, notLast, answersReader ? [] : [AUTO_CONTINUE_NUDGE]),
        target: { kind: 'new', parentId: end?.id ?? null },
      };
    });
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
    return c.json(await inspectGeneration(deps, plan, userId, deps.chatgpt?.accounts.forUser(userId)));
  });

  app.post('/:id/continue', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const body = await optionalJsonBody(c);
    const focusIds = optionalMemberIds(body, 'focusCharacterIds') ?? [];
    const scripts = readGenerationScripts(body, { startDelta: true });

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> => {
      const chat = await loadWritableChat(deps, id, userId);
      await requireEnabledModel(deps, userId, chat.model);
      const context = await loadGenerationContext(deps, chat, scripts);
      const focusNames = focusNamesOf(context.onStage, focusIds);
      const before = buildPath(context.all, chat.headMessageId);
      if (before.at(-1)?.role !== 'assistant') {
        throw badRequest('invalid_state', 'The current head is not an assistant message');
      }
      // Its text would go out as the reply being resumed — the AI would read it.
      if (before.at(-1)?.hiddenFromPrompt) {
        throw badRequest('invalid_state', 'The current head is hidden from the AI');
      }
      await settleHead(deps, chat, before.at(-1), scripts, true);
      // What is continued is the message the start triggers left last, as RisuAI
      // continues whatever ends its chat — written in place, so a stored one other
      // branches read is copied first. A chat they left ending on a user turn, or
      // on nothing, has no reply to continue.
      const scriptMember = scriptMemberOf(scripts.memberId, context.members);
      const edit = scripts.chat
        ? planScriptChat(before, scripts.chat, {
            inPlace: rewritableHead(context.all, before.at(-1)),
            ownLast: true,
            ...(scriptMember ? { memberId: scriptMember.id } : {}),
          })
        : null;
      if (edit && edit.lastRole !== 'assistant') {
        throw badRequest('invalid_state', 'The scripts left no assistant message to continue');
      }
      await keepScriptWrites(deps, chat, context, scripts);
      const edited = edit ? await keepScriptChat(deps, chat, edit, context.all) : null;
      const path = edited ? edited.path : before;
      const head = path[path.length - 1]!;
      const memory = await buildMemoryInput(deps, chat, path, path);
      // The partial assistant turn must stay last for the model to resume it, so it
      // is re-attached when the summary swallowed it.
      const history = memory.history.length > 0 ? memory.history : [head];
      // A group reply is continued by whoever said it, while they are on the
      // stage — a round's narration by the narrator; anything else as the scene.
      const group = context.members.length >= 2;
      const speaker = group ? context.onStage.find((member) => member.id === head.speakerMemberId) : undefined;
      const voice = speaker
        ? context.members.indexOf(speaker)
        : group && head.groupTurnId !== null && isNarration(head.content)
          ? NARRATOR_SPEAKER
          : undefined;

      return {
        chatId: chat.id,
        model: chat.model,
        plot: context.plot,
        characters: context.characters,
        personaText: context.personaText,
        userName: context.userName,
        history: await promptHistory(deps, c.get('userId'), chat.model, history, context.scriptSpeaker),
        // The head being continued is in the chat, as RisuAI's continue keeps it there.
        wholeBranch: path,
        memoryText: memory.memoryText,
        relationshipText: buildRelationshipText(chat),
        authorNote: context.authorNote,
        ...readerPromptSettings(c, chat, context.row),
        ...(context.narrator ? { narrator: context.narrator } : {}),
        // Continue finishes the reply to the last user turn, so that turn's ruling
        // is still the one in force. Auto-continue, below, is a beat past it.
        directions: lastUserDirections(path),
        preset: getPreset(chat.preset),
        readerAdditions: context.readerAdditions,
        // The prompt reads the whole branch, head included; the head's new delta
        // is measured from the branch before it, since the continue rewrites it.
        ...startedFrom(pathVariables(context.row, path, context.fold), scripts),
        turnBase: pathVariables(context.row, path.slice(0, -1), context.fold),
        fold: context.fold,
        globalVariables: context.globalVariables,
        clock: requestClock(c, context.row, path),
        seed: chat.id,
        branch: promptBranch(edited?.all ?? context.all, path, context.firstMessage),
        // The message being generated is the head itself, so the branch before it
        // is what it was first generated on — its own record must not read as a
        // trigger from the turn before.
        loreState: loreStateOf(path.slice(0, -1)),
        assetNames: context.assetNames,
        scriptView: context.scriptView,
        localLore: context.localLore,
        auxiliaryModel: context.auxiliaryModel,
        contextBudget: memorySettingsOf(chat).contextBudget,
        focusNames,
        // The message keeps its own speaker and round; only the names its own
        // prefixes come off by, and whose scripts run, travel.
        ...(voice !== undefined ? { speaker: voice } : {}),
        ...(speaker ? { speakerNames: speakerNamesOf(speaker), scriptView: context.scriptViewFor(speaker) } : {}),
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
    const body = await optionalJsonBody(c);
    const focusIds = optionalMemberIds(body, 'focusCharacterIds') ?? [];
    const scripts = readGenerationScripts(body, { startDelta: true });

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> => {
      const chat = await loadWritableChat(deps, id, userId);
      await requireEnabledModel(deps, userId, chat.model);
      const context = await loadGenerationContext(deps, chat, scripts);
      const focusNames = focusNamesOf(context.onStage, focusIds);
      const before = buildPath(context.all, chat.headMessageId);
      if (before.at(-1)?.role !== 'assistant') {
        throw badRequest('invalid_state', 'The current head is not an assistant message');
      }
      await settleHead(deps, chat, before.at(-1), scripts, true);
      // The reply follows whatever the start triggers left last.
      const scriptMember = scriptMemberOf(scripts.memberId, context.members);
      const edit = scripts.chat
        ? planScriptChat(before, scripts.chat, {
            inPlace: rewritableHead(context.all, before.at(-1)),
            ...(scriptMember ? { memberId: scriptMember.id } : {}),
          })
        : null;
      await keepScriptWrites(deps, chat, context, scripts);
      const edited = edit ? await keepScriptChat(deps, chat, edit, context.all) : null;
      const path = edited ? edited.path : before;
      const head = path.at(-1);
      const memory = await buildMemoryInput(deps, chat, path, path);
      // The scene to continue must be in the prompt, so the head is re-attached
      // when the summary swallowed it.
      const history = memory.history.length > 0 || !head ? memory.history : [head];

      return {
        chatId: chat.id,
        model: chat.model,
        plot: context.plot,
        characters: context.characters,
        personaText: context.personaText,
        userName: context.userName,
        history: await promptHistory(deps, c.get('userId'), chat.model, history, context.scriptSpeaker),
        wholeBranch: path,
        memoryText: memory.memoryText,
        relationshipText: buildRelationshipText(chat),
        authorNote: context.authorNote,
        ...readerPromptSettings(c, chat, context.row),
        ...(context.narrator ? { narrator: context.narrator } : {}),
        preset: getPreset(chat.preset),
        readerAdditions: context.readerAdditions,
        ...startedFrom(pathVariables(context.row, path, context.fold), scripts),
        fold: context.fold,
        globalVariables: context.globalVariables,
        clock: requestClock(c, context.row, path),
        seed: chat.id,
        branch: promptBranch(edited?.all ?? context.all, path, context.firstMessage),
        loreState: loreStateOf(path),
        assetNames: context.assetNames,
        scriptView: context.scriptView,
        localLore: context.localLore,
        auxiliaryModel: context.auxiliaryModel,
        contextBudget: memorySettingsOf(chat).contextBudget,
        focusNames,
        trailingSystem: applyMacros(AUTO_CONTINUE_NUDGE, {
          char: context.plot.char ?? context.plot.name,
          user: context.userName,
        }),
        // A child of the assistant head: two assistant turns in a row, which the
        // adapters merge for providers that require alternating roles.
        target: { kind: 'new', parentId: head?.id ?? null },
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
    const body = await optionalJsonBody(c);
    const focusIds = optionalMemberIds(body, 'focusCharacterIds') ?? [];
    const scripts = readGenerationScripts(body, { startDelta: true });

    return withGenerationSlot(c, deps, id, async (): Promise<GenerationPlan> => {
      const chat = await loadWritableChat(deps, id, userId);
      await requireEnabledModel(deps, userId, chat.model);
      const context = await loadGenerationContext(deps, chat, scripts);
      const focusNames = focusNamesOf(context.onStage, focusIds);
      const before = buildPath(context.all, chat.headMessageId);
      if (!before.at(-1)) throw badRequest('invalid_state', 'The chat has no messages to narrate from');
      await settleHead(deps, chat, before.at(-1), scripts, true);
      // The narration follows whatever the start triggers left last.
      const scriptMember = scriptMemberOf(scripts.memberId, context.members);
      const edit = scripts.chat
        ? planScriptChat(before, scripts.chat, {
            inPlace: rewritableHead(context.all, before.at(-1)),
            ...(scriptMember ? { memberId: scriptMember.id } : {}),
          })
        : null;
      await keepScriptWrites(deps, chat, context, scripts);
      const edited = edit ? await keepScriptChat(deps, chat, edit, context.all) : null;
      const path = edited ? edited.path : before;
      const head = path.at(-1);
      const memory = await buildMemoryInput(deps, chat, path, path);
      // The scene to narrate must be in the prompt, so the head is re-attached
      // when the summary swallowed it.
      const history = memory.history.length > 0 || !head ? memory.history : [head];

      return {
        chatId: chat.id,
        model: chat.model,
        plot: context.plot,
        characters: context.characters,
        personaText: context.personaText,
        userName: context.userName,
        history: await promptHistory(deps, c.get('userId'), chat.model, history, context.scriptSpeaker),
        wholeBranch: path,
        memoryText: memory.memoryText,
        relationshipText: buildRelationshipText(chat),
        authorNote: context.authorNote,
        ...readerPromptSettings(c, chat, context.row),
        ...(context.narrator ? { narrator: context.narrator } : {}),
        preset: getPreset(chat.preset),
        readerAdditions: context.readerAdditions,
        ...startedFrom(pathVariables(context.row, path, context.fold), scripts),
        fold: context.fold,
        globalVariables: context.globalVariables,
        clock: requestClock(c, context.row, path),
        seed: chat.id,
        branch: promptBranch(edited?.all ?? context.all, path, context.firstMessage),
        loreState: loreStateOf(path),
        assetNames: context.assetNames,
        scriptView: context.scriptView,
        localLore: context.localLore,
        auxiliaryModel: context.auxiliaryModel,
        contextBudget: memorySettingsOf(chat).contextBudget,
        focusNames,
        trailingSystem: applyMacros(NARRATION_NUDGE, {
          char: context.plot.char ?? context.plot.name,
          user: context.userName,
        }),
        narration: true,
        // In a work of several members the narration is the narrator's turn: it
        // ends the round the head is a reply of, joining it, or opens one of its
        // own — under the reader's turn, or a reply in no round. Its prompt is the
        // scene's, stopped where it starts on a member's line.
        ...(context.members.length >= 2
          ? {
              speaker: NARRATOR_SPEAKER,
              round: {
                speakerMemberId: null,
                groupTurnId: head?.role === 'assistant' ? head.groupTurnId : null,
              },
            }
          : {}),
        target: { kind: 'new', parentId: head?.id ?? null },
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
          subModel: chat.subModel,
          recent: visibleToAi(buildPath(context.all, chat.headMessageId)),
          members: context.members,
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
        const chat = await loadWritableChat(deps, id, userId);
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
            visibleToAi(path),
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
 * writes the prefix as well is deduplicated on the way in, and one that slips
 * into a member's line is cut there (`narrationKept` in generation.ts).
 *
 * The rules are the ones the services before us learned the hard way: a
 * narrator that may say anything about the scene says things about the reader
 * too — decides what they do, restates what they wrote, overrules it — and is
 * read as the system's own voice when it does. So the reader's half is kept
 * theirs, said as what to do with it where that can be said. The length is
 * shorter than a reply's, whatever the plot's length setting says (its cap is
 * `NARRATION_MAX_TOKENS`), and one register runs through the whole of it.
 * The same particle rule as the presets: nothing allomorphic after a macro.
 */
export const NARRATION_NUDGE = `(다음 응답은 {{char}}의 등장인물이 말하거나 움직이는 장면이 아니라 나레이터의 장면 서술만 출력한다. 접두사 없는 줄로만 쓰고, 서술 문체·서술 시점 설정이 있으면 따른다.
- 직전 메시지를 지금 이 순간으로 삼아, 거기서 이어지는 장면과 세계의 변화, 다른 인물들이 겉으로 보이는 움직임, 공기와 분위기를 쓴다. 이미 묘사한 날씨나 분위기를 되풀이하지 말고 새로 달라진 것을 보여 준다.
- {{user}}의 말과 행동은 이미 일어난 일로 두고, 그 결과로 달라진 주변과 인물들의 반응을 쓴다. {{user}}의 행동·감정·생각·다음 움직임은 서술하지도 정하지도 않고 {{user}}의 몫으로 남겨 둔다.
- {{user}}의 글을 다시 옮겨 적거나 인용하지 않고, 그 내용을 부정하거나 뒤집지 않는다. 인물들과 {{user}}에 대해 평가나 판정을 내리지 않는다.
- 유저나 등장인물의 대사를 만들지 않는다.
- 응답 길이 설정과 상관없이 1~2문단, 모두 여섯 문장 안쪽으로 짧게 쓴다.
- 종결어미는 처음부터 끝까지 한 가지로 맞춘다. 서술 문체가 정한 어미가 있으면 그것을, 없으면 이 대화의 지난 서술이 쓴 어미를 따르고, 반말과 존댓말을 섞지 않는다.)`;

/**
 * For a group round's speakers before the last: the round ends on the last
 * reply, and the status window and the choices are what it closes on. Appended
 * to the prompt, never persisted — and only where the chat has either.
 */
const NOT_LAST_SPEAKER_NUDGE =
  '(이 응답 뒤에 다른 인물이 이어서 답한다. 이번 응답에는 상태창과 선택지를 붙이지 않는다)';

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
    if (row.chat.importing) throw chatImporting();

    if (row.message.role === 'assistant') {
      // One transaction: the edit and the memory invalidation it forces must not be
      // observable apart, or a refresh could snapshot the old text and still win.
      const dropped = await deps.db.transaction(async (tx) => {
        await tx
          .update(messages)
          // The delta stays: it holds the values the scripts set, not a reading of
          // the text. The revision moves, so a script commit computed on the old
          // text cannot land on top of the reader's own words.
          .set({ content, scriptRev: sql`${messages.scriptRev} + 1` })
          .where(eq(messages.id, id));
        return invalidateMemoryForEdit(tx, row.chat.id, id);
      });
      // The summary that covered the old words is gone; the new ones are summarized again.
      if (dropped > 0) scheduleMemoryUpdate(deps, row.chat.id);
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
        // The scripts that ran for the turn are not run again for an edit of it —
        // RisuAI never re-runs a trigger on one either — so what they left stays.
        ...(row.message.variableDelta ? { variableDelta: row.message.variableDelta } : {}),
        // A new version of the same turn: still hidden from the AI if it was.
        ...(row.message.hiddenFromPrompt ? { hiddenFromPrompt: true } : {}),
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
