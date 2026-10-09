/**
 * The durable job queue (see docs/ARCHITECTURE.md §5, §10).
 *
 * Postgres and nothing else. A broker would be a second thing to run and a second
 * thing to lose writes in, and the property the queue exists for — an enqueue that
 * commits with the write that caused it, or not at all — is one only the same
 * database can give: `enqueueJob` takes the caller's transaction, never a
 * connection of its own.
 *
 * What runs the jobs is passed in. This module knows how a job is claimed, retried
 * and given up on, and nothing about what any of them do.
 */
import { jobs, type Db, type Job, type JobKind, type JobPayloadMap } from '@shizue/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { hostname } from 'node:os';
import type { Tx } from './deps.js';

/** What runs one claimed job. It gets the plain db handle: a handler's work is its own transaction (or several), not the claim's. */
export type JobHandler<K extends JobKind> = (db: Db, payload: JobPayloadMap[K]) => Promise<void>;

/** One handler per kind. Complete rather than partial: a kind nothing can run is a job that is claimed and never finished. */
export type JobHandlers = { [K in JobKind]: JobHandler<K> };

/**
 * How long a claim stands before another worker may take the job over. Two
 * minutes, the same lease the generation claim uses (generation.ts) — long enough
 * that a slow handler is not overtaken, short enough that a worker that died does
 * not park the job for an afternoon.
 */
const LEASE = sql`interval '2 minutes'`;

/** How long an idle loop waits before asking again. */
const IDLE_MS = 1_000;

/**
 * How often a running handler says it is still there. Half the lease, so one
 * renewal that does not land is not enough to have the job taken away.
 */
const RENEW_MS = 60_000;

/** Whose lease it is. Diagnostic — the claim is decided by the row, not by this. */
const WORKER_ID = `${hostname()}:${process.pid}`;

/**
 * Puts a job on the queue inside the caller's transaction. Nothing is started
 * here: the worker finds the row once it is committed, which is exactly the point
 * — a rolled-back publish leaves no fan-out behind.
 *
 * `maxAttempts` overrides the column default for a kind that should give up
 * sooner: waiting for a recorder to close a file is worth three tries, where a
 * fan-out that has to reach everybody is worth five.
 */
export async function enqueueJob<K extends JobKind>(
  tx: Tx,
  kind: K,
  payload: JobPayloadMap[K],
  { runAt, maxAttempts }: { runAt?: Date; maxAttempts?: number } = {},
): Promise<void> {
  await tx.insert(jobs).values({
    kind,
    payload,
    ...(runAt ? { runAt } : {}),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
}

/**
 * The fence a claim holder puts on every write it makes about its own job.
 *
 * `attempts` is the token: a takeover always increments it, so a worker whose lease
 * expired while it was still running finds nothing to update and cannot report
 * `done` — or a retry, or a failure — over the state of the claim that replaced it.
 */
const heldBy = (job: Job, worker: string) =>
  and(
    eq(jobs.id, job.id),
    eq(jobs.attempts, job.attempts),
    eq(jobs.lockedBy, worker),
    eq(jobs.status, 'pending'),
  );

/**
 * Fails the jobs whose final attempt died with the worker that was running it.
 *
 * Without this they are stranded: `pending` with every attempt spent, refused by a
 * claim that only takes rows with attempts left, and there is nothing else in the
 * system that would ever move them. Run before each claim, where it writes nothing
 * at all on a healthy queue.
 */
async function failExpiredFinalAttempts(db: Db): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: 'failed',
      lockedAt: null,
      lockedBy: null,
      // Whatever the attempt that died managed to report first is worth more than
      // this note; the note is for the one that never reported anything.
      lastError: sql`coalesce(${jobs.lastError}, 'lease expired after the final attempt')`,
    })
    .where(
      and(
        eq(jobs.status, 'pending'),
        sql`${jobs.attempts} >= ${jobs.maxAttempts}`,
        isNotNull(jobs.lockedAt),
        sql`${jobs.lockedAt} < now() - ${LEASE}`,
      ),
    );
}

/**
 * Takes the oldest due job, if there is one. A single statement decides it, and
 * `for update skip locked` is what makes two workers asking at the same moment
 * walk away with two different rows instead of the same one.
 *
 * The attempt is counted by the claim rather than by the outcome, so a handler
 * that hangs until its lease expires still spends an attempt — otherwise a job
 * that kills whoever picks it up would be retried forever. That is also why the
 * claim asks for attempts to be left: a job with none is finished being tried,
 * whether or not anybody got to write that down.
 */
async function claimJob(db: Db, worker: string): Promise<Job | undefined> {
  await failExpiredFinalAttempts(db);
  const [claimed] = await db
    .update(jobs)
    .set({ lockedAt: sql`now()`, lockedBy: worker, attempts: sql`${jobs.attempts} + 1` })
    .where(
      sql`${jobs.id} = (
        select ${jobs.id} from ${jobs}
        where ${jobs.status} = 'pending'
          and ${jobs.runAt} <= now()
          and ${jobs.attempts} < ${jobs.maxAttempts}
          and (${jobs.lockedAt} is null or ${jobs.lockedAt} < now() - ${LEASE})
        order by ${jobs.runAt}
        limit 1
        for update skip locked
      )`,
    )
    .returning();
  return claimed;
}

/**
 * Keeps the lease under a running handler alive, and hands back the stop.
 *
 * A handler that takes longer than the lease is not a dead worker, and this is how
 * the row says so. The renewal carries the same fence as every other write a holder
 * makes, so one that arrives after a takeover writes nothing rather than pulling
 * the job back from the worker that now owns it.
 *
 * `everyMs` is here for the tests: a renewal is a minute apart, and waiting one out
 * is not something a suite should do.
 */
export function renewLease(db: Db, job: Job, worker: string, everyMs = RENEW_MS): () => void {
  const timer = setInterval(() => {
    void db
      .update(jobs)
      .set({ lockedAt: sql`now()` })
      .where(heldBy(job, worker))
      .catch((error) => console.warn(`[jobs] ${job.kind} ${job.id} lease renewal failed`, error));
  }, everyMs);
  // Nothing stays up for a renewal: the loop that owns the job is what keeps the
  // process alive, and this timer only ever outlives it by mistake.
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Marks a finished job done, if the claim is still this worker's. Answers how many
 * rows that was: zero means the lease was taken over while the handler ran, and
 * what happens to the job now belongs to whoever holds it.
 */
export async function finishJob(db: Db, job: Job, worker: string): Promise<number> {
  const finished = await db
    .update(jobs)
    .set({ status: 'done', lockedAt: null, lockedBy: null })
    .where(heldBy(job, worker))
    .returning({ id: jobs.id });
  if (finished.length === 0) {
    console.warn(`[jobs] ${job.kind} ${job.id} finished under a lease that had been taken over`);
  }
  return finished.length;
}

/**
 * Records an attempt that threw, if the claim is still this worker's — same fence,
 * and the same zero, as `finishJob`. The lease goes either way — the job is not
 * running any more — and the row either becomes claimable again with the next
 * attempt pushed out, or stops at `failed` with the reason on it.
 *
 * The backoff is 2^attempts minutes: two after the first failure, half an hour
 * after the fifth. A fault that is going to clear on its own has cleared by then,
 * and one that is not has left an operator half an hour of quiet log instead of a
 * retry loop.
 */
export async function recordFailure(db: Db, job: Job, worker: string, error: unknown): Promise<number> {
  const lastError = error instanceof Error ? error.message : String(error);
  const spent = job.attempts >= job.maxAttempts;
  if (spent) console.error(`[jobs] ${job.kind} ${job.id} gave up after ${job.attempts} attempts`, error);
  else console.warn(`[jobs] ${job.kind} ${job.id} attempt ${job.attempts} failed, retrying`, error);
  const recorded = await db
    .update(jobs)
    .set({
      lockedAt: null,
      lockedBy: null,
      lastError,
      ...(spent
        ? { status: 'failed' as const }
        : { runAt: sql`now() + make_interval(mins => ${2 ** job.attempts})` }),
    })
    .where(heldBy(job, worker))
    .returning({ id: jobs.id });
  return recorded.length;
}

/**
 * Claims one due job and runs it. False means there was nothing due — the caller
 * decides whether that is a reason to wait or to stop.
 */
async function runNextJob(db: Db, handlers: JobHandlers, worker: string): Promise<boolean> {
  const job = await claimJob(db, worker);
  if (!job) return false;
  const stopRenewing = renewLease(db, job, worker);
  try {
    // The row correlates kind with payload; the type system only sees two unions
    // side by side, and the map is what keeps them in step.
    const handler = handlers[job.kind] as JobHandler<JobKind>;
    await handler(db, job.payload);
    await finishJob(db, job, worker);
  } catch (error) {
    await recordFailure(db, job, worker, error);
  } finally {
    stopRenewing();
  }
  return true;
}

/**
 * Runs due jobs until none is left. This is how tests get the work done — a queue
 * is not a timing puzzle to them — and how any caller that has to see the effect
 * before it returns asks for it.
 *
 * `maxJobs` is a stop, not a target: a handler that enqueues its own successor
 * would otherwise be able to keep one drain running forever.
 */
export async function drainJobs(
  db: Db,
  handlers: JobHandlers,
  { maxJobs = 1_000 }: { maxJobs?: number } = {},
): Promise<number> {
  let ran = 0;
  while (ran < maxJobs && (await runNextJob(db, handlers, WORKER_ID))) ran += 1;
  return ran;
}

export interface JobWorkerDeps {
  db: Db;
  handlers: JobHandlers;
}

/**
 * Starts this instance's poll loop and returns the stop.
 *
 * One job per tick, and the next tick is immediate when there was one: a backlog
 * drains at the speed of the handlers rather than of the poll, and an idle queue
 * costs one indexed statement a second. A chained timeout rather than an interval,
 * so a slow handler cannot have two ticks running over each other.
 *
 * Stopping clears the pending timer and lets the job in flight finish. Nothing is
 * killed mid-handler and nothing needs to be: an unfinished job's lease expires
 * two minutes later and the next worker takes it over.
 */
export function startJobWorker(
  deps: JobWorkerDeps,
  { idleMs = IDLE_MS }: { idleMs?: number } = {},
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    let ran = false;
    try {
      ran = await runNextJob(deps.db, deps.handlers, WORKER_ID);
    } catch (error) {
      // The claim itself failed — a database that is going away, or gone. Swallowed
      // so the loop survives it: this is the only thing that will notice when it
      // comes back.
      console.error('[jobs] claim failed', error);
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), ran ? 0 : idleMs);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
