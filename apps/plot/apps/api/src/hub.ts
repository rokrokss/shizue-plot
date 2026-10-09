import { stripImageMacros, stripVariableMacros } from '@shizue/core';
import {
  characters,
  plots,
  plotLikes,
  user,
  type Character,
  type Db,
  type Plot,
} from '@shizue/db';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Tx } from './deps.js';
import { notFound } from './errors.js';

/** Caps on the plot's tag column. */
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 20;
/** How much of the first intro a listing card reveals. */
const INTRO_PREVIEW_LENGTH = 200;

/**
 * A member's avatar, addressed under the plot it belongs to: a character has no
 * exposure of its own, so every route that serves one goes through the work that
 * decides who may see it.
 */
export const avatarUrl = (
  character: Pick<Character, 'id' | 'plotId' | 'avatarPath'>,
): string | null =>
  character.avatarPath
    ? `/api/plots/${character.plotId}/characters/${character.id}/avatar`
    : null;

/** The plot's cover; the route serves the bytes, exactly as an avatar's does. */
export const coverUrl = (plot: Pick<Plot, 'id' | 'coverPath'>): string | null =>
  plot.coverPath ? `/api/plots/${plot.id}/cover` : null;

/** The explore filter column: trimmed, de-duped and capped. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const trimmed = tag.trim().slice(0, MAX_TAG_LENGTH);
    if (trimmed) seen.add(trimmed);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

/**
 * An intro as a reader gets it. Image macros go because they are references the
 * reader has no way to resolve, variable macros because they are protocol the
 * model reads rather than prose. Stripping happens before any cut: slicing first
 * can leave half a reference behind.
 */
export const publicIntro = (text: string): string => stripVariableMacros(stripImageMacros(text));

/**
 * Rows any public surface may show. Age verification does not exist yet, so an
 * `adult` plot is published in name only: it stays out of explore, of the
 * creator listings and of every other user's reach until it does. The owner's own
 * access goes through `visibleToViewer` instead, so nothing else has to know the
 * rule.
 */
export const publiclyListed = (): SQL =>
  sql`(${plots.visibility} = 'public' and ${plots.safetyLevel} = 'all')`;

/**
 * Rows the caller may read: their own, plus anyone's publicly listed ones. A
 * reader without an account owns nothing, so for them it is the public rule and
 * only that.
 */
export const visibleToViewer = (viewerId: string | null): SQL =>
  viewerId === null ? publiclyListed() : sql`(${plots.ownerId} = ${viewerId} or ${publiclyListed()})`;

/**
 * Loads a plot the caller may read or chat with. Editing, deleting and
 * publishing stay owner-only through `loadOwnedPlot`.
 */
export async function loadVisiblePlot(db: Db, id: string, viewerId: string | null): Promise<Plot> {
  const [plot] = await db
    .select()
    .from(plots)
    .where(and(eq(plots.id, id), visibleToViewer(viewerId)))
    .limit(1);
  if (!plot) throw notFound('Plot not found');
  return plot;
}

/** A plot's roster, in the creator's order — the order the prompt is written in. */
export async function loadMembers(db: Db | Tx, plotId: string): Promise<Character[]> {
  return db
    .select()
    .from(characters)
    .where(eq(characters.plotId, plotId))
    .orderBy(asc(characters.orderIndex), asc(characters.createdAt));
}

/** The same read for a page of plots at once, grouped by plot id. */
export async function membersByPlot(
  db: Db | Tx,
  plotIds: string[],
): Promise<Map<string, Character[]>> {
  const grouped = new Map<string, Character[]>();
  if (plotIds.length === 0) return grouped;
  const rows = await db
    .select()
    .from(characters)
    .where(inArray(characters.plotId, plotIds))
    .orderBy(asc(characters.orderIndex), asc(characters.createdAt));
  for (const member of rows) {
    const bucket = grouped.get(member.plotId);
    if (bucket) bucket.push(member);
    else grouped.set(member.plotId, [member]);
  }
  return grouped;
}

/** A member as every public surface names one: a face and a name, nothing else. */
export const toPublicMemberJson = (member: Character) => ({
  id: member.id,
  name: member.name,
  avatarUrl: avatarUrl(member),
});

export interface PublicPlotRow {
  plot: Plot;
  creatorName: string;
  likedByMe: boolean;
}

/**
 * The only public shape of a plot. Everything the model is told — description,
 * lorebook, the members' cards — stays with the owner; prompts are assembled
 * server-side, so nothing here leaks a definition.
 */
export const toPublicPlotJson = (row: PublicPlotRow, members: Character[]) => ({
  id: row.plot.id,
  name: row.plot.name,
  coverUrl: coverUrl(row.plot),
  creatorId: row.plot.ownerId,
  creatorName: row.creatorName,
  language: row.plot.language,
  tags: row.plot.tags,
  likeCount: row.plot.likeCount,
  chatCount: row.plot.chatCount,
  // The one field written for readers rather than for the model.
  intro: row.plot.intro,
  // The listings' cut of the first opening. The detail read carries every intro
  // whole instead (`routes/plots.ts`) — a prologue is meant to be read.
  introPreview: publicIntro(row.plot.intros[0] ?? '').slice(0, INTRO_PREVIEW_LENGTH),
  publishedAt: row.plot.publishedAt?.toISOString() ?? null,
  likedByMe: row.likedByMe,
  // The face stack a plot card is read by; the roster is public, the cards are not.
  characters: members.map(toPublicMemberJson),
});

/** A page of listing cards, with one roster read for the whole page. */
export async function publicPlotList(
  db: Db,
  rows: PublicPlotRow[],
): Promise<ReturnType<typeof toPublicPlotJson>[]> {
  const members = await membersByPlot(db, rows.map((row) => row.plot.id));
  return rows.map((row) => toPublicPlotJson(row, members.get(row.plot.id) ?? []));
}

/**
 * Plot rows joined with the creator name and the viewer's like — the source of
 * every public view. Callers add their own `where` / `orderBy` / `limit`, and
 * pass a transaction when the read has to happen inside one (the counter-sorted
 * feeds hold a cursor lock across it).
 */
export function publicPlotQuery(db: Db | Tx, viewerId: string | null) {
  return db
    .select({
      plot: plots,
      creatorName: user.name,
      likedByMe: sql<boolean>`${plotLikes.userId} is not null`,
    })
    .from(plots)
    .innerJoin(user, eq(plots.ownerId, user.id))
    // Nobody signed in: there is no like row to find, so the join is left in
    // place and made empty rather than dropped — the projection has to stay the
    // same shape, and `likedByMe` then comes out false for every row.
    .leftJoin(
      plotLikes,
      viewerId === null
        ? sql`false`
        : and(eq(plotLikes.plotId, plots.id), eq(plotLikes.userId, viewerId)),
    );
}
