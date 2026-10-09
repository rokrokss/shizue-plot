import { isNarration } from '@shizue/core/narration';
import type { MessageRole } from './types';

/** How long a run of turns by one speaker stays one group. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** The calendar day a moment falls on, where the reader is. */
const dayKey = (time: number): string => {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

export interface ChatRowInput {
  role: MessageRole;
  content: string;
  /** ISO timestamp; null while a row is optimistic and not stored yet. */
  createdAt: string | null;
}

export interface ChatRowMeta {
  /** Raw text of the previous message with the same role, for `repeat_back`. */
  previousSameRole: string;
  /** This row's timestamp when a new calendar day starts on it, else null. */
  dayStart: string | null;
  /** Continues the row above it: same speaker, minutes apart, neither narrating. */
  grouped: boolean;
}

/**
 * Everything a row needs from its neighbours, in one pass over the branch. A
 * streamed token rebuilds this on every frame, so what is cheap here matters:
 * anything that scans back from a row would be quadratic in the length of the
 * conversation.
 *
 * A row without a timestamp is one the server has not seen yet — the optimistic
 * bubble and the reply being streamed. It has no day of its own, so it belongs to
 * the day it is being written into and continues the run it was typed into.
 */
export function chatRowMeta(rows: readonly ChatRowInput[]): ChatRowMeta[] {
  const latestByRole = new Map<MessageRole, string>();
  let day = '';
  let previous: { role: MessageRole; time: number | null; narration: boolean } | null = null;

  return rows.map((row) => {
    const previousSameRole = latestByRole.get(row.role) ?? '';
    latestByRole.set(row.role, row.content);

    const narration = isNarration(row.content);
    const time = row.createdAt === null ? null : new Date(row.createdAt).getTime();
    const rowDay = time === null ? day : dayKey(time);
    // Between days only: the first message of a conversation starts nothing.
    const dayStart = day !== '' && rowDay !== day ? row.createdAt : null;
    if (rowDay) day = rowDay;

    // Narration is the scene moving rather than anyone speaking, so it neither
    // joins a run nor continues one — and a divider always begins a new group.
    const grouped =
      previous !== null &&
      dayStart === null &&
      !narration &&
      !previous.narration &&
      previous.role === row.role &&
      (time === null || previous.time === null || time - previous.time < GROUP_WINDOW_MS);
    previous = { role: row.role, time, narration };

    return { previousSameRole, dayStart, grouped };
  });
}

/**
 * Which named day a divider stands for, or null when it is far enough back to be
 * read as a date. The caller owns the words — and the date format.
 */
export function relativeDay(iso: string, now: Date): 'today' | 'yesterday' | null {
  const key = dayKey(new Date(iso).getTime());
  if (key === dayKey(now.getTime())) return 'today';
  const yesterday = new Date(now.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  return key === dayKey(yesterday.getTime()) ? 'yesterday' : null;
}
