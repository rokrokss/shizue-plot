export type CardSpec = 'v1' | 'v2' | 'v3';

export type LorePosition = 'before_char' | 'after_char';

/** Role of a depth-injected lore entry (V3 `@@role`). */
export type LoreRole = 'user' | 'assistant' | 'system';

export interface LoreEntry {
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
  tokenBudget: number;
  /** V3 `recursive_scanning`: rescan with the activated content added to the scan text. */
  recursiveScanning: boolean;
}

/**
 * A creator-authored display transform (RisuAI `editdisplay`). Applied by the web
 * client when it renders a message, never to the stored text and never to the
 * prompt: `in` matches, `out` is the HTML template the match is rewritten into.
 */
export interface DisplayScript {
  /** Regular expression source, matched against the raw message text. */
  in: string;
  /** HTML template. `$1`..`$9`, `$&` and `$<name>` bind the match; CBS macros bind the chat. */
  out: string;
  /** Regex flags. `g` is always applied. */
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
 * the other two are outside it — an observer who sees what a camera would, and one
 * who also sees what everyone thinks.
 */
export type NarratorPov = 'first' | 'third' | 'omniscient';

/** Every point of view a narrator may declare; anything else is dropped. */
export const NARRATOR_POVS: readonly NarratorPov[] = ['first', 'third', 'omniscient'];

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
  defaultVariables?: Record<string, string>;
  componentCode?: string;
  componentCapabilities?: ComponentCapability[];
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
}

export const DEFAULT_LORE_SETTINGS: LoreSettings = {
  scanDepth: 4,
  tokenBudget: 2048,
  recursiveScanning: false,
};
