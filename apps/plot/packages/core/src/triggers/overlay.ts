/**
 * What a card's scripts rewrote of the work, kept for one chat.
 *
 * RisuAI lets a trigger rewrite the character it belongs to — its description
 * (`v2SetCharacterDesc`), its lorebook (`v2CreateLorebook` and the by-index
 * family), its global note (`v2SetReplaceGlobalNote`) — and the reader's persona
 * (`v2SetPersonaDesc`). There the character is the reader's own copy, so the
 * rewrite simply sticks, in every chat at once. Here the work is the creator's
 * and many readers play it, so a rewrite stays with the chat it happened in
 * (`chats.script_overlay`) and is laid over the work wherever that chat's prompt
 * is assembled. The plot and the reader's persona rows never change.
 *
 * Each field is a whole value, not a list of edits: the browser sends what the
 * scripts left, the server keeps the latest of each, and a field nobody touched
 * is absent and reads through to the work. The cost of whole values is that a
 * field once rewritten no longer follows the creator's later edits of the same
 * field in this chat — which is what RisuAI's own copy would do too.
 */

import type { LoreEntry, NormalizedCard } from '../types.js';

/** One member's rewritten fields. */
export interface MemberOverlay {
  description?: string;
  lorebook?: LoreEntry[];
  /** RisuAI's `replaceGlobalNote`, which is the card's post-history instructions. */
  postHistoryInstructions?: string;
}

export interface ScriptOverlay {
  /** By member id: whose scripts ran is whose card they rewrote. */
  members?: Record<string, MemberOverlay>;
  /** The reader's persona description, as the scripts left it for this chat. */
  persona?: string;
}

const MEMBER_FIELDS = ['description', 'lorebook', 'postHistoryInstructions'] as const;

/**
 * `patch` laid over `overlay`, field by field: a field the patch carries replaces
 * the one before it, and everything else stays. Null when nothing is left.
 */
export function mergeScriptOverlay(
  overlay: ScriptOverlay | null | undefined,
  patch: ScriptOverlay | null | undefined,
): ScriptOverlay | null {
  const members: Record<string, MemberOverlay> = { ...(overlay?.members ?? {}) };
  for (const [id, fields] of Object.entries(patch?.members ?? {})) {
    const merged: MemberOverlay = { ...(members[id] ?? {}) };
    for (const field of MEMBER_FIELDS) {
      if (fields[field] !== undefined) (merged as Record<string, unknown>)[field] = fields[field];
    }
    if (Object.keys(merged).length > 0) members[id] = merged;
  }
  const persona = patch?.persona ?? overlay?.persona;
  const result: ScriptOverlay = {
    ...(Object.keys(members).length > 0 ? { members } : {}),
    ...(persona !== undefined ? { persona } : {}),
  };
  return Object.keys(result).length > 0 ? result : null;
}

/** A member's card with what the scripts rewrote of it in this chat. */
export function overlaidCard<T extends Pick<NormalizedCard, 'description' | 'lorebook' | 'postHistoryInstructions'>>(
  card: T,
  overlay: MemberOverlay | undefined,
): T {
  if (!overlay) return card;
  return {
    ...card,
    ...(overlay.description !== undefined ? { description: overlay.description } : {}),
    ...(overlay.lorebook !== undefined ? { lorebook: overlay.lorebook } : {}),
    ...(overlay.postHistoryInstructions !== undefined
      ? { postHistoryInstructions: overlay.postHistoryInstructions }
      : {}),
  };
}
