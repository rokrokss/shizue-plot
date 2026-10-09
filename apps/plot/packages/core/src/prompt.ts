import { applyMacros, stripImageMacros, type MacroContext } from './macro.js';
import { activateLore } from './lorebook.js';
import { isNarration, narrationBody } from './narration.js';
import { DEFAULT_PRESET, type Preset } from './presets.js';
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
import { emptyVariables, type Variables } from './variables.js';

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
   * Images attached to the turn, as URLs the provider can read (the API resolves
   * its stored attachments into `data:` URLs). Only a model with vision is given
   * them — see `IMAGE_ATTACHED_PLACEHOLDER`.
   */
  images?: string[];
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
  name: string;
  card: NormalizedCard;
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
   * Author's note. Injected as a system message right before the history and,
   * like the post-history block, never evicted.
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
  contextBudget?: number;
  maxResponseTokens?: number;
  preset?: Preset;
}

export interface AssembledPrompt {
  system: string;
  messages: PromptMessage[];
}

export const DEFAULT_CONTEXT_BUDGET = 16000;
// Sized for the speech protocol: a turn carries several speakers plus narration,
// and 600 (the single-character era value) cut replies mid-sentence.
export const DEFAULT_MAX_RESPONSE_TOKENS = 1200;
export const DEFAULT_USER_NAME = '유저';

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

/** How each point of view is put to the model. No macro, so no particle to agree with. */
export const NARRATOR_POV_LABELS: Record<NarratorPov, string> = {
  first: '1인칭 (유저 캐릭터의 시점)',
  third: '3인칭 관찰자',
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

/** Applies an override that may re-inject the preset through {{original}}. */
function resolveOverride(override: string, presetText: string, macro: MacroContext): string {
  if (!override.trim()) return presetText;
  return stripImageMacros(applyMacros(override, { ...macro, original: presetText }));
}

export function assemblePrompt(input: AssemblePromptInput): AssembledPrompt {
  const {
    plot,
    characters,
    history,
    personaText = '',
    memoryText = '',
    relationshipText = '',
    authorNote = '',
    directions = '',
    narrator = plot.narrator,
    trailingTurns = 0,
    variables = emptyVariables(),
    userName = DEFAULT_USER_NAME,
    contextBudget = DEFAULT_CONTEXT_BUDGET,
    maxResponseTokens = DEFAULT_MAX_RESPONSE_TOKENS,
    preset = DEFAULT_PRESET,
  } = input;

  // `{{char}}` resolves per text origin. A member's own card text is about that
  // member, and everything else — the presets, the plot's own writing, the
  // narrator, the history — is about the work, so the plot's name stands in.
  const plotMacro: MacroContext = { char: plot.name, user: userName, variables };
  const macroOf = (name: string): MacroContext => ({ char: name, user: userName, variables });
  // Image references never reach the model, so they are gone before anything is
  // measured against the budget.
  const expandWith = (text: string, macro: MacroContext): string =>
    stripImageMacros(applyMacros(text, macro));
  const expand = (text: string): string => expandWith(text, plotMacro);

  // The first member is the plot's stand-in wherever the assembler needs one
  // card rather than all of them. There is no plot-level override field yet, so
  // a card that carries one still speaks for the work it is the first member of.
  const first = characters[0];
  const firstMacro = first ? macroOf(first.name) : plotMacro;

  // 1. main system prompt
  const main = resolveOverride(first?.card.systemPrompt ?? '', expand(preset.main), firstMacro);

  // 2/4. lorebook — the plot's entries and every member's, activated as one book
  // against the last scanDepth messages. The sort inside `activateLore` is stable,
  // so entries sharing an insertionOrder keep this order: plot, then roster.
  const loreMacro = new Map<LoreEntry, MacroContext>();
  const lorebook: LoreEntry[] = [];
  for (const entry of plot.lorebook) {
    lorebook.push(entry);
    loreMacro.set(entry, plotMacro);
  }
  for (const member of characters) {
    const macro = macroOf(member.name);
    for (const entry of member.card.lorebook) {
      lorebook.push(entry);
      loreMacro.set(entry, macro);
    }
  }
  // One book means one set of settings decides its depth and budget: the first
  // member's, the same card the overrides come from.
  const loreSettings = first?.card.loreSettings ?? DEFAULT_LORE_SETTINGS;
  const scanText = history
    .slice(-loreSettings.scanDepth)
    .map((message) => message.content)
    .join('\n');
  const activated = activateLore(
    lorebook,
    scanText,
    loreSettings.tokenBudget,
    countTokens,
    loreSettings.recursiveScanning,
  );
  const expandLore = (entry: LoreEntry): string =>
    expandWith(entry.content, loreMacro.get(entry) ?? plotMacro);
  const loreText = (position: LorePosition): string =>
    activated
      .filter((entry) => entry.depth === undefined && entry.position === position)
      .map(expandLore)
      .join('\n\n');

  // 7b. `@@depth` entries go into the history instead of the system block. Kept
  // in insertionOrder, which decides the order of entries sharing a depth.
  const depthLore = activated
    .filter((entry) => entry.depth !== undefined)
    .map((entry) => ({
      depth: entry.depth!,
      role: (entry.role ?? 'system') as PromptRole,
      content: expandLore(entry),
    }));

  // 3. plot block — the work itself, ahead of the people in it.
  const plotBlock = [
    plot.name.trim() ? plotHeader(plot.name.trim()) : '',
    expand(plot.description).trim(),
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  // 4. one block per roster member, in the creator's order. The card's scenario
  // is not read: a situation belongs to the plot or to an intro, not to a member.
  const characterBlocks = characters.map(({ name, card }) => {
    const macro = macroOf(name);
    const lines = [characterHeader(name), expandWith(card.description, macro).trim()]
      .filter((line) => line.length > 0)
      .join('\n');
    if (!card.personality.trim()) return lines;
    return `${lines}\n\n${expandWith('{{char}}의 성격: ', macro)}${expandWith(card.personality, macro).trim()}`;
  });

  // 4b. narrator — how the scene is told, as against how the members speak.
  // Static text in the cached prefix like the blocks it follows.
  const narratorBlock = [
    narrator?.voice?.trim() ? `나레이터 문체: ${expand(narrator.voice).trim()}` : '',
    narrator?.pov ? `나레이션 시점: ${NARRATOR_POV_LABELS[narrator.pov]}` : '',
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

  const system = [
    main,
    NARRATION_NOTE,
    loreText('before_char'),
    plotBlock,
    ...characterBlocks,
    narratorBlock,
    styleBlock,
    loreText('after_char'),
    personaBlock,
    memoryBlock,
    relationshipBlock,
  ]
    .filter((section) => section.length > 0)
    .join('\n\n');

  // 5d. stage directions of the turn being answered. Outside the system string on
  // purpose: it changes every turn, and the system string is the cached prefix.
  const directionsBlock = directions.trim() ? `${DIRECTIONS_HEADER}\n${expand(directions).trim()}` : '';

  // 6b. author's note
  const authorNoteBlock = authorNote.trim() ? expand(authorNote).trim() : '';

  // 8. post-history instructions
  const postHistory = resolveOverride(
    first?.card.postHistoryInstructions ?? '',
    expand(preset.postHistory),
    firstMacro,
  );

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
    depthLore.reduce((sum, entry) => sum + countTokens(entry.content), 0);

  // 7. history, newest first. The newest message is always kept so the request
  // is never empty.
  const historyMessages: PromptMessage[] = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i]!;
    // A narrating turn keeps its role — the message is still the reader's or the
    // model's — but it is labelled, so the model reads it as the scene moving
    // rather than as someone acting. The prefix never reaches the model.
    const raw = isNarration(turn.content)
      ? `${NARRATION_HEADER} ${narrationBody(turn.content)}`.trim()
      : turn.content;
    const text = expand(raw);
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
  }

  // 6. example dialogue — every member's blocks, each named so the model can tell
  // whose exchange it is reading. Filled from whatever budget history left over,
  // so it is the first thing to be evicted.
  const exampleMessages: PromptMessage[] = [];
  const exampleBlocks = characters.flatMap(({ name, card }) =>
    splitExamples(card.mesExample).map(
      (block) => `${exampleHeader(name)}\n${expandWith(block, macroOf(name))}`,
    ),
  );
  for (const content of exampleBlocks) {
    const cost = countTokens(content);
    if (cost > available) break;
    available -= cost;
    exampleMessages.push({ role: 'system', content });
  }

  // Depth 0 lands after the last message, depth N before the Nth message from the
  // end, and anything deeper than the history clamps to its start. Trailing turns
  // count as the last messages even though the caller attaches them, so anything
  // shallower than them clamps to the end of the history block.
  const end = historyMessages.length;
  const indexOf = (depth: number): number => Math.min(end, Math.max(0, end + trailingTurns - depth));
  const depthAt = (index: number): PromptMessage[] =>
    depthLore
      .filter(({ depth }) => indexOf(depth) === index)
      .map(({ role, content }) => ({ role, content }));

  const historyBlock: PromptMessage[] = [];
  for (let i = 0; i < historyMessages.length; i += 1) {
    historyBlock.push(...depthAt(i), historyMessages[i]!);
  }
  historyBlock.push(...depthAt(historyMessages.length));

  return {
    system,
    messages: [
      ...(directionsBlock ? [{ role: 'system' as const, content: directionsBlock }] : []),
      ...exampleMessages,
      ...(authorNoteBlock ? [{ role: 'system' as const, content: authorNoteBlock }] : []),
      ...historyBlock,
      { role: 'system', content: postHistory },
    ],
  };
}

function splitExamples(mesExample: string): string[] {
  return mesExample
    .split(/<START>/i)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}
