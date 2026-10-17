/**
 * The chat's emotion screen (RisuAI's `viewScreen: 'emotion'`, `@shizue/core`
 * `emotion.ts`): which picture each member shows on the branch on screen, and
 * which replies are still waiting for theirs.
 *
 * A reply carries the name of the picture its member wears after it
 * (`ChatMessage.emotion`), so the branch is the whole record: a member shows
 * the picture of its newest reply on the branch that has one, and before any —
 * as RisuAI's `defaultEmotion` — the one named `neutral`, or none.
 */

import { defaultEmotion } from '@shizue/core/emotion';
import { isNarration } from '@shizue/core/narration';
import type { AssetResolver } from './assets';
import type { ChatMessage, EmotionImage, PublicMember } from './types';

/** One member's place in the panel. */
export interface EmotionSlot {
  memberId: string;
  name: string;
  /** The picture's name, or null when there is none to show. */
  emotion: string | null;
  /** Its image, or null — none chosen and no `neutral`, or not open in this chat. */
  src: string | null;
}

/** The members whose pictures stand in the panel, in the roster's order. */
export const panelMembers = (members: readonly PublicMember[]): PublicMember[] =>
  members.filter((member) => member.emotion?.mode === 'panel');

/**
 * Whose reply a message is: a group reply's speaker, or the one member of a
 * work of one — never a narration or a message a card's script wrote. Only such
 * a reply ever carries a picture (the API's `replyMemberOf`).
 */
function ownerOf(message: ChatMessage, roster: readonly PublicMember[]): string | null {
  if (message.role !== 'assistant' || message.source === 'script' || isNarration(message.content)) return null;
  return message.speakerMemberId ?? (roster.length === 1 ? roster[0]!.id : null);
}

/**
 * What each panel member shows on this branch. `assets` is the chat's images by slug.
 */
export function emotionSlots(
  path: readonly ChatMessage[],
  roster: readonly PublicMember[],
  assets: ReadonlyMap<string, string>,
): EmotionSlot[] {
  return panelMembers(roster).map((member) => {
    const images: readonly EmotionImage[] = member.emotion?.images ?? [];
    const latest = path.findLast((message) => message.emotion && ownerOf(message, roster) === member.id)?.emotion;
    const image = latest ? images.find((candidate) => candidate.name === latest) : defaultEmotion(images);
    return {
      memberId: member.id,
      name: member.name,
      emotion: image?.name ?? null,
      src: image ? (assets.get(image.slug) ?? null) : null,
    };
  });
}

/**
 * The replies on this branch whose picture is still being chosen: ones this
 * page just saw finish (`fresh`), by a panel member, with none yet and no
 * output scripts still owed — those are finished first, and the choice follows.
 */
export function awaitingEmotion(
  path: readonly ChatMessage[],
  roster: readonly PublicMember[],
  fresh: ReadonlySet<string>,
): string[] {
  if (fresh.size === 0) return [];
  const panel = new Set(panelMembers(roster).map((member) => member.id));
  return path
    .filter(
      (message) =>
        fresh.has(message.id) &&
        !message.emotion &&
        message.scriptState !== 'pending' &&
        panel.has(ownerOf(message, roster) ?? ''),
    )
    .map((message) => message.id);
}

/** The branch with the pictures the server has since chosen. */
export function withEmotions<T extends { path: ChatMessage[] }>(state: T, chosen: ReadonlyMap<string, string>): T {
  if (!state.path.some((message) => chosen.has(message.id))) return state;
  return {
    ...state,
    path: state.path.map((message) => (chosen.has(message.id) ? { ...message, emotion: chosen.get(message.id)! } : message)),
  };
}

/**
 * A member's own pictures first for `{{emotion::name}}` in its replies, by name
 * without case — RisuAI looks an emotion up among the replying character's
 * emotions alone, so a second member's `happy` is its own and not the first's.
 * Everything else, and a name the member has no picture for, as `fallback` reads it.
 */
export function emotionResolver(images: readonly EmotionImage[], fallback: AssetResolver): AssetResolver {
  return (ref, macro) => {
    if (macro === 'emotion') {
      const name = ref.trim().toLocaleLowerCase();
      const own = images.find((image) => image.name.toLocaleLowerCase() === name);
      if (own) return own.slug;
    }
    return fallback(ref, macro);
  };
}

const COLLAPSED_KEY = 'shizue.emotionCollapsed.';

/** Whether the reader folded this chat's panel away (narrow screens only). */
export function readEmotionCollapsed(chatId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSED_KEY + chatId) === '1';
  } catch {
    return false;
  }
}

export function writeEmotionCollapsed(chatId: string, collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSED_KEY + chatId, '1');
    else window.localStorage.removeItem(COLLAPSED_KEY + chatId);
  } catch {
    // Blocked site data: the panel folds for this visit only.
  }
}
