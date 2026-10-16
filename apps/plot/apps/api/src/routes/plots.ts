import {
  backgroundHtmlOf,
  backgroundWithoutStyles,
  cardLicense,
  characterName,
  coerceAssetUnlock,
  coerceGroupSettings,
  coerceNarrator,
  coercePlotProfiles,
  coercePlotStyle,
  coerceTalkativeness,
  computeVariables,
  creatorCssOverCap,
  DEFAULT_GROUP_SETTINGS,
  constantLoreTokens,
  DEFAULT_USER_NAME,
  detectContentLanguage,
  displayScriptsFor,
  emotionScreenOf,
  emptyCard,
  exportCardCharx,
  exportCardPng,
  exportCardV3,
  introFromCreatorNotes,
  MAX_BACKGROUND_HTML_LENGTH,
  MAX_CARD_IMPORT_BYTES,
  MAX_CHARACTERS_PER_PLOT,
  MAX_INTRO_LENGTH,
  MAX_INTRO_TEXT_LENGTH,
  MAX_INTROS_PER_PLOT,
  plotModuleOf,
  readCardAssets,
  toRisuAssetRefs,
  type CardAsset,
  type CharxExportAsset,
  type EmotionImage,
  type EmotionMode,
  type GroupSettings,
  type ImportProvenance,
  type LoreEntry,
  type MacroContext,
  type NarratorConfig,
  type NormalizedCard,
  type ParsedCardSource,
  type ParsedRisuModule,
  type PlotCustomUi,
  type PlotModule,
  type PlotProfile,
  type PlotStyle,
  type SkippedAssets,
} from '@shizue/core';
import {
  draftFingerprint,
  MIGRATION_PLATFORMS_ENABLED,
  type MigrationDraft,
  type MigrationPlatform,
} from '@shizue/core/migrate';
import { sourceUrlFor } from '@shizue/core/source-url';
import { cardScripts, scriptedMember } from '@shizue/core/triggers';
import { fromLorebookFile, LorebookFileError } from '@shizue/core/world-info';
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
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import {
  assetResponse,
  assetUrl,
  byNameOf,
  coerceAssetPreview,
  MAX_ASSETS_PER_PLOT,
  normalizeSlug,
  saveAsset,
  saveAssetStream,
  uniqueSlug,
} from '../assets.js';
import {
  MAX_IMAGE_BYTES,
  mimeForPath,
  sanitizeStoredAvatar,
  saveAvatar,
  storableImage,
} from '../avatar.js';
import {
  coerceCard,
  coerceCustomUi,
  coerceLorebook,
  customUiOfCard,
  customUiOfRoster,
  customUiWithoutModules,
  extensionsWithSettings,
  liftCompanion,
  mergeCard,
  readerCustomUi,
  withoutMember,
  withStoredModules,
} from '../card.js';
import type { AppDeps, AppEnv, Tx } from '../deps.js';
import type { FileImportResult } from '@shizue/db';
import { draftPlot, MAX_PREMISE_LENGTH } from '../draft.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import type { ImportHooks } from '../fileImports.js';
import {
  avatarUrl,
  coverUrl,
  loadMembers,
  loadVisiblePlot,
  normalizeTags,
  publicIntro,
  publicPlotQuery,
  toPublicMemberJson,
  toPublicPlotJson,
  visibleToViewer,
} from '../hub.js';
import { scheduleSearchVector } from '../search.js';
import { enqueueJob } from '../jobs.js';
import { createRemoteFetch, localizePlot, type LocalizeScope } from '../localizeAssets.js';
import { requireUser } from '../session.js';
import { cbsModulesOf, loadOwnedPlot } from '../plots.js';
import { RATE_LIMITS, rateLimit } from '../rateLimit.js';
import { realmCardId, realmCharacterUrl } from '../realm.js';
import { avatarKey, coverKey, deleteQuietly, readAll } from '../storage.js';
import { isUuid, optionalBoolean, optionalString, readJsonBody, requireString, requireUuidParam } from '../util.js';
import { scheduleLoreAliases, scheduleLoreUpdate } from '../vectors.js';
import { countComments } from './comments.js';
import { followState } from './explore.js';

const LANGUAGES: ContentLanguage[] = ['ko', 'en', 'ja'];
/**
 * The levels a create, edit or publish may declare. `adult` is left out until age
 * verification exists: rows saved with it earlier keep it, but none gain it now.
 */
const SAFETY_LEVELS: SafetyLevel[] = ['all'];

/**
 * One card file (`@shizue/core`): what a file import takes (`fileImports.ts`),
 * which the import forms check before uploading.
 */
export { MAX_CARD_IMPORT_BYTES };
/** The upload's own name as the provenance keeps it; a file's name has no cap of its own. */
export const MAX_IMPORT_FILE_NAME_LENGTH = 255;
/** An uploaded asset's reference name (`name`), the one a pasted `{{img::name}}` is written in. */
export const MAX_ASSET_NAME_LENGTH = 100;
/** A module's name as the studio lists it — a label, as a member's roster name is. */
export const MAX_MODULE_NAME_LENGTH = 100;

/**
 * What an import that would show someone else's characters to readers is
 * refused with until the owner vouches for them: a publish with imported
 * members, and an import into a plot that is already public.
 */
export const rightsUnconfirmed = (): ApiError =>
  new ApiError(
    409,
    'rights_unconfirmed',
    'Imported characters are published only once the owner confirms the rights to them (rightsConfirmed)',
  );

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

/**
 * How a work of several members picks a round's speakers, on the coercion's
 * terms (`coerceGroupSettings`): an unknown order is the default and a cap out of
 * range is clamped, as a style's unknown option is dropped. Settings that say
 * what the default says are stored as nothing.
 */
function optionalGroupSettings(body: Record<string, unknown>): GroupSettings | null | undefined {
  const value = body['groupSettings'];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_request', 'groupSettings must be an object or null');
  }
  const settings = coerceGroupSettings(value);
  return settings.order === DEFAULT_GROUP_SETTINGS.order && settings.maxSpeakers === DEFAULT_GROUP_SETTINGS.maxSpeakers
    ? null
    : settings;
}

/**
 * A member's 대화량 (talkativeness): an integer 0..100, or null for the default.
 * A number is the creator's setting as the studio sends it, so one that is not
 * such an integer is a client to refuse rather than a value to guess at.
 */
function optionalTalkativeness(body: Record<string, unknown>): number | null | undefined {
  const value = body['talkativeness'];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw badRequest('invalid_request', 'talkativeness must be an integer from 0 to 100, or null');
  }
  return value;
}

/** A member's RisuAI emotion screen as the studio sets it: shown in a panel, inline, or (null) not at all. */
function optionalEmotionMode(body: Record<string, unknown>): EmotionMode | null | undefined {
  const value = body['emotionMode'];
  if (value === undefined || value === null) return value;
  if (value !== 'panel' && value !== 'inlay') {
    throw badRequest('invalid_request', "emotionMode must be 'panel', 'inlay' or null");
  }
  return value;
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

/**
 * A plot may only be published once it has enough substance to be worth finding:
 * a name, and something for the model to play — its own setting, or a member's
 * description. An imported card keeps its character there and seldom has a
 * scenario to lend the plot, and RisuAI lets a card open on the reader's first
 * message, so neither a setting nor an opening is asked for on its own.
 */
function requirePublishable(plot: Plot, members: Character[]): void {
  const missing = [
    ...(plot.name.trim() ? [] : ['name']),
    ...(plot.description.trim() || members.some((member) => member.card.description.trim())
      ? []
      : ['description']),
  ];
  if (missing.length > 0) {
    throw badRequest('not_publishable', `Cannot publish: ${missing.join(', ')} must not be empty`);
  }
}

/** The whole plot as its owner edits it. Nothing here is public but by choice. */
/** A module as the studio lists it: what it is and what it brought, not its scripts. */
const toModuleJson = (module: PlotModule) => ({
  id: module.id,
  name: module.name,
  description: module.description,
  loreCount: module.lorebook.length,
  regexCount: module.regex.length,
  triggerCount: module.trigger.length,
  displayScriptCount: module.displayScripts?.length ?? 0,
  assetCount: module.assets.length,
  background: Boolean(module.css || module.backgroundHtml),
  lowLevelAccess: module.lowLevelAccess === true,
  /** RisuAI's `hideIcon`: the work's chats show no sender picture or name. */
  hideIcon: module.hideIcon === true,
  /** What it would connect to or run that is never done here (`PlotModule.inert`). */
  ...(module.inert ? { inert: module.inert } : {}),
  /** Whether it brings anything the reader's browser runs — what a publish tells the owner readers receive. */
  scripts: cardScripts({ extensions: {} }, [module]) !== null,
  importedFrom: module.importedFrom,
});

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
  // The editors' part: the modules, which the server keeps apart, are listed below.
  customUi: customUiWithoutModules(plot.customUi),
  /** The RisuAI modules brought into the work, as the studio lists them. */
  modules: (plot.customUi?.modules ?? []).map(toModuleJson),
  /** How a work of several members picks a round's speakers, the default filled in. */
  groupSettings: coerceGroupSettings(plot.groupSettings),
  language: plot.language,
  visibility: plot.visibility,
  safetyLevel: plot.safetyLevel,
  commentsEnabled: plot.commentsEnabled,
  tags: plot.tags,
  likeCount: plot.likeCount,
  chatCount: plot.chatCount,
  publishedAt: plot.publishedAt?.toISOString() ?? null,
  // The last time the owner vouched for the imported members; null until then.
  rightsConfirmedAt: plot.rightsConfirmedAt?.toISOString() ?? null,
  createdAt: plot.createdAt.toISOString(),
  updatedAt: plot.updatedAt.toISOString(),
});

/**
 * The macros a book is expanded with the way a chat's first prompt expands it:
 * the plot's default variables, the default user name, and `{{char}}` as
 * whoever the book belongs to — the plot's name, or the member's.
 */
const firstPromptMacro = (plot: Plot, char: string): MacroContext => ({
  char,
  user: DEFAULT_USER_NAME,
  variables: computeVariables([], plot.customUi?.defaultVariables),
});

/**
 * What a plot draws behind its chats: the work's own background
 * (`PlotCustomUi.backgroundHtml`) — one for the whole work, as a RisuAI group
 * has — or, on a plot from before the field, `cardBackgroundOf` its roster.
 * Presentation, like the stylesheet, so it travels with the public view; ''
 * when nothing is left to draw.
 */
const backgroundOf = (plot: Plot, members: Character[]): string =>
  plot.customUi?.backgroundHtml ?? cardBackgroundOf(members);

/**
 * The HTML a RisuAI card draws behind the chat (`backgroundHTML`), where a plot
 * has no background of its own: the card whose scripts run — the character the
 * chat is with, whose `getBackgroundEmbedding` it is — or, in a plot without
 * scripts, the first that carries one. Its `<style>` elements are left out: they
 * are the plot's stylesheet already (`customUi.css`, lifted at import), which the
 * creator may have edited since.
 */
function cardBackgroundOf(members: Character[]): string {
  const lead =
    scriptedMember(members)?.member ?? members.find((member) => backgroundHtmlOf(member.card.extensions) !== undefined);
  const html = lead ? backgroundHtmlOf(lead.card.extensions) : undefined;
  const shown = html ? backgroundWithoutStyles(html) : '';
  return shown.length <= MAX_BACKGROUND_HTML_LENGTH ? shown : '';
}

/**
 * The `backgroundHTML` a member's charx export carries, put back together the
 * way RisuAI keeps it: the work's stylesheet and the member's own (`memberCss`)
 * as `<style>` elements ahead of what the work draws behind its chats
 * (`backgroundOf`) — the split the import made (`splitBackground`), undone,
 * with whatever the creator has edited since. '' when the work has none of them.
 */
function exportedBackground(plot: Plot, members: Character[], memberId: string): string {
  const ui = plot.customUi ?? {};
  const sheets = [ui.css, ui.memberCss?.[memberId]].filter((css): css is string => Boolean(css?.trim()));
  // A `</style` in a sheet would end its element early; in CSS it is junk either way.
  const styles = sheets.map((css) => `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`);
  return [...styles, backgroundOf(plot, members)].filter((part) => part.trim()).join('\n');
}

/**
 * A member as its own creator sees it: the whole card, since they wrote it — or
 * imported it, in which case where it came from and the license its card
 * declares travel too, being what the owner weighs before publishing it. Both
 * are the owner's alone: no public shape carries them. So is what the card's
 * always-on lore costs once expanded (`constantLoreTokens`), which the studio
 * sets against the lore budget.
 */
export const toMemberJson = (plot: Plot, member: Character) => ({
  id: member.id,
  name: member.name,
  // The same field every public member carries, so a screen reads one shape.
  nickname: member.card.nickname?.trim() || null,
  card: member.card,
  avatarUrl: avatarUrl(member),
  orderIndex: member.orderIndex,
  /** 대화량, 0..100, the default (50) filled in. */
  talkativeness: coerceTalkativeness(member.talkativeness),
  importedFrom: member.importedFrom,
  license: cardLicense(member.card.extensions) ?? null,
  loreConstantTokens: constantLoreTokens(member.card.lorebook, firstPromptMacro(plot, characterName(member))),
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
  // The source's own name for the image — an imported card's, or the one an
  // upload sent — which its references are written in.
  name: asset.name,
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

/** Loads a member of a plot the caller owns, with the plot; anything else is simply not found. */
async function loadOwnedMember(
  deps: AppDeps,
  plotId: string,
  characterId: string,
  userId: string,
): Promise<{ plot: Plot; member: Character }> {
  const plot = await loadOwnedPlot(deps, plotId, userId);
  const [member] = await deps.db
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.plotId, plotId)))
    .limit(1);
  if (!member) throw notFound('Character not found');
  return { plot, member };
}

/** What a card upload says about itself beside the card. */
export interface CardImport {
  importedFrom: ImportProvenance;
  /** The owner's word that they may publish the card, for a plot that is already public. */
  rightsConfirmed: boolean;
}

/**
 * Inserts a member under the roster cap. The cap is a count, and a count only
 * means something while nothing else can insert: the plot row is locked for the
 * whole check-then-write, so two creates racing at nine cannot both see room.
 *
 * An imported member joining a plot that is already public is published by the
 * insert itself, so it needs the owner's word exactly as a publish does. The
 * visibility is read under the same lock a publish takes, so an import and a
 * publish cannot pass each other with neither one asking.
 */
async function insertMember(
  deps: AppDeps,
  plotId: string,
  name: string,
  card: NormalizedCard,
  imported?: CardImport,
  /** The member's id, where the caller has already written it somewhere (`customUiOfCard`). */
  id?: string,
): Promise<Character> {
  return deps.db.transaction(async (tx) => {
    const [plot] = await tx
      .select({ visibility: plots.visibility })
      .from(plots)
      .where(eq(plots.id, plotId))
      .for('update');
    const vouching = imported !== undefined && plot?.visibility === 'public';
    if (vouching && !imported.rightsConfirmed) throw rightsUnconfirmed();
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
      .values({
        ...(id ? { id } : {}),
        plotId,
        name,
        card,
        orderIndex: counted?.next ?? 0,
        ...(imported ? { importedFrom: imported.importedFrom } : {}),
      })
      .returning();
    if (vouching) {
      await tx.update(plots).set({ rightsConfirmedAt: new Date() }).where(eq(plots.id, plotId));
    }
    return created!;
  });
}

/**
 * Stores the pictures, music, video and web fonts a card carried beside the
 * icon — a font for a stylesheet to reach as `{{raw::name}}`, as RisuAI's charx
 * export carries one, and as this app's own does for the fonts it localized.
 * Slugs come from the asset names so `{{img::slug}}` written into the card keeps
 * working; a name with nothing sluggable left falls back to its position, and
 * collisions get a suffix. Bytes that turn out to be none of these are skipped
 * rather than failing the import, and counted (`unsupported`), as are those past the plot's cap
 * (`overLimit`), for the import to say so (`ImportWarning`).
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
 *
 * Each asset is streamed from the file into the store, one at a time and never
 * held (`readCardAssets`, `saveAssetStream`), under the parse's caps: the first
 * past one ends the pass, and it and the rest are counted (`overBudget`). `spent`
 * is what the parse already read of the budget (a charx's icon). The import
 * hears each key before it is written (`ImportHooks.wrote`).
 */
async function storeImportedAssets(
  deps: AppDeps,
  plotId: string,
  assets: readonly CardAsset[],
  { spent, hooks }: { spent?: number; hooks: ImportHooks },
): Promise<{ emotions: EmotionImage[]; ids: string[]; unsupported: number; overLimit: number; overBudget: number }> {
  /** An image already in the store, still waiting for a row to name it. */
  interface StoredCandidate {
    id: string;
    /** The archive's own name and position, which is what a slug is derived from. */
    name: string;
    index: number;
    key: string;
    mime: string;
  }
  /** The card's emotion pictures among the rows written, by the slug each got. */
  let emotions: EmotionImage[] = [];

  // Never more candidates than an empty plot could hold: a larger archive must
  // not pay to store what could not fit under any reading of the cap.
  const candidates: StoredCandidate[] = [];
  // Every object in the store, until the transaction says which of them it kept.
  // Keys go in as each put lands, so a throw anywhere — the nth put included —
  // takes every already-stored object with it.
  let orphaned: string[] = [];
  /** The ids of the rows written, for a caller that keeps them (a module). */
  const written: string[] = [];
  let unsupported = 0;
  let overLimit = 0;
  let overBudget = 0;
  try {
    hooks.progress('assets', 0, assets.length);
    ({ overBudget } = await readCardAssets(
      assets,
      async (asset, body, index) => {
        if (candidates.length >= MAX_ASSETS_PER_PLOT) {
          overLimit = assets.length - index;
          return false;
        }
        const id = randomUUID();
        const stored = await saveAssetStream(deps.storage, id, body, {
          audio: true,
          video: true,
          font: true,
          onKey: async (key) => {
            orphaned.push(key);
            await hooks.wrote({ keys: [key] });
          },
        });
        hooks.progress('assets', index + 1, assets.length);
        if (!stored) {
          unsupported += 1;
          return true;
        }
        candidates.push({ id, name: asset.name, index, key: stored.key, mime: stored.mime });
        return true;
      },
      spent === undefined ? {} : { spent },
    ));
    if (candidates.length === 0) return { emotions, ids: written, unsupported, overLimit, overBudget };

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
        return {
          id: candidate.id,
          plotId,
          slug,
          name: candidate.name,
          path: candidate.key,
          mime: candidate.mime,
        };
      });
      if (rows.length > 0) await tx.insert(plotAssets).values(rows);
      emotions = fitting.flatMap((candidate, at) =>
        assets[candidate.index]!.emotion ? [{ name: candidate.name, slug: rows[at]!.slug }] : [],
      );
      written.push(...rows.map((row) => row.id!));
      overLimit += candidates.length - rows.length;
      return candidates.slice(rows.length).map((candidate) => candidate.key);
    });
  } finally {
    // Outside the transaction, as everywhere: an object is garbage exactly when
    // no row will ever name it.
    for (const key of orphaned) await deleteQuietly(deps.storage, key);
  }
  return { emotions, ids: written, unsupported, overLimit, overBudget };
}

/**
 * Why an import left something of the card behind or cut it, and how much: what
 * the import's answer lists (`importWarnings`) and the studio says quietly. Every
 * one is a cap or a file the card itself got wrong — the import goes ahead.
 *
 * - `assets_unsupported` files that are none of a picture, music, a video a browser plays
 *   or a web font (AVI, Matroska, a voice model)
 * - `assets_missing` files the card declares and does not hold
 * - `assets_over_budget` files past the parse budget (`MAX_TOTAL_BYTES`, `MAX_ASSETS`)
 * - `assets_over_limit` files past the plot's `MAX_ASSETS_PER_PLOT`
 * - `greetings_over_limit` openings past `MAX_INTROS_PER_PLOT`
 * - `greetings_cut` openings cut to `MAX_INTRO_TEXT_LENGTH`
 * - `stylesheet_over_limit` a stylesheet over `MAX_CREATOR_CSS_LENGTH`, left out whole
 * - `background_over_limit` a background over `MAX_BACKGROUND_HTML_LENGTH`, left out whole
 * - `external_failed` addresses on other hosts the import could not bring in
 *   (`localizeAssets.ts`): left as written, so the chat does not draw them
 * - `external_over_limit` the same, left because the import's fetch caps ran out
 * - `module_mcp_inert` / `module_cjs_inert` a module's MCP server or `cjs` code,
 *   kept and never connected to or run (`PlotModule.inert`)
 */
type ImportWarningCode =
  | 'assets_unsupported'
  | 'assets_missing'
  | 'assets_over_budget'
  | 'assets_over_limit'
  | 'greetings_over_limit'
  | 'greetings_cut'
  | 'stylesheet_over_limit'
  | 'background_over_limit'
  | 'external_failed'
  | 'external_over_limit'
  | 'module_mcp_inert'
  | 'module_cjs_inert';

interface ImportWarning {
  code: ImportWarningCode;
  count: number;
}

/** The counts as the answer lists them: in the order above, the zeros left out. */
function importWarnings(counts: Partial<Record<ImportWarningCode, number>>): ImportWarning[] {
  const order: ImportWarningCode[] = [
    'assets_unsupported',
    'assets_missing',
    'assets_over_budget',
    'assets_over_limit',
    'greetings_over_limit',
    'greetings_cut',
    'stylesheet_over_limit',
    'background_over_limit',
    'external_failed',
    'external_over_limit',
    'module_mcp_inert',
    'module_cjs_inert',
  ];
  return order.flatMap((code) => ((counts[code] ?? 0) > 0 ? [{ code, count: counts[code]! }] : []));
}

/**
 * Brings in what the texts of `scope` load from other hosts (`localizePlot`),
 * and the warnings half of what it left. Never fails the import: a fetch that
 * throws past its own handling leaves everything as written, counted as failed.
 */
async function localizeImport(
  deps: AppDeps,
  plotId: string,
  scope: LocalizeScope,
): Promise<{ warnings: Partial<Record<ImportWarningCode, number>>; moduleAssets: Map<string, string[]> }> {
  const remoteFetch =
    deps.remoteFetch ?? createRemoteFetch({ ownOrigins: deps.webOrigin ? [deps.webOrigin] : [] });
  try {
    const outcome = await localizePlot({ db: deps.db, storage: deps.storage, remoteFetch }, plotId, scope);
    return {
      warnings: { external_failed: outcome.failed, external_over_limit: outcome.overLimit },
      moduleAssets: outcome.moduleAssets,
    };
  } catch (error) {
    console.warn(`[api] localizing plot ${plotId}'s external assets failed:`, error);
    return { warnings: { external_failed: 1 }, moduleAssets: new Map() };
  }
}

/** The asset half of the counts: what the parse passed over, and what the store did. */
const assetWarnings = (
  skipped: SkippedAssets | undefined,
  stored: { unsupported: number; overLimit: number; overBudget: number } | undefined,
): Partial<Record<ImportWarningCode, number>> => ({
  assets_unsupported: (skipped?.unsupported ?? 0) + (stored?.unsupported ?? 0),
  assets_missing: skipped?.missing ?? 0,
  assets_over_budget: (skipped?.overBudget ?? 0) + (stored?.overBudget ?? 0),
  assets_over_limit: stored?.overLimit ?? 0,
});

/**
 * Greetings made the plot's openings: the non-empty ones, as many as there is
 * room for, each cut to the opening length — and how many of them did not fit
 * or were cut.
 */
function introsOfGreetings(
  greetings: readonly string[],
  room: number,
): { intros: string[]; overLimit: number; cut: number } {
  const given = greetings.filter((greeting) => greeting.trim().length > 0);
  const kept = given.slice(0, Math.max(0, room));
  return {
    intros: kept.map((greeting) => greeting.slice(0, MAX_INTRO_TEXT_LENGTH)),
    overLimit: given.length - kept.length,
    cut: kept.filter((greeting) => greeting.length > MAX_INTRO_TEXT_LENGTH).length,
  };
}

/**
 * The card's emotion pictures, written onto the member the import made once
 * the images are stored (`NormalizedCard.emotionImages`): the card names them,
 * and only now is it known which of the plot's slugs each became — a second
 * member's `neutral` is another slug than the first's.
 */
async function recordEmotionImages(deps: AppDeps, member: Character, emotionImages: EmotionImage[]): Promise<Character> {
  if (emotionImages.length === 0) return member;
  const [updated] = await deps.db
    .update(characters)
    .set({ card: { ...member.card, emotionImages } })
    .where(eq(characters.id, member.id))
    .returning();
  return updated ?? member;
}

/**
 * Deletes a plot's assets by row id, their stored files with them — what a
 * removed module brought, as far as the creator has not removed it already.
 * By id rather than slug: a slug the creator freed and reused is not the module's.
 */
async function deleteAssets(deps: AppDeps, plotId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const deleted = await deps.db
    .delete(plotAssets)
    .where(and(eq(plotAssets.plotId, plotId), inArray(plotAssets.id, [...ids])))
    .returning({ path: plotAssets.path });
  for (const { path } of deleted) await deleteQuietly(deps.storage, path);
}

/**
 * What a card joining a plot's roster brings to the work (`liftCompanion`): its
 * display scripts and stylesheet as its own, its default variables into the
 * work's namespace. The work keeps one background, as a RisuAI group draws its
 * own and no member's: a plot that has none of its own yet takes the one it drew
 * until now — its scripted card's — so the new card's never shows; the first
 * card of an empty plot brings its own, as a card that makes a plot does. Under
 * the plot's row lock, so an edit racing it is not undone. Answers with the
 * variable names the work kept another value for.
 */
async function liftCustomUi(deps: AppDeps, plotId: string, member: Character): Promise<string[]> {
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx.select({ customUi: plots.customUi }).from(plots).where(eq(plots.id, plotId)).for('update');
    const before = locked?.customUi ?? {};
    const others = (await loadMembers(tx, plotId)).filter((other) => other.id !== member.id);
    const background = cardBackgroundOf(others.length > 0 ? others : [member]);
    const pinned: PlotCustomUi =
      before.backgroundHtml !== undefined || (others.length === 0 && !background)
        ? before
        : { ...before, backgroundHtml: background };
    const { customUi, conflicts } = liftCompanion(pinned, member.card, member.id);
    const stored = Object.keys(customUi).length > 0 ? customUi : null;
    if (JSON.stringify(stored) !== JSON.stringify(locked?.customUi ?? null)) {
      await tx.update(plots).set({ customUi: stored, updatedAt: new Date() }).where(eq(plots.id, plotId));
    }
    return conflicts;
  });
}

/**
 * A card's group-only greetings, made openings of a plot it joins as one more
 * of a cast. The V3 spec keeps them for group chats, and every chat of a plot
 * with more than one member is one; a card that starts a plot on its own keeps
 * them on the card alone. (In RisuAI's characterCards.ts only the import and
 * the export touch them.)
 *
 * They go after the plot's own openings, under the caps the card import holds
 * its greetings to: as many as there is room for, each cut to the opening
 * length. The cap loses nothing — the greetings stay on the member's card and
 * go out with its export (where the openings made of them are not written a
 * second time, `CardPlotOverlay.intros`); it only bounds which become the root
 * of a chat. The roster and the openings are read under the plot's row lock,
 * so an edit to the openings racing this one is not undone by a stale list.
 */
async function addGroupGreetings(
  deps: AppDeps,
  plotId: string,
  card: NormalizedCard,
): Promise<{ overLimit: number; cut: number }> {
  const none = { overLimit: 0, cut: 0 };
  const greetings = (card.groupOnlyGreetings ?? []).filter((greeting) => greeting.trim().length > 0);
  if (greetings.length === 0) return none;
  return deps.db.transaction(async (tx) => {
    const [plot] = await tx
      .select({ intros: plots.intros })
      .from(plots)
      .where(eq(plots.id, plotId))
      .for('update');
    const [counted] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(characters)
      .where(eq(characters.plotId, plotId));
    if (!plot || (counted?.value ?? 0) < 2) return none;
    const { intros: added, overLimit, cut } = introsOfGreetings(greetings, MAX_INTROS_PER_PLOT - plot.intros.length);
    if (added.length > 0) {
      await tx
        .update(plots)
        .set({ intros: [...plot.intros, ...added], updatedAt: new Date() })
        .where(eq(plots.id, plotId));
    }
    return { overLimit, cut };
  });
}

/**
 * The page an import names as its source. Only a RisuRealm card page is
 * recorded, and always in one spelling; anything else is refused rather than
 * dropped, because a client that sent it expects it to have been kept.
 */
export function coerceSourceUrl(value: unknown): string | undefined {
  if (value === null || (typeof value === 'string' && !value.trim())) return undefined;
  const id = typeof value === 'string' ? realmCardId(value) : null;
  if (!id) throw badRequest('invalid_request', 'sourceUrl must be a RisuRealm character page');
  return realmCharacterUrl(id);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The page a paste migration names as its source, in the one spelling its
 * platform's rule stores (`@shizue/core/source-url`). Refused rather than
 * dropped, as a card import's is; blank is no source at all.
 */
function coerceMigrationSourceUrl(platform: MigrationPlatform, value: unknown): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined;
  const url = typeof value === 'string' ? sourceUrlFor(platform, value) : null;
  if (!url) throw badRequest('invalid_request', `sourceUrl must be a ${platform} character page`);
  return url;
}

/**
 * The roster a migration draft brings, each member made the way the studio's
 * member create makes one (`coerceCard`) from the only fields a paste fills —
 * nothing else on a card is the draft's to set.
 */
function coerceMigrationMembers(value: unknown): { name: string; card: NormalizedCard }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('invalid_request', 'draft.members must be a non-empty array');
  }
  if (value.length > MAX_CHARACTERS_PER_PLOT) {
    throw badRequest('character_limit', `A plot holds at most ${MAX_CHARACTERS_PER_PLOT} characters`);
  }
  return value.map((member) => {
    if (!isObject(member)) throw badRequest('invalid_request', 'draft.members must be objects');
    const name = requireString(member, 'name').trim();
    if (!name) throw badRequest('invalid_request', 'name must not be empty');
    const { intro, description, personality, mesExample } = member;
    return { name, card: coerceCard({ name, intro, description, personality, mesExample }, name) };
  });
}

/**
 * The lorebook a SillyTavern World Info file beside the card carries (the
 * import's `worldInfo`). ST writes a character's linked world back into the card
 * only when the character is saved, so the file is the fresher copy and its
 * entries stand in for the card's own. Unreadable is a 400, like an unreadable
 * card — answered when the import starts, before the card is uploaded.
 */
export function readWorldInfo(text: string): LoreEntry[] {
  let entries: LoreEntry[];
  try {
    entries = fromLorebookFile(JSON.parse(text));
  } catch (error) {
    throw badRequest(
      'invalid_lorebook',
      error instanceof LorebookFileError ? error.message : 'Unreadable World Info file',
    );
  }
  // A file the client chose, normalized on the way in like any other lorebook it sends.
  return coerceLorebook(entries);
}

/** A card file read for an import (`fileImports.ts`): the card, and the record of the file. */
export interface CardUpload {
  parsed: ParsedCardSource;
  /** The file's name as the reader's browser gave it. */
  fileName: string;
  imported: CardImport;
}

/** A module file read for an import: the module, and what the record of the file needs. */
export interface ModuleUpload {
  parsed: ParsedRisuModule;
  fileName: string;
  /** Of the bytes as uploaded. */
  sha256: string;
  rightsConfirmed: boolean;
}

/** The provenance a card import records: the file's name and hash, and the page the importer says it came from. */
export const importProvenance = (fileName: string, sha256: string, sourceUrl?: string): ImportProvenance => ({
  fileName: fileName.slice(0, MAX_IMPORT_FILE_NAME_LENGTH),
  // The part of the record the server can vouch for: the URL is the importer's
  // word, the hash is of what actually arrived.
  sha256,
  ...(sourceUrl ? { sourceUrl } : {}),
  importedAt: new Date().toISOString(),
});

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

/** A storage key's extension — the image type it was sniffed as when it was stored (`assetKey` and the like). */
const extensionOf = (key: string): string => key.slice(key.lastIndexOf('.') + 1);

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
 * Importing a card creates the work it was always describing: the card becomes
 * the first member and everything on it that belongs to a work rather than to a
 * person — the situation, the openings, the narrator, the custom UI, the
 * picture as the cover — is lifted onto the plot around it. Run by the import
 * job (`fileImports.ts`) once the file is read; a file that is not a card never
 * gets here (400 `invalid_card` there).
 */
export async function importCardAsPlot(
  deps: AppDeps,
  userId: string,
  { parsed, fileName, imported }: CardUpload,
  hooks: ImportHooks,
): Promise<FileImportResult> {
  const card = parsed.card;
  const name = card.name.trim() || fileName.replace(/\.[^.]+$/, '') || 'Unnamed';
  // The situation is the work's; the character's description stays on the
  // member, which the prompt already reads it from — copying it here as well
  // would tell the model the same thing twice.
  const description = card.scenario.trim();
  const greetings = introsOfGreetings([card.firstMes, ...card.alternateGreetings], MAX_INTROS_PER_PLOT);
  const intros = greetings.intros;
  // The member the card becomes: its display scripts are tagged as its own.
  const memberId = randomUUID();
  const customUi = customUiOfCard(card, memberId);
  // What the reader meets first says what the work is written in; a card with
  // no opening to read is judged by its description, and an undecided one
  // keeps the column's default.
  const language =
    detectContentLanguage(intros[0] ?? '') ?? detectContentLanguage(card.description);

  // Recorded before it exists, so a failure from here on takes the whole plot back.
  const plotId = randomUUID();
  await hooks.wrote({ plotId });
  const [created] = await deps.db
    .insert(plots)
    .values({
      id: plotId,
      ownerId: userId,
      name,
      // Only the plot borrows the creator notes: the member keeps its card's own
      // intro, or the public page would say the same thing twice.
      intro: card.intro ?? introFromCreatorNotes(card.creatorNotes, language) ?? '',
      description,
      intros,
      tags: normalizeTags(card.tags),
      ...(card.narrator ? { narrator: card.narrator } : {}),
      ...(Object.keys(customUi).length > 0 ? { customUi } : {}),
      ...(language ? { language } : {}),
    })
    .returning();
  let plot = created!;

  // A new plot is private, so this records where the card came from and asks
  // for nothing yet: the owner vouches for it when they publish.
  let member = await insertMember(deps, plot.id, name, card, imported, memberId);
  if (parsed.iconBuffer) {
    member = await writeMemberAvatar(deps, member, parsed.iconBuffer);
    plot = await writeImportedCover(deps, plot, parsed.iconBuffer);
  }
  const stored = parsed.assets.length
    ? await storeImportedAssets(deps, plot.id, parsed.assets, { spent: parsed.spent, hooks })
    : undefined;
  if (stored) await recordEmotionImages(deps, member, stored.emotions);
  const background = backgroundHtmlOf(card.extensions);
  // After the card's own pictures, so they keep their slugs and the plot's room
  // goes to them first: what the card loads from other hosts, brought in.
  hooks.progress('localizing');
  const localized = await localizeImport(deps, plot.id, { plot: true, modules: [] });

  // What was left behind or cut, for the studio to say quietly.
  const warnings = importWarnings({
    ...assetWarnings(parsed.skipped, stored),
    greetings_over_limit: greetings.overLimit,
    greetings_cut: greetings.cut,
    stylesheet_over_limit: creatorCssOverCap(card.extensions) ? 1 : 0,
    background_over_limit:
      background !== undefined && backgroundWithoutStyles(background).length > MAX_BACKGROUND_HTML_LENGTH ? 1 : 0,
    ...localized.warnings,
  });
  scheduleLoreUpdate(deps, plot.id, userId);
  return { plotId: plot.id, importWarnings: warnings };
}

/**
 * A card as one more member of a plot the reader owns. The work's narrator and
 * openings stay its own. What the card dresses its own messages in comes along
 * as its own (`liftCustomUi`), and so do its images, as the plot's, because
 * `{{img::slug}}` resolves there, and its group-only greetings once there is a
 * cast for them to greet (`addGroupGreetings`). Into a public plot it needs
 * `rightsConfirmed` (`insertMember`).
 */
export async function importCardAsMember(
  deps: AppDeps,
  userId: string,
  plotId: string,
  { parsed, fileName, imported }: CardUpload,
  hooks: ImportHooks,
): Promise<FileImportResult> {
  const plot = await loadOwnedPlot(deps, plotId, userId);
  const name = parsed.card.name.trim() || fileName.replace(/\.[^.]+$/, '') || 'Unnamed';

  const memberId = randomUUID();
  await hooks.wrote({ characterId: memberId });
  let member = await insertMember(deps, plotId, name, parsed.card, imported, memberId);
  if (parsed.iconBuffer) member = await writeMemberAvatar(deps, member, parsed.iconBuffer);
  const stored = parsed.assets.length
    ? await storeImportedAssets(deps, plotId, parsed.assets, { spent: parsed.spent, hooks })
    : undefined;
  if (stored) member = await recordEmotionImages(deps, member, stored.emotions);
  const greetings = await addGroupGreetings(deps, plotId, parsed.card);
  const variableConflicts = await liftCustomUi(deps, plotId, member);
  // What the companion's lifted scripts, sheet and greetings load from other hosts —
  // only those: the rest of the work is the studio's, brought in at its own import.
  hooks.progress('localizing');
  const localized = await localizeImport(deps, plotId, {
    plot: true,
    modules: [],
    member: { id: member.id, introsFrom: plot.intros.length },
  });
  // The work keeps one background, so a companion's is never drawn and never missed.
  const warnings = importWarnings({
    ...assetWarnings(parsed.skipped, stored),
    greetings_over_limit: greetings.overLimit,
    greetings_cut: greetings.cut,
    stylesheet_over_limit: creatorCssOverCap(parsed.card.extensions) ? 1 : 0,
    ...localized.warnings,
  });
  scheduleLoreUpdate(deps, plotId, userId);
  // The default variables the work already had another value for, and what the
  // import left behind, for the studio to say so.
  return { plotId, characterId: member.id, variableConflicts, importWarnings: warnings };
}

/**
 * A RisuAI module brought into the work — any file RisuAI's module import
 * takes: a charx (its `.module.charx` export, or a character's), a `.risum`,
 * the module's JSON, a lorebook or a regex export (`readRisuModuleSource`) —
 * the creator's side of RisuAI's module list. RisuAI stacks a module on the
 * chat rather than into the character, so this one is the work's: kept whole
 * under an id of its own (`PlotModule`), every member's, and run after the
 * cards' own wherever theirs run (§6 of ARCHITECTURE.md). Its pictures join the
 * work's assets under the plot's cap, as a card's do (`storeImportedAssets`);
 * its stylesheet and background, past the plot's caps, are left out as a card's
 * are. A module carries no default variables, so there is nothing to merge into
 * the work's. Unreadable is a 400 `invalid_module`, answered by the job.
 */
export async function importPlotModule(
  deps: AppDeps,
  userId: string,
  plotId: string,
  { parsed, fileName, sha256, rightsConfirmed }: ModuleUpload,
  hooks: ImportHooks,
): Promise<FileImportResult> {
  const owned = await loadOwnedPlot(deps, plotId, userId);
  // Someone else's work shown to readers the moment it lands, as an imported
  // member is: a public plot takes it only on the owner's word. Asked before
  // anything is stored, and again under the lock the write takes.
  if (owned.visibility === 'public' && !rightsConfirmed) throw rightsUnconfirmed();

  // A module names no emotion pictures: its assets are only `additionalAssets`.
  const stored = await storeImportedAssets(deps, plotId, parsed.assets, { hooks });
  const assets = stored.ids;
  const module = plotModuleOf(parsed, {
    id: randomUUID(),
    name: (parsed.name || fileName.replace(/\.[^.]+$/, '').trim() || 'Module').slice(0, MAX_MODULE_NAME_LENGTH),
    description: parsed.description.trim().slice(0, MAX_INTRO_LENGTH),
    // Held to what any lorebook the work stores is held to.
    lorebook: coerceLorebook(parsed.lorebook),
    assets,
    importedFrom: {
      fileName: fileName.slice(0, MAX_IMPORT_FILE_NAME_LENGTH),
      sha256,
      importedAt: new Date().toISOString(),
    },
  });
  await hooks.wrote({ moduleId: module.id });
  try {
    await deps.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ customUi: plots.customUi, visibility: plots.visibility })
        .from(plots)
        .where(eq(plots.id, plotId))
        .for('update');
      // The same lock a publish takes, so the two cannot pass each other unasked.
      const vouching = locked?.visibility === 'public';
      if (vouching && !rightsConfirmed) throw rightsUnconfirmed();
      const customUi = locked?.customUi ?? {};
      await tx
        .update(plots)
        .set({
          customUi: { ...customUi, modules: [...(customUi.modules ?? []), module] },
          updatedAt: new Date(),
          ...(vouching ? { rightsConfirmedAt: new Date() } : {}),
        })
        .where(eq(plots.id, plotId));
    });
  } catch (error) {
    // The pictures were stored ahead of the record that names them.
    await deleteAssets(deps, plotId, assets);
    throw error;
  }
  // What the module's stylesheet, background and scripts load from other hosts —
  // stored as its own, so taking the module out takes them too.
  hooks.progress('localizing');
  const localized = await localizeImport(deps, plotId, { plot: false, modules: [module.id] });
  const warnings = importWarnings({
    ...assetWarnings(undefined, stored),
    ...localized.warnings,
    ...(module.inert?.mcp !== undefined ? { module_mcp_inert: 1 } : {}),
    ...(module.inert?.cjs ? { module_cjs_inert: 1 } : {}),
  });
  scheduleLoreUpdate(deps, plotId, userId);
  return { plotId, importWarnings: warnings };
}

/**
 * Takes back what an import wrote before it failed (`FileImportWritten`): a
 * plot it made, whole; a member it added, with the pictures it stored; a module
 * it added to a work. The objects it stored (`keys`) go too, named or not. What a member
 * import lifted onto the work (`liftCustomUi`, the group greetings) stays, as it
 * did when the import was one request.
 */
export async function undoImportWrites(
  deps: AppDeps,
  written: { plotId?: string; characterId?: string; moduleId?: string },
  keys: readonly string[],
  target: 'plot' | 'member' | 'plot_module',
  plotId: string | null,
): Promise<void> {
  const paths = new Set(keys);
  if (target === 'plot' && written.plotId) {
    await deletePlotWithObjects(deps, written.plotId);
  } else if (plotId && paths.size > 0) {
    const rows = await deps.db
      .delete(plotAssets)
      .where(and(eq(plotAssets.plotId, plotId), inArray(plotAssets.path, [...paths])))
      .returning({ path: plotAssets.path });
    for (const row of rows) paths.add(row.path);
  }
  if (target === 'member' && written.characterId) {
    const [gone] = await deps.db.delete(characters).where(eq(characters.id, written.characterId)).returning();
    if (gone?.avatarPath) paths.add(gone.avatarPath);
    // Written under a key of its id, maybe without the row naming it yet.
    for (const ext of AVATAR_EXTENSIONS) paths.add(avatarKey(written.characterId, ext));
  }
  if (target === 'plot_module' && written.moduleId && plotId) {
    await deps.db.transaction(async (tx) => {
      const [locked] = await tx.select({ customUi: plots.customUi }).from(plots).where(eq(plots.id, plotId)).for('update');
      const modules = locked?.customUi?.modules ?? [];
      if (!locked?.customUi || !modules.some((module) => module.id === written.moduleId)) return;
      const kept = modules.filter((module) => module.id !== written.moduleId);
      const { modules: _modules, ...rest } = locked.customUi;
      const customUi: PlotCustomUi = kept.length > 0 ? { ...rest, modules: kept } : rest;
      await tx
        .update(plots)
        .set({ customUi: Object.keys(customUi).length > 0 ? customUi : null, updatedAt: new Date() })
        .where(eq(plots.id, plotId));
    });
  }
  for (const path of paths) await deleteQuietly(deps.storage, path);
}

/** The picture types an avatar or a cover is stored as (`pictureType`): what a key of an id may end in. */
const AVATAR_EXTENSIONS = ['png', 'jpg', 'gif', 'webp', 'avif'];

/**
 * Deletes a plot and what it keeps in the store: its cover, its members'
 * avatars, its assets. The rows go with the plot (`on delete cascade`).
 */
async function deletePlotWithObjects(deps: AppDeps, plotId: string): Promise<void> {
  const [plot] = await deps.db.select().from(plots).where(eq(plots.id, plotId)).limit(1);
  const members = await loadMembers(deps.db, plotId);
  const assets = await deps.db.select({ path: plotAssets.path }).from(plotAssets).where(eq(plotAssets.plotId, plotId));
  await deps.db.delete(plots).where(eq(plots.id, plotId));
  const paths = new Set<string>(assets.map((asset) => asset.path));
  if (plot?.coverPath) paths.add(plot.coverPath);
  for (const member of members) if (member.avatarPath) paths.add(member.avatarPath);
  // An import that died between a write and the row naming it leaves a key of the id.
  for (const ext of AVATAR_EXTENSIONS) {
    paths.add(coverKey(plotId, ext));
    for (const member of members) paths.add(avatarKey(member.id, ext));
  }
  for (const path of paths) await deleteQuietly(deps.storage, path);
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

  app.post('/', requireUser, rateLimit(deps, RATE_LIMITS.plots), async (c) => {
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
    scheduleLoreUpdate(deps, created!.id, c.get('userId'));
    return c.json(toPlotJson(created!), 201);
  });

  /**
   * A creator's own character moved over from another platform by pasting its
   * fields (docs/KR-PASTE-MIGRATION-DESIGN.md). The browser maps the site's form
   * onto one `MigrationDraft`; this writes it as a new plot and its roster in one
   * transaction, so a draft refused half-way leaves nothing behind.
   *
   * The draft passes the coercers the create and the studio's member create use,
   * so a pasted plot holds nothing a written one could not. The creator's word
   * that the work is theirs and not held exclusively elsewhere comes first
   * (`migration_unconfirmed`). Every member is stamped `imported_from`, so the
   * publish asks for `rightsConfirmed` exactly as it does after a card import;
   * the plot is private whatever the source rated it. The images follow through
   * the ordinary avatar and asset uploads, against the ids the answer carries.
   */
  app.post('/migrate', requireUser, rateLimit(deps, RATE_LIMITS.plots), async (c) => {
    const body = await readJsonBody(c);
    const confirmations = body['confirmations'];
    if (!isObject(confirmations) || confirmations['ownWork'] !== true || confirmations['notExclusive'] !== true) {
      throw badRequest(
        'migration_unconfirmed',
        'confirmations.ownWork and confirmations.notExclusive must both be true',
      );
    }
    const platform = body['platform'] as MigrationPlatform;
    if (!MIGRATION_PLATFORMS_ENABLED.includes(platform)) {
      throw badRequest('invalid_request', `platform must be one of ${MIGRATION_PLATFORMS_ENABLED.join(', ')}`);
    }
    const draft = body['draft'];
    if (!isObject(draft) || draft['platform'] !== platform) {
      throw badRequest('invalid_request', 'draft must be an object for the same platform');
    }
    const sourceUrl = coerceMigrationSourceUrl(platform, body['sourceUrl']);
    const work = draft['plot'];
    if (!isObject(work)) throw badRequest('invalid_request', 'draft.plot must be an object');
    const name = requireString(work, 'name').trim();
    if (!name) throw badRequest('invalid_request', 'name must not be empty');
    const intros = coerceIntros(work);
    const tags = coerceTags(work);
    const narrator = optionalNarrator(work);
    const style = optionalStyle(work);
    const profiles = optionalProfiles(work);
    const customUi = optionalCustomUi(work);
    const values = {
      ownerId: c.get('userId'),
      name,
      intro: coerceIntro(work) ?? '',
      description: optionalString(work, 'description') ?? '',
      ...(work['lorebook'] === undefined ? {} : { lorebook: coerceLorebook(work['lorebook']) }),
      ...(intros !== undefined ? { intros } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(narrator ? { narrator } : {}),
      ...(style ? { style } : {}),
      ...(profiles ? { profiles } : {}),
      ...(customUi ? { customUi } : {}),
    };
    const members = coerceMigrationMembers(draft['members']);
    const importedFrom: ImportProvenance = {
      fileName: `${platform}-paste`,
      // Of the draft as it arrived, not as coerced: it is the hash the browser
      // computed before sending, and checked against `/api/imports/lookup`.
      sha256: createHash('sha256')
        .update(draftFingerprint(draft as unknown as MigrationDraft))
        .digest('hex'),
      ...(sourceUrl ? { sourceUrl } : {}),
      importedAt: new Date().toISOString(),
      platform,
      method: 'paste',
    };

    // A new plot is private and nobody else knows its id, so the roster goes in
    // whole: none of `insertMember`'s locking has anything to guard yet.
    const plot = await deps.db.transaction(async (tx) => {
      const [created] = await tx.insert(plots).values(values).returning();
      await tx.insert(characters).values(
        members.map((member, index) => ({
          plotId: created!.id,
          name: member.name,
          card: member.card,
          orderIndex: index,
          importedFrom,
        })),
      );
      return created!;
    });
    scheduleLoreUpdate(deps, plot.id, c.get('userId'));
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
    // The creator's pick; null or absent is the default model. The catalog check
    // is the draft's own (`draftPlot`), with the account it runs on.
    const model = body['model'];
    if (model !== undefined && model !== null && typeof model !== 'string') {
      throw badRequest('invalid_request', 'model must be a string or null');
    }

    // One draft per creator at a time. The call is a minute long at worst, and a
    // creator hammering the button would otherwise pay for every one of them.
    if (deps.drafting.has(userId)) {
      throw new ApiError(429, 'draft_in_progress', 'A draft is already being written for this user');
    }
    deps.drafting.add(userId);
    try {
      return c.json(await draftPlot(deps, userId, premise, model ?? undefined));
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
    const sent = optionalCustomUi(body);
    // What a member brought is held to the roster as it stands: an editor that
    // still showed a member deleted since does not bring its scripts back.
    const customUi = sent
      ? customUiOfRoster(sent, new Set((await loadMembers(deps.db, id)).map((member) => member.id)))
      : sent;
    const groupSettings = optionalGroupSettings(body);
    const safetyLevel = coerceSafetyLevel(optionalString(body, 'safetyLevel'));
    const commentsEnabled = optionalBoolean(body, 'commentsEnabled');

    const lorebook = body['lorebook'] === undefined ? undefined : coerceLorebook(body['lorebook']);
    const updated = await deps.db.transaction(async (tx) => {
      // The modules are the module routes' to write: what the editor sent is
      // laid over the ones the plot holds, read under the lock an import or a
      // removal takes, so a save racing one neither undoes nor revives it.
      const stored =
        customUi === undefined
          ? undefined
          : (await tx.select({ customUi: plots.customUi }).from(plots).where(eq(plots.id, id)).for('update'))[0]
              ?.customUi;
      const kept = customUi === undefined ? undefined : withStoredModules(customUi, stored);
      const [row] = await tx
        .update(plots)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(intro !== undefined ? { intro } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(lorebook !== undefined ? { lorebook } : {}),
          ...(intros !== undefined ? { intros } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(narrator !== undefined ? { narrator } : {}),
          ...(style !== undefined ? { style } : {}),
          ...(profiles !== undefined ? { profiles } : {}),
          ...(kept !== undefined ? { customUi: kept && Object.keys(kept).length > 0 ? kept : null } : {}),
          ...(groupSettings !== undefined ? { groupSettings } : {}),
          ...(safetyLevel !== undefined ? { safetyLevel } : {}),
          ...(commentsEnabled !== undefined ? { commentsEnabled } : {}),
          ...(language ? { language } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(plots.id, id), eq(plots.ownerId, userId)))
        .returning();
      return row!;
    });
    // The book, or the language that picks the model its vectors are of.
    scheduleLoreUpdate(deps, id, c.get('userId'));
    // Its searchable text may have changed (`search.ts`); a private plot has no vector to change.
    if (updated.visibility === 'public') scheduleSearchVector(deps, id);
    return c.json(await ownerView(deps, updated));
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

  /**
   * Publishing is owner-only, and only for a plot that carries the basics. A
   * plot with imported members also needs `rightsConfirmed: true` — the owner's
   * word that they made those characters or may publish them, which nothing
   * here can check — and the publish stamps when it was given. Unpublishing
   * asks for nothing.
   */
  app.post('/:id/publish', requireUser, rateLimit(deps, RATE_LIMITS.plots), async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const plot = await loadOwnedPlot(deps, id, userId);
    const body = await readJsonBody(c);
    const publish = body['publish'];
    if (typeof publish !== 'boolean') throw badRequest('invalid_request', 'publish must be a boolean');
    const safetyLevel = coerceSafetyLevel(optionalString(body, 'safetyLevel'));
    const rightsConfirmed = optionalBoolean(body, 'rightsConfirmed') === true;
    // Avatars imported before the card stripping existed are cleaned up here, so
    // going public never exposes an embedded card.
    if (publish) {
      const members = await loadMembers(deps.db, id);
      requirePublishable(plot, members);
      for (const member of members) {
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
      // Under the lock an import takes too (`insertMember`), so a member that
      // lands while this publish waits is one it vouches for.
      const [imported] = publish
        ? await tx
            .select({ id: characters.id })
            .from(characters)
            .where(and(eq(characters.plotId, id), isNotNull(characters.importedFrom)))
            .limit(1)
        : [];
      if (imported && !rightsConfirmed) throw rightsUnconfirmed();
      const [row] = await tx
        .update(plots)
        .set({
          visibility: publish ? 'public' : 'private',
          // The audience is declared with the publish, but stored either way: an
          // unpublish must not quietly reset a plot to 'all'.
          ...(safetyLevel !== undefined ? { safetyLevel } : {}),
          // Kept on unpublish: it only ever matters while the row is public.
          ...(publish ? { publishedAt: new Date() } : {}),
          ...(imported ? { rightsConfirmedAt: new Date() } : {}),
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
    // Listed now, or not any more: its vector is written, or deleted (`search.ts`).
    scheduleSearchVector(deps, id);
    // Going public, its Korean readers' aliases are made now if they were not yet.
    if (publish) scheduleLoreAliases(deps, id, { userId, subModel: null });
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
    // What the chat draws: the work's and, after it, its modules' (`readerCustomUi`).
    const drawn = readerCustomUi(plot.customUi, backgroundOf(plot, members));
    // `{{moduleenabled}}`/`{{moduleassetlist}}` on the reader's screen: the
    // modules by namespace, their pictures by name — every reader's already
    // through the asset list — read only when some module has a namespace.
    const modules = plot.customUi?.modules;
    const moduleAssetRows = modules?.some((module) => module.namespace)
      ? await deps.db
          .select({ id: plotAssets.id, name: plotAssets.name, slug: plotAssets.slug })
          .from(plotAssets)
          .where(eq(plotAssets.plotId, plot.id))
      : [];

    return c.json({
      public: true,
      creatorFollow,
      ...toPublicPlotJson(row, members),
      // The one card field written for readers rather than for the model, so it is
      // the one that may leave with the public view.
      characters: members.map((member) => ({
        ...toPublicMemberJson(member),
        intro: member.card.intro ?? '',
        // What the reader's browser rolls a round's speakers by (`groupOrder`).
        talkativeness: coerceTalkativeness(member.talkativeness),
        // How the member's emotion pictures are shown, and which they are — the
        // names are already every reader's through the plot's images.
        emotion: emotionScreenOf(member.card),
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
      // How the reader's browser picks a round's speakers — options, like the style.
      groupSettings: coerceGroupSettings(plot.groupSettings),
      displayScripts: drawn.displayScripts,
      css: drawn.css,
      // Each member's own stylesheet, for its messages, in a work of several.
      memberCss: plot.customUi?.memberCss ?? {},
      // What is drawn behind the chat (`backgroundOf`), and the modules' after it.
      backgroundHtml: drawn.backgroundHtml,
      defaultVariables: plot.customUi?.defaultVariables ?? {},
      componentCode: plot.customUi?.componentCode ?? '',
      componentCapabilities: plot.customUi?.componentCapabilities ?? [],
      modules: cbsModulesOf(modules, new Map(moduleAssetRows.map((asset) => [asset.id, asset.name ?? asset.slug]))),
      commentsEnabled: plot.commentsEnabled,
      commentCount,
    });
  });

  // Idempotent: the counter moves only when a like row actually appears/disappears.
  app.post('/:id/like', requireUser, rateLimit(deps, RATE_LIMITS.social), async (c) => {
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

  app.delete('/:id/like', requireUser, rateLimit(deps, RATE_LIMITS.social), async (c) => {
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
    return c.json(members.map((member) => toMemberJson(plot, member)));
  });

  app.post('/:id/characters', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const plot = await loadOwnedPlot(deps, id, c.get('userId'));
    const body = await readJsonBody(c);
    const name = requireString(body, 'name').trim();
    if (!name) throw badRequest('invalid_request', 'name must not be empty');
    const card = body['card'] === undefined ? emptyCard(name) : coerceCard(body['card'], name);
    const member = await insertMember(deps, id, name, card);
    scheduleLoreUpdate(deps, id, c.get('userId'));
    return c.json(toMemberJson(plot, member), 201);
  });

  /**
   * The creator's arrangement, rewritten whole: the body is every member of the
   * roster, in the order they should stand. A partial list would leave the
   * unnamed members at indexes the request never decided.
   */
  app.post('/:id/characters/reorder', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const plot = await loadOwnedPlot(deps, id, c.get('userId'));
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
    // The first member's settings are the book's, whether every entry activates by meaning among them.
    scheduleLoreUpdate(deps, id, c.get('userId'));
    return c.json(members.map((member) => toMemberJson(plot, member)));
  });

  /**
   * A member's card is written as a patch: the fields sent are laid over the
   * card the row holds (`mergeCard`), read under the row's lock so two saves do
   * not undo each other, and everything not sent — the original card, a RisuAI
   * card's extensions with its scripts — stays as it was. The studio's two
   * RisuAI settings come as values (`emotionMode`, `utilityBot`) rather than as
   * the extension that holds them.
   */
  app.patch('/:id/characters/:characterId', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const characterId = requireUuidParam(c, 'characterId');
    const plot = await loadOwnedPlot(deps, id, c.get('userId'));
    const body = await readJsonBody(c);

    const name = optionalString(body, 'name')?.trim();
    if (name !== undefined && !name) throw badRequest('invalid_request', 'name must not be empty');
    const talkativeness = optionalTalkativeness(body);
    const emotionMode = optionalEmotionMode(body);
    const utilityBot = optionalBoolean(body, 'utilityBot');

    const updated = await deps.db.transaction(async (tx) => {
      const [member] = await tx
        .select()
        .from(characters)
        .where(and(eq(characters.id, characterId), eq(characters.plotId, id)))
        .for('update');
      if (!member) throw notFound('Character not found');
      const merged =
        body['card'] === undefined ? member.card : mergeCard(member.card, body['card'], name ?? member.name);
      const extensions = extensionsWithSettings(merged.extensions, { emotionMode, utilityBot });
      const card = merged === member.card && extensions === merged.extensions ? undefined : { ...merged, extensions };
      const [row] = await tx
        .update(characters)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(card !== undefined ? { card } : {}),
          ...(talkativeness !== undefined ? { talkativeness } : {}),
          updatedAt: new Date(),
        })
        .where(eq(characters.id, characterId))
        .returning();
      return row!;
    });
    scheduleLoreUpdate(deps, id, c.get('userId'));
    return c.json(toMemberJson(plot, updated));
  });

  app.delete('/:id/characters/:characterId', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const characterId = requireUuidParam(c, 'characterId');
    const { member } = await loadOwnedMember(deps, id, characterId, c.get('userId'));
    // What came with the member goes with it — its tagged display scripts and its
    // stylesheet — under the plot's row lock, so an edit racing it is not undone.
    await deps.db.transaction(async (tx) => {
      const [locked] = await tx.select({ customUi: plots.customUi }).from(plots).where(eq(plots.id, id)).for('update');
      await tx.delete(characters).where(and(eq(characters.id, characterId), eq(characters.plotId, id)));
      if (!locked?.customUi) return;
      const kept = withoutMember(locked.customUi, characterId);
      if (JSON.stringify(kept) === JSON.stringify(locked.customUi)) return;
      await tx
        .update(plots)
        .set({ customUi: Object.keys(kept).length > 0 ? kept : null, updatedAt: new Date() })
        .where(eq(plots.id, id));
    });
    if (member.avatarPath) await deleteQuietly(deps.storage, member.avatarPath);
    scheduleLoreUpdate(deps, id, c.get('userId'));
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
  app.post('/:id/characters/:characterId/avatar', requireUser, rateLimit(deps, RATE_LIMITS.upload), async (c) => {
    const id = requireUuidParam(c);
    const characterId = requireUuidParam(c, 'characterId');
    const { plot, member } = await loadOwnedMember(deps, id, characterId, c.get('userId'));

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
    return c.json(toMemberJson(plot, updated));
  });

  app.delete('/:id/characters/:characterId/avatar', requireUser, async (c) => {
    const id = requireUuidParam(c);
    const characterId = requireUuidParam(c, 'characterId');
    const { plot, member } = await loadOwnedMember(deps, id, characterId, c.get('userId'));

    const [updated] = await deps.db
      .update(characters)
      .set({ avatarPath: null, updatedAt: new Date() })
      .where(and(eq(characters.id, characterId), eq(characters.plotId, id)))
      .returning();
    if (member.avatarPath) await deleteQuietly(deps.storage, member.avatarPath);
    return c.json(toMemberJson(plot, updated!));
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
   *
   * The charx is the one format that carries the plot's images, so a card's
   * `{{img::…}}` still finds them in RisuAI (`exportCardCharx`) — and the fonts
   * and pictures the import brought in from other hosts, which its texts then
   * name as `{{raw::…}}` instead of by this server's address (`toRisuAssetRefs`),
   * the stylesheet and the background going out together as RisuAI's
   * `backgroundHTML` (`exportedBackground`). Its icon is the
   * picture the PNG is written on, in whatever format it is. Every plot asset
   * goes into every member's archive: assets are the plot's, and so are the
   * openings, the lorebook and the custom UI that every member's card carries
   * out — any of them may name any image. An unlock condition keeps nothing
   * out, being a reveal inside one chat, and this is the owner's copy. The
   * images are read whole and zipped in memory, so an export holds about twice
   * what the plot's images weigh.
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
    if (format !== 'json' && format !== 'png' && format !== 'charx') {
      throw badRequest('invalid_request', 'format must be json, png or charx');
    }

    const customUi = plot.customUi ?? {};
    const rows =
      format === 'charx'
        ? await deps.db
            .select()
            .from(plotAssets)
            .where(eq(plotAssets.plotId, plot.id))
            .orderBy(asc(plotAssets.createdAt), asc(plotAssets.slug))
        : [];
    // In a charx the plot's assets travel with the card, so its texts name them
    // as RisuAI reaches a card's own (`toRisuAssetRefs`) rather than by an
    // address of this server's.
    const inCard = (text: string): string => (format === 'charx' ? toRisuAssetRefs(text, plot.id, rows) : text);
    const scripts = customUi.displayScripts
      ? displayScriptsFor(customUi.displayScripts, member.id).map((script) => ({ ...script, out: inCard(script.out) }))
      : undefined;
    const card = exportCardV3(member.card, {
      narrator: plot.narrator ?? undefined,
      // The plot's custom UI is the whole answer even when empty: the card's own
      // copies are what the import lifted off it. Of its display scripts, the
      // work's own and this member's — not another member's.
      customUi: scripts ? { ...customUi, displayScripts: scripts } : customUi,
      intros: plot.intros.map(inCard),
      lorebook: plot.lorebook,
      // A charx carries the work's stylesheet — and this member's own — and its
      // background as one `backgroundHTML`, as RisuAI keeps them: what the
      // import split, put back, with every font and picture it brought in from
      // other hosts in the archive. The other formats carry no assets, so the
      // card's own background goes out as it came.
      ...(format === 'charx'
        ? { backgroundHtml: inCard(exportedBackground(plot, await loadMembers(deps.db, plot.id), member.id)) }
        : {}),
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
    if (format === 'png') {
      return new Response(exportCardPng(card, image), {
        headers: { ...headers, 'Content-Type': 'image/png' },
      });
    }

    const assets: CharxExportAsset[] = [];
    const emotions = new Map((member.card.emotionImages ?? []).map((image) => [image.slug, image.name]));
    for (const row of rows) {
      // A row whose file is gone stays out of the card as well: RisuAI refuses
      // a whole card over one image it names and does not carry.
      const stored = await deps.storage.get(row.path);
      if (!stored) continue;
      assets.push({
        slug: row.slug,
        name: row.name,
        ext: extensionOf(row.path),
        bytes: await readAll(stored.body),
        ...(emotions.has(row.slug) ? { emotion: emotions.get(row.slug)! } : {}),
      });
    }
    const icon = image && imagePath ? { ext: extensionOf(imagePath), bytes: image } : undefined;
    return new Response(exportCardCharx(card, assets, icon), {
      headers: { ...headers, 'Content-Type': 'application/zip' },
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

  app.post('/:id/assets', requireUser, rateLimit(deps, RATE_LIMITS.upload), async (c) => {
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
    // The name the source wrote its references in (a paste migration's
    // `{{img::웃음}}`), which the resolver reads beside the slug. Refused rather
    // than cut: a shortened name is a reference that silently stops resolving.
    const name = String(form.get('name') ?? '').trim() || null;
    if (name && name.length > MAX_ASSET_NAME_LENGTH) {
      throw badRequest('invalid_asset', `name must be at most ${MAX_ASSET_NAME_LENGTH} characters`);
    }

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
        .values({ id: assetId, plotId: id, slug, name, path: stored.key, mime: stored.mime, ...measured })
        .onConflictDoUpdate({
          target: [plotAssets.plotId, plotAssets.slug],
          // createdAt stays put: a replaced image keeps its place in the grid.
          // The name is not the bytes' — an imported card's references are
          // written in it — so a replacement that sends none keeps the old one.
          set: { path: stored.key, mime: stored.mime, ...measured, ...(name ? { name } : {}) },
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
  /**
   * An asset by the address it was fetched from at import (`localizeAssets.ts`):
   * `by-name/<host>/<path>` is the asset named `https://<host>/<path>` (a scheme
 * the renderer wrote in front of the host, from a variable, is passed over) — the
   * name matched as written, then without case, as RisuAI looks a name up. What
   * a template address the import localized points at, with the renderer's value
   * in its slot, so a value the import did not foresee is a 404 on our own
   * origin. Streamed as the slug route streams.
   */
  app.get('/:id/assets/by-name/*', async (c) => {
    const plot = await loadVisiblePlot(deps.db, requireUuidParam(c), c.get('viewerId'));
    // A host the renderer wrote from a variable (`{{getvar::cdn}}/…`) comes with its scheme.
    const name = byNameOf(c.req.path);
    const [asset] = await deps.db
      .select()
      .from(plotAssets)
      .where(and(eq(plotAssets.plotId, plot.id), sql`lower(${plotAssets.name}) = lower(${name})`))
      .orderBy(sql`${plotAssets.name} = ${name} desc`, asc(plotAssets.createdAt))
      .limit(1);
    if (!asset) throw notFound('Asset not found');
    return assetResponse(deps.storage, c, asset);
  });

  app.get('/:id/assets/:slug', async (c) => {
    const plot = await loadVisiblePlot(deps.db, requireUuidParam(c), c.get('viewerId'));
    const [asset] = await deps.db
      .select()
      .from(plotAssets)
      .where(and(eq(plotAssets.plotId, plot.id), eq(plotAssets.slug, c.req.param('slug')!)))
      .limit(1);
    if (!asset) throw notFound('Asset not found');
    return assetResponse(deps.storage, c, asset);
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

  /* ------------------------------------------------------------ the modules */

  /** Takes a module out of the work: its record, and the pictures it brought that are still there. */
  app.delete('/:id/modules/:moduleId', requireUser, async (c) => {
    const id = requireUuidParam(c);
    await loadOwnedPlot(deps, id, c.get('userId'));
    const moduleId = c.req.param('moduleId');
    const removed = await deps.db.transaction(async (tx) => {
      const [locked] = await tx.select({ customUi: plots.customUi }).from(plots).where(eq(plots.id, id)).for('update');
      const modules = locked?.customUi?.modules ?? [];
      const gone = modules.find((module) => module.id === moduleId);
      if (!locked?.customUi || !gone) return null;
      const { modules: _modules, ...rest } = locked.customUi;
      const kept = modules.filter((module) => module !== gone);
      const customUi: PlotCustomUi = kept.length > 0 ? { ...rest, modules: kept } : rest;
      const [row] = await tx
        .update(plots)
        .set({ customUi: Object.keys(customUi).length > 0 ? customUi : null, updatedAt: new Date() })
        .where(eq(plots.id, id))
        .returning();
      return { plot: row!, gone };
    });
    if (!removed) throw notFound('Module not found');
    await deleteAssets(deps, id, removed.gone.assets);
    scheduleLoreUpdate(deps, id, c.get('userId'));
    return c.json(await ownerView(deps, removed.plot));
  });

  /* -------------------------------------------------------------- the cover */

  /**
   * The cover image, owner-only to change and readable by anyone who can read the
   * plot's public face. Streamed through the API under every driver, exactly as
   * an avatar is: it is an `<img>` on our origin, and a presigned redirect would
   * fail the sanitizer's same-origin rule.
   */
  app.post('/:id/cover', requireUser, rateLimit(deps, RATE_LIMITS.upload), async (c) => {
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

/**
 * The plot with its roster and its comment count — every owner-side answer.
 * Beside the plot's own book rides what its always-on lore costs, as each
 * member's does (`toMemberJson`).
 */
export async function ownerView(deps: AppDeps, plot: Plot): Promise<unknown> {
  const members = await loadMembers(deps.db, plot.id);
  return {
    ...toPlotJson(plot),
    plotLoreConstantTokens: constantLoreTokens(plot.lorebook, firstPromptMacro(plot, plot.name)),
    characters: members.map((member) => toMemberJson(plot, member)),
    // What the chat draws behind the work now — its own, or its card's on a plot
    // from before it — for the studio's field to start from.
    backgroundHtml: backgroundOf(plot, members),
    // Only the owner view carries the comment count: the listings are card grids,
    // and a count per card would cost a query per card.
    commentCount: await countComments(deps.db, plot),
  };
}

/**
 * The card's picture as the new plot's cover, through `storableImage` like an
 * uploaded cover — the copy every reader is served carries none of the card's
 * text chunks. Best effort: the plot is already written, and an import does not
 * fail over its cover; the plot simply has none.
 */
async function writeImportedCover(deps: AppDeps, plot: Plot, bytes: Uint8Array): Promise<Plot> {
  const image = storableImage(bytes);
  // The cover upload's own cap, measured once the card's text chunks are gone: a
  // cover is fetched by every explore card, and a picture past it stays the
  // character's avatar only.
  if (!image || image.bytes.length > MAX_IMAGE_BYTES) return plot;
  const key = coverKey(plot.id, image.ext);
  try {
    await deps.storage.put(key, image.bytes, image.mime);
    const [updated] = await deps.db
      .update(plots)
      .set({ coverPath: key, updatedAt: new Date() })
      .where(eq(plots.id, plot.id))
      .returning();
    return updated ?? plot;
  } catch {
    await deleteQuietly(deps.storage, key);
    return plot;
  }
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
