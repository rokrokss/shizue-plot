/**
 * Explore's search by meaning (ARCHITECTURE §10 `GET /api/explore`, backlog B8):
 * each publicly listed plot's searchable text embedded with the plot's model
 * (`plot_search_vectors`), and a reader's sentence ("집착남 재벌물 추천해줘")
 * embedded with the model of the language partition it is asked in.
 *
 * - **The text is public**: the name, the tags, the reader-facing intro and the
 *   start of the first opening as a reader sees it (`publicIntro`). Never the
 *   description, lorebook or cards — what only the model is told stays out of
 *   the vector as it stays out of every public view.
 * - **Written in the background**: a publish or an edit of the plot schedules its
 *   refresh (`scheduleSearchVector`), which embeds the text unless the stored
 *   vector is of the same text and model, and deletes the row of a plot no
 *   longer listed. A search also sweeps a bounded number of its partition's
 *   plots whose vector is missing, of another model, or older than the plot's
 *   last change (`scheduleSearchSweep`) — the lazy re-embedding after a model
 *   change, and the catch-up for plots published before this existed or while
 *   the embedder was down.
 * - The search itself is the explore route's: it filters by the same listing
 *   rule, language partition and tag as the text search, and falls back to it.
 */
import { createHash } from 'node:crypto';
import { plots, plotSearchVectors, type ContentLanguage, type Plot } from '@shizue/db';
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { publicIntro, publiclyListed } from './hub.js';

/** How much of the first opening the text carries: its start says what the work is. */
const OPENING_CHARS = 400;
/** Longest searchable text; a long intro is cut rather than diluting the vector. */
const SEARCH_TEXT_CHARS = 2000;
/** Plots one sweep looks at, and how long a sweep that found nothing stale is not repeated for. */
const SWEEP_BATCH = 64;
const SWEEP_IDLE_MS = 60_000;

/** The text a plot is found by: its public fields only. */
export function plotSearchText(plot: Pick<Plot, 'name' | 'tags' | 'intro' | 'intros'>): string {
  const opening = publicIntro(plot.intros[0] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, OPENING_CHARS);
  return [plot.name.trim(), plot.tags.join(', '), plot.intro.trim(), opening]
    .filter((part) => part.length > 0)
    .join('\n')
    .slice(0, SEARCH_TEXT_CHARS);
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Plots whose refresh is running, and whether another was asked for meanwhile. */
const refreshing = new Map<string, boolean>();

/**
 * Fire-and-forget refresh of one plot's vector, after a write that may have
 * changed its text or its listing. One at a time per plot; one asked for while
 * it runs runs again after it, so the last write is the one embedded.
 */
export function scheduleSearchVector(deps: AppDeps, plotId: string): void {
  if (refreshing.has(plotId)) {
    refreshing.set(plotId, true);
    return;
  }
  refreshing.set(plotId, false);
  const task = (async () => {
    do {
      refreshing.set(plotId, false);
      await refreshSearchVectors(deps, [plotId]);
    } while (refreshing.get(plotId));
  })()
    .catch((error: unknown) => console.error('[search] refreshing a plot vector failed', error))
    .finally(() => refreshing.delete(plotId));
  deps.onBackgroundTask?.(task, 'search');
}

/**
 * Brings the vectors of `plotIds` in line with the plots: deletes the row of a
 * plot no longer listed, embeds the text of a listed one whose row is missing or
 * of another text or model (all of them in one call), and only re-stamps a row
 * whose text and model still hold. Throws when the embedder does.
 */
export async function refreshSearchVectors(deps: AppDeps, plotIds: readonly string[]): Promise<void> {
  if (plotIds.length === 0) return;
  const rows = await deps.db
    .select({ plot: plots, listed: sql<boolean>`${publiclyListed()}`, vector: plotSearchVectors })
    .from(plots)
    .leftJoin(plotSearchVectors, eq(plotSearchVectors.plotId, plots.id))
    .where(inArray(plots.id, [...plotIds]));
  const unlisted = rows.filter((row) => !row.listed && row.vector).map((row) => row.plot.id);
  if (unlisted.length > 0) await deps.db.delete(plotSearchVectors).where(inArray(plotSearchVectors.plotId, unlisted));

  const embedder = deps.embedder;
  if (!embedder) return;
  const due: { plot: Plot; text: string; hash: string }[] = [];
  const current: string[] = [];
  for (const row of rows) {
    if (!row.listed) continue;
    const model = embedder.modelFor(row.plot.language);
    if (!model) continue;
    const text = plotSearchText(row.plot);
    const hash = hashOf(text);
    if (row.vector?.model === model && row.vector.textHash === hash) current.push(row.plot.id);
    else due.push({ plot: row.plot, text, hash });
  }
  if (current.length > 0) {
    await deps.db.update(plotSearchVectors).set({ embeddedAt: new Date() }).where(inArray(plotSearchVectors.plotId, current));
  }
  // One call per language: a call embeds with one plot's model.
  const languages = [...new Set(due.map((item) => item.plot.language))];
  for (const language of languages) {
    const batch = due.filter((item) => item.plot.language === language);
    const embedded = await embedder.embed(
      batch.map((item) => item.text),
      { plotLanguage: language, kind: 'document' },
    );
    for (const [index, item] of batch.entries()) {
      const values = {
        model: embedded.model,
        embedding: embedded.vectors[index]!,
        textHash: item.hash,
        embeddedAt: new Date(),
      };
      await deps.db
        .insert(plotSearchVectors)
        .values({ plotId: item.plot.id, ...values })
        .onConflictDoUpdate({ target: plotSearchVectors.plotId, set: values });
    }
  }
}

/** Partitions with a sweep running, and until when one that found nothing is not repeated. */
const sweeping = new Set<ContentLanguage>();
const sweptUntil = new Map<ContentLanguage, number>();

/**
 * Fire-and-forget catch-up of a partition's vectors, started by a search: up to
 * `SWEEP_BATCH` listed plots whose vector is missing, of another model than
 * `model`, or older than the plot's last change. One per partition at a time;
 * the next search takes the next batch.
 */
export function scheduleSearchSweep(deps: AppDeps, language: ContentLanguage, model: string): void {
  if (sweeping.has(language) || Date.now() < (sweptUntil.get(language) ?? 0)) return;
  sweeping.add(language);
  const task = (async () => {
    const stale = await deps.db
      .select({ id: plots.id })
      .from(plots)
      .leftJoin(plotSearchVectors, eq(plotSearchVectors.plotId, plots.id))
      .where(
        and(
          publiclyListed(),
          eq(plots.language, language),
          or(
            isNull(plotSearchVectors.plotId),
            ne(plotSearchVectors.model, model),
            gt(plots.updatedAt, plotSearchVectors.embeddedAt),
          ),
        ),
      )
      .orderBy(desc(plots.publishedAt))
      .limit(SWEEP_BATCH);
    if (stale.length === 0) {
      sweptUntil.set(language, Date.now() + SWEEP_IDLE_MS);
      return;
    }
    await refreshSearchVectors(
      deps,
      stale.map((row) => row.id),
    );
  })()
    .catch((error: unknown) => console.error('[search] sweeping plot vectors failed', error))
    .finally(() => sweeping.delete(language));
  deps.onBackgroundTask?.(task, 'search');
}

/** Forgets the sweeps' state; for tests, whose plots come and go between cases. */
export function resetSearchSweeps(): void {
  sweptUntil.clear();
}
