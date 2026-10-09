/**
 * Scenes — the run of turns a reader edits as one block.
 *
 * A scene is whatever moves without the reader speaking: the character's turns,
 * and narration whoever wrote it. The reader's own dialogue is the break, so a
 * path reads as scenes separated by the lines the reader said out loud. Like
 * narration itself this is a convention over the stored messages and not a
 * column — the same grouping the browser draws is the one the server validates
 * an edit against.
 */
import { isNarration } from './narration.js';

/** What scene grouping reads of a message: who sent it, and what it says. */
export interface SceneMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A run of the path as a half-open `[start, end)` range. */
export interface SceneSpan {
  start: number;
  end: number;
}

/** Whether a turn belongs to a scene rather than breaking one. */
export function isSceneMessage(message: SceneMessage): boolean {
  return message.role === 'assistant' || isNarration(message.content);
}

/**
 * The maximal scene the message at `index` sits in, or null when that message is
 * the reader's own dialogue — grouping the path into scenes, one lookup at a time,
 * which is the shape both the editor and the edit's validation need.
 */
export function sceneSpanAt(path: readonly SceneMessage[], index: number): SceneSpan | null {
  const at = path[index];
  if (!at || !isSceneMessage(at)) return null;
  let start = index;
  while (start > 0 && isSceneMessage(path[start - 1]!)) start -= 1;
  let end = index + 1;
  while (end < path.length && isSceneMessage(path[end]!)) end += 1;
  return { start, end };
}
