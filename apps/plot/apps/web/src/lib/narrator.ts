import { isNarration } from '@shizue/core/narration';
import type { NarratorConfig } from '@shizue/core';
import type { ChatMessage, StreamMode } from './types';

/**
 * The narrator with one field replaced, or null once it says nothing at all.
 *
 * Both editors — the card's and the chat's — have to hand back an absence rather
 * than an empty object when the reader clears the last field: the card drops the
 * key so an untouched card still exports byte-identical, and the chat clears its
 * column so the character's narrator comes back into force. Emptying a field here
 * is what says that, so neither editor has to know it.
 *
 * Only a field that is empty counts as cleared, not one that is merely blank: the
 * card editor runs this on every keystroke, and trimming here would swallow a
 * space the reader is still typing in front of a word. A voice of pure whitespace
 * is dropped by the server, which is where it stops mattering.
 */
export function withNarratorField(
  current: NarratorConfig | null | undefined,
  values: Partial<NarratorConfig>,
): NarratorConfig | null {
  const next: NarratorConfig = { ...current, ...values };
  if (!next.voice) delete next.voice;
  if (!next.pov) delete next.pov;
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * Whether the turn now streaming will be stored as a narration, and so has to be
 * drawn as one while it streams rather than flipping when it lands.
 *
 * Two modes produce one. `narrate` asks for a narration outright; regenerating a
 * narration head answers with another, because the server reads the head the same
 * way and re-applies the nudge — so a swipe never moves between a narration and a
 * line of dialogue. Regenerating under a *user* head is an ordinary reply, and so
 * is every other mode.
 */
export function streamsNarration(mode: StreamMode | null, head: ChatMessage | undefined): boolean {
  if (mode === 'narrate') return true;
  return mode === 'regenerate' && head?.role === 'assistant' && isNarration(head.content);
}
