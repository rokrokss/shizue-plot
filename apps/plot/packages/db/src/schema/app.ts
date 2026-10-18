import type {
  AuthorNoteSettings,
  ChatRetrievalSettings,
  ChatTranslationSettings,
  EmotionProcessor,
  GroupSettings,
  HypaV3Settings,
  ImportProvenance,
  LoreAliases,
  LoreEntry,
  NarratorConfig,
  NormalizedCard,
  PlotCustomUi,
  PlotModule,
  PlotProfile,
  PlotStyle,
  ReaderModuleAsset,
  VariableDelta,
  Variables,
} from '@shizue/core';
import type { ModelBinding } from '@shizue/llm';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  foreignKey,
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
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';

export type MessageRole = 'user' | 'assistant';
/**
 * Where a turn's text came from. A user turn: the reader, or a card component
 * acting for them. An assistant turn: the model (`user`), or a card's script
 * writing as its character (`script`).
 */
export type MessageSource = 'user' | 'component' | 'script';
/** Content language of a plot, independent of the UI locale. */
export type ContentLanguage = 'ko' | 'en' | 'ja';
export type JobKind = 'memory_backfill' | 'file_import';
export type JobStatus = 'pending' | 'done' | 'failed';

/** What each kind of job is handed. */
export interface JobPayloadMap {
  /** Summarizes an imported chat's history into its memory, a batch per call. */
  memory_backfill: {
    chatId: string;
  };
  /** Reads a file a reader uploaded and imports it (`file_imports`). */
  file_import: {
    importId: string;
  };
}
export type JobPayload = JobPayloadMap[JobKind];

/** Context budgets a chat may pick from; the largest is the default (`DEFAULT_CONTEXT_BUDGET` in @shizue/core). */
export const MEMORY_CONTEXT_BUDGETS = [8000, 16000, 32000, 64000] as const;

/**
 * Per-chat overrides for the memory layer: the context budget, and RisuAI
 * HypaV3's settings a chat may tune (`HypaV3Settings` in @shizue/core, which
 * holds the defaults). A missing key (or a null column) means the default.
 */
export interface ChatMemorySettings extends Partial<HypaV3Settings> {
  contextBudget?: (typeof MEMORY_CONTEXT_BUDGETS)[number];
  /** Facts a request may carry (`[기억]`), 0–`MAX_FACT_COUNT`; 0 turns the facts off, extraction too. */
  factCount?: number;
}

/**
 * Where a turn stands with the card's own scripts. `pending` is an assistant turn
 * the reader's browser has not yet run its output scripts over (editoutput, output
 * triggers): stored as the model wrote it, and finished by the commit that clears
 * the mark. Null is every other turn.
 */
export type MessageScriptState = 'pending';

// The first-class unit. A plot is what is created and chatted with — RisuAI's
// character, or its group; its characters are structured sub-entities of it.
// A card's scripts rewrite these rows themselves (apps/api/src/scriptState.ts),
// as RisuAI's rewrite the character object.
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
    // The card's tags, as an import brings them and an export carries them (max 10, 20 chars).
    tags: text('tags').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// A member of a plot's roster, and nothing on its own: it has no owner, because
// that question is the plot's to answer and every read joins through it. `card`
// is the import container the whole NormalizedCard round-trips through; the
// editor writes only the subset (name/intro/description/personality/mesExample)
// it exposes, and a card's scripts the fields they rewrite (`scriptState.ts`).
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('plot_assets_plot_id_slug_key').on(t.plotId, t.slug)],
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

// A reader's own prompt preset, which replaces the built-in one on a chat that
// picks it: RisuAI's `botPreset`, the fields that make the prompt (@shizue/core
// `PromptPreset`, `readerPromptPreset`). Account-level, picked per chat
// (`chats.reader_preset_id`). Lengths capped by the API.
export const readerPresets = pgTable(
  'reader_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // RisuAI's `mainPrompt`.
    main: text('main').notNull().default(''),
    globalNote: text('global_note').notNull().default(''),
    jailbreak: text('jailbreak').notNull().default(''),
    // RisuAI's `formatingOrder`; null for its default.
    formatingOrder: jsonb('formating_order').$type<string[]>(),
    // RisuAI's prompt template; null for none, where the three texts and the order are the prompt.
    promptTemplate: jsonb('prompt_template').$type<unknown[]>(),
    // RisuAI's group chat settings: how another member's message is sent.
    groupTemplate: text('group_template').notNull().default(''),
    groupOtherBotRole: text('group_other_bot_role').notNull().default('user'),
    // RisuAI's preset toggles (`customPromptTemplateToggle`): drawn first among a
    // chat's toggles while the preset is the chat's, in RisuAI's toggle syntax.
    toggles: text('toggles').notNull().default(''),
    // RisuAI's `moduleIntergration`: a comma list of namespaces (or ids) whose
    // library modules a chat on this preset turns on.
    moduleIntegration: text('module_integration').notNull().default(''),
    // RisuAI's `templateDefaultVariables`, in its `key=value` lines: what a chat on
    // this preset reads for a variable nothing set and its card has no default for.
    defaultVariables: text('default_variables').notNull().default(''),
    // RisuAI's `promptSettings` (`sendName`, `sendChatAsSystem`, …); null for every one off.
    promptSettings: jsonb('prompt_settings').$type<object>(),
    // RisuAI's preset regex (`presetRegex`, saved as the preset's `regex`): scripts
    // in the card scripts' shape, run ahead of the card's own; null for none.
    regex: jsonb('regex').$type<unknown[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reader_presets_user_id_idx').on(t.userId)],
);

// A RisuAI module in a reader's own library — RisuAI's `db.modules`. Kept whole
// as a work keeps one (`PlotModule`, its `assets` empty: its pictures are its own,
// `assets` here, under `reader-modules/` and served to its owner alone). On for
// every chat of theirs while `enabled_globally` (RisuAI's `enabledModules`), on
// every chat of a work `plot_ids` lists (RisuAI's character `modules`), on the
// chats that list it (`chats.modules`), and on a chat whose reader preset names
// its namespace (RisuAI's `moduleIntergration`). A module on a chat runs after
// the work's own modules, the library's in the order it was filled (`created_at`)
// — RisuAI orders the modules on a chat by its library, never by the list that
// turned one on. Never written into the work. Sizes capped by the API.
export const readerModules = pgTable(
  'reader_modules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    module: jsonb('module').$type<PlotModule>().notNull(),
    assets: jsonb('assets').$type<ReaderModuleAsset[]>().notNull().default([]),
    enabledGlobally: boolean('enabled_globally').notNull().default(false),
    // The works whose every chat of this reader's runs it — RisuAI's character
    // `modules`, the reader's side of it. Null is none; a gone plot matches nothing.
    plotIds: jsonb('plot_ids').$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reader_modules_user_id_idx').on(t.userId, t.createdAt)],
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
    // The model presets this chat runs on (PocketRisu's binding): `main` its own
    // turns, `sub` the side work — card scripts' auxiliary calls, the memory's
    // summaries and facts, emotion, translation, suggestions. A slot left out or
    // null follows the owner's default (`user.model_binding`), and an open sub
    // runs on the main. Null is both open. Ids of the owner's `model_presets`,
    // which the API checks on the way in; a preset's delete clears them.
    modelBinding: jsonb('model_binding').$type<ModelBinding>(),
    // Author's note: per-chat instruction injected into the history, by default
    // four messages from its end (`AUTHOR_NOTE_DEPTH`).
    note: text('note').notNull().default(''),
    // Where and how often the note goes in — SillyTavern's depth, frequency and
    // role (`AuthorNoteSettings`). Null, and any key left out, is the default.
    noteSettings: jsonb('note_settings').$type<AuthorNoteSettings>(),
    // The reader's language mode for this chat (`ChatTranslationSettings`): off,
    // a reply-language instruction, or RisuAI's translation. Null decides it by
    // the plot's language against the reader's.
    translation: jsonb('translation').$type<ChatTranslationSettings>(),
    // Whether the chat's earlier messages are searched by meaning and brought back
    // into the prompt — SillyTavern's chat vectorization (`ChatRetrievalSettings`).
    // Null is off, as in ST.
    retrieval: jsonb('retrieval').$type<ChatRetrievalSettings>(),
    // Built-in prompt preset id (see @shizue/core presets); unknown values — the
    // five style presets that were — fall back to the default.
    preset: text('preset').notNull().default('default'),
    // The reader's own preset, which replaces the built-in one; null keeps it.
    // Always one of the chat owner's, which the API checks on the way in and
    // again when it reads it.
    readerPresetId: uuid('reader_preset_id').references(() => readerPresets.id, { onDelete: 'set null' }),
    // Leaf of the currently selected branch. Intentionally unconstrained to avoid a
    // circular FK with messages.chat_id.
    headMessageId: uuid('head_message_id'),
    // Memory tuning for this chat; null means every pipeline default.
    memorySettings: jsonb('memory_settings').$type<ChatMemorySettings>(),
    // Bumped by every event that can invalidate the memory layer (an edit, a
    // hide or a delete of a message). A background summary is written only if
    // it still matches.
    memoryRevision: integer('memory_revision').notNull().default(0),
    // How a reply's emotion picture is chosen (`EmotionProcessor`, RisuAI's
    // `emotionProcesser`): null is the default, the auxiliary model.
    emotionProcessor: text('emotion_processor').$type<EmotionProcessor>(),
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
    // Set when the conversation came from another app's chat file (SillyTavern's
    // JSONL), null when it was started here. The hash is what a second run of the
    // same import recognizes it by.
    importedFrom: jsonb('imported_from').$type<ImportProvenance>(),
    // True while an import is still writing the history in batches. Nothing but
    // the import may write to the chat until it is finished.
    importing: boolean('importing').notNull().default(false),
    // RisuAI's chat `localLore`: the entries a card's Lua upserted
    // (`upsertLocalLoreBook`), which belong to this chat alone and are activated
    // after the scripted member's own lore. Null until a script writes one. Per
    // chat, not per branch: a swipe does not undo it.
    localLore: jsonb('local_lore').$type<LoreEntry[]>(),
    // RisuAI's chat `modules`: the reader's library modules (`reader_modules` ids)
    // turned on for this chat alone. Null is none. An id whose module is gone
    // matches nothing; the API keeps the list to the chat owner's own.
    modules: jsonb('modules').$type<string[]>(),
    // RisuAI's "Local Toggles" (`useLocallySetGlobalVariables`): while on, the
    // toggles set in this chat's settings are kept in `local_global_variables`
    // rather than in the reader's globals on the work. Whatever that map holds
    // (non-empty, not 'null') is read over the globals in this chat, on or off,
    // as RisuAI's `getGlobalChatVar` reads `GLGlobalVariables`.
    localToggles: boolean('local_toggles').notNull().default(false),
    localGlobalVariables: jsonb('local_global_variables').$type<Variables>(),
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
    // What SillyTavern kept beside a message it brought in (`extra`), null on
    // every other. `display_text` is shown in place of the text — ST's
    // translation, which the prompt never reads — and goes when the reader
    // edits the message, as ST's does. `reasoning` is the model's thinking,
    // shown folded above the text and not sent, as ST sends none by default.
    // `bias` is ST's `{{bias}}`, shown under the reader's turn it was written on.
    displayText: text('display_text'),
    reasoning: text('reasoning'),
    bias: text('bias'),
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
    // A text file's own name (`text/plain` rows only, which only a SillyTavern
    // chat import brings: ST's attached files, whose text it folds into every
    // prompt that sends the message). Null for every picture.
    name: text('name'),
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
// `turn_from`/`turn_to` are the turns (rounds, `roundCount`) its first and last
// message close, as the branch stood when it was written — a message's turn
// never changes, since a delete takes the messages under it too. Null on the
// summaries written before they were kept; the memory reads a summary's turns
// off the branch it applies to, so nothing depends on them.
// `scene_member_ids` are the members on the stage of a group work's batch — who
// speaks in it (@shizue/core `sceneMembers`) — which its facts carry on. Null
// for a work of one, a batch nobody spoke in, and the summaries from before
// scenes were kept: known to every member.
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
    turnFrom: integer('turn_from'),
    turnTo: integer('turn_to'),
    sceneMemberIds: uuid('scene_member_ids').array(),
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

// Aliases the auxiliary model wrote for a lore entry whose keys a reader of another
// language never types (@shizue/core `loreAliases.ts`): derived data, kept apart from
// the entry so no export, editor or card ever carries it. Keyed by a hash of what they
// were made from — the entry's keys and content, and a selective entry's secondary keys
// (`aliasSourceText`) — so an edited entry is asked again and its old row goes on the
// next pass. `aliases` is the list for the entry's keys, or, where its secondary keys
// were asked about too, `{keys, secondary}` (`LoreAliases`). An entry the model gave
// nothing for keeps an empty row and is not asked again. `language` is the language
// they are in, only Korean so far; `model` is the auxiliary model that wrote them.
export const loreEntryAliases = pgTable(
  'lore_entry_aliases',
  {
    plotId: uuid('plot_id')
      .notNull()
      .references(() => plots.id, { onDelete: 'cascade' }),
    sourceHash: text('source_hash').notNull(),
    language: text('language').$type<ContentLanguage>().notNull(),
    aliases: jsonb('aliases').$type<string[] | LoreAliases>().notNull().default([]),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.plotId, t.sourceHash, t.language] })],
);

// A message split as SillyTavern's chat vectorization splits it (`retrievalChunks`,
// 400 characters), each piece embedded, for the chat's retrieval. `content_hash` is
// the message's text when it was embedded: a row whose hash is not the message's any
// more is stale — the text was edited — and is neither searched nor kept. `model` as
// in `chat_summary_chunks`.
export const messageChunks = pgTable(
  'message_chunks',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    contentHash: text('content_hash').notNull(),
    content: text('content').notNull(),
    model: text('model').notNull(),
    embedding: anyVector('embedding').notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.chunkIndex] })],
);

// A message translated for display, per language the reader reads it in
// (RisuAI's LLM translation cache, `LLMCacheStorage`). `texts` maps each text the
// display asked about to its translation. `content_hash` is the message's
// content when they were made: a row whose hash is not the message's any more is
// stale — the text changed — and is neither served nor kept.
export const messageTranslations = pgTable(
  'message_translations',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    language: text('language').$type<ContentLanguage>().notNull(),
    contentHash: text('content_hash').notNull(),
    texts: jsonb('texts').$type<Record<string, string>>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.language] })],
);

// The chat's facts (ARCHITECTURE §7.3 사실): up to eight durable ones — names,
// promises, preferences, relationships, important objects — a separate call of
// the auxiliary model takes from the messages a summary covers, right after it
// is written. Each belongs to that summary (`summary_id`), so it applies where
// the summary applies and goes with it: an edit, a hide or a delete of a covered
// message, or the reader deleting the summary. `model` is the embedder's id for
// `embedding`; a fact without a vector of the plot's model is embedded again by
// the next refresh, as a summary's chunks are.
//
// A later extraction may find that a fact no longer holds: it is never deleted
// for that, but kept as no longer holding (`invalidated_by_summary_id`, the
// summary whose messages showed it, and `invalidated_turn`, that summary's last
// turn), with the fact that took its place where there is one
// (`superseded_by_id`). It no longer holds on a branch that summary applies to,
// and holds again once that summary is gone. A fact whose own summary goes while
// the one that ended it stays moves to that one (`summary_id`), so the stretch
// summarized again does not bring it back. `turn_from`/`turn_to` are the turns
// its summary covered when it was extracted; null on older facts.
//
// In a group work a fact is known to the members on its summary's stage
// (`scene_member_ids`, copied from the summary when it is extracted, so a fact
// that moves to the summary that ended it keeps its own), unless the extraction
// marked it as one everyone knows (`known_to_all`). A member's turn is told only
// the facts it may know; null members, as on the summary, are known to all.
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
    summaryId: uuid('summary_id')
      .notNull()
      .references(() => chatSummaries.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    model: text('model'),
    embedding: anyVector('embedding'),
    turnFrom: integer('turn_from'),
    turnTo: integer('turn_to'),
    invalidatedBySummaryId: uuid('invalidated_by_summary_id').references(() => chatSummaries.id, {
      onDelete: 'set null',
    }),
    invalidatedTurn: integer('invalidated_turn'),
    supersededById: uuid('superseded_by_id'),
    sceneMemberIds: uuid('scene_member_ids').array(),
    knownToAll: boolean('known_to_all').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('memories_chat_id_idx').on(t.chatId),
    index('memories_summary_id_idx').on(t.summaryId),
    // What a summary's or a fact's delete walks to let go of the facts it ended; only those few are in them.
    index('memories_invalidated_by_idx').on(t.invalidatedBySummaryId).where(sql`${t.invalidatedBySummaryId} is not null`),
    index('memories_superseded_by_idx').on(t.supersededById).where(sql`${t.supersededById} is not null`),
    foreignKey({ columns: [t.supersededById], foreignColumns: [t.id] }).onDelete('set null'),
  ],
);

// Reusable author's notes, owned by the account rather than by one chat. The
// length cap (2,000 characters) is enforced by the API.
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

// Notes attached to a chat, injected into the author's note slot.
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

// Global variables: the work's own values, shared by every chat on it — RisuAI's
// `getglobalvar`, SillyTavern's `{{getglobalvar}}`. Not branch-scoped, unlike
// chat variables: a swipe does not take one back. Capped in keys and size by the
// API (see `scriptState.ts`).
export const plotReaderVariables = pgTable('plot_reader_variables', {
  plotId: uuid('plot_id')
    .primaryKey()
    .references(() => plots.id, { onDelete: 'cascade' }),
  variables: jsonb('variables').$type<Variables>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Work a request handed off rather than did. A row is written inside the caller's
 * own transaction — that is the whole point of the queue living in Postgres: the
 * enqueue commits with the write that caused it, or neither of them happens.
 *
 * `locked_at` is a lease and not a lock. A worker that dies mid-job — the app
 * stopped under it — leaves one standing, and the claim takes over anything
 * older than two minutes.
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

/** What an uploaded file is imported as: a new plot, one more member of a plot, a module of a plot, a module of the reader's library. */
export type FileImportTarget = 'plot' | 'member' | 'plot_module' | 'reader_module';
/**
 * `uploading` while the browser sends the parts, `queued` once they are joined
 * and the job is waiting, `processing` while the job reads and writes, then
 * `done` or `failed` — or `abandoned`, an upload nobody finished.
 */
export type FileImportStatus = 'uploading' | 'queued' | 'processing' | 'done' | 'failed' | 'abandoned';

/** What the reader sent beside the file, for the job to act on as the old form fields were. */
export interface FileImportOptions {
  /** The RisuRealm page the card came from, in its one spelling. */
  sourceUrl?: string;
  /** The reader's yes to a module that asks for low-level access. */
  confirmLowLevelAccess?: boolean;
  /** A World Info file came with the card, kept beside it in the store (`imports/<id>/world-info`). */
  worldInfo?: boolean;
}

/** One reason an import left something of the file behind, and how much (`importWarnings`). */
export interface FileImportWarning {
  code: string;
  count: number;
}

/** What a finished import made, for the status to answer with the same body the old routes did. */
export interface FileImportResult {
  plotId?: string;
  characterId?: string;
  readerModuleId?: string;
  importWarnings: FileImportWarning[];
  /** The default variables the work already had another value for (a member import). */
  variableConflicts?: string[];
}

/** Why an import failed, as the API's error body says it. */
export interface FileImportError {
  status: number;
  code: string;
  message: string;
}

/**
 * The rows a running import has made, so a failure — or a worker that died
 * under it — can take them back; the objects it stored are `file_import_keys`.
 * Set (if only to `{}`) from the import's first write: an attempt that finds it
 * set knows the one before it died writing.
 */
export interface FileImportWritten {
  plotId?: string;
  characterId?: string;
  moduleId?: string;
  readerModuleId?: string;
}

/**
 * Card and module files a reader imports (`apps/api/src/fileImports.ts`,
 * ARCHITECTURE §10 파일 임포트). The browser uploads the file straight into the
 * store in parts — never through the web or the API's body — and a job reads it
 * back; this row is the import from the first request to the answer the page
 * polls for. `upload_id` names the store's multipart upload while it is open;
 * `staged` says whether the uploaded file may still be in the store under
 * `imports/<id>/`, until the import has read it or given it up.
 */
export const fileImports = pgTable(
  'file_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    target: text('target').$type<FileImportTarget>().notNull(),
    /** The plot a member or module goes into; set null if it is deleted first, which fails the import. */
    plotId: uuid('plot_id').references(() => plots.id, { onDelete: 'set null' }),
    fileName: text('file_name').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    partSize: integer('part_size').notNull(),
    options: jsonb('options').$type<FileImportOptions>().notNull().default({}),
    uploadId: text('upload_id'),
    staged: boolean('staged').notNull().default(true),
    status: text('status').$type<FileImportStatus>().notNull().default('uploading'),
    /** Where a running import is (`reading`, `assets`, `localizing`, `saving`), and how far, for the page. */
    stage: text('stage'),
    progress: jsonb('progress').$type<{ done: number; total: number }>(),
    result: jsonb('result').$type<FileImportResult>(),
    error: jsonb('error').$type<FileImportError>(),
    written: jsonb('written').$type<FileImportWritten>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Touched by every step the browser or the job takes, which is how a stalled one is told. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('file_imports_user_id_idx').on(t.userId, t.status),
    index('file_imports_status_idx').on(t.status, t.updatedAt),
  ],
);

/**
 * The objects a running import stored, each recorded before it is written, for
 * a failure to delete (`FileImportWritten`). A row each rather than a list on
 * the import, so recording the thousandth picture costs what the first did.
 */
export const fileImportKeys = pgTable(
  'file_import_keys',
  {
    importId: uuid('import_id')
      .notNull()
      .references(() => fileImports.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.importId, t.key] })],
);

export type FileImport = typeof fileImports.$inferSelect;
export type Plot = typeof plots.$inferSelect;
export type NewPlot = typeof plots.$inferInsert;
export type Character = typeof characters.$inferSelect;
export type NewCharacter = typeof characters.$inferInsert;
export type PlotAsset = typeof plotAssets.$inferSelect;
export type NewPlotAsset = typeof plotAssets.$inferInsert;
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
export type MessageTranslation = typeof messageTranslations.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type UserNote = typeof userNotes.$inferSelect;
export type NewUserNote = typeof userNotes.$inferInsert;
export type ChatNoteLink = typeof chatNoteLinks.$inferSelect;
export type PlotReaderVariables = typeof plotReaderVariables.$inferSelect;
export type ReaderModule = typeof readerModules.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
