import { comments, plots, user, type Comment, type Db, type Plot } from '@shizue/db';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { loadVisiblePlot } from '../hub.js';
import { requireUser } from '../session.js';
import { isUuid, optionalBoolean, readJsonBody, requireString, requireUuidParam } from '../util.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Cap on one comment's content, as declared in the architecture doc. */
export const MAX_COMMENT_LENGTH = 500;

/** A comment row with the display name of whoever wrote it. */
interface CommentRow {
  comment: Comment;
  authorName: string;
}

/**
 * A deleted comment keeps nothing but its place in the thread: the content is
 * already blank in the database, and the author disappears here as well. It only
 * ever reaches the client while it still anchors replies, as a placeholder.
 */
function toJson(row: CommentRow, viewerId: string | null, ownerId: string, replies: unknown[] = []) {
  const deleted = row.comment.deletedAt !== null;
  return {
    id: row.comment.id,
    parentId: row.comment.parentId,
    content: row.comment.content,
    spoiler: row.comment.spoiler,
    deleted,
    authorName: deleted ? null : row.authorName,
    createdAt: row.comment.createdAt.toISOString(),
    // The author moderates their own words, the creator their own page.
    canDelete: !deleted && (row.comment.userId === viewerId || ownerId === viewerId),
    replies,
  };
}

/** Position in the total order (created_at, id); both are needed to be stable. */
interface Cursor {
  createdAt: string;
  id: string;
}

// Same opaque-cursor contract as explore: base64url JSON the client only ever
// echoes back, so anything unreadable is a bad request.
const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');

function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
  } catch {
    parsed = null;
  }
  const cursor = parsed as Cursor | null;
  if (
    typeof cursor?.createdAt !== 'string' ||
    Number.isNaN(Date.parse(cursor.createdAt)) ||
    typeof cursor.id !== 'string' ||
    // The id reaches Postgres as a uuid; a malformed one is a bad request here,
    // not a cast error there.
    !isUuid(cursor.id)
  ) {
    throw badRequest('invalid_request', 'cursor is not a valid pagination cursor');
  }
  return cursor;
}

/**
 * Everything strictly after the cursor in the total order. The serialized
 * timestamp is only millisecond-precise — Postgres stores microseconds, and the
 * Date the driver hands back has already dropped them — so the boundary is read
 * back from the row the cursor names. Rows sharing that millisecond then compare
 * exactly instead of collapsing onto a truncated value. Only when the row is
 * gone does this fall back to the serialized timestamp, and with it to
 * millisecond precision at that one boundary.
 */
const afterCursor = (cursor: Cursor): SQL =>
  sql`(${comments.createdAt}, ${comments.id}) < (
    coalesce(
      (select boundary.created_at from ${comments} boundary where boundary.id = ${cursor.id}::uuid),
      ${cursor.createdAt}::timestamptz
    ),
    ${cursor.id}::uuid
  )`;

function coerceLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest('invalid_request', `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

const commentQuery = (db: Db) =>
  db
    .select({ comment: comments, authorName: user.name })
    .from(comments)
    .innerJoin(user, eq(comments.userId, user.id));

/**
 * How many comments the page says it has, replies included and deleted ones
 * excluded. A closed comment section shows nothing, so it counts nothing either.
 */
export async function countComments(db: Db, plot: Plot): Promise<number> {
  if (!plot.commentsEnabled) return 0;
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(comments)
    .where(and(eq(comments.plotId, plot.id), isNull(comments.deletedAt)));
  return row?.value ?? 0;
}

/**
 * The parent a reply may attach to: a live top-level comment of this plot.
 * Anything else is either not a comment the caller can see (404) or a second
 * reply level, which does not exist (400).
 */
async function loadParent(db: Db, value: unknown, plotId: string): Promise<string | null> {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest('invalid_request', 'parentId must be a uuid or null');
  if (!isUuid(value)) throw notFound('Comment not found');

  const [parent] = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, value), eq(comments.plotId, plotId), isNull(comments.deletedAt)))
    .limit(1);
  if (!parent) throw notFound('Comment not found');
  if (parent.parentId !== null) {
    throw badRequest('invalid_request', 'parentId must be a top-level comment');
  }
  return parent.id;
}

/**
 * Comments on a plot page, mounted under `/api/plots`. Reading and writing
 * follow the plot's own visibility: everyone who may see it may comment on it,
 * and nobody else may even tell it exists. Reading is where that reaches
 * furthest — the section is part of a public page, so it is legible without an
 * account; writing one is not.
 */
export function plotCommentRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/:id/comments', async (c) => {
    const viewerId = c.get('viewerId');
    const plot = await loadVisiblePlot(deps.db, requireUuidParam(c), viewerId);
    const limit = coerceLimit(c.req.query('limit'));
    const rawCursor = c.req.query('cursor');
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    // A closed section hides the comments that are already there.
    if (!plot.commentsEnabled) return c.json({ items: [], nextCursor: null });

    const rows = await commentQuery(deps.db)
      .where(
        and(
          eq(comments.plotId, plot.id),
          isNull(comments.parentId),
          // A deleted comment survives only as the anchor of a live reply;
          // without one it leaves the listing altogether.
          sql`(${comments.deletedAt} is null or exists (
            select 1 from ${comments} reply
            where reply.parent_id = ${comments.id} and reply.deleted_at is null
          ))`,
          ...(cursor ? [afterCursor(cursor)] : []),
        ),
      )
      .orderBy(desc(comments.createdAt), desc(comments.id))
      // One extra row answers "is there a next page?" without a second query.
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const parentIds = page.map((row) => row.comment.id);
    // Replies are never paginated: a thread is one level deep and short by design.
    const replies = parentIds.length
      ? await commentQuery(deps.db)
          .where(and(inArray(comments.parentId, parentIds), isNull(comments.deletedAt)))
          .orderBy(asc(comments.createdAt), asc(comments.id))
      : [];

    const byParent = new Map<string, CommentRow[]>();
    for (const reply of replies) {
      const bucket = byParent.get(reply.comment.parentId!) ?? [];
      bucket.push(reply);
      byParent.set(reply.comment.parentId!, bucket);
    }

    const last = page[page.length - 1];
    return c.json({
      items: page.map((row) =>
        toJson(
          row,
          viewerId,
          plot.ownerId,
          (byParent.get(row.comment.id) ?? []).map((reply) => toJson(reply, viewerId, plot.ownerId)),
        ),
      ),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.comment.createdAt.toISOString(), id: last.comment.id })
          : null,
    });
  });

  app.post('/:id/comments', requireUser, async (c) => {
    const userId = c.get('userId');
    const plot = await loadVisiblePlot(deps.db, requireUuidParam(c), userId);
    if (!plot.commentsEnabled) {
      throw forbidden('comments_disabled', 'This plot does not accept comments');
    }

    const body = await readJsonBody(c);
    const content = requireString(body, 'content').trim();
    if (!content) throw badRequest('invalid_request', 'content must not be empty');
    if (content.length > MAX_COMMENT_LENGTH) {
      throw badRequest('comment_limit', `content must be at most ${MAX_COMMENT_LENGTH} characters`);
    }
    const parentId = await loadParent(deps.db, body['parentId'], plot.id);

    const [created] = await deps.db
      .insert(comments)
      .values({
        plotId: plot.id,
        userId,
        parentId,
        content,
        spoiler: optionalBoolean(body, 'spoiler') ?? false,
      })
      .returning();
    const [author] = await deps.db.select({ name: user.name }).from(user).where(eq(user.id, userId));

    return c.json(toJson({ comment: created!, authorName: author!.name }, userId, plot.ownerId), 201);
  });

  return app;
}

/** DELETE /api/comments/:id — soft, and only for the author or the creator. */
export function commentRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.delete('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const [row] = await deps.db
      .select({ comment: comments, ownerId: plots.ownerId })
      .from(comments)
      .innerJoin(plots, eq(comments.plotId, plots.id))
      .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
      .limit(1);
    // To anyone but the author and the plot's owner it is simply not there.
    if (!row || (row.comment.userId !== userId && row.ownerId !== userId)) {
      throw notFound('Comment not found');
    }

    // Soft only in the sense that the row stays: the words themselves are gone,
    // and the spoiler flag with them, so the placeholder has nothing left to hide.
    await deps.db
      .update(comments)
      .set({ deletedAt: new Date(), content: '', spoiler: false })
      .where(eq(comments.id, id));
    return c.body(null, 204);
  });

  return app;
}
