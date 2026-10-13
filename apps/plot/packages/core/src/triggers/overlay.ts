/**
 * What a card's scripts rewrote of the work, kept for one reader on one plot.
 *
 * RisuAI lets a trigger rewrite the character it belongs to — its description
 * (`v2SetCharacterDesc`), its lorebook (`v2CreateLorebook` and the by-index
 * family, all on the character's `globalLore`), its global note
 * (`v2SetReplaceGlobalNote`) — and Lua its description (`setDescription`), its
 * name (`setName`), its first message (`setCharacterFirstMessage`) and the HTML
 * behind the chat (`setBackgroundEmbedding`), and a trigger the reader's persona
 * (`v2SetPersonaDesc`). There the character and the persona are the reader's own
 * objects, so the rewrite simply sticks, in every chat with them at once. Here
 * the work is the creator's and many readers play it, so a rewrite stays with
 * the reader and the plot (`plot_reader_overlays`) — every chat that reader has
 * on it reads it, no other reader does — and is laid over the work wherever one
 * of those chats' prompts is assembled. The plot and the persona rows never
 * change: a persona is the reader's across every work, and a rewrite one work's
 * script made of it must not follow them into another.
 *
 * What RisuAI keeps on the chat stays on the chat: the author's note
 * (`v2SetAuthorNote`, `chats.note`) and the entries Lua's `upsertLocalLoreBook`
 * writes to the chat's `localLore` (`chats.local_lore`, `upsertLocalLore`).
 *
 * Each field is a whole value, not a list of edits: the browser sends what the
 * scripts left, the server keeps the latest of each, and a field nobody touched
 * is absent and reads through to the work. The cost of whole values is that a
 * field once rewritten no longer follows the creator's later edits of the same
 * field for this reader — which is what RisuAI's own copy would do too. Two of
 * the reader's chats open at once each send only the fields their runs touched,
 * so both land; where both touched one, the later write stands, as in RisuAI.
 */

import type { LoreEntry, NormalizedCard } from '../types.js';

/** One member's rewritten fields. */
export interface MemberOverlay {
  description?: string;
  lorebook?: LoreEntry[];
  /** RisuAI's `replaceGlobalNote`, which is the card's post-history instructions. */
  postHistoryInstructions?: string;
  /**
   * RisuAI's `char.name` (`setName`): the member's name for this reader — the name
   * the prompt gives it and its lines go under, and `{{char}}` in its own text
   * where its card sets no nickname. Trimmed (`overlayName`).
   */
  name?: string;
  /**
   * RisuAI's `char.firstMessage` (`setCharacterFirstMessage`): what the plot's
   * first opening reads as for this reader, on a branch that opens on it — RisuAI
   * draws and sends its greeting from the character while the chat is on the
   * first one (`fmIndex` -1). The stored greeting is not rewritten.
   */
  firstMessage?: string;
  /** RisuAI's `char.backgroundHTML` (`setBackgroundEmbedding`): the HTML drawn behind the chat, in place of the card's. */
  backgroundHtml?: string;
}

export interface ScriptOverlay {
  /** By member id: whose scripts ran is whose card they rewrote. */
  members?: Record<string, MemberOverlay>;
  /** The reader's persona description, as the scripts left it on this plot. */
  persona?: string;
}

const MEMBER_FIELDS = ['description', 'lorebook', 'postHistoryInstructions', 'name', 'firstMessage', 'backgroundHtml'] as const;

/**
 * The longest name a script may give a member. A member's own name has no cap,
 * but this one comes from a script, and it is drawn as a speaker label.
 */
export const MAX_OVERLAY_NAME_LENGTH = 100;

/**
 * A name a script gave a member (`setName`) as the overlay keeps it — trimmed, as
 * a member's own name is — or null when it cannot be one: empty, longer than
 * `MAX_OVERLAY_NAME_LENGTH`, or broken over lines (a speaker's name is the start
 * of one line, `speech.ts`).
 */
export function overlayName(value: string): string | null {
  const name = value.trim();
  if (!name || name.length > MAX_OVERLAY_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

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

/** A member's card with what the scripts rewrote of it for this reader. */
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
