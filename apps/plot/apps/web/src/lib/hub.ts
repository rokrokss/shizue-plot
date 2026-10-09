/** Client-side helpers for the plot hub (explore, public pages, tags). */

import type { PublicPlot } from './types';

/** Mirrors the caps `normalizeTags` enforces in apps/api/src/hub.ts. */
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 20;
/** How much of an opening a listing card reveals. */
export const INTRO_PREVIEW_LENGTH = 200;

const normalizeTag = (tag: string): string => tag.trim().slice(0, MAX_TAG_LENGTH);

/** Appends a tag unless it is empty, already present, or over the cap. */
export function addTag(tags: string[], raw: string): string[] {
  const tag = normalizeTag(raw);
  if (!tag || tags.length >= MAX_TAGS || tags.includes(tag)) return tags;
  return [...tags, tag];
}

/** The whole list through `addTag` — what the server stores in `plots.tags`. */
export function normalizeTags(tags: string[]): string[] {
  return tags.reduce<string[]>((kept, tag) => addTag(kept, tag), []);
}

/**
 * Genre tags the product suggests: offered as chips in the tag editor and shown
 * ahead of free tags in the explore filter. They are ordinary tag strings — the
 * server knows nothing about them, and free tags keep working unchanged.
 */
export const RESERVED_TAGS = [
  '로맨스',
  '판타지',
  'BL',
  'GL',
  'HL',
  '일상',
  '공포',
  '미스터리',
  '액션',
  'SF',
  '사극',
  '코미디',
] as const;

const RESERVED_RANK = new Map<string, number>(RESERVED_TAGS.map((tag, index) => [tag, index]));

/** Reserved genres first (in catalogue order), then everything else as it came. */
export function orderTags(tags: string[]): string[] {
  const reserved = tags.filter((tag) => RESERVED_RANK.has(tag));
  reserved.sort((a, b) => RESERVED_RANK.get(a)! - RESERVED_RANK.get(b)!);
  return [...reserved, ...tags.filter((tag) => !RESERVED_RANK.has(tag))];
}

/** Where the per-browser hidden-tag set lives; server-side storage comes later. */
export const HIDDEN_TAGS_KEY = 'shizue.hiddenTags';

/** Reads the hidden set. Anything unreadable is treated as "nothing hidden". */
export function readHiddenTags(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(HIDDEN_TAGS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tag): tag is string => typeof tag === 'string');
  } catch {
    return [];
  }
}

export function writeHiddenTags(tags: string[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(HIDDEN_TAGS_KEY, JSON.stringify(tags));
}

/** Drops every plot carrying a hidden tag. Filtering is per browser, not per query. */
export function withoutHiddenTags(plots: PublicPlot[], hidden: string[]): PublicPlot[] {
  if (hidden.length === 0) return plots;
  const blocked = new Set(hidden);
  return plots.filter((plot) => !plot.tags.some((tag) => blocked.has(tag)));
}

const CHAR_OR_USER = /\{\{\s*(char|user)\s*\}\}/gi;

/**
 * Openings are stored raw — macros are only expanded when the server assembles a
 * prompt — so a page that shows one has to fill them in for display. Only
 * {{char}} and {{user}} have a sensible answer outside a chat, and outside one
 * {{char}} is the work rather than any of its members.
 */
export function fillPreview(text: string, char: string, user: string): string {
  return text.replace(CHAR_OR_USER, (_match, name: string) =>
    name.toLowerCase() === 'char' ? char : user,
  );
}

/** A keyset page of any feed — the plot catalogue. */
interface FeedPage<T> {
  items: T[];
  /** Opaque cursor, or null on the last page. */
  nextCursor: string | null;
}

/**
 * A cursor-paged list and its pagination. Every filter change starts a new
 * generation, and a page only lands if its generation is still the current one —
 * otherwise a slow "load more" from the previous filter would append foreign
 * rows and, worse, replace the new cursor with a stale one.
 *
 * The item type is a parameter because a catalogue page follows the same pagination as
 * explore does; nothing in the state machine ever looks inside an item.
 */
export interface FeedState<T = PublicPlot> {
  generation: number;
  /** null while the first page of this generation is in flight. */
  items: T[] | null;
  cursor: string | null;
  error: string;
}

/** Holds no items yet, so it is the start of a feed of any item type. */
export const initialFeed: FeedState<never> = { generation: 0, items: null, cursor: null, error: '' };

export const restartFeed = <T,>(generation: number): FeedState<T> => ({
  generation,
  items: null,
  cursor: null,
  error: '',
});

export function applyPage<T>(
  state: FeedState<T>,
  generation: number,
  page: FeedPage<T>,
  append: boolean,
): FeedState<T> {
  if (generation !== state.generation) return state;
  return {
    generation,
    items: append ? [...(state.items ?? []), ...page.items] : page.items,
    cursor: page.nextCursor,
    error: '',
  };
}

export function failPage<T>(state: FeedState<T>, generation: number, error: string): FeedState<T> {
  if (generation !== state.generation) return state;
  // A failed first page falls back to the empty state; a failed "load more"
  // keeps what is on screen along with its cursor, so it can be retried.
  return { ...state, items: state.items ?? [], error };
}
