import { notifications, plots, user, type Notification } from '@shizue/db';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';
import { badRequest } from '../errors.js';
import { isUuid } from '../util.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** A notification row with the names the listing renders it by. */
interface NotificationRow {
  notification: Notification;
  actorName: string | null;
  plotName: string | null;
}

/** A publication notification and the plot it opens. */
const toJson = (row: NotificationRow) => ({
  id: row.notification.id,
  kind: row.notification.kind,
  /** Who did it; null once that account is gone, and the name with it. */
  actorId: row.notification.actorId,
  actorName: row.actorName,
  plotId: row.notification.plotId,
  plotName: row.plotName,
  /** There is no per-row read, so this is only ever flipped by "read all". */
  read: row.notification.readAt !== null,
  createdAt: row.notification.createdAt.toISOString(),
});

/** Position in the total order (created_at, id); both are needed to be stable. */
interface Cursor {
  createdAt: string;
  id: string;
}

// Same opaque-cursor contract as comments: base64url JSON the client only ever
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
 * Everything strictly after the cursor in the total order. The boundary is read
 * back from the row the cursor names, because the serialized timestamp is only
 * millisecond-precise while Postgres stores microseconds — the same reason, and
 * the same shape, as the comment listing's.
 */
const afterCursor = (cursor: Cursor): SQL =>
  sql`(${notifications.createdAt}, ${notifications.id}) < (
    coalesce(
      (select boundary.created_at from ${notifications} boundary where boundary.id = ${cursor.id}::uuid),
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

/**
 * The reader's own notifications, newest first. Mounted whole behind
 * `requireUser` (app.ts): every row here belongs to exactly one recipient.
 */
export function notificationRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const userId = c.get('userId');
    const limit = coerceLimit(c.req.query('limit'));
    const rawCursor = c.req.query('cursor');
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;

    const rows = await deps.db
      .select({
        notification: notifications,
        actorName: user.name,
        plotName: plots.name,
      })
      .from(notifications)
      // Every side is nullable — an actor whose account is gone, and a kind that
      // names one subject necessarily names neither of the others — so no join
      // here may drop a row.
      .leftJoin(user, eq(notifications.actorId, user.id))
      .leftJoin(plots, eq(notifications.plotId, plots.id))
      .where(and(eq(notifications.userId, userId), ...(cursor ? [afterCursor(cursor)] : [])))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      // One extra row answers "is there a next page?" without a second query.
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      items: page.map(toJson),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              createdAt: last.notification.createdAt.toISOString(),
              id: last.notification.id,
            })
          : null,
      // Only the first page carries it: the badge is read when the list is
      // opened, and every later page would be answering a question nobody asked.
      ...(cursor ? {} : { unreadCount: await countUnread(deps, userId) }),
    });
  });

  app.post('/read', async (c) => {
    await deps.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, c.get('userId')), isNull(notifications.readAt)));
    // The badge's new state, so the client does not have to re-read the list.
    return c.json({ unreadCount: 0 });
  });

  return app;
}

async function countUnread(deps: AppDeps, userId: string): Promise<number> {
  const [row] = await deps.db
    .select({ value: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.value ?? 0;
}
