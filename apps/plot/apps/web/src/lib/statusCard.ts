/**
 * Whether this chat's 상태창 cards are folded away.
 *
 * Per chat and per browser, like the custom-UI opt-out next door: the card is the
 * same handful of rows every turn, so a reader who folds one is saying it about
 * the conversation and not about that message. Kept out of the chat row on
 * purpose — it is a way of reading, not a setting of the plot.
 */

/** One key per chat, so folding one conversation's cards leaves the rest open. */
const statusCollapsedKey = (chatId: string): string => `shizue.statusCollapsed.${chatId}`;

/** Cards are open until this browser folded this chat's. */
export function readStatusCollapsed(chatId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(statusCollapsedKey(chatId)) === '1';
  } catch {
    return false;
  }
}

export function writeStatusCollapsed(chatId: string, collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(statusCollapsedKey(chatId), collapsed ? '1' : '0');
  } catch {
    // A browser with storage refused still folds the card for this reading.
  }
}
