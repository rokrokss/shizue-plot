/**
 * Where and how often the author's note goes into the prompt — SillyTavern's
 * per-chat Author's Note settings (`authors-note.js`): its in-chat depth, its
 * insertion frequency and its role. RisuAI's note has no numbers of its own (it is
 * a prompt-template slot with a role), so the union is these three. Defaults are
 * ST's, which were this product's fixed ones: depth 4, every turn, system.
 */

export type AuthorNoteRole = 'system' | 'user' | 'assistant';
export const AUTHOR_NOTE_ROLES: readonly AuthorNoteRole[] = ['system', 'user', 'assistant'];

/** `chats.note_settings`. A key left out is the default. */
export interface AuthorNoteSettings {
  /** How many messages from the end of the history the note sits; 0 is after the last. */
  depth?: number;
  /**
   * Inserted every this many of the reader's messages (ST's `note_interval`):
   * 1 is every turn, 0 is never.
   */
  frequency?: number;
  role?: AuthorNoteRole;
}

/** ST's `MAX_INJECTION_DEPTH`-bounded inputs (`min="0" max="9999"`). */
export const AUTHOR_NOTE_MAX = 9999;

export const AUTHOR_NOTE_DEFAULTS: Required<AuthorNoteSettings> = { depth: 4, frequency: 1, role: 'system' };

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(AUTHOR_NOTE_MAX, Math.max(0, Math.round(value)))
    : undefined;

/**
 * The stored form: numbers rounded and clamped to ST's range, an unknown role
 * dropped, and a value equal to its default left out — so a chat that only ever
 * had the defaults keeps a null column.
 */
export function coerceAuthorNoteSettings(value: unknown): AuthorNoteSettings | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: AuthorNoteSettings = {};
  const depth = count(raw['depth']);
  if (depth !== undefined && depth !== AUTHOR_NOTE_DEFAULTS.depth) out.depth = depth;
  const frequency = count(raw['frequency']);
  if (frequency !== undefined && frequency !== AUTHOR_NOTE_DEFAULTS.frequency) out.frequency = frequency;
  const role = raw['role'];
  if (typeof role === 'string' && (AUTHOR_NOTE_ROLES as readonly string[]).includes(role) && role !== 'system') {
    out.role = role as AuthorNoteRole;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Every setting, the defaults filled in. */
export const authorNoteSettingsOf = (settings: AuthorNoteSettings | null | undefined): Required<AuthorNoteSettings> => ({
  ...AUTHOR_NOTE_DEFAULTS,
  ...settings,
});

/**
 * Whether the note goes into this prompt — ST's `setFloatingPrompt`. `userTurns`
 * is how many of the reader's messages the chat holds (ST counts `is_user` over
 * the whole chat, hidden ones too). Frequency 1 is always; 0 is never; otherwise
 * the note is due when that count is a non-zero multiple of the frequency — the
 * turn the reader's count reaches it, and every that many after.
 */
export function authorNoteDue(frequency: number, userTurns: number): boolean {
  if (frequency === 1) return true;
  if (frequency <= 0 || userTurns <= 0) return false;
  return userTurns % frequency === 0;
}
