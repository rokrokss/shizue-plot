/**
 * The emotion picture a reply leaves its member wearing (RisuAI's emotion
 * images, `@shizue/core` `emotion.ts`), chosen after the reply as RisuAI's
 * default `emotionProcesser` (`submodel`) chooses it: the chat's auxiliary model
 * is shown the card's names and the reply, and answers with one.
 *
 * Like the memory refresh this runs after the SSE `done` event — or after the
 * script commit that finishes a pending turn — and swallows its own failures:
 * the reply never waits for it. What it chooses is stored on the reply
 * (`messages.emotion`), so the branch carries it; the reader's page asks for it
 * once the turn is done (`GET /api/chats/:id/messages/:messageId/emotion`).
 */
import {
  emotionRequest,
  emotionScreenOf,
  EMOTION_MAX_TOKENS,
  isNarration,
  pickEmotion,
  type EmotionImage,
} from '@shizue/core';
import { chats, messages, type Message } from '@shizue/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { loadMembers } from './hub.js';
import { collect, memoryChannel } from './memory.js';

/** Deadline for one choice, so a hung provider frees its slot. */
const EMOTION_TIMEOUT_MS = 20_000;

/**
 * The member a message is wholly by, whose emotion screen it moves: a group
 * reply's speaker, or the one member of a work of one. A narration, a reply
 * naming its speakers in `이름:` lines in a work of several, and a message a
 * card's script wrote are no one member's reply.
 */
export function replyMemberOf<M extends { id?: string | undefined }>(
  message: Pick<Message, 'role' | 'content' | 'source' | 'speakerMemberId'>,
  roster: readonly M[],
): M | undefined {
  if (message.role !== 'assistant' || message.source === 'script' || isNarration(message.content)) return undefined;
  if (message.speakerMemberId) return roster.find((member) => member.id === message.speakerMemberId);
  return roster.length === 1 ? roster[0] : undefined;
}

/** One of the member's own pictures by name, as RisuAI's `@@emo` finds it (`emo[0] === name`). */
export const emotionNamed = (images: readonly EmotionImage[], name: string): EmotionImage | undefined =>
  images.find((image) => image.name === name);

/**
 * Fire-and-forget choice for one reply. Must only be called once the reply is
 * stored and finished; it reloads everything itself and never propagates a
 * failure. One at a time per message — a round's replies each get their own.
 */
export function scheduleEmotionDetection(deps: AppDeps, chatId: string, messageId: string): void {
  if (deps.detectingEmotion.has(messageId)) return;
  deps.detectingEmotion.add(messageId);
  const task = detectEmotion(deps, chatId, messageId)
    .catch((error: unknown) => {
      console.error('[emotion] detection failed', error);
    })
    .finally(() => deps.detectingEmotion.delete(messageId));
  deps.onBackgroundTask?.(task, 'emotion');
}

async function detectEmotion(deps: AppDeps, chatId: string, messageId: string): Promise<void> {
  const [row] = await deps.db
    .select({ message: messages, chat: chats })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .where(and(eq(messages.id, messageId), eq(messages.chatId, chatId)))
    .limit(1);
  // Chosen already — by the card's `@@emo`, which RisuAI lets stand (`emoChanged`).
  if (!row || row.message.emotion !== null) return;
  const member = replyMemberOf(row.message, await loadMembers(deps.db, row.chat.plotId));
  const screen = member ? emotionScreenOf(member.card) : null;
  // The panel's alone: in inlay mode the model named its picture in the reply.
  if (screen?.mode !== 'panel') return;

  const resolved = await memoryChannel(deps, row.chat);
  if (!resolved) return;
  const request = emotionRequest(screen.images, row.message.content);
  let answer: string;
  try {
    answer = await collect(resolved.adapter, {
      model: resolved.providerModel,
      system: request.system,
      messages: request.messages,
      maxTokens: EMOTION_MAX_TOKENS,
      abortSignal: AbortSignal.timeout(EMOTION_TIMEOUT_MS),
    });
  } catch (error) {
    console.error('[emotion] the auxiliary model did not answer', error);
    return;
  }
  const picked = pickEmotion(answer, screen.images);
  if (!picked) return;
  // Only where nothing chose one meanwhile, and on a message that is still there.
  await deps.db
    .update(messages)
    .set({ emotion: picked.name })
    .where(and(eq(messages.id, messageId), isNull(messages.emotion)));
}
