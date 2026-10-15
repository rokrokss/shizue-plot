/**
 * Korean aliases for the lore of a work a Korean reader cannot reach by its keys
 * (@shizue/core `loreAliases.ts`, ARCHITECTURE §7.9).
 *
 * - **The pass** (`aliasPlotLore`): for a work whose language is not Korean and
 *   whose book has (next to) no Korean keys (`lacksKoreanKeys`), every keyed
 *   entry without a row of its current keys and content is sent to the
 *   auxiliary model — the one translation and the HypaV3 summaries use — in
 *   batches (`aliasBatches`), and its answer stored in `lore_entry_aliases`,
 *   apart from the entry. Rows no entry has any more go first. Scheduled after
 *   every write that can change the lore, on the creator's model, and lazily by
 *   a Korean reader's request that meets an entry without one, on theirs
 *   (`vectors.ts` `scheduleLoreAliases`, which guards it to one pass a plot);
 *   the backfill (`fix:lore-aliases`) runs it for works made before.
 * - **A request reads them** (`loreAliasesFor`): only in the `instruct` mode for
 *   a Korean reader over such a book, as `ActivateLoreInput.aliases`. Until an
 *   entry's row lands it activates by its keys alone — and, where the embedder
 *   has a measured bar, by meaning in their place (`vectorLoreSearch`).
 *
 * `LORE_ALIASES=off` turns both off. The model's failures never reach a
 * request: the pass reports them and backs off, and a request whose rows cannot
 * be read goes by the keys alone.
 */
import {
  aliasBatches,
  aliasRequest,
  aliasSourceText,
  isKeyedLoreEntry,
  lacksKoreanKeys,
  LORE_ALIAS_LANGUAGE,
  parseLoreAliases,
  type LoreEntry,
  type PlotModule,
} from '@shizue/core';
import { characters, loreEntryAliases, plots, type ContentLanguage } from '@shizue/db';
import type { LLMAdapter } from '@shizue/llm';
import { and, asc, eq, notInArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { AppDeps } from './deps.js';
import { collect, memoryChannel, type AuxiliaryOwner } from './memory.js';

/** What one call may answer: thirty entries' aliases with room to spare. */
const ALIAS_MAX_TOKENS = 4_096;
/** Deadline for one call, so a hung provider frees the plot's pass. */
const ALIAS_TIMEOUT_MS = 120_000;
/** How long a plot's pass stands back after its model failed it, or there was none to ask. */
const RETRY_AFTER_MS = 10 * 60_000;

/** Plots whose pass is backing off, until when. Per process, as the guard is. */
const backingOff = new Map<string, number>();

/** Whether the alias pass and the aliases are on: everything but `LORE_ALIASES=off`. */
export const loreAliasesEnabled = (env: NodeJS.ProcessEnv): boolean => env['LORE_ALIASES']?.trim() !== 'off';

/** The key an entry's aliases are stored under: a hash of its keys and content. */
export const aliasHash = (entry: Pick<LoreEntry, 'keys' | 'content'>): string =>
  createHash('sha256').update(aliasSourceText(entry)).digest('hex');

/**
 * The entries the pass aliases, in a work of `language`: its keyed entries when
 * it is not Korean and its book has (next to) no Korean keys, else none.
 */
export function aliasableEntries(language: ContentLanguage, entries: readonly LoreEntry[]): LoreEntry[] {
  if (language === LORE_ALIAS_LANGUAGE || !lacksKoreanKeys(entries)) return [];
  return entries.filter(isKeyedLoreEntry);
}

/** Every lore entry a work holds: its own book, its members' and its modules'. */
export async function loadWorkLore(
  deps: Pick<AppDeps, 'db'>,
  plotId: string,
): Promise<{ language: ContentLanguage; entries: LoreEntry[] } | null> {
  const [plot] = await deps.db
    .select({ language: plots.language, lorebook: plots.lorebook, customUi: plots.customUi })
    .from(plots)
    .where(eq(plots.id, plotId))
    .limit(1);
  if (!plot) return null;
  const members = await deps.db
    .select({ card: characters.card })
    .from(characters)
    .where(eq(characters.plotId, plotId))
    .orderBy(asc(characters.orderIndex), asc(characters.createdAt));
  const modules: readonly PlotModule[] = plot.customUi?.modules ?? [];
  return {
    language: plot.language,
    entries: [...plot.lorebook, ...members.flatMap((member) => member.card.lorebook), ...modules.flatMap((module) => module.lorebook)],
  };
}

/** A plot's alias rows in `language`, by source hash. */
async function aliasRows(deps: Pick<AppDeps, 'db'>, plotId: string): Promise<Map<string, string[]>> {
  const rows = await deps.db
    .select({ hash: loreEntryAliases.sourceHash, aliases: loreEntryAliases.aliases })
    .from(loreEntryAliases)
    .where(and(eq(loreEntryAliases.plotId, plotId), eq(loreEntryAliases.language, LORE_ALIAS_LANGUAGE)));
  return new Map(rows.map((row) => [row.hash, row.aliases]));
}

/** What one pass did, for the log and the backfill. */
export interface AliasPassResult {
  /** Entries that had no row when the pass began. */
  pending: number;
  /** Rows it wrote, an entry's aliases or its empty answer. */
  written: number;
  /** Aliases in those rows. */
  aliases: number;
  /** Calls it made to the model. */
  calls: number;
  /** Why it stopped short, if it did. */
  skipped?: 'off' | 'backing_off' | 'no_model' | 'failed';
}

/**
 * One alias pass over a plot's lore, to its end, on `owner`'s auxiliary model.
 * Rows of entries the work no longer has go; each pending entry is asked for
 * once; a provider failure stops the pass and backs the plot off for
 * `RETRY_AFTER_MS`. Only a database error throws — the scheduler logs it.
 */
export async function aliasPlotLore(
  deps: Pick<AppDeps, 'db' | 'env' | 'chatgpt' | 'getAdapter'>,
  plotId: string,
  owner: AuxiliaryOwner,
): Promise<AliasPassResult> {
  const result: AliasPassResult = { pending: 0, written: 0, aliases: 0, calls: 0 };
  if (!loreAliasesEnabled(deps.env)) return { ...result, skipped: 'off' };
  const work = await loadWorkLore(deps, plotId);
  if (!work) return result;
  const wanted = new Map<string, LoreEntry>();
  for (const entry of aliasableEntries(work.language, work.entries)) {
    const hash = aliasHash(entry);
    if (!wanted.has(hash)) wanted.set(hash, entry);
  }

  // What no entry is made from any more goes.
  const mine = and(eq(loreEntryAliases.plotId, plotId), eq(loreEntryAliases.language, LORE_ALIAS_LANGUAGE));
  await deps.db
    .delete(loreEntryAliases)
    .where(wanted.size > 0 ? and(mine, notInArray(loreEntryAliases.sourceHash, [...wanted.keys()])) : mine);
  if (wanted.size === 0) return result;

  const done = await aliasRows(deps, plotId);
  const pending = [...wanted].filter(([hash]) => !done.has(hash));
  result.pending = pending.length;
  if (pending.length === 0) return result;
  if (Date.now() < (backingOff.get(plotId) ?? 0)) return { ...result, skipped: 'backing_off' };

  const channel = await memoryChannel(deps, owner);
  if (!channel) {
    backingOff.set(plotId, Date.now() + RETRY_AFTER_MS);
    return { ...result, skipped: 'no_model' };
  }
  const entries = pending.map(([, entry]) => entry);
  for (const batch of aliasBatches(entries)) {
    let answers: string[][];
    try {
      answers = await askAliases(channel, batch.map((index) => entries[index]!), true, result);
    } catch (error) {
      console.warn(`[aliases] ${plotId}: the auxiliary model failed; the pass backs off`, error);
      backingOff.set(plotId, Date.now() + RETRY_AFTER_MS);
      return { ...result, skipped: 'failed' };
    }
    const rows = batch.map((index, at) => ({
      plotId,
      sourceHash: pending[index]![0],
      language: LORE_ALIAS_LANGUAGE,
      aliases: answers[at] ?? [],
      model: channel.providerModel,
    }));
    await deps.db.insert(loreEntryAliases).values(rows).onConflictDoNothing();
    result.written += rows.length;
    result.aliases += rows.reduce((sum, row) => sum + row.aliases.length, 0);
  }
  backingOff.delete(plotId);
  console.log(
    `[aliases] ${plotId}: ${result.written} entries, ${result.aliases} aliases in ${result.calls} calls on ${channel.providerModel}`,
  );
  return result;
}

/**
 * The aliases of `entries`, from one call — or, where its answer cannot be read
 * (a refusal, or an answer cut off at its cap), from one call for each half,
 * once. What still cannot be read has none. A blank answer, or the provider
 * failing, throws: that is the provider's state, not the entries'.
 */
async function askAliases(
  channel: { adapter: LLMAdapter; providerModel: string },
  entries: readonly LoreEntry[],
  split: boolean,
  result: AliasPassResult,
): Promise<string[][]> {
  const request = aliasRequest(entries);
  result.calls += 1;
  const answer = await collect(channel.adapter, {
    model: channel.providerModel,
    system: request.system,
    messages: request.messages,
    maxTokens: ALIAS_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(ALIAS_TIMEOUT_MS),
  });
  if (!answer.trim()) throw new Error('the auxiliary model answered nothing');
  const parsed = parseLoreAliases(answer, entries.length);
  if (parsed) return parsed;
  if (!split || entries.length < 2) return entries.map(() => []);
  const half = Math.ceil(entries.length / 2);
  return [
    ...(await askAliases(channel, entries.slice(0, half), false, result)),
    ...(await askAliases(channel, entries.slice(half), false, result)),
  ];
}

/** What a request reads of a book's aliases. */
export interface RequestAliases {
  /** An entry's aliases, for `ActivateLoreInput.aliases`. */
  lookup: (entry: LoreEntry) => readonly string[] | undefined;
  /** Whether an entry has aliases to be found by — what the search by meaning stands in for until it does. */
  aliased: (entry: LoreEntry) => boolean;
  /** Whether a keyed entry has no row yet: the pass has something to do. */
  pending: boolean;
}

/**
 * The aliases a request activates the book with: only for a Korean reader in
 * the `instruct` mode (`conversationLanguage`) of a work in another language
 * whose book has (next to) no Korean keys. Null otherwise, with the feature
 * off, or when the rows cannot be read. Never throws.
 */
export async function loreAliasesFor(
  deps: Pick<AppDeps, 'db' | 'env'>,
  plan: { plotId: string; plotLanguage: ContentLanguage; conversationLanguage?: ContentLanguage },
  entries: readonly LoreEntry[],
): Promise<RequestAliases | null> {
  if (!loreAliasesEnabled(deps.env)) return null;
  if (plan.conversationLanguage !== LORE_ALIAS_LANGUAGE || plan.plotLanguage === LORE_ALIAS_LANGUAGE) return null;
  if (!lacksKoreanKeys(entries)) return null;
  let rows: Map<string, string[]>;
  try {
    rows = await aliasRows(deps, plan.plotId);
  } catch (error) {
    console.warn('[aliases] the aliases could not be read; lore by its own keys', error);
    return null;
  }
  const hashes = new WeakMap<LoreEntry, string>();
  const hashOf = (entry: LoreEntry): string => {
    let hash = hashes.get(entry);
    if (hash === undefined) hashes.set(entry, (hash = aliasHash(entry)));
    return hash;
  };
  const lookup = (entry: LoreEntry): readonly string[] | undefined => {
    const aliases = rows.get(hashOf(entry));
    return aliases && aliases.length > 0 ? aliases : undefined;
  };
  return {
    lookup,
    aliased: (entry) => lookup(entry) !== undefined,
    pending: entries.some((entry) => isKeyedLoreEntry(entry) && !rows.has(hashOf(entry))),
  };
}
