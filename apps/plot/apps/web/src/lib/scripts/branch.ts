/**
 * The whole branch, for a script to read.
 *
 * A chat read answers with the newest window of the branch, and the page pages
 * back only as the reader scrolls. A trigger, though, reads the chat the way
 * RisuAI hands it one — every message after the greeting: `chatindex` counts
 * them, `v2GetMessageAtIndex` indexes them, `exists` with depth 0 searches all
 * of them. So before a script runs on a long chat, the rest of the branch is
 * read in, window by window, and joined on the way the page joins a scrolled-in
 * window (`prependWindow`) — and the page keeps it, so it is read once.
 */

import { prependWindow } from '../chatHistory';
import type { ChatState } from '../types';

/** Messages one read asks for: the API's ceiling. */
export const BRANCH_WINDOW = 500;
/**
 * Reads before giving up, which is a branch of twenty thousand messages. Past it
 * the scripts run on what was read, and count from there.
 */
export const MAX_BRANCH_WINDOWS = 40;

/** `state` with everything before its window read in; `state` itself when nothing was left out. */
export async function loadWholeBranch(
  state: ChatState,
  readBefore: (cursor: string, limit: number) => Promise<ChatState>,
): Promise<ChatState> {
  let current = state;
  for (let read = 0; read < MAX_BRANCH_WINDOWS && current.hasMore; read += 1) {
    const cursor = current.path[0]?.id;
    if (!cursor) break;
    current = prependWindow(current, await readBefore(cursor, BRANCH_WINDOW));
  }
  return current;
}
