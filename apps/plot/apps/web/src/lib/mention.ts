import { NARRATOR_NAMES } from '@shizue/core/speech';

/**
 * Zeta's write-as, typed: a line the reader opens with `@이름:` is that member's
 * line, and `@:` is the narrator's (core `readerLine`). While the reader is
 * still typing the name — after the `@` that opens the line, before its `:` —
 * the composer offers the names it would be read by.
 */

/** The `@이름` being typed at the caret: where its `@` is, and what follows it. */
export interface Mention {
  start: number;
  query: string;
}

/** What can follow the `@`: a member's name, or the narrator (`name` ''). */
export interface MentionOption {
  key: string;
  label: string;
  /** What is written after the `@`; '' writes the narrator's `@:`. */
  name: string;
  /** Every name the line is read by, for matching what was typed. */
  names: readonly string[];
  avatarUrl?: string | null;
}

/** The `@`, then up to a name's length of anything but the `:` that would close it. */
const OPEN_MENTION_RE = /^[ \t]*@([^:：\n@]{0,40})$/;

export function mentionAt(text: string, caret: number): Mention | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const head = text.slice(lineStart, caret);
  const match = OPEN_MENTION_RE.exec(head);
  if (!match) return null;
  return { start: lineStart + head.indexOf('@'), query: match[1]!.trim() };
}

const fold = (value: string): string => value.trim().toLowerCase();

/** The options whose names begin with what was typed, members first, in their order. */
export function matchMentions(options: readonly MentionOption[], query: string): MentionOption[] {
  const typed = fold(query);
  if (!typed) return [...options];
  return options.filter((option) => option.names.some((name) => fold(name).startsWith(typed)));
}

/** The narrator's option, read by any of its names (`NARRATOR_NAMES`). */
export function narratorOption(label: string): MentionOption {
  return { key: 'narrator', label, name: '', names: [label, ...NARRATOR_NAMES] };
}

/** The text with the typed `@이름` replaced by the whole marker, and where the caret goes. */
export function applyMention(text: string, mention: Mention, caret: number, option: MentionOption): { value: string; caret: number } {
  const marker = `@${option.name}: `;
  return { value: text.slice(0, mention.start) + marker + text.slice(caret), caret: mention.start + marker.length };
}
