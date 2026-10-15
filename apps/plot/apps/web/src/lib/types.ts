import type {
  AssetUnlock,
  AssetUnlockKind,
  AuthorNoteSettings,
  ChatTranslationSettings,
  ChoicesMode,
  ComponentCapability,
  DisplayScript,
  EmotionImage,
  EmotionMode,
  EmotionProcessor,
  GroupSettings,
  HypaV3Settings,
  ImportProvenance,
  LoreEntry,
  LoreRole,
  LoreSelectiveLogic,
  NarrativeDelivery,
  NarratorConfig,
  NarratorPov,
  NormalizedCard,
  ReplyLength,
  PlotCustomUi,
  PlotDifficulty,
  PlotMood,
  PlotPacing,
  PlotProfile,
  PlotStyle,
  PlotTense,
  PromptBlockKind,
  PromptReport,
  StorytellingStyle,
  UnlockAxis,
  VariableDelta,
  Variables,
} from '@shizue/core';

export type {
  AssetUnlock,
  AssetUnlockKind,
  ChoicesMode,
  ComponentCapability,
  DisplayScript,
  EmotionImage,
  EmotionMode,
  EmotionProcessor,
  GroupSettings,
  ImportProvenance,
  LoreEntry,
  LoreRole,
  LoreSelectiveLogic,
  NarrativeDelivery,
  NarratorConfig,
  NarratorPov,
  NormalizedCard,
  ReplyLength,
  PlotCustomUi,
  PlotDifficulty,
  PlotMood,
  PlotPacing,
  PlotProfile,
  PlotStyle,
  PlotTense,
  PromptBlockKind,
  PromptReport,
  StorytellingStyle,
  UnlockAxis,
  Variables,
};

/**
 * Mirrors the option lists in @shizue/core — also the order every picker offers them
 * in. Mirrored rather than imported for the same reason the caps below are: the
 * arrays live in the core index, and pulling that into the browser bundle for
 * nine string lists would bring the card parser and the tokenizer with it.
 */
export const PLOT_TENSES = ['past', 'present'] as const satisfies readonly PlotTense[];
export const REPLY_LENGTHS = [
  'short',
  'medium',
  'long',
  'auto',
] as const satisfies readonly ReplyLength[];
export const NARRATIVE_DELIVERIES = [
  'dialogue',
  'balanced',
  'action',
] as const satisfies readonly NarrativeDelivery[];
export const PLOT_PACINGS = ['fast', 'natural', 'slow'] as const satisfies readonly PlotPacing[];
export const PLOT_DIFFICULTIES = [
  'easy',
  'normal',
  'hard',
  'nightmare',
] as const satisfies readonly PlotDifficulty[];
export const PLOT_MOODS = [
  'romance',
  'healing',
  'angst',
  'yandere',
  'fantasy',
  'action',
  'mystery',
  'horror',
] as const satisfies readonly PlotMood[];
export const STORYTELLING_STYLES = [
  'highSociety',
  'noir',
  'afterDark',
  'nostalgia',
  'blockbuster',
  'arcane',
  'manga',
  'dread',
] as const satisfies readonly StorytellingStyle[];
export const CHOICES_MODES = ['off', 'keywords', 'sentences'] as const satisfies readonly ChoicesMode[];
export const UNLOCK_AXES = [
  'affection',
  'obsession',
  'trust',
  'liking',
  'disgust',
  'fear',
] as const satisfies readonly UnlockAxis[];
export const ASSET_UNLOCK_KINDS = [
  'keyword',
  'turns',
  'relationship',
] as const satisfies readonly AssetUnlockKind[];
export const LORE_SELECTIVE_LOGICS = [
  'and_any',
  'and_all',
  'not_any',
  'not_all',
] as const satisfies readonly LoreSelectiveLogic[];

/** How many moods one plot may aim for at once; mirrors @shizue/core. */
export const MAX_PLOT_MOODS = 2;

/** The caps the profile editor writes under; mirror @shizue/core's coercion. */
export const MAX_PLOT_PROFILES = 5;
export const MAX_PLOT_PROFILE_NAME_LENGTH = 30;
export const MAX_PLOT_PROFILE_DESCRIPTION_LENGTH = 1000;

/** The same, for an asset's unlock condition. */
export const MAX_UNLOCK_KEYWORDS = 5;
export const MAX_UNLOCK_KEYWORD_LENGTH = 30;
export const MAX_UNLOCK_TURNS = 500;
export const MAX_UNLOCK_RELATIONSHIP = 100;

export type ContentLanguage = 'ko' | 'en' | 'ja';

/** Audience a plot declares on publish; mirrors packages/db. */
export type SafetyLevel = 'all' | 'adult';

/** Roster size and openings a plot may hold; mirrors the caps in apps/api. */
export const MAX_CHARACTERS_PER_PLOT = 10;
export const MAX_INTROS_PER_PLOT = 10;
/** One opening's length, and the reader-facing intro's; mirrors the API. */
export const MAX_INTRO_TEXT_LENGTH = 400_000;
export const MAX_INTRO_LENGTH = 4000;
/** The longest background a plot carries; mirrors `MAX_BACKGROUND_HTML_LENGTH` in @shizue/core. */
export const MAX_BACKGROUND_HTML_LENGTH = 400_000;
/**
 * What drawing the background may spend: the source and what its CBS makes of
 * it, charged together before each step, and the markup that comes out. Its own
 * rather than a message's (`MAX_RENDER_INPUT_CHARS`): a work's background may be
 * as long as a plot carries one, and it is drawn behind the whole chat rather
 * than once per message. At the half microsecond a charged character costs
 * (`displayScripts.ts`), the longest is under half a second; RisuRealm's
 * backgrounds past their stylesheets run to a few thousand characters.
 */
export const MAX_BACKGROUND_RENDER_CHARS = 2 * MAX_BACKGROUND_HTML_LENGTH;
/** One card file an import takes; mirrors `MAX_CARD_IMPORT_BYTES` in @shizue/core. */
export const MAX_CARD_IMPORT_BYTES = 1024 * 1024 * 1024;

/**
 * A plot as its owner edits it. The first-class row: everything a work is
 * published, explored, liked, commented and chatted with by.
 */
export interface Plot {
  id: string;
  name: string;
  /** What readers are told; '' when the creator wrote none. Never sent to the model. */
  intro: string;
  /** The setting the model is told. */
  description: string;
  /** URL served by the API, or null when the plot has no cover. */
  coverUrl: string | null;
  lorebook: LoreEntry[];
  /** The openings a reader picks between; every one becomes a root of the chat. */
  intros: string[];
  /** The plot's narrator; null when the creator set neither field. */
  narrator: NarratorConfig | null;
  /** How the creator wants it written; null while every option is left alone. */
  style: PlotStyle | null;
  /** The reader profiles the work recommends; empty until one is written. */
  profiles: PlotProfile[];
  /** Display scripts, variable seeds and the component module the work shares. */
  customUi: PlotCustomUi | null;
  /** The RisuAI modules brought into the work, which the server keeps apart from `customUi`. */
  modules: PlotModuleSummary[];
  language: ContentLanguage;
  visibility: string;
  /** 'adult' only on rows saved before the level was disabled; those stay unlisted. */
  safetyLevel: SafetyLevel;
  /** The creator's comment switch; a closed section hides what is already there. */
  commentsEnabled: boolean;
  /**
   * How a round of a work of two or more members is picked: the order and the
   * cap. The API fills the defaults in, so it is always whole.
   */
  groupSettings: GroupSettings;
  tags: string[];
  likeCount: number;
  chatCount: number;
  publishedAt: string | null;
  /** When the owner last vouched for the imported members; null until then. */
  rightsConfirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A member of the roster, as its own creator sees it: the whole card. */
export interface PlotMember {
  id: string;
  name: string;
  card: NormalizedCard;
  /** URL served by the API, or null when the member has no avatar. */
  avatarUrl: string | null;
  orderIndex: number;
  /** Where an imported card came from; null for a member the studio made. */
  importedFrom: ImportProvenance | null;
  /** The license the card declares (`extensions.risuai.license`); null when it says none. */
  license: string | null;
  /** Tokens the card lorebook's always-on entries take, counted by the server from the saved card. */
  loreConstantTokens: number;
  /** 대화량, 0..100: how readily the member joins a round unprompted. 0 is only when picked. */
  talkativeness: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /api/plots/:id — the plot, its roster and its comment count. The
 * listings are card grids, so only the owner view carries the count.
 */
/**
 * A RisuAI module in a work, as the studio lists it (`POST /api/plots/:id/modules`):
 * what it is and how much it brought, not its scripts.
 */
export interface PlotModuleSummary {
  id: string;
  name: string;
  description: string;
  loreCount: number;
  regexCount: number;
  triggerCount: number;
  displayScriptCount: number;
  assetCount: number;
  /** It draws a stylesheet or a background behind the chat. */
  background: boolean;
  lowLevelAccess: boolean;
  /** It brings triggers or input/output scripts the reader's browser runs. */
  scripts: boolean;
  /** RisuAI's `hideIcon`: the chats it is on show no sender picture or name. */
  hideIcon?: boolean;
  /** An MCP server or `cjs` code it carries, kept and never connected to or run. */
  inert?: ModuleInert;
  importedFrom: { fileName: string; sha256: string; importedAt: string };
}

/** What of RisuAI's MCP and `cjs` a module carries (`PlotModule.inert` in @shizue/core). */
export interface ModuleInert {
  /** The MCP server's address, '' where the module names none. */
  mcp?: string;
  cjs?: true;
}

export interface PlotDetail extends Plot {
  characters: PlotMember[];
  /**
   * What the chat draws behind the work today: its own background where it has
   * one, else the scripted card's (`PublicPlotDetail.backgroundHtml`) — what the
   * studio's background field starts from.
   */
  backgroundHtml?: string;
  commentCount: number;
  /** Tokens the plot lorebook's always-on entries take, counted from the saved plot. */
  plotLoreConstantTokens: number;
}

/** A member as every public surface names one: a face and a name. */
export interface PublicMember {
  id: string;
  name: string;
  avatarUrl: string | null;
  /**
   * The card's nickname, which RisuAI's `{{char}}` is where a card sets one — so
   * the model may write the member's lines under it. Null when the card has none.
   */
  nickname?: string | null;
  /**
   * Other names the member's lines go by on this screen: the name it had before
   * its card's scripts renamed it in this chat (Lua's `setName`). The chat page
   * sets it; the API never sends it.
   */
  aliases?: readonly string[];
  /**
   * 대화량, 0..100, which the reader's browser picks a round's speakers by. The
   * public view fills the default in; optional for a member built by hand.
   */
  talkativeness?: number;
  /**
   * How the member's emotion pictures are shown — beside the chat (`panel`) or
   * in its replies (`inlay`) — and which they are, by the card's names and the
   * plot's slugs. Null when it shows none; absent outside the plot's own page.
   */
  emotion?: { mode: EmotionMode; images: EmotionImage[] } | null;
}

/** The only shape a non-owner ever sees of a plot: no definitions. */
export interface PublicPlot {
  id: string;
  name: string;
  coverUrl: string | null;
  creatorId: string;
  creatorName: string;
  language: ContentLanguage;
  tags: string[];
  likeCount: number;
  chatCount: number;
  /** The creator's line to readers; '' when they wrote none. Never sent to the model. */
  intro: string;
  /** First opening, cut by the API. Macros are already stripped. */
  introPreview: string;
  publishedAt: string | null;
  likedByMe: boolean;
  /** The face stack a plot card is read by. */
  characters: PublicMember[];
}

/**
 * GET /api/plots/:id/public — the same plot as the detail read carries it.
 * The listings live on `introPreview`; the page a reader decides on gets every
 * opening whole, because a prologue is meant to be read.
 */
export interface PublicPlotDetail extends PublicPlot {
  public: true;
  /** The follow edge to the creator, so the page's button needs no second read. */
  creatorFollow: FollowState;
  /** The roster, each with the one card field written for readers. */
  characters: (PublicMember & { intro: string })[];
  /** Every opening, uncut. Macros are already stripped. */
  intros: string[];
  /** The same openings, cut to 200 characters for the picker. */
  introPreviews: string[];
  commentsEnabled: boolean;
  commentCount: number;
  /**
   * The style, as enum values only: it is the badge row a reader decides on, and
   * the chat reads the two derived features off it to know which of its own
   * toggles are worth offering. Null while the creator set nothing.
   */
  style: PlotStyle | null;
  /**
   * The profiles the work recommends its readers. Reader-facing by design — the
   * start panel is where one is picked — and never prompt text of its own.
   */
  profiles: PlotProfile[];
  /**
   * The narrator, for the point of view the badge row names. Optional because the
   * public read carries it only where the API sends it — the rest of the narrator
   * is prompt text and never leaves the owner's view.
   */
  narrator?: NarratorConfig | null;
  /** Presentation, so it travels even though the definitions do not. */
  displayScripts: DisplayScript[];
  /** The stylesheet the scripts' markup is drawn with; '' when the plot has none. */
  css: string;
  /**
   * Each member's own stylesheet in a work of several, by member id
   * (`PlotCustomUi.memberCss`), for that member's messages. Optional for a
   * detail built by hand.
   */
  memberCss?: Record<string, string>;
  /**
   * What is drawn behind the chat: the work's own background
   * (`PlotCustomUi.backgroundHtml`), or — on a plot from before it — the
   * scripted card's `backgroundHTML` past the stylesheet above; '' when there is
   * nothing to draw. Optional for a detail built by hand.
   */
  backgroundHtml?: string;
  defaultVariables: Record<string, string>;
  /** The Layer 2 module, for the same reason. '' when the plot has none. */
  componentCode: string;
  /**
   * How a round's speakers are picked in a work of two or more members, which
   * the reader's browser does. Optional for a detail built by hand.
   */
  groupSettings?: GroupSettings;
  /** What its components may ask the chat for; empty grants nothing. */
  componentCapabilities: ComponentCapability[];
  /**
   * The work's RisuAI modules that have a namespace, each with the names its
   * pictures go by, for `{{moduleenabled}}` and `{{moduleassetlist}}`. Optional
   * for a detail built by hand.
   */
  modules?: { namespace: string; assets: string[] }[];
}

/** Characters one comment may hold; mirrors MAX_COMMENT_LENGTH in the API. */
export const MAX_COMMENT_LENGTH = 500;

/** A comment on a plot page; `replies` is empty on a reply itself. */
export interface Comment {
  id: string;
  /** Null on a top-level comment; replies never nest further. */
  parentId: string | null;
  /** Empty on a deleted comment — the server keeps nothing of it. */
  content: string;
  spoiler: boolean;
  deleted: boolean;
  /** Null on a deleted comment. */
  authorName: string | null;
  createdAt: string;
  /** The viewer wrote it, or owns the plot. */
  canDelete: boolean;
  replies: Comment[];
}

export interface CommentPage {
  items: Comment[];
  /** Opaque keyset cursor, or null on the last page. */
  nextCursor: string | null;
}

export interface ExploreResult {
  items: PublicPlot[];
  /** Opaque keyset cursor, or null on the last page. */
  nextCursor: string | null;
  /** With a query: whether it was searched by meaning (ranked by nearness) or as text. */
  search?: 'meaning' | 'text';
}

/** How many follow a creator, and whether the reader is one of them. */
export interface FollowState {
  followerCount: number;
  followedByMe: boolean;
}

export interface Creator extends FollowState {
  id: string;
  name: string;
  publicPlots: PublicPlot[];
}

export interface LikeState {
  liked: boolean;
  likeCount: number;
}

/** What a notification is about; mirrors the kinds in packages/db. */
export type NotificationKind = 'plot_published';

/** A plot publication notification, named by the API. */
export interface AppNotification {
  id: string;
  kind: NotificationKind;
  /** Who did it; null once that account is gone, and the name with it. */
  actorId: string | null;
  actorName: string | null;
  plotId: string | null;
  plotName: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationPage {
  items: AppNotification[];
  /** Opaque keyset cursor, or null on the last page. */
  nextCursor: string | null;
  /** Only the first page carries it — it is what the badge is read from. */
  unreadCount?: number;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  /** Its picture, served to its owner only (`/api/personas/:id/avatar`), or null. */
  avatarUrl: string | null;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Reasoning efforts the model accepts; absent where it advertises none. */
  reasoningEfforts?: string[];
  /** The effort the model runs at when the chat picks none. */
  defaultReasoningEffort?: string;
}

export interface PresetInfo {
  id: string;
}

/**
 * The reader's own preset (`GET /api/reader-presets`): what they add on top of
 * the chat's preset — a main-instruction addition and a global note. Account-level,
 * picked per chat.
 */
/**
 * A module in the reader's own library (`/api/reader-modules`), as they list it:
 * what it is and what it brought, not its scripts.
 */
export interface ReaderModuleSummary {
  id: string;
  name: string;
  description: string;
  /** On for every chat of the reader's (RisuAI's `enabledModules`). */
  enabledGlobally: boolean;
  loreCount: number;
  regexCount: number;
  triggerCount: number;
  displayScriptCount: number;
  assetCount: number;
  background: boolean;
  toggles: boolean;
  lowLevelAccess: boolean;
  scripts: boolean;
  /** RisuAI's `hideIcon`: the chats it is on show no sender picture or name. */
  hideIcon?: boolean;
  /** An MCP server or `cjs` code it carries, kept and never connected to or run. */
  inert?: ModuleInert;
  /** RisuAI's `namespace`, what a reader preset's module integration names it by. */
  namespace?: string | null;
  importedFrom: { fileName: string; sha256: string; importedAt: string };
  createdAt: string;
  /** In `GET /api/chats/:id/modules` only: whether that chat's own list names it. */
  listedHere?: boolean;
  /** In `GET /api/chats/:id/modules` only: on for every chat of that chat's work (RisuAI's character `modules`). */
  onThisWork?: boolean;
  /** In `GET /api/chats/:id/modules` only: on in that chat, by whichever list — the preset's integration too. */
  onHere?: boolean;
}

/** A library module on a chat, as the page draws it (`GET /api/chats/:id/modules` `active`). */
export interface ActiveReaderModule {
  id: string;
  name: string;
  displayScripts: DisplayScript[];
  css: string;
  backgroundHtml: string;
  namespace: string | null;
  /** Its pictures by the module's names for them, served to the reader alone. */
  assets: { id: string; name: string; url: string; mime: string }[];
}

/** GET /api/chats/:id/modules. */
export interface ChatModulesView {
  library: ReaderModuleSummary[];
  active: ActiveReaderModule[];
  /** The toggle text the chat's settings draw: the reader preset's, the modules' on the chat, then the members' own. */
  toggles: string;
  /** RisuAI's `HideIconStore`: the chat draws no message's sender picture or name. Optional for a hand-built view. */
  hideIcons?: boolean;
}

export interface ReaderPreset {
  id: string;
  name: string;
  main: string;
  globalNote: string;
  /** RisuAI's preset toggles (`customPromptTemplateToggle`), drawn first among a chat's toggles. */
  toggles: string;
  /** RisuAI's `moduleIntergration`: namespaces whose library modules a chat on it turns on. */
  moduleIntegration: string;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors the whitelist in packages/db — also the order the select uses. */
export const MEMORY_CONTEXT_BUDGETS = [8000, 16000, 32000] as const;

/**
 * Per-chat memory tuning — the context budget and RisuAI HypaV3's settings; a
 * missing key means the default (`HYPA_V3_DEFAULTS` in @shizue/core).
 */
export interface ChatMemorySettings extends Partial<HypaV3Settings> {
  contextBudget?: number;
  /** Facts a request carries (`[기억]`), 0–10; absent, 5. */
  factCount?: number;
}

/** A message one of the memory's summaries covers, as `GET /api/chats/:id/memory` lists it. */
export interface MemorySummaryMessage {
  id: string;
  role: 'user' | 'assistant';
  /** The start of its text, images left out. */
  preview: string;
  /** Its index on the chat's current branch (0: the greeting), or null where it is on another. */
  position: number | null;
}

/** One of the memory's summaries (HypaV3's), as `GET /api/chats/:id/memory` lists it. */
export interface MemorySummary {
  id: string;
  text: string;
  /** Pinned: selected before any other while it fits. */
  important: boolean;
  /** Whether it applies to the current branch — every message it covers is on it. */
  applies: boolean;
  messageIds: string[];
  /** The covered messages that still exist, in order. */
  messages: MemorySummaryMessage[];
  createdAt: string;
  updatedAt: string;
}

/** One of the facts of the summaries on the current branch, as `GET /api/chats/:id/memory` lists it. */
export interface MemoryFact {
  id: string;
  content: string;
  /** The summary it goes with: the one it was taken from, or the one that ended it. */
  summaryId: string;
  /** The turns its summary covered when it was taken; null for older facts. */
  turnFrom: number | null;
  turnTo: number | null;
  /** Ended on this branch by a later summary: kept and listed, never sent, restorable. */
  invalidated: boolean;
  /** The turn it ended at, when ended. */
  invalidatedTurn: number | null;
  /** The fact that took its place, when ended by one. */
  supersededBy: { id: string; content: string } | null;
  /** The members on the stage of the group scene it was taken in; null: known to every member. */
  knownTo: { id: string; name: string }[] | null;
  /** Marked as one every member knows, whatever scene it came from. */
  knownToAll: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Characters one note may hold; mirrors MAX_NOTE_LENGTH in the API. */
export const MAX_NOTE_LENGTH = 2000;

/** A reusable author's note, owned by the account and attachable to any chat. */
export interface UserNote {
  id: string;
  title: string;
  content: string;
  groupName: string;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors RELATIONSHIP_AXES in packages/db — also the order the gauges use. */
export const RELATIONSHIP_AXES = [
  'affection',
  'obsession',
  'trust',
  'liking',
  'disgust',
  'fear',
] as const;

export type RelationshipAxis = (typeof RELATIONSHIP_AXES)[number];

/** How the plot's characters currently feel about the user; each axis is 0-100. */
export interface ChatRelationship {
  /** Null until the first extraction succeeds. */
  axes: Record<RelationshipAxis, number> | null;
  note: string;
  updatedAt: string;
  /** Assistant messages the branch held at the last extraction attempt. */
  lastExtractedAssistantDepth: number;
}

export interface Chat {
  id: string;
  plotId: string;
  personaId: string | null;
  title: string;
  model: string;
  /**
   * The auxiliary model for scripts' auxiliary calls and the background work
   * (summaries, relationship, suggestions); null leaves it to the first model in
   * the reader's catalog.
   */
  subModel: string | null;
  /** Author's note, injected into the history at `noteSettings.depth`. */
  note: string;
  /**
   * Where the note goes and how often — SillyTavern's depth, frequency and role.
   * Optional so a state built by hand needs none; absent is the defaults.
   */
  noteSettings?: Required<AuthorNoteSettings>;
  /**
   * The reader's language mode as they chose it; a key left out is decided by
   * the plot's language against the reader's (`resolveTranslation`). Optional
   * for the same reason.
   */
  translation?: ChatTranslationSettings;
  /**
   * Whether the chat's earlier messages are searched by meaning and brought back
   * into the prompt — SillyTavern's chat vectorization. Optional for the same
   * reason; absent is off.
   */
  retrieval?: { enabled: boolean };
  /** Prompt preset id, one of the ids GET /api/presets lists. */
  preset: string;
  /** The reader's own preset on top of `preset`; null adds nothing. */
  readerPresetId: string | null;
  headMessageId: string | null;
  /** Moves with every edit, hide and delete of a message — what may drop one of the memory's summaries. */
  memoryRevision: number;
  /** Null while the chat runs on every pipeline default. */
  memorySettings: ChatMemorySettings | null;
  relationship: ChatRelationship | null;
  relationshipEnabled: boolean;
  /** How a reply's emotion picture is chosen; optional for a state built by hand, absent is `submodel`. */
  emotionProcessor?: EmotionProcessor;
  /** This chat's narrator; null leaves the plot's own in force. */
  narrator: NarratorConfig | null;
  /** Consent for the sendTurn capability, given once per chat and revocable. */
  allowComponentTurns: boolean;
  /**
   * The reader's half of the plot's two style features. Both mean something only
   * while the plot asks for the feature at all, which is why the panel offers
   * each one where the plot enables it and nowhere else.
   */
  statusWindowEnabled: boolean;
  choicesEnabled: boolean;
  /** One of the model's advertised efforts; null sends none (the model's default). */
  reasoningEffort: string | null;
  /**
   * Members the reader sent off the stage; empty while the whole roster is on.
   * May name a member that has since been deleted, which matches nobody.
   */
  absentCharacterIds: string[];
  /**
   * The reader's library modules turned on for this chat alone (RisuAI's chat
   * `modules`); one on everywhere is not listed. Optional so a state built by
   * hand needs none.
   */
  modules?: string[];
  /**
   * RisuAI's "Local Toggles": while on, the toggles set in this chat keep their
   * values to it. Optional so a state built by hand needs none.
   */
  localToggles?: boolean;
  /** Reusable notes attached to this chat, in injection order. */
  noteIds: string[];
  /**
   * True while an import (the SillyTavern move) is still writing the history in
   * batches; nothing else may write to the chat until it finishes. Optional so a
   * state built by hand needs no flag.
   */
  importing?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /api/chats — a chat plus what a list of conversations is read by. Only the
 * listing carries these; a single chat read has the plot beside it already.
 */
export interface ChatListItem extends Chat {
  /** The plot's cover, or null once it is no longer the reader's to see. */
  coverUrl: string | null;
  /** The head message, cut to a preview. null for a chat with no message yet. */
  lastMessage: string | null;
}

/**
 * How a chat asks for the next turn — the generation endpoint, by name. `send`
 * posts a message first; the others act on the branch as it stands. `reply` is
 * a work of several members' alone: the next speaker of a round, or a round of
 * its own.
 */
export type StreamMode = 'send' | 'regenerate' | 'continue' | 'auto' | 'narrate' | 'reply';

export type MessageRole = 'user' | 'assistant';

/**
 * Where a turn's text came from; mirrors messages.source in packages/db. A user
 * turn is the reader's or a component's; an assistant turn is the model's
 * (`user`) or one a card's script wrote as its character (`script`).
 */
export type MessageSource = 'user' | 'component' | 'script';

/** An image the reader attached to one of their own turns. */
export interface ChatAttachment {
  id: string;
  /** Served by the API, to this reader only. */
  url: string;
  mime: string;
  /** Intrinsic size and blurred placeholder; null together when unmeasured. */
  width: number | null;
  height: number | null;
  thumbhash: string | null;
}

export interface ChatMessage {
  id: string;
  parentId: string | null;
  role: MessageRole;
  content: string;
  source: MessageSource;
  /** The turn's stage directions, never shown as text. Null on most turns. */
  directions: string | null;
  /**
   * What the card's scripts left on the turn, laid over its macros by the
   * variable fold (`computeVariables`). Null on most turns; optional so a message
   * built by hand — a test's, a fixture's — needs none.
   */
  variableDelta?: VariableDelta | null;
  /** 'pending' while the browser still owes the turn its output scripts. */
  scriptState?: 'pending' | null;
  /** The revision a script commit to the turn has to name. */
  scriptRev?: number;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Images sent with the turn; empty on all but a few of them. */
  attachments: ChatAttachment[];
  /**
   * In a work of several members, the member a reply is wholly by (`messages.
   * speaker_member_id`), and the round it belongs to — the id of the round's
   * first reply. Null on the reader's turns, a narration's speaker, and every
   * message from before group turns; optional for a message built by hand.
   */
  speakerMemberId?: string | null;
  groupTurnId?: string | null;
  /**
   * Hidden from the AI (SillyTavern's hide): drawn dimmed and left out of what a
   * model reads. Optional for a message built by hand.
   */
  hiddenFromPrompt?: boolean;
  /**
   * What SillyTavern kept beside a message it brought in — null (or absent, for
   * a message built by hand) on every other: the text it showed in place of
   * `content`, the model's reasoning, drawn folded above the text, and the
   * reader's `{{bias}}`, drawn under their turn.
   */
  displayText?: string | null;
  reasoning?: string | null;
  bias?: string | null;
  /**
   * The name of the emotion picture the reply left its member wearing
   * (`messages.emotion`), or null while none is chosen. Optional for a message
   * built by hand.
   */
  emotion?: string | null;
  createdAt: string;
}

/** 0-based position among the messages sharing a parent. */
export interface SiblingInfo {
  index: number;
  total: number;
  /** Sibling ids in the same order as `index`, so `ids[index]` is the message. */
  ids: string[];
}

/**
 * What this chat may show of one of its plot's images: whether it is open here
 * and — while it is not — which kind of condition it waits on. The condition
 * itself never travels; the kind is the whole hint a reader gets.
 */
export interface AssetLock {
  assetId: string;
  slug: string;
  locked: boolean;
  kind: AssetUnlockKind | null;
}

/** What the deployment can do beyond the base chat. Decided by the server's env. */
export interface ChatCapabilities {
  /** Drawing a scene; off wherever no image provider is configured. */
  drawScene: boolean;
}

export interface ChatState {
  chat: Chat;
  path: ChatMessage[];
  siblings: Record<string, SiblingInfo>;
  /**
   * Whether the branch continues past the first message of `path`. Only a
   * windowed read says so; a whole-branch answer leaves it out, which reads the
   * same as false.
   */
  hasMore?: boolean;
  /**
   * The variable fold as it stood just before the first message of `path`. Only a
   * windowed read that really left messages behind carries it: the client folds
   * the loaded window onto it, so a `{{setvar}}` older than the window is not lost
   * from the display.
   */
  variableDefaults?: Variables;
  /**
   * The reader's global variables on the plot — shared by their chats on it, and
   * not by branch. Optional for the same reason as the flags below.
   */
  globalVariables?: Variables;
  /** Optional so a state built by hand — a test's, a fixture's — needs no flags. */
  capabilities?: ChatCapabilities;
  /** Every asset of the plot, locked or open. Optional for the same reason. */
  assetLocks?: AssetLock[];
  /**
   * Whether the reader is the plot's creator, the one person the assembled
   * prompt may be shown to. Optional for the same reason; absent reads as no.
   */
  isPlotOwner?: boolean;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** Characters one premise may hold; mirrors MAX_PREMISE_LENGTH in the API. */
export const MAX_PREMISE_LENGTH = 2000;

/** A member of a drafted roster, as the create endpoint takes one. */
export interface DraftCharacter {
  name: string;
  description: string;
  personality: string;
}

/**
 * POST /api/plots/draft — the fields a create takes, and no id: nothing is
 * stored until the creator posts them back as an ordinary create.
 */
export interface PlotDraft {
  name: string;
  intro: string;
  description: string;
  characters: DraftCharacter[];
  intros: string[];
  tags: string[];
}

/** POST /api/chats/:id/suggest — three things the reader could say next. */
export interface SuggestionsResult {
  suggestions: string[];
}
