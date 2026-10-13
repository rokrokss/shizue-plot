/**
 * A pending reply that took the tab down with it is not finished a second time.
 *
 * Finishing a reply runs the card's regular expressions over what the model
 * wrote, on this thread, and a pattern that backtracks without end hangs the
 * tab. The reply is still pending when the reader reloads, and finishing it on
 * load would hang the tab again, every time the chat is opened. So the attempt is
 * marked in the session's storage before it starts and unmarked when it ends, and
 * a mark found on load means the last attempt never ended: that reply is given
 * up — committed as the model wrote it — instead of being run again.
 *
 * Storage that cannot be reached (a private window, a blocked origin) marks
 * nothing, and the reply is simply finished as usual.
 */

export const FINISH_MARK_PREFIX = 'shizue-script-finish:';

const keyOf = (messageId: string, scriptRev: number): string => `${FINISH_MARK_PREFIX}${messageId}:${scriptRev}`;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function markFinish(messageId: string, scriptRev: number): void {
  try {
    storage()?.setItem(keyOf(messageId, scriptRev), '1');
  } catch {
    // Nothing to remember it in; the attempt goes ahead unguarded.
  }
}

export function unmarkFinish(messageId: string, scriptRev: number): void {
  try {
    storage()?.removeItem(keyOf(messageId, scriptRev));
  } catch {
    // As above.
  }
}

/** Whether an attempt at this revision started and never ended. */
export function finishMarked(messageId: string, scriptRev: number): boolean {
  try {
    return storage()?.getItem(keyOf(messageId, scriptRev)) === '1';
  } catch {
    return false;
  }
}
