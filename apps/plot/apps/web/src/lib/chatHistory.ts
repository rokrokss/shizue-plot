import type { ChatMessage, ChatState, Variables } from './types';

/**
 * How the loaded branch grows and how it survives a refetch.
 *
 * The API answers a chat read with the newest window of the branch and a
 * `hasMore` flag; paging back is asking again with the first id of the window
 * already in hand. That leaves the client with two joins to make — the older
 * window arriving at the top, and the head window arriving again after a turn —
 * and both are here rather than in the page, because both are worth testing
 * without a browser.
 */

/**
 * An older window joined to the front of what is on screen. The window ends
 * strictly before the cursor it was asked for, so nothing should overlap; ids
 * already loaded are dropped anyway, because a duplicate row would be a
 * duplicate React key.
 *
 * `chat` stays the one the page is already rendering: the older read is about
 * history, and letting it move the head would be it answering a question it was
 * not asked.
 */
export function prependWindow(current: ChatState, older: ChatState): ChatState {
  const known = new Set(current.path.map((message) => message.id));
  const added = older.path.filter((message) => !known.has(message.id));
  return {
    ...current,
    path: [...added, ...current.path],
    // The older read carries the swipe groups of its own stretch; the current
    // ones win where they overlap, being the fresher answer.
    siblings: { ...older.siblings, ...current.siblings },
    hasMore: older.hasMore ?? false,
  };
}

/**
 * A fresh head window folded onto what was already loaded. The refetch after a
 * turn asks for the newest window, so on a long chat it comes back shorter than
 * what the reader has paged in — and replacing the state with it would take the
 * history back off the screen under them.
 *
 * The seam is the parent of the window's first message. Where the loaded path
 * has it, everything up to and including it is the same branch and is kept, and
 * the window takes over from there: that holds whether the window overlaps what
 * was loaded, continues past its end — two new turns and nothing else — or forks
 * away from it, where the fork point is exactly as far as the two agree.
 *
 * Where the loaded path does not have that parent at all, the two have nothing
 * to be joined by, and the answer is taken whole.
 */
export function mergeRefetched(previous: ChatState | null, next: ChatState): ChatState {
  const head = next.path[0];
  if (!previous || !head?.parentId) return next;
  const seam = previous.path.findIndex((message) => message.id === head.parentId);
  if (seam < 0) return next;
  return {
    ...next,
    path: [...previous.path.slice(0, seam + 1), ...next.path],
    siblings: { ...previous.siblings, ...next.siblings },
    // What is older than the kept stretch has not changed, so neither has the
    // answer to whether there is any.
    hasMore: previous.hasMore ?? false,
  };
}

/**
 * Where the client's own variable fold begins, and what it begins from.
 *
 * The macros of a branch are folded from its first message on, and the client
 * only ever holds a window of it — so the fold has to start at the window rather
 * than at whatever happens to be on screen, over the state the server folded for
 * everything in front of it. Paging older messages in must not move it: those
 * messages are already accounted for in `defaults`, and folding them again would
 * count every `{{addvar}}` in them twice.
 */
export interface VariableAnchor {
  /** First message of the head window this anchor was read from. */
  id: string;
  /** The server's fold over what came before it; absent on an unwindowed read. */
  defaults?: Variables;
}

/** The anchor a fresh read of the head window establishes. */
export function headAnchor(next: ChatState): VariableAnchor | null {
  const head = next.path[0];
  if (!head) return null;
  return { id: head.id, ...(next.variableDefaults ? { defaults: next.variableDefaults } : {}) };
}

/**
 * The stretch of the loaded path the client folds itself, and the state to fold
 * it onto. An anchor the path no longer carries — a fork, a branch switch — is
 * not one, so the whole path is folded over the card's defaults: what every chat
 * short enough never to be windowed does anyway.
 */
export function foldBase(
  path: ChatMessage[],
  anchor: VariableAnchor | null,
  cardDefaults: Variables,
): { messages: ChatMessage[]; defaults: Variables } {
  const at = anchor ? path.findIndex((message) => message.id === anchor.id) : -1;
  if (at < 0) return { messages: path, defaults: cardDefaults };
  return { messages: path.slice(at), defaults: anchor!.defaults ?? cardDefaults };
}
