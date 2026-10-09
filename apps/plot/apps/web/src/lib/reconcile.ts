import type { ChatState } from './types';

/**
 * What to do with the composer after a send request was rejected. A rejection
 * only proves the client never read a stream — the POST may still have been
 * accepted and the user turn inserted — so the head is reconciled instead of
 * assumed.
 */
type SendRecovery =
  /** The turn landed. Keep the composer empty; `retry` offers regenerate. */
  | { kind: 'delivered'; retry: boolean }
  /** The head did not move: nothing was stored, so give the text back. */
  | { kind: 'notDelivered' }
  /** The reconcile refetch failed too. Give the text back, but warn. */
  | { kind: 'unknown' };

/**
 * @param headBefore `chat.headMessageId` captured before the request went out.
 * @param refreshed  Chat state fetched after the rejection, or null if that failed.
 */
export function reconcileSend(headBefore: string | null, refreshed: ChatState | null): SendRecovery {
  if (!refreshed) return { kind: 'unknown' };
  if (refreshed.chat.headMessageId === headBefore) return { kind: 'notDelivered' };

  // The head moved. A user message on top means the turn was stored but never
  // answered, which is exactly the state `regenerate` is documented to retry.
  const head = refreshed.path[refreshed.path.length - 1];
  return { kind: 'delivered', retry: head?.role === 'user' };
}
