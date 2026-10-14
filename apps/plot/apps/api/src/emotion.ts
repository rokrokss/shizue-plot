/**
 * The emotion picture a reply leaves its member wearing (RisuAI's emotion
 * images, `@shizue/core` `emotion.ts`), chosen after the reply as RisuAI's
 * `emotionProcesser` chooses it — by default (`submodel`) the chat's auxiliary
 * model is shown the card's names and the reply and answers with one; where the
 * reader picked `embedding` for the chat (`chats.emotion_processor`), the
 * server's embedder compares the reply with each name (`pickEmotionByEmbedding`)
 * and the auxiliary model is not asked. When the embedder cannot run for the
 * plot, or fails, the auxiliary model chooses after all.
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
  EMOTION_EMBEDDING_PREFIX,
  EMOTION_MAX_TOKENS,
  EMOTION_PENALTY_WINDOW,
  isNarration,
  pickEmotion,
  pickEmotionByEmbedding,
  type EmotionImage,
} from '@shizue/core';
import { chats, messages, plots, type Character, type Chat, type Message } from '@shizue/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import type { Embedder } from './embedder.js';
import { loadMembers } from './hub.js';
import { collect, memoryChannel } from './memory.js';
import { buildPath } from './tree.js';

/** Deadline for one choice, so a hung provider frees its slot. */
const EMOTION_TIMEOUT_MS = 20_000;
/** The names' vectors kept in this process, by model and text — RisuAI keeps them in its browser store. */
const nameVectors = new Map<string, number[]>();
const MAX_NAME_VECTORS = 5_000;

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
  const roster = await loadMembers(deps.db, row.chat.plotId);
  const member = replyMemberOf(row.message, roster);
  const screen = member ? emotionScreenOf(member.card) : null;
  // The panel's alone: in inlay mode the model named its picture in the reply.
  if (!member || screen?.mode !== 'panel') return;

  let picked: EmotionImage | undefined;
  const byEmbedding =
    row.chat.emotionProcessor === 'embedding' && deps.embedder
      ? await chooseByEmbedding(deps, deps.embedder, row.chat, row.message, member, roster, screen.images)
      : null;
  if (byEmbedding !== null) picked = byEmbedding;
  else {
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
    picked = pickEmotion(answer, screen.images);
  }
  if (!picked) return;
  // Only where nothing chose one meanwhile, and on a message that is still there.
  await deps.db
    .update(messages)
    .set({ emotion: picked.name })
    .where(and(eq(messages.id, messageId), isNull(messages.emotion)));
}

/**
 * RisuAI's embedding processor: each name embedded as `emotion:<name>`, the
 * reply as the query, both with the plot's model, and the closest name less the
 * penalty for the member's last pictures on this branch (`pickEmotionByEmbedding`
 * — RisuAI keeps them per character, in memory). Null when the embedder cannot
 * run for the plot or fails, which hands the choice to the auxiliary model.
 */
async function chooseByEmbedding(
  deps: AppDeps,
  embedder: Embedder,
  chat: Pick<Chat, 'id' | 'plotId'>,
  message: Message,
  member: Character,
  roster: readonly Character[],
  images: readonly EmotionImage[],
): Promise<EmotionImage | undefined | null> {
  const [plot] = await deps.db.select({ language: plots.language }).from(plots).where(eq(plots.id, chat.plotId)).limit(1);
  const model = plot ? embedder.modelFor(plot.language) : null;
  if (!plot || !model) return null;
  const names = [...new Set(images.map((image) => image.name))];
  try {
    const missing = names.filter((name) => !nameVectors.has(`${model}\u0000${name}`));
    if (missing.length > 0) {
      const embedded = await embedder.embed(
        missing.map((name) => EMOTION_EMBEDDING_PREFIX + name),
        { plotLanguage: plot.language, kind: 'document', timeoutMs: EMOTION_TIMEOUT_MS },
      );
      missing.forEach((name, index) => {
        nameVectors.set(`${embedded.model}\u0000${name}`, embedded.vectors[index]!);
        if (nameVectors.size > MAX_NAME_VECTORS) nameVectors.delete(nameVectors.keys().next().value!);
      });
    }
    const query = await embedder.embed([message.content], {
      plotLanguage: plot.language,
      kind: 'query',
      timeoutMs: EMOTION_TIMEOUT_MS,
    });
    const reply = query.vectors[0]!;
    const scores = new Map<string, number>();
    for (const name of names) {
      const vector = nameVectors.get(`${query.model}\u0000${name}`);
      if (vector) scores.set(name, cosine(reply, vector));
    }
    return pickEmotionByEmbedding(images, scores, await recentEmotions(deps, chat.id, message.id, member, roster));
  } catch (error) {
    console.warn('[emotion] the embedder could not choose; the auxiliary model does', error);
    return null;
  }
}

/** The member's pictures on the branch before `messageId`, oldest first, the last few RisuAI holds against a choice. */
async function recentEmotions(
  deps: AppDeps,
  chatId: string,
  messageId: string,
  member: Character,
  roster: readonly Character[],
): Promise<string[]> {
  const all = await deps.db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.createdAt));
  return buildPath(all, messageId)
    .slice(0, -1)
    .filter((earlier) => earlier.emotion !== null && replyMemberOf(earlier, roster)?.id === member.id)
    .map((earlier) => earlier.emotion!)
    .slice(-EMOTION_PENALTY_WINDOW);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    left += a[i]! * a[i]!;
    right += b[i]! * b[i]!;
  }
  return left === 0 || right === 0 ? 0 : dot / Math.sqrt(left * right);
}
