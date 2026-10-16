import { hybridRanking } from '@shizue/core';
import { follows, plots, plotLikes, plotSearchVectors, user, type ContentLanguage, type Db, type Plot } from '@shizue/db';
import { and, eq, ilike, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';
import { embedErrorForLog } from '../embedder.js';
import { badRequest, notFound } from '../errors.js';
import { RATE_LIMITS, rateLimit } from '../rateLimit.js';
import { pageSnapshotFeed } from '../feedCursor.js';
import { publiclyListed, publicPlotList, publicPlotQuery, type PublicPlotRow } from '../hub.js';
import { noteLexicalSearch } from '../lexicalHealth.js';
import { lexicalPlotIds, scheduleSearchSweep } from '../search.js';
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

/**
 * Search by meaning (`plot_search_vectors`, `search.ts`): a plot is a match
 * when its name contains the query or its text's vector is at least this close
 * to the query's, and at most `MEANING_RESULTS` are ranked, past which nearness
 * says little. Measured on KURE-v1 (ARCHITECTURE §10): the work a query was
 * about scored 0.48–0.72, the others 0.29–0.48.
 */
export const MEANING_MIN_SIMILARITY = 0.45;
const MEANING_RESULTS = 96;
/** How long a search waits to embed its query before it searches the text instead. */
const MEANING_EMBED_TIMEOUT_MS = 3_000;

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

/** A page of a search by meaning: how far into the ranking it starts. */
const encodeMeaningCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ meaning: offset }), 'utf-8').toString('base64url');

/** The offset a search-by-meaning cursor names, or null for any other cursor. */
function meaningOffset(raw: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as { meaning?: unknown } | null;
    const offset = parsed?.meaning;
    return typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

/**
 * One page of explore's search by meaning, or null when it cannot run — no
 * embedder for the partition's language, or the query not embedded in time —
 * and the text search answers instead. The query is embedded with the
 * partition's model, so only the plots of that partition, which embed with the
 * same model, are compared. Every plot the text search would list stays in
 * reach: a name containing the query ranks first, then nearness fused with the
 * search by words (`lexicalPlotIds`) by reciprocal rank.
 */
async function pageByMeaning(
  deps: AppDeps,
  input: { language: ContentLanguage; q: string; filters: SQL[]; viewerId: string | null; limit: number; offset: number },
): Promise<{ rows: PublicPlotRow[]; nextCursor: string | null } | null> {
  const embedder = deps.embedder;
  const model = embedder?.modelFor(input.language);
  if (!embedder || !model) return null;
  let vector: number[];
  try {
    const embedded = await embedder.embed([input.q], {
      plotLanguage: input.language,
      kind: 'query',
      timeoutMs: MEANING_EMBED_TIMEOUT_MS,
    });
    if (embedded.model !== model) return null;
    vector = embedded.vectors[0]!;
  } catch (error) {
    console.warn('[explore] the query could not be embedded; searching the text', embedErrorForLog(error));
    return null;
  }
  scheduleSearchSweep(deps, input.language, model);

  const take = Math.max(0, Math.min(input.limit, MEANING_RESULTS - input.offset));
  if (take === 0) return { rows: [], nextCursor: null };
  const distance = sql`(${plotSearchVectors.embedding} <=> ${JSON.stringify(vector)}::vector)`;
  const named = ilike(plots.name, `%${escapeLike(input.q)}%`);
  const [near, lexical] = await Promise.all([
    deps.db
      .select({ id: plots.id, named: sql<boolean>`${named}` })
      .from(plots)
      // Only a vector of the partition's model: another's is stale, and of another length.
      .leftJoin(plotSearchVectors, and(eq(plotSearchVectors.plotId, plots.id), eq(plotSearchVectors.model, model)))
      .where(and(...input.filters, or(named, sql`1 - ${distance} >= ${MEANING_MIN_SIMILARITY}`)))
      .orderBy(sql`${named} desc`, sql`${distance} asc nulls last`, descNullsLast(plots.id))
      .limit(MEANING_RESULTS),
    lexicalPlotIds(deps.db, input.q, input.filters, MEANING_RESULTS),
  ]);
  noteLexicalSearch('explore', lexical.length > 0);
  // A name holding the query first, then the fusion of nearness and words.
  const names = near.filter((row) => row.named).map((row) => row.id);
  const first = new Set(names);
  const ranking = [
    ...names,
    ...hybridRanking(
      near.filter((row) => !row.named).map((row) => row.id),
      lexical,
    ).filter((id) => !first.has(id)),
  ].slice(0, MEANING_RESULTS);
  const page = ranking.slice(input.offset, input.offset + take);
  const rows =
    page.length === 0
      ? []
      : await publicPlotQuery(deps.db, input.viewerId).where(and(...input.filters, inArray(plots.id, page)));
  const at = new Map(page.map((id, index) => [id, index]));
  rows.sort((a, b) => at.get(a.plot.id)! - at.get(b.plot.id)!);
  const more = input.offset + take < ranking.length;
  return { rows, nextCursor: more ? encodeMeaningCursor(input.offset + take) : null };
}

/**
 * GET /api/explore — the public catalogue of plots, hard-partitioned by content
 * language. Explore *is* plots: a character has no exposure of its own, so
 * there is no second rail beside this one. Ordering is (sort key desc, id desc).
 * `recent` walks it with a keyset cursor; the counter sorts walk a snapshot
 * instead, because the counters move while the reader pages (feedCursor.ts).
 *
 * With `q` the catalogue is searched by meaning where the embedder can
 * (`pageByMeaning`): ranked by nearness, `sort` aside, paged by offset. Where it
 * cannot, the name is searched as text in the chosen sort. `search` says which
 * answered.
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

    /** Everything the catalogue shows this reader, whatever the sort or the search. */
    const filters = (): SQL[] => [
      publiclyListed(),
      eq(plots.language, language),
      ...(tag ? [sql`${plots.tags} @> ARRAY[${tag}]::text[]`] : []),
    ];
    /** …and of those, the ones the text search finds. */
    const listed = (): SQL[] => [...filters(), ...(q ? [ilike(plots.name, `%${escapeLike(q)}%`)] : [])];

    // A text search's cursor goes on as a text search: the reader paging it
    // should not find the ranking changing under them.
    const offset = q ? (rawCursor ? meaningOffset(rawCursor) : 0) : null;
    if (q && offset !== null) {
      const page = await pageByMeaning(deps, { language, q, filters: filters(), viewerId, limit, offset });
      if (page) {
        return c.json({ items: await publicPlotList(deps.db, page.rows), nextCursor: page.nextCursor, search: 'meaning' });
      }
      // The embedder went away mid-walk: the ranking it was paging is gone.
      if (rawCursor) return c.json({ items: [], nextCursor: null, search: 'text' });
    }
    const search = q ? { search: 'text' as const } : {};

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
      return c.json({ items: await publicPlotList(deps.db, items), nextCursor, ...search });
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
      ...search,
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
  app.post('/:userId/follow', requireUser, rateLimit(deps, RATE_LIMITS.social), async (c) => {
    const creatorId = c.req.param('userId')!;
    const userId = c.get('userId');
    // Refused rather than quietly dropped: a self-follow is a client that got
    // the button wrong, and a follower count including yourself is a lie.
    if (creatorId === userId) throw badRequest('invalid_request', 'A creator cannot follow themselves');
    const creator = await loadCreator(deps, creatorId);

    await deps.db.insert(follows).values({ followerId: userId, creatorId: creator.id }).onConflictDoNothing();
    return c.json(await followState(deps.db, creator.id, userId));
  });

  app.delete('/:userId/follow', requireUser, rateLimit(deps, RATE_LIMITS.social), async (c) => {
    const userId = c.get('userId');
    const creator = await loadCreator(deps, c.req.param('userId')!);

    await deps.db
      .delete(follows)
      .where(and(eq(follows.followerId, userId), eq(follows.creatorId, creator.id)));
    return c.json(await followState(deps.db, creator.id, userId));
  });

  return app;
}
