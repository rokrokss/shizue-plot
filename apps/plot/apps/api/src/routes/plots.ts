import {
  coerceAssetUnlock,
  coerceNarrator,
  coercePlotProfiles,
  coercePlotStyle,
  emptyCard,
  exportCardPng,
  exportCardV3,
  MAX_INTRO_LENGTH,
  parseCard,
  type CharxAssetFile,
  type NarratorConfig,
  type NormalizedCard,
  type PlotCustomUi,
  type PlotProfile,
  type PlotStyle,
} from '@shizue/core';
import {
  characters,
  plots,
  plotAssets,
  plotLikes,
  type Character,
  type ContentLanguage,
  type NewPlotAsset,
  type SafetyLevel,
  type Plot,
  type PlotAsset,
} from '@shizue/db';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
  assetUrl,
  coerceAssetPreview,
  MAX_ASSETS_PER_PLOT,
  normalizeSlug,
  saveAsset,
  uniqueSlug,
} from '../assets.js';
import {
  MAX_IMAGE_BYTES,
  mimeForPath,
  sanitizeStoredAvatar,
  saveAvatar,
  storableImage,
} from '../avatar.js';
import { coerceCard, coerceCustomUi, coerceLorebook, customUiOfCard } from '../card.js';
import type { AppDeps, AppEnv, Tx } from '../deps.js';
import { draftPlot, MAX_PREMISE_LENGTH } from '../draft.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import {
  avatarUrl,
  coverUrl,
  loadMembers,
  loadVisiblePlot,
  normalizeTags,
  publicIntro,
  publicPlotQuery,
  toPublicPlotJson,
  visibleToViewer,
} from '../hub.js';
import { enqueueJob } from '../jobs.js';
import { requireUser } from '../session.js';
import { loadOwnedPlot } from '../plots.js';
import { coverKey, deleteQuietly, readAll } from '../storage.js';
import { isUuid, optionalBoolean, optionalString, readJsonBody, requireString, requireUuidParam } from '../util.js';
import { countComments } from './comments.js';
import { followState } from './explore.js';

const LANGUAGES: ContentLanguage[] = ['ko', 'en', 'ja'];
/**
 * The levels a create, edit or publish may declare. `adult` is left out until age
 * verification exists: rows saved with it earlier keep it, but none gain it now.
 */
const SAFETY_LEVELS: SafetyLevel[] = ['all'];

/** Roster size. Ten is what one prompt can hold and one reader can keep straight. */
export const MAX_CHARACTERS_PER_PLOT = 10;
/** Openings a plot may offer; every one of them becomes a root of a new chat. */
export const MAX_INTROS_PER_PLOT = 10;
/** One opening's length — a prologue, not a chapter. */
export const MAX_INTRO_TEXT_LENGTH = 4000;

export function coerceLanguage(value: string | undefined): ContentLanguage | undefined {
  if (value === undefined) return undefined;
  if (!LANGUAGES.includes(value as ContentLanguage)) {
    throw badRequest('invalid_request', `language must be one of ${LANGUAGES.join(', ')}`);
  }
  return value as ContentLanguage;
}

/** Explore partitions on the content language, so there it is mandatory. */
export function requireLanguage(value: string | undefined): ContentLanguage {
  const language = coerceLanguage(value);
  if (!language) throw badRequest('invalid_request', 'language is required');
  return language;
}

/**
 * The audience a publish declares. Absent leaves the stored level alone, so a
 * re-publish never silently reclassifies a plot.
 */
function coerceSafetyLevel(value: string | undefined): SafetyLevel | undefined {
  if (value === undefined) return undefined;
  if (!SAFETY_LEVELS.includes(value as SafetyLevel)) {
    throw badRequest('invalid_request', `safetyLevel must be one of ${SAFETY_LEVELS.join(', ')}`);
  }
  return value as SafetyLevel;
}

/**
 * Trimmed and refused rather than truncated: the author is right here, and a
 * silently halved intro is a worse answer. It shares the card's cap because it is
 * the same piece of writing one level up — a line addressed to readers.
 */
function coerceIntro(body: Record<string, unknown>): string | undefined {
  const intro = optionalString(body, 'intro')?.trim();
  if (intro !== undefined && intro.length > MAX_INTRO_LENGTH) {
    throw badRequest('invalid_request', `intro must be at most ${MAX_INTRO_LENGTH} characters`);
  }
  return intro;
}

/**
 * The openings, in the order a reader picks between them. Stored verbatim —
 * they are speech-protocol text with macros in it, and the chat is what expands
 * and trims them.
 */
function coerceIntros(body: Record<string, unknown>): string[] | undefined {
  const value = body['intros'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest('invalid_request', 'intros must be an array');
  if (value.length > MAX_INTROS_PER_PLOT) {
    throw badRequest('intro_limit', `A plot offers at most ${MAX_INTROS_PER_PLOT} intros`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'string') throw badRequest('invalid_request', 'intros must be strings');
    if (entry.length > MAX_INTRO_TEXT_LENGTH) {
      throw badRequest('intro_limit', `An intro is at most ${MAX_INTRO_TEXT_LENGTH} characters`);
    }
    return entry;
  });
}

/**
 * The plot's narrator, on the same whitelist a chat's override passes through.
 * `null` clears it; so does an object whose fields all fail the whitelist, since
 * storing `{}` would only mean the same thing in a shape nothing reads.
 */
function optionalNarrator(body: Record<string, unknown>): NarratorConfig | null | undefined {
  const value = body['narrator'];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_request', 'narrator must be an object or null');
  }
  const narrator = coerceNarrator(value);
  return Object.keys(narrator).length > 0 ? narrator : null;
}

/**
 * How the creator wants the work written, on the whitelist the directive compiler
 * can read back (`coercePlotStyle`): an option this build has no directive for is
 * dropped rather than refused, exactly as an unknown point of view is. A style
 * that says nothing is stored as nothing, so the column stays null until the
 * creator really sets something.
 */
function optionalStyle(body: Record<string, unknown>): PlotStyle | null | undefined {
  const value = body['style'];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_request', 'style must be an object or null');
  }
  const style = coercePlotStyle(value);
  return Object.keys(style).length > 0 ? style : null;
}

/**
 * The reader profiles this work recommends, on the caps the coercion owns
 * (`coercePlotProfiles`): a row without a usable name is dropped rather than
 * refused, ids are minted for the rows the editor has not saved yet, and a list
 * that describes nothing is stored as nothing.
 */
function optionalProfiles(body: Record<string, unknown>): PlotProfile[] | null | undefined {
  const value = body['profiles'];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) throw badRequest('invalid_request', 'profiles must be an array or null');
  const profiles = coercePlotProfiles(value);
  return profiles.length > 0 ? profiles : null;
}

/** Same shape of answer for the custom UI: nothing declared is stored as nothing. */
function optionalCustomUi(body: Record<string, unknown>): PlotCustomUi | null | undefined {
  const value = body['customUi'];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_request', 'customUi must be an object or null');
  }
  const customUi = coerceCustomUi(value);
  return Object.keys(customUi).length > 0 ? customUi : null;
}

/** The explore filter column, written directly rather than derived from a card. */
function coerceTags(body: Record<string, unknown>): string[] | undefined {
  const value = body['tags'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest('invalid_request', 'tags must be an array');
  for (const tag of value) {
    if (typeof tag !== 'string') throw badRequest('invalid_request', 'tags must be strings');
  }
  return normalizeTags(value as string[]);
}

/** A plot may only be published once it has enough substance to be worth finding. */
function requirePublishable(plot: Plot): void {
  const missing = [
    ...(plot.name.trim() ? [] : ['name']),
    ...(plot.description.trim() ? [] : ['description']),
    ...(plot.intros.some((intro) => intro.trim()) ? [] : ['intros']),
  ];
  if (missing.length > 0) {
    throw badRequest('not_publishable', `Cannot publish: ${missing.join(', ')} must not be empty`);
  }
}

/** The whole plot as its owner edits it. Nothing here is public but by choice. */
const toPlotJson = (plot: Plot) => ({
  id: plot.id,
  name: plot.name,
  intro: plot.intro,
  description: plot.description,
  coverUrl: coverUrl(plot),
  lorebook: plot.lorebook,
  intros: plot.intros,
  narrator: plot.narrator,
  style: plot.style,
  /** Always an array on the way out; the column is null until one is written. */
  profiles: plot.profiles ?? [],
  customUi: plot.customUi,
  language: plot.language,
  visibility: plot.visibility,
  safetyLevel: plot.safetyLevel,
  commentsEnabled: plot.commentsEnabled,
  tags: plot.tags,
  likeCount: plot.likeCount,
  chatCount: plot.chatCount,
  publishedAt: plot.publishedAt?.toISOString() ?? null,
  createdAt: plot.createdAt.toISOString(),
  updatedAt: plot.updatedAt.toISOString(),
});

/** A member as its own creator sees it: the whole card, since they wrote it. */
const toMemberJson = (member: Character) => ({
  id: member.id,
  name: member.name,
  card: member.card,
  avatarUrl: avatarUrl(member),
  orderIndex: member.orderIndex,
  createdAt: member.createdAt.toISOString(),
  updatedAt: member.updatedAt.toISOString(),
});

/**
 * An asset is addressed by its slug, never by its row id or stored path.
 *
 * The unlock condition is the creator's alone: its keywords are the spoiler the
 * reveal is worth having, so only the owner's reads carry it. What a reader is
 * told is the chat's `assetLocks` — whether it is open, and which kind of
 * condition it waits on.
 */
const toAssetJson = (asset: PlotAsset, owner = false) => ({
  slug: asset.slug,
  url: assetUrl(asset.plotId, asset.slug),
  mime: asset.mime,
  // Null for everything uploaded before the measurement existed; the reader
  // gets the same image, just without a box reserved for it.
  width: asset.width,
  height: asset.height,
  thumbhash: asset.thumbhash,
  ...(owner ? { unlock: asset.unlock } : {}),
  createdAt: asset.createdAt.toISOString(),
});

/** Loads a member of a plot the caller owns; anything else is simply not found. */
async function loadOwnedMember(
  deps: AppDeps,
  plotId: string,
  characterId: string,
  userId: string,
): Promise<Character> {
  await loadOwnedPlot(deps, plotId, userId);
  const [member] = await deps.db
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.plotId, plotId)))
    .limit(1);
  if (!member) throw notFound('Character not found');
  return member;
}

/**
 * Inserts a member under the roster cap. The cap is a count, and a count only
 * means something while nothing else can insert: the plot row is locked for the
 * whole check-then-write, so two creates racing at nine cannot both see room.
 */
async function insertMember(
  deps: AppDeps,
  plotId: string,
  name: string,
  card: NormalizedCard,
): Promise<Character> {
  return deps.db.transaction(async (tx) => {
    await tx.select({ id: plots.id }).from(plots).where(eq(plots.id, plotId)).for('update');
    const [counted] = await tx
      .select({ value: sql<number>`count(*)::int`, next: sql<number>`coalesce(max(${characters.orderIndex}), -1) + 1` })
      .from(characters)
      .where(eq(characters.plotId, plotId));
    if ((counted?.value ?? 0) >= MAX_CHARACTERS_PER_PLOT) {
      throw badRequest(
        'character_limit',
        `A plot holds at most ${MAX_CHARACTERS_PER_PLOT} characters`,
      );
    }
    const [created] = await tx
      .insert(characters)
      .values({ plotId, name, card, orderIndex: counted?.next ?? 0 })
      .returning();
    return created!;
  });
}

/**
 * Stores the images a charx archive carried beside the icon. Slugs come from the
 * asset names so `{{img::slug}}` written into the card keeps working; a name with
 * nothing sluggable left falls back to its position, and collisions get a suffix.
 * Bytes that turn out not to be an image are skipped rather than failing the import.
 *
 * The rows are written under the plot's row lock, the same lock an upload takes:
 * the cap is a count, and a count only means something while nothing else can
 * insert. Two imports racing on one plot would otherwise both read the same free
 * space and both allocate the same slugs — the second insert dying on the unique
 * constraint with its objects already in the store.
 *
 * The bytes go in before the lock is taken, because storing them is the slow part
 * and a `for update` held across it would serialize every upload on the plot for
 * the length of an archive. What that costs is objects nobody ends up naming —
 * the ones that no longer fit once the lock is held, and every one of them if the
 * write fails — so they are deleted again on the way out.
 */
async function storeImportedAssets(
  deps: AppDeps,
  plotId: string,
  assets: CharxAssetFile[],
): Promise<void> {
  /** An image already in the store, still waiting for a row to name it. */
  interface StoredCandidate {
    id: string;
    /** The archive's own name and position, which is what a slug is derived from. */
    name: string;
    index: number;
    key: string;
    mime: string;
  }

  // Never more candidates than an empty plot could hold: a larger archive must
  // not pay to store what could not fit under any reading of the cap.
  const candidates: StoredCandidate[] = [];
  // Every object in the store, until the transaction says which of them it kept.
  // Keys go in as each put lands, so a throw anywhere — the nth put included —
  // takes every already-stored object with it.
  let orphaned: string[] = [];
  try {
    for (const [index, asset] of assets.entries()) {
      if (candidates.length >= MAX_ASSETS_PER_PLOT) break;
      const id = randomUUID();
      const stored = await saveAsset(deps.storage, id, asset.bytes);
      if (!stored) continue;
      candidates.push({ id, name: asset.name, index, key: stored.key, mime: stored.mime });
      orphaned.push(stored.key);
    }
    if (candidates.length === 0) return;

    orphaned = await deps.db.transaction(async (tx) => {
      await tx.select({ id: plots.id }).from(plots).where(eq(plots.id, plotId)).for('update');
      const existing = await tx
        .select({ slug: plotAssets.slug })
        .from(plotAssets)
        .where(eq(plotAssets.plotId, plotId));
      // Read under the lock, so the room and the slugs are the ones that hold at
      // the moment of the insert rather than the ones that held before it.
      const taken = new Set(existing.map((asset) => asset.slug));
      const fitting = candidates.slice(0, Math.max(0, MAX_ASSETS_PER_PLOT - taken.size));

      const rows: NewPlotAsset[] = fitting.map((candidate) => {
        const slug = uniqueSlug(
          normalizeSlug(candidate.name) ?? `asset-${candidate.index + 1}`,
          taken,
        );
        taken.add(slug);
        return { id: candidate.id, plotId, slug, path: candidate.key, mime: candidate.mime };
      });
      if (rows.length > 0) await tx.insert(plotAssets).values(rows);
      return candidates.slice(rows.length).map((candidate) => candidate.key);
    });
  } finally {
    // Outside the transaction, as everywhere: an object is garbage exactly when
    // no row will ever name it.
    for (const key of orphaned) await deleteQuietly(deps.storage, key);
  }
}

/** The card file a `multipart/form-data` import carries. */
async function readCardUpload(c: { req: { formData: () => Promise<FormData> } }): Promise<{
  parsed: ReturnType<typeof parseCard>;
  fileName: string;
}> {
  let file: unknown;
  try {
    file = (await c.req.formData()).get('file');
  } catch {
    throw badRequest('invalid_request', 'Expected multipart/form-data with a file field');
  }
  if (!(file instanceof File)) throw badRequest('invalid_request', 'file field is required');

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return { parsed: parseCard(bytes), fileName: file.name };
  } catch (error) {
    throw badRequest('invalid_card', error instanceof Error ? error.message : 'Unreadable character card');
  }
}

/**
 * `Content-Disposition` for a download named after a character: the name as
 * written in RFC 5987 form, and an ASCII stand-in for clients that predate it.
 * `encodeURIComponent` leaves `'()*` alone, which RFC 5987 does not allow.
 */
function attachment(name: string, extension: string): string {
  const file = `${name.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim() || 'character'}.${extension}`;
  const ascii = file.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(file).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Applies a like delta (0 when the like row did not change) and returns the count. */
async function bumpLikeCount(tx: Tx, plotId: string, delta: number): Promise<number> {
  if (delta === 0) {
    const [row] = await tx
      .select({ likeCount: plots.likeCount })
      .from(plots)
      .where(eq(plots.id, plotId));
    return row!.likeCount;
  }
  const [row] = await tx
    .update(plots)
    .set({ likeCount: sql`${plots.likeCount} + ${delta}` })
    .where(eq(plots.id, plotId))
    .returning({ likeCount: plots.likeCount });
  return row!.likeCount;
}

/**
 * The plot and everything that hangs off it — its roster, its assets, its cover,
 * its public page. Public reads and owner-only writes in one router, so the
 * session guard is per route rather than at the mount (app.ts). What a reader
 * without an account may take: the public view of a published plot, its cover,
 * its members' avatars and its assets. Everything else carries `requireUser`.
 */
export function plotRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', requireUser, async (c) => {
    const rows = await deps.db
      .select()
      .from(plots)
      .where(eq(plots.ownerId, c.get('userId')))
      .orderBy(desc(plots.updatedAt));
    return c.json(rows.map(toPlotJson));
  });

  app.post('/', requireUser, async (c) => {
    const body = await readJsonBody(c);
    const name = requireString(body, 'name').trim();
    if (!name) throw badRequest('invalid_request', 'name must not be empty');
    const language = coerceLanguage(optionalString(body, 'language'));
    const intros = coerceIntros(body);
    const tags = coerceTags(body);
    // Everything the editor may set later it may also set at once: a create is a
    // patch onto an empty row, and two field lists would drift.
    const narrator = optionalNarrator(body);
    const style = optionalStyle(body);
    const profiles = optionalProfiles(body);
    const customUi = optionalCustomUi(body);
    const safetyLevel = coerceSafetyLevel(optionalString(body, 'safetyLevel'));
    const commentsEnabled = optionalBoolean(body, 'commentsEnabled');

    const [created] = await deps.db
      .insert(plots)
      .values({
        ownerId: c.get('userId'),
        name,
        intro: coerceIntro(body) ?? '',
        description: optionalString(body, 'description') ?? '',
        ...(body['lorebook'] === undefined ? {} : { lorebook: coerceLorebook(body['lorebook']) }),
        ...(intros !== undefined ? { intros } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(narrator ? { narrator } : {}),
        ...(style ? { style } : {}),
        ...(profiles ? { profiles } : {}),
        ...(customUi ? { customUi } : {}),
        ...(safetyLevel !== undefined ? { safetyLevel } : {}),
        ...(commentsEnabled !== undefined ? { commentsEnabled } : {}),
        ...(language ? { language } : {}),
      })
      .returning();
    return c.json(toPlotJson(created!), 201);
  });

  /**
   * Importing a card creates the work it was always describing: the card becomes
   * the first member and everything on it that belongs to a work rather than to a
   * person — the situation, the openings, the narrator, the custom UI — is lifted
   * onto the plot around it. Card files are user-controlled bytes, so every parse
   * failure is a 400, never a 500.
   */
  app.post('/import', requireUser, async (c) => {
    const { parsed, fileName } = await readCardUpload(c);
    const card = parsed.card;
    const name = card.name.trim() || fileName.replace(/\.[^.]+$/, '') || 'Unnamed';
    // The setting the model is told, which on a card is split across two fields.
    const description = [card.description.trim(), card.scenario.trim()]
      .filter((part) => part.length > 0)
      .join('\n\n');
    const intros = [card.firstMes, ...card.alternateGreetings]
      .filter((intro) => intro.trim().length > 0)
      .slice(0, MAX_INTROS_PER_PLOT)
      .map((intro) => intro.slice(0, MAX_INTRO_TEXT_LENGTH));
    const customUi = customUiOfCard(card);

    const [created] = await deps.db
      .insert(plots)
      .values({
        ownerId: c.get('userId'),
        name,
        intro: card.intro ?? '',
        description,
        intros,
        tags: normalizeTags(card.tags),
        ...(card.narrator ? { narrator: card.narrator } : {}),
        ...(Object.keys(customUi).length > 0 ? { customUi } : {}),
      })
      .returning();
    const plot = created!;

    const member = await insertMember(deps, plot.id, name, card);
    if (parsed.iconBuffer) await writeMemberAvatar(deps, member, parsed.iconBuffer);
    if (parsed.assets?.length) await storeImportedAssets(deps, plot.id, parsed.assets);

    return c.json(await ownerView(deps, plot), 201);
  });

  /**
   * A first version of a work, written from one premise. Nothing is stored: the
   * draft comes back as the fields a create takes, and the plot editor creates the
   * plot through the ordinary POST — so the editor is the review surface and a
   * draft nobody liked leaves no row behind.
   *
   * Registered before `/:id`, which has no POST of its own but would take the
   * path if it ever grew one.
   */
  app.post('/draft', requireUser, async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const premise = requireString(body, 'premise').trim();
    if (!premise) throw badRequest('invalid_request', 'premise must not be empty');
    if (premise.length > MAX_PREMISE_LENGTH) {
      throw badRequest('invalid_request', `premise must be at most ${MAX_PREMISE_LENGTH} characters`);
    }

    // One draft per creator at a time. The call is a minute long at worst, and a
    // creator hammering the button would otherwise pay for every one of them.
    if (deps.drafting.has(userId)) {
      throw new ApiError(429, 'draft_in_progress', 'A draft is already being written for this user');
    }
    deps.drafting.add(userId);
    try {
      return c.json(await draftPlot(deps, userId, premise));
    } finally {
      deps.drafting.delete(userId);
    }
  });

  // The owner's view: the plot plus everything currently set in it.
  app.get('/:id', requireUser, async (c) => {
    const userId = c.get('userId');
    const plot = await loadOwnedPlot(deps, requireUuidParam(c), userId);
    return c.json(await ownerView(deps, plot));
  });

  app.patch('/:id', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadOwnedPlot(deps, id, userId);
    const body = await readJsonBody(c);

    const name = optionalString(body, 'name')?.trim();
    if (name !== undefined && !name) throw badRequest('invalid_request', 'name must not be empty');
    const intro = coerceIntro(body);
    const description = optionalString(body, 'description');
    const language = coerceLanguage(optionalString(body, 'language'));
    const intros = coerceIntros(body);
    const tags = coerceTags(body);
    const narrator = optionalNarrator(body);
    const style = optionalStyle(body);
    const profiles = optionalProfiles(body);
    const customUi = optionalCustomUi(body);
    const safetyLevel = coerceSafetyLevel(optionalString(body, 'safetyLevel'));
    const commentsEnabled = optionalBoolean(body, 'commentsEnabled');

    const [updated] = await deps.db
      .update(plots)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(intro !== undefined ? { intro } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(body['lorebook'] === undefined ? {} : { lorebook: coerceLorebook(body['lorebook']) }),
        ...(intros !== undefined ? { intros } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(narrator !== undefined ? { narrator } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(profiles !== undefined ? { profiles } : {}),
        ...(customUi !== undefined ? { customUi } : {}),
        ...(safetyLevel !== undefined ? { safetyLevel } : {}),
        ...(commentsEnabled !== undefined ? { commentsEnabled } : {}),
        ...(language ? { language } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(plots.id, id), eq(plots.ownerId, userId)))
      .returning();
    return c.json(await ownerView(deps, updated!));
  });

  // Everything hanging off the plot goes with it — the roster, the assets, the
  // likes, the comments, the chats. The files those rows named do not: nothing is
  // left to point at them, so they are ours to clean up.
  app.delete('/:id', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const plot = await loadOwnedPlot(deps, id, userId);
    const members = await loadMembers(deps.db, id);
    const assets = await deps.db
      .select({ path: plotAssets.path })
      .from(plotAssets)
      .where(eq(plotAssets.plotId, id));

    await deps.db.delete(plots).where(and(eq(plots.id, id), eq(plots.ownerId, userId)));
    if (plot.coverPath) await deleteQuietly(deps.storage, plot.coverPath);
    for (const member of members) {
      if (member.avatarPath) await deleteQuietly(deps.storage, member.avatarPath);
    }
    for (const asset of assets) await deleteQuietly(deps.storage, asset.path);
    return c.body(null, 204);
  });

  // Publishing is owner-only, and only for a plot that carries the basics.
  app.post('/:id/publish', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const plot = await loadOwnedPlot(deps, id, userId);
    const body = await readJsonBody(c);
    const publish = body['publish'];
    if (typeof publish !== 'boolean') throw badRequest('invalid_request', 'publish must be a boolean');
    const safetyLevel = coerceSafetyLevel(optionalString(body, 'safetyLevel'));
    if (publish) requirePublishable(plot);
    // Avatars imported before the card stripping existed are cleaned up here, so
    // going public never exposes an embedded card.
    if (publish) {
      for (const member of await loadMembers(deps.db, id)) {
        if (member.avatarPath) await sanitizeStoredAvatar(deps.storage, member.avatarPath);
      }
    }

    const updated = await deps.db.transaction(async (tx) => {
      // Whether this is the first publish is a check-then-write, and it only
      // means something while nothing else can publish: two clicks racing on one
      // plot would otherwise both read an unstamped row and notify twice.
      const [locked] = await tx
        .select({ publishedAt: plots.publishedAt })
        .from(plots)
        .where(eq(plots.id, id))
        .for('update');
      const [row] = await tx
        .update(plots)
        .set({
          visibility: publish ? 'public' : 'private',
          // The audience is declared with the publish, but stored either way: an
          // unpublish must not quietly reset a plot to 'all'.
          ...(safetyLevel !== undefined ? { safetyLevel } : {}),
          // Kept on unpublish: it only ever matters while the row is public.
          ...(publish ? { publishedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(plots.id, id), eq(plots.ownerId, userId)))
        .returning();

      // Followers hear about a work once, when it first goes public — the moment
      // `publishedAt` is stamped, which only ever happens once because an
      // unpublish keeps it. So re-publishing, and toggling the visibility back
      // and forth, mint nothing. An adult plot is published in name only until
      // age verification exists (`publiclyListed`), so notifying about one would
      // hand every follower a link they cannot open; it is left unannounced
      // rather than announced late.
      //
      // The fan-out itself is queued rather than done here: it is the publish that
      // decides whether followers are told, and the queue that tells them. The
      // enqueue is inside this transaction, so a publish that rolls back leaves no
      // announcement of a plot that never went public.
      if (publish && locked?.publishedAt === null && row!.safetyLevel === 'all') {
        await enqueueJob(tx, 'notification_fanout', {
          kind: 'plot_published',
          plotId: row!.id,
          actorId: row!.ownerId,
          // The stamp this publish just wrote, which is the fan-out's cutoff: it is
          // whose followers were told, not when the telling happened.
          publishedAt: row!.publishedAt!.toISOString(),
        });
      }
      return row!;
    });
    return c.json(await ownerView(deps, updated));
  });

  /**
   * The public face of a plot: what it is called, what it is about, who is in it
   * and how it opens. The lorebook, the description the model is told and every
   * member's card stay on the server — prompts are assembled here, so nothing a
   * reader receives is a definition.
   *
   * The custom UI travels because it is presentation rather than definition:
   * without it the creator's status window would only render for the creator.
   */
  app.get('/:id/public', async (c) => {
    const viewerId = c.get('viewerId');
    const [row] = await publicPlotQuery(deps.db, viewerId)
      .where(and(eq(plots.id, requireUuidParam(c)), visibleToViewer(viewerId)))
      .limit(1);
    if (!row) throw notFound('Plot not found');
    const plot = row.plot;
    const members = await loadMembers(deps.db, plot.id);
    const commentCount = await countComments(deps.db, plot);
    // The follow edge to the creator rides along so the page's follow button
    // does not have to fetch the creator's whole public listing for two numbers.
    const creatorFollow = await followState(deps.db, plot.ownerId, viewerId);

    return c.json({
      public: true,
      creatorFollow,
      ...toPublicPlotJson(row, members),
      // The one card field written for readers rather than for the model, so it is
      // the one that may leave with the public view.
      characters: members.map((member) => ({
        id: member.id,
        name: member.name,
        avatarUrl: avatarUrl(member),
        intro: member.card.intro ?? '',
      })),
      // The openings, uncut — this is the page a reader decides on, and the
      // listings' `introPreview` is the only place the 200-character cut belongs.
      intros: plot.intros.map(publicIntro),
      introPreviews: plot.intros.map((intro) => publicIntro(intro).slice(0, 200)),
      // The style travels because it is options rather than prompt text: it is the
      // badge row a reader decides on, and the chat page reads the two derived
      // features off it to know which of its own toggles are worth offering.
      // The narrator's `pov` is an option too and rides along for the POV badge;
      // its `voice` is prompt text and stays with the owner.
      style: plot.style,
      // The recommended profiles travel for the same reason: they are written for
      // readers, and the start panel is where one is picked. Nothing here reaches
      // the prompt — the persona a pick copies out does.
      profiles: plot.profiles ?? [],
      narrator: plot.narrator?.pov ? { pov: plot.narrator.pov } : null,
      displayScripts: plot.customUi?.displayScripts ?? [],
      defaultVariables: plot.customUi?.defaultVariables ?? {},
      componentCode: plot.customUi?.componentCode ?? '',
      componentCapabilities: plot.customUi?.componentCapabilities ?? [],
      commentsEnabled: plot.commentsEnabled,
      commentCount,
    });
  });

  // Idempotent: the counter moves only when a like row actually appears/disappears.
  app.post('/:id/like', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadVisiblePlot(deps.db, id, userId);

    const likeCount = await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(plotLikes)
        .values({ userId, plotId: id })
        .onConflictDoNothing()
        .returning();
      return bumpLikeCount(tx, id, inserted.length > 0 ? 1 : 0);
    });
    return c.json({ liked: true, likeCount });
  });

  app.delete('/:id/like', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadVisiblePlot(deps.db, id, userId);

    const likeCount = await deps.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(plotLikes)
        .where(and(eq(plotLikes.userId, userId), eq(plotLikes.plotId, id)))
        .returning();
      return bumpLikeCount(tx, id, deleted.length > 0 ? -1 : 0);
    });
    return c.json({ liked: false, likeCount });
  });

  /* ------------------------------------------------------------- the roster */

  app.get('/:id/characters', requireUser, async (c) => {
    const plot = await loadOwnedPlot(deps, requireUuidParam(c), c.get('userId'));
    const members = await loadMembers(deps.db, plot.id);
    return c.json(members.map(toMemberJson));
  });

  app.post('/:id/characters', requireUser, async (c) => {
    const id = requireUuidParam(c);
    await loadOwnedPlot(deps, id, c.get('userId'));
    const body = await readJsonBody(c);
    const name = requireString(body, 'name').trim();
    if (!name) throw badRequest('invalid_request', 'name must not be empty');
    const card = body['card'] === undefined ? emptyCard(name) : coerceCard(body['card'], name);
    return c.json(toMemberJson(await insertMember(deps, id, name, card)), 201);
  });

  // Registered before `/:characterId`, which would otherwise swallow both.
  app.post('/:id/characters/import', requireUser, async (c) => {
    const id = requireUuidParam(c);
    await loadOwnedPlot(deps, id, c.get('userId'));
    const { parsed, fileName } = await readCardUpload(c);
    const name = parsed.card.name.trim() || fileName.replace(/\.[^.]+$/, '') || 'Unnamed';

    // Nothing is lifted onto the plot: it already has a narrator and a custom UI
    // of its own, and a member joining a cast does not get to redecorate it. Its
    // images do land as the plot's, because `{{img::slug}}` resolves there.
    let member = await insertMember(deps, id, name, parsed.card);
    if (parsed.iconBuffer) member = await writeMemberAvatar(deps, member, parsed.iconBuffer);
    if (parsed.assets?.length) await storeImportedAssets(deps, id, parsed.assets);
    return c.json(toMemberJson(member), 201);
  });

  /**
   * The creator's arrangement, rewritten whole: the body is every member of the
   * roster, in the order they should stand. A partial list would leave the
   * unnamed members at indexes the request never decided.
   */
  app.post('/:id/characters/reorder', requireUser, async (c) => {
    const id = requireUuidParam(c);
    await loadOwnedPlot(deps, id, c.get('userId'));
    const body = await readJsonBody(c);
    const value = body['ids'];
    if (!Array.isArray(value)) throw badRequest('invalid_request', 'ids must be an array');
    const ids = value.map((entry) => {
      if (typeof entry !== 'string' || !isUuid(entry)) {
        throw badRequest('invalid_request', 'ids must be character ids');
      }
      return entry;
    });

    const members = await deps.db.transaction(async (tx) => {
      await tx.select({ id: plots.id }).from(plots).where(eq(plots.id, id)).for('update');
      const current = await tx
        .select({ id: characters.id })
        .from(characters)
        .where(eq(characters.plotId, id));
      const known = new Set(current.map((member) => member.id));
      if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((one) => !known.has(one))) {
        throw badRequest('invalid_request', 'ids must name every character of this plot exactly once');
      }
      for (const [index, characterId] of ids.entries()) {
        await tx
          .update(characters)
          .set({ orderIndex: index, updatedAt: new Date() })
          .where(and(eq(characters.id, characterId), eq(characters.plotId, id)));
      }
      return loadMembers(tx, id);
    });
    return c.json(members.map(toMemberJson));
  });

  app.patch('/:id/characters/:characterId', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const characterId = requireUuidParam(c, 'characterId');
    const userId = c.get('userId');
    const member = await loadOwnedMember(deps, id, characterId, userId);
    const body = await readJsonBody(c);

    const name = optionalString(body, 'name')?.trim();
    if (name !== undefined && !name) throw badRequest('invalid_request', 'name must not be empty');
    const card = body['card'] === undefined ? undefined : coerceCard(body['card'], name ?? member.name);

    const [updated] = await deps.db
      .update(characters)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(card !== undefined ? { card } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(characters.id, characterId), eq(characters.plotId, id)))
      .returning();
    return c.json(toMemberJson(updated!));
  });

  app.delete('/:id/characters/:characterId', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const characterId = requireUuidParam(c, 'characterId');
    const member = await loadOwnedMember(deps, id, characterId, c.get('userId'));
    await deps.db
      .delete(characters)
      .where(and(eq(characters.id, characterId), eq(characters.plotId, id)));
    if (member.avatarPath) await deleteQuietly(deps.storage, member.avatarPath);
    return c.body(null, 204);
  });

  /**
   * A member's picture. Readable by anyone who may read the plot, and streamed
   * through the API under every driver for the same reason an asset is: it is an
   * `<img>` on our origin, and the chat export names it as one.
   */
  app.get('/:id/characters/:characterId/avatar', async (c) => {
    const plot = await loadVisiblePlot(deps.db, requireUuidParam(c), c.get('viewerId'));
    const [member] = await deps.db
      .select()
      .from(characters)
      .where(
        and(eq(characters.id, requireUuidParam(c, 'characterId')), eq(characters.plotId, plot.id)),
      )
      .limit(1);
    if (!member) throw notFound('Character not found');
    if (!member.avatarPath) throw notFound('Character has no avatar');
    const object = await deps.storage.get(member.avatarPath);
    if (!object) throw notFound('Avatar file is missing');
    return new Response(object.body, {
      headers: {
        'Content-Type': mimeForPath(member.avatarPath),
        'Content-Length': String(object.size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });

  /**
   * Setting an avatar without going through a card import. `saveAvatar` is the
   * same call the import path makes, so a PNG carrying a card is stripped here
   * too — the bytes are served to everyone who can see the plot.
   */
  app.post('/:id/characters/:characterId/avatar', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const characterId = requireUuidParam(c, 'characterId');
    const member = await loadOwnedMember(deps, id, characterId, c.get('userId'));

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw badRequest('invalid_request', 'Expected multipart/form-data with a file field');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('invalid_request', 'file field is required');
    // The route's own statement of the cap, checked before the bytes are read.
    // The platform's 5MB body limit (app.ts) covers the whole multipart body and
    // so answers 413 first for anything near it; this one names the file itself,
    // which is what the editor tells the creator.
    if (file.size > MAX_IMAGE_BYTES) {
      throw badRequest('payload_too_large', `An avatar is at most ${MAX_IMAGE_BYTES} bytes`);
    }

    const updated = await writeMemberAvatar(deps, member, new Uint8Array(await file.arrayBuffer()));
    return c.json(toMemberJson(updated));
  });

  app.delete('/:id/characters/:characterId/avatar', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const characterId = requireUuidParam(c, 'characterId');
    const member = await loadOwnedMember(deps, id, characterId, c.get('userId'));

    const [updated] = await deps.db
      .update(characters)
      .set({ avatarPath: null, updatedAt: new Date() })
      .where(and(eq(characters.id, characterId), eq(characters.plotId, id)))
      .returning();
    if (member.avatarPath) await deleteQuietly(deps.storage, member.avatarPath);
    return c.json(toMemberJson(updated!));
  });

  /**
   * A member as a card file again — for SillyTavern, RisuAI, or an import here.
   * The stored card goes out with what the plot holds for the work written over
   * it: the narrator, the custom UI, the openings and the plot lorebook (see
   * `CardPlotOverlay`). The owner's alone, like every whole card: a published
   * plot shows readers its cast, never their definitions.
   *
   * The PNG is the member's avatar (else the plot cover) with its text chunks
   * stripped and the card written in; one that is not a PNG gives way to a plain
   * placeholder, since nothing here transcodes images.
   */
  app.get('/:id/characters/:characterId/export', requireUser, async (c) => {
    const plot = await loadOwnedPlot(deps, requireUuidParam(c), c.get('userId'));
    const [member] = await deps.db
      .select()
      .from(characters)
      .where(
        and(eq(characters.id, requireUuidParam(c, 'characterId')), eq(characters.plotId, plot.id)),
      )
      .limit(1);
    if (!member) throw notFound('Character not found');
    const format = c.req.query('format') ?? 'json';
    if (format !== 'json' && format !== 'png') {
      throw badRequest('invalid_request', 'format must be json or png');
    }

    const card = exportCardV3(member.card, {
      narrator: plot.narrator ?? undefined,
      // The plot's custom UI is the whole answer even when empty: the card's own
      // copies are what the import lifted off it.
      customUi: plot.customUi ?? {},
      intros: plot.intros,
      lorebook: plot.lorebook,
    });
    const headers = {
      'Content-Disposition': attachment(member.name, format),
      'Cache-Control': 'no-store',
    };
    if (format === 'json') {
      return new Response(JSON.stringify(card), {
        headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    const imagePath = member.avatarPath ?? plot.coverPath;
    const object = imagePath ? await deps.storage.get(imagePath) : null;
    const image = object ? await readAll(object.body) : undefined;
    return new Response(exportCardPng(card, image), {
      headers: { ...headers, 'Content-Type': 'image/png' },
    });
  });

  /* ------------------------------------------------------------- the assets */

  // Assets follow the cover's visibility rules: anyone who may read the plot may
  // read its images, but only the owner may change them.
  app.get('/:id/assets', async (c) => {
    const viewerId = c.get('viewerId');
    const plot = await loadVisiblePlot(deps.db, requireUuidParam(c), viewerId);
    const rows = await deps.db
      .select()
      .from(plotAssets)
      .where(eq(plotAssets.plotId, plot.id))
      // Upload order; the slug breaks the tie a bulk charx import leaves behind.
      .orderBy(asc(plotAssets.createdAt), asc(plotAssets.slug));
    return c.json(rows.map((asset) => toAssetJson(asset, plot.ownerId === viewerId)));
  });

  app.post('/:id/assets', requireUser, async (c) => {
    const id = requireUuidParam(c);
    await loadOwnedPlot(deps, id, c.get('userId'));

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw badRequest('invalid_request', 'Expected multipart/form-data with file and slug fields');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('invalid_request', 'file field is required');
    const slug = normalizeSlug(String(form.get('slug') ?? ''));
    if (!slug) throw badRequest('invalid_asset', 'slug must contain at least one of [a-z0-9-_]');
    const preview = coerceAssetPreview(form.get('width'), form.get('height'), form.get('thumbhash'));

    const assetId = randomUUID();
    const bytes = new Uint8Array(await file.arrayBuffer());

    // The cap is a count, and a count only means something while nothing else can
    // insert: the plot row is locked for the whole check-then-write, so two
    // uploads racing at 99 cannot both see room.
    const { asset, replaced } = await deps.db.transaction(async (tx) => {
      await tx.select({ id: plots.id }).from(plots).where(eq(plots.id, id)).for('update');

      // Re-uploading a slug replaces it, so only a new one has to fit under the cap.
      const [existing] = await tx
        .select()
        .from(plotAssets)
        .where(and(eq(plotAssets.plotId, id), eq(plotAssets.slug, slug)))
        .limit(1);
      if (!existing) {
        const [counted] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(plotAssets)
          .where(eq(plotAssets.plotId, id));
        if ((counted?.value ?? 0) >= MAX_ASSETS_PER_PLOT) {
          throw badRequest('asset_limit', `A plot holds at most ${MAX_ASSETS_PER_PLOT} assets`);
        }
      }

      // After the cap check, so a refused upload leaves no object behind.
      const stored = await saveAsset(deps.storage, assetId, bytes);
      if (!stored) throw badRequest('invalid_asset', 'Unsupported image file');

      // The measurement belongs to the bytes, so a replacement writes it whole —
      // nulls included, or the new image would be drawn in the old one's box.
      const measured = {
        width: preview?.width ?? null,
        height: preview?.height ?? null,
        thumbhash: preview?.thumbhash ?? null,
      };
      const [row] = await tx
        .insert(plotAssets)
        .values({ id: assetId, plotId: id, slug, path: stored.key, mime: stored.mime, ...measured })
        .onConflictDoUpdate({
          target: [plotAssets.plotId, plotAssets.slug],
          // createdAt stays put: a replaced image keeps its place in the grid.
          set: { path: stored.key, mime: stored.mime, ...measured },
        })
        .returning();
      return { asset: row!, replaced: existing?.path };
    });
    // Outside the transaction: the replaced object only becomes garbage once the
    // row that pointed at it is really gone.
    if (replaced) await deleteQuietly(deps.storage, replaced);
    return c.json(toAssetJson(asset, true), 201);
  });

  /**
   * The asset's unlock condition, which is the only thing about an asset that is
   * edited without re-uploading its bytes — a PATCH rather than a field on the
   * multipart upload, so the editor can set it on an image that is already there
   * and a re-upload of the same slug never has to restate it.
   *
   * `unlock: null` clears it, and so does a condition this build cannot evaluate
   * (`coerceAssetUnlock`): an unlock nothing can open would leave the image locked
   * forever.
   */
  app.patch('/:id/assets/:slug', requireUser, async (c) => {
    const id = requireUuidParam(c);
    await loadOwnedPlot(deps, id, c.get('userId'));
    const body = await readJsonBody(c);
    const value = body['unlock'];
    if (value === undefined) throw badRequest('invalid_request', 'unlock is required');
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      throw badRequest('invalid_request', 'unlock must be an object or null');
    }

    const [updated] = await deps.db
      .update(plotAssets)
      .set({ unlock: coerceAssetUnlock(value) })
      .where(and(eq(plotAssets.plotId, id), eq(plotAssets.slug, c.req.param('slug')!)))
      .returning();
    if (!updated) throw notFound('Asset not found');
    return c.json(toAssetJson(updated, true));
  });

  /**
   * The bytes, streamed through the API under **every** driver — this route never
   * redirects to the store, however capable the driver is.
   *
   * The web sanitizer accepts same-origin images, including `{{img::slug}}`.
   * Serving assets here preserves that boundary for both storage drivers.
   */
  app.get('/:id/assets/:slug', async (c) => {
    const plot = await loadVisiblePlot(deps.db, requireUuidParam(c), c.get('viewerId'));
    const [asset] = await deps.db
      .select()
      .from(plotAssets)
      .where(and(eq(plotAssets.plotId, plot.id), eq(plotAssets.slug, c.req.param('slug')!)))
      .limit(1);
    if (!asset) throw notFound('Asset not found');

    const object = await deps.storage.get(asset.path);
    if (!object) throw notFound('Asset file is missing');
    return new Response(object.body, {
      headers: {
        'Content-Type': asset.mime,
        'Content-Length': String(object.size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });

  app.delete('/:id/assets/:slug', requireUser, async (c) => {
    const id = requireUuidParam(c);
    await loadOwnedPlot(deps, id, c.get('userId'));
    const [deleted] = await deps.db
      .delete(plotAssets)
      .where(and(eq(plotAssets.plotId, id), eq(plotAssets.slug, c.req.param('slug')!)))
      .returning();
    if (!deleted) throw notFound('Asset not found');
    await deleteQuietly(deps.storage, deleted.path);
    return c.body(null, 204);
  });

  /* -------------------------------------------------------------- the cover */

  /**
   * The cover image, owner-only to change and readable by anyone who can read the
   * plot's public face. Streamed through the API under every driver, exactly as
   * an avatar is: it is an `<img>` on our origin, and a presigned redirect would
   * fail the sanitizer's same-origin rule.
   */
  app.post('/:id/cover', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const plot = await loadOwnedPlot(deps, id, userId);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw badRequest('invalid_request', 'Expected multipart/form-data with a file field');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('invalid_request', 'file field is required');
    if (file.size > MAX_IMAGE_BYTES) {
      throw badRequest('payload_too_large', `A cover image is at most ${MAX_IMAGE_BYTES} bytes`);
    }

    // Through `storableImage` rather than straight to the store: a cover is
    // served to every reader of the work, and a card PNG uploaded as one would
    // otherwise hand out the character definition in its text chunks.
    const image = storableImage(new Uint8Array(await file.arrayBuffer()));
    if (!image) throw badRequest('invalid_asset', 'Unsupported image file');

    const key = coverKey(id, image.ext);
    await deps.storage.put(key, image.bytes, image.mime);
    const [updated] = await deps.db
      .update(plots)
      .set({ coverPath: key, updatedAt: new Date() })
      .where(and(eq(plots.id, id), eq(plots.ownerId, userId)))
      .returning();
    // A re-upload in another format lands on a new key, so the old object is only
    // garbage once the row has stopped naming it.
    if (plot.coverPath && plot.coverPath !== key) {
      await deleteQuietly(deps.storage, plot.coverPath);
    }
    return c.json(await ownerView(deps, updated!));
  });

  app.delete('/:id/cover', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const plot = await loadOwnedPlot(deps, id, userId);

    const [updated] = await deps.db
      .update(plots)
      .set({ coverPath: null, updatedAt: new Date() })
      .where(and(eq(plots.id, id), eq(plots.ownerId, userId)))
      .returning();
    if (plot.coverPath) await deleteQuietly(deps.storage, plot.coverPath);
    return c.json(await ownerView(deps, updated!));
  });

  app.get('/:id/cover', async (c) => {
    const plot = await loadVisiblePlot(deps.db, requireUuidParam(c), c.get('viewerId'));
    if (!plot.coverPath) throw notFound('Plot has no cover');
    const object = await deps.storage.get(plot.coverPath);
    if (!object) throw notFound('Cover file is missing');
    return new Response(object.body, {
      headers: {
        'Content-Type': mimeForPath(plot.coverPath),
        'Content-Length': String(object.size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });

  return app;
}

/** The plot with its roster and its comment count — every owner-side answer. */
async function ownerView(deps: AppDeps, plot: Plot): Promise<unknown> {
  const members = await loadMembers(deps.db, plot.id);
  return {
    ...toPlotJson(plot),
    characters: members.map(toMemberJson),
    // Only the owner view carries the comment count: the listings are card grids,
    // and a count per card would cost a query per card.
    commentCount: await countComments(deps.db, plot),
  };
}

/** Writes a member's avatar and re-reads the row that now names it. */
async function writeMemberAvatar(
  deps: AppDeps,
  member: Character,
  bytes: Uint8Array,
): Promise<Character> {
  const avatarPath = await saveAvatar(deps.storage, member.id, bytes);
  if (!avatarPath) throw badRequest('invalid_asset', 'Unsupported image file');
  const [updated] = await deps.db
    .update(characters)
    .set({ avatarPath, updatedAt: new Date() })
    .where(eq(characters.id, member.id))
    .returning();
  // A re-upload in another format lands on a new key, so the old object is only
  // garbage once the row has stopped naming it.
  if (member.avatarPath && member.avatarPath !== avatarPath) {
    await deleteQuietly(deps.storage, member.avatarPath);
  }
  return updated!;
}
