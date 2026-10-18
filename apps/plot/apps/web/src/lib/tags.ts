/** A plot's tags, as the studio's tag editor writes them. */

/** Mirrors the caps `normalizeTags` enforces in apps/api/src/hub.ts. */
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 20;

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
 * Genre tags the product suggests, offered as chips in the tag editor. They are
 * ordinary tag strings — the server knows nothing about them.
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
