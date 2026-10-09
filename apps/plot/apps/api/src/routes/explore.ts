import { follows, plots, plotLikes, user, type Db, type Plot } from '@shizue/db';
import { and, eq, ilike, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';
import { badRequest, notFound } from '../errors.js';
import { pageSnapshotFeed } from '../feedCursor.js';
import { publiclyListed, publicPlotList, publicPlotQuery } from '../hub.js';
import { requireUser } from '../session.js';
import { isUuid } from '../util.js';
import { requireLanguage } from './plots.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;

const SORTS = ['recent', 'chats', 'likes', 'weekly'] as const;
type Sort = (typeof SORTS)[number];

/** The counter sorts, each on a column the plot row carries. */
const SORT_COLUMNS = {
  chats: plots.chatCount,
  likes: plots.likeCount,
} as const;

/** How far back 주간 인기 counts a like. */
const WEEKLY_WINDOW = sql`interval '7 days'`;

/**
 * Likes this plot collected in the trailing week. Derived on every read rather
 * than kept in a column: a windowed counter has to be decremented by the passage
 * of time, which nothing here is awake to do. The subquery costs one index range
 * per candidate row, which the snapshot walk already bounds to a page at a time.
 */
const weeklyLikes = (): SQL => sql`(
  select count(*) from ${plotLikes} weekly
  where weekly.plot_id = ${plots.id} and weekly.created_at >= now() - ${WEEKLY_WINDOW}
)`;

/**
 * Position in the `recent` order (published_at, id); both are needed to be
 * stable. The counter sorts do not use a keyset cursor at all — see feedCursor.ts.
 */
interface Cursor {
  value: string;
  id: string;
}

const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');

/** Cursors are opaque to the client, so anything unreadable is a bad request. */
function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
  } catch {
    parsed = null;
  }
  const cursor = parsed as Cursor | null;
  // The id reaches Postgres as a uuid; a malformed one is a bad request here,
  // not a cast error there.
  if (
    typeof cursor?.value !== 'string' ||
    Number.isNaN(Date.parse(cursor.value)) ||
    typeof cursor.id !== 'string' ||
    !isUuid(cursor.id)
  ) {
    throw badRequest('invalid_request', 'cursor is not a valid pagination cursor');
  }
  return cursor;
}

const cursorOf = (plot: Plot): Cursor => ({
  value: plot.publishedAt?.toISOString() ?? '',
  id: plot.id,
});

/**
 * Descending, nulls last — the exact ordering the explore indexes carry. Plain
 * `desc()` means nulls first, which the planner cannot match, so it would sort
 * every tie group instead of seeking into it.
 */
export const descNullsLast = (column: PgColumn): SQL => sql`${column} desc nulls last`;

/**
 * Feed order for a sort the counters move under. 주간 인기 ranks on the trailing
 * week and breaks its ties on the total, so a work everyone liked once still
 * outranks one nobody has liked at all — the window decides who is rising, the
 * total decides between equals.
 */
const snapshotOrder = (sort: Exclude<Sort, 'recent'>): SQL[] =>
  sort === 'weekly'
    ? [sql`${weeklyLikes()} desc`, descNullsLast(plots.likeCount), descNullsLast(plots.id)]
    : [descNullsLast(SORT_COLUMNS[sort]), descNullsLast(plots.id)];

/**
 * Keyset predicate: everything strictly after the cursor in the `recent` order.
 *
 * A publish date does not survive the round trip: it is serialized at millisecond
 * precision while Postgres stores microseconds, so the boundary is read back from
 * the plot the cursor names and rows sharing that millisecond compare exactly. A
 * plot that has since been deleted falls back to the serialized value, and with
 * it to millisecond precision at that one boundary.
 */
function afterCursor(cursor: Cursor): SQL {
  const value = sql`coalesce(
    (select boundary.published_at from ${plots} boundary where boundary.id = ${cursor.id}::uuid),
    ${cursor.value}::timestamptz
  )`;
  return sql`(${plots.publishedAt}, ${plots.id}) < (${value}, ${cursor.id}::uuid)`;
}

function coerceSort(value: string | undefined): Sort {
  if (value === undefined) return 'recent';
  if (!SORTS.includes(value as Sort)) {
    throw badRequest('invalid_request', `sort must be one of ${SORTS.join(', ')}`);
  }
  return value as Sort;
}

function coerceLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest('invalid_request', `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

/** LIKE wildcards in user input are literal characters, not operators. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

/**
 * GET /api/explore — the public catalogue of plots, hard-partitioned by content
 * language. Explore *is* plots: a character has no exposure of its own, so
 * there is no second rail beside this one. Ordering is (sort key desc, id desc).
 * `recent` walks it with a keyset cursor; the counter sorts walk a snapshot
 * instead, because the counters move while the reader pages (feedCursor.ts).
 */
export function exploreRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const language = requireLanguage(c.req.query('language'));
    const sort = coerceSort(c.req.query('sort'));
    const limit = coerceLimit(c.req.query('limit'));
    const q = c.req.query('q')?.trim();
    const tag = c.req.query('tag')?.trim();
    const rawCursor = c.req.query('cursor');
    const viewerId = c.get('viewerId');

    /** Everything the catalogue shows this reader, whatever the sort. */
    const listed = (): SQL[] => [
      publiclyListed(),
      eq(plots.language, language),
      ...(q ? [ilike(plots.name, `%${escapeLike(q)}%`)] : []),
      ...(tag ? [sql`${plots.tags} @> ARRAY[${tag}]::text[]`] : []),
    ];

    if (sort !== 'recent') {
      const { items, nextCursor } = await pageSnapshotFeed(deps.db, rawCursor, limit, {
        top: (reader, exclude, take) =>
          publicPlotQuery(reader, viewerId)
            .where(and(...listed(), notInArray(plots.id, exclude)))
            .orderBy(...snapshotOrder(sort))
            .limit(take),
        byIds: (reader, ids) =>
          publicPlotQuery(reader, viewerId).where(and(...listed(), inArray(plots.id, ids))),
        idOf: (row) => row.plot.id,
      });
      return c.json({ items: await publicPlotList(deps.db, items), nextCursor });
    }

    const rows = await publicPlotQuery(deps.db, viewerId)
      .where(and(...listed(), ...(rawCursor ? [afterCursor(decodeCursor(rawCursor))] : [])))
      .orderBy(descNullsLast(plots.publishedAt), descNullsLast(plots.id))
      // One extra row answers "is there a next page?" without a second count query.
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      items: await publicPlotList(deps.db, page),
      nextCursor: rows.length > limit && last ? encodeCursor(cursorOf(last.plot)) : null,
    });
  });

  return app;
}

/** The creator page's subject; anyone else's id is simply not a creator page. */
async function loadCreator(deps: AppDeps, userId: string): Promise<{ id: string; name: string }> {
  const [creator] = await deps.db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!creator) throw notFound('Creator not found');
  return creator;
}

/**
 * How many follow this creator, and whether the reader is one of them — one read
 * over the same rows. A reader without an account follows nobody, so the join
 * condition is made constantly false rather than parameterized with a null.
 */
export async function followState(
  db: Db,
  creatorId: string,
  viewerId: string | null,
): Promise<{ followerCount: number; followedByMe: boolean }> {
  const [row] = await db
    .select({
      followerCount: sql<number>`count(*)::int`,
      followedByMe:
        viewerId === null
          ? sql<boolean>`false`
          : sql<boolean>`coalesce(bool_or(${follows.followerId} = ${viewerId}), false)`,
    })
    .from(follows)
    .where(eq(follows.creatorId, creatorId));
  return { followerCount: row?.followerCount ?? 0, followedByMe: row?.followedByMe ?? false };
}

/**
 * A creator: everything they have published, and the follow edge between them
 * and whoever is reading. The page itself is public — following is not, and
 * carries `requireUser` route by route like the plot router does.
 */
export function creatorRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/:userId', async (c) => {
    const viewerId = c.get('viewerId');
    const creator = await loadCreator(deps, c.req.param('userId')!);

    const rows = await publicPlotQuery(deps.db, viewerId)
      .where(and(eq(plots.ownerId, creator.id), publiclyListed()))
      .orderBy(descNullsLast(plots.publishedAt), descNullsLast(plots.id));

    return c.json({
      id: creator.id,
      name: creator.name,
      ...(await followState(deps.db, creator.id, viewerId)),
      publicPlots: await publicPlotList(deps.db, rows),
    });
  });

  // Idempotent, like the plot like: the pair is the key, so following twice is
  // the same row and both calls answer with the state that now holds.
  app.post('/:userId/follow', requireUser, async (c) => {
    const creatorId = c.req.param('userId')!;
    const userId = c.get('userId');
    // Refused rather than quietly dropped: a self-follow is a client that got
    // the button wrong, and a follower count including yourself is a lie.
    if (creatorId === userId) throw badRequest('invalid_request', 'A creator cannot follow themselves');
    const creator = await loadCreator(deps, creatorId);

    await deps.db.insert(follows).values({ followerId: userId, creatorId: creator.id }).onConflictDoNothing();
    return c.json(await followState(deps.db, creator.id, userId));
  });

  app.delete('/:userId/follow', requireUser, async (c) => {
    const userId = c.get('userId');
    const creator = await loadCreator(deps, c.req.param('userId')!);

    await deps.db
      .delete(follows)
      .where(and(eq(follows.followerId, userId), eq(follows.creatorId, creator.id)));
    return c.json(await followState(deps.db, creator.id, userId));
  });

  return app;
}
