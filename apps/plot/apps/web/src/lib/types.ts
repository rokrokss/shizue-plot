import type {
  AssetUnlock,
  AssetUnlockKind,
  ChoicesMode,
  ComponentCapability,
  DisplayScript,
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
} from '@shizue/core';

export type {
  AssetUnlock,
  AssetUnlockKind,
  ChoicesMode,
  ComponentCapability,
  DisplayScript,
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
export const MAX_INTRO_TEXT_LENGTH = 4000;
export const MAX_INTRO_LENGTH = 500;
/** One card file an import takes; mirrors `MAX_CARD_IMPORT_BYTES` in apps/api. */
export const MAX_CARD_IMPORT_BYTES = 50 * 1024 * 1024;

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
  language: ContentLanguage;
  visibility: string;
  /** 'adult' only on rows saved before the level was disabled; those stay unlisted. */
  safetyLevel: SafetyLevel;
  /** The creator's comment switch; a closed section hides what is already there. */
  commentsEnabled: boolean;
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
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /api/plots/:id — the plot, its roster and its comment count. The
 * listings are card grids, so only the owner view carries the count.
 */
export interface PlotDetail extends Plot {
  characters: PlotMember[];
  commentCount: number;
}

/** A member as every public surface names one: a face and a name. */
export interface PublicMember {
  id: string;
  name: string;
  avatarUrl: string | null;
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
  defaultVariables: Record<string, string>;
  /** The Layer 2 module, for the same reason. '' when the plot has none. */
  componentCode: string;
  /** What its components may ask the chat for; empty grants nothing. */
  componentCapabilities: ComponentCapability[];
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

/** Rolling summary of the turns that fell out of the context budget. */
export interface ChatMemory {
  summary: string;
  anchorMessageId: string;
  updatedAt: string;
}

/** Mirrors the whitelists in packages/db — also the order the selects use. */
export const MEMORY_CONTEXT_BUDGETS = [8000, 16000, 32000] as const;
export const MEMORY_SUMMARY_THRESHOLDS = [0.4, 0.6, 0.8] as const;
export const MEMORY_RETRIEVAL_COUNTS = [0, 3, 5, 10] as const;

/** Per-chat memory tuning; a missing key means the server-side default. */
export interface ChatMemorySettings {
  contextBudget?: number;
  summaryThreshold?: number;
  retrievalCount?: number;
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
  /** Author's note, injected four messages from the end of the history. */
  note: string;
  /** Prompt preset id, one of the ids GET /api/presets lists. */
  preset: string;
  headMessageId: string | null;
  memory: ChatMemory | null;
  /** Null while the chat runs on every pipeline default. */
  memorySettings: ChatMemorySettings | null;
  relationship: ChatRelationship | null;
  relationshipEnabled: boolean;
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
 * posts a message first; the other four act on the branch as it stands.
 */
export type StreamMode = 'send' | 'regenerate' | 'continue' | 'auto' | 'narrate';

export type MessageRole = 'user' | 'assistant';

/** Who put a user turn in the chat; mirrors messages.source in packages/db. */
export type MessageSource = 'user' | 'component';

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
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Images sent with the turn; empty on all but a few of them. */
  attachments: ChatAttachment[];
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
