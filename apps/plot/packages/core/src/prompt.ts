import { unescapeCbs, type CbsChat, type CbsCharacter, type CbsModel } from './cbs.js';
import { extractChoices } from './choices.js';
import { applyMacros, stripInlayMacros, type MacroClock, type MacroContext, type MacroHostData } from './macro.js';
import { activateLore, loreEntryKey, type LoreActivationVia, type LoreTimedState } from './lorebook.js';
import { isNarration, narrationBody } from './narration.js';
import { readerLine, spokenBy, type ReaderMember } from './speech.js';
import type { NarratorSpeaker } from './group.js';
import {
  DEFAULT_PRESET,
  GROUP_SPEECH_PROTOCOL,
  GROUP_SPEECH_PROTOCOL_REMINDER,
  groupPreset,
  REPLY_FORMAT_HINT,
  SPEECH_PROTOCOL,
  SPEECH_PROTOCOL_REMINDER,
  type Preset,
} from './presets.js';
import { extractStatusBlock } from './statusBlock.js';
import { countTokens } from './tokens.js';
import {
  DEFAULT_LORE_SETTINGS,
  type LoreEntry,
  type LorePosition,
  type NarratorConfig,
  type NarratorPov,
  type NormalizedCard,
  type ReplyLength,
  type PlotDifficulty,
  type PlotMood,
  type PlotPacing,
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
   * and RisuAI's `{{char}}` follows the rename. The `[작품: …]` header keeps `name`.
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
   * Rolling summary (and retrieved facts) of the turns that no longer fit, already
   * formatted into blocks. Injected right after the persona.
   */
  memoryText?: string;
  /**
   * Relationship state block (the six axes plus a one-line summary), already
   * formatted. Injected right after the memory, so the model sees who the two
   * are to each other before it reads the turns.
   */
  relationshipText?: string;
  /**
   * Author's note. Injected as a system message `AUTHOR_NOTE_DEPTH` messages from
   * the end of the history and, like the post-history block, never evicted.
   */
  authorNote?: string;
  /**
   * Stage directions carried by the *last* user message — what a game component
   * decided about the turn the user just took. Injected as a `[게임 판정]` system
   * block ahead of the example dialogue, so it lands after the whole cached
   * prefix (the merged system string) and never invalidates it. Earlier turns'
   * directions are not injected: they already had their effect.
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
  /** The names this chat's open images go by, for {{assetlist}} (`MacroContext.assetNames`). */
  assetNames?: readonly string[];
  contextBudget?: number;
  maxResponseTokens?: number;
  preset?: Preset;
  /**
   * Also say how the prompt was put together (`PromptReport`). Off for every
   * generation: it measures each block again, which only the inspector needs.
   */
  report?: boolean;
  /**
   * Who a group turn asks the reply of (`group.ts`): an index into `characters`,
   * or `NARRATOR_SPEAKER`. Without it the prompt is the scene's, as it has always
   * been.
   *
   * A member: their card's system and post-history overrides stand in for the
   * first member's (read with `{{char}}` as them), the preset teaches
   * `GROUP_SPEECH_PROTOCOL` in place of the speech protocol (`groupPreset`), their
   * own past replies go plain while everyone else's go under their names, and the
   * prompt closes on `groupSpeakerLine`. The member is expected to be on the stage.
   *
   * The narrator: the scene prompt as a narration has always been built on — the
   * caller still closes it with the narration nudge — with every member's reply
   * under its name.
   *
   * Either way the result carries `stopSequences`.
   */
  speaker?: number | NarratorSpeaker;
  /**
   * The reply is a narration (the narration button): the scene told, with no
   * one's lines in it, so the reply format hint (`REPLY_FORMAT_HINT`) is left out.
   * The narrator's group turn (`speaker`) is one without being told.
   */
  narration?: boolean;
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
  /** Present only when the input asked for it. */
  report?: PromptReport;
  /**
   * What each of `messages` is, in order — the block it was put together as,
   * and for a turn of the chat the stored message it came from. A card's
   * request editors read them as RisuAI's item fields (`risuRequestExtras`).
   * Always there from the assembler; gone once the request was edited, when
   * they no longer line up.
   */
  sources?: MessageSource[];
  /**
   * For a group turn (`AssemblePromptInput.speaker`): where the reply has strayed
   * into another member's line — `\n이름:` and `\n별명:` of every member on the
   * stage but the speaker. The caller stops the stream on them.
   */
  stopSequences?: string[];
}

/** What each piece of an assembled prompt is, in the creator's prompt inspector. */
export type PromptBlockKind =
  | 'main'
  | 'format'
  | 'narration_note'
  | 'lore_before'
  | 'plot'
  | 'character'
  | 'absent_cast'
  | 'narrator'
  | 'style'
  | 'lore_after'
  | 'persona'
  | 'memory'
  | 'relationship'
  | 'directions'
  | 'examples'
  | 'history'
  | 'depth_lore'
  | 'author_note'
  | 'post_history'
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
  /** `'plot'`, or the name of the member whose card carries the entry. */
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
 * How far from the end of the history the author's note sits — SillyTavern's
 * default. Close enough to the end to steer the next turn, without being the
 * last thing the model reads.
 */
export const AUTHOR_NOTE_DEPTH = 4;

export const DEFAULT_CONTEXT_BUDGET = 16000;
/**
 * The lore budget of a book whose card names none (`LoreSettings.tokenBudget`):
 * this share of the context budget, so a chat given more room gives its lore
 * more too.
 */
export const LORE_BUDGET_SHARE = 0.25;
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
export const DIRECTIONS_HEADER = '[게임 판정]';

/** Wrapper a narrating turn is carried under; it moves the scene, not whoever sent it. */
export const NARRATION_HEADER = '[나레이션]';

/**
 * What the header means, said once. It sits in the system string rather than
 * beside the turn it describes: the rule never changes, and the system string is
 * the cached prefix — a per-turn copy would pay for the same sentence every turn.
 */
export const NARRATION_NOTE =
  '[나레이션] 표시가 붙은 메시지는 캐릭터나 유저의 발화가 아니라 장면·상황 전개 서술입니다.';

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
 * What closes a group turn's prompt: who speaks next. The name stands bare,
 * before a full stop, so no particle has to agree with it.
 */
export const groupSpeakerLine = (name: string): string =>
  `[다음 응답의 화자: ${name}. 이 인물의 말과 행동만 씁니다.]`;

/** Wrapper the work's own setting is read under. */
export const plotHeader = (name: string): string => `[작품: ${name}]`;

/** Wrapper each roster member's profile is read under. */
export const characterHeader = (name: string): string => `[등장인물: ${name}]`;

/**
 * Wrapper an example-dialogue block is read under. Every block carries it rather
 * than one line introducing a member's blocks: the blocks are evicted one by one
 * from whatever budget the history leaves, and a lone introduction would survive
 * every example it was meant to introduce.
 */
export const exampleHeader = (name: string): string => `[예시 대화: ${name}]`;

/**
 * What a member sent off the stage leaves behind: one line, right after the
 * blocks of those still in it. Their card is gone, but their name is still all
 * over the history, and without this the model would carry on writing them in.
 */
export const absentCastLine = (names: string[]): string =>
  `현재 장면에 없는 인물: ${names.join(', ')} — 이 인물들은 이번 장면에서 대사나 행동으로 등장하지 않습니다.`;

/**
 * Who the reader wants the next reply to be about. One turn's request, so the
 * caller appends it after everything else and stores it nowhere.
 */
export const sceneFocusDirective = (names: string[]): string =>
  `이번 응답은 ${names.join(', ')}의 대사와 행동을 중심으로 씁니다.`;

/** How each point of view is put to the model. No macro, so no particle to agree with. */
export const NARRATOR_POV_LABELS: Record<NarratorPov, string> = {
  first: '1인칭 (유저 캐릭터의 시점)',
  third: '3인칭 관찰자',
  'third-limited': '3인칭 제한 (장면과 등장인물만 서술하고, 유저의 속마음은 쓰지 않음)',
  omniscient: '3인칭 전지적',
};

/** Header the compiled style directives are read under. */
export const STYLE_DIRECTIVES_HEADER = '연출 지시:';

/** How each mood is named to the model. */
export const PLOT_MOOD_LABELS: Record<PlotMood, string> = {
  romance: '로맨스',
  healing: '힐링',
  angst: '앙스트',
  yandere: '얀데레',
  fantasy: '판타지',
  action: '액션',
  mystery: '미스터리',
  horror: '호러',
};

// The directive tables. Every option whose value is the plot's default — the
// tense the model would pick anyway, `balanced`, `natural`, `normal`, `auto`,
// `off` — is absent on purpose: the default is what the prompt says nothing
// about, and a line saying "keep it balanced" would spend the model's attention
// on the setting the creator left alone.
//
// The same particle rule as the presets applies (see presets.ts): no allomorphic
// particle may attach to a {{char}}/{{user}} substitution, since the name is
// unknown here. A test in prompt.test.ts holds every line below to it.

const TENSE_DIRECTIVES: Record<PlotTense, string> = {
  past: '사건을 과거 시제로 서술합니다.',
  present: '사건을 현재 시제로 서술합니다.',
};

const REPLY_LENGTH_DIRECTIVES: Partial<Record<ReplyLength, string>> = {
  short: '군더더기 없이 짧게, 1~2문단으로 답합니다.',
  medium: '읽기 편한 호흡의 2~3문단으로 답합니다.',
  long: '묘사를 아끼지 말고 3~5문단의 몰입감 있는 장문으로 답합니다.',
};

const DELIVERY_DIRECTIVES: Partial<Record<NarrativeDelivery, string>> = {
  dialogue: '대사의 비중을 조금 더 두어, 주고받는 말로 장면을 굴립니다.',
  action: '행동과 지문의 비중을 조금 더 두어, 움직이는 장면으로 씁니다.',
};

const PACING_DIRECTIVES: Partial<Record<PlotPacing, string>> = {
  fast: '전개를 빠르게 가져가고, 장면을 지체 없이 다음으로 밀어붙입니다.',
  slow: '전개를 서두르지 않고, 한 장면을 천천히 뜸들이며 이어 갑니다.',
};

const DIFFICULTY_DIRECTIVES: Partial<Record<PlotDifficulty, string>> = {
  easy: '등장인물은 {{user}}의 주도를 대체로 순순히 따릅니다.',
  hard: '등장인물은 쉽게 협조하지 않고, 장면에는 늘 긴장이 흐릅니다.',
  nightmare: '등장인물은 뚜렷한 자기 의지로 움직이며 {{user}}에게 적대적으로 굽니다.',
};

const STORYTELLING_DIRECTIVES: Record<StorytellingStyle, string> = {
  highSociety: '격조 있는 위트와 절제된 감정으로 문장을 씁니다.',
  noir: '건조하고 날카로운 문장으로 서늘한 서스펜스를 깔아 둡니다.',
  afterDark: '감각적이고 거리낌 없는 욕망의 문체로 씁니다.',
  nostalgia: '따뜻하고 아련한 회고조로 씁니다.',
  blockbuster: '폭발적이고 영화적인 전개로 장면을 몰아칩니다.',
  arcane: '신비와 경이가 배어나는 묘사로 씁니다.',
  manga: '빠른 템포와 과장된 개성이 드러나는 만화적 문체로 씁니다.',
  dread: '평범한 일상 속으로 불길함이 스며들게 씁니다.',
};

/** The status-window convention, taught where the plot asks for it (statusBlock.ts). */
const STATUS_WINDOW_DIRECTIVE =
  '매 응답의 끝에 ```status 코드 블록을 붙여 현재 상태를 갱신합니다. ' +
  '배경(위치·시간·날씨 등)과 인물(상태·감정·목표 등) 가운데 장면에 맞는 항목만 골라 `키: 값` 한 줄씩 적습니다.';

/** The choice-line convention (choices.ts); the two modes differ only in shape. */
const CHOICES_DIRECTIVE =
  '응답의 맨 끝에(상태창 블록이 있다면 그 뒤에) {{user}}의 다음 행동 선택지를 2~3개, `>> `로 시작하는 줄로 하나씩 붙입니다.';

const CHOICES_SHAPE_DIRECTIVES: Partial<Record<ChoicesMode, string>> = {
  keywords: '선택지는 5어절 이내의 짧은 키워드형 구로 씁니다.',
  sentences: '선택지는 완결된 한 문장으로 씁니다.',
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
      ? `장면의 분위기는 ${style.moods.map((mood) => PLOT_MOOD_LABELS[mood]).join(', ')} 쪽을 지향합니다.`
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
 * Applies an override that may re-inject the preset through {{original}}.
 *
 * A card's own instructions were written for some other app's chat, which knows
 * nothing of the `이름: ` lines `speech.ts` reads a reply by — and RisuAI itself
 * sets the system prompt aside whenever a prompt template is in use. So the
 * preset's speech protocol outlives the override: one that did not bring the
 * preset back through {{original}} gets the protocol appended.
 */
function resolveOverride(override: string, presetText: string, macro: MacroContext, protocol: string): string {
  if (!override.trim()) return presetText;
  const resolved = applyMacros(override, { ...macro, original: presetText });
  return presetText.includes(protocol) && !resolved.includes(protocol) ? `${resolved}\n\n${protocol}` : resolved;
}

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
    relationshipText = '',
    authorNote = '',
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
    assetNames,
    userName = DEFAULT_USER_NAME,
    contextBudget = DEFAULT_CONTEXT_BUDGET,
    maxResponseTokens = DEFAULT_MAX_RESPONSE_TOKENS,
    preset: scenePreset = DEFAULT_PRESET,
    speaker,
    narration = false,
  } = input;
  const history = withBranchGreeting(given, branch);

  // The first member is the plot's stand-in wherever the assembler needs one
  // card rather than all of them. There is no plot-level override field yet, so
  // a card that carries one still speaks for the work it is the first member of.
  const first = characters[0];
  // A group turn's member speaker. Its card's overrides speak for this one reply
  // in place of the first member's, and the preset teaches the group protocol.
  const speakerMember = typeof speaker === 'number' ? characters[speaker] : undefined;
  if (typeof speaker === 'number' && !speakerMember) {
    throw new RangeError(`speaker ${speaker} is not on the roster of ${characters.length}`);
  }
  const voice = speakerMember ?? first;
  const preset = speakerMember ? groupPreset(scenePreset) : scenePreset;
  const protocol = speakerMember ? GROUP_SPEECH_PROTOCOL : SPEECH_PROTOCOL;
  const protocolReminder = speakerMember ? GROUP_SPEECH_PROTOCOL_REMINDER : SPEECH_PROTOCOL_REMINDER;
  // Whoever the reader sent off the stage is gone from everything that is the
  // member's own — their block, examples and lorebook — and from nothing else.
  const cast = characters.filter((member) => !member.absent);
  const absentNames = characters.filter((member) => member.absent).map((member) => member.name);

  // What the macros read and — in a SillyTavern member's text — write: a copy,
  // so the caller's map stays the state the branch folded to, and what the
  // prompt wrote is the difference between the two.
  const working = applyVariableDelta(variables, null);
  // RisuAI's chat, as its chat functions see it — built when first asked for.
  let chat: CbsChat | undefined;
  const chatOf = (): CbsChat => (chat ??= cbsChat(history, branch));
  const seedLength = branch ? cbsChat([], branch).length : undefined;
  const lorebookOf = (): readonly object[] =>
    [...plot.lorebook, ...cast.flatMap((member) => member.card.lorebook)]
      .filter((entry) => entry.enabled)
      .map(risuLoreEntry);
  const shared: MacroHostData = {
    persona: personaText,
    prompts: {
      main: preset.main,
      postHistory: preset.postHistory,
      authorNote,
      // There is no jailbreak prompt here, and none to toggle.
      jailbreak: { text: '', enabled: false },
    },
    chat: chatOf,
    ...(model ? { model } : {}),
    lorebook: lorebookOf,
  };
  const group = cast.map((member) => member.name);
  // The card RisuAI's `{{description}}` and the like read outside a member's own
  // text: the first one still on the stage, as RisuAI reads its one character.
  const standIn = cast[0] ?? first;

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
      ...(globalVariables ? { globalVariables } : {}),
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
      },
      ...(member?.sillyTavern ? { runVariableMacros: true } : {}),
    };
  };
  const plotMacro = macroOf(undefined);
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

  // 1. main system prompt
  const main = resolveOverride(voice?.card.systemPrompt ?? '', expand(preset.main), voiceMacro, protocol);

  // 1b. how a reply marks its 지문 when it has any (`REPLY_FORMAT_HINT`), and
  // the least of what the system string says: right behind the preset whose
  // protocol it refines, so everything the work itself says comes after it.
  // Only beside one of our presets — a card that writes its own instructions
  // has its own form — and never on a narration, which is not a reply's lines.
  const formatHint =
    !narration &&
    typeof speaker !== 'string' &&
    preset.main.includes(protocol) &&
    !voice?.card.systemPrompt.trim() &&
    !voice?.card.postHistoryInstructions.trim()
      ? REPLY_FORMAT_HINT
      : '';

  // 2/4. lorebook — the plot's entries and every member's, activated as one book
  // against the last scanDepth messages. The sort inside `activateLore` is stable,
  // so entries sharing an insertionOrder keep this order: plot, then roster.
  const loreMacro = new Map<LoreEntry, MacroContext>();
  /** Whose book each entry came from, for the report. */
  const loreSource = new Map<LoreEntry, string>();
  const lorebook: LoreEntry[] = [];
  for (const entry of plot.lorebook) {
    lorebook.push(entry);
    loreMacro.set(entry, plotMacro);
    loreSource.set(entry, 'plot');
  }
  for (const member of cast) {
    const macro = macroOf(member);
    for (const entry of member.card.lorebook) {
      lorebook.push(entry);
      loreMacro.set(entry, macro);
      loreSource.set(entry, member.name);
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
  // The raw texts: an old status block the model is no longer sent (7, below)
  // is still where the scene's place and people are written down.
  const {
    entries: activated,
    triggered: loreTriggers,
    via: loreVia,
  } = activateLore(lorebook, {
    history: history.map((message) => message.content),
    scanDepth: loreSettings.scanDepth,
    budgetTokens:
      loreSettings.tokenBudget ??
      Math.floor(
        contextBudget *
          (loreSettings.budgetPercent !== undefined ? loreSettings.budgetPercent / 100 : LORE_BUDGET_SHARE),
      ),
    countTokens,
    recursiveScanning: loreSettings.recursiveScanning,
    ...(loreSettings.maxRecursionSteps !== undefined
      ? { maxRecursionSteps: loreSettings.maxRecursionSteps }
      : {}),
    risuMatching: loreSettings.risuMatching ?? false,
    textOf: expandLore,
    ...(loreState ? { timed: loreState } : {}),
  });
  /** The expanded entries a position holds, in insertionOrder, the empty ones left out. */
  const loreAt = (position: LorePosition): LoreEntry[] =>
    activated.filter(
      (entry) => entry.depth === undefined && entry.position === position && expandLore(entry).length > 0,
    );
  const loreText = (position: LorePosition): string => loreAt(position).map(expandLore).join('\n\n');

  // 2b. outlets — SillyTavern's World Info position 7. An outlet entry goes
  // nowhere by itself: what its outlet's entries say, one per line as ST joins
  // them, stands in for every `{{outlet::name}}` the prompt's text writes, and an
  // outlet nothing names is not sent at all. A name no active entry fills reads
  // as nothing, as in ST. One pass, so an outlet's own text never names another.
  const outlets = new Map<string, string[]>();
  for (const entry of loreAt('outlet')) {
    const name = entry.outletName?.trim();
    if (name) outlets.set(name, [...(outlets.get(name) ?? []), expandLore(entry)]);
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
      content: send(expandLore(entry)),
    }));

  // 3. plot block — the work itself, ahead of the people in it.
  const plotBlock = [
    plot.name.trim() ? plotHeader(plot.name.trim()) : '',
    expand(plot.description).trim(),
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  // 4. one block per roster member on the stage, in the creator's order. The
  // card's scenario is not read: a situation belongs to the plot or to an intro,
  // not to a member.
  const characterBlocks = cast.map((member): SystemSection => {
    const { name, card } = member;
    const macro = macroOf(member);
    const lines = [characterHeader(name), applyMacros(card.description, macro).trim()]
      .filter((line) => line.length > 0)
      .join('\n');
    const text = card.personality.trim()
      ? `${lines}\n\n${applyMacros('{{char}}의 성격: ', macro)}${applyMacros(card.personality, macro).trim()}`
      : lines;
    return { kind: 'character', label: name, text };
  });

  // 4a. who is not on the stage — right behind those who are.
  const absentBlock = absentNames.length > 0 ? absentCastLine(absentNames) : '';

  // 4b. narrator — how the scene is told, as against how the members speak.
  // Static text in the cached prefix like the blocks it follows. The labels name
  // the prose rather than a narrator: the settings govern every 지문 — a reply's
  // unprefixed lines as well as a narration — and a model writing an ordinary
  // reply would find nothing in it that a "narrator" label could be about.
  const narratorBlock = [
    narrator?.voice?.trim() ? `서술 문체: ${expand(narrator.voice).trim()}` : '',
    narrator?.pov ? `서술 시점: ${NARRATOR_POV_LABELS[narrator.pov]}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  // 4c. style — how the creator wants the work written, right behind the narrator
  // so the two read as one set of 연출 지시. Static like the narrator's, and the
  // plot's alone: a reader's toggles reach it as a style the caller already
  // crossed with them.
  const styleBlock = plot.style ? expand(styleDirectives(plot.style)) : '';

  // 5. persona
  const personaBlock = personaText.trim() ? `${expand('유저({{user}}) 정보: ')}${expand(personaText)}` : '';

  // 5b. memory — the summary of the evicted history plus any retrieved facts.
  const memoryBlock = memoryText.trim() ? expand(memoryText).trim() : '';

  // 5c. relationship — how the plot's characters currently feel about the user.
  const relationshipBlock = relationshipText.trim() ? expand(relationshipText).trim() : '';

  const sections: SystemSection[] = [
    { kind: 'main', text: main },
    { kind: 'format', text: formatHint },
    { kind: 'narration_note', text: NARRATION_NOTE },
    { kind: 'lore_before', text: loreText('before_char') },
    { kind: 'plot', text: plotBlock },
    ...characterBlocks,
    { kind: 'absent_cast', text: absentBlock },
    { kind: 'narrator', text: narratorBlock },
    { kind: 'style', text: styleBlock },
    { kind: 'lore_after', text: loreText('after_char') },
    { kind: 'persona', text: personaBlock },
    { kind: 'memory', text: memoryBlock },
    { kind: 'relationship', text: relationshipBlock },
  ];
  const systemSections = sections
    .map((section) => ({ ...section, text: send(section.text) }))
    .filter((section) => section.text.length > 0);
  const system = systemSections.map((section) => section.text).join('\n\n');

  // 5d. stage directions of the turn being answered. Outside the system string on
  // purpose: it changes every turn, and the system string is the cached prefix.
  const directionsBlock = directions.trim() ? send(`${DIRECTIONS_HEADER}\n${expand(directions).trim()}`) : '';

  // 7c. author's note — spliced into the history at AUTHOR_NOTE_DEPTH, below —
  // with the lore SillyTavern puts around it (World Info positions 2 and 3), one
  // per line as ST joins them. Like ST, which adds them whenever the note is due,
  // the entries take the note's place even when the chat has no note of its own.
  const authorNoteBlock = send(
    [
      ...loreAt('before_author_note').map(expandLore),
      expand(authorNote).trim(),
      ...loreAt('after_author_note').map(expandLore),
    ]
      .filter((text) => text.length > 0)
      .join('\n')
      .trim(),
  );

  // 8. post-history instructions
  const postHistory = send(
    resolveOverride(
      voice?.card.postHistoryInstructions ?? '',
      expand(preset.postHistory),
      voiceMacro,
      protocolReminder,
    ),
  );

  // 8b. what the card's start triggers asked for, RisuAI's three places: just
  // before the newest turn, just after the history, and after everything. As
  // written — the triggers expanded their own text — and never evicted.
  const injected = (place: keyof PromptInjections): MessageSlot | null => {
    const text = injections[place]?.trim();
    return text ? { kind: 'injection', label: place, message: { role: 'system', content: send(text) } } : null;
  };
  const startInjection = injected('start');
  const historyEndInjection = injected('historyend');
  const promptEndInjection = injected('promptend');
  const injectedTokens = [startInjection, historyEndInjection, promptEndInjection].reduce(
    (sum, slot) => sum + (slot ? countTokens(promptText(slot.message.content)) : 0),
    0,
  );

  // 8c. a group turn's member speaker: who speaks next, after everything else
  // and, like the injections, never evicted.
  const speakerSlot: MessageSlot | null = speakerMember
    ? {
        kind: 'trailing',
        label: speakerMember.name,
        message: { role: 'system', content: groupSpeakerLine(speakerMember.name) },
      }
    : null;

  // Everything that is never evicted is charged up front. Depth lore is charged
  // here too — it is counted against the lorebook budget by activateLore, but it
  // still occupies context that history would otherwise use.
  let available =
    contextBudget -
    maxResponseTokens -
    countTokens(system) -
    countTokens(postHistory) -
    countTokens(directionsBlock) -
    countTokens(authorNoteBlock) -
    injectedTokens -
    (speakerSlot ? countTokens(promptText(speakerSlot.message.content)) : 0) -
    depthLore.reduce((sum, entry) => sum + countTokens(entry.content), 0);

  // 7. history, newest first. The newest message is always kept so the request
  // is never empty.
  //
  // Only the newest assistant turn keeps its status window and choice lines: it
  // carries the current state and shows the model the format, and every older
  // copy is a superseded state the model would otherwise re-read each turn.
  const newestAssistant = history.findLastIndex((turn) => turn.role === 'assistant');
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
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i]!;
    // What the cards' prompt scripts made of the turn, where they rewrote it.
    const source = turn.promptContent ?? turn.content;
    const said = turn.role === 'assistant' && i !== newestAssistant ? withoutStateTail(source) : source;
    // A narrating turn keeps its role — the message is still the reader's or the
    // model's — but it is labelled, so the model reads it as the scene moving
    // rather than as someone acting. The prefix never reaches the model. A turn a
    // script wrote as its character, or a group turn's reply, is that member's,
    // line by line — but a speaker reads their own replies plain. A reader's line
    // written as a member is that member's, and one written as the narrator is
    // narration (`readerTurnText`).
    const tagged = turn.speakerId !== undefined ? byId.get(turn.speakerId) : undefined;
    const saidBy = tagged ? (tagged === speakerMember ? undefined : tagged.name) : turn.speaker;
    const raw = isNarration(said)
      ? `${NARRATION_HEADER} ${narrationBody(said)}`.trim()
      : turn.role === 'user'
        ? readerTurnText(said, readers)
        : saidBy !== undefined
          ? spokenBy(said, saidBy, speakers)
          : said;
    // A turn's inlays name pictures in someone's own RisuAI storage; RisuAI takes
    // them out of the turns it sends, and so does this.
    const text = send(applyMacros(stripInlayMacros(raw), turnMacroOf(turn, i)));
    const images = turn.images ?? [];
    const cost = countTokens(text) + images.length * IMAGE_TOKEN_ESTIMATE;
    if (cost > available && historyMessages.length > 0) break;
    available -= cost;
    // The parts form is only used where there is something besides words: the
    // image goes after the text, which is the order the turn was sent in.
    const content: string | PromptPart[] =
      images.length === 0
        ? text
        : [
            { type: 'text', text },
            ...images.map((url): PromptPart => ({ type: 'image', url })),
          ];
    historyMessages.unshift({ role: turn.role, content });
    historyCosts.unshift(cost);
    historySources.unshift({
      ...(turn.id !== undefined ? { id: turn.id } : {}),
      ...(branch?.greeting && historyStart + i === 0 ? { greeting: true as const } : {}),
    });
  }

  // 6. example dialogue — every member's blocks, each named so the model can tell
  // whose exchange it is reading. Filled from whatever budget history left over,
  // so it is the first thing to be evicted. The lore SillyTavern puts around the
  // examples (World Info positions 5 and 6) is example dialogue there — split on
  // `<START>` like a card's, ahead of every member's blocks or behind them, and
  // evicted with them — named for the book it came from.
  const exampleSlots: MessageSlot[] = [];
  const exampleLore = (position: LorePosition): { name: string; content: string }[] =>
    loreAt(position).flatMap((entry) => {
      const source = loreSource.get(entry);
      const name = source === undefined || source === 'plot' ? plot.name : source;
      return splitExamples(expandLore(entry)).map((block) => ({
        name,
        content: send(`${exampleHeader(name)}\n${block}`),
      }));
    });
  const exampleBlocks = [
    ...exampleLore('before_examples'),
    ...cast.flatMap((member) => {
      const macro = macroOf(member);
      return splitExamples(member.card.mesExample).map((block) => ({
        name: member.name,
        content: send(`${exampleHeader(member.name)}\n${applyMacros(block, macro)}`),
      }));
    }),
    ...exampleLore('after_examples'),
  ];
  for (const { name, content } of exampleBlocks) {
    const cost = countTokens(content);
    if (cost > available) break;
    available -= cost;
    exampleSlots.push({ kind: 'examples', label: name, message: { role: 'system', content }, tokens: cost });
  }

  // Depth 0 lands after the last message, depth N before the Nth message from the
  // end, and anything deeper than the history clamps to its start. Trailing turns
  // count as the last messages even though the caller attaches them, so anything
  // shallower than them clamps to the end of the history block. The author's note
  // takes the same slots, after any depth lore that shares its slot.
  const end = historyMessages.length;
  const indexOf = (depth: number): number => Math.min(end, Math.max(0, end + trailingTurns - depth));
  const noteIndex = authorNoteBlock ? indexOf(AUTHOR_NOTE_DEPTH) : -1;
  const depthAt = (index: number): MessageSlot[] => [
    ...depthLore
      .filter(({ depth }) => indexOf(depth) === index)
      .map(({ depth, role, content }): MessageSlot => ({
        kind: 'depth_lore',
        label: `depth ${depth}`,
        message: { role, content },
      })),
    ...(index === noteIndex
      ? [{ kind: 'author_note', message: { role: 'system', content: authorNoteBlock } } satisfies MessageSlot]
      : []),
  ];

  // RisuAI's `start` goes right before the newest turn, behind whatever depth
  // lore is spliced in front of it; `historyend` after the whole history block.
  const historyBlock: MessageSlot[] = [];
  for (let i = 0; i < historyMessages.length; i += 1) {
    const message = historyMessages[i]!;
    historyBlock.push(...depthAt(i));
    if (startInjection && i === historyMessages.length - 1) historyBlock.push(startInjection);
    historyBlock.push({
      kind: 'history',
      label: message.role,
      message,
      tokens: historyCosts[i]!,
      ...historySources[i]!,
    });
  }
  historyBlock.push(...depthAt(historyMessages.length));
  if (startInjection && historyMessages.length === 0) historyBlock.push(startInjection);
  if (historyEndInjection) historyBlock.push(historyEndInjection);

  const slots: MessageSlot[] = [
    ...(directionsBlock
      ? [{ kind: 'directions', message: { role: 'system', content: directionsBlock } } satisfies MessageSlot]
      : []),
    ...exampleSlots,
    ...historyBlock,
    { kind: 'post_history', message: { role: 'system', content: postHistory } },
    ...(promptEndInjection ? [promptEndInjection] : []),
    ...(speakerSlot ? [speakerSlot] : []),
  ];

  // Every text that could write has been expanded by now, examples last.
  const variableWrites = diffVariables(working, variables);

  /** Measured here, after the fact, so a generation never pays for it. */
  const report = (): PromptReport => ({
    blocks: [
      ...systemSections.map(({ kind, label, text }) => ({
        kind,
        ...(label !== undefined ? { label } : {}),
        tokens: countTokens(text),
        text,
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
    history: { included: historyMessages.length, total: history.length },
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
    sources: slots.map(({ kind, id, greeting }) => ({
      kind,
      ...(id !== undefined ? { id } : {}),
      ...(greeting ? { greeting } : {}),
    })),
    loreTriggers,
    ...(variableWrites ? { variableWrites } : {}),
    ...(input.report ? { report: report() } : {}),
    ...(stopSequences ? { stopSequences } : {}),
  };
}

/** One section of the system string, kept with what it is until the report. */
interface SystemSection {
  kind: PromptBlockKind;
  label?: string;
  text: string;
}

/** One message of the assembled list, kept with what it is until the report. */
interface MessageSlot extends Omit<MessageSource, 'kind'> {
  kind: PromptBlockKind;
  label?: string;
  message: PromptMessage;
  /** What the budget was charged for it, where that was already measured. */
  tokens?: number;
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
 * scenario is the plot's setting: an imported card's became the plot's, and a
 * member here has none of its own.
 */
const cbsCharacter = (member: PromptCharacter, plot: PromptPlot): CbsCharacter => ({
  description: member.card.description,
  personality: member.card.personality,
  scenario: plot.description,
  exampleDialogue: member.card.mesExample,
});

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
