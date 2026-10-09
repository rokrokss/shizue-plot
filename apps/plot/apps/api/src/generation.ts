import {
  assemblePrompt,
  countTokens,
  replyLengthTokens,
  sceneFocusDirective,
  stripImageMacros,
  withNarrationPrefix,
  type AssembledPrompt,
  type HistoryMessage,
  type LoreTimedState,
  type MacroClock,
  type NarratorConfig,
  type Preset,
  type PromptCharacter,
  type PromptPlot,
  type PromptReport,
  type Variables,
} from '@shizue/core';
import { chats, messages, type Chat, type Message } from '@shizue/db';
import { ChatGPTError, getAdapter, getModel, supportsVision, type ChatGPTAccount, type LLMAdapter } from '@shizue/llm';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { withImageNote } from './attachments.js';
import { ApiError, badRequest, notFound } from './errors.js';
import type { AppDeps, AppEnv } from './deps.js';
import { invalidateMemoryForEdit, scheduleMemoryUpdate } from './memory.js';
import { scheduleRelationshipUpdate } from './relationship.js';
import { unlockAssets } from './unlocks.js';

/**
 * The fire-and-forget jobs a completed assistant turn starts. They own separate
 * per-chat guards and never block each other.
 */
function scheduleBackgroundUpdates(deps: AppDeps, chatId: string): void {
  scheduleMemoryUpdate(deps, chatId);
  scheduleRelationshipUpdate(deps, chatId);
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
  /** Summary/facts block for the turns that are no longer in `history`. */
  memoryText: string;
  /** Relationship state block, empty when the chat has none or turned it off. */
  relationshipText: string;
  /** The chat's author note, injected `AUTHOR_NOTE_DEPTH` messages from the end. */
  authorNote: string;
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
   * `{{setvar}}` macros of its messages over the plot's defaults. Only
   * `{{getvar::k}}` reads them; the macros themselves stay in the history.
   */
  variables: Variables;
  /** The reader's clock, for the time macros (see `requestClock`). */
  clock: MacroClock;
  /** What keeps `{{pick}}` stable on this chat: its id. */
  seed: string;
  /**
   * The lore records of the branch the turn is generated on, for the timed
   * effects — taken from the whole branch, not the history the budget kept.
   */
  loreState: LoreTimedState;
  /** The chat's prompt preset. */
  preset: Preset;
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
  target: GenerationTarget;
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
}

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
    return { role: turn.role, content: withImageNote(turn.content, turn.images.length) };
  });
}

async function buildRequestMessages(
  plan: GenerationPlan,
  deps: AppDeps,
  account?: ChatGPTAccount,
  report = false,
): Promise<AssembledPrompt> {
  // For continue the trailing assistant text must be the last turn so the model
  // resumes it, so it is re-attached after the post-history instructions.
  const isContinue = plan.target.kind === 'continue';
  // The partial bypasses the assembler, so it is stripped of image references
  // here — the assembler would have done it for any other turn.
  const partial = isContinue
    ? stripImageMacros(plan.history[plan.history.length - 1]?.content ?? '').trimEnd()
    : '';
  const history = await withoutUnseeableImages(
    isContinue ? plan.history.slice(0, -1) : plan.history,
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
  const prompt = assemblePrompt({
    plot: plan.plot,
    characters: plan.characters,
    personaText: plan.personaText,
    userName: plan.userName,
    memoryText: plan.memoryText,
    relationshipText: plan.relationshipText,
    authorNote: plan.authorNote,
    ...(plan.directions ? { directions: plan.directions } : {}),
    ...(plan.narrator ? { narrator: plan.narrator } : {}),
    preset: plan.preset,
    variables: plan.variables,
    clock: plan.clock,
    seed: plan.seed,
    loreState: plan.loreState,
    history,
    // The budget reserves what the stream may actually spend — the same value
    // the request's maxTokens is set from, so a `long` plot does not assemble
    // a prompt whose history has eaten into its own reply.
    maxResponseTokens: replyLengthTokens(plan.plot.style?.replyLength),
    // The partial is appended below rather than assembled, so its slot and its
    // tokens have to be declared here or depth lore lands one turn too early and
    // its text rides along uncounted.
    trailingTurns: partial ? 1 : 0,
    // The trailing instruction bypasses the assembler too, so its tokens are
    // subtracted here; it is not a turn, so it does not shift depth lore.
    contextBudget: plan.contextBudget - countTokens(partial) - countTokens(trailingSystem),
    report,
  });
  if (!partial && !trailingSystem) return prompt;

  // The partial is the turn the model resumes, so it stays last: a closing
  // instruction on a continue (only a speaker focus can be one) goes before it.
  return {
    system: prompt.system,
    messages: [
      ...prompt.messages,
      ...(trailingSystem ? [{ role: 'system' as const, content: trailingSystem }] : []),
      ...(partial ? [{ role: 'assistant' as const, content: partial }] : []),
    ],
    loreTriggers: prompt.loreTriggers,
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
              ...(partial ? [{ kind: 'history' as const, label: 'assistant', tokens: countTokens(partial), text: partial }] : []),
            ],
            totals: {
              ...prompt.report.totals,
              contextBudget: plan.contextBudget,
              used: prompt.report.totals.used + countTokens(partial) + countTokens(trailingSystem),
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
  account?: ChatGPTAccount,
): Promise<PromptReport> {
  const { report } = await buildRequestMessages(plan, deps, account, true);
  return report!;
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

async function runGeneration(
  c: Context<AppEnv>,
  deps: AppDeps,
  plan: GenerationPlan,
  release: () => Promise<void>,
): Promise<Response> {
  // Defensive: the routes already rejected unavailable models before writing
  // anything, so this should not fire for the deterministic case.
  let resolved: { adapter: LLMAdapter; providerModel: string };
  let request: AssembledPrompt;
  let reasoningEffort: string | undefined;
  try {
    // The reader's own ChatGPT account answers their chat.
    const account = deps.chatgpt?.accounts.forUser(c.get('userId'));
    resolved = await (deps.getAdapter ?? getAdapter)(plan.model, deps.env, account);
    request = await buildRequestMessages(plan, deps, account);
    reasoningEffort = await chosenReasoningEffort(deps, plan, account);
  } catch (error) {
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
          maxTokens: replyLengthTokens(plan.plot.style?.replyLength),
          // ChatGPT sharing does not accept sampling parameters.
          stop: [`\n${plan.userName}:`],
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

      // Client gone: keep whatever was received so far, but send nothing.
      if (controller.signal.aborted) {
        if (text) {
          const stored = await persist(deps, plan, text, usage, request.loreTriggers);
          // The turn is on the branch whether or not anyone was listening, so what
          // it opened is opened; there is simply no event to say so on.
          await openUnlocks(deps, plan.chatId, stored.content);
          scheduleBackgroundUpdates(deps, plan.chatId);
        }
        return;
      }

      const stored = await persist(deps, plan, text, usage, request.loreTriggers);
      const unlockedAssetIds = await openUnlocks(deps, plan.chatId, stored.content);
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          messageId: stored.id,
          usage,
          // Only when something really opened: the client celebrates on the field
          // being there, and every other turn's payload stays what it was.
          ...(unlockedAssetIds.length > 0 ? { unlockedAssetIds } : {}),
        }),
      });
      // Strictly after `done`: background work must not add latency to the turn.
      scheduleBackgroundUpdates(deps, plan.chatId);
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
 * text is already stored.
 */
async function openUnlocks(deps: AppDeps, chatId: string, content: string): Promise<string[]> {
  try {
    const [chat] = await deps.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    return chat ? await unlockAssets(deps, chat, content) : [];
  } catch (error) {
    console.error('[api] asset unlock evaluation failed', error);
    return [];
  }
}

/** The stored turn: its id, and the text the branch now holds for it. */
interface StoredTurn {
  id: string;
  content: string;
}

/**
 * Writes the generated text and moves the head. A new turn records the lore that
 * freshly triggered for its prompt; a continue is the same turn, whose record was
 * written when it was first generated.
 */
async function persist(
  deps: AppDeps,
  plan: GenerationPlan,
  text: string,
  usage: Usage,
  loreTriggers: string[],
): Promise<StoredTurn> {
  if (plan.target.kind === 'continue') {
    const target = plan.target.message;
    const content = target.content + text;
    await deps.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({
          content,
          promptTokens: usage.promptTokens,
          completionTokens: (target.completionTokens ?? 0) + usage.completionTokens,
        })
        .where(eq(messages.id, target.id));
      // The append mutates assistant content in place — same revision rules as
      // an edit, so a refresh whose snapshot predates the append is discarded.
      await invalidateMemoryForEdit(tx, plan.chatId, target.id);
    });
    return { id: target.id, content };
  }

  const [created] = await deps.db
    .insert(messages)
    .values({
      chatId: plan.chatId,
      parentId: plan.target.parentId,
      role: 'assistant',
      // The prefix is the server's to write: the model was asked for the scene
      // alone, and the convention is what makes the stored turn a narration.
      content: plan.narration ? withNarrationPrefix(text) : text,
      model: plan.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      loreTriggers: loreTriggers.length > 0 ? loreTriggers : null,
    })
    .returning();
  await deps.db
    .update(chats)
    .set({ headMessageId: created!.id, updatedAt: new Date() })
    .where(eq(chats.id, plan.chatId));
  return { id: created!.id, content: created!.content };
}
