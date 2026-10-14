import type {
  AssetUnlock,
  GroupSettings,
  HypaV3Settings,
  ImportProvenance,
  LoreEntry,
  NarratorConfig,
  NormalizedCard,
  PlotCustomUi,
  PlotProfile,
  PlotStyle,
  VariableDelta,
  Variables,
} from '@shizue/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';

export type Visibility = 'private' | 'public';
export type MessageRole = 'user' | 'assistant';
/**
 * Where a turn's text came from. A user turn: the reader, or a card component
 * acting for them. An assistant turn: the model (`user`), or a card's script
 * writing as its character (`script`).
 */
export type MessageSource = 'user' | 'component' | 'script';
/** Content language of a plot, independent of the UI locale. */
export type ContentLanguage = 'ko' | 'en' | 'ja';
/**
 * Audience a plot is meant for. Without age verification the API no longer
 * accepts `adult`; it stays in the type for rows saved before that, which every
 * public surface still filters out (see `publiclyListed` in the API).
 */
export type SafetyLevel = 'all' | 'adult';
export type NotificationKind = 'plot_published';
export type JobKind = 'notification_fanout' | 'memory_backfill';
export type JobStatus = 'pending' | 'done' | 'failed';

/** The publication event and the follower cutoff captured in its transaction. */
export interface JobPayloadMap {
  notification_fanout: {
    kind: 'plot_published';
    plotId: string;
    actorId: string;
    publishedAt: string;
  };
  /** Summarizes an imported chat's history into its memory, a batch per call. */
  memory_backfill: {
    chatId: string;
  };
}
export type JobPayload = JobPayloadMap[JobKind];

/** Dimension of the stored embeddings — fixed by the column type. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * The single rolling summary the memory kept before HypaV3 (`chats.memory`).
 * Retired: migration 0011 turned each one into a summary of `chat_summaries`,
 * and nothing reads or writes the column since.
 */
export interface ChatMemory {
  summary: string;
  /** Last message the summary covers; only valid while it is on the current path. */
  anchorMessageId: string;
  updatedAt: string;
}

/** Context budgets a chat may pick from; the middle one is the default. */
export const MEMORY_CONTEXT_BUDGETS = [8000, 16000, 32000] as const;

/**
 * Per-chat overrides for the memory layer: the context budget, and RisuAI
 * HypaV3's settings a chat may tune (`HypaV3Settings` in @shizue/core, which
 * holds the defaults). A missing key (or a null column) means the default.
 */
export interface ChatMemorySettings extends Partial<HypaV3Settings> {
  contextBudget?: (typeof MEMORY_CONTEXT_BUDGETS)[number];
}

/** The six relationship axes (WHIF benchmark), in display order. */
export const RELATIONSHIP_AXES = [
  'affection',
  'obsession',
  'trust',
  'liking',
  'disgust',
  'fear',
] as const;

export type RelationshipAxis = (typeof RELATIONSHIP_AXES)[number];
/** Each axis is an integer 0-100. */
export type RelationshipAxes = Record<RelationshipAxis, number>;

/** How the character currently feels about the user, extracted every few turns. */
export interface ChatRelationship {
  /** Null until the first extraction succeeds — the state exists before it does. */
  axes: RelationshipAxes | null;
  /** One-line summary of the relationship, in the language of the chat. */
  note: string;
  updatedAt: string;
  /**
   * Rounds the branch held when the last extraction was attempted — assistant
   * messages, a group turn's replies counted once together (the API's `roundCount`).
   * The trigger compares it against the current branch rather than counting
   * generation events, so regenerate/continue do not inflate it and a turn that
   * lands while an extraction runs is not lost.
   */
  lastExtractedAssistantDepth: number;
}

/**
 * Where a turn stands with the card's own scripts. `pending` is an assistant turn
 * the reader's browser has not yet run its output scripts over (editoutput, output
 * triggers): stored as the model wrote it, and finished by the commit that clears
 * the mark. Null is every other turn.
 */
export type MessageScriptState = 'pending';

/**
 * What a card's scripts rewrote of the work itself — a member's description, a
 * lorebook entry, its name — for one reader on one plot (`plot_reader_overlays`),
 * as RisuAI rewrites the character for every chat with it at once. Its shape is
 * `ScriptOverlay` in @shizue/core/triggers (`{members: {[id]: {description?,
 * lorebook?, postHistoryInstructions?, name?, firstMessage?, backgroundHtml?}},
 * persona?}`), validated and merged by apps/api/src/scriptState.ts; the API lays
 * it over the cards when it builds a prompt. Typed loosely here so the schema
 * does not depend on the script runtime.
 */
export type ChatScriptOverlay = Record<string, unknown>;

// The first-class unit. A plot is what is created, published, explored, liked,
// commented on and chatted with; its characters are structured sub-entities of it
// and have no exposure of their own. Every axis that decides who may see anything
// lives here: `visibility`, `language` (content language, a hard partition) and
// `safety_level`.
export const plots = pgTable(
  'plots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // What readers are told about the work, as against `description`, which is what
    // the model is told. The two are separate columns because they have separate
    // audiences; neither substitutes for the other.
    intro: text('intro').notNull().default(''),
    description: text('description').notNull().default(''),
    /** Storage key, namespaced `covers/…` (apps/api/src/storage.ts). */
    coverPath: text('cover_path'),
    lorebook: jsonb('lorebook').$type<LoreEntry[]>().notNull().default([]),
    // The openings a reader picks between when they start a chat. Every one of
    // them becomes a parent-null sibling root of the new chat, so they are the
    // plot's greetings — speech-protocol text with macros, capped at 10 entries
    // of 4,000 characters by the API.
    intros: jsonb('intros').$type<string[]>().notNull().default([]),
    // How the scene is told, for the whole work. A chat may override it.
    narrator: jsonb('narrator').$type<NarratorConfig>(),
    // How the creator wants the work written — the directives the assembler
    // compiles, and the two features derived from them (status window, choices).
    // Null when the creator set nothing; the coercion (@shizue/core) decides what a
    // stored style may contain.
    style: jsonb('style').$type<PlotStyle>(),
    // The reader profiles this work recommends: what a chat can be started as.
    // Null until the creator writes one; the coercion (@shizue/core) decides what a
    // stored profile may contain, and the caps (5 per plot) live with it.
    profiles: jsonb('profiles').$type<PlotProfile[]>(),
    // Display scripts, variable seeds and the Layer 2 component, in one column.
    // They belong to the work because a chat is the work's: an imported card
    // carries them and the import lifts them here.
    customUi: jsonb('custom_ui').$type<PlotCustomUi>(),
    // How a work of two or more members picks a round's speakers (@shizue/core
    // group.ts): the order and the cap. Null is the default — natural order,
    // three a round; the coercion decides what a stored value may say.
    groupSettings: jsonb('group_settings').$type<GroupSettings>(),
    language: text('language').$type<ContentLanguage>().notNull().default('ko'),
    visibility: text('visibility').$type<Visibility>().notNull().default('private'),
    // Chosen on publish. Not part of the explore indexes: 'all' is the default and
    // by far the common case, so the filter costs a recheck rather than a scan.
    safetyLevel: text('safety_level').$type<SafetyLevel>().notNull().default('all'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    // Denormalized counters, kept in the same transaction as the rows they count.
    likeCount: integer('like_count').notNull().default(0),
    // Chats other users started with this plot; the owner's own are not counted.
    chatCount: integer('chat_count').notNull().default(0),
    // The explore filter column, synced on publish and on edits (max 10, 20 chars).
    tags: text('tags').array().notNull().default([]),
    // The creator may close the comment section; existing comments then stay hidden.
    commentsEnabled: boolean('comments_enabled').notNull().default(true),
    // When the owner last declared they hold the rights to the imported characters
    // the plot shows. Stamped by every publish, and every import into a public
    // plot, that had imported members to vouch for; null until the first.
    rightsConfirmedAt: timestamp('rights_confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One index per explore sort; the hard partition (visibility, language) leads.
    // The trailing id matches the cursor's tiebreak, so a later page seeks into a
    // tie group instead of sorting it.
    index('plots_explore_recent_idx').on(t.visibility, t.language, t.publishedAt.desc(), t.id.desc()),
    index('plots_explore_likes_idx').on(t.visibility, t.language, t.likeCount.desc(), t.id.desc()),
    index('plots_explore_chats_idx').on(t.visibility, t.language, t.chatCount.desc(), t.id.desc()),
    index('plots_tags_idx').using('gin', t.tags),
  ],
);

// A member of a plot's roster, and nothing on its own: it has no owner, no
// visibility and no counters, because every one of those questions is the plot's
// to answer and authorization always joins through it. `card` is the import
// container the whole NormalizedCard round-trips through; the editor writes only
// the subset (name/intro/description/personality/mesExample) it exposes.
// The cap (10 per plot) is enforced by the API.
export const characters = pgTable(
  'characters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plotId: uuid('plot_id')
      .notNull()
      .references(() => plots.id, { onDelete: 'cascade' }),
    // The roster name: the speaker prefix the script protocol matches (@shizue/core
    // speech.ts), so it is the row's own column rather than a read of the card.
    name: text('name').notNull(),
    card: jsonb('card').$type<NormalizedCard>().notNull(),
    // Set when the member came from a card file, null when the studio made it. A
    // column rather than a card field, because it records how the row came to be,
    // not what the character is — an export never carries it.
    importedFrom: jsonb('imported_from').$type<ImportProvenance>(),
    /** Storage key, namespaced `avatars/…` (apps/api/src/storage.ts). */
    avatarPath: text('avatar_path'),
    // The creator's arrangement, which is the order the prompt blocks are written
    // in and the order the roster renders in. Not unique: a reorder rewrites the
    // whole set, and two members briefly sharing an index only ties their order.
    orderIndex: integer('order_index').notNull().default(0),
    // 대화량: how readily the member speaks unprompted in a group round, 0..100,
    // 0 being only when the reader writes them a line or picks them. Null is the
    // default, 50 (`coerceTalkativeness`).
    talkativeness: smallint('talkativeness'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The roster is loaded in full, in order, on every generation; the index is that
  // read rather than a general-purpose foreign-key index.
  (t) => [index('characters_plot_id_idx').on(t.plotId, t.orderIndex)],
);

export const plotLikes = pgTable(
  'plot_likes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    plotId: uuid('plot_id')
      .notNull()
      .references(() => plots.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.plotId] }),
    // The weekly ranking counts a plot's likes inside a time window; without a
    // plot-led index that correlated count rescans the table per ranked row.
    index('plot_likes_plot_id_idx').on(t.plotId, t.createdAt),
  ],
);

// Images a plot can show inside a message through `{{img::slug}}`. The slug is
// the only handle the text has, so it is unique per plot; the cap (100) is
// enforced by the API.
export const plotAssets = pgTable(
  'plot_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plotId: uuid('plot_id')
      .notNull()
      .references(() => plots.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    // The name an imported card gave the image, as it wrote it. RisuAI cards build
    // image references out of these names at render time (`{{img::{{getvar::outfit}}.png}}`),
    // and a slug cannot stand in for them — the fold turns a Korean name into
    // nothing. Null for uploads.
    name: text('name'),
    /** Storage key, namespaced `assets/…` (apps/api/src/storage.ts). */
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    // Intrinsic pixel size and the blurred placeholder (base64 thumbhash), all
    // measured by the uploader before it sends the bytes. Null together: images
    // that arrived through the charx import simply render without a reserved box.
    width: integer('width'),
    height: integer('height'),
    thumbhash: text('thumbhash'),
    // What a chat has to do before this image is revealed in it. Null — every
    // asset until a creator sets one — means it is simply visible. A reward layer
    // rather than access control: the bytes are served to everyone who may read
    // the plot either way, and `chat_asset_unlocks` records the reveals.
    unlock: jsonb('unlock').$type<AssetUnlock>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('plot_assets_plot_id_slug_key').on(t.plotId, t.slug)],
);

// One chat's reveal of one unlockable asset. Written the moment the condition is
// first met and never taken back — an unlock is a thing that happened in that
// conversation, so the pair is the key and a second write is a no-op.
export const chatAssetUnlocks = pgTable(
  'chat_asset_unlocks',
  {
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => plotAssets.id, { onDelete: 'cascade' }),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.assetId] })],
);

// Comments on a plot's public page, one reply level deep. Deletion is soft:
// `deleted_at` is stamped and `content` is blanked in the same write, so nothing
// deleted is kept around — the row only survives to anchor its replies.
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    plotId: uuid('plot_id')
      .notNull()
      .references(() => plots.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Null = top-level. A reply always points at a top-level comment of the same
    // plot; the API is what enforces it, so no self-FK is declared.
    parentId: uuid('parent_id'),
    content: text('content').notNull(),
    spoiler: boolean('spoiler').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The listing walks (created_at desc, id desc) within one plot; the trailing
    // id matches the cursor's tiebreak.
    index('comments_plot_id_idx').on(t.plotId, t.createdAt.desc(), t.id.desc()),
    // Replies are loaded per parent, and the placeholder rule asks a parent
    // whether it still has any.
    index('comments_parent_id_idx').on(t.parentId),
  ],
);

// One reader following one creator. The pair is the key, so following twice is
// the same row and the API answers idempotently; self-follows are refused there
// rather than by a constraint, because the answer is a 400 and not a crash.
export const follows = pgTable(
  'follows',
  {
    followerId: text('follower_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    creatorId: text('creator_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.creatorId] }),
    // The other direction of the same edge: a creator's follower count and the
    // fan-out that walks it.
    index('follows_creator_id_idx').on(t.creatorId, t.createdAt.desc()),
  ],
);

// A followed creator published a plot. The notification follows that plot's lifetime.
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NotificationKind>().notNull(),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    plotId: uuid('plot_id').references(() => plots.id, { onDelete: 'cascade' }),
    // Null until the reader marks everything read; there is no per-row read.
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The list walks (created_at desc, id desc) within one recipient; the trailing
    // id matches the cursor's tiebreak.
    index('notifications_user_id_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
    // One row per recipient per subject per kind, which is what lets the fan-out be
    // re-run: a job whose second batch failed is retried from the first, and the
    // batches it already wrote conflict instead of notifying anyone twice. Rows
    // with no plot are outside the constraint — nulls are distinct — and that is
    // right, since a kind that is not about a plot has no such rule.
    unique('notifications_user_id_plot_id_kind_key').on(t.userId, t.plotId, t.kind),

  ],
);

export const personas = pgTable('personas', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** Storage key, namespaced `personas/…` (apps/api/src/storage.ts). Served to its owner only. */
  avatarPath: text('avatar_path'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// A reader's own preset: what they add on top of the prompt preset a chat runs
// with — a main-instruction addition and a global note (@shizue/core
// `ReaderAdditions`). Account-level, picked per chat (`chats.reader_preset_id`).
// Count and lengths capped by the API.
export const readerPresets = pgTable(
  'reader_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    main: text('main').notNull().default(''),
    globalNote: text('global_note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reader_presets_user_id_idx').on(t.userId)],
);

export const chats = pgTable(
  'chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    plotId: uuid('plot_id')
      .notNull()
      .references(() => plots.id, { onDelete: 'cascade' }),
    personaId: uuid('persona_id').references(() => personas.id, { onDelete: 'set null' }),
    title: text('title').notNull().default(''),
    model: text('model').notNull(),
    // The auxiliary model (RisuAI's sub model) the reader picked for this chat's
    // side work: card scripts' auxiliary calls and the background jobs — memory
    // summaries, relationship, reply suggestions. Null leaves it to the memory
    // channel's default, the first model in the owner's ChatGPT catalog.
    subModel: text('sub_model'),
    // Author's note: per-chat instruction injected four messages from the end of
    // the history (`AUTHOR_NOTE_DEPTH`).
    note: text('note').notNull().default(''),
    // Prompt preset id (see @shizue/core presets); unknown values fall back to the default.
    preset: text('preset').notNull().default('standard'),
    // The reader's own preset on top of it; null adds nothing. Always one of the
    // chat owner's, which the API checks on the way in and again when it reads it.
    readerPresetId: uuid('reader_preset_id').references(() => readerPresets.id, { onDelete: 'set null' }),
    // Leaf of the currently selected branch. Intentionally unconstrained to avoid a
    // circular FK with messages.chat_id.
    headMessageId: uuid('head_message_id'),
    // Retired: the rolling summary before HypaV3. Migration 0011 moved each into
    // `chat_summaries`; the column stays unread, as `script_overlay` does, for a
    // process still running the code before it.
    memory: jsonb('memory').$type<ChatMemory>(),
    // Memory tuning for this chat; null means every pipeline default.
    memorySettings: jsonb('memory_settings').$type<ChatMemorySettings>(),
    // Bumped by every event that can invalidate the memory layer (an edit, a
    // hide or a delete of a message). A background summary is written only if
    // it still matches.
    memoryRevision: integer('memory_revision').notNull().default(0),
    // Relationship stats. No user-edit path, so no revision counter: the background
    // extraction is the only writer and last write wins.
    relationship: jsonb('relationship').$type<ChatRelationship>(),
    relationshipEnabled: boolean('relationship_enabled').notNull().default(true),
    // This chat's narrator, standing in for the plot's own. Null means the plot
    // decides, which is what every chat starts out doing.
    narrator: jsonb('narrator').$type<NarratorConfig>(),
    // Consent for the sendTurn capability, given once per chat and revocable in
    // the chat panel. A plot declaring the capability is not enough on its own.
    allowComponentTurns: boolean('allow_component_turns').notNull().default(false),
    // The reader's half of the two style features: on by default, and meaningful
    // only while the plot enables the feature at all — a chat on a plot with no
    // status window carries a true nobody ever sees.
    statusWindowEnabled: boolean('status_window_enabled').notNull().default(true),
    choicesEnabled: boolean('choices_enabled').notNull().default(true),
    // Roster members the reader sent off the stage: their cards leave the prompt
    // until they are brought back. Null (or empty) means the whole roster is on.
    absentCharacterIds: jsonb('absent_character_ids').$type<string[]>(),
    // Reasoning effort the reader asked for. Null sends none and leaves the model
    // at its default; a value is only sent where the model advertises it.
    reasoningEffort: text('reasoning_effort'),
    // The generation claim: when a turn is being generated on this chat, and null
    // when none is. It lives in the row rather than in a process so several API
    // instances see the same answer; the stream renews it while it runs, and a
    // claim nobody has renewed for two minutes is taken over rather than trusted.
    generatingAt: timestamp('generating_at', { withTimezone: true }),
    // Set when the conversation came from another app's chat file (SillyTavern's
    // JSONL), null when it was started here. The hash is what a second run of the
    // same import recognizes it by.
    importedFrom: jsonb('imported_from').$type<ImportProvenance>(),
    // True while an import is still writing the history in batches. Nothing but
    // the import may write to the chat until it is finished.
    importing: boolean('importing').notNull().default(false),
    // Retired: the card's scripts' rewrites of the work were kept here, per chat,
    // until they moved to the reader and the plot (`plot_reader_overlays`, which
    // migration 0007 filled from this column). Nothing reads or writes it any
    // more; it stays so a process still running the code from before that
    // migration does not fail on a column it names.
    scriptOverlay: jsonb('script_overlay').$type<ChatScriptOverlay>(),
    // RisuAI's chat `localLore`: the entries a card's Lua upserted
    // (`upsertLocalLoreBook`), which belong to this chat alone and are activated
    // after the scripted member's own lore. Null until a script writes one. Per
    // chat, not per branch: a swipe does not undo it.
    localLore: jsonb('local_lore').$type<LoreEntry[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chats_user_id_idx').on(t.userId), index('chats_plot_id_idx').on(t.plotId)],
);

// Append-only message tree; the active path is walked from chats.head_message_id
// up the parent chain.
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    role: text('role').$type<MessageRole>().notNull(),
    content: text('content').notNull(),
    // Where the text came from. Only a user turn can come from a component, and
    // only an assistant turn from a card's script: a character message a script
    // added, or a message it turned into one ('script'). Every other assistant
    // turn is 'user'.
    source: text('source').$type<MessageSource>().notNull().default('user'),
    // Stage directions attached to a user turn: the ruling a game component made
    // about it. Injected into the prompt only while the turn is the last one, and
    // never rendered as message text.
    directions: text('directions'),
    // Lore entries (by `loreEntryKey`) that freshly triggered for the prompt this
    // assistant turn was generated from. Timed effects read the branch's records.
    loreTriggers: jsonb('lore_triggers').$type<string[]>(),
    // What the card's scripts left on this turn: the final value of each variable
    // they changed, null for one they unset (see `VariableDelta` in @shizue/core).
    // Laid over the turn's own `{{setvar}}` macros wherever the branch is folded.
    variableDelta: jsonb('variable_delta').$type<VariableDelta>(),
    // 'pending' while the reader's browser still owes this turn its output
    // scripts; null otherwise (see `MessageScriptState`).
    scriptState: text('script_state').$type<MessageScriptState>(),
    // Bumped by every script commit to the row. A commit names the revision its
    // scripts ran on, so a second tab running the same scripts on the same turn
    // is refused rather than applied twice.
    scriptRev: integer('script_rev').notNull().default(0),
    model: text('model'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    // A group turn's reply is one member's whole (@shizue/core group.ts): who said
    // it. Null for every other message — the reader's, a scene reply naming its
    // speakers in `이름:` lines, a narration — and once the member is deleted.
    speakerMemberId: uuid('speaker_member_id').references(() => characters.id, { onDelete: 'set null' }),
    // The round a group reply belongs to: the id of the round's first reply,
    // which carries its own. Unconstrained, as `head_message_id` is — a label the
    // round's replies share, which outlives the message it was taken from.
    groupTurnId: uuid('group_turn_id'),
    // Hidden from the AI (SillyTavern's /hide): still on screen, never in what a
    // model reads — the prompt, the lore scan, the memory, suggestions. On the
    // node, so every branch through it shares it. Card scripts still see it.
    hiddenFromPrompt: boolean('hidden_from_prompt').notNull().default(false),
    // The expression its member wears after this reply — the name of one of the
    // member's emotion pictures (`NormalizedCard.emotionImages`), chosen by the
    // auxiliary model after the reply or by the card's `@@emo` script. RisuAI
    // keeps the latest few in memory; here it is the reply's own, so a reload or
    // a swipe to another branch shows the picture that branch left. Null until
    // one is chosen, and on every message no emotion screen reads.
    emotion: text('emotion'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_chat_id_idx').on(t.chatId),
    index('messages_parent_id_idx').on(t.parentId),
    // What a member's delete walks to clear its replies' speaker; only the
    // tagged few are in it.
    index('messages_speaker_member_id_idx').on(t.speakerMemberId).where(sql`${t.speakerMemberId} is not null`),
  ],
);

// Images the reader attached to one of their own turns. Uploaded before the turn
// is sent, so a row exists with `message_id` still null; the send binds it to the
// message it was written for, and an unbound row is the composer's to keep or
// throw away. Deleting the message takes its attachments with it, and the object
// behind `path` is deleted by the route that prunes the row.
export const chatAttachments = pgTable(
  'chat_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    // Null while the upload is still waiting for the turn it belongs to.
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    /** Storage key, namespaced `attachments/…` (apps/api/src/storage.ts). */
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    // Measured by the uploader before it sends the bytes, exactly like a
    // character asset: null together for an image the browser could not decode.
    width: integer('width'),
    height: integer('height'),
    thumbhash: text('thumbhash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chat_attachments_chat_id_idx').on(t.chatId),
    index('chat_attachments_message_id_idx').on(t.messageId),
  ],
);

/**
 * A pgvector `vector` of any dimension. Each row says which embedding model
 * made it, and only vectors of one model are ever compared, so the column is
 * not tied to one model's size — a model change re-embeds rather than migrates.
 * pgvector's text form is the JSON array's.
 */
const anyVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(value) as number[],
});

// The chat's memory, as RisuAI HypaV3's summaries: each a summary of a batch of
// the branch's messages (`message_ids`, oldest first), pinned (`important`) or
// not. A summary applies to a branch only while every message it covers is on
// it; editing, hiding or deleting one of them deletes the summary.
export const chatSummaries = pgTable(
  'chat_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    messageIds: uuid('message_ids').array().notNull(),
    important: boolean('important').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_summaries_chat_id_idx').on(t.chatId)],
);

// A summary's text split as HypaV3 splits it for the similarity search
// (`summaryChunkSeparator`), each piece embedded by the server's embedder.
// `model` is the embedder's id: a row of another model is stale, never compared,
// and replaced when the summary is embedded again. Rewriting the summary's
// text deletes its rows.
export const chatSummaryChunks = pgTable(
  'chat_summary_chunks',
  {
    summaryId: uuid('summary_id')
      .notNull()
      .references(() => chatSummaries.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    model: text('model').notNull(),
    embedding: anyVector('embedding').notNull(),
  },
  (t) => [primaryKey({ columns: [t.summaryId, t.chunkIndex] })],
);

// Long-term facts extracted from a chat — unused since the memory became
// HypaV3's summaries. Kept for a fact layer the server embedder could revive.
export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    plotId: uuid('plot_id')
      .notNull()
      .references(() => plots.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    sourceMessageId: uuid('source_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memories_chat_id_idx').on(t.chatId)],
);

// Reusable author's notes, owned by the account rather than by one chat. The caps
// (100 per account, 2,000 characters) are enforced by the API.
export const userNotes = pgTable(
  'user_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    content: text('content').notNull().default(''),
    /** Free-form folder name; '' is the ungrouped bucket. */
    groupName: text('group_name').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('user_notes_user_id_idx').on(t.userId)],
);

// Notes attached to a chat, injected into the author's note slot. Capped at 10 per
// chat by the API.
export const chatNoteLinks = pgTable(
  'chat_note_links',
  {
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    noteId: uuid('note_id')
      .notNull()
      .references(() => userNotes.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.noteId] })],
);

// Global variables: one reader's values for one plot, shared by every chat they
// have on it and by no one else — RisuAI's `getglobalvar`, SillyTavern's
// `{{getglobalvar}}`. Not branch-scoped, unlike chat variables: a swipe does not
// take one back. Capped in keys and size by the API (see `scriptState.ts`).
export const plotReaderVariables = pgTable(
  'plot_reader_variables',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    plotId: uuid('plot_id')
      .notNull()
      .references(() => plots.id, { onDelete: 'cascade' }),
    variables: jsonb('variables').$type<Variables>().notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.plotId] })],
);

// What a card's scripts rewrote of the work — a member's description, lore,
// global note, name, first message and background, and the reader's persona
// (`ChatScriptOverlay`) — for one reader on one plot. RisuAI's scripts rewrite
// the character object itself, so a rewrite carries to every chat with it; here
// the work is the creator's and many readers play it, so the rewrite stays with
// the reader and the plot, like their global variables, and is laid over the
// work wherever one of their chats on it is assembled. Not branch-scoped: a
// swipe does not take one back. Merged field by field under this row's lock and
// capped by the API (see `scriptState.ts`).
export const plotReaderOverlays = pgTable(
  'plot_reader_overlays',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    plotId: uuid('plot_id')
      .notNull()
      .references(() => plots.id, { onDelete: 'cascade' }),
    overlay: jsonb('overlay').$type<ChatScriptOverlay>().notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.plotId] })],
);

/**
 * One reader's walk through a feed sorted by a counter that moves underneath it
 * (explore `likes`/`chats`). `seen` is every row id the walk has
 * handed out, in the order it handed them out, and the cursor is an offset into
 * it: the snapshot is what makes the walk see each row exactly once even as the
 * counters move. Written only once a reader pages past the first page, and
 * collected by TTL — there is no background job, so the next walk to start does
 * the sweep.
 */
export const feedCursors = pgTable(
  'feed_cursors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seen: uuid('seen').array().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('feed_cursors_updated_at_idx').on(t.updatedAt)],
);

/**
 * Work a request handed off rather than did. A row is written inside the caller's
 * own transaction — that is the whole point of the queue living in Postgres: the
 * enqueue commits with the write that caused it, or neither of them happens.
 *
 * `locked_at` is a lease and not a lock. A worker that dies mid-job leaves one
 * standing, and the claim takes over anything older than two minutes; the same
 * convention `chats.generating_at` uses, for the same reason.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<JobKind>().notNull(),
    payload: jsonb('payload').$type<JobPayload>().notNull(),
    /** When the job became due; the backoff pushes it out after a failed attempt. */
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    /** Attempts started, counted by the claim — so it includes the one running now. */
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    /** Who holds the lease, as `hostname:pid`. Diagnostic only; the lease is the authority. */
    lockedBy: text('locked_by'),
    status: text('status').$type<JobStatus>().notNull().default('pending'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The claim query, which is the only read of this table on a hot path: the
    // oldest due row that is still pending.
    index('jobs_claim_idx').on(t.status, t.runAt),
  ],
);

export type Plot = typeof plots.$inferSelect;
export type NewPlot = typeof plots.$inferInsert;
export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;
export type PlotLike = typeof plotLikes.$inferSelect;
export type PlotAsset = typeof plotAssets.$inferSelect;
export type NewPlotAsset = typeof plotAssets.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type ChatAssetUnlock = typeof chatAssetUnlocks.$inferSelect;
export type Follow = typeof follows.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type Persona = typeof personas.$inferSelect;
export type ReaderPreset = typeof readerPresets.$inferSelect;
export type NewPersona = typeof personas.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type ChatAttachment = typeof chatAttachments.$inferSelect;
export type NewChatAttachment = typeof chatAttachments.$inferInsert;
export type ChatSummary = typeof chatSummaries.$inferSelect;
export type ChatSummaryChunk = typeof chatSummaryChunks.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type UserNote = typeof userNotes.$inferSelect;
export type NewUserNote = typeof userNotes.$inferInsert;
export type ChatNoteLink = typeof chatNoteLinks.$inferSelect;
export type PlotReaderVariables = typeof plotReaderVariables.$inferSelect;
export type PlotReaderOverlay = typeof plotReaderOverlays.$inferSelect;
export type FeedCursor = typeof feedCursors.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
