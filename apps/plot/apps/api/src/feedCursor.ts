import { feedCursors, type Db } from '@shizue/db';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from './deps.js';
import { badRequest } from './errors.js';
import { isUuid } from './util.js';

/**
 * Stable paging over a feed whose sort key moves while the reader walks it —
 * explore's `likes`/`chats`. The
 * two feeds cannot drift apart.
 *
 * ## Why a keyset cursor cannot do this
 *
 * The order is (counter desc, id desc) and the cursor names a boundary in it. A
 * row that gains likes crosses the boundary upwards and is never returned; one
 * that loses them crosses downwards and is returned twice. Pinning the counter
 * value the cursor was issued against does not fix it: the pinned value describes
 * the *boundary*, and the rows moving are the other ones — a row that jumps over
 * a pinned boundary is still on the wrong side of it. Nothing a cursor carries
 * about a single row can decide about rows it has never seen, so the walk has to
 * remember what it has already handed out. That is per-reader state, and the only
 * places to keep it are the cursor itself or the database.
 *
 * ## What this does instead
 *
 * Page one is not a walk. It is served straight from the live query and writes
 * nothing; its `nextCursor` carries that page's ids inline (a *seed* cursor). Only
 * when a reader actually comes back for page two does a `feed_cursors` row appear,
 * seeded with those ids. Most readers never page, and they cost exactly what they
 * did before.
 *
 * From there the row holds `seen`: every id handed out, in order. The cursor is
 * `{session, offset}` — the session names the row, the offset says how far into it
 * the reader has read. A page is `seen[offset .. offset+limit]` replayed when it
 * has already been produced, and otherwise the top rows the live query returns
 * that are not in `seen` yet, appended to it.
 *
 * That gives exactly the property asked for. Every page is a slice of a growing
 * ordered list no row ever appears in twice, and a page is only ever extended
 * with rows outside it, so the walk ends when — and only when — the query has no
 * unseen row left. Counters may move as much as they like underneath.
 *
 * ## The lock
 *
 * Loading `seen`, selecting the page, appending to `seen` and deciding what the
 * next cursor is all happen inside one transaction, under `for update` on the
 * cursor row. That is not belt-and-braces: two requests consuming the same offset
 * would otherwise both select against the same `seen`, get *different* candidates
 * because a counter moved between them, and each append and advance by its own
 * count — leaving an offset that indexes neither ordering, which duplicates ids
 * and drops others. Serialized, the second request finds the first's rows already
 * in `seen` and replays them, so a retry is exactly a retry.
 *
 * The lock is per-walk, so it serializes one reader against themselves and nobody
 * else. It is held across the feed query, which is the query that request was
 * going to run regardless.
 *
 * ## What it costs
 *
 * - A seed cursor carries a page of ids, so it is larger than a keyset cursor:
 *   about 1 KB at the default limit and 2.5 KB at the maximum. Bounded by `limit`,
 *   never by walk depth — every later cursor is just a session id and an offset.
 * - Consuming the same seed cursor twice opens two walks rather than sharing one.
 *   Each is internally consistent, and the one the client drops expires. The walks
 *   cannot be shared: every reader's page one looks alike, so keying a walk on its
 *   contents would hand strangers each other's snapshot.
 * - The keyset predicate is gone for these sorts. The query still reads the feed
 *   index in order, but it walks past the rows already handed out instead of
 *   seeking over them, so page N costs O(N x limit) skipped rows. Fine for the
 *   handful of pages a reader actually walks, and it degrades smoothly rather
 *   than falling off a cliff; `sort=recent` keeps its seek and is untouched.
 * - `seen` is passed back as a `not in (...)` list, so a walk is bounded by
 *   Postgres' parameter limit — tens of thousands of rows deep, far past where
 *   the scan cost would have stopped anyone anyway.
 * - Rows published mid-walk are visible to it (they are simply unseen rows); rows
 *   deleted mid-walk drop out of a replayed page. Neither breaks the property.
 * - Abandoned walks are collected by TTL. There are no background jobs here, so
 *   opening a walk sweeps — but a capped batch of them, never the backlog.
 */

/** How long a walk may sit idle before its snapshot is collected. */
const WALK_TTL = sql`interval '1 hour'`;

/**
 * Expired walks collected per walk opened. Bounded on purpose: an unbounded sweep
 * would make the first request after a quiet hour pay for the whole backlog,
 * arrays and all, before it could answer. Opening a walk creates one row and
 * collects up to fifty, so a backlog can only ever shrink.
 */
const COLLECT_BATCH = 50;

/** Page one's ids, handed to the client so page two can seed a walk from them. */
interface SeedCursor {
  seen: string[];
}

/** Position in an open walk: which snapshot, and how far into it. */
interface WalkCursor {
  session: string;
  offset: number;
}

type SnapshotCursor = SeedCursor | WalkCursor;

const encodeCursor = (cursor: SnapshotCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');

/** Cursors are opaque to the client, so anything unreadable is a bad request. */
function decodeCursor(raw: string): SnapshotCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
  } catch {
    parsed = null;
  }
  const cursor = parsed as Partial<SeedCursor & WalkCursor> | null;
  // The ids reach Postgres as uuids; a malformed one is a bad request here, not a
  // cast error there.
  if (Array.isArray(cursor?.seen) && cursor.seen.every((id) => typeof id === 'string' && isUuid(id))) {
    return { seen: cursor.seen };
  }
  if (
    typeof cursor?.session === 'string' &&
    isUuid(cursor.session) &&
    Number.isInteger(cursor.offset) &&
    cursor.offset! >= 0
  ) {
    return { session: cursor.session, offset: cursor.offset! };
  }
  throw badRequest('invalid_request', 'cursor is not a valid pagination cursor');
}

/** A `Db` or the open transaction a walk holds; the feed reads run on either. */
export type FeedReader = Db | Tx;

/** The two reads a feed has to offer for its rows to be walked this way. */
export interface SnapshotFeed<T> {
  /** The top `take` rows in feed order, skipping the ids already handed out. */
  top: (reader: FeedReader, exclude: string[], take: number) => Promise<T[]>;
  /** Those rows, in any order — the walk puts them back in snapshot order. */
  byIds: (reader: FeedReader, ids: string[]) => Promise<T[]>;
  idOf: (row: T) => string;
}

/** Collects a capped batch of walks nobody came back to. */
async function collectExpired(db: Db): Promise<void> {
  await db.delete(feedCursors).where(
    inArray(
      feedCursors.id,
      db
        .select({ id: feedCursors.id })
        .from(feedCursors)
        .where(sql`${feedCursors.updatedAt} < now() - ${WALK_TTL}`)
        .limit(COLLECT_BATCH),
    ),
  );
}

/**
 * The walk this cursor belongs to, locked for the rest of the transaction. A seed
 * cursor opens one; the freshly inserted row is nobody else's to contend for.
 */
async function lockWalk(tx: Tx, cursor: SnapshotCursor): Promise<{ session: string; seen: string[] }> {
  if ('seen' in cursor) {
    const [opened] = await tx
      .insert(feedCursors)
      .values({ seen: cursor.seen })
      .returning({ id: feedCursors.id });
    return { session: opened!.id, seen: cursor.seen };
  }
  const [row] = await tx
    .select({ seen: feedCursors.seen })
    .from(feedCursors)
    .where(eq(feedCursors.id, cursor.session))
    .for('update');
  // Only a collected walk gets here, so the reader has been idle for the whole
  // TTL. Saying so beats silently restarting them at the top of the feed.
  if (!row) throw badRequest('invalid_request', 'cursor has expired; start the feed again');
  return { session: cursor.session, seen: row.seen };
}

export async function pageSnapshotFeed<T>(
  db: Db,
  rawCursor: string | undefined,
  limit: number,
  feed: SnapshotFeed<T>,
): Promise<{ items: T[]; nextCursor: string | null }> {
  if (rawCursor === undefined) {
    // Page one is a plain read: no snapshot, no write, nothing to collect.
    const rows = await feed.top(db, [], limit + 1);
    const items = rows.slice(0, limit);
    if (rows.length <= limit) return { items, nextCursor: null };
    return { items, nextCursor: encodeCursor({ seen: items.map(feed.idOf) }) };
  }

  const cursor = decodeCursor(rawCursor);
  if ('seen' in cursor) await collectExpired(db);

  return db.transaction(async (tx) => {
    const { session, seen } = await lockWalk(tx, cursor);
    const offset = 'seen' in cursor ? cursor.seen.length : cursor.offset;
    // The snapshot is handed out in order, so an offset past its end is not a
    // position this walk ever issued.
    if (offset > seen.length) {
      throw badRequest('invalid_request', 'cursor is not a valid pagination cursor');
    }

    const replayIds = seen.slice(offset, offset + limit);
    const items: T[] = [];
    if (replayIds.length > 0) {
      const rows = await feed.byIds(tx, replayIds);
      const byId = new Map(rows.map((row) => [feed.idOf(row), row] as const));
      // A row the feed no longer shows simply drops out; its slot stays consumed.
      for (const id of replayIds) {
        const row = byId.get(id);
        if (row !== undefined) items.push(row);
      }
    }

    let consumed = replayIds.length;
    let hasMore: boolean;
    if (replayIds.length === limit) {
      // The whole page was already produced; one unseen row is all it takes to
      // know there is another page behind it.
      hasMore = seen.length > offset + limit || (await feed.top(tx, seen, 1)).length > 0;
    } else {
      const take = limit - replayIds.length;
      const fresh = await feed.top(tx, seen, take + 1);
      const taken = fresh.slice(0, take);
      hasMore = fresh.length > taken.length;
      if (taken.length > 0) {
        // The query excluded everything in `seen`, and the lock is what makes that
        // still true here, so these ids simply append.
        await tx
          .update(feedCursors)
          .set({ seen: [...seen, ...taken.map(feed.idOf)], updatedAt: new Date() })
          .where(eq(feedCursors.id, session));
        items.push(...taken);
        consumed += taken.length;
      }
    }

    return {
      items,
      nextCursor: hasMore ? encodeCursor({ session, offset: offset + consumed }) : null,
    };
  });
}
