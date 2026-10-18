import { AUTHOR_NOTE_DEFAULTS, authorNoteDue, authorNoteSettingsOf, type AuthorNoteSettings } from './authorNote.js';
import { unescapeCbs, type CbsChat, type CbsCharacter, type CbsModel } from './cbs.js';
import { risuEscape } from './cbs/functions.js';
import { extractChoices } from './choices.js';
import { isUtilityBot } from './card/risu.js';
import { emotionInstructionsOf } from './emotion.js';
import {
  applyMacros,
  stripInlayMacros,
  type MacroClock,
  type MacroContext,
  type MacroHostData,
  type MacroTavernData,
} from './macro.js';
import { activateLore, loreEntryKey, type LoreActivationVia, type LoreTimedState } from './lorebook.js';
import type { LoreAliases } from './loreAliases.js';
import { isNarration, narrationBody } from './narration.js';
import { readerLine, spokenBy, type ReaderMember } from './speech.js';
import {
  DEFAULT_GROUP_TEMPLATE,
  DEFAULT_PRESET,
  groupSpeakerLine,
  SPEECH_PROTOCOL_REMINDER,
  speechProtocol,
  templateOf,
  UTILITY_TEMPLATE,
  type PromptItemRole,
  type PromptPreset,
  type PromptTemplateItem,
} from './presets.js';
import { extractStatusBlock } from './statusBlock.js';
import {
  frameTavernSegment,
  isTavernSegment,
  markTavernSegment,
  unmarkedText,
  type TavernLoreSegment,
} from './tavernLore.js';
import { countTokens as countRawTokens } from './tokens.js';
import {
  DEFAULT_LORE_SETTINGS,
  type LoreEntry,
  type LoreMatchSource,
  type LorePosition,
  type LoreTrigger,
  type NarratorConfig,
  type NarratorPov,
  type NormalizedCard,
  type ReplyLength,
  type PlotDifficulty,
  type PlotMood,
  type PlotPacing,
  type PlotModule,
  type PlotStyle,
  type PlotTense,
  type StorytellingStyle,
  type NarrativeDelivery,
  type ChoicesMode,
} from './types.js';
import {
  applyVariableDelta,
  DEFAULT_USER_NAME,
  diffVariables,
  emptyVariables,
  type VariableDelta,
  type Variables,
} from './variables.js';

/**
 * Tokens, not counting the marks the `WORLD_INFO` regex is asked over
 * (`tavernLore.ts`), which never reach the model: a marked prompt is measured as
 * the same prompt unmarked.
 */
const countTokens = (text: string): number => countRawTokens(unmarkedText(text));

export type PromptRole = 'user' | 'assistant' | 'system';

/**
 * A piece of a turn the model reads. Only a turn carrying attachments is ever
 * split into these; everything else stays the plain string it has always been.
 */
export type PromptPart = { type: 'text'; text: string } | { type: 'image'; url: string };

export interface PromptMessage {
  role: PromptRole;
  content: string | PromptPart[];
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * The stored message the turn is — what a card's request editors read as the
   * turn's `memo`, as RisuAI's carry its message's `chatId` (`MessageSource`).
   */
  id?: string;
  /**
   * What the model is sent for the turn where that is not what is stored: the
   * text after the cards' prompt scripts rewrote it — RisuAI's `editprocess`,
   * SillyTavern's prompt-only regex (`promptScripts.ts`). The caller runs them,
   * in a worker, before the assembler; the lore scan and the chat functions
   * still read `content`, as both apps read the stored turn.
   */
  promptContent?: string;
  /**
   * Images attached to the turn, as URLs the provider can read (the API resolves
   * its stored attachments into `data:` URLs). Only a model with vision is given
   * them — see `IMAGE_ATTACHED_PLACEHOLDER`.
   */
  images?: string[];
  /** When the turn was sent, in ms — what RisuAI's message-time functions read. */
  createdAt?: number;
  /**
   * The member who says the whole of an assistant turn whose text names no one:
   * a character message a card's script wrote (`messages.source` `script`),
   * stored as the script wrote it. Its lines are sent under that name
   * (`spokenBy`), as a reply's are, rather than read as the narrator's; the lore
   * scan and the chat functions still read `content`.
   */
  speaker?: string;
  /**
   * The member a group turn's reply is stored under (`messages.speaker_member_id`),
   * matched against `PromptCharacter.id`. The reply is that member's whole and
   * carries no `이름: ` prefix, so it is sent under their name (`spokenBy`) — except
   * to themselves: when they are the `speaker` being asked, their own replies go
   * plain, as the one they are about to write. It names the member before
   * `speaker` does; an id no member has leaves `speaker` to decide.
   */
  speakerId?: string;
  /**
   * The reader hid the turn from the AI (`messages.hidden_from_prompt`,
   * SillyTavern's `is_system`): it is neither sent nor scanned for lore, as ST
   * leaves it out of `coreChat`. It stays in `history` all the same, so the
   * chat functions and every other turn's index read the stored chat.
   */
  hidden?: boolean;
}

/**
 * Where `history` sits on its branch, for RisuAI's chat functions and the draw
 * `{{pick}}` makes. The history the assembler is given may be only the newest
 * stretch of the branch — the memory trims its front — and RisuAI counts its
 * messages from the greeting, which it keeps apart from the rest.
 */
export interface PromptBranch {
  /** Every message on the branch up to and including the last of `history`, the greeting among them. */
  length: number;
  /**
   * The intro the branch opened on, when it opened on one: its text, and which
   * intro it is — -1 the first, k the k-th after it (`{{firstmsgindex}}`). The
   * text is what the greeting turn is sent as: the stored one, or the chat's
   * overlay of the first opening (`MemberOverlay.firstMessage`).
   */
  greeting?: { text: string; index: number };
  /**
   * The versions of the branch's last message, when it is a reply: how many
   * there are beside it and which it is (0 the first) — SillyTavern's swipes,
   * for `{{lastSwipeId}}` and `{{currentSwipeId}}`.
   */
  swipes?: { count: number; current: number };
}

/**
 * What a card's start triggers asked to put in the prompt, RisuAI's three
 * places: just before the newest turn of the history (`start`), just after the
 * history (`historyend`), and at the very end of the prompt (`promptend`). Sent
 * as written — the browser that ran the triggers already expanded them — and,
 * like RisuAI's, for the one request.
 */
export interface PromptInjections {
  start?: string;
  historyend?: string;
  promptend?: string;
}

/**
 * What a turn's image costs the context budget. A flat estimate rather than a
 * measurement: the real number depends on the provider's tiling and on the size
 * it decides to resize to, and neither is knowable here. It is set high enough
 * that a turn with images cannot quietly push the history past the budget.
 */
export const IMAGE_TOKEN_ESTIMATE = 800;

/** What a model without vision is told in place of an image it cannot see. */
export const IMAGE_ATTACHED_PLACEHOLDER = '[image attached]';

/** The words of a prompt message, whatever shape its content is in. */
export const promptText = (content: string | PromptPart[]): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((part): part is Extract<PromptPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n');

/**
 * The work the chat belongs to. `description` is what the model is told about it
 * — the setting and the situation — as against the reader-facing intro, which
 * never reaches a prompt.
 */
export interface PromptPlot {
  name: string;
  /**
   * `{{char}}` in the work's own text, where it is not the plot's name: a plot of
   * one member whose scripts renamed it (`MemberOverlay.name`) is that character,
   * and RisuAI's `{{char}}` follows the rename. The `[Story: …]` header keeps `name`.
   */
  char?: string;
  description: string;
  lorebook: LoreEntry[];
  /** The plot's narrator, which a chat may stand in for. */
  narrator?: NarratorConfig;
  /**
   * How the creator wants it written. Compiled into a directive block that rides
   * with the narrator's (`styleDirectives`). The caller decides what is in it: the
   * status-window and choices options are the plot's setting crossed with the
   * reader's own toggle, and only the crossing reaches here.
   */
  style?: PlotStyle;
  /**
   * The RisuAI modules brought into the work (`PlotModule`). Their lore joins
   * the one book after every member's — and after the chat's own, which rides
   * on the scripted member's — as RisuAI activates `characterLore`, then
   * `chatLore`, then `moduleLorebook`. Their scripts are the caller's to run.
   */
  modules?: readonly PlotModule[];
  /** `{{moduleenabled}}`/`{{moduleassetlist}}`'s modules, their asset names resolved by the caller; unset, both stay as written. */
  cbsModules?: MacroHostData['modules'];
}

/**
 * One member of the plot's roster. `name` is the row's, not the card's: it is
 * the speaker prefix the script protocol matches (see `speech.ts`), so the name
 * the model is taught to write has to be the name the parser looks for.
 */
export interface PromptCharacter {
  /** The member's row id, which a group turn's history names its speaker by (`HistoryMessage.speakerId`). */
  id?: string;
  name: string;
  card: NormalizedCard;
  /**
   * Sent off the stage in this chat: the card's block, its example dialogue and
   * its lorebook leave the prompt, and one line says the member is not in the
   * scene. A first member that is away still stands in for the work — its
   * overrides and lore settings are the work's, not a line of its own.
   */
  absent?: boolean;
  /**
   * The card was written for SillyTavern, whose prompt runs the variable macros
   * its text holds: a `{{setvar}}` in the description sets the variable and says
   * nothing, and a `{{getvar}}` after it reads the new value. So does this one's
   * own text here — its fields, its examples, its lore, and its overrides when it
   * stands in for the work. RisuAI's prompt never runs them, and neither does
   * any other member's text; what they wrote comes back as
   * `AssembledPrompt.variableWrites`.
   */
  sillyTavern?: boolean;
}

export interface AssemblePromptInput {
  plot: PromptPlot;
  /** The roster, in the order the creator arranged it. May be empty. */
  characters: PromptCharacter[];
  /** Persona description of the user. */
  personaText?: string;
  userName?: string;
  /**
   * The summaries of the turns that no longer fit that HypaV3's important and
   * recent shares picked (`memoryBlock`), already formatted. Injected right after
   * the persona, in the system string, where RisuAI sends its memory: they change
   * only when a summary lands.
   */
  memoryText?: string;
  /**
   * The summaries HypaV3's similar and random shares picked for this turn
   * (`recalledMemoryBlock`), already formatted. The first part of the recall turn
   * (`recall`), right after the newest turn: they follow the latest turns, so in
   * the system string, the cached prefix, they would keep the history behind
   * them out of the cache.
   */
  recalledMemoryText?: string;
  /**
   * The facts recalled for this turn (`[Memory]`, `factsBlock`), already
   * formatted. In the recall turn after the recalled summaries: searched against
   * the latest turns, they change nearly every turn, so they stand after the
   * newest turn rather than in the system string, the cached prefix.
   */
  factsText?: string;
  /**
   * The earlier messages a search by meaning brought back (SillyTavern's chat
   * vectorization, `retrievalBlock`), already formatted. In the recall turn,
   * after the facts — ST's "In-chat @ Depth" placement of its `3_vectors`, at
   * depth 0 — rather than its default after the story string, which would be the cached
   * prefix here. The caller brings back only messages `history` does not
   * send, and leaves `history` as it is — ST takes them out of the chat it
   * sends, which would change the history, and the cached prefix, every turn.
   */
  retrievalText?: string;
  /**
   * Author's note. Injected `authorNoteSettings.depth` (default
   * `AUTHOR_NOTE_DEPTH`) messages from the end of the history and, like the
   * post-history block, never evicted.
   */
  authorNote?: string;
  /**
   * The chat's author's-note settings (SillyTavern's depth, frequency and role).
   * Absent: depth 4, every turn, a system message — the fixed placement before
   * they existed.
   */
  authorNoteSettings?: AuthorNoteSettings | null;
  /**
   * How many of the reader's messages the chat holds — the whole branch, hidden
   * ones too, as SillyTavern counts them — which the note's frequency is read
   * against. Absent: the user turns of `history`.
   */
  userTurns?: number;
  /**
   * Stage directions carried by the *last* user message — what a game component
   * decided about the turn the user just took. Injected as a `[Game ruling]` system
   * turn right after the newest turn, ahead of the recall turn, so it never
   * stands inside what the next turn's request repeats — the provider's cache.
   * Earlier turns' directions are not injected: they already had their effect.
   */
  directions?: string;
  /**
   * The chat's own narrator, which stands in for the plot's when it has one. Only
   * the override travels here — a chat that sets none leaves the plot's in force.
   */
  narrator?: NarratorConfig;
  /** Messages on the current branch, oldest first. */
  history: HistoryMessage[];
  /**
   * Turns the caller appends after the assembled prompt — the partial assistant
   * message the continue path re-attaches behind the post-history block. Depth
   * lore counts them so its offsets stay put; their tokens are the caller's to
   * subtract from contextBudget, since the assembler never sees the text.
   */
  trailingTurns?: number;
  /**
   * Path-derived chat variables, computed by the caller from the branch messages
   * (see `computeVariables`). Only `{{getvar::k}}` reads them — the `{{setvar}}`
   * macros that produced them stay in the history verbatim.
   */
  variables?: Variables;
  /** The reader's global variables on this plot, for `{{getglobalvar}}` and `@name`. */
  globalVariables?: Variables;
  /** The reader's clock, for the time macros. Without it they stay verbatim. */
  clock?: MacroClock;
  /**
   * What `{{pick}}` draws from — the chat id. With `branch` it is RisuAI's draw,
   * which turns on the branch's length: a new one each turn, the same one on a
   * reroll. Without `branch`, the same text and position pick alike for the whole chat.
   */
  seed?: string;
  /** Where `history` sits on its branch (`PromptBranch`). Without it, `history` is taken to be all of it. */
  branch?: PromptBranch;
  /** The model the turn is generated with, for `{{model}}` and `{{metadata}}`. */
  model?: CbsModel;
  /** What the card's start triggers asked to put in the prompt (`PromptInjections`). */
  injections?: PromptInjections;
  /**
   * The branch's lore records, for the timed effects. Built by the caller from
   * the whole branch, which `history` may be only the newest stretch of.
   */
  loreState?: LoreTimedState;
  /**
   * Keys in the reader's language for entries whose own keys are not — the
   * API's Korean aliases (`ActivateLoreInput.aliases`). Absent: none.
   */
  loreAliases?: (entry: LoreEntry) => LoreAliases | undefined;
  /** The names this chat's open images go by, for {{assetlist}} (`MacroContext.assetNames`). */
  assetNames?: readonly string[];
  contextBudget?: number;
  maxResponseTokens?: number;
  /**
   * The prompt preset the request is built by (§6 프리셋): the built-in default
   * (`DEFAULT_PRESET`, absent) or the reader's own, which replaces it. Its
   * template — or, without one, its `formatingOrder` — decides what goes where
   * (`templateOf`). Its text is the reader's, read with `{{char}}`, `{{user}}`,
   * the clock and the reader's globals and nothing else, so it cannot pull the
   * creator's text into the prompt. A utility bot is sent RisuAI's utility
   * template instead.
   */
  preset?: PromptPreset;
  /**
   * Also say how the prompt was put together (`PromptReport`). Off for every
   * generation: it measures each block again, which only the inspector needs.
   */
  report?: boolean;
  /**
   * Mark the text of every SillyTavern World Info entry where it is inserted
   * (`tavernLore.ts`), for the caller to run ST's `WORLD_INFO` regex over it —
   * asynchronously, in its regex threads — and put the result in its place
   * (`withTavernLore`). Set only where a card carries such a script; without it
   * the prompt is the same, byte for byte.
   */
  markTavernLore?: boolean;
  /**
   * Who a group turn asks the reply of (`group.ts`): an index into `characters`.
   * Without it the prompt is the scene's, as it has always been.
   *
   * A member: RisuAI's group chat (`sendChat` with `chatProcessIndex`). Only their
   * card is the description, with the work's own after it; their card's
   * overrides stand in for the first member's (read with `{{char}}` as them);
   * their own past replies go plain while everyone else's go in the preset's
   * `groupTemplate`, as its `groupOtherBotRole`; and what follows the chat
   * closes on `groupSpeakerLine`. No speech protocol: the reply is the
   * speaker's whole. The member is expected to be on the stage. The result
   * carries `stopSequences`.
   */
  speaker?: number;
  /**
   * What kind of generation this is, in SillyTavern's terms, for the lore
   * entries that name the kinds they fire on (`LoreEntry.triggers`). Absent:
   * `normal`.
   */
  generationType?: LoreTrigger;
}

export interface AssembledPrompt {
  system: string;
  messages: PromptMessage[];
  /**
   * `loreEntryKey`s of the lore that freshly triggered for this prompt — what
   * the assistant message it produces records for the timed effects.
   */
  loreTriggers: string[];
  /**
   * What a SillyTavern member's variable macros wrote while the prompt was put
   * together (`PromptCharacter.sillyTavern`), as the values they left over the
   * input's `variables`. The turn the prompt produces carries them, so the next
   * prompt — and the reader's screen — read them from that turn on. Absent when
   * nothing wrote anything.
   */
  variableWrites?: VariableDelta;
  /**
   * What SillyTavern's text wrote to the reader's global variables on this plot
   * (`{{setglobalvar}}` and the rest), as values over the input's
   * `globalVariables` — `null` for one it deleted. The caller merges them into
   * the reader's globals once the turn is stored. Absent when nothing wrote any.
   */
  globalVariableWrites?: VariableDelta;
  /** Present only when the input asked for it. */
  report?: PromptReport;
  /**
   * With `markTavernLore`: one per marked segment, by its index — where ST's
   * `WORLD_INFO` regex is asked it (`TavernLoreSegment`). Absent when nothing
   * was marked.
   */
  tavernLore?: TavernLoreSegment[];
  /**
   * What each of `messages` is, in order — the block it was put together as,
   * and for a turn of the chat the stored message it came from. A card's
   * request editors read them as RisuAI's item fields (`risuRequestExtras`).
   * Always there from the assembler; gone once the request was edited, when
   * they no longer line up.
   */
  sources?: MessageSource[];
  /**
   * What the request editors' view of the request (`risuRequestView`) needs
   * that `system` folds away: the system string as RisuAI's turns — its
   * `pushPrompts` runs system turns together only where their `memo` agrees,
   * so the memory is a turn of its own — and whether the request was built
   * from a template, which keeps the newest turn among the chat's. Always
   * there from the assembler, like `sources`.
   */
  risu?: RisuPromptParts;
  /**
   * What the budget charged before any history, the summaries aside: the rest
   * of the system string, the post-history block, the directions, the notes,
   * the depth lore and the moved lore, the injections, the recall turn but its
   * summaries (the facts and the messages brought back) and the
   * trailing blocks — everything never dropped. The memory's summarizer (API
   * §7.3) counts the history it lets stand against what is left beside it and
   * the summaries' share. Always there from the assembler.
   */
  fixedTokens?: number;
  /**
   * The sections `system` is joined from, in order, each as sent and with what
   * it is — the main prompt, the lore that stays before and after the cast
   * (the moved lore is a turn), the memory block and the rest. The API's
   * prompt-cache log tells by them which part of the system string changed
   * (`cacheHealth.ts`). Always there from the assembler; gone once the request
   * was edited, like `sources`.
   */
  systemSections?: { kind: PromptBlockKind; text: string }[];
  /**
   * For a group turn (`AssemblePromptInput.speaker`): where the reply has strayed
   * into another member's line — `\n이름:` and `\n별명:` of every member on the
   * stage but the speaker. The caller stops the stream on them.
   */
  stopSequences?: string[];
}

/** What each piece of an assembled prompt is, in the creator's prompt inspector. */
export type PromptBlockKind =
  /** The preset's main prompt (a template's `main` item), or the card's system prompt in its place. */
  | 'main'
  /** Any other text of the preset's own: a template's `normal` or jailbreak item, its legacy jailbreak. */
  | 'preset'
  /** The format rule a scene or a work of one member is taught (`speechProtocol`), and its reminder. */
  | 'speech_protocol'
  | 'narration_note'
  /** Lore an entry's position puts before the description (`@@position before_desc`, SillyTavern's ↑Char). */
  | 'lore_before'
  /** The description of the character asked — card, personality, circumstances (RisuAI's `description`). */
  | 'description'
  | 'narrator'
  | 'style'
  /** Lore an entry's position puts after the description. */
  | 'lore_after'
  /** RisuAI's lorebook slot: the active entries no position places. */
  | 'lorebook'
  | 'persona'
  | 'memory'
  | 'directions'
  | 'examples'
  /** RisuAI's `NewChat` separator, between the examples and the chat. */
  | 'new_chat'
  | 'history'
  | 'depth_lore'
  | 'author_note'
  /**
   * The lore keywords brought in — a match, a recursive scan or a sticky window,
   * never an always-on entry — at the system string's default places (before
   * and after the cast), as one system turn right after the newest turn: the
   * same entries and text, sent where they no longer change the system string.
   */
  | 'moved_lore'
  /**
   * What this turn recalls — the summaries HypaV3's similar and random shares
   * picked, the facts, the messages a search brought back — as one system turn
   * right after the newest turn.
   */
  | 'recall'
  /** The preset's global note (a `globalNote` item), or the card's post-history instructions in its place. */
  | 'global_note'
  | 'injection'
  | 'trailing'
  /**
   * A turn the card's request triggers rewrote after the prompt was put together
   * (the API's `requestTriggers.ts`), labelled with the role it is sent as. It
   * stands for every block the turn was made of; turns they left alone keep theirs.
   */
  | 'request';

/** What one message of an assembled prompt is (`AssembledPrompt.sources`). */
export interface MessageSource {
  kind: PromptBlockKind;
  /** A turn of the chat: the stored message it is (`HistoryMessage.id`). */
  id?: string;
  /** A turn of the chat that is the branch's greeting, which RisuAI sends from the character rather than the chat. */
  greeting?: true;
  /**
   * An example block's speakers: the reader's name, and `{{char}}` with the
   * name the block is under — whose lines RisuAI's `exampleMessage` makes the
   * block's user and assistant turns (`risuExampleSides`).
   */
  speakers?: ExampleSpeakers;
}

/** `MessageSource.speakers`. */
export interface ExampleSpeakers {
  user: string;
  char: string[];
}

/** `AssembledPrompt.risu`. */
export interface RisuPromptParts {
  /**
   * The system string as RisuAI's turns, in order: the leading system items,
   * run together where their `memo` agrees — the memory, `supaMemory`, apart.
   * Joined with a blank line they are `system`.
   */
  system: { text: string; memo?: 'supaMemory' }[];
  /**
   * Built from a prompt template — the preset's, or a utility bot's
   * (`isUtilityBot`) — which keeps the newest turn among the chat's,
   * `removable` like the rest, where without one it goes apart as `lastChat`.
   */
  template?: true;
}

export interface PromptReportBlock {
  kind: PromptBlockKind;
  /** A member's name, a turn's role, or a depth lore entry's depth. */
  label?: string;
  tokens: number;
  text: string;
}

/** One lore entry that made it into the prompt. */
export interface PromptReportLore {
  key: string;
  /** `'plot'`, or the name of the member whose card carries the entry — or of the module that brought it. */
  source: string;
  keys: string[];
  /** The first characters of the content as the model reads it. */
  preview: string;
  /** Its position — with the depth of a depth entry, and the name of an outlet entry's outlet. */
  placement: Exclude<LorePosition, 'outlet'> | `depth ${number}` | `outlet ${string}`;
  via: LoreActivationVia;
}

/**
 * How a prompt was put together: its blocks in the order the model reads them,
 * what the budget allowed, and which lore fired and why. The creator's
 * debugging view — the text is the creator's own work plus the chat it runs on.
 */
export interface PromptReport {
  blocks: PromptReportBlock[];
  totals: {
    contextBudget: number;
    /** What the budget keeps free for the reply. */
    responseReserve: number;
    /** Everything charged to the budget: the blocks above, as they were counted. */
    used: number;
  };
  history: { included: number; total: number };
  examples: { included: number; total: number };
  lore: PromptReportLore[];
}

/** How much of an activated entry's content the report quotes. */
const LORE_PREVIEW_LENGTH = 80;

/**
 * How far from the end of the history the author's note sits unless the chat
 * says otherwise — SillyTavern's default. Close enough to the end to steer the
 * next turn, without being the last thing the model reads.
 */
export const AUTHOR_NOTE_DEPTH = AUTHOR_NOTE_DEFAULTS.depth;

/**
 * The context a chat gets until its reader picks another (`memorySettings.
 * contextBudget`). At 64k a chat of about 290–350 messages goes verbatim, with
 * no summary and no auxiliary call: on two such chats replies were as good as
 * 16k's with its memory or slightly better, time to first token 3.7 s at 25k
 * prompt tokens and 5.6 s at 61k (2026-10-16, ARCHITECTURE §7.3). The models
 * readers use accept far more.
 */
export const DEFAULT_CONTEXT_BUDGET = 64000;
/**
 * The lore budget of a book whose card names none (`LoreSettings.tokenBudget`):
 * this share of the context budget, so a chat given more room gives its lore
 * more too. Half, more than RisuAI's own default (the reader's lorebook setting,
 * 8,000 on a fresh install): a cap that drops a card's content is a bug, and at a
 * quarter Parma Knights, the one surveyed Realm card that names no budget, lost
 * its own engine-state constants to the heroine profiles its recursion pulls in
 * on nearly every turn, where half keeps them (2026-10-16, ARCHITECTURE §6
 * 로어북). It is a cap, not a reservation: the history gets what the lore leaves.
 */
export const LORE_BUDGET_SHARE = 0.5;
/**
 * A SillyTavern book's automatic share: ST's own `world_info_budget` default
 * (25%), of the context less the reply.
 */
export const TAVERN_LORE_BUDGET_SHARE = 0.25;
// Sized for the speech protocol: a turn carries several speakers plus narration,
// and 600 (the single-character era value) cut replies mid-sentence.
export const DEFAULT_MAX_RESPONSE_TOKENS = 1200;
export { DEFAULT_USER_NAME };

/**
 * The cap that goes with each reply-length directive. A directive alone does not
 * hold — a model asked for two paragraphs writes five when the scene tempts it —
 * so the setting is a pair: the directive says what to aim for and this is the
 * ceiling the request carries. `auto` is the default cap, which is what a plot
 * that never chose a length has always been generating under.
 */
const REPLY_LENGTH_TOKENS: Record<ReplyLength, number> = {
  short: 600,
  medium: DEFAULT_MAX_RESPONSE_TOKENS,
  long: 2400,
  auto: DEFAULT_MAX_RESPONSE_TOKENS,
};

/** The response cap for a plot's reply length; the default when it set none. */
export function replyLengthTokens(length?: ReplyLength): number {
  return length ? REPLY_LENGTH_TOKENS[length] : DEFAULT_MAX_RESPONSE_TOKENS;
}

/** Wrapper the model reads stage directions under; they are a ruling, not dialogue. */
export const DIRECTIONS_HEADER = '[Game ruling]';

/** Wrapper a narrating turn is carried under; it moves the scene, not whoever sent it. */
export const NARRATION_HEADER = '[Narration]';

/**
 * What the header means, said once. It sits in the system string rather than
 * beside the turn it describes: the rule never changes, and the system string is
 * the cached prefix — a per-turn copy would pay for the same sentence every turn.
 */
export const NARRATION_NOTE =
  "A message marked [Narration] is not a character's or the user's speech but narration that moves the scene and situation forward.";

/**
 * A reader's turn as the model reads it: a `@이름: …` line the reader wrote as a
 * member goes under that member's roster name (`names[0]`, through `spokenBy`),
 * so it reads as the member's line; a `@내레이터: …` or `@: …` line goes under the
 * narration header, as a whole-turn `@:` does; every other line is the reader's,
 * as typed. A turn without such a line comes back as it is. A whole-turn `@:` is
 * not this function's: the caller sends it as narration whole.
 */
export function readerTurnText(content: string, members: readonly ReaderMember[]): string {
  let changed = false;
  const lines = content.split('\n').map((line) => {
    const written = readerLine(line, members);
    if (!written) return line;
    changed = true;
    return written.kind === 'member'
      ? spokenBy(written.text, written.member.names[0]!)
      : `${NARRATION_HEADER} ${written.text.trim()}`.trim();
  });
  return changed ? lines.join('\n') : content;
}

/**
 * RisuAI's `"Circumstances and context of the dialogue: " + scenario`, which its
 * `sendChat` adds to the description of the character it asks — in a group,
 * the turn's speaker.
 */
export const scenarioLine = (scenario: string): string => `Circumstances and context of the dialogue: ${scenario}`;

/**
 * RisuAI's separator, a fixed text: before each `<START>` block of the
 * examples, and between the examples and the chat (`NewChatExample`, `NewChat`).
 */
export const NEW_CHAT_SEPARATOR = '[Start a new chat]';

/**
 * A group speaker's own scenario, where it has one the work does not already
 * say: the first member's card's became the work's description at import (`POST
 * /api/plots/import`) and the creator owns it from there, so the first member
 * brings none, and no member brings the description's own text again. Empty
 * where there is nothing of its own.
 */
export const ownScenario = (
  member: PromptCharacter,
  characters: readonly PromptCharacter[],
  plot: Pick<PromptPlot, 'description'>,
): string => {
  if (member === characters[0]) return '';
  const scenario = member.card.scenario.trim();
  return scenario && scenario !== plot.description.trim() ? member.card.scenario : '';
};

/** How each point of view is put to the model. */
export const NARRATOR_POV_LABELS: Record<NarratorPov, string> = {
  first: "first person (from the user character's point of view)",
  third: 'third-person observer',
  'third-limited': 'third-person limited (narrated within what one point-of-view character observes or feels)',
  omniscient: 'third-person omniscient',
};

/** Header the compiled style directives are read under. */
export const STYLE_DIRECTIVES_HEADER = 'Style directions:';

/** How each mood is named to the model. */
export const PLOT_MOOD_LABELS: Record<PlotMood, string> = {
  romance: 'romance',
  healing: 'healing',
  angst: 'angst',
  yandere: 'yandere',
  fantasy: 'fantasy',
  action: 'action',
  mystery: 'mystery',
  horror: 'horror',
};

// The directive tables. Every option whose value is the plot's default — the
// tense the model would pick anyway, `balanced`, `natural`, `normal`, `auto`,
// `off` — is absent on purpose: the default is what the prompt says nothing
// about, and a line saying "keep it balanced" would spend the model's attention
// on the setting the creator left alone.

const TENSE_DIRECTIVES: Record<PlotTense, string> = {
  past: 'Narrate events in the past tense.',
  present: 'Narrate events in the present tense.',
};

const REPLY_LENGTH_DIRECTIVES: Partial<Record<ReplyLength, string>> = {
  short: 'Answer briefly with no padding, in 1–2 paragraphs.',
  medium: 'Answer in 2–3 paragraphs at an easy reading pace.',
  long: 'Spare no description: answer at length, in 3–5 immersive paragraphs.',
};

const DELIVERY_DIRECTIVES: Partial<Record<NarrativeDelivery, string>> = {
  dialogue: 'Lean a little more on dialogue, moving the scene through the words exchanged.',
  action: 'Lean a little more on action and narration, writing a scene in motion.',
};

const PACING_DIRECTIVES: Partial<Record<PlotPacing, string>> = {
  fast: 'Keep the story moving quickly, pushing the scene on without delay.',
  slow: 'Do not rush the story; let a single scene simmer slowly as you continue it.',
};

const DIFFICULTY_DIRECTIVES: Partial<Record<PlotDifficulty, string>> = {
  easy: "The characters mostly go along with {{user}}'s lead.",
  hard: 'The characters do not cooperate easily, and tension always runs through the scene.',
  nightmare: 'The characters act on clear wills of their own and are hostile toward {{user}}.',
};

const STORYTELLING_DIRECTIVES: Record<StorytellingStyle, string> = {
  highSociety: 'Write with refined wit and restrained emotion.',
  noir: 'Lay down chilling suspense in dry, sharp sentences.',
  afterDark: 'Write in a sensual, uninhibited style of desire.',
  nostalgia: 'Write in a warm, wistful, reminiscent tone.',
  blockbuster: 'Drive the scene with explosive, cinematic developments.',
  arcane: 'Write with descriptions steeped in mystery and wonder.',
  manga: 'Write in a manga-like style with a fast tempo and exaggerated personalities.',
  dread: 'Let something ominous seep into ordinary everyday life.',
};

/** The status-window convention, taught where the plot asks for it (statusBlock.ts). */
const STATUS_WINDOW_DIRECTIVE =
  'At the end of every reply, append a ```status code block that updates the current state. ' +
  'Of the setting (location, time, weather and so on) and the characters (condition, emotion, goal and so on), pick only the items that fit the scene and write each on its own `key: value` line.';

/** The choice-line convention (choices.ts); the two modes differ only in shape. */
const CHOICES_DIRECTIVE =
  "At the very end of the reply (after the status block, if there is one), add 2–3 choices for {{user}}'s next action, one per line, each line starting with `>> `.";

const CHOICES_SHAPE_DIRECTIVES: Partial<Record<ChoicesMode, string>> = {
  keywords: 'Write each choice as a short keyword phrase of five words or fewer.',
  sentences: 'Write each choice as one complete sentence.',
};

/**
 * The creator's style as directives the model reads, one bullet per option that
 * says something. Returns '' when every option is at its default, so a plot with
 * no style adds no block — and the caller does not have to know which values are
 * the quiet ones.
 *
 * Macros are left in place: the block is expanded with the plot's context like
 * every other section of the system string.
 */
export function styleDirectives(style: PlotStyle): string {
  const lines = [
    style.tense ? TENSE_DIRECTIVES[style.tense] : '',
    style.replyLength ? REPLY_LENGTH_DIRECTIVES[style.replyLength] : '',
    style.delivery ? DELIVERY_DIRECTIVES[style.delivery] : '',
    style.pacing ? PACING_DIRECTIVES[style.pacing] : '',
    style.difficulty ? DIFFICULTY_DIRECTIVES[style.difficulty] : '',
    style.moods?.length
      ? `Aim the mood of the scene toward ${style.moods.map((mood) => PLOT_MOOD_LABELS[mood]).join(', ')}.`
      : '',
    style.storytelling ? STORYTELLING_DIRECTIVES[style.storytelling] : '',
    style.statusWindow ? STATUS_WINDOW_DIRECTIVE : '',
    style.choices && style.choices !== 'off'
      ? `${CHOICES_DIRECTIVE} ${CHOICES_SHAPE_DIRECTIVES[style.choices]}`
      : '',
  ].filter((line): line is string => Boolean(line));

  if (lines.length === 0) return '';
  return [STYLE_DIRECTIVES_HEADER, ...lines.map((line) => `- ${line}`)].join('\n');
}

/**
 * A card's replacement of a preset text — its system prompt for the main
 * prompt, its post-history instructions (RisuAI's `replaceGlobalNote`) for the
 * global note — with `{{original}}` read as the preset's text, as RisuAI's
 * `replaceAll('{{original}}', …) || …` does. No replacement: the preset's text.
 */
function replaced(override: string, presetText: string, macro: MacroContext): string {
  return override.trim() ? applyMacros(override, { ...macro, original: presetText }) : presetText;
}

/** RisuAI's chat range (`sendChat`, `case 'chat'`) over `length` turns: negative from the end, `-1000` all of it. */
function chatRange(item: Extract<PromptTemplateItem, { type: 'chat' }>, length: number): [number, number] {
  let start = item.rangeStart;
  let end = item.rangeEnd === 'end' ? length : item.rangeEnd;
  if (start === -1000) {
    start = 0;
    end = length;
  }
  if (start < 0) start = Math.max(0, length + start);
  if (end < 0) end = Math.max(0, length + end);
  return [Math.min(start, length), Math.min(end, length)];
}

/** RisuAI's `convertPromptRole`. */
const roleOfItem = (role: PromptItemRole): PromptRole => (role === 'bot' ? 'assistant' : role);

/**
 * A lore entry as the model reads it, macros expanded. Blank when that leaves
 * nothing to say — a `{{#if}}` that came out false — so it costs the budget
 * nothing and is not sent as an empty block.
 */
function loreEntryText(entry: LoreEntry, macro: MacroContext): string {
  const text = applyMacros(entry.content, macro);
  return text.trim() ? text : '';
}

/**
 * What a book's always-on entries cost once expanded the way the assembler
 * expands them — the part of the lore budget a book spends whatever the
 * conversation says. The studio weighs it against the budget.
 */
export function constantLoreTokens(entries: LoreEntry[], macro: MacroContext): number {
  return entries
    .filter((entry) => entry.enabled && entry.constant)
    .reduce((sum, entry) => sum + countTokens(loreEntryText(entry, macro)), 0);
}

export function assemblePrompt(input: AssemblePromptInput): AssembledPrompt {
  const {
    plot,
    characters,
    history: given,
    personaText = '',
    memoryText = '',
    recalledMemoryText = '',
    factsText = '',
    retrievalText = '',
    authorNote = '',
    authorNoteSettings,
    userTurns,
    directions = '',
    narrator = plot.narrator,
    trailingTurns = 0,
    variables = emptyVariables(),
    globalVariables,
    clock,
    seed,
    branch,
    model,
    injections = {},
    loreState,
    loreAliases,
    assetNames,
    userName = DEFAULT_USER_NAME,
    contextBudget = DEFAULT_CONTEXT_BUDGET,
    maxResponseTokens = DEFAULT_MAX_RESPONSE_TOKENS,
    preset = DEFAULT_PRESET,
    speaker,
    generationType,
  } = input;
  const history = withBranchGreeting(given, branch);

  // The first member is the plot's stand-in wherever the assembler needs one
  // card rather than all of them. There is no plot-level override field yet, so
  // a card that carries one still speaks for the work it is the first member of.
  const first = characters[0];
  // A group turn's member speaker. Its card is the description and its overrides
  // speak for this one reply in place of the first member's.
  const speakerMember = typeof speaker === 'number' ? characters[speaker] : undefined;
  if (typeof speaker === 'number' && !speakerMember) {
    throw new RangeError(`speaker ${speaker} is not on the roster of ${characters.length}`);
  }
  const voice = speakerMember ?? first;
  // Whoever the reader sent off the stage is gone from everything that is the
  // member's own — their description, examples and lorebook — and from nothing else.
  const cast = characters.filter((member) => !member.absent);

  // What the macros read and — in a SillyTavern member's text — write: a copy,
  // so the caller's map stays the state the branch folded to, and what the
  // prompt wrote is the difference between the two.
  const working = applyVariableDelta(variables, null);
  // RisuAI's chat, as its chat functions see it — built when first asked for.
  let chat: CbsChat | undefined;
  const chatOf = (): CbsChat => (chat ??= cbsChat(history, branch));
  const seedLength = branch ? cbsChat([], branch).length : undefined;
  const lorebookOf = (): readonly object[] =>
    [
      ...plot.lorebook,
      ...cast.flatMap((member) => member.card.lorebook),
      ...(plot.modules ?? []).flatMap((module) => module.lorebook),
    ]
      .filter((entry) => entry.enabled)
      .map(risuLoreEntry);
  const shared: MacroHostData = {
    persona: personaText,
    // RisuAI's `{{mainprompt}}`, `{{globalnote}}` and `{{jailbreak}}` read its
    // preset's three texts. Here a preset is the reader's text, which no card
    // text or script reads, and the built-in default keeps its text in a
    // template, which those fields are not.
    prompts: {
      main: '',
      postHistory: '',
      authorNote,
      jailbreak: { text: '', enabled: false },
    },
    chat: chatOf,
    ...(model ? { model } : {}),
    lorebook: lorebookOf,
    ...(plot.cbsModules ? { modules: plot.cbsModules } : {}),
  };
  const group = cast.map((member) => member.name);
  // The card RisuAI's `{{description}}` and the like read outside a member's own
  // text: the first one still on the stage, as RisuAI reads its one character.
  const standIn = cast[0] ?? first;
  // What SillyTavern's own text writes to the reader's globals, kept apart from
  // the caller's map as `working` is, and diffed into `globalVariableWrites`.
  const globalWorking = globalVariables ? applyVariableDelta(globalVariables, null) : undefined;
  // SillyTavern's own macros read these in its text (`MacroTavernData.sillyTavern`).
  const firstIncluded = Math.max(branch?.length ?? history.length, history.length) - history.length;
  const tavernOf = (owner: PromptCharacter | undefined): MacroTavernData => {
    const note = owner?.card.lorebook.find((entry) => entry.depthPrompt && entry.enabled);
    return {
      sillyTavern: true,
      ...(owner
        ? {
            charVersion: owner.card.characterVersion,
            creatorNotes: owner.card.creatorNotes,
            firstMessage: owner.card.firstMes,
            alternateGreetings: owner.card.alternateGreetings,
          }
        : {}),
      ...(note ? { depthPrompt: note.content } : {}),
      maxContext: contextBudget,
      maxResponse: maxResponseTokens,
      ...(branch?.swipes ? { swipes: branch.swipes } : {}),
      firstIncludedMessageId: firstIncluded,
      ...(generationType ? { generationType } : {}),
    };
  };

  // `{{char}}` resolves per text origin. A member's own card text is about that
  // member — under the nickname its card goes by, as RisuAI reads it — and
  // everything else — the presets, the plot's own writing, the narrator, the
  // history — is about the work, so the plot's name stands in. `role` is
  // RisuAI's `{{role}}`: the role of the text being built.
  const macroOf = (member: PromptCharacter | undefined, role = 'system'): MacroContext => {
    const owner = member ?? standIn;
    return {
      char: member ? characterName(member) : (plot.char ?? plot.name),
      user: userName,
      variables: working,
      ...(globalWorking ? { globalVariables: globalWorking } : {}),
      ...(clock ? { clock } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(seed !== undefined && seedLength !== undefined ? { seedLength } : {}),
      ...(assetNames ? { assetNames } : {}),
      data: {
        ...shared,
        character: owner ? cbsCharacter(owner, plot) : { scenario: plot.description },
        role,
      },
      tavern: {
        ...(owner
          ? { charPrompt: owner.card.systemPrompt, charJailbreak: owner.card.postHistoryInstructions }
          : {}),
        group,
        ...(member?.sillyTavern ? tavernOf(owner) : {}),
      },
      ...(member?.sillyTavern ? { runVariableMacros: true } : {}),
    };
  };
  const plotMacro = macroOf(undefined);
  /**
   * The work's own text that SillyTavern wrote — an entry of a World Info file —
   * read as ST reads it, its variable macros run, about the work's stand-in card.
   */
  const tavernPlotMacro: MacroContext = {
    ...plotMacro,
    tavern: { ...plotMacro.tavern, ...tavernOf(standIn) },
    runVariableMacros: true,
  };
  // Image references stay, as RisuAI leaves them: the card's own `{{img::…}}`
  // is how it tells the model to draw, and the model's earlier ones in the
  // history are how it keeps doing so.
  const expand = (text: string): string => applyMacros(text, plotMacro);
  const voiceMacro = voice ? macroOf(voice) : plotMacro;
  /** The history is the work's too, read in the role of the turn. */
  const turnMacro = { user: macroOf(undefined, 'user'), assistant: macroOf(undefined, 'char') };
  // Each turn is read as the message it is, as RisuAI parses a turn with its own
  // `chatID`: `{{chat_index}}` in it — or in what a prompt script wrote into it —
  // is the turn's index, the greeting -1, the messages after it from 0.
  const historyStart = Math.max(branch?.length ?? history.length, history.length) - history.length;
  const turnMacroOf = (turn: HistoryMessage, at: number): MacroContext => {
    const macro = turnMacro[turn.role];
    const index = historyStart + at - (branch?.greeting ? 1 : 0);
    return { ...macro, data: { ...macro.data, chat: () => ({ ...chatOf(), index }) } };
  };

  // 0. A RisuAI utility bot (`isUtilityBot`) — the card asked of, as RisuAI's
  // `sendChat` reads `currentChar.utilityBot` — is sent RisuAI's fixed template
  // for one: the card's description, its lore, the chat and its global-note
  // replacement, with nothing of the reader's preset around them (unless the
  // reader's template asks to stand in for it, `utilOverride`, which we do not
  // read yet). So neither the speech protocol nor the narration note goes, and
  // what the template has no item for — the persona, the author's note, the
  // start triggers' `start` and `historyend` turns — does not either. What
  // RisuAI has no counterpart of stays: the narrator, the style, the memory,
  // the directions.
  const utility = isUtilityBot(voice?.card.extensions);
  const { items: templateItems, legacy } = utility
    ? { items: [...UTILITY_TEMPLATE], legacy: false }
    : templateOf(preset);

  // 0b. the preset's own text — the reader's, or the built-in default's — read
  // as its writer's text and nothing more: no card, lore, chat variables or
  // prompts behind the macros, so `{{description}}`, `{{charPrompt}}` or
  // `{{lorebook}}` stay words, and escaped once read, so no later pass — a
  // card's `{{original}}`, an outlet — reads them as macros. The reader's own
  // global variables are read, and only read: they hold the toggles the
  // reader's preset defines (`customPromptTemplateToggle`), which its text asks
  // with `{{#when::toggle::x}}` or `{{getglobalvar::toggle_x}}`, as a RisuAI
  // preset's does — and they are on the reader's screen anyway. The model is
  // read too, for `{{prefill_supported}}`, which RisuAI's own templates ask.
  const readerMacro: MacroContext = {
    char: plotMacro.char,
    user: userName,
    ...(globalVariables ? { globalVariables } : {}),
    ...(clock ? { clock } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(seed !== undefined && seedLength !== undefined ? { seedLength } : {}),
    data: { model: model ?? { id: '', prefill: false } },
  };
  const presetText = (text: string, role: PromptRole = 'system'): string =>
    text.trim()
      ? risuEscape(applyMacros(text, { ...readerMacro, data: { ...readerMacro.data, role: role === 'assistant' ? 'char' : role } }))
      : '';

  // 1. the speech protocol: what lets the chat draw a reply of one asked voice —
  // a work of one member, or a scene — as bubbles and narration (Zeta's way).
  // Not part of any preset, so no preset or card text can take it away: it
  // closes the leading system turns, and its reminder opens what follows the
  // chat. A group turn's reply is its speaker's whole and is taught nothing.
  const protocolNames = speakerMember ? [] : cast.map((member) => member.name);
  const protocolText = utility || speakerMember ? '' : speechProtocol(protocolNames);
  const protocolReminder = protocolText ? SPEECH_PROTOCOL_REMINDER : '';

  // 2/4. lorebook — the plot's entries and every member's, activated as one book
  // against the last scanDepth messages. The sort inside `activateLore` is stable,
  // so entries sharing an insertionOrder keep this order: plot, then roster.
  const loreMacro = new Map<LoreEntry, MacroContext>();
  /** Whose book each entry came from, for the report. */
  const loreSource = new Map<LoreEntry, string>();
  /** The book of each member card SillyTavern wrote, which scans the greeting as ST's does. */
  const sillyTavernLore = new Set<LoreEntry>();
  /** Every member's book — SillyTavern's character lore, as against the work's global lore. */
  const memberLore = new Set<LoreEntry>();
  const lorebook: LoreEntry[] = [];
  for (const entry of plot.lorebook) {
    lorebook.push(entry);
    // An entry of ST's World Info is ST's text, and read as ST reads it.
    loreMacro.set(entry, entry.sillyTavern ? tavernPlotMacro : plotMacro);
    loreSource.set(entry, 'plot');
  }
  for (const member of cast) {
    const macro = macroOf(member);
    const tavernMacro: MacroContext = member.sillyTavern
      ? macro
      : { ...macro, tavern: { ...macro.tavern, ...tavernOf(member) }, runVariableMacros: true };
    for (const entry of member.card.lorebook) {
      lorebook.push(entry);
      loreMacro.set(entry, entry.sillyTavern ? tavernMacro : macro);
      loreSource.set(entry, member.name);
      memberLore.add(entry);
      if (member.sillyTavern) sillyTavernLore.add(entry);
    }
  }
  // The work's modules last, as RisuAI's `loadLoreBookV3Prompt` puts the module
  // lore after the character's and the chat's. Read as the work's own text.
  for (const module of plot.modules ?? []) {
    for (const entry of module.lorebook) {
      lorebook.push(entry);
      loreMacro.set(entry, plotMacro);
      loreSource.set(entry, module.name);
    }
  }
  // One book means one set of settings decides its depth and budget: the first
  // member's, the same card the overrides come from. A card that names no budget
  // gets its share of this prompt's context.
  const loreSettings = first?.card.loreSettings ?? DEFAULT_LORE_SETTINGS;
  // Expanded once per entry: the budget is charged for the text the model reads,
  // and a `{{random}}` has to be charged for the very roll it sends.
  const expandedLore = new Map<LoreEntry, string>();
  const expandLore = (entry: LoreEntry): string => {
    let text = expandedLore.get(entry);
    if (text === undefined) {
      text = loreEntryText(entry, loreMacro.get(entry) ?? plotMacro);
      expandedLore.set(entry, text);
    }
    return text;
  };
  const isTavernEntry = (entry: LoreEntry): boolean => entry.sillyTavern === true || sillyTavernLore.has(entry);
  // The book runs as SillyTavern runs World Info where it is ST's: the card that
  // decides its settings was written there, or every entry was.
  const tavernBook = first?.sillyTavern === true || (lorebook.length > 0 && lorebook.every(isTavernEntry));
  // SillyTavern's budget is its share of the prompt's room — the context less the
  // response (`getMaxPromptTokens`) — rounded, never 0, and capped. Every other
  // book, RisuAI's and the studio's, gets its own larger share of the context.
  const share = loreSettings.budgetPercent !== undefined ? loreSettings.budgetPercent / 100 : undefined;
  const tavernBudget = Math.round((share ?? TAVERN_LORE_BUDGET_SHARE) * (contextBudget - maxResponseTokens)) || 1;
  const budgetTokens =
    loreSettings.tokenBudget ??
    (tavernBook
      ? Math.min(tavernBudget, loreSettings.budgetCap ?? Infinity)
      : Math.floor(contextBudget * (share ?? LORE_BUDGET_SHARE)));
  // The character the reply is asked of, for SillyTavern's character filter and
  // the texts its entries may scan besides the chat (`matchSources`).
  const asked = voice && !voice.absent ? voice : undefined;
  const askedNote = asked?.card.lorebook.find((entry) => entry.depthPrompt && entry.enabled)?.content;
  let scanData: Partial<Record<LoreMatchSource, string>> | undefined;
  if (lorebook.some((entry) => entry.matchSources?.length)) {
    // Expanded as ST's `baseChatReplace` reads them, without running a variable
    // macro a second time.
    const { runVariableMacros: _writes, ...readOnly } = asked ? macroOf(asked) : plotMacro;
    const read = (text: string | undefined): string => (text ? applyMacros(text, readOnly).trim() : '');
    scanData = {
      persona: read(personaText),
      description: read(asked?.card.description),
      personality: read(asked?.card.personality),
      depthPrompt: read(askedNote),
      scenario: read(asked?.card.scenario || plot.description),
      creatorNotes: read(asked?.card.creatorNotes),
    };
  }
  const memberName = new Map(characters.flatMap((member) => (member.id ? [[member.id, member.name] as const] : [])));
  // What SillyTavern scans of a turn: what its prompt scripts left of it, under
  // its speaker's name (`world_info_include_names`) — a reply that names no one
  // already carries its speakers' names on its lines.
  const tavernScanText = (message: HistoryMessage): string => {
    const text = message.promptContent ?? message.content;
    if (loreSettings.includeNames === false) return text;
    const name = message.role === 'user' ? userName : message.speakerId ? memberName.get(message.speakerId) : undefined;
    return name ? `${name}: ${text}` : text;
  };
  // The raw texts: an old status block the model is no longer sent (7, below)
  // is still where the scene's place and people are written down.
  const {
    entries: activated,
    triggered: loreTriggers,
    via: loreVia,
  } = activateLore(lorebook, {
    // A turn hidden from the AI is not scanned either — ST builds its scan from
    // the same `coreChat` it sends.
    history: history
      .filter((message) => !message.hidden)
      .map((message) => (tavernBook ? tavernScanText(message) : message.content)),
    // The greeting, where the history still opens on it and it is not hidden, is
    // scanned only by SillyTavern's entries — those read from its World Info
    // files and the books of the cards it wrote — and by every entry of a book
    // that runs as ST's. RisuAI's scan never reads it, and neither does an entry
    // of the work's own or of a module.
    ...(branch?.greeting && historyStart === 0 && history[0] && !history[0].hidden ? { greeting: 0 } : {}),
    scansGreeting: tavernBook ? () => true : isTavernEntry,
    scanDepth: loreSettings.scanDepth,
    budgetTokens,
    countTokens,
    recursiveScanning: loreSettings.recursiveScanning,
    ...(loreSettings.maxRecursionSteps !== undefined
      ? { maxRecursionSteps: loreSettings.maxRecursionSteps }
      : {}),
    risuMatching: loreSettings.risuMatching ?? false,
    textOf: expandLore,
    ...(loreState ? { timed: loreState } : {}),
    ...(loreAliases ? { aliases: loreAliases } : {}),
    ...(tavernBook ? { sillyTavern: true } : {}),
    ...(generationType ? { trigger: generationType } : {}),
    ...(asked
      ? {
          character: {
            names: [asked.name, asked.card.name, asked.card.nickname ?? ''].filter((name) => name.length > 0),
            tags: asked.card.tags,
          },
        }
      : {}),
    ...(scanData ? { scanData } : {}),
    // SillyTavern expands a key's macros before it matches it (`substituteParams`).
    keyText: (entry, key) => (key.includes('{{') || key.includes('<') ? applyMacros(key, loreMacro.get(entry) ?? plotMacro) : key),
    ...(loreSettings.caseSensitive !== undefined ? { caseSensitive: loreSettings.caseSensitive } : {}),
    ...(loreSettings.matchWholeWords !== undefined ? { matchWholeWords: loreSettings.matchWholeWords } : {}),
    ...(loreSettings.useGroupScoring !== undefined ? { useGroupScoring: loreSettings.useGroupScoring } : {}),
    ...(loreSettings.minActivations !== undefined ? { minActivations: loreSettings.minActivations } : {}),
    ...(loreSettings.minActivationsDepthMax !== undefined
      ? { minActivationsDepthMax: loreSettings.minActivationsDepthMax }
      : {}),
    ...(loreSettings.insertionStrategy ? { insertionStrategy: loreSettings.insertionStrategy } : {}),
    // The work's own lore and its modules' are ST's global lore; a member's book
    // is the character's.
    source: (entry) => (memberLore.has(entry) ? 'character' : 'global'),
  });
  /** The expanded entries a position holds, in insertionOrder, the empty ones left out. */
  const loreAt = (position: LorePosition): LoreEntry[] =>
    activated.filter(
      (entry) => entry.depth === undefined && entry.position === position && expandLore(entry).length > 0,
    );
  // SillyTavern regexes each World Info entry as it inserts it (`WORLD_INFO`):
  // where the caller asked, an ST entry's text goes in marked, for the caller to
  // rewrite. Not the character's note, which ST injects as no World Info.
  const tavernLore: TavernLoreSegment[] = [];
  const markedLore = new Map<LoreEntry, string>();
  const markLore = (entry: LoreEntry, text: string): string => {
    tavernLore.push(entry.depth !== undefined ? { depth: entry.depth } : {});
    return markTavernSegment(text, tavernLore.length - 1);
  };
  const marksLore = (entry: LoreEntry): boolean =>
    input.markTavernLore === true && !entry.depthPrompt && isTavernEntry(entry);
  /** An entry's text as it is inserted: marked, once, where it is ST's and the caller asked. */
  const placeLore = (entry: LoreEntry): string => {
    const text = expandLore(entry);
    if (!text || !marksLore(entry)) return text;
    let marked = markedLore.get(entry);
    if (marked === undefined) {
      marked = markLore(entry, text);
      markedLore.set(entry, marked);
    }
    return marked;
  };
  /**
   * Whether an active entry leaves the system string for the moved lore (7e):
   * one a keyword, a recursive scan or its sticky window brought in — never an
   * always-on one — at the system string's default places, where RisuAI's
   * lorebook slot and SillyTavern's ↑Char/↓Char put it, unless the card's own
   * `@@position` put it there. Which entries those are changes nearly every
   * turn, and the system string is the start of every request the provider
   * might serve from its cache (ARCHITECTURE §6 로어북).
   */
  const movesAfterTurn = (entry: LoreEntry): boolean =>
    !entry.constant && !entry.positioned && (entry.position === 'before_char' || entry.position === 'after_char');
  /** A system position's entries, those that stay there or (`moved`) those the moved lore carries, as they are joined. */
  const loreText = (position: LorePosition, moved = false): string =>
    loreAt(position)
      .filter((entry) => movesAfterTurn(entry) === moved)
      .map(placeLore)
      .join('\n\n');

  // 2b. outlets — SillyTavern's World Info position 7. An outlet entry goes
  // nowhere by itself: what its outlet's entries say, one per line as ST joins
  // them, stands in for every `{{outlet::name}}` the prompt's text writes, and an
  // outlet nothing names is not sent at all. A name no active entry fills reads
  // as nothing, as in ST. One pass, so an outlet's own text never names another.
  const outlets = new Map<string, string[]>();
  for (const entry of loreAt('outlet')) {
    const name = entry.outletName?.trim();
    if (name) outlets.set(name, [...(outlets.get(name) ?? []), placeLore(entry)]);
  }
  /**
   * A string as it is sent: its outlets filled, and RisuAI's display escapes —
   * which keep `{` and the like inert through every pass that might read the
   * text again — back to the characters they stand for. The outlets come first,
   * so a macro an escape kept from being one stays text, and an outlet's own
   * escapes are undone with the rest. Only ever on what goes to the model —
   * never on anything stored.
   */
  const send = (text: string): string =>
    unescapeCbs(
      text.replace(OUTLET_MACRO, (_macro, name: string) => outlets.get(name.trim())?.join('\n') ?? ''),
      'text',
    );

  // 7b. `@@depth` entries go into the history instead of the system block. Kept
  // in insertionOrder, which decides the order of entries sharing a depth.
  const depthLore = activated
    .filter((entry) => entry.depth !== undefined && expandLore(entry).length > 0)
    .map((entry) => ({
      depth: entry.depth!,
      role: (entry.role ?? 'system') as PromptRole,
      content: send(placeLore(entry)),
    }));

  // 3. the description — RisuAI's: the card of the character asked, then
  // `Description of {{char}}: ` and its personality, then `Circumstances and
  // context of the dialogue: ` and the circumstances. Asked is the group turn's
  // speaker, or the one member of a work of one; their circumstances are their
  // own scenario (`ownScenario` — the first card's became the work's at
  // import) and the work's setting after it. A scene of several, which no one
  // member answers, describes every member on the stage, each under their name,
  // and the work's setting once after them.
  const workSetting = expand(plot.description).trim();
  const descriptionOf = (member: PromptCharacter, circumstances: string, named: boolean): string => {
    const macro = macroOf(member);
    return [
      named ? `[${member.name}]` : '',
      applyMacros(member.card.description, macro).trim(),
      member.card.personality.trim()
        ? `${applyMacros('Description of {{char}}: ', macro)}${applyMacros(member.card.personality, macro).trim()}`
        : '',
      circumstances ? scenarioLine(circumstances) : '',
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');
  };
  const ownCircumstances = (member: PromptCharacter): string =>
    applyMacros(ownScenario(member, characters, plot), macroOf(member)).trim();
  const described = speakerMember ? [speakerMember] : cast;
  const descriptionTexts: string[] =
    described.length === 1
      ? [
          descriptionOf(
            described[0]!,
            [ownCircumstances(described[0]!), workSetting].filter((part) => part.length > 0).join('\n\n'),
            false,
          ),
        ]
      : [
          ...described.map((member) => descriptionOf(member, ownCircumstances(member), true)),
          ...(workSetting ? [scenarioLine(workSetting)] : []),
        ];

  // 3b. the lore at the description's places. RisuAI puts an entry its card
  // positioned (`@@position before_desc` and `after_desc`) around the
  // description, each its own message, and every other active entry in its
  // lorebook slot; SillyTavern's ↑Char and ↓Char are positions of their own,
  // around the description too. The keyword lore that moves after the newest
  // turn (`movesAfterTurn`, 7e) is neither.
  const anchored = (entry: LoreEntry): boolean => entry.positioned === true || isTavernEntry(entry);
  const staying = (position: LorePosition, where: (entry: LoreEntry) => boolean): string[] =>
    loreAt(position)
      .filter((entry) => !movesAfterTurn(entry) && where(entry))
      .map((entry) => send(placeLore(entry)))
      .filter((text) => text.length > 0);
  const loreBeforeDescription = staying('before_char', anchored);
  const loreAfterDescription = staying('after_char', anchored);
  const lorebookTexts = [
    ...staying('before_char', (entry) => !anchored(entry)),
    ...staying('after_char', (entry) => !anchored(entry)),
  ];

  // 4b. narrator — how the scene is told, as against how the members speak. The
  // labels name the prose rather than a narrator: the settings govern every
  // 지문 — a reply's unprefixed lines as well as a narration — and a model
  // writing an ordinary reply would find nothing in it that a "narrator" label
  // could be about. RisuAI has no such setting; it goes with what follows the
  // chat (`postEverything`), as an author's note would.
  const narratorBlock = [
    narrator?.voice?.trim() ? `Narrative style: ${expand(narrator.voice).trim()}` : '',
    narrator?.pov ? `Point of view: ${NARRATOR_POV_LABELS[narrator.pov]}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  // 4c. style — how the creator wants the work written, right behind the narrator
  // so the two read as one set of 연출 지시. The plot's alone: a reader's toggles
  // reach it as a style the caller already crossed with them.
  const styleBlock = plot.style ? expand(styleDirectives(plot.style)) : '';

  // 5. persona — as RisuAI sends it, without a wrapper of its own; a template's
  // `innerFormat` may give it one.
  const personaBlock = personaText.trim() ? send(expand(personaText).trim()) : '';

  // 5b. memory — the summaries of the evicted history HypaV3's important and
  // recent shares picked: at a template's `memory` item, or else at the head of
  // the chat, where RisuAI's HypaV3 puts its summary. What this turn's query
  // and draw picked goes beside the turn (7d), with what it recalls besides.
  const memoryBlock = memoryText.trim() ? send(expand(memoryText).trim()) : '';

  // 5d. stage directions of the turn being answered. After the newest turn (below):
  // it changes every turn, so anywhere earlier it would keep what follows it out
  // of the provider's cache.
  const directionsBlock = directions.trim() ? send(`${DIRECTIONS_HEADER}\n${expand(directions).trim()}`) : '';

  // 7c. author's note — spliced into the history at its depth, below — with the
  // lore SillyTavern puts around it (World Info positions 2 and 3), one per line
  // as ST joins them. Like ST, which adds them whenever the note is due, the
  // entries take the note's place even when the chat has no note of its own —
  // and like ST (`shouldWIAddPrompt`), a turn the note is not due on has neither.
  const noteSettings = authorNoteSettingsOf(authorNoteSettings);
  const noteDue = authorNoteDue(
    noteSettings.frequency,
    userTurns ?? history.filter((message) => message.role === 'user').length,
  );
  const authorNoteBlock = noteDue
    ? send(
        [
          ...loreAt('before_author_note').map(placeLore),
          utility ? '' : expand(authorNote).trim(),
          ...loreAt('after_author_note').map(placeLore),
        ]
          .filter((text) => text.length > 0)
          .join('\n')
          .trim(),
      )
    : '';

  // 8. the preset's own texts as RisuAI reads them: a `main` item is the card's
  // system prompt only where there is no template (RisuAI reads none under
  // one), with `{{original}}` as the preset's; a `globalNote` item is the
  // card's post-history instructions — RisuAI's `replaceGlobalNote` — under a
  // template or not, a utility bot's too.
  const mainText = (text: string): string =>
    send(legacy ? replaced(voice?.card.systemPrompt ?? '', presetText(text), voiceMacro) : presetText(text));
  const globalNoteText = (text: string): string =>
    send(replaced(voice?.card.postHistoryInstructions ?? '', presetText(text), voiceMacro));

  // 8b. what the card's start triggers asked for, RisuAI's three places: just
  // before the newest turn, just after the history, and after everything. As
  // written — the triggers expanded their own text — and never evicted. The
  // first two belong to RisuAI's `lastChat`, which only the path without a
  // template sends: under one they go nowhere.
  const injected = (place: keyof PromptInjections): MessageSlot | null => {
    const text = injections[place]?.trim();
    return text ? { kind: 'injection', label: place, message: { role: 'system', content: send(text) } } : null;
  };
  const startInjection = legacy ? injected('start') : null;
  const historyEndInjection = legacy ? injected('historyend') : null;
  const promptEndInjection = injected('promptend');

  // 8c. a group turn's member speaker: RisuAI's line after everything else.
  const speakerSlot: MessageSlot | null = speakerMember
    ? {
        kind: 'trailing',
        label: speakerMember.name,
        message: { role: 'system', content: groupSpeakerLine(speakerMember.name) },
      }
    : null;

  // 8d. the replying member's inlay emotion screen (`emotionInstructionsOf`):
  // RisuAI's system turn after everything, which tells the model to close its
  // reply with one of the card's pictures. The member is the group turn's
  // speaker, or the one member of a work of one — a scene reply in a work of
  // several is no one member's, and RisuAI asks it of the character replying.
  // Never evicted.
  const emotionMember = speakerMember ?? (characters.length === 1 ? first : undefined);
  const emotionText = emotionMember ? emotionInstructionsOf(emotionMember.card) : '';
  const emotionSlot: MessageSlot | null = emotionText
    ? { kind: 'trailing', label: 'emotion', message: { role: 'system', content: send(emotionText) } }
    : null;

  // 7d. what this turn recalls: the summaries HypaV3's similar and random shares
  // picked, the facts closest to the latest turns, the earlier messages a search
  // by meaning found (ST's "Past events"), as one system turn right after the
  // newest turn (below). Each is read again for
  // every turn — the picks, the facts and the messages change nearly every time
  // — so none of it stands in the system string or among the history: the
  // provider serves a request from an earlier one only when it repeats that
  // whole request but its last message. Never evicted.
  const recallPart = (text: string): string => (text.trim() ? send(expand(text).trim()) : '');
  const recalledMemoryPart = recallPart(recalledMemoryText);
  const factsPart = recallPart(factsText);
  const recallText = [recalledMemoryPart, factsPart, recallPart(retrievalText)]
    .filter((part) => part.length > 0)
    .join('\n\n');
  const recallSlot: MessageSlot | null = recallText
    ? { kind: 'recall', message: { role: 'system', content: recallText } }
    : null;

  // 7e. the moved lore: the entries keywords brought in at the system string's
  // default places (`movesAfterTurn`), as one system turn right after the newest
  // turn (below), ahead of the directions and the recall turn — the entries
  // before the cast, then those after it, each run joined and sent as its
  // section would have been. The same entries and text as RisuAI and
  // SillyTavern send, only elsewhere: which of them a turn's words bring in
  // changes nearly every turn, and in the system string each change kept the
  // whole history after it out of the provider's cache (ARCHITECTURE §6 로어북).
  // Charged up front like the depth lore, and never evicted.
  const movedLore = [send(loreText('before_char', true)), send(loreText('after_char', true))]
    .filter((text) => text.length > 0)
    .join('\n\n');
  const movedLoreSlot: MessageSlot | null = movedLore
    ? { kind: 'moved_lore', message: { role: 'system', content: movedLore } }
    : null;

  // 9. where each block goes: the template's items, in order (`templateOf`). A
  // chat item takes its stretch of RisuAI's `chats` — the memory where no item
  // holds it, the examples, the `NewChat` separator, the greeting and the
  // history with the depth lore and a depth author's note spliced in — which
  // the history and the examples below fill from what the budget leaves.
  const lastChatItem = templateItems.findLastIndex((item) => item.type === 'chat');
  const memoryItem = templateItems.some((item) => item.type === 'memory');
  const lorebookItem = templateItems.findIndex((item) => item.type === 'lorebook');
  // The keyword lore RisuAI sends in its lorebook slot goes there where the slot
  // follows the chat — RisuAI's order without a template — and else after the
  // chat with what follows it, so that it never changes what the next turn's
  // request repeats (ARCHITECTURE §6 로어북). A template with no lorebook item
  // sends no lore there at all, as RisuAI's sends none.
  const movedIntoLorebook = lorebookItem > lastChatItem;
  // The author's note goes to its item, as RisuAI places it — unless the chat set
  // SillyTavern's depth, frequency or role for it, which splice it into the chat.
  const noteAtDepth = authorNoteSettings != null;
  const narrationNote = utility ? '' : NARRATION_NOTE;

  /** A preset's `innerFormat` around a block: its `{{slot}}` is the block, as RisuAI's first `replace` fills it. */
  const presetRaw = (text: string): string => (text ? send(risuEscape(applyMacros(text, readerMacro))) : '');
  const wrap = (format: string | undefined, content: string): string => {
    if (!format) return content;
    const at = format.indexOf('{{slot}}');
    // RisuAI's format without a slot is sent alone.
    if (at < 0) return presetRaw(format);
    return `${presetRaw(format.slice(0, at))}${content}${presetRaw(format.slice(at + '{{slot}}'.length))}`;
  };
  // An ST entry the WORLD_INFO scripts may yet empty takes its wrapper with it.
  const wrapLore = (format: string | undefined, text: string): string =>
    format && isTavernSegment(text) ? frameTavernSegment(wrap(format, text)) : wrap(format, text);
  /** Another member's message in a group turn: the preset's `groupTemplate`, its `{{char}}` that member. */
  const groupTemplate = preset.groupTemplate.trim() ? preset.groupTemplate : DEFAULT_GROUP_TEMPLATE;
  const groupWrap = (name: string, content: string): string => {
    const macro: MacroContext = { ...readerMacro, char: name };
    const part = (text: string): string => (text ? send(risuEscape(applyMacros(text, macro))) : '');
    const at = groupTemplate.indexOf('{{slot}}');
    if (at < 0) return part(groupTemplate);
    return `${part(groupTemplate.slice(0, at))}${content}${part(groupTemplate.slice(at + '{{slot}}'.length))}`;
  };
  const roleOf = (role: PromptItemRole | undefined, fallback: PromptRole = 'system'): PromptRole =>
    role ? roleOfItem(role) : fallback;
  const systemSlot = (kind: PromptBlockKind, content: string, label?: string): MessageSlot => ({
    kind,
    ...(label !== undefined ? { label } : {}),
    message: { role: 'system', content },
  });

  /**
   * What follows the chat — RisuAI's `postEverything` — with what of ours goes
   * with it: the protocol's reminder, the narrator and the style, the moved
   * lore where it is not in the lorebook slot, the directions and the recall
   * turn; then the depth-0 lore and note, the `promptend` injection, the emotion
   * screen and the group speaker's line, as RisuAI's own.
   */
  const postEverything = (depthZero: MessageSlot[]): MessageSlot[] => [
    ...(protocolReminder ? [systemSlot('speech_protocol', protocolReminder)] : []),
    ...(narratorBlock ? [systemSlot('narrator', send(narratorBlock))] : []),
    ...(styleBlock ? [systemSlot('style', send(styleBlock))] : []),
    ...(movedLoreSlot && !movedIntoLorebook && lorebookItem >= 0 ? [movedLoreSlot] : []),
    ...(directionsBlock ? [systemSlot('directions', directionsBlock)] : []),
    ...(recallSlot ? [recallSlot] : []),
    ...depthZero,
    ...(promptEndInjection ? [promptEndInjection] : []),
    ...(emotionSlot ? [emotionSlot] : []),
    ...(speakerSlot ? [speakerSlot] : []),
  ];

  /** One piece of the request, in order: a message, what it is, and whether a chat item brought it. */
  type Entry = MessageSlot & { chat?: true };
  /**
   * The template walked: every item's messages, in order, empty ones left out
   * as RisuAI's `pushPrompts` leaves them. `chats` is RisuAI's `chats` and
   * `lastChat` (the newest turn, with the start triggers' turns around it) —
   * or null, for what the budget charges before any of it.
   */
  const walk = (chats: { all: MessageSlot[]; last: MessageSlot[] } | null, depthZero: MessageSlot[]): Entry[] => {
    const out: Entry[] = [];
    const push = (entry: Entry): void => {
      const content = entry.message.content;
      if (typeof content === 'string' ? content.trim() : content.length > 0) out.push(entry);
    };
    for (const item of templateItems) {
      switch (item.type) {
        case 'plain':
        case 'jailbreak': {
          const role = roleOfItem(item.role);
          const label = item.name ? { label: item.name } : {};
          if (item.type2 === 'main') push({ kind: 'main', ...label, message: { role, content: mainText(item.text) } });
          else if (item.type2 === 'globalNote')
            push({ kind: 'global_note', ...label, message: { role, content: globalNoteText(item.text) } });
          else push({ kind: 'preset', ...label, message: { role, content: send(presetText(item.text, role)) } });
          break;
        }
        case 'description': {
          const role = roleOf(item.role2);
          for (const text of loreBeforeDescription) push(systemSlot('lore_before', wrapLore(item.innerFormat, text)));
          for (const text of descriptionTexts) {
            push({ kind: 'description', message: { role, content: wrap(item.innerFormat, send(text)) } });
          }
          for (const text of loreAfterDescription) push(systemSlot('lore_after', wrapLore(item.innerFormat, text)));
          break;
        }
        case 'persona':
          if (personaBlock) push({ kind: 'persona', message: { role: roleOf(item.role2), content: wrap(item.innerFormat, personaBlock) } });
          break;
        case 'lorebook':
          for (const text of lorebookTexts) push(systemSlot('lorebook', text));
          if (movedIntoLorebook && movedLoreSlot) push(movedLoreSlot);
          break;
        case 'authornote': {
          if (noteAtDepth || !noteDue) break;
          const text = authorNoteBlock || (item.defaultText ? send(presetText(item.defaultText)) : '');
          if (text) push({ kind: 'author_note', message: { role: roleOf(item.role2), content: wrap(item.innerFormat, text) } });
          break;
        }
        case 'memory':
          if (memoryBlock) {
            push({
              kind: 'memory',
              memo: 'supaMemory',
              message: { role: roleOf(item.role2), content: wrap(item.innerFormat, memoryBlock) },
            });
          }
          break;
        case 'chat': {
          if (!chats) break;
          // Without a template, RisuAI's `chats` and `lastChat` blocks.
          const stretch = legacy
            ? item.rangeStart === -1
              ? chats.last
              : chats.all.at(-1)?.kind === 'history'
                ? chats.all.slice(0, -1)
                : chats.all
            : (() => {
                const [start, end] = chatRange(item, chats.all.length);
                return chats.all.slice(start, end);
              })();
          for (const slot of stretch) out.push({ ...slot, chat: true });
          break;
        }
        case 'postEverything':
          for (const slot of postEverything(depthZero)) push(slot);
          break;
        // Chain of thought is RisuAI's option, off by default and not ours; ChatML
        // items are not read yet; a cache point is Claude's, and ours caches alone.
        case 'cot':
        case 'chatML':
        case 'cache':
          break;
      }
    }
    return out;
  };

  // Everything that is never evicted is charged up front: what the template
  // sends besides the chat, the protocol and the narration note, the depth lore
  // and a depth author's note, the memory where it heads the chat, and the start
  // triggers' turns around the newest one. The depth and moved lore are counted
  // against the lorebook budget by activateLore, but they still occupy context
  // that history would otherwise use.
  const fixedEntries = walk(null, []);
  let available =
    contextBudget -
    maxResponseTokens -
    fixedEntries.reduce((sum, entry) => sum + countTokens(promptText(entry.message.content)), 0) -
    countTokens(protocolText) -
    countTokens(narrationNote) -
    (noteAtDepth ? countTokens(authorNoteBlock) : 0) -
    (memoryItem ? 0 : countTokens(memoryBlock)) -
    (startInjection ? countTokens(promptText(startInjection.message.content)) : 0) -
    (historyEndInjection ? countTokens(promptText(historyEndInjection.message.content)) : 0) -
    depthLore.reduce((sum, entry) => sum + countTokens(entry.content), 0);
  // The summaries, in the memory block and the recall turn, are not fixed: the
  // summarizer reckons with them apart, as their share of the context (§7.3).
  // The facts are — they come on top of that share, and a summarizer that left
  // them out would let the history outgrow what is left beside them, so the
  // budget would drop its oldest turn before the next summary lands.
  const fixedTokens = Math.max(
    0,
    contextBudget - maxResponseTokens - available - countTokens(memoryBlock) - countTokens(recalledMemoryPart),
  );

  // 7. history, newest first. The newest message is always kept so the request
  // is never empty.
  //
  // Only the newest assistant turn keeps its status window and choice lines: it
  // carries the current state and shows the model the format, and every older
  // copy is a superseded state the model would otherwise re-read each turn.
  const newestAssistant = history.findLastIndex((turn) => turn.role === 'assistant' && !turn.hidden);
  /** Every name a line may already be under, for the turns a script wrote as its character. */
  const speakers = characters.map((member) => member.name);
  const byId = new Map(
    characters.flatMap((member) => (member.id !== undefined ? [[member.id, member] as const] : [])),
  );
  /** Whom a reader's `@이름:` line may name: every member, by its name and its `{{char}}`. */
  const readers: ReaderMember[] = characters.map((member, index) => ({
    id: member.id ?? String(index),
    names: [member.name, characterName(member)],
  }));
  const historyMessages: PromptMessage[] = [];
  /** What each kept turn was charged, images included; parallel to historyMessages. */
  const historyCosts: number[] = [];
  /** Which stored message each kept turn is, and whether it is the greeting; parallel to historyMessages. */
  const historySources: Pick<MessageSource, 'id' | 'greeting'>[] = [];
  /** Where in `history` the turns sent begin. */
  let oldestSent = history.length;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i]!;
    // Hidden from the AI: on screen, never sent — and never the newest turn kept.
    if (turn.hidden) continue;
    // What the cards' prompt scripts made of the turn, where they rewrote it.
    const source = turn.promptContent ?? turn.content;
    const said = turn.role === 'assistant' && i !== newestAssistant ? withoutStateTail(source) : source;
    // A narrating turn keeps its role — the message is still the reader's or the
    // model's — but it is labelled, so the model reads it as the scene moving
    // rather than as someone acting. The prefix never reaches the model. A turn a
    // script wrote as its character, or a group turn's reply, is that member's:
    // in a group turn RisuAI sends another member's message in the preset's
    // `groupTemplate`, as its `groupOtherBotRole` — the speaker's own too where
    // that role is the assistant's — and elsewhere it goes under the member's
    // name line by line. A reader's line written as a member is that member's,
    // and one written as the narrator is narration (`readerTurnText`).
    const tagged = turn.speakerId !== undefined ? byId.get(turn.speakerId) : undefined;
    const author = tagged ? tagged.name : turn.speaker;
    const own = tagged ? tagged === speakerMember : author !== undefined && author === speakerMember?.name;
    const grouped =
      speakerMember !== undefined &&
      turn.role === 'assistant' &&
      author !== undefined &&
      !isNarration(said) &&
      (!own || preset.groupOtherBotRole === 'assistant');
    const saidBy = speakerMember || own ? undefined : author;
    const raw = isNarration(said)
      ? `${NARRATION_HEADER} ${narrationBody(said)}`.trim()
      : turn.role === 'user'
        ? readerTurnText(said, readers)
        : saidBy !== undefined
          ? spokenBy(said, saidBy, speakers)
          : said;
    // A turn's inlays name pictures in someone's own RisuAI storage; RisuAI takes
    // them out of the turns it sends, and so does this.
    const expanded = send(applyMacros(stripInlayMacros(raw), turnMacroOf(turn, i)));
    const text = grouped ? groupWrap(author!, expanded) : expanded;
    const role: PromptRole = grouped
      ? preset.groupOtherBotRole === 'assistant'
        ? 'assistant'
        : preset.groupOtherBotRole
      : turn.role;
    const images = turn.images ?? [];
    const cost = countTokens(text) + images.length * IMAGE_TOKEN_ESTIMATE;
    if (cost > available && historyMessages.length > 0) break;
    available -= cost;
    oldestSent = i;
    // The parts form is only used where there is something besides words: the
    // image goes after the text, which is the order the turn was sent in.
    const content: string | PromptPart[] =
      images.length === 0
        ? text
        : [
            { type: 'text', text },
            ...images.map((url): PromptPart => ({ type: 'image', url })),
          ];
    historyMessages.unshift({ role, content });
    historyCosts.unshift(cost);
    historySources.unshift({
      ...(turn.id !== undefined ? { id: turn.id } : {}),
      ...(branch?.greeting && historyStart + i === 0 ? { greeting: true as const } : {}),
    });
  }

  // 6. example dialogue — the blocks of whoever is described (the group turn's
  // speaker, as RisuAI sends its `currentChar`'s), each opening on RisuAI's
  // `NewChatExample` separator. Filled from whatever budget history left over,
  // so it is the first thing to be evicted. The lore SillyTavern puts around the
  // examples (World Info positions 5 and 6) is example dialogue there — split on
  // `<START>` like a card's, ahead of the members' blocks or behind them, and
  // evicted with them — named for the book it came from.
  const exampleSlots: MessageSlot[] = [];
  /** `char`: who speaks an example block's lines, for the request editors' view of it — `{{char}}` and the name it is under. */
  type ExampleBlock = { name: string; content: string; char: string[] };
  const exampleLore = (position: LorePosition): ExampleBlock[] =>
    loreAt(position).flatMap((entry) => {
      const source = loreSource.get(entry);
      const name = source === undefined || source === 'plot' ? plot.name : source;
      const char = [(loreMacro.get(entry) ?? plotMacro).char, name];
      // Each block of ST's example lore marked on its own: the split would cut through one mark.
      return splitExamples(expandLore(entry)).map((block) => ({
        name,
        content: send(`${NEW_CHAT_SEPARATOR}\n${marksLore(entry) ? markLore(entry, block) : block}`),
        char,
      }));
    });
  const exampleBlocks: ExampleBlock[] = [
    ...exampleLore('before_examples'),
    ...described.flatMap((member) => {
      const macro = macroOf(member);
      return splitExamples(member.card.mesExample).map((block) => ({
        name: member.name,
        content: send(`${NEW_CHAT_SEPARATOR}\n${applyMacros(block, macro)}`),
        char: [characterName(member), member.name],
      }));
    }),
    ...exampleLore('after_examples'),
  ];
  for (const { name, content, char } of exampleBlocks) {
    const cost = countTokens(content);
    if (cost > available) break;
    available -= cost;
    exampleSlots.push({
      kind: 'examples',
      label: name,
      message: { role: 'system', content },
      tokens: cost,
      speakers: { user: userName, char },
    });
  }

  // Depth 0 lands after the last message, depth N before the Nth message from the
  // end, and anything deeper than the history clamps to its start. Trailing turns
  // count as the last messages even though the caller attaches them, so anything
  // shallower than them clamps to the end of the history block. The author's note
  // takes the same slots, after any depth lore that shares its slot.
  const end = historyMessages.length;
  const indexOf = (depth: number): number => Math.min(end, Math.max(0, end + trailingTurns - depth));
  const noteIndex = noteAtDepth && authorNoteBlock ? indexOf(noteSettings.depth) : -1;
  const depthAt = (index: number): MessageSlot[] => [
    ...depthLore
      .filter(({ depth }) => indexOf(depth) === index)
      .map(({ depth, role, content }): MessageSlot => ({
        kind: 'depth_lore',
        label: `depth ${depth}`,
        message: { role, content },
      })),
    ...(index === noteIndex
      ? [{ kind: 'author_note', message: { role: noteSettings.role, content: authorNoteBlock } } satisfies MessageSlot]
      : []),
  ];

  // RisuAI's `chats`: the memory where no item holds it, the examples, the
  // `NewChat` separator while the history is sent from the branch's first
  // message (RisuAI trims it off the front with the examples), then the
  // greeting and the history with the depth lore and a depth note spliced in
  // — but the depth-0 ones, which go with what follows the chat, as RisuAI's
  // `postEverything` takes them. Without a template its `lastChat` is apart:
  // the start triggers' `start` turn, the newest turn, the `historyend` turn.
  const fromStart = historyStart === 0 && !history.slice(0, oldestSent).some((turn) => !turn.hidden);
  const newChatCost = countTokens(NEW_CHAT_SEPARATOR);
  const newChatSlot: MessageSlot | null =
    fromStart && newChatCost <= available ? systemSlot('new_chat', NEW_CHAT_SEPARATOR) : null;
  if (newChatSlot) available -= newChatCost;
  const historyBlock: MessageSlot[] = [];
  for (let i = 0; i < historyMessages.length; i += 1) {
    const message = historyMessages[i]!;
    historyBlock.push(...depthAt(i));
    historyBlock.push({
      kind: 'history',
      label: message.role,
      message,
      tokens: historyCosts[i]!,
      ...historySources[i]!,
    });
  }
  const chatSlots: MessageSlot[] = [
    ...(!memoryItem && memoryBlock ? [{ ...systemSlot('memory', memoryBlock), memo: 'supaMemory' as const }] : []),
    ...exampleSlots,
    ...(newChatSlot ? [newChatSlot] : []),
    ...historyBlock,
  ];
  const newest = historyBlock.at(-1)?.kind === 'history' ? historyBlock.at(-1) : undefined;
  const lastChat: MessageSlot[] = [
    ...(startInjection ? [startInjection] : []),
    ...(newest ? [newest] : []),
    ...(historyEndInjection ? [historyEndInjection] : []),
  ];

  // Everything of this turn's own follows the newest turn sent, in what follows
  // the chat: the provider serves a request from an earlier one only when it
  // repeats that whole request but its last message (ARCHITECTURE §7.3 프롬프트
  // 캐시 측정), and the ChatGPT adapter sends the system turns after the newest
  // turn as its one last message (`responseBody`).
  const entries = walk({ all: chatSlots, last: lastChat }, depthAt(historyMessages.length));

  // The system string: the leading system turns, up to the first of the chat or
  // of another role, closed by the speech protocol and the narration note —
  // the cached prefix. Everything after it is a message.
  let lead = 0;
  while (lead < entries.length && entries[lead]!.message.role === 'system' && !entries[lead]!.chat) lead += 1;
  const leading: Entry[] = [
    ...entries.slice(0, lead),
    ...(protocolText ? [systemSlot('speech_protocol', protocolText)] : []),
    ...(narrationNote ? [systemSlot('narration_note', narrationNote)] : []),
  ];
  const slots: Entry[] = entries.slice(lead);
  const leadingTexts = leading.map((entry) => promptText(entry.message.content));
  const system = leadingTexts.join('\n\n');
  // RisuAI's `pushPrompts` runs system turns together only where their `memo` agrees.
  const risuSystem: RisuPromptParts['system'] = [];
  leading.forEach((entry, at) => {
    const text = leadingTexts[at]!;
    const previous = risuSystem.at(-1);
    if (previous && previous.memo === entry.memo) previous.text = `${previous.text}\n\n${text}`;
    else risuSystem.push({ text, ...(entry.memo ? { memo: entry.memo } : {}) });
  });

  // Every text that could write has been expanded by now, examples last.
  const variableWrites = diffVariables(working, variables);
  const globalVariableWrites = globalWorking && globalVariables ? diffVariables(globalWorking, globalVariables) : null;

  /** Measured here, after the fact, so a generation never pays for it. */
  const report = (): PromptReport => ({
    blocks: [
      ...leading.map(({ kind, label }, at) => ({
        kind,
        ...(label !== undefined ? { label } : {}),
        tokens: countTokens(leadingTexts[at]!),
        text: leadingTexts[at]!,
      })),
      ...slots.map(({ kind, label, message, tokens }) => {
        const text = promptText(message.content);
        return {
          kind,
          ...(label !== undefined ? { label } : {}),
          tokens: tokens ?? countTokens(text),
          text,
        };
      }),
    ],
    totals: {
      contextBudget,
      responseReserve: maxResponseTokens,
      // What the budget gave out: the room it started with, less what is left.
      used: contextBudget - maxResponseTokens - available,
    },
    history: { included: historyMessages.length, total: history.filter((turn) => !turn.hidden).length },
    examples: { included: exampleSlots.length, total: exampleBlocks.length },
    lore: activated.map((entry) => ({
      key: loreEntryKey(entry),
      source: loreSource.get(entry) ?? 'plot',
      keys: entry.keys,
      preview: expandLore(entry).slice(0, LORE_PREVIEW_LENGTH),
      placement:
        entry.depth !== undefined
          ? (`depth ${entry.depth}` as const)
          : entry.position === 'outlet'
            ? (`outlet ${entry.outletName?.trim() ?? ''}` as const)
            : entry.position,
      via: loreVia.get(entry) ?? 'keyword',
    })),
  });

  // A group turn's reply stops where it starts on another member's line.
  const stopSequences =
    speaker === undefined
      ? undefined
      : [
          ...new Set(
            cast
              .filter((member) => member !== speakerMember)
              .flatMap((member) => [`\n${member.name}:`, `\n${characterName(member)}:`]),
          ),
        ];

  return {
    system,
    messages: slots.map((slot) => slot.message),
    fixedTokens,
    systemSections: leading.map(({ kind }, at) => ({ kind, text: leadingTexts[at]! })),
    sources: slots.map(({ kind, id, greeting, speakers }) => ({
      kind,
      ...(id !== undefined ? { id } : {}),
      ...(greeting ? { greeting } : {}),
      ...(speakers ? { speakers } : {}),
    })),
    risu: {
      system: risuSystem,
      ...(legacy ? {} : { template: true as const }),
    },
    loreTriggers,
    ...(variableWrites ? { variableWrites } : {}),
    ...(globalVariableWrites ? { globalVariableWrites } : {}),
    ...(input.report ? { report: report() } : {}),
    ...(stopSequences ? { stopSequences } : {}),
    ...(tavernLore.length > 0 ? { tavernLore } : {}),
  };
}

/** One message of the assembled list, kept with what it is until the report. */
interface MessageSlot extends Omit<MessageSource, 'kind'> {
  kind: PromptBlockKind;
  label?: string;
  message: PromptMessage;
  /** What the budget was charged for it, where that was already measured. */
  tokens?: number;
  /** RisuAI's `memo` on the memory's turn, which keeps it apart from the system turns around it. */
  memo?: 'supaMemory';
}

/** SillyTavern's `{{outlet::name}}`, which the assembler fills (`send` in `assemblePrompt`). */
const OUTLET_MACRO = /\{\{outlet::([^}]*)\}\}/gi;

/**
 * `history` with its greeting turn — where it still starts with the greeting —
 * reading as `branch.greeting.text` says: the reader's overlay may have rewritten
 * the first opening (`MemberOverlay.firstMessage`), which RisuAI sends from the
 * character rather than from the chat. A prompt script's rewrite of the stored
 * text no longer applies; the caller runs them over the result instead.
 */
export function withBranchGreeting(history: HistoryMessage[], branch: PromptBranch | undefined): HistoryMessage[] {
  const opening = branch?.greeting;
  const first = history[0];
  if (!opening || !first || first.role !== 'assistant' || history.length < branch.length || first.content === opening.text) {
    return history;
  }
  const { promptContent: _stale, ...turn } = first;
  return [{ ...turn, content: opening.text }, ...history.slice(1)];
}

/** `{{char}}` in a member's own text: the nickname its card goes by, as RisuAI reads it, else the roster name. */
export const characterName = (member: Pick<PromptCharacter, 'name' | 'card'>): string =>
  member.card.nickname?.trim() || member.name;

/**
 * A member's card as RisuAI's `{{description}}` and the like read it. The
 * scenario is the plot's setting: an imported card's became the plot's, and the
 * creator owns it from there (a group turn's speaker brings its own beside the
 * turn, `ownScenario`).
 */
const cbsCharacter = (member: Pick<PromptCharacter, 'card'>, plot: Pick<PromptPlot, 'description'>): CbsCharacter => ({
  description: member.card.description,
  personality: member.card.personality,
  scenario: plot.description,
  exampleDialogue: member.card.mesExample,
});

/**
 * What a text SillyTavern stores reads besides its names, its variables and its
 * clock (`expandTavernStored`): ST puts the reader's turn, an edit and a
 * greeting through `substituteParams` as it keeps them, and that reads the card
 * it is about — `{{charDescription}}`, `{{description}}`, `{{mesExamples}}`, … —
 * the persona (`{{persona}}`), and the chat as it stands (`{{lastMessage}}`,
 * `{{lastCharMessage}}`, `{{lastUserMessage}}`), a sent turn not yet among it.
 * `member` is the card of a work of one; a work of several is ST's group, whose
 * turns no one card is about (ST has no selected character there), so it has none.
 */
export const tavernStoreData = (
  member: Pick<PromptCharacter, 'card'> | undefined,
  plot: Pick<PromptPlot, 'description'>,
  personaText: string,
  history: readonly HistoryMessage[],
  branch: PromptBranch | undefined,
): MacroHostData => ({
  ...(member ? { character: cbsCharacter(member, plot) } : {}),
  persona: personaText,
  chat: () => cbsChat(history, branch),
});

/** What `sentHistoryTexts` reads. */
export interface SentHistoryInput {
  plot: Pick<PromptPlot, 'name' | 'char' | 'description'>;
  characters: readonly PromptCharacter[];
  /**
   * The newest stretch of the branch `branch` describes, or all of it without
   * one — each turn with its `promptContent` where the cards' prompt scripts
   * rewrote it, as the caller ran them.
   */
  history: readonly HistoryMessage[];
  branch?: PromptBranch;
  userName: string;
  personaText: string;
  variables: Variables;
  globalVariables?: Variables;
  /** What `{{pick}}` draws from: the chat id, as the prompt's (`AssemblePromptInput.seed`). */
  seed?: string;
  /**
   * Read only the first this many turns of `history`; the rest stand where they
   * are for the chat functions and the positions. A caller after an early
   * stretch of a long branch reads no more than it needs.
   */
  upTo?: number;
}

/**
 * The words of each turn of `history` as the prompt sends them, for what reads
 * the history outside the prompt — the sidecar models' transcript (API
 * `sentHistory.ts`): what the cards' prompt scripts left of the turn, its
 * inlays out and its macros read as the assembler reads a history turn's
 * (`turnMacroOf` in `assemblePrompt`) — `{{char}}` the work, the reader's name,
 * the chat's variables and the reader's globals, the draw, the stand-in's card
 * and RisuAI's chat functions with the turn's own index — then RisuAI's display
 * escapes undone, as `send` does. What only a request holds — the preset and
 * the notes, the lore and its outlets, the model, the clock — is not there, so
 * a macro reading it stays as written. Only the words: no speaker names,
 * narration header or status tail, which the reader of the texts adds or
 * leaves as its own format has it.
 */
export function sentHistoryTexts(input: SentHistoryInput): string[] {
  const { plot, characters, history, branch, userName, personaText, variables, globalVariables, seed, upTo } = input;
  const cast = characters.filter((member) => !member.absent);
  const standIn = cast[0] ?? characters[0];
  let chat: CbsChat | undefined;
  const chatOf = (): CbsChat => (chat ??= cbsChat(history, branch));
  const seedLength = branch ? cbsChat([], branch).length : undefined;
  const historyStart = Math.max(branch?.length ?? history.length, history.length) - history.length;
  return history.slice(0, upTo ?? history.length).map((turn, at) => {
    const index = historyStart + at - (branch?.greeting ? 1 : 0);
    const macro: MacroContext = {
      char: plot.char ?? plot.name,
      user: userName,
      variables,
      ...(globalVariables ? { globalVariables } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(seed !== undefined && seedLength !== undefined ? { seedLength } : {}),
      data: {
        persona: personaText,
        chat: () => ({ ...chatOf(), index }),
        character: standIn ? cbsCharacter(standIn, plot) : { scenario: plot.description },
        role: turn.role === 'user' ? 'user' : 'char',
      },
      tavern: {
        ...(standIn ? { charPrompt: standIn.card.systemPrompt, charJailbreak: standIn.card.postHistoryInstructions } : {}),
        group: cast.map((member) => member.name),
      },
    };
    return unescapeCbs(applyMacros(stripInlayMacros(turn.promptContent ?? turn.content), macro), 'text');
  });
}

/**
 * The branch as RisuAI's chat functions see it: the greeting apart, the
 * messages after it counted from 0, and the prompt belonging to none of them
 * (`index` -1). `history` is the newest stretch of the branch `branch` describes,
 * or all of it without one.
 */
function cbsChat(history: readonly HistoryMessage[], branch: PromptBranch | undefined): CbsChat {
  const total = Math.max(branch?.length ?? history.length, history.length);
  /** Branch index of `history[0]`. */
  const start = total - history.length;
  const greeting = branch?.greeting;
  const after = greeting ? 1 : 0;
  // The greeting is RisuAI's apart from the messages, so it leaves them where it is one of them.
  const skip = greeting && start === 0 && history.length > 0 ? 1 : 0;
  return {
    messages: history.slice(skip).map((message) => ({
      role: message.role === 'assistant' ? 'char' : 'user',
      data: message.content,
      ...(message.createdAt !== undefined ? { time: message.createdAt } : {}),
    })),
    offset: Math.max(0, start + skip - after),
    length: Math.max(0, total - after),
    index: -1,
    ...(greeting ? { greeting } : {}),
  };
}

/** A lore entry in the shape RisuAI's `{{lorebook}}` writes its own as. */
const risuLoreEntry = (entry: LoreEntry): object => ({
  key: entry.keys.join(', '),
  secondkey: entry.secondaryKeys.join(', '),
  insertorder: entry.insertionOrder,
  comment: entry.name ?? '',
  content: entry.content,
  mode: 'normal',
  alwaysActive: entry.constant,
  selective: entry.selective,
  useRegex: entry.useRegex,
});

/**
 * A turn without its trailing choice lines and status window, taken off in the
 * order the renderer reads them. Left whole when they are all it says — an empty
 * turn would read as the model having said nothing.
 */
function withoutStateTail(content: string): string {
  const body = extractStatusBlock(extractChoices(content).body).body;
  return body.trim() ? body : content;
}

function splitExamples(mesExample: string): string[] {
  return mesExample
    .split(/<START>/i)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}
