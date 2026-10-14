import {
  applyMacros,
  applyVariableDelta,
  assemblePrompt,
  characterName,
  computeVariables,
  countTokens,
  diffVariables,
  emotionScreenOf,
  inlayEmotionTags,
  narrationBody,
  narrationUntilSpeech,
  replyLanguageInstruction,
  replyLengthTokens,
  sceneFocusDirective,
  spokenBy,
  stripInlayMacros,
  stripSpeakerPrefix,
  withBranchGreeting,
  withNarrationPrefix,
  type AssembledPrompt,
  type AuthorNoteSettings,
  type TranslationLanguage,
  type FoldItem,
  type FoldOptions,
  type HistoryMessage,
  type LoreEntry,
  type LoreTimedState,
  type MacroClock,
  type NarratorConfig,
  type NarratorSpeaker,
  type Preset,
  type PromptBranch,
  type PromptCharacter,
  type PromptPlot,
  type PromptReport,
  type ReaderAdditions,
  type VariableDelta,
  type Variables,
} from '@shizue/core';
import { promptScriptJob, promptScriptsOf } from '@shizue/core/prompt-scripts';
import {
  cardScripts,
  checkScriptChat,
  hasTriggersFor,
  luaScriptsOf,
  overlayName,
  risuLore,
  scriptChatOf,
  scriptedMember,
  upsertLocalLore,
  type CardScripts,
  type MemberOverlay,
  type TriggerMessage,
  type TriggerRunInput,
} from '@shizue/core/triggers';
import { chats, messages, type Chat, type Message } from '@shizue/db';
import { ChatGPTError, getAdapter, getModel, supportsVision, type ChatGPTAccount, type LLMAdapter } from '@shizue/llm';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { withImageNote } from './attachments.js';
import { ApiError, badRequest, notFound } from './errors.js';
import type { AppDeps, AppEnv, Tx } from './deps.js';
import { invalidateMemoryForEdit, noteRequestOverhead, scheduleMemoryUpdate } from './memory.js';
import { runPromptScriptJob } from './regexWorker.js';
import { scheduleRelationshipUpdate } from './relationship.js';
import { replyMemberOf, scheduleEmotionDetection } from './emotion.js';
import {
  characterImage,
  editRequestLua,
  luaStateHash,
  luaStateKey,
  luaStates,
  type ListenerEdits,
  type LuaCharacterRewrite,
  type RequestLuaInput,
} from './requestLua.js';
import { editRequestTurns, refitRequest, RequestTooLongError, withEditedRequest, type EditedTurn } from './requestTriggers.js';
import { applyScriptChat, planScriptChat, rewritableHead } from './scriptChat.js';
import {
  MAX_OVERLAY_TEXT_LENGTH,
  mergeReaderOverlay,
  readLocalLore,
  storableDelta,
  type PromptInjections,
} from './scriptState.js';
import { unlockAssets } from './unlocks.js';
import { scheduleMessageEmbedding, searchByMeaning, type VectorPlan } from './vectors.js';

/**
 * The fire-and-forget jobs a completed assistant turn starts. They own separate
 * per-chat guards and never block each other.
 *
 * A turn stored `pending` starts them only once the browser commits what its
 * output scripts made of it (`script-commit`): run on the raw text, the summary
 * would be built on words the commit is about to replace, and the commit's own
 * edit would throw it away again.
 */
export function scheduleBackgroundUpdates(deps: AppDeps, chatId: string, reply?: string): void {
  scheduleMemoryUpdate(deps, chatId);
  scheduleRelationshipUpdate(deps, chatId);
  // The chat's retrieval searches the branch with the reply in it from the next turn on.
  scheduleMessageEmbedding(deps, chatId);
  // The emotion picture `reply` leaves its member wearing — only for a reply that
  // finished: RisuAI chooses none for one the reader stopped.
  if (reply !== undefined) scheduleEmotionDetection(deps, chatId, reply);
}

/** Where the generated text ends up. */
type GenerationTarget =
  | { kind: 'new'; parentId: string | null }
  /** Continue: text is appended to an existing assistant message in place. */
  | { kind: 'continue'; message: Message };

export interface GenerationPlan {
  chatId: string;
  model: string;
  /** The work this chat belongs to, as the assembler reads it. */
  plot: PromptPlot;
  /** Its roster, in the creator's order. May be empty. */
  characters: PromptCharacter[];
  personaText: string;
  userName: string;
  /** Branch messages, oldest first, that the model should see. */
  history: HistoryMessage[];
  /**
   * The whole branch the turn is generated on, as stored, oldest first — the
   * one `branch` measures, and a continue's head with it. What the card's
   * request triggers read as the chat, as RisuAI's read the chat it holds when
   * the request goes out: not `history`, which the memory trims.
   */
  wholeBranch: Message[];
  /** The memory block: the summaries selected for the turns no longer in `history`. */
  memoryText: string;
  /** Relationship state block, empty when the chat has none or turned it off. */
  relationshipText: string;
  /** The chat's author note, injected at its depth (`AUTHOR_NOTE_DEPTH` unless the chat sets one). */
  authorNote: string;
  /** The chat's author's-note settings — depth, frequency, role; absent, the defaults. */
  authorNoteSettings?: AuthorNoteSettings;
  /**
   * The language the reply is asked for, in the `instruct` language mode: a
   * system line after everything else (`replyLanguageInstruction`), which no
   * card's post-history instructions replace.
   */
  replyLanguage?: TranslationLanguage;
  /**
   * The narrator in force for this chat: its own override where it set one, the
   * plot's otherwise. Absent means neither declared one.
   */
  narrator?: NarratorConfig;
  /**
   * Stage directions of the user turn being answered, if it carries any. Assembled
   * outside the cached system prefix, and never part of the history text.
   */
  directions?: string;
  /**
   * Chat variables derived from the branch this turn generates on: the folded
   * `{{setvar}}` macros of its messages, and the deltas their scripts left, over
   * the plot's defaults — with this request's `startDelta` on top. Only
   * `{{getvar::k}}` reads them; the macros themselves stay in the history.
   */
  variables: Variables;
  /**
   * The state the stored turn's own macros fold onto, before the start triggers
   * wrote anything: the parent's for a new turn, the head's parent's for a
   * continue, which rewrites the head. What `generatedDelta` measures against.
   */
  turnBase: Variables;
  /**
   * The names the chat's folds answer `{{user}}` and `{{char}}` with — the ones
   * `variables` and `turnBase` were folded with, so the stored turn's delta is
   * measured the same way.
   */
  fold: FoldOptions;
  /** The reader's global variables on this plot, for `{{getglobalvar}}`. */
  globalVariables: Variables;
  /**
   * Where `history` sits on the branch the turn is generated on, for RisuAI's
   * chat functions and the draw `{{pick}}` makes. For a continue it counts the
   * head being continued, which the assembler is not handed.
   */
  branch: PromptBranch;
  /**
   * What the card's start triggers changed, in the reader's browser, before this
   * generation — a regenerate, a continue, an auto turn or a narration. A send
   * has none: the triggers ran for the user turn, and their writes are on it.
   */
  startDelta?: VariableDelta;
  /**
   * The text the start triggers asked to put in the prompt, by place — RisuAI's
   * three, which the assembler places (`PromptInjections` in @shizue/core).
   */
  injections?: PromptInjections;
  /**
   * The browser will run the card's output scripts over the reply and commit
   * the result, so the turn is stored `pending` and its background work waits
   * for that commit (`scheduleBackgroundUpdates`).
   */
  postProcess?: boolean;
  /** The reader's clock, for the time macros (see `requestClock`). */
  clock: MacroClock;
  /** What `{{pick}}` draws from on this chat: its id, with the branch's length. */
  seed: string;
  /**
   * The lore records of the branch the turn is generated on, for the timed
   * effects — taken from the whole branch, not the history the budget kept.
   */
  loreState: LoreTimedState;
  /** The names this chat's open images go by, for `{{assetlist}}` (see `openAssetNames`). */
  assetNames: string[];
  /** The chat's auxiliary model, for `{{axmodel}}` (see `auxiliaryModelOf`). */
  auxiliaryModel: string;
  /**
   * What the scripted member's Lua reads that the prompt does not carry, as the
   * browser's reads it (`GET /:id/scripts`, the chat's own note): for the
   * `editRequest` listeners the server runs (`requestLuaInput`). Absent without
   * a scripted member.
   */
  scriptView?: ScriptView;
  /**
   * The chat's own lore (`chats.local_lore`, RisuAI's chat `localLore`): what the
   * card's Lua upserted in this chat. Activated after the scripted member's book,
   * as RisuAI activates `globalLore.concat(localLore)` — and kept apart from
   * `characters`, whose books the request triggers' lore effects read alone.
   */
  localLore?: LoreEntry[];
  /**
   * What SillyTavern's vector storage searches with (`vectors.ts`): the plot and
   * its language, which picks the model, and whether the chat's retrieval is on.
   * Absent: no search, lore by keyword only.
   */
  vectors?: VectorPlan;
  /** The chat's prompt preset. */
  preset: Preset;
  /** The reader's own preset on top of it (`chats.reader_preset_id`), if the chat picked one. */
  readerAdditions?: ReaderAdditions | undefined;
  /** Context budget this chat runs with (see memorySettings). */
  contextBudget: number;
  /**
   * System instruction appended after everything else, for a turn the user did not
   * ask for by hand (auto-continue). It is never stored, so it lives on the plan
   * rather than in the history.
   */
  trailingSystem?: string;
  /**
   * Members the reader asked this one reply to center on, by name. Like the
   * trailing instruction it rides at the very end of the prompt and is stored
   * nowhere — the next turn is back to the scene deciding who speaks.
   */
  focusNames?: string[];
  /**
   * This turn is the narrator's, not a character's: the text is stored under the
   * narration prefix so every reader of the branch — the renderer, the prompt, the
   * sidecar models — reads it back as the scene moving. Only a new message can be
   * one; continuing a narration appends to text that already carries the prefix.
   */
  narration?: boolean;
  /**
   * Who a group turn's reply is asked of (@shizue/core `group.ts`): an index into
   * `characters`, or the narrator. Absent is the scene, as every reply was before
   * group turns — and every reply of a work of one member still is.
   */
  speaker?: number | NarratorSpeaker;
  /**
   * The names a member speaker's own `이름: ` prefixes go by — its name in this
   * chat, then its nickname — taken off what it writes before it is stored
   * (`stripSpeakerPrefix`): the reply is the member's whole.
   */
  speakerNames?: string[];
  /**
   * Where a new group reply is stored: its speaker (null for the narrator) and
   * its round — null opens a new one under the reply's own id. Absent for a
   * scene reply, and for a continue, whose message keeps its own.
   */
  round?: { speakerMemberId: string | null; groupTurnId: string | null };
  target: GenerationTarget;
}

/** `GenerationPlan.scriptView`. */
export interface ScriptView {
  /** The member whose scripts run — the speaker of a group turn, else the scripted member — whose card the listeners' rewrites are of. */
  memberId: string;
  /** The chat's own note, as this request's scripts left it — not the attached notes the prompt adds. */
  note: string;
  /** The first message this chat's scripts set (`setCharacterFirstMessage`). */
  firstMessage?: string;
  /** The background as the overlay has it, else the card's `backgroundHTML`, whole. */
  backgroundHtml: string;
  /** The member's avatar, a same-origin address, or null. */
  avatarUrl: string | null;
  /** The chat's persona's picture, a same-origin address, or null — Lua's `getPersonaImage`. */
  personaAvatarUrl: string | null;
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** A request as it is sent, with what the `editRequest` listeners did besides it, for the reply to keep. */
type BuiltRequest = AssembledPrompt & { listenerEdits?: ListenerEdits };

/**
 * How long a claim stands on its own. The running stream renews it on every
 * heartbeat, so only an instance that died mid-generation leaves one behind — and
 * that one is taken over two minutes later instead of wedging the chat forever.
 */
const CLAIM_STALE_MS = 2 * 60_000;

/** How often an open stream says something, and renews its claim while at it. */
export const HEARTBEAT_MS = 15_000;

/**
 * Takes the chat's generation slot for the caller. A single guarded UPDATE decides
 * it, so two API instances racing on the same chat cannot both win; the in-process
 * set in front of it is only a fast path for the same instance's double-clicks.
 *
 * False means the slot is held — including by a request that is only *about* to
 * find out the chat is not the caller's, which is why callers check ownership
 * before they report a busy chat.
 */
export async function acquireChatSlot(deps: AppDeps, chatId: string, userId: string): Promise<boolean> {
  if (deps.generating.has(chatId)) return false;
  deps.generating.add(chatId);
  try {
    const claimed = await deps.db
      .update(chats)
      .set({ generatingAt: new Date() })
      .where(
        and(
          eq(chats.id, chatId),
          eq(chats.userId, userId),
          or(isNull(chats.generatingAt), lt(chats.generatingAt, new Date(Date.now() - CLAIM_STALE_MS))),
        ),
      )
      .returning({ at: chats.generatingAt });
    if (!claimed[0]?.at) {
      deps.generating.delete(chatId);
      return false;
    }
    // What the row actually holds, not what we sent: it is the identity renewal
    // and release compare against, so it has to be the stored value.
    deps.generationClaims.set(chatId, { at: claimed[0].at, renewing: null });
    return true;
  } catch (error) {
    // The fast path was taken before the UPDATE was tried, so a failure here would
    // otherwise leave this instance answering 429 for a chat nothing is generating
    // on — for as long as the process lives.
    deps.generating.delete(chatId);
    throw error;
  }
}

/**
 * Whether a generation is running on this chat right now, read off the claim
 * rather than taken. For callers that write nothing and only have to stand back
 * while a stream runs — taking the slot would make them block the reader's next
 * turn instead. A claim older than the staleness window belongs to an instance
 * that died, and reading it as busy would wedge the chat.
 */
export const isGenerating = (chat: Chat): boolean =>
  chat.generatingAt !== null && chat.generatingAt.getTime() > Date.now() - CLAIM_STALE_MS;

/**
 * Gives the slot back. Idempotent: releasing a chat that holds none is a no-op —
 * and so is releasing one whose claim was taken over meanwhile, because the
 * column is only cleared where it still carries the claim this instance wrote.
 *
 * A renewal still in flight is waited out first: it may be advancing the row's
 * timestamp this very moment, and clearing with the identity it replaces would
 * miss — leaving a finished chat claimed until the staleness window let it go.
 */
export async function releaseChatSlot(deps: AppDeps, chatId: string): Promise<void> {
  const handle = deps.generationClaims.get(chatId);
  // Locally it is over whatever the row says, so the fast path never outlives the
  // request that took it.
  deps.generating.delete(chatId);
  if (!handle) return;
  if (handle.renewing) {
    try {
      await handle.renewing;
    } catch {
      // The renewal's own failure was already logged; the release still runs.
    }
  }
  deps.generationClaims.delete(chatId);
  await deps.db
    .update(chats)
    .set({ generatingAt: null })
    .where(and(eq(chats.id, chatId), eq(chats.generatingAt, handle.at)));
}

/**
 * Renews the claim so a generation slower than the staleness window keeps it.
 *
 * Compare-and-set on the claim this instance wrote: a stream that ran long enough
 * for another instance to declare it dead and take the chat over must not steal it
 * back mid-answer. Losing the race is said once and stops the renewals, so the
 * heartbeat goes quiet instead of arguing with the new holder every fifteen
 * seconds.
 *
 * One renewal in flight at a time: a second heartbeat landing while the first is
 * still talking to the database joins it instead of racing it — two CAS's off the
 * same remembered timestamp would have one advance the row and the other read its
 * own miss as a takeover and stop the heartbeat on a live stream.
 */
export function renewChatSlot(deps: AppDeps, chatId: string): Promise<void> {
  const handle = deps.generationClaims.get(chatId);
  if (!handle) return Promise.resolve();
  if (handle.renewing) return handle.renewing;
  const work = (async (): Promise<void> => {
    try {
      const [renewed] = await deps.db
        .update(chats)
        .set({ generatingAt: new Date() })
        .where(and(eq(chats.id, chatId), eq(chats.generatingAt, handle.at)))
        .returning({ at: chats.generatingAt });
      // Only this claim's own handle is ever written to: if the slot was released
      // (or released and re-acquired) while the renewal was in flight, the map
      // entry is no longer ours to touch.
      if (deps.generationClaims.get(chatId) !== handle) return;
      if (!renewed?.at) {
        deps.generationClaims.delete(chatId);
        console.warn('[api] generation claim was taken over; stopping renewal', chatId);
        return;
      }
      handle.at = renewed.at;
    } catch (error) {
      // A failed renewal only risks the claim being taken over later; it must never
      // tear down the stream that is already producing text.
      console.error('[api] generation claim renewal failed', error);
    } finally {
      handle.renewing = null;
    }
  })();
  handle.renewing = work;
  return work;
}

/**
 * The 429 a caller gets for a chat that is already generating. Ownership is
 * re-checked first so another user's chat stays a 404 rather than leaking that it
 * exists and is busy.
 */
export async function rejectBusyChat(deps: AppDeps, chatId: string, userId: string): Promise<never> {
  const [owned] = await deps.db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  if (!owned) throw notFound('Chat not found');
  throw new ApiError(429, 'generation_in_progress', 'A generation is already running for this chat');
}

/**
 * Acquires the chat's generation slot, builds the plan, and streams. The slot is
 * held until the SSE response is done so a second request gets 429 meanwhile.
 */
export async function withGenerationSlot(
  c: Context<AppEnv>,
  deps: AppDeps,
  chatId: string,
  build: () => Promise<GenerationPlan>,
): Promise<Response> {
  const userId = c.get('userId');
  if (!(await acquireChatSlot(deps, chatId, userId))) await rejectBusyChat(deps, chatId, userId);

  let plan: GenerationPlan;
  try {
    plan = await build();
  } catch (error) {
    await releaseChatSlot(deps, chatId);
    throw error;
  }
  return runGeneration(c, deps, plan, () => releaseChatSlot(deps, chatId));
}

/**
 * The history a model without vision is given: the images are dropped and the
 * turn says that it carried them.
 *
 * Sending an image part to a text-only model is an upstream error, not a graceful
 * degradation, so the choice is between refusing the send and answering without
 * having seen the picture. The note is what keeps the second honest — the reply
 * can acknowledge an image it was not shown rather than ignoring a turn that
 * looks empty. A chat whose turns carry no images is untouched.
 */
async function withoutUnseeableImages(history: HistoryMessage[], model: string, deps: AppDeps, account?: ChatGPTAccount): Promise<HistoryMessage[]> {
  if (!history.some((turn) => turn.images?.length) || await supportsVision(model, deps.env, account)) return history;
  return history.map((turn) => {
    if (!turn.images?.length) return turn;
    const { images, ...rest } = turn;
    return {
      ...rest,
      content: withImageNote(turn.content, images.length),
      ...(turn.promptContent !== undefined
        ? { promptContent: withImageNote(turn.promptContent, images.length) }
        : {}),
    };
  });
}

/**
 * The history with what the cards' prompt scripts make of it: RisuAI's
 * `editprocess` and SillyTavern's prompt-only regex, read off every member's
 * card in roster order — a member sent off the stage too, since the history
 * they rewrite is still the work's. Each turn they change carries the result as
 * its `promptContent`; the stored turns, and what the lore scans, stay as they
 * are. The macros a script's pattern is matched with are expanded here, for the
 * card it is on; everything else of a script runs in the pool's threads, which
 * bound it (`regexWorker.ts`).
 */
async function withPromptScripts(
  history: HistoryMessage[],
  plan: GenerationPlan,
  branch: PromptBranch,
): Promise<HistoryMessage[]> {
  if (history.length === 0) return history;
  // The work's modules after every card, once — RisuAI's `processScript` runs
  // the character's `customscript` and then the modules' regex — read as the
  // first member's, the work's stand-in.
  const modules = (plan.plot.modules ?? []).map((module) => ({ extensions: { risuai: { customScripts: module.regex } } }));
  const charOf = (index: number): string => {
    const member = plan.characters[index] ?? plan.characters[0];
    return member ? characterName(member) : plan.plot.name;
  };
  const scripts = promptScriptsOf([...plan.characters.map((member) => member.card), ...modules], (text, index) =>
    applyMacros(text, {
      char: charOf(index),
      user: plan.userName,
      variables: plan.variables,
      globalVariables: plan.globalVariables,
    }),
  );
  if (scripts.length === 0) return history;
  const texts = await runPromptScriptJob(promptScriptJob(history, scripts, branch));
  return history.map((turn, index) =>
    texts[index] === undefined || texts[index] === turn.content ? turn : { ...turn, promptContent: texts[index] },
  );
}

/**
 * What a generation sends — or, with `report`, measures for the creator's
 * inspector: the prompt as it is put together, then as the card's scripts
 * leave the request in RisuAI's order — its Lua `editRequest` listeners, which
 * `sendChat` runs once the request is put together (`requestLua.ts`), then its
 * request triggers, which `requestChatData` runs just before sending
 * (`requestTriggers.ts`). The chat variables the listeners wrote are the
 * triggers' to read, and the generated turn's to keep, as is what else they did
 * (`listenerEdits`). The listeners' state's globals are put back from the
 * reader's last generation with that card's Lua, in whichever of their chats
 * and works, and a generation keeps them for the next (`LuaStateStore`,
 * `luaStateKey`); the inspector reads them and keeps nothing.
 */
async function buildRequestMessages(
  plan: GenerationPlan,
  deps: AppDeps,
  reader: string,
  account?: ChatGPTAccount,
  report = false,
): Promise<BuiltRequest> {
  const prompt = await assembleRequest(plan, deps, account, report);
  // How much history fits beside the rest of this request is what the memory
  // summarizes against (§7.3); the inspector's look changes nothing.
  if (!report && prompt.fixedTokens !== undefined) noteRequestOverhead(plan.chatId, prompt.fixedTokens);
  const lua = requestLuaInput(plan);
  const triggers = requestTriggerInput(plan);
  if (!lua && !triggers) return prompt;
  const label = plan.chatId;
  const listened: { writes: VariableDelta | null; edits: ListenerEdits | null } = { writes: null, edits: null };
  const edited = await withEditedRequest(
    prompt,
    async (items) => {
      let request: EditedTurn[] | null = null;
      if (lua) {
        const states = deps.luaStates ?? luaStates;
        const key = luaStateKey(reader, lua.scripts);
        const kept = states.get(key);
        // RisuAI's one state holds the code it ran last: the next run's first script finds it only if it is that code.
        const restore = kept && kept.hash === luaStateHash(lua.scripts[0]!) ? kept.state : undefined;
        const keep = { ...(restore !== undefined ? { restore } : {}), ...(report ? {} : { capture: true }) };
        const result = await editRequestLua(items, { ...lua, keep }, { run: deps.runRequestLua, label });
        listened.writes = result.writes;
        if (!report) {
          listened.edits = result.edits;
          if (result.state === null) states.delete(key);
          else if (result.state !== undefined) states.set(key, { hash: luaStateHash(lua.scripts.at(-1)!), state: result.state });
        }
        // RisuAI fits the request to the context again once its listeners left
        // it, before the request triggers see it (`refitRequest`) — after the
        // state is kept, as RisuAI's outlives a request it then refuses.
        request = result.turns && refitRequest(result.turns, plan.contextBudget);
      }
      if (triggers) {
        const input = { ...triggers, variables: applyVariableDelta(triggers.variables, listened.writes) };
        request = (await editRequestTurns(request ?? items, input, { run: deps.runRequestTriggers, label })) ?? request;
      }
      return request;
    },
    label,
  );
  const { writes, edits } = listened;
  return {
    ...edited,
    ...(writes ? { variableWrites: { ...edited.variableWrites, ...writes } } : {}),
    ...(edits ? { listenerEdits: edits } : {}),
  };
}

/**
 * The member whose card the request's scripts are of: a group turn's member
 * speaker — whose scripts alone run, as RisuAI runs the character it asks
 * (`sendChat(index)`), so nothing runs for one that carries none — and for
 * everything else, the narrator's turn included, the scripted member
 * (`scriptedMember`). Null when that member carries no scripts.
 */
export function requestScriptsOf(
  plan: Pick<GenerationPlan, 'characters' | 'speaker' | 'plot'>,
): { member: PromptCharacter; scripts: CardScripts } | null {
  // The work's modules run after whichever card's do, as RisuAI's run the
  // character it asks's triggers and then the modules' (`cardScripts`).
  const modules = plan.plot.modules ?? [];
  if (typeof plan.speaker !== 'number') return scriptedMember(plan.characters, modules);
  const member = plan.characters[plan.speaker];
  const scripts = member ? cardScripts(member.card, modules) : null;
  return member && scripts ? { member, scripts } : null;
}

/**
 * What the card's `editRequest` listeners run with, or null for a plot whose
 * scripted member has none — read off its Lua's text, as the browser decides
 * which hooks a script has, so a plot without them spawns nothing. Every Lua
 * script on the card runs, in trigger order, as RisuAI runs them. What they read
 * is what the browser hands its sandbox (web `lua/engine.ts`, `snapshotOf`):
 * the member as the request triggers have it, the whole branch, and
 * `scriptView`'s note, first message, background, avatar and persona picture.
 */
export function requestLuaInput(
  plan: Pick<
    GenerationPlan,
    | 'characters'
    | 'wholeBranch'
    | 'branch'
    | 'personaText'
    | 'userName'
    | 'variables'
    | 'globalVariables'
    | 'scriptView'
    | 'localLore'
    | 'speaker'
    | 'plot'
    | 'clock'
    | 'seed'
    | 'assetNames'
  >,
): Omit<RequestLuaInput, 'request'> | null {
  const found = requestScriptsOf(plan);
  if (!found) return null;
  const scripts = luaScriptsOf(found.scripts.triggers);
  if (!/\beditRequest\b/.test(scripts.join('\n'))) return null;
  const { member } = found;
  const view = plan.scriptView;
  return {
    scripts,
    snapshot: {
      vars: Object.entries(plan.variables),
      globals: Object.entries(plan.globalVariables),
      messages: plan.wholeBranch.slice(plan.branch.greeting ? 1 : 0).map((message) => ({
        role: message.role === 'user' ? 'user' : 'char',
        data: message.content,
        time: message.createdAt.getTime(),
      })),
      char: {
        name: member.name,
        nickname: member.card.nickname?.trim() ?? '',
        description: member.card.description,
        firstMessage: view?.firstMessage ?? plan.branch.greeting?.text ?? '',
        background: view?.backgroundHtml ?? '',
        image: characterImage(view?.avatarUrl),
        lore: member.card.lorebook.map(risuLore),
        localLore: (plan.localLore ?? []).map(risuLore),
      },
      user: plan.userName,
      persona: plan.personaText,
      personaImage: characterImage(view?.personaAvatarUrl),
      note: view?.note ?? '',
      lowLevel: false,
      // What `cbs()` reads besides the above: the reader's side the request triggers get (`requestTriggerInput`).
      cbs: {
        clock: { now: plan.clock.now.getTime(), timeZone: plan.clock.timeZone, locale: plan.clock.locale },
        seed: { key: plan.seed, length: plan.wholeBranch.length - (plan.branch.greeting ? 1 : 0) },
        meta: { language: plan.clock.locale },
        assets: { names: plan.assetNames, display: plan.assetNames },
        ...(plan.plot.cbsModules ? { modules: plan.plot.cbsModules } : {}),
        character: {
          personality: member.card.personality,
          scenario: member.card.scenario,
          exampleDialogue: member.card.mesExample,
        },
        triggerId: null,
      },
    },
  };
}

/**
 * What the card's request triggers run with, or null for a plot whose scripted
 * member — or a group turn's speaker (`requestScriptsOf`) — has none, which
 * costs it nothing. The member, its card and its name
 * are the ones the browser's runs read (`GET /:id/scripts`), with the reader's
 * overlay already on them; the chat is the whole branch, and the reader's side
 * of things (`data`) is what the browser hands its runs, from the plan — or
 * from what `script-llm` reads of the chat, in the plan's shape.
 */
export function requestTriggerInput(
  plan: Pick<
    GenerationPlan,
    | 'characters'
    | 'wholeBranch'
    | 'branch'
    | 'authorNote'
    | 'personaText'
    | 'userName'
    | 'variables'
    | 'globalVariables'
    | 'clock'
    | 'seed'
    | 'assetNames'
    | 'speaker'
    | 'plot'
  >,
): Omit<TriggerRunInput, 'mode' | 'displayData'> | null {
  const found = requestScriptsOf(plan);
  if (!found || !hasTriggersFor(found.scripts.triggers, 'request')) return null;
  const { member, scripts } = found;
  const messages = plan.wholeBranch.slice(plan.branch.greeting ? 1 : 0).map(
    (message): TriggerMessage => ({
      role: message.role === 'user' ? 'user' : 'char',
      data: message.content,
      id: message.id,
      time: message.createdAt.getTime(),
    }),
  );
  const nickname = member.card.nickname?.trim();
  return {
    character: {
      name: characterName(member),
      memberName: member.name,
      ...(nickname ? { nickname } : {}),
      description: member.card.description,
      personality: member.card.personality,
      scenario: member.card.scenario,
      exampleDialogue: member.card.mesExample,
      lorebook: member.card.lorebook,
      postHistoryInstructions: member.card.postHistoryInstructions,
      lowLevelAccess: scripts.lowLevelAccess,
      triggers: scripts.triggers,
    },
    messages,
    greeting: plan.branch.greeting?.text ?? null,
    note: plan.authorNote,
    persona: plan.personaText,
    variables: plan.variables,
    globalVariables: plan.globalVariables,
    data: {
      user: plan.userName,
      clock: plan.clock,
      seed: { key: plan.seed, length: messages.length },
      meta: { language: plan.clock.locale },
      assets: { names: plan.assetNames, display: plan.assetNames },
      ...(plan.plot.cbsModules ? { modules: plan.plot.cbsModules } : {}),
    },
  };
}

/**
 * The roster with the chat's own lore after the scripted member's book — whose
 * Lua wrote it — as RisuAI activates the character's lore and then the chat's.
 * (The work's modules' lore comes after both: the assembler puts it last.)
 */
function withChatLore(
  characters: PromptCharacter[],
  localLore: LoreEntry[] | undefined,
  modules: PromptPlot['modules'],
): PromptCharacter[] {
  if (!localLore?.length) return characters;
  const scripted = scriptedMember(characters, modules)?.member;
  if (!scripted) return characters;
  return characters.map((member) =>
    member === scripted ? { ...member, card: { ...member.card, lorebook: [...member.card.lorebook, ...localLore] } } : member,
  );
}

/** The prompt as it is put together, before the card's request triggers see it. */
async function assembleRequest(
  plan: GenerationPlan,
  deps: AppDeps,
  account?: ChatGPTAccount,
  report = false,
): Promise<AssembledPrompt> {
  // For continue the trailing assistant text must be the last turn so the model
  // resumes it, so it is re-attached after the post-history instructions.
  const isContinue = plan.target.kind === 'continue';
  // The partial bypasses the assembler, so it drops its own inlays as every other
  // turn does — and one a script wrote as its character, or another member's
  // group reply, goes under its name, as it would there. A speaker continuing
  // their own reply reads it plain.
  const last = isContinue ? plan.history[plan.history.length - 1] : undefined;
  const tagged = last?.speakerId !== undefined ? plan.characters.find((member) => member.id === last.speakerId) : undefined;
  const own = tagged !== undefined && typeof plan.speaker === 'number' && plan.characters[plan.speaker] === tagged;
  const partialBy = tagged ? (own ? undefined : tagged.name) : last?.speaker;
  const partial = last
    ? stripInlayMacros(
        partialBy !== undefined && last.role === 'assistant'
          ? spokenBy(last.content, partialBy, plan.characters.map((member) => member.name))
          : last.content,
      ).trimEnd()
    : '';
  // The partial is not in the history the assembler reads, so not on its branch
  // either — and where the partial is the greeting itself, there is none apart.
  const branch: PromptBranch = !isContinue
    ? plan.branch
    : plan.branch.length <= 1
      ? { length: 0 }
      : { ...plan.branch, length: plan.branch.length - 1 };
  // SillyTavern's vector storage: the lore found by meaning, and the earlier
  // messages brought back — which leave the history for this request, as ST
  // takes them out of the chat it sends. Never the newest turns, so never the
  // partial. Without an embedder, or past its deadline, nothing is found.
  const found = await searchByMeaning(deps, {
    vectors: plan.vectors,
    plot: plan.plot,
    characters: plan.characters,
    branch: plan.wholeBranch,
    userName: plan.userName,
  });
  const turns =
    found.retrieved.size > 0
      ? plan.history.map((turn) => (turn.id !== undefined && found.retrieved.has(turn.id) ? { ...turn, hidden: true } : turn))
      : plan.history;
  // The scripts read the turns as stored, before an image note is added to them —
  // the greeting as the reader's overlay has it, which is what the assembler sends.
  const history = await withoutUnseeableImages(
    await withPromptScripts(withBranchGreeting(isContinue ? turns.slice(0, -1) : turns, branch), plan, branch),
    plan.model,
    deps,
    account,
  );
  // The mode's own nudge first, then who the reader wants the reply to be about:
  // one closing instruction rather than two system turns in a row.
  const trailingSystem = [
    plan.trailingSystem?.trim() ?? '',
    plan.focusNames?.length ? sceneFocusDirective(plan.focusNames) : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
  // The `instruct` language mode's line: a turn of its own after everything the
  // assembler and the mode put there, so neither a card's post-history
  // instructions nor its system prompt stand after it (a narration is read by
  // the reader too, so it is asked in their language as well).
  const languageLine = plan.replyLanguage ? replyLanguageInstruction(plan.replyLanguage) : '';
  const prompt = assemblePrompt({
    plot: plan.plot,
    characters: withChatLore(plan.characters, plan.localLore, plan.plot.modules),
    personaText: plan.personaText,
    userName: plan.userName,
    memoryText: plan.memoryText,
    ...(found.retrievalText ? { retrievalText: found.retrievalText } : {}),
    relationshipText: plan.relationshipText,
    authorNote: plan.authorNote,
    ...(plan.authorNoteSettings ? { authorNoteSettings: plan.authorNoteSettings } : {}),
    // SillyTavern counts the reader's messages over the whole chat, not the
    // history the memory left: the note's frequency is read against these.
    userTurns: plan.wholeBranch.filter((message) => message.role === 'user').length,
    ...(plan.directions ? { directions: plan.directions } : {}),
    ...(plan.narrator ? { narrator: plan.narrator } : {}),
    preset: plan.preset,
    ...(plan.readerAdditions ? { readerAdditions: plan.readerAdditions } : {}),
    variables: plan.variables,
    globalVariables: plan.globalVariables,
    clock: plan.clock,
    seed: plan.seed,
    branch,
    // ChatGPT takes no assistant prefill: a continue is asked for, not resumed mid-turn.
    model: { id: plan.model, maxContext: plan.contextBudget, prefill: false, auxiliary: plan.auxiliaryModel },
    ...(plan.injections ? { injections: plan.injections } : {}),
    loreState: plan.loreState,
    ...(found.vectorLore ? { vectorLore: found.vectorLore } : {}),
    assetNames: plan.assetNames,
    history,
    // The budget reserves what the stream may actually spend — the same value
    // the request's maxTokens is set from, so a `long` plot does not assemble
    // a prompt whose history has eaten into its own reply.
    maxResponseTokens: responseTokens(plan),
    // The partial is appended below rather than assembled, so its slot and its
    // tokens have to be declared here or depth lore lands one turn too early and
    // its text rides along uncounted.
    trailingTurns: partial ? 1 : 0,
    ...(plan.speaker !== undefined ? { speaker: plan.speaker } : {}),
    // A narration is not a reply's lines, so it is not told how a reply marks its 지문.
    ...(plan.narration ? { narration: true } : {}),
    // The trailing instruction bypasses the assembler too, so its tokens are
    // subtracted here; it is not a turn, so it does not shift depth lore.
    contextBudget: plan.contextBudget - countTokens(partial) - countTokens(trailingSystem) - countTokens(languageLine),
    report,
  });
  if (!partial && !trailingSystem && !languageLine) return prompt;

  // The partial is the turn the model resumes, so it stays last: a closing
  // instruction on a continue (a speaker focus, the reply language) goes before it.
  return {
    system: prompt.system,
    messages: [
      ...prompt.messages,
      ...(trailingSystem ? [{ role: 'system' as const, content: trailingSystem }] : []),
      ...(languageLine ? [{ role: 'system' as const, content: languageLine }] : []),
      ...(partial ? [{ role: 'assistant' as const, content: partial }] : []),
    ],
    // The partial is the head being continued — the greeting itself on a branch of one.
    sources: [
      ...(prompt.sources ?? []),
      ...(trailingSystem ? [{ kind: 'trailing' as const }] : []),
      ...(languageLine ? [{ kind: 'trailing' as const }] : []),
      ...(partial
        ? [
            {
              kind: 'history' as const,
              ...(last?.id !== undefined ? { id: last.id } : {}),
              ...(plan.branch.greeting && plan.branch.length <= 1 ? { greeting: true as const } : {}),
            },
          ]
        : []),
    ],
    ...(prompt.risu ? { risu: prompt.risu } : {}),
    ...(prompt.fixedTokens !== undefined ? { fixedTokens: prompt.fixedTokens } : {}),
    loreTriggers: prompt.loreTriggers,
    ...(prompt.variableWrites ? { variableWrites: prompt.variableWrites } : {}),
    ...(prompt.stopSequences ? { stopSequences: prompt.stopSequences } : {}),
    // The two appended turns are part of what is sent, so the report says so —
    // and the budget it shows is the chat's, before they were taken out of it.
    ...(prompt.report
      ? {
          report: {
            ...prompt.report,
            blocks: [
              ...prompt.report.blocks,
              ...(trailingSystem
                ? [{ kind: 'trailing' as const, tokens: countTokens(trailingSystem), text: trailingSystem }]
                : []),
              ...(languageLine
                ? [{ kind: 'trailing' as const, label: 'language', tokens: countTokens(languageLine), text: languageLine }]
                : []),
              ...(partial ? [{ kind: 'history' as const, label: 'assistant', tokens: countTokens(partial), text: partial }] : []),
            ],
            totals: {
              ...prompt.report.totals,
              contextBudget: plan.contextBudget,
              used: prompt.report.totals.used + countTokens(partial) + countTokens(trailingSystem) + countTokens(languageLine),
            },
          },
        }
      : {}),
  };
}

/**
 * What a plan would send, measured block by block — the creator's prompt
 * inspector. Builds the request exactly as a generation would and stops there:
 * no adapter is asked, nothing is written.
 */
export async function inspectGeneration(
  deps: AppDeps,
  plan: GenerationPlan,
  reader: string,
  account?: ChatGPTAccount,
): Promise<PromptReport> {
  try {
    const { report } = await buildRequestMessages(plan, deps, reader, account, true);
    return report!;
  } catch (error) {
    // What a generation would fail on, the inspector is told as a refusal.
    if (error instanceof RequestTooLongError) throw badRequest(error.code, error.message);
    throw error;
  }
}

/**
 * The reasoning effort to send with this turn, if any. Read here rather than
 * planned: it is a request option, not prompt input. The catalog can drop an
 * effort after the reader chose it, and one the model no longer advertises is
 * left unsent rather than risked as an upstream error. Best effort: the reply
 * does not depend on it, so a failed read sends none instead of failing the turn
 * under a misleading `model_unavailable`.
 */
async function chosenReasoningEffort(
  deps: AppDeps,
  plan: GenerationPlan,
  account?: ChatGPTAccount,
): Promise<string | undefined> {
  try {
    const [row] = await deps.db
      .select({ reasoningEffort: chats.reasoningEffort })
      .from(chats)
      .where(eq(chats.id, plan.chatId));
    const chosen = row?.reasoningEffort;
    if (!chosen) return undefined;
    const offered = (await getModel(plan.model, deps.env, account))?.reasoningEfforts;
    return offered?.includes(chosen) ? chosen : undefined;
  } catch (error) {
    console.error('[api] reasoning effort lookup failed', error);
    return undefined;
  }
}

/**
 * The cap a narration is asked under: the `short` reply's, which pairs with the
 * 1~2문단 the narration nudge asks for, as each reply length pairs a directive
 * with a cap. ChatGPT sharing takes no hard cap, so there it is the response
 * reserve the prompt is planned with and the directive does the holding.
 */
const NARRATION_MAX_TOKENS = replyLengthTokens('short');

/** What the stream may spend, which the prompt's budget reserves too: one number for both. */
const responseTokens = (plan: GenerationPlan): number =>
  plan.narration ? NARRATION_MAX_TOKENS : replyLengthTokens(plan.plot.style?.replyLength);

/** `\n이름:` and `\n별명:` of every member, on the stage or off it. */
const memberStops = (characters: PromptCharacter[]): string[] =>
  characters.flatMap((member) =>
    [member.name, member.card.nickname?.trim() ?? ''].filter((name) => name.length > 0).map((name) => `\n${name}:`),
  );

/**
 * What a new narration keeps of the text the model wrote: the scene up to the
 * first line the parser reads as a member — or the reader — speaking. The stop
 * sequences end the stream on such a line, but not on the first one, which no
 * line break comes before, nor on one the parser reads more loosely than the
 * stop matches. Empty when nothing of the scene is left; null when the turn is
 * not a new narration and keeps what it was given.
 */
function narrationKept(plan: GenerationPlan, text: string): string | null {
  if (!plan.narration || plan.target.kind !== 'new') return null;
  const roster = [
    ...plan.characters.map((member) => {
      const nickname = member.card.nickname?.trim();
      return { name: member.name, aliases: nickname ? [nickname] : [] };
    }),
    plan.userName,
  ];
  return narrationUntilSpeech(narrationBody(text), roster);
}

async function runGeneration(
  c: Context<AppEnv>,
  deps: AppDeps,
  plan: GenerationPlan,
  release: () => Promise<void>,
): Promise<Response> {
  // Defensive: the routes already rejected unavailable models before writing
  // anything, so this should not fire for the deterministic case.
  let resolved: { adapter: LLMAdapter; providerModel: string };
  let request: BuiltRequest;
  let reasoningEffort: string | undefined;
  try {
    // The reader's own ChatGPT account answers their chat.
    const account = deps.chatgpt?.accounts.forUser(c.get('userId'));
    resolved = await (deps.getAdapter ?? getAdapter)(plan.model, deps.env, account);
    request = await buildRequestMessages(plan, deps, c.get('userId'), account);
    reasoningEffort = await chosenReasoningEffort(deps, plan, account);
  } catch (error) {
    // The card's listeners grew the request past the chat's context: it fails
    // as RisuAI's `toomuchtoken` does, as a provider failure does here —
    // nothing stored, the turn it would have answered still the head.
    if (error instanceof RequestTooLongError) {
      return streamSSE(c, async (stream) => {
        try {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: error.message, code: error.code }) });
        } finally {
          await release();
        }
      });
    }
    await release();
    if (error instanceof ChatGPTError) throw error;
    throw badRequest('model_unavailable', error instanceof Error ? error.message : 'Model unavailable');
  }

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    stream.onAbort(abort);
    c.req.raw.signal?.addEventListener('abort', abort);

    // A stream that says nothing while the model thinks is a stream an idle proxy
    // drops, and time to first token is exactly when it says nothing. `ping` is a
    // named event rather than a bare `:` comment because that is what streamSSE
    // writes cleanly; every client ignores an event it has no branch for, and the
    // browser reader is tested on it. The same tick renews the generation claim,
    // which is what keeps a reply slower than CLAIM_STALE_MS from being taken over.
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: '' });
      void renewChatSlot(deps, plan.chatId);
    }, HEARTBEAT_MS);

    let text = '';
    let usage: Usage = { promptTokens: 0, completionTokens: 0 };

    try {
      try {
        const generator = resolved.adapter.stream({
          model: resolved.providerModel,
          system: request.system,
          messages: request.messages,
          // ChatGPT sharing accepts the prompt's length directive, not a hard
          // token cap. Keep the budget here for prompt planning and test adapters.
          maxTokens: responseTokens(plan),
          // ChatGPT sharing does not accept sampling parameters. A group reply also
          // stops where it starts on another member's line (`stopSequences`), and
          // so does a narration, on every member's.
          stop: [
            ...new Set([
              `\n${plan.userName}:`,
              ...(request.stopSequences ?? []),
              ...(plan.narration ? memberStops(plan.characters) : []),
            ]),
          ],
          ...(reasoningEffort ? { reasoningEffort } : {}),
          abortSignal: controller.signal,
        });

        let next = await generator.next();
        while (!next.done) {
          text += next.value.text;
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: next.value.text }) });
          next = await generator.next();
        }
        usage = next.value.usage;
      } catch (error) {
        // A disconnect surfaces as an abort error; anything else is a real failure
        // and must not persist a message.
        if (!controller.signal.aborted) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ message: error instanceof Error ? error.message : 'Generation failed', ...(error instanceof ChatGPTError ? { code: error.code } : {}) }),
          });
          return;
        }
      }

      // A narration keeps the scene and nothing a member says (`narrationKept`).
      const kept = narrationKept(plan, text);
      const reply = kept ?? text;

      // Client gone: keep whatever was received so far, but send nothing.
      if (controller.signal.aborted) {
        if (reply) {
          // Stored pending all the same, if the browser meant to post-process
          // it: the next time it opens the chat it finds the mark and finishes.
          const stored = await persist(deps, plan, reply, usage, request, { stopped: true });
          // The turn is on the branch whether or not anyone was listening, so what
          // it opened is opened; there is simply no event to say so on.
          await openUnlocks(deps, plan.chatId, stored.content);
          if (!plan.postProcess) scheduleBackgroundUpdates(deps, plan.chatId);
        }
        return;
      }

      // Nothing of the scene was left: it fails as a provider failure does —
      // nothing stored, and the turn it would have followed is still the head.
      if (kept === '') {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: 'The narration held nothing but dialogue', code: 'narration_empty' }),
        });
        return;
      }

      const stored = await persist(deps, plan, reply, usage, request);
      // Evaluated on the raw text as well as at the commit: unlocks only ever
      // open, so the earlier answer costs nothing and saves the reader a wait.
      const unlockedAssetIds = await openUnlocks(deps, plan.chatId, stored.content);
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          messageId: stored.id,
          usage,
          // Only when something really opened: the client celebrates on the field
          // being there, and every other turn's payload stays what it was.
          ...(unlockedAssetIds.length > 0 ? { unlockedAssetIds } : {}),
          // Only for a turn the browser said it would finish: the revision its
          // commit has to name, read from the row rather than assumed.
          ...(plan.postProcess ? { postProcess: true, scriptRev: stored.scriptRev } : {}),
          // Only for a group reply: whose it is, and the round the next speaker joins.
          ...(stored.groupTurnId !== null
            ? { speakerMemberId: stored.speakerMemberId, groupTurnId: stored.groupTurnId }
            : {}),
        }),
      });
      // Strictly after `done`: background work must not add latency to the turn.
      if (!plan.postProcess) scheduleBackgroundUpdates(deps, plan.chatId, stored.id);
    } finally {
      clearInterval(heartbeat);
      c.req.raw.signal?.removeEventListener('abort', abort);
      await release();
    }
  });
}

/**
 * Evaluates the plot's unlockable assets against the turn that has just been
 * persisted, and answers with what it opened.
 *
 * The chat row is re-read rather than taken from the plan: the head has just
 * moved, and a turn-count condition is asked about the branch as it now stands.
 * Failures are logged like any other post-persistence work — an unlock that did
 * not land is opened by the next turn, and must never tear down a stream whose
 * text is already stored. A script commit that rewrites a turn asks again of
 * the text it leaves.
 */
export async function openUnlocks(deps: AppDeps, chatId: string, content: string): Promise<string[]> {
  try {
    const [chat] = await deps.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    return chat ? await unlockAssets(deps, chat, content) : [];
  } catch (error) {
    console.error('[api] asset unlock evaluation failed', error);
    return [];
  }
}

/** The stored turn: its id, the text the branch now holds for it, its script revision, and its group-turn tags. */
interface StoredTurn {
  id: string;
  content: string;
  scriptRev: number;
  speakerMemberId: string | null;
  groupTurnId: string | null;
}

/**
 * The delta a generated turn is stored with, so that folding it — the turn's own
 * macros over its base, then this on top — reads the way RisuAI would have left
 * things: the start triggers ran before the reply existed, so the reply's macros
 * fold over their writes and win where both touch a name. Measured against the
 * plain fold of the stored text, exactly as the browser measures the delta it
 * commits after the output scripts (`diffVariables`), which replaces this one.
 *
 * What a SillyTavern member's text wrote while the prompt was put together
 * (`AssembledPrompt.variableWrites`) lands between the two: ST runs those macros
 * as it builds the prompt, after the triggers and before the reply exists. It
 * rides on the turn the prompt produced, so a regenerate — which folds the
 * branch without the turn it replaces — writes them again, once, and the next
 * turn reads them from here.
 *
 * A continue rewrites the head, so the head is the one node here: what it held
 * before — its own delta included — then the start triggers, then the prompt's
 * writes, then the continuation's macros. A continue with none of the three
 * stores none, as it always has.
 */
function generatedDelta(
  plan: GenerationPlan,
  content: string,
  appended: string,
  writes: VariableDelta | undefined,
): VariableDelta | null {
  const fold = (items: readonly FoldItem[], base: Variables): Variables =>
    computeVariables(items, base, plan.fold);
  if (plan.target.kind === 'continue') {
    const head = plan.target.message;
    if (!plan.startDelta && !writes && !head.variableDelta) return null;
    const before = applyVariableDelta(applyVariableDelta(fold([head], plan.turnBase), plan.startDelta), writes);
    return diffVariables(fold([appended], before), fold([content], plan.turnBase));
  }
  if (!plan.startDelta && !writes) return null;
  return diffVariables(
    fold([content], applyVariableDelta(applyVariableDelta(plan.turnBase, plan.startDelta), writes)),
    fold([content], plan.turnBase),
  );
}

/**
 * What the `editRequest` listeners rewrote of the scripted member, as the
 * reader's overlay keeps it — held to the limits a rewrite from the browser is
 * held to (`readOverlay`). A field past them is dropped and logged: the reply is
 * on its way by now, and the browser drops what it cannot send the same way.
 */
function listenerOverlay(rewrite: LuaCharacterRewrite, label: string): MemberOverlay | null {
  const patch: MemberOverlay = {};
  if (rewrite.name !== undefined) {
    const name = overlayName(rewrite.name);
    if (name === null) console.warn('[api] editRequest set a name that is not one line of 1 to 100 characters; dropped:', label);
    else patch.name = name;
  }
  for (const [from, to] of [
    ['description', 'description'],
    ['firstMessage', 'firstMessage'],
    ['background', 'backgroundHtml'],
  ] as const) {
    const value = rewrite[from];
    if (value === undefined) continue;
    if (value.length > MAX_OVERLAY_TEXT_LENGTH || value.includes('\u0000')) {
      console.warn(`[api] editRequest's ${from} rewrite is past what a rewrite may hold; dropped:`, label);
    } else patch[to] = value;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Keeps what the `editRequest` listeners did besides the request, in the
 * reply's transaction and before the reply — RisuAI's listener edits the live
 * chat and character, and `sendChat` pushes the reply onto that chat after it:
 *
 * - the chat, as the reader's branch (`scriptChat.ts`, the rules a start
 *   trigger's edit is kept by), said against the branch the turn is generated
 *   on; the reply then hangs under where it ends. A continue continues the
 *   message it ends on, as RisuAI's continues whatever ends its chat — copied
 *   first if another branch reads it — and a chat they left ending on anything
 *   but a reply has nothing to continue: those edits are dropped and logged;
 * - what they rewrote of the scripted member, merged into the reader's overlay;
 * - the lore they upserted, into the chat's own.
 *
 * Each is held to the limits the browser's writes are held to; one past them
 * is dropped and logged rather than failing a reply that is already written.
 * Where the reply goes: under `parentId`, or onto `continued`; null leaves it
 * where the plan put it.
 */
async function keepListenerEdits(
  tx: Tx,
  plan: GenerationPlan,
  edits: ListenerEdits,
): Promise<{ parentId: string | null; continued?: Message } | null> {
  const label = plan.chatId;
  // The chat's row first, as every writer of the reader's overlay takes the two.
  const [chat] = await tx
    .select({ userId: chats.userId, plotId: chats.plotId, localLore: chats.localLore })
    .from(chats)
    .where(eq(chats.id, plan.chatId))
    .for('update');
  if (!chat) return null;

  let place: { parentId: string | null; continued?: Message } | null = null;
  if (edits.messages) {
    const all = await tx.select().from(messages).where(eq(messages.chatId, plan.chatId));
    const rows = new Map(all.map((message) => [message.id, message]));
    const path = plan.wholeBranch.map((message) => rows.get(message.id) ?? message);
    // What the listeners were handed: the branch after its greeting, as RisuAI's `chat.message`.
    const before: TriggerMessage[] = path.slice(plan.branch.greeting ? 1 : 0).map((message) => ({
      role: message.role === 'user' ? 'user' : 'char',
      data: message.content,
      id: message.id,
    }));
    const after: TriggerMessage[] = edits.messages.map((message) => {
      const was = message.key !== null ? before[message.key] : undefined;
      return { role: message.role, data: message.data, ...(was ? { id: was.id } : {}) };
    });
    const check = checkScriptChat(scriptChatOf(before, after));
    const continuing = plan.target.kind === 'continue';
    if (!check.ok) {
      console.warn(`[api] editRequest's chat edits are not kept (${check.error}):`, label);
    } else if (check.chat) {
      // The listeners are the speaker's, so a character message they add is the speaker's.
      const memberId = typeof plan.speaker === 'number' ? plan.characters[plan.speaker]?.id : undefined;
      const planned = planScriptChat(path, check.chat, {
        inPlace: rewritableHead(all, path.at(-1)),
        ...(continuing ? { ownLast: true } : {}),
        ...(memberId !== undefined ? { memberId } : {}),
      });
      if (continuing && planned.lastRole !== 'assistant') {
        console.warn('[api] editRequest left no reply at the end of the chat to continue; its chat edits are not kept:', label);
      } else if (planned.changed) {
        const applied = await applyScriptChat(tx, plan.chatId, planned, all);
        const end = applied.path.at(-1);
        place = continuing && end ? { parentId: end.parentId, continued: end } : { parentId: end?.id ?? null };
      }
    }
  }

  const memberId = plan.scriptView?.memberId;
  const patch = memberId ? listenerOverlay(edits.character, label) : null;
  if (memberId && patch) {
    try {
      // A savepoint: a refusal (the overlay past its size) takes back this write alone.
      await tx.transaction((inner) =>
        mergeReaderOverlay(inner, chat.userId, chat.plotId, { members: { [memberId]: patch } }, new Set([memberId])),
      );
    } catch (error) {
      console.warn('[api] editRequest\'s character rewrites are not kept:', label, error instanceof Error ? error.message : error);
    }
  }

  if (edits.lore.length > 0) {
    try {
      const lore = readLocalLore(upsertLocalLore(chat.localLore ?? [], edits.lore))!;
      await tx
        .update(chats)
        .set({ localLore: lore.length > 0 ? lore : null })
        .where(eq(chats.id, plan.chatId));
    } catch (error) {
      console.warn('[api] editRequest\'s lore upserts are not kept:', label, error instanceof Error ? error.message : error);
    }
  }
  return place;
}

/**
 * The reply's text as it is stored: where it is wholly by a member whose card
 * shows its emotion pictures inline (RisuAI's `inlayViewScreen`), the
 * `<Emotion="…">` tags the model was told to end with become the picture
 * (`inlayEmotionTags`), as RisuAI's `runInlayScreen` rewrites a reply.
 */
function withInlayEmotions(plan: GenerationPlan, text: string, speakerMemberId: string | null, whole: string): string {
  const member = replyMemberOf({ role: 'assistant', content: whole, source: 'user', speakerMemberId }, plan.characters);
  return member && emotionScreenOf(member.card)?.mode === 'inlay' ? inlayEmotionTags(text) : text;
}

/**
 * Writes the generated text and moves the head, in one transaction with what
 * the `editRequest` listeners did (`keepListenerEdits`), which goes first. A
 * new turn records the lore that freshly triggered for its prompt; a continue
 * is the same turn, whose record was written when it was first generated.
 *
 * A member speaker's own `이름: ` prefixes come off what it wrote — of a continue,
 * off the appended text alone — and a new group reply is stored under its
 * speaker and its round (`GenerationPlan.round`); one that opens a round is the
 * round's id.
 */
async function persist(
  deps: AppDeps,
  plan: GenerationPlan,
  text: string,
  usage: Usage,
  { loreTriggers, variableWrites, listenerEdits }: Pick<BuiltRequest, 'loreTriggers' | 'variableWrites' | 'listenerEdits'>,
  /** The reader stopped it: nothing chooses its emotion picture again (`scheduleBackgroundUpdates`). */
  { stopped = false }: { stopped?: boolean } = {},
): Promise<StoredTurn> {
  const scriptState = plan.postProcess ? ('pending' as const) : null;
  return deps.db.transaction(async (tx) => {
    const place = listenerEdits ? await keepListenerEdits(tx, plan, listenerEdits) : null;
    if (plan.target.kind === 'continue') {
      // The message the listeners left last, where they edited the chat — its text as they left it.
      const target = place?.continued ?? plan.target.message;
      const continued: GenerationPlan = target === plan.target.message ? plan : { ...plan, target: { kind: 'continue', message: target } };
      const stripped = plan.speakerNames ? stripSpeakerPrefix(text, plan.speakerNames) : text;
      const appended = withInlayEmotions(plan, stripped, target.speakerMemberId, target.content);
      const content = target.content + appended;
      const [updated] = await tx
        .update(messages)
        .set({
          content,
          promptTokens: usage.promptTokens,
          completionTokens: (target.completionTokens ?? 0) + usage.completionTokens,
          variableDelta: storableDelta(generatedDelta(continued, content, appended, variableWrites)),
          scriptState,
          // The text changed in place, so a script commit computed on the old
          // text — another tab's, finishing the turn as it was — is refused.
          scriptRev: sql`${messages.scriptRev} + 1`,
          // Chosen again for the longer reply, as RisuAI chooses after a continue —
          // unless the reader stopped it, which chooses none and keeps the one it had.
          ...(stopped ? {} : { emotion: null }),
        })
        .where(eq(messages.id, target.id))
        .returning({ scriptRev: messages.scriptRev });
      // The append mutates assistant content in place — same revision rules as
      // an edit, so a refresh whose snapshot predates the append is discarded.
      await invalidateMemoryForEdit(tx, plan.chatId, target.id);
      return {
        id: target.id,
        content,
        scriptRev: updated?.scriptRev ?? target.scriptRev + 1,
        speakerMemberId: target.speakerMemberId,
        groupTurnId: target.groupTurnId,
      };
    }

    // The prefix is the server's to write: the model was asked for the scene
    // alone, and the convention is what makes the stored turn a narration.
    const said = plan.narration
      ? withNarrationPrefix(text)
      : plan.speakerNames
        ? stripSpeakerPrefix(text, plan.speakerNames)
        : text;
    const content = withInlayEmotions(plan, said, plan.round?.speakerMemberId ?? null, said);
    // Minted here, so a reply that opens a round can be stored as its id.
    const id = randomUUID();
    const [created] = await tx
      .insert(messages)
      .values({
        id,
        chatId: plan.chatId,
        // Under where the listeners left the chat, where they edited it.
        parentId: place ? place.parentId : plan.target.parentId,
        role: 'assistant',
        content,
        model: plan.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        loreTriggers: loreTriggers.length > 0 ? loreTriggers : null,
        variableDelta: storableDelta(generatedDelta(plan, content, content, variableWrites)),
        scriptState,
        ...(plan.round
          ? { speakerMemberId: plan.round.speakerMemberId, groupTurnId: plan.round.groupTurnId ?? id }
          : {}),
      })
      .returning();
    await tx
      .update(chats)
      .set({ headMessageId: created!.id, updatedAt: new Date() })
      .where(eq(chats.id, plan.chatId));
    return {
      id: created!.id,
      content: created!.content,
      scriptRev: created!.scriptRev,
      speakerMemberId: created!.speakerMemberId,
      groupTurnId: created!.groupTurnId,
    };
  });
}
