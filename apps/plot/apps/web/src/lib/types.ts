import type {
  AuthorNoteSettings,
  ChatTranslationSettings,
  ChoicesMode,
  ComponentCapability,
  DisplayScript,
  EmotionImage,
  EmotionMode,
  EmotionProcessor,
  FormatOrderItem,
  GroupOtherBotRole,
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
  PromptTemplateItem,
  StorytellingStyle,
  VariableDelta,
  Variables,
} from '@shizue/core';

export type {
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

export type ContentLanguage = 'ko' | 'en' | 'ja';

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

/** A plot as the studio edits it: the first-class row, everything a work is chatted with by. */
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
  /**
   * How a round of a work of two or more members is picked: the order and the
   * cap. The API fills the defaults in, so it is always whole.
   */
  groupSettings: GroupSettings;
  tags: string[];
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
 * A RisuAI module in a work, as the studio lists it (a `plot_module` file import, `lib/fileImport`):
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
  /** Tokens the plot lorebook's always-on entries take, counted from the saved plot. */
  plotLoreConstantTokens: number;
}

/** A member as the work page and the chat name one: a face and a name. */
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
   * play view fills the default in; optional for a member built by hand.
   */
  talkativeness?: number;
  /**
   * How the member's emotion pictures are shown — beside the chat (`panel`) or
   * in its replies (`inlay`) — and which they are, by the card's names and the
   * plot's slugs. Null when it shows none; absent outside the plot's own page.
   */
  emotion?: { mode: EmotionMode; images: EmotionImage[] } | null;
}

/**
 * GET /api/plots/:id/public — the plot as it is played: what the work page and
 * the chat draw, and none of the definitions the prompt is made of. Every
 * opening is whole, because a prologue is meant to be read.
 */
export interface PublicPlotDetail {
  id: string;
  name: string;
  coverUrl: string | null;
  language: ContentLanguage;
  tags: string[];
  /** The creator's line about the work; '' when they wrote none. Never sent to the model. */
  intro: string;
  /** The roster, each with the one card field written for the reader. */
  characters: (PublicMember & { intro: string })[];
  /** Every opening, uncut. Macros are already stripped. */
  intros: string[];
  /** The same openings, cut to 200 characters for the picker. */
  introPreviews: string[];
  /**
   * The style, as enum values only: it is the badge row the work page shows, and
   * the chat reads the two derived features off it to know which of its own
   * toggles are worth offering. Null while the creator set nothing.
   */
  style: PlotStyle | null;
  /** The profiles the work recommends; the start panel is where one is picked. */
  profiles: PlotProfile[];
  /** The narrator, for the point of view the badge row names. */
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

export interface Persona {
  id: string;
  name: string;
  description: string;
  /** Its picture, served to its owner only (`/api/personas/:id/avatar`), or null. */
  avatarUrl: string | null;
  createdAt: string;
}

/** One model a provider offers, as the preset editor's picker lists it (`GET /api/model-presets/catalog`). */
export interface ModelInfo {
  id: string;
  label: string;
  /** Whether it reads pictures, where the provider says. */
  vision?: boolean;
  /** Reasoning efforts the model accepts (a ChatGPT model's catalog); absent where it advertises none. */
  reasoningEfforts?: string[];
  /** The effort the model runs at when the preset picks none. */
  defaultReasoningEffort?: string;
}

/** The sampling values a preset may set (`@shizue/llm` `MODEL_PARAMETERS`). */
export type ModelParameter =
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'minP'
  | 'topA'
  | 'repetitionPenalty'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'reasoningEffort'
  | 'thinkingTokens'
  | 'verbosity';

/** What a preset sends with every request on it; a value left out is not sent. */
export interface ModelParams extends Partial<Record<Exclude<ModelParameter, 'reasoningEffort' | 'verbosity'>, number>> {
  reasoningEffort?: string;
  verbosity?: string;
  maxTokens?: number;
  stop?: string[];
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** A text format's instruct template: a built-in's name, or `jinja` for `jinjaTemplate`. */
  instructTemplate?: string;
  jinjaTemplate?: string;
}

/** What a preset's model can take: pictures, and RisuAI's flags for a strict chat template. */
export interface ModelCapabilities {
  vision?: boolean;
  systemPrompt?: 'full' | 'first' | 'none';
  alternateRoles?: boolean;
  startWithUser?: boolean;
}

/** A model preset (`/api/model-presets`): a format, a model, its credential or a keyless address, its values. */
export interface ModelPreset {
  id: string;
  name: string;
  format: string;
  endpoint: string | null;
  model: string;
  credentialId: string | null;
  params: ModelParams;
  capabilities: ModelCapabilities;
  /** Made from a registry profile (its snapshot and values decide the request), or a custom one (absent: custom). */
  kind?: 'profile' | 'custom';
  sourceProfile?: ProfileSource | null;
  profileSnapshot?: ProfileSnapshot | null;
  /** A profile preset's values for its snapshot's fields. */
  userValues?: Record<string, unknown>;
  /** A profile preset's profile has a newer revision, or is gone from the registry. */
  profileUpdate?: 'none' | 'updatable' | 'missing';
  /** The provider whose key a profile preset takes. */
  profileProvider?: string;
  /** A profile preset's profile as the registry has it now. */
  profile?: {
    displayName: string;
    displayNameI18n?: Record<string, string>;
    description?: string;
    descriptionI18n?: Record<string, string>;
    status: ProfileStatus;
    statusReason?: string;
    updatedAt?: number;
    baseLabel: string;
  };
  /** The test runner's catalog entry, not one of the owner's. */
  builtIn?: true;
}

export type ProfileStatus = 'current' | 'outdated' | 'deprecated';

/** Which registry profile a preset was made from, and the revision it took. */
export interface ProfileSource {
  registryId: string;
  profileId: string;
  profileVersion: number;
  providerBaseVersion?: number;
  fetchedAt: number;
  profileUpdatedAt?: number;
}

/** A registry profile's request field (PocketRisu's `RegistryFieldSchema`). */
export interface ProfileField {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'json' | 'stringArray' | 'keyValue';
  label: string;
  description?: string;
  descriptionI18n?: Record<string, string>;
  default?: unknown;
  enum?: { value: string | number | boolean; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  secret?: boolean;
  mapsTo?: { target: string; path: string };
}

/** How a profile's editor draws a field (PocketRisu's `RegistryUiField`). */
export interface ProfileUiField {
  key: string;
  widget: string;
  visibility: 'basic' | 'advanced' | 'hidden';
  group?: string;
  order?: number;
  placeholder?: string;
  help?: string;
  showIf?: { key: string; equals?: unknown; notEquals?: unknown };
}

/** A profile merged over its base provider, as a preset keeps it. */
export interface ProfileSnapshot {
  profileId: string;
  providerBaseId: string;
  modelId: string;
  schema: ProfileField[];
  uiSchema: { groups: { id: string; label: string; labelI18n?: Record<string, string>; order?: number }[]; fields: ProfileUiField[] };
  capabilities?: string[];
  limits?: { contextWindowTokens?: number; maxOutputTokens?: number };
}

/** A registry profile this app offers (`GET /api/model-presets/registry`). */
export interface RegistryProfile {
  id: string;
  displayName: string;
  displayNameI18n?: Record<string, string>;
  description?: string;
  descriptionI18n?: Record<string, string>;
  status: ProfileStatus;
  statusReason?: string;
  sortOrder?: number;
  updatedAt?: number;
  modelId: string;
  baseId: string;
  baseLabel: string;
  /** The provider whose key a preset on it takes. */
  provider: string;
  format: string;
  capabilities: string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

/** The registry the app reads, and where it came from. */
export interface ModelRegistry {
  origin: 'bundled' | 'remote';
  source: string | null;
  hash: string | null;
  fetchedAt: string | null;
  refreshable: boolean;
  profiles: RegistryProfile[];
}

/** Which presets a chat runs on, or the owner's default (`/api/model-binding`); null follows the default. */
export interface ModelBinding {
  main: string | null;
  sub: string | null;
}

/** An API key, AWS keys, a service account or the ChatGPT connection (`/api/credentials`) — never its secret, only a masked hint. */
export interface Credential {
  id: string;
  kind: 'api_key' | 'aws' | 'gcp_service_account' | 'chatgpt' | string;
  provider: string;
  label: string;
  baseUrl: string | null;
  hint: string;
  /** The ChatGPT connection holds tokens; a key always counts as set. */
  connected: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What `GET /api/model-presets/formats` says each format and provider takes. */
export interface ModelFormats {
  formats: {
    id: string;
    parameters: ModelParameter[];
    /** The values it sends on the ChatGPT connection, where it takes one. */
    chatgptParameters: ModelParameter[] | null;
    key: 'required' | 'optional';
    defaultBaseUrl: string | null;
    /** RisuAI's flags for its models, which the preset's own lay over; null where the format places system turns itself. */
    reformat: ModelCapabilities | null;
    /** Whether a preset on it picks an instruct template. */
    instructTemplate: boolean;
  }[];
  providers: {
    id: string;
    label: string;
    baseUrl: string | null;
    formats: string[];
    key: 'required' | 'optional';
    /** What its credential holds: a key, AWS keys, or a Google service account. */
    kind: 'api_key' | 'aws' | 'gcp_service_account';
  }[];
  localEndpoints: { id: string; label: string; endpoint: string; formats: string[] }[];
  reasoningEfforts: string[];
  verbosities: string[];
  /** The instruct templates a text format may name, `jinja` last. */
  instructTemplates: string[];
}

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

/**
 * The reader's own preset (`GET /api/reader-presets`): RisuAI's `botPreset`, the
 * fields that make the prompt. Account-level, picked per chat, where it replaces
 * the built-in default (`DEFAULT_PRESET`) as picking a preset does in PocketRisu.
 */
export interface ReaderPreset {
  id: string;
  name: string;
  /** RisuAI's `mainPrompt`. Like the jailbreak and the global note, read only without a template. */
  main: string;
  globalNote: string;
  jailbreak: string;
  /** RisuAI's `formatingOrder`; null for its default order. */
  formatingOrder: FormatOrderItem[] | null;
  /** RisuAI's prompt template; when there is one it is the prompt, and the three texts and the order are not read. */
  promptTemplate: PromptTemplateItem[] | null;
  /** RisuAI's `groupTemplate`; '' for its default. */
  groupTemplate: string;
  groupOtherBotRole: GroupOtherBotRole;
  /** RisuAI's preset toggles (`customPromptTemplateToggle`), drawn first among a chat's toggles. */
  toggles: string;
  /** RisuAI's `moduleIntergration`: namespaces whose library modules a chat on it turns on. */
  moduleIntegration: string;
  /** RisuAI's `templateDefaultVariables`: `key=value` lines a chat on it reads for a variable nothing set. */
  defaultVariables: string;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors the whitelist in packages/db — also the order the select uses. */
export const MEMORY_CONTEXT_BUDGETS = [8000, 16000, 32000, 64000] as const;

/**
 * Per-chat memory tuning — the context budget and RisuAI HypaV3's settings; a
 * missing key means the default (`HYPA_V3_DEFAULTS` in @shizue/core).
 */
export interface ChatMemorySettings extends Partial<HypaV3Settings> {
  contextBudget?: number;
  /** Facts a request carries (`[Memory]`), 0–10; absent, 5. */
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

export interface Chat {
  id: string;
  plotId: string;
  personaId: string | null;
  title: string;
  /**
   * The model presets the chat runs on: `main` its turns, `sub` the side work —
   * null follows the owner's default, and an open sub the main. Optional so a
   * state built by hand needs none; absent is both open.
   */
  modelBinding?: ModelBinding;
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
  /** Built-in prompt preset id; `default` is the only one, which a reader preset replaces. */
  preset: string;
  /** The reader's own preset, which replaces the built-in default; null runs the default. */
  readerPresetId: string | null;
  headMessageId: string | null;
  /** Moves with every edit, hide and delete of a message — what may drop one of the memory's summaries. */
  memoryRevision: number;
  /** Null while the chat runs on every pipeline default. */
  memorySettings: ChatMemorySettings | null;
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
  /**
   * True while the server holds the chat's slot — a reply, or a drawn scene, on
   * its way, possibly one a page that has since gone asked for. Optional so a
   * state built by hand needs no flag.
   */
  generating?: boolean;
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
export type StreamMode = 'send' | 'regenerate' | 'continue' | 'auto' | 'reply';

export type MessageRole = 'user' | 'assistant';

/**
 * Where a turn's text came from; mirrors messages.source in packages/db. A user
 * turn is the reader's or a component's; an assistant turn is the model's
 * (`user`) or one a card's script wrote as its character (`script`).
 */
export type MessageSource = 'user' | 'component' | 'script';

/** An image the reader attached to one of their own turns, or a picture or file a SillyTavern chat brought. */
export interface ChatAttachment {
  id: string;
  /** Served by the API, to this reader only. */
  url: string;
  mime: string;
  /** Intrinsic size and blurred placeholder; null together when unmeasured. */
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  /** A SillyTavern file's name (`text/plain`); null or absent for a picture. */
  name?: string | null;
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
   * The work's global variables — shared by its chats, and not by branch.
   * Optional for a state built by hand.
   */
  globalVariables?: Variables;
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
