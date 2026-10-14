export type CardSpec = 'v1' | 'v2' | 'v3';

/**
 * Where an entry that is not injected at a depth goes. The first two are the
 * system string, around the cast; the rest are SillyTavern's World Info
 * positions, which its cards and World Info files carry as numbers: around the
 * author's note (2 and 3 there), around the example dialogue (5 and 6), and an
 * outlet (7) — text that goes nowhere by itself and stands in for a
 * `{{outlet::name}}` macro wherever the prompt's text writes one
 * (`LoreEntry.outletName`).
 */
export type LorePosition =
  | 'before_char'
  | 'after_char'
  | 'before_author_note'
  | 'after_author_note'
  | 'before_examples'
  | 'after_examples'
  | 'outlet';

/** Every position an entry may take; anything else reads as `before_char`. */
export const LORE_POSITIONS: readonly LorePosition[] = [
  'before_char',
  'after_char',
  'before_author_note',
  'after_author_note',
  'before_examples',
  'after_examples',
  'outlet',
];

/** Role of a depth-injected lore entry (V3 `@@role`). */
export type LoreRole = 'user' | 'assistant' | 'system';

export interface LoreEntry {
  /**
   * The creator's label for the entry (CCv3 `name`/`comment`, SillyTavern's
   * `comment`). Only the studio shows it; the model never reads it.
   */
  name?: string;
  keys: string[];
  secondaryKeys: string[];
  /** When true, secondaryKeys must also match. */
  selective: boolean;
  content: string;
  enabled: boolean;
  constant: boolean;
  insertionOrder: number;
  caseSensitive: boolean;
  /** V3: interpret keys as regular expressions. */
  useRegex: boolean;
  position: LorePosition;
  /**
   * The outlet an `outlet` entry fills — what `{{outlet::name}}` names. Only set
   * with that position; an outlet entry without one is never sent, as in
   * SillyTavern.
   */
  outletName?: string;
  /**
   * V3 `@@depth N`: inject the entry into the history, N messages from the end,
   * instead of into the system block. Undefined for system-block entries.
   */
  depth?: number;
  /** V3 `@@role`: role of the injected message. Only set together with depth. */
  role?: LoreRole;
  /**
   * How `secondaryKeys` combine with the primary match when `selective` is on.
   * Absent means `and_any`.
   */
  selectiveLogic?: LoreSelectiveLogic;
  /** Chance in percent (0–100) that a triggered entry is inserted. Absent means 100. */
  probability?: number;
  /**
   * Inclusion group labels, comma-separated (SillyTavern's `group`). Of the entries
   * triggered together in one group only one is inserted, picked by `groupWeight`.
   */
  group?: string;
  /** Relative weight in the group pick. Absent means 100. */
  groupWeight?: number;
  /** This entry's own scan depth in messages, overriding the book's `scanDepth`. */
  scanDepth?: number;
  /** Messages the entry stays active after it triggers (SillyTavern sticky). */
  sticky?: number;
  /** Messages the entry cannot trigger after its effect ends (SillyTavern cooldown). */
  cooldown?: number;
  /** The entry cannot trigger before the chat holds this many messages. */
  delay?: number;
}

/** SillyTavern's selective logic, in its own terms. */
export type LoreSelectiveLogic = 'and_any' | 'and_all' | 'not_any' | 'not_all';

export interface LoreSettings {
  scanDepth: number;
  /**
   * The card's own `token_budget`. Absent is automatic: a share of the chat's
   * context budget (`LORE_BUDGET_SHARE`), so the lore grows with the room it has.
   */
  tokenBudget?: number;
  /**
   * The automatic budget's share of the context, in percent, where it is not the
   * default quarter (`LORE_BUDGET_SHARE`) — SillyTavern's global
   * `world_info_budget`, which its migration carries over. Absent is the default
   * share; `tokenBudget`, when the card names one, wins over both.
   */
  budgetPercent?: number;
  /** V3 `recursive_scanning`: rescan with the activated content added to the scan text. */
  recursiveScanning: boolean;
  /**
   * How many scans a recursive activation may run in all, the first included —
   * SillyTavern's global `world_info_max_recursion_steps`, so 1 is no recursion
   * at all. Absent is unbounded, up to the engine's own ceiling.
   */
  maxRecursionSteps?: number;
  /**
   * Plain keys matched the way RisuAI matches them: case and spaces ignored on
   * both sides (`마왕 성` finds `마왕성`), whatever an entry's `caseSensitive`
   * says, and `{{// …}}` comments left out of the scan. Set by the import on a
   * book that came from RisuAI, whose creator tested it that way; absent (off)
   * everywhere else, so a SillyTavern or shizue book matches exactly as written.
   * Regex keys are not touched.
   */
  risuMatching?: boolean;
}

/**
 * A creator-authored display transform (RisuAI `editdisplay`). Applied by the web
 * client when it renders a message, never to the stored text and never to the
 * prompt: `in` matches, `out` is the HTML template the match is rewritten into.
 */
export interface DisplayScript {
  /** Regular expression source, matched against the raw message text. */
  in: string;
  /** HTML template. `$1`..`$99`, `$&` and `$<name>` bind the match; CBS macros bind the chat. */
  out: string;
  /**
   * Regex flags as the script's source compiled them. Absent or empty: every
   * match. Otherwise `g` decides — without it only the first match is rewritten
   * or moved.
   */
  flags?: string;
  /** Ascending application order. */
  order: number;
  /**
   * `move_top` / `move_bottom` lift the rendered match to the top or bottom of the
   * message; `repeat_back` reuses the previous same-role message's match when this
   * one has none, which is how a status window survives a turn that omits it.
   */
  action?: DisplayScriptAction;
  enabled: boolean;
  /**
   * The member whose card the script came with, in a work of several. It is
   * skipped on a message another member is the speaker of; untagged, it runs on
   * every message.
   */
  memberId?: string;
  /**
   * The messages the script runs on, by depth — SillyTavern's regex min/max
   * depth: 0 the newest message on the branch, counting every message the AI
   * reads, the reader's included. Both bounds inclusive; absent, no limit
   * (`inDisplayDepth`). A message out of range is not matched at all.
   */
  minDepth?: number;
  maxDepth?: number;
}

export type DisplayScriptAction = 'move_top' | 'move_bottom' | 'repeat_back';

/**
 * Something a card's components may ask the chat for, beyond drawing themselves.
 * `sendTurn` posts a user turn on the reader's behalf (see `messages.source`).
 */
export type ComponentCapability = 'sendTurn';

/** Every capability a card may declare; anything else is dropped on the way in. */
export const COMPONENT_CAPABILITIES: readonly ComponentCapability[] = ['sendTurn'];

/**
 * Whose vantage a narration is written from. `first` is the user character's own,
 * the others are outside it — an observer who sees what a camera would, one held
 * to the scene and the members (`third-limited`: never the user's inner life),
 * and one who also sees what everyone thinks.
 */
export type NarratorPov = 'first' | 'third' | 'third-limited' | 'omniscient';

/** Every point of view a narrator may declare; anything else is dropped. */
export const NARRATOR_POVS: readonly NarratorPov[] = ['first', 'third', 'third-limited', 'omniscient'];

/**
 * How the scene is narrated, as opposed to how the character speaks. Set on a
 * card and overridable per chat; every key is optional, and a config with none is
 * the same as having no narrator setting at all.
 */
export interface NarratorConfig {
  /** Free-form description of the narrating prose. */
  voice?: string;
  pov?: NarratorPov;
}

/** Which tense the events are told in. Unset leaves the choice to the model. */
export type PlotTense = 'past' | 'present';

/**
 * How long a reply should be. The setting is a pair — a directive telling the
 * model what to aim for and a cap the server enforces (`replyLengthTokens`) — so
 * a short plot stays short even when the model would rather keep writing.
 */
export type ReplyLength = 'short' | 'medium' | 'long' | 'auto';

/** Where the weight of a turn sits: in what is said, or in what is done. */
export type NarrativeDelivery = 'dialogue' | 'balanced' | 'action';

/** How fast the plot moves. */
export type PlotPacing = 'fast' | 'natural' | 'slow';

/** How readily the roster goes along with the reader. */
export type PlotDifficulty = 'easy' | 'normal' | 'hard' | 'nightmare';

/** The emotional register a scene aims for. A plot may pick two. */
export type PlotMood =
  | 'romance'
  | 'healing'
  | 'angst'
  | 'yandere'
  | 'fantasy'
  | 'action'
  | 'mystery'
  | 'horror';

/**
 * A named prose style. The names are ours and the directives describe the writing
 * itself — none of them names an author for the model to imitate.
 */
export type StorytellingStyle =
  | 'highSociety'
  | 'noir'
  | 'afterDark'
  | 'nostalgia'
  | 'blockbuster'
  | 'arcane'
  | 'manga'
  | 'dread';

/** Whether the model offers choices at the end of a turn, and in what shape. */
export type ChoicesMode = 'off' | 'keywords' | 'sentences';

export const PLOT_TENSES: readonly PlotTense[] = ['past', 'present'];
export const REPLY_LENGTHS: readonly ReplyLength[] = ['short', 'medium', 'long', 'auto'];
export const NARRATIVE_DELIVERIES: readonly NarrativeDelivery[] = ['dialogue', 'balanced', 'action'];
export const PLOT_PACINGS: readonly PlotPacing[] = ['fast', 'natural', 'slow'];
export const PLOT_DIFFICULTIES: readonly PlotDifficulty[] = ['easy', 'normal', 'hard', 'nightmare'];
export const PLOT_MOODS: readonly PlotMood[] = [
  'romance',
  'healing',
  'angst',
  'yandere',
  'fantasy',
  'action',
  'mystery',
  'horror',
];
export const STORYTELLING_STYLES: readonly StorytellingStyle[] = [
  'highSociety',
  'noir',
  'afterDark',
  'nostalgia',
  'blockbuster',
  'arcane',
  'manga',
  'dread',
];
export const CHOICES_MODES: readonly ChoicesMode[] = ['off', 'keywords', 'sentences'];

/** How many moods one plot may aim for at once. */
export const MAX_PLOT_MOODS = 2;

/**
 * How the creator wants the work written: the directives the assembler compiles
 * into the prompt (`styleDirectives`), plus the two features derived from them —
 * the status window and the choice lines.
 *
 * Every key is optional and each has a value that says nothing, so a plot that
 * sets none reads the same as a plot with no style at all. The point of view is
 * deliberately absent: it already belongs to the narrator (`NarratorConfig`), and
 * two places to set it would be two answers to the same question.
 */
export interface PlotStyle {
  tense?: PlotTense;
  replyLength?: ReplyLength;
  delivery?: NarrativeDelivery;
  pacing?: PlotPacing;
  difficulty?: PlotDifficulty;
  /** At most `MAX_PLOT_MOODS`, in the order the creator picked them. */
  moods?: PlotMood[];
  storytelling?: StorytellingStyle;
  statusWindow?: boolean;
  choices?: ChoicesMode;
}

/**
 * A reader profile the creator recommends for their plot: the persona this work
 * is written to be read as. Reader-facing by design — the name and the line of
 * description are what the start panel offers — and never prompt text of its own:
 * a reader who picks one gets a copy of it in their own personas, and it is that
 * copy the assembler reads as the persona.
 */
export interface PlotProfile {
  /** Minted by the coercion when the editor did not carry one. */
  id: string;
  name: string;
  description: string;
}

/** Profiles one plot may recommend. */
export const MAX_PLOT_PROFILES = 5;
/** A profile's name — a label on a chip, not a sentence. */
export const MAX_PLOT_PROFILE_NAME_LENGTH = 30;
/** A profile's description, which becomes the copied persona's. */
export const MAX_PLOT_PROFILE_DESCRIPTION_LENGTH = 1000;

/** Roster size. Ten is what one prompt can hold and one reader can keep straight. */
export const MAX_CHARACTERS_PER_PLOT = 10;
/** Openings a plot may offer; every one of them becomes a root of a new chat. */
export const MAX_INTROS_PER_PLOT = 10;
/**
 * One opening's length. Room for a RisuAI greeting that keeps a branch per
 * variable value: only the branch the variables choose reaches the model and the
 * reader, so the stored text can be several prologues long.
 */
export const MAX_INTRO_TEXT_LENGTH = 16_000;
/** Tags on a plot's explore filter column. */
export const MAX_TAGS = 10;
/** One tag — a word or two, not a phrase. */
export const MAX_TAG_LENGTH = 20;
/**
 * One card file an import takes. RisuRealm caps a charx upload at 150MB and its
 * popular cards carry hundreds of images; a gigabyte leaves room for archives
 * built elsewhere, so a card is not refused for its size. A PNG card with its
 * images inside runs to about 30MB.
 */
export const MAX_CARD_IMPORT_BYTES = 1024 * 1024 * 1024;

/**
 * The relationship axes an unlock may be keyed on. Mirrors `RELATIONSHIP_AXES`
 * in `@shizue/db`, which cannot be imported here — that package depends on this one.
 */
export const UNLOCK_AXES = [
  'affection',
  'obsession',
  'trust',
  'liking',
  'disgust',
  'fear',
] as const;

export type UnlockAxis = (typeof UNLOCK_AXES)[number];

/** What kind of condition an asset's reveal waits on. */
export type AssetUnlockKind = 'keyword' | 'turns' | 'relationship';

/**
 * What a plot asset waits for before a chat may see it. A null column means the
 * image is simply visible, which is what every asset was before this existed.
 *
 * This is a reward layer rather than access control: the bytes stay served by the
 * plot-scoped route to everyone who may read the work, and what is locked is the
 * reveal inside one conversation.
 */
export type AssetUnlock =
  /** Any of the keywords appearing in an assistant turn, case-insensitively. */
  | { kind: 'keyword'; keywords: string[] }
  /** Assistant turns on the current branch. */
  | { kind: 'turns'; count: number }
  /** A relationship axis reaching `min` (skipped while the chat has no axes). */
  | { kind: 'relationship'; axis: UnlockAxis; min: number };

/** Keywords one unlock may listen for. */
export const MAX_UNLOCK_KEYWORDS = 5;
/** One keyword's length — a word or a phrase, not a paragraph. */
export const MAX_UNLOCK_KEYWORD_LENGTH = 30;
/** The deepest turn count an unlock may wait for. */
export const MAX_UNLOCK_TURNS = 500;
/** Axis values run 0-100, and an unlock waiting for 0 would never be one. */
export const MAX_UNLOCK_RELATIONSHIP = 100;

/** One of a card's emotion pictures (`NormalizedCard.emotionImages`). */
export interface EmotionImage {
  /** The card's name for it — what the model is asked to choose, and what a message stores. */
  name: string;
  /** The plot asset it became. */
  slug: string;
}

export interface NormalizedCard {
  /** Spec of the source card, informational only. */
  spec: CardSpec;
  name: string;
  nickname?: string;
  /**
   * What the creator tells *readers* about the character — the line the explore
   * card and the public page lead with. Our own extension, and the one card field
   * that never reaches the prompt: `description` is what the model is told, this
   * is what a person is told, and folding the two together loses the distinction.
   * Absent when the creator wrote none.
   */
  intro?: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  /**
   * V3 `group_only_greetings`: openings the spec reserves for group chats. Kept
   * on the card so an export writes them back where they came from; an import
   * into a plot that already has a cast also makes them openings of the plot.
   * Absent when none.
   */
  groupOnlyGreetings?: string[];
  /** Kept verbatim, including <START> separators. */
  mesExample: string;
  /** May be ''. Supports {{original}}. */
  systemPrompt: string;
  /** May be ''. Supports {{original}}. */
  postHistoryInstructions: string;
  creatorNotes: string;
  tags: string[];
  creator: string;
  characterVersion: string;
  lorebook: LoreEntry[];
  loreSettings: LoreSettings;
  /** Display transforms, in no particular order — `order` decides. Absent when none. */
  displayScripts?: DisplayScript[];
  /** Seed values for the path-derived chat variables. Absent when none. */
  defaultVariables?: Record<string, string>;
  /**
   * Layer 2 component code: a JSX module the message's call codes instantiate,
   * compiled and run inside a worker in a sandboxed iframe, never on our origin.
   * A card field rather than a column, so it travels with the card. Absent when
   * empty.
   */
  componentCode?: string;
  /**
   * What the card's components may ask the chat for, beyond drawing themselves.
   * Nothing is granted by default: a capability the card does not declare never
   * reaches the frame, and the reader consents to it once per chat on top of that.
   * Absent when none.
   */
  componentCapabilities?: ComponentCapability[];
  /**
   * The card's narrator: how scene narration reads and whose vantage it takes. A
   * chat may override it. Absent when the creator set neither field — our own
   * extension, so an imported card never starts with one.
   */
  narrator?: NarratorConfig;
  /**
   * RisuAI's `emotionImages`: the card's expression pictures, by the name the
   * card gave each, and the plot asset each became. Written by the import once
   * the images are stored (a card file names them, but only the plot knows the
   * slugs), so a member's own pictures are told apart from another member's of
   * the same name. Whether they are shown is the card's RisuAI extension
   * (`emotionScreenOf`). Absent when the card brought none.
   */
  emotionImages?: EmotionImage[];
  /** Original extensions, preserved for round-tripping. */
  extensions: Record<string, unknown>;
  /** Original card JSON, kept for export/preservation. */
  raw: unknown;
}

/**
 * A plot's custom UI: the display transforms, the variable seeds and the Layer 2
 * component the whole work shares. An imported card carries these fields itself
 * (see `NormalizedCard`), and the import lifts them here — a chat is a plot's,
 * so what a chat renders with cannot belong to one of its members.
 *
 * Every key is optional, and a config with none is the same as having none.
 */
export interface PlotCustomUi {
  displayScripts?: DisplayScript[];
  /**
   * The stylesheet the scripts' markup is drawn with — what a RisuAI card keeps
   * in `backgroundHTML`. Scoped and filtered like a `<style>` in a script's
   * output, once per chat rather than once per message.
   */
  css?: string;
  defaultVariables?: Record<string, string>;
  componentCode?: string;
  componentCapabilities?: ComponentCapability[];
  /**
   * Each member's own stylesheet, by member id, in a work of several — what
   * `/characters/import` lifts off a companion's `backgroundHTML`. Scoped to the
   * messages that member speaks (`data-shizue-member`); the work's first member
   * also speaks for the messages no member is the speaker of. `css` above stays
   * the work's, on every message.
   */
  memberCss?: Record<string, string>;
  /**
   * The HTML drawn behind the chat — one for the whole work, as a RisuAI group
   * has its own `backgroundHTML` and draws no member's. The import lifts it off
   * the first card (past its `<style>`, which is `css`), and the creator may edit
   * it; '' draws nothing. Absent on a plot from before the field, which draws
   * what it always drew: the scripted member's card background.
   */
  backgroundHtml?: string;
  /**
   * The RisuAI modules the creator brought into the work (`POST
   * /api/plots/:id/modules`), in the order they came. The server keeps them: a
   * custom-UI save neither sends nor clears them, and only the module routes
   * write them.
   */
  modules?: PlotModule[];
}

/**
 * A RisuAI module (`.risum`, or its JSON) brought into a work. RisuAI stacks a
 * module on a chat beside the character rather than into it, so one is the
 * work's — every member's, untagged by any — and each runs after the card's own,
 * as RisuAI concatenates them: the card's regex scripts then the module's, the
 * card's triggers then the module's, the card's lore and the chat's then the
 * module's, the card's background then the module's. Kept whole under its own
 * id, so the studio lists it and takes it out cleanly.
 */
export interface PlotModule {
  /** Ours, minted on import — RisuAI mints a new one on every import too. */
  id: string;
  name: string;
  description: string;
  /** RisuAI's `lorebook`, as entries (`risuLoreBookEntry`). */
  lorebook: LoreEntry[];
  /** RisuAI's `regex`: `customScripts` as the module wrote them, every type. */
  regex: unknown[];
  /** RisuAI's `trigger`: the module's `triggerscript`, as written. */
  trigger: unknown[];
  /** RisuAI's `lowLevelAccess`, for the module's own triggers alone. */
  lowLevelAccess?: true;
  /** The `editdisplay` scripts of `regex`, as display scripts — run after the work's, on every message. */
  displayScripts?: DisplayScript[];
  /** The `<style>` elements of the module's `backgroundEmbedding`, drawn after the work's stylesheet. */
  css?: string;
  /** The rest of its `backgroundEmbedding`, drawn after the work's background. */
  backgroundHtml?: string;
  /**
   * The ids of the plot assets the import stored — its pictures join the work's,
   * as RisuAI's `getModuleAssets` joins the character's — which go with the module.
   */
  assets: string[];
  /** The file as it arrived. */
  importedFrom: { fileName: string; sha256: string; importedAt: string };
}

/**
 * Where an imported character came from: the file as it arrived, and the page
 * the reader says they took it from. A record for a takedown request rather than
 * a proof — the server hashes what it received, but the URL is the importer's
 * word. A member the studio created has none.
 */
export interface ImportProvenance {
  fileName: string;
  /** Hex SHA-256 of the uploaded bytes. */
  sha256: string;
  /** Canonical source page, e.g. `https://realm.risuai.net/character/<id>`. */
  sourceUrl?: string;
  /** ISO 8601. */
  importedAt: string;
  /** The platform it came from, when it was not a card file (`zeta`, `elyn`, …). */
  platform?: string;
  /** How it arrived. Absent means a card file, which is what every older row is. */
  method?: 'file' | 'url' | 'backup' | 'paste';
}

/**
 * One message of a conversation brought over from another app, as the chat
 * import takes it. The source's alternatives (SillyTavern's swipes) come along
 * as `versions`, and the conversation goes on from the `selected` one — the rest
 * become siblings the reader can still swipe to. The text is already in our
 * speech protocol: the importer, not the server, knows who said what.
 */
export interface ImportedChatMessage {
  role: 'user' | 'assistant';
  /** At least one. */
  versions: string[];
  /** Index into `versions`. */
  selected: number;
  /** ISO 8601, when the source recorded a time it could be read from. */
  createdAt?: string;
  /**
   * The member an assistant message is wholly said by, for a group chat brought
   * into a work of several: its text then carries no `이름: ` prefix.
   */
  speakerId?: string;
  /** Hidden from the AI, every version (`messages.hidden_from_prompt`): what ST keeps out of the prompt. */
  hidden?: boolean;
}

/** No `tokenBudget`: a card that names none gets the automatic one. */
export const DEFAULT_LORE_SETTINGS: LoreSettings = {
  scanDepth: 4,
  recursiveScanning: false,
};
