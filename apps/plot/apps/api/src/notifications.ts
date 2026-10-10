/** Plot publication notifications, fan-out queued in the publish transaction. */
import { follows, notifications, plots, type Db, type JobPayloadMap } from '@shizue/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import type { JobHandlers } from './jobs.js';
import { memoryBackfill } from './memory.js';

/**
 * Followers per insert. The walk is keyset, so this decides how much one statement
 * writes and never how many followers are reached.
 */
export const FANOUT_BATCH = 1_000;

/**
 * What one fan-out is about, once the row it names has been confirmed to still be
 * there: the cutoff, and the column that ties each notification to the thing that
 * happened.
 */
interface FanoutSubject {
  /** ISO instant; the moment the followers are counted as of. */
  at: string;
  ref: { plotId: string };
}

/**
 * Reads the subject's own row, which is both an existence check and the fallback
 * for the cutoff.
 *
 * The row can be gone by the time the job runs — a plot deleted. There is nothing left to announce, and without
 * this the insert would fail its foreign key on every attempt until the job gave
 * up.
 *
 * The cutoff is read defensively even though the payload declare it
 * required. A queued row outlives the code that wrote it: a payload enqueued by an
 * older deployment may not carry a field this version added, and the subject's own
 * column holds the same fact. When neither has it there is nothing to announce —
 * a plot with no `published_at` was never published, and a stream with no
 * `started_at` never went live.
 */
async function resolveSubject(
  db: Db,
  payload: JobPayloadMap['notification_fanout'],
): Promise<FanoutSubject | null> {
  const [plot] = await db
    .select({ publishedAt: plots.publishedAt })
    .from(plots)
    .where(eq(plots.id, payload.plotId));
  if (!plot) return null;
  const at = (payload.publishedAt as string | undefined) ?? plot.publishedAt?.toISOString();
  return at ? { at, ref: { plotId: payload.plotId } } : null;
}

/**
 * One notification per follower of the subject's owner, in batches, off the
 * critical path of whatever caused it.
 *
 * Who is notified is decided the same way it always was: everyone who followed the
 * creator **as of the thing that happened**. Nobody follows themselves — that is a
 * 400 at the follow route, not a condition here — so a creator still never hears
 * about their own publish, . The cutoff is what an inline
 * fan-out got for free by running inside the publish; queued, the job may run a
 * minute later, and without it a reader who followed in between would be handed
 * something from before they arrived — "following is not a subscription to the
 * past" (§10).
 *
 * The rest of the exclusions belong to the caller and stay there: only a first
 * publish enqueues anything, an adult plot enqueues nothing (§10).
 *
 * Re-running is safe. Every attempt starts from the first batch, and the rows an
 * earlier attempt already wrote conflict on `(user_id, plot_id, kind)` rather than arriving a second time.
 */
export async function notificationFanout(
  db: Db,
  payload: JobPayloadMap['notification_fanout'],
  batchSize = FANOUT_BATCH,
): Promise<void> {
  const subject = await resolveSubject(db, payload);
  if (!subject) return;

  // Keyset along the (creator_id, created_at desc) index, never an offset: the list
  // is being read while people are still following and unfollowing, and an offset
  // walk skips rows when it is.
  //
  // The boundary travels as text. Postgres stores microseconds and a JS Date carries
  // milliseconds, so a boundary that went out as a Date would come back truncated —
  // and on a descending walk a truncated boundary excludes the rows between the
  // truncated value and the real one, which is followers silently never told. A text
  // round-trip is exact. Reading the boundary back out of the follow row instead
  // would be exact too, and was how this was written first: it is wrong, because the
  // boundary follower can unfollow between two batches, and then the subquery is
  // null, the comparison is unknown for every row, and the walk ends early and calls
  // itself finished.
  let cursor: { createdAt: string; followerId: string } | undefined;
  for (;;) {
    const batch = await db
      .select({
        followerId: follows.followerId,
        createdAt: sql<string>`${follows.createdAt}::text`,
      })
      .from(follows)
      .where(
        and(
          eq(follows.creatorId, payload.actorId),
          // Everyone the creator had when it happened, and nobody who arrived
          // after — however long the job waited for a worker.
          sql`${follows.createdAt} <= ${subject.at}::timestamptz`,
          cursor
            ? sql`(${follows.createdAt}, ${follows.followerId}) < (${cursor.createdAt}::timestamptz, ${cursor.followerId})`
            : undefined,
        ),
      )
      .orderBy(desc(follows.createdAt), desc(follows.followerId))
      .limit(batchSize);
    if (batch.length === 0) return;

    await db
      .insert(notifications)
      .values(
        batch.map((follower) => ({
          userId: follower.followerId,
          kind: payload.kind,
          actorId: payload.actorId,
          ...subject.ref,
        })),
      )
      .onConflictDoNothing();

    if (batch.length < batchSize) return;
    cursor = batch[batch.length - 1]!;
  }
}

/**
 * The work this API runs off the queue. The memory backfill calls the chat owner's
 * model and shares the per-chat refresh guard with the request path, so it is
 * handed the same deps the app runs on.
 */
export function createJobHandlers(deps: AppDeps): JobHandlers {
  return {
    notification_fanout: notificationFanout,
    memory_backfill: (_db, payload) => memoryBackfill(deps, payload),
  };
}
