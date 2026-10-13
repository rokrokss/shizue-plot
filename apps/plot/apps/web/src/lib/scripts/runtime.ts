/**
 * The chat's script runtime: a RisuAI card's triggers and `editinput`/
 * `editoutput` regex scripts, run in the reader's browser at the moments RisuAI
 * runs them, with what they change carried to the server.
 *
 * RisuAI runs everything in the browser and keeps the character and the chat
 * there too. Here the chat lives on the server, so each moment ends in a request:
 *
 * - **A send** (`prepare('send')`): the input triggers run on the branch, the
 *   `editinput` scripts rewrite the text, the new turn's own macros are folded
 *   over that, and the start triggers run with the turn on the branch — RisuAI's
 *   `DefaultChatScreen` and then `sendChat`. The POST carries the rewritten text,
 *   what the triggers left as the turn's `variableDelta`, the prompt text the start
 *   triggers asked for (`injections`) and anything they rewrote of the work.
 * - **Any other generation** (`prepare('regenerate' | 'continue' | 'auto' |
 *   'narrate')`): the start triggers alone, on the branch the generation reads; what
 *   they left goes as `startDelta`.
 * - **The reply** (`finish`): when the plot has output scripts the POST says
 *   `postProcess`, the server stores the reply `pending`, and once it lands the
 *   `editoutput` scripts rewrite it and the output triggers run — and the result
 *   is committed in place (`script-commit`), which clears the mark. The same call
 *   finishes a pending head found on load: a tab closed mid-reply leaves one.
 * - **A button** (`manual`): a manual trigger by name, committed on the head.
 * - **A slash command** (`command`): what the reader typed starting with `/`,
 *   run as RisuAI's composer runs it and committed on the head; `/multisend`'s
 *   messages come back as turns for the page to take (`ScriptTurn`).
 * - **A message drawn** (`display`): the display triggers rewrite its text, for
 *   the screen only.
 *
 * Every delta is measured the same way: the state the scripts ended in, against
 * the fold of the message's own macros over its parent (`diffVariables`), which is
 * exactly what the server folds back to that state.
 *
 * What the runs did to the chat itself — RisuAI's `impersonate`, `cutchat`,
 * `modifychat` and Lua's chat functions, on any message — rides along as the
 * chat they left (`ScriptChat`, the request's `chat`), which the server keeps as
 * the reader's branch without touching any other. A delta is then measured over
 * that branch: the generation's start delta against where it ends, a send's or a
 * commit's against the message it ends on, which is the one that carries it.
 *
 * What the scripts rewrote of the work — the description, the lore, the global
 * note, the name, the first message, the background, the persona — is the
 * chat's overlay (`ScriptOverlay`): it rides on the generation or the commit, and
 * the runtime keeps its own copy so the next run reads it, and hands it to the
 * page (`onOverlay`), which draws the name, the greeting and the background from
 * it. The chat note goes to the chat's own `note`.
 *
 * The runtime holds no React state and talks to the API through what it is
 * given, so it is tested with a fake fetch.
 */

import {
  checkScriptChat,
  hasEditScripts,
  hasTriggersFor,
  isCodeTrigger,
  manualTriggerNames,
  mergeScriptOverlay,
  runCommands,
  runEditScripts,
  runTriggers,
  runTriggersSync,
  scriptChatOf,
  type CharacterRewrite,
  type CodeScope,
  type CommandMultisend,
  type EditScript,
  type LoreTest,
  type MemberOverlay,
  type PromptInjectionText,
  type ScriptChat,
  type ScriptOverlay,
  type TriggerCharacter,
  type TriggerDriver,
  type TriggerLogEntry,
  type TriggerMessage,
  type TriggerMode,
  type TriggerRunInput,
  type TriggerRunResult,
  type TriggerScript,
} from '@shizue/core/triggers';
import type { LoreSettings } from '@shizue/core';
import type { CbsHostData } from '@shizue/core/cbs';
import {
  applyVariableDelta,
  checkVariableDelta,
  computeVariables,
  diffVariables,
  readVariable,
  type FoldItem,
  type FoldOptions,
  type VariableDelta,
  type Variables,
} from '@shizue/core/variables';
import type { ChatMessage, ChatState, LoreEntry, StreamMode } from '../types';
import type { EditPhase, ScriptEngine, ScriptPhase } from './engine';
import type { SimilaritySearch } from './similarity';

/** GET /api/chats/:id/scripts — what the browser runs for a chat, when the plot carries any. */
export interface ScriptBundle {
  /** The member whose scripts these are, and whose card they rewrite. */
  memberId: string;
  /** `{{char}}` in the scripts' text: the member's nickname, else its name as this chat's overlay has it. */
  name: string;
  triggers: TriggerScript[];
  editScripts: EditScript[];
  lowLevelAccess: boolean;
  character: {
    /** RisuAI's `char.name`, as the card has it; the overlay's rewrite is beside it. Defaults to `name`. */
    name?: string;
    /** The card's nickname, which `{{char}}` is while it is set; '' when none. */
    nickname?: string;
    description: string;
    personality: string;
    scenario: string;
    exampleDialogue: string;
    lorebook: LoreEntry[];
    postHistoryInstructions: string;
    /** The lorebook's settings, which `/test_lorebook` and Lua's `loadLoreBooks` activate by. */
    loreSettings?: LoreSettings;
    /** RisuAI's `backgroundHTML` as the card carries it, whole. */
    backgroundHtml?: string;
    /** The member's avatar, a same-origin address, or null. */
    avatarUrl?: string | null;
  };
  /** What this chat's scripts already rewrote of it. */
  overlay: { member: MemberOverlay | null; persona: string | null };
}

/** How the runtime asks the reader something — the page draws it. */
export interface ScriptUi {
  alert(text: string, error: boolean): Promise<void>;
  input(text: string): Promise<string>;
  /** The index of the option chosen, as text — what RisuAI's select dialog answers — or '' when dismissed. */
  select(options: string[], display?: string): Promise<string>;
  /** Yes or no (Lua's `alertConfirm`); dismissing it is no. */
  confirm(text: string): Promise<boolean>;
  /** The list of slash commands (`/?`), in the reader's language. */
  help?(): Promise<void>;
}

/** The API, as little of it as the runtime needs. */
export interface ScriptApi {
  send<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface ScriptRuntimeOptions {
  chatId: string;
  bundle: ScriptBundle;
  api: ScriptApi;
  ui: ScriptUi;
  engines?: readonly ScriptEngine[];
  random?: () => number;
  /** Where the runs' notes go — the effects not carried out, the limits reached. */
  log?: (entry: TriggerLogEntry) => void;
  wait?: (ms: number) => Promise<void>;
  /**
   * The embedding search `checkSimilarity`/`v2CheckSimilarity` ask for — the
   * page's worker (`embedding.ts`). Without one the effects fail as RisuAI's
   * do when its embedder throws.
   */
  similarity?: SimilaritySearch;
  /**
   * The reader's global variables after the scripts wrote some. Nothing in the
   * trigger language or in RisuAI's Lua writes one — `CodeScope.setGlobalVar`
   * is there for an engine that does — so this is where such writes would reach
   * the page.
   */
  onGlobalVariables?: (variables: Variables) => void;
  /**
   * The scripted member's overlay once the server has taken what a run rewrote of
   * it — the page draws the member's name, the first greeting and the background
   * from it.
   */
  onOverlay?: (member: MemberOverlay) => void;
}

/**
 * The chat as the page holds it at the moment a script runs. `messages` is the
 * whole branch — the page loads what it had not paged in first — and `defaults`
 * is what its fold starts from.
 */
export interface ScriptView {
  messages: readonly ChatMessage[];
  defaults: Variables;
  names: FoldOptions;
  /** The chat note. */
  note: string;
  /** The reader's persona description, as stored. */
  persona: string;
  /**
   * The branch opens on the plot's first opening — RisuAI's `fmIndex` -1 — whose
   * text the overlay's `firstMessage` stands in for, as RisuAI's greeting is drawn
   * from the character's first message there.
   */
  firstGreeting?: boolean;
  globalVariables?: Variables;
  /** What the evaluator may tell the scripts about the reader's side: the clock, the screen, the seed. */
  data?: Omit<CbsHostData, 'chat' | 'character' | 'persona' | 'triggerId' | 'lorebook' | 'char'>;
}

/** What a generation carries for the scripts, besides the text a send may have rewritten. */
export interface PreparedGeneration {
  /** Fields to add to the generation's body. */
  body: Record<string, unknown>;
  /** A send's text as the input scripts left it. */
  content?: string;
  /**
   * A start trigger said not to send (`stop`). Nothing was sent; what the runs
   * did to the chat is kept all the same (`state`), and a send's text is not.
   */
  stop: boolean;
  /** The chat as a stopped run's commit left it, when it had changed the chat. */
  state?: ChatState;
  /**
   * Called once the server took the generation (its stream opened): what the
   * scripts rewrote of the work is the chat's from then on, and the runtime's
   * copy moves with it. A refused generation kept nothing, and is not accepted.
   */
  accept(): void;
}

export interface FinishedReply {
  state: ChatState;
  /** `sendAIprompt`: the card asks for another reply. The page decides whether it gets one. */
  followUp: boolean;
}

/**
 * What a `/multisend` leaves for the page once the line is done, in order.
 *
 * RisuAI pushes each item onto the chat and calls `sendChat` for it, but only
 * the first call generates: a generation leaves `doingChat` set, and every
 * later `sendChat(-1)` declines while it is. So the first item is a send that is
 * answered (`send`); the rest are the reader's messages with no reply
 * (`append`). On a card with triggers, the rest of that same `/multisend` land
 * nowhere — the start run has put a copy in place of the chat object the
 * command pushes onto — and only a later `/multisend`'s items are appended.
 * `clear` empties the chat before an item, as RisuAI does before each.
 */
export type ScriptTurn =
  | { kind: 'send'; content: string; clear: boolean }
  | { kind: 'append'; items: { content: string; clear: boolean }[] };

/** What a line of slash commands typed into the composer came to. */
export interface CommandOutcome {
  /** RisuAI's line answered `false`: the text goes as an ordinary message. */
  send: boolean;
  /** A command threw: nothing more happens, and the text goes back to the composer. */
  error?: string;
  /** The chat as the commands left it, when they changed it. */
  state?: ChatState;
  /** What `/multisend` asked for, for the page to take once this is done. */
  turns: ScriptTurn[];
}

/** How a send goes when it is not the reader's typing: `/multisend`'s. */
export interface PrepareOptions {
  /** RisuAI pushes the text as it is: no input triggers, no `editinput`. */
  raw?: boolean;
  /** The chat is emptied before the turn — the greeting stays. */
  clear?: boolean;
}

/**
 * The entries `lorebook` activates on `history` — the chat after its greeting —
 * in the shape RisuAI's `loadLoreBookV3Prompt` lists them: what `/test_lorebook`
 * shows and Lua's `loadLoreBooks` reads. The prompt's own activation
 * (`@shizue/core/lorebook`), fetched on first use, with the book's settings — and
 * RisuAI's 800 tokens where it names no budget — over token counts estimated at
 * four characters each. RisuAI's match log is not kept.
 */
export async function activeLore(
  lorebook: readonly LoreEntry[],
  history: string[],
  settings: LoreSettings | undefined,
  random?: () => number,
): Promise<LoreTest> {
  const { activateLore } = await import('@shizue/core/lorebook');
  const tokens = (text: string): number => Math.ceil(text.length / 4);
  const entries = [...lorebook];
  const { entries: active } = activateLore(entries, {
    history,
    scanDepth: settings?.scanDepth ?? 5,
    budgetTokens: settings?.tokenBudget ?? 800,
    countTokens: tokens,
    recursiveScanning: settings?.recursiveScanning ?? true,
    ...(settings?.maxRecursionSteps !== undefined ? { maxRecursionSteps: settings.maxRecursionSteps } : {}),
    risuMatching: settings?.risuMatching ?? true,
    ...(random ? { random } : {}),
  });
  return {
    actives: active.map((entry) => ({
      depth: entry.depth ?? 0,
      pos: '',
      prompt: entry.content,
      role: entry.role ?? 'system',
      order: entry.insertionOrder,
      tokens: tokens(entry.content),
      priority: entry.insertionOrder,
      source: entry.name || `lorebook ${entries.indexOf(entry)}`,
      inject: null,
    })),
    matchLog: [],
  };
}

/** The turn a send is about to store, as the start triggers see it on the branch. */
const NEW_TURN = '\u0000new-turn';

/** The branch after its greeting, as RisuAI's triggers read `chat.message`. */
function triggerMessages(messages: readonly ChatMessage[]): {
  greeting: string | null;
  chat: TriggerMessage[];
} {
  const first = messages[0];
  const greeting = first && first.parentId === null && first.role === 'assistant' ? first.content : null;
  const rest = greeting === null ? messages : messages.slice(1);
  return {
    greeting,
    chat: rest.map((message) => ({
      role: message.role === 'user' ? 'user' : 'char',
      data: message.content,
      id: message.id,
      time: Date.parse(message.createdAt),
    })),
  };
}

/** A delta the server will take, or nothing — logged — when the scripts made one too big to store. */
function storable(delta: VariableDelta | null, log: (entry: TriggerLogEntry) => void): VariableDelta | null {
  const check = checkVariableDelta(delta);
  if (check.ok) return check.delta;
  log({ kind: 'limit', message: `the scripts' variables could not be kept: ${check.error}` });
  return null;
}

/**
 * The branch the server holds once it takes `edits`, as the fold reads it: the
 * greeting, then the chat the runs left, each stored message with the delta it
 * carries (a copy keeps its message's). `messages` is the stretch of the branch
 * the runs read, `before` the trigger chat they were given — with the text they
 * were given it as — and `turn` a send's text, standing where `{turn: true}`
 * does, or last when the chat is as it was.
 */
function resultFold(
  messages: readonly ChatMessage[],
  before: readonly TriggerMessage[],
  edits: ScriptChat | null,
  turn?: string,
): FoldItem[] {
  const greeting = triggerMessages(messages).greeting !== null ? [messages[0]!] : [];
  const deltas = new Map(messages.map((message) => [message.id, message.variableDelta ?? null]));
  const stored = before.filter((message) => message.id !== undefined && message.id !== NEW_TURN);
  const byId = new Map(stored.map((message) => [message.id!, message]));
  const item = (message: TriggerMessage, content = message.data): FoldItem => ({
    content,
    variableDelta: deltas.get(message.id!) ?? null,
  });
  const chat: FoldItem[] = edits
    ? [
        ...stored.slice(0, edits.keep).map((message) => item(message)),
        ...edits.messages.map((entry): FoldItem =>
          'turn' in entry ? (turn ?? '') : 'id' in entry ? item(byId.get(entry.id)!, entry.content) : entry.content,
        ),
      ]
    : [...stored.map((message) => item(message)), ...(turn !== undefined ? [turn] : [])];
  return [...greeting, ...chat];
}

/** `items` with the last one's own delta left out: what a delta for that message is measured against. */
function withoutLastDelta(items: readonly FoldItem[]): FoldItem[] {
  const last = items.at(-1);
  if (last === undefined) return [];
  return [...items.slice(0, -1), typeof last === 'string' ? last : last.content];
}

/** The head's new text, when that is all the runs changed of the chat — kept where it stands, as ever. */
function headText(edits: ScriptChat | null, before: readonly TriggerMessage[], headId: string | undefined): string | undefined {
  if (!edits || edits.keep !== before.length - 1 || edits.messages.length !== 1) return undefined;
  const only = edits.messages[0]!;
  return 'id' in only && only.id === headId && !('role' in only) ? only.content : undefined;
}

/** Whether two trigger chats hold the same messages, in the same roles, with the same text. */
const sameChat = (a: readonly TriggerMessage[], b: readonly TriggerMessage[]): boolean =>
  a.length === b.length &&
  a.every((message, index) => message.id === b[index]!.id && message.role === b[index]!.role && message.data === b[index]!.data);

/** `before` with the head's text as `text`. */
const withHeadText = (before: readonly TriggerMessage[], text: string): TriggerMessage[] =>
  before.map((message, index) => (index === before.length - 1 ? { ...message, data: text } : message));

export interface ScriptRuntime {
  readonly bundle: ScriptBundle;
  /** Names a `{{button}}` or a `risu-trigger` can run. */
  readonly triggerNames: ReadonlySet<string>;
  /** Whether replies are finished in the browser — and so whether a generation asks for `postProcess`. */
  readonly finishesReplies: boolean;
  /** Whether messages are drawn through display triggers. */
  readonly rewritesDisplay: boolean;
  prepare(mode: StreamMode, view: ScriptView, content?: string, options?: PrepareOptions): Promise<PreparedGeneration>;
  /** Finishes the head reply the server holds `pending`; null when the head is not one. */
  finish(view: ScriptView): Promise<FinishedReply | null>;
  /** Runs the manual triggers named `name`; null when there was nothing to commit. */
  manual(name: string, triggerId: string | null, view: ScriptView): Promise<ChatState | null>;
  /**
   * A line typed into the composer starting with `/`, run as RisuAI's
   * `processMultiCommand`: what it did to the chat is committed on the head.
   */
  command(text: string, view: ScriptView): Promise<CommandOutcome>;
  /** `/multisend`'s unanswered messages (`ScriptTurn` `append`), committed on the head; null when none. */
  append(items: readonly { content: string; clear: boolean }[], view: ScriptView): Promise<ChatState | null>;
  /**
   * A `risu-btn` click: the engines' (Lua's `onButtonClick`) to answer, and what
   * they did committed on the head as a manual run's is; null when there was
   * nothing to commit.
   */
  button(data: string, view: ScriptView): Promise<ChatState | null>;
  /**
   * A message's text as the display triggers draw it, with the chat's variables
   * as they stand — the page's own fold, so drawing a message folds nothing.
   */
  display(text: string, view: ScriptView, variables: Variables): string;
  /** Whether an engine rewrites what messages show (Lua's `editDisplay`), which `displayEdits` answers. */
  readonly editsDisplay: boolean;
  /**
   * The engines' display listeners over several messages at once, by message
   * id — only the ones they changed. Asynchronous, unlike `display`: the page
   * draws a message as it stands until its answer arrives, and what the
   * listeners write stays with the screen. Runs before the display triggers,
   * whose input it becomes, as in RisuAI.
   */
  displayEdits(items: readonly { id: string; text: string }[], view: ScriptView, variables: Variables): Promise<Map<string, string>>;
  /** Ends what the engines keep running — the Lua sandbox. */
  dispose(): void;
}

export function createScriptRuntime(options: ScriptRuntimeOptions): ScriptRuntime {
  const { bundle, api, ui, chatId } = options;
  const engines = options.engines ?? [];
  const log = options.log ?? ((entry) => console.warn('[scripts]', entry.kind, entry.effect ?? '', entry.message));
  const triggers = bundle.triggers;
  const codeTriggers = triggers.some(isCodeTrigger);
  const engineHandles = (phase: ScriptPhase): boolean => engines.some((engine) => engine.handles(phase));
  /** Whether anything would run at `mode` — the interpreter's triggers, or an engine's code triggers. */
  const runsAt = (mode: Exclude<TriggerMode, 'request'>): boolean =>
    hasTriggersFor(triggers, mode) || (codeTriggers && engineHandles(mode));

  /** The work as the scripts see it: the card, with what this chat already rewrote of it. */
  let overlay: { member: MemberOverlay; persona: string | null } = {
    member: bundle.overlay.member ?? {},
    persona: bundle.overlay.persona,
  };

  /** RisuAI's `char.name` and `{{char}}`, over a session's patch: the nickname stays `{{char}}` through a rename. */
  const memberName = (patch: MemberOverlay): string =>
    patch.name ?? overlay.member.name ?? bundle.character.name ?? bundle.name;
  const charName = (patch: MemberOverlay): string => {
    const renamed = patch.name ?? overlay.member.name;
    return renamed === undefined ? bundle.name : bundle.character.nickname || renamed;
  };

  const character = (): TriggerCharacter => ({
    name: charName({}),
    memberName: memberName({}),
    ...(bundle.character.nickname ? { nickname: bundle.character.nickname } : {}),
    ...(overlay.member.firstMessage !== undefined ? { firstMessage: overlay.member.firstMessage } : {}),
    backgroundHtml: overlay.member.backgroundHtml ?? bundle.character.backgroundHtml ?? '',
    description: overlay.member.description ?? bundle.character.description,
    personality: bundle.character.personality,
    scenario: bundle.character.scenario,
    exampleDialogue: bundle.character.exampleDialogue,
    lorebook: overlay.member.lorebook ?? bundle.character.lorebook,
    postHistoryInstructions: overlay.member.postHistoryInstructions ?? bundle.character.postHistoryInstructions,
    lowLevelAccess: bundle.lowLevelAccess,
    triggers,
  });

  /**
   * One operation's view of the work: it starts from the runtime's copy, each run
   * reads what the runs before it left, and the patch is what the operation sends.
   */
  interface Session {
    view: ScriptView;
    persona: string;
    note: string;
    noteChanged: boolean;
    patch: MemberOverlay;
    personaPatch: string | undefined;
    /** The reader's global variables as the runs left them, and what they wrote. */
    globals: Variables;
    globalWrites: VariableDelta | null;
  }

  const session = (view: ScriptView): Session => ({
    view,
    persona: overlay.persona ?? view.persona,
    note: view.note,
    noteChanged: false,
    patch: {},
    personaPatch: undefined,
    globals: applyVariableDelta(view.globalVariables ?? {}, null),
    globalWrites: null,
  });

  /** The character as one operation's runs have it: the runtime's copy, with what the runs before rewrote. */
  const sessionCharacter = (s: Session): TriggerCharacter => {
    const base = character();
    const firstMessage = s.patch.firstMessage ?? base.firstMessage;
    return {
      ...base,
      name: charName(s.patch),
      memberName: memberName(s.patch),
      description: s.patch.description ?? base.description,
      lorebook: s.patch.lorebook ?? base.lorebook,
      postHistoryInstructions: s.patch.postHistoryInstructions ?? base.postHistoryInstructions,
      ...(firstMessage !== undefined ? { firstMessage } : {}),
      backgroundHtml: s.patch.backgroundHtml ?? base.backgroundHtml ?? '',
    };
  };

  /**
   * The branch as one operation's runs read it (`triggerMessages`): on the plot's
   * first opening, the greeting is the first message the scripts set
   * (`setCharacterFirstMessage`), as RisuAI draws and reads its greeting from the
   * character there. The stored greeting stays what the fold and the edits read.
   */
  const branchOf = (s: Session, messages: readonly ChatMessage[]): ReturnType<typeof triggerMessages> => {
    const read = triggerMessages(messages);
    const set = s.patch.firstMessage ?? overlay.member.firstMessage;
    return read.greeting !== null && s.view.firstGreeting === true && set !== undefined ? { ...read, greeting: set } : read;
  };

  /**
   * Hands what the runs wrote of the reader's global variables to the server,
   * where they belong to the reader and the plot rather than to the branch —
   * right away, as RisuAI writes them.
   */
  async function flushGlobals(s: Session): Promise<void> {
    if (!s.globalWrites) return;
    const writes = s.globalWrites;
    s.globalWrites = null;
    const answer = await api.send<{ variables: Variables }>('PATCH', `/api/chats/${chatId}/global-variables`, {
      variables: writes,
    });
    options.onGlobalVariables?.(answer.variables);
  }

  const driver: TriggerDriver = {
    alert: (text, error) => ui.alert(text, error),
    input: (text) => ui.input(text),
    select: (choices, display) => ui.select(choices, display),
    ...(options.wait ? { wait: options.wait } : {}),
    code: async (request) => {
      const engine = engines.find((candidate) => candidate.runCode);
      if (!engine?.runCode) {
        log({ kind: 'unsupported', effect: 'triggerlua', message: 'no Lua engine is installed' });
        return;
      }
      return engine.runCode(request);
    },
    // `runLLM`/`v2RunLLM`: the same call card Lua makes, on the reader's own
    // account — the chat's model, or its auxiliary model where a `v2RunLLM` asks
    // for RisuAI's sub model. A refusal (no lowLevelAccess, a busy chat, the model
    // failing) comes back as the failure the effect writes.
    llm: async (request) => {
      try {
        const answer = await api.send<{ result: string }>('POST', `/api/chats/${chatId}/script-llm`, {
          messages: request.messages,
          model: request.model === 'submodel' ? 'sub' : 'main',
        });
        return { ok: true, text: answer.result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    // `checkSimilarity`/`v2CheckSimilarity`: the reader's embedding model, in the
    // page's worker. A failure (the model would not load) stops the run there.
    similarity: async (request) => {
      if (!options.similarity) return { ok: false, error: 'no embedder is installed' };
      try {
        return { ok: true, texts: await options.similarity(request.source, request.texts) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    lore: (request) => testLore(request.lorebook, request.history),
    help: () => ui.help?.(),
  };

  /** `/test_lorebook`: the card's book, activated on `history` (`activeLore`). */
  const testLore = (lorebook: readonly LoreEntry[], history: string[]): Promise<LoreTest> =>
    activeLore(lorebook, history, bundle.character.loreSettings, options.random);

  /** A run's input over one operation's session: the work as the runs before it left it. */
  function runInput(
    s: Session,
    mode: TriggerMode,
    variables: Variables,
    chat: readonly TriggerMessage[],
    greeting: string | null,
  ): TriggerRunInput {
    return {
      mode,
      character: sessionCharacter(s),
      messages: chat,
      greeting,
      note: s.note,
      persona: s.persona,
      variables,
      globalVariables: s.globals,
      data: { ...s.view.data, user: s.view.names.user ?? s.view.data?.user },
      ...(options.random ? { random: options.random } : {}),
    };
  }

  /** Runs `mode` and folds what it rewrote into the session. */
  async function run(
    s: Session,
    mode: TriggerMode,
    variables: Variables,
    chat: readonly TriggerMessage[],
    greeting: string | null,
    extra: Partial<TriggerRunInput> = {},
  ): Promise<TriggerRunResult> {
    const result = await runTriggers({ ...runInput(s, mode, variables, chat, greeting), ...extra }, driver);
    took(s, result);
    return result;
  }

  /** What a run rewrote, into the session: its notes, the work, the globals, the persona and the note. */
  function took(s: Session, result: TriggerRunResult): void {
    for (const entry of result.log) log(entry);
    absorb(s, result.character);
    if (result.globalWrites) {
      s.globals = applyVariableDelta(s.globals, result.globalWrites);
      s.globalWrites = { ...(s.globalWrites ?? {}), ...result.globalWrites };
    }
    if (result.persona !== undefined) {
      s.persona = result.persona;
      s.personaPatch = result.persona;
    }
    if (result.note !== undefined) {
      s.note = result.note;
      s.noteChanged = true;
    }
  }

  function absorb(s: Session, rewrite: CharacterRewrite): void {
    if (rewrite.description !== undefined) s.patch.description = rewrite.description;
    if (rewrite.lorebook !== undefined) s.patch.lorebook = rewrite.lorebook;
    if (rewrite.postHistoryInstructions !== undefined) s.patch.postHistoryInstructions = rewrite.postHistoryInstructions;
    if (rewrite.name !== undefined) s.patch.name = rewrite.name;
    if (rewrite.firstMessage !== undefined) s.patch.firstMessage = rewrite.firstMessage;
    if (rewrite.backgroundHtml !== undefined) s.patch.backgroundHtml = rewrite.backgroundHtml;
  }

  /** The session's rewrites as the request fields that carry them. */
  function writes(s: Session): { overlay?: ScriptOverlay; note?: string } {
    const patch: ScriptOverlay | null = mergeScriptOverlay(null, {
      ...(Object.keys(s.patch).length > 0 ? { members: { [bundle.memberId]: s.patch } } : {}),
      ...(s.personaPatch !== undefined ? { persona: s.personaPatch } : {}),
    });
    return {
      ...(patch ? { overlay: patch } : {}),
      ...(s.noteChanged ? { note: s.note } : {}),
    };
  }

  /** Once the server has them, the runtime's copy of the overlay moves too — and the page's. */
  function kept(s: Session): void {
    overlay = {
      member: { ...overlay.member, ...s.patch },
      persona: s.personaPatch ?? overlay.persona,
    };
    if (Object.keys(s.patch).length > 0) options.onOverlay?.(overlay.member);
  }

  /**
   * A `CodeScope` over one operation's session, for an engine called outside a
   * trigger run — an edit listener, a button, a display pass. The variables are
   * its own copy (`variables()` is how the engine left them); the character, the
   * globals and the rest go through the session, as a trigger run's rewrites do.
   */
  function sessionScope(
    s: Session,
    variables: Variables,
    messages: TriggerMessage[],
    greeting: string | null,
  ): { scope: CodeScope; variables(): Variables; changed(): boolean } {
    const vars = applyVariableDelta(variables, null);
    let changed = false;
    const scope: CodeScope = {
      getVar: (name) => readVariable(vars, name) ?? 'null',
      setVar: (name, value) => {
        if (value === null) {
          if (readVariable(vars, name) === undefined) return;
          delete vars[name];
        } else {
          if (readVariable(vars, name) === value) return;
          vars[name] = value;
        }
        changed = true;
      },
      variables: () => applyVariableDelta(vars, null),
      getGlobalVar: (name) => readVariable(s.globals, name) ?? 'null',
      setGlobalVar: (name, value) => {
        s.globals = applyVariableDelta(s.globals, { [name]: value });
        s.globalWrites = { ...(s.globalWrites ?? {}), [name]: value };
      },
      globalVariables: () => applyVariableDelta(s.globals, null),
      messages,
      // Read through the session, so what one engine wrote the next one reads.
      get character() {
        return sessionCharacter(s);
      },
      setDescription: (text) => {
        s.patch.description = text;
      },
      setLorebook: (entries) => {
        s.patch.lorebook = entries;
      },
      setName: (name) => {
        s.patch.name = name;
      },
      setFirstMessage: (text) => {
        s.patch.firstMessage = text;
      },
      setBackgroundHtml: (html) => {
        s.patch.backgroundHtml = html;
      },
      user: s.view.names.user ?? s.view.data?.user ?? '',
      persona: s.persona,
      note: s.note,
      greeting,
    };
    return { scope, variables: () => vars, changed: () => changed };
  }

  /**
   * `text` through the engines' edit listeners and then the regex scripts of
   * `phase`, with the variables as the listeners left them. The listeners edit
   * the chat as RisuAI's do — the chat as stored, each one after the one before —
   * and `chat` is what they left of it: a copy of the chat given, as it was when
   * they wrote nothing there. Whether it is kept is the caller's, as in RisuAI.
   */
  async function edit(
    phase: Extract<EditPhase, 'editinput' | 'editoutput'>,
    text: string,
    variables: Variables,
    s: Session,
    meta: { chatIndex: number; previousSameRole?: string },
    chat: readonly TriggerMessage[],
    greeting: string | null,
  ): Promise<{ text: string; variables: Variables; chat: TriggerMessage[] }> {
    let data = text;
    let current = variables;
    const working = chat.map((message) => ({ ...message }));
    for (const engine of engines) {
      if (!engine.edit || !engine.handles(phase)) continue;
      const over = sessionScope(s, current, working, greeting);
      data = await engine.edit(phase, data, { chatIndex: meta.chatIndex }, over.scope);
      current = over.variables();
    }
    if (!hasEditScripts(bundle.editScripts, phase)) return { text: data, variables: current, chat: working };
    const edited = runEditScripts(data, bundle.editScripts, phase, {
      chatIndex: meta.chatIndex,
      ...(meta.previousSameRole !== undefined ? { previousSameRole: meta.previousSameRole } : {}),
      env: {
        variable: (name) => readVariable(current, name),
        globalVariable: (name) => readVariable(s.globals, name),
        ...(options.random ? { random: options.random } : {}),
        data: {
          ...s.view.data,
          user: s.view.names.user ?? s.view.data?.user,
          char: charName(s.patch),
          persona: s.persona,
          character: { description: s.patch.description ?? character().description },
        },
      },
      onSkip: (_script, reason) => log({ kind: 'error', effect: phase, message: reason }),
    });
    return { text: edited, variables: current, chat: working };
  }

  /**
   * What the runs left of the chat, against what they were given — null when
   * they left it as it was, or when it is more than the server takes (said, and
   * the chat goes on as it was).
   */
  function chatEdits(
    before: readonly TriggerMessage[],
    after: readonly TriggerMessage[],
    turnId?: string,
  ): ScriptChat | null {
    const edits = scriptChatOf(before, after, turnId);
    if (!edits) return null;
    const check = checkScriptChat(edits, { turn: turnId !== undefined });
    if (check.ok) return edits;
    log({ kind: 'limit', message: `what the scripts did to the chat could not be kept: ${check.error}` });
    return null;
  }

  /** The trigger chat of each branch the display triggers drew, by the branch's array. */
  const displayBranches = new WeakMap<readonly ChatMessage[], ReturnType<typeof triggerMessages>>();

  const commit = (body: Record<string, unknown>): Promise<ChatState> =>
    api.send<ChatState>('POST', `/api/chats/${chatId}/script-commit`, body);

  const finishesReplies = runsAt('output') || hasEditScripts(bundle.editScripts, 'editoutput') || engineHandles('editoutput');

  return {
    bundle,
    triggerNames: new Set([...manualTriggerNames(triggers), ...engines.flatMap((engine) => engine.manualNames?.() ?? [])]),
    finishesReplies,
    rewritesDisplay: hasTriggersFor(triggers, 'display'),

    async prepare(mode, view, content, prepareOptions = {}) {
      const s = session(view);
      const head = view.messages[view.messages.length - 1];
      const headId = head?.id ?? null;
      const body: Record<string, unknown> = {
        baseHeadId: headId,
        ...(finishesReplies ? { postProcess: true } : {}),
      };

      if (mode === 'send') {
        const text = content ?? '';
        const base = computeVariables(view.messages, view.defaults, view.names);
        const { greeting, chat } = branchOf(s, view.messages);
        let variables = base;
        let messages: TriggerMessage[] = chat;
        let input: TriggerRunResult | null = null;
        if (!prepareOptions.raw && runsAt('input')) {
          input = await run(s, 'input', variables, chat, greeting);
          variables = input.variables;
          messages = input.messages;
        }
        const typed = prepareOptions.raw
          ? { text, variables, chat: messages }
          : await edit('editinput', text, variables, s, { chatIndex: -1 }, messages, greeting);
        // RisuAI's editInput listener edits the chat as stored, and the send then
        // puts the input run's copy, with the turn on it, in its place
        // (`DefaultChatScreen`'s `sendMain`): what the listener did is gone. Not
        // when that run ended early — it hands back nothing, and the turn is
        // pushed onto the stored chat itself.
        if (input?.aborted) messages = typed.chat;
        else if (!sameChat(messages, typed.chat)) {
          log({ kind: 'dropped', effect: 'editinput', message: 'an editInput listener changed the chat, which the input run’s chat replaces' });
        }
        let sent = typed.text;
        variables = computeVariables([sent], typed.variables, view.names);
        // RisuAI pushes the turn onto the chat the input run left, and the start
        // run reads it there — and may edit around it, or cut it.
        let final: TriggerMessage[] = [...(prepareOptions.clear ? [] : messages), { role: 'user', data: sent, id: NEW_TURN }];
        let injections: PromptInjectionText | null = null;
        if (runsAt('start')) {
          const start = await run(s, 'start', variables, final, greeting);
          // What the runs wrote, without the macros of a turn that is not stored.
          const ran = applyVariableDelta(typed.variables, diffVariables(start.variables, variables));
          if (start.stopSending) {
            // The turn is not sent; what the runs did to the rest of the chat is kept.
            const rest = start.messages.filter((message) => message.id !== NEW_TURN);
            return stopped(s, view, view.messages, chat, rest, ran);
          }
          variables = start.messages.some((message) => message.id === NEW_TURN) ? start.variables : ran;
          injections = start.injections;
          final = start.messages;
        }
        // A start trigger may rewrite the turn being sent; that is the text it goes as.
        sent = final.find((message) => message.id === NEW_TURN)?.data ?? sent;
        const edits = chatEdits([...chat, { role: 'user', data: sent, id: NEW_TURN }], final, NEW_TURN);
        // Against what the server folds the message the chat ends on to without its
        // delta — the stored turn, unless the runs edited the chat around it.
        const plain = computeVariables(withoutLastDelta(resultFold(view.messages, chat, edits, sent)), view.defaults, view.names);
        const delta = storable(diffVariables(variables, plain), log);
        await flushGlobals(s);
        return {
          body: {
            ...body,
            ...(delta ? { variableDelta: delta } : {}),
            ...(injections ? injectionFields(injections) : {}),
            ...(edits ? { chat: edits } : {}),
            ...writes(s),
          },
          content: sent,
          stop: false,
          accept: () => kept(s),
        };
      }

      // Every other mode starts no turn of its own: the start triggers run on the
      // branch the generation reads — without the head a regenerate replaces.
      const replaces = mode === 'regenerate' && head?.role === 'assistant';
      const branch = replaces ? view.messages.slice(0, -1) : view.messages;
      if (!runsAt('start')) return { body, stop: false, accept: () => undefined };
      const base = computeVariables(branch, view.defaults, view.names);
      const { greeting, chat } = branchOf(s, branch);
      const start = await run(s, 'start', base, chat, greeting);
      if (start.stopSending) return stopped(s, view, branch, chat, start.messages, start.variables);
      const edits = chatEdits(chat, start.messages);
      // Against the branch the generation reads: the one the run left.
      const delta = storable(
        diffVariables(start.variables, computeVariables(resultFold(branch, chat, edits), view.defaults, view.names)),
        log,
      );
      await flushGlobals(s);
      return {
        body: {
          ...body,
          ...(delta ? { startDelta: delta } : {}),
          ...injectionFields(start.injections),
          ...(edits ? { chat: edits } : {}),
          ...writes(s),
        },
        stop: false,
        accept: () => kept(s),
      };
    },

    async finish(view) {
      const head = view.messages[view.messages.length - 1];
      if (!head || head.role !== 'assistant' || head.scriptState !== 'pending') return null;
      const s = session(view);
      const before = view.messages.slice(0, -1);
      const parent = computeVariables(before, view.defaults, view.names);
      const { greeting, chat } = branchOf(s, view.messages);
      // RisuAI's index for the message, the greeting being -1.
      const chatIndex = chat.length - 1;
      const previous =
        [...chat.slice(0, -1)].reverse().find((message) => message.role === 'char')?.data ?? greeting ?? '';
      const stored = { content: head.content, variableDelta: head.variableDelta ?? null };
      const asStored = computeVariables([stored], parent, view.names);
      const reply = await edit(
        'editoutput',
        head.content,
        asStored,
        s,
        { chatIndex, previousSameRole: previous },
        chat,
        greeting,
      );
      let text = reply.text;

      // The reply's text may have changed under its macros, so the fold is taken
      // again — and what the listeners wrote laid back over it.
      let variables = applyVariableDelta(
        computeVariables([{ content: text, variableDelta: stored.variableDelta }], parent, view.names),
        diffVariables(reply.variables, asStored),
      );
      let followUp = false;
      const withReply = withHeadText(chat, text);
      // RisuAI's editOutput listener edits the chat as stored, the reply on it; the
      // reply's place then takes the text it came to — by its index, whatever the
      // listener did there (`message[msgIndex].data`) — and the output triggers
      // run on that chat. Said, like theirs, against the chat with the reply's text.
      const listened = reply.chat.map((message, index) => (index === chatIndex ? { ...message, data: text } : message));
      let edits: ScriptChat | null = chatEdits(withReply, listened);
      if (runsAt('output')) {
        const output = await run(s, 'output', variables, listened, greeting);
        variables = output.variables;
        followUp = output.sendAIprompt;
        edits = chatEdits(withReply, output.messages);
      }
      // A rewrite of the reply alone is its text; anything more is the chat.
      const reworded = headText(edits, withReply, head.id);
      if (reworded !== undefined) {
        text = reworded;
        edits = null;
      }
      // Against the message the chat now ends on — the reply, unless the output
      // triggers added after it or cut it — without its own delta.
      const plain = computeVariables(
        withoutLastDelta(resultFold(view.messages, edits ? withReply : withHeadText(chat, text), edits)),
        view.defaults,
        view.names,
      );
      const delta = storable(diffVariables(variables, plain), log);
      await flushGlobals(s);
      const state = await commit({
        messageId: head.id,
        scriptRev: head.scriptRev ?? 0,
        clearPending: true,
        // Always sent: it replaces the delta the server computed for the reply —
        // or, with a chat, is the delta of the message it ends on.
        variableDelta: delta,
        // The reply as its edit scripts left it, in place; the chat is said against it.
        ...(text !== head.content ? { content: text } : {}),
        ...(edits ? { chat: edits } : {}),
        ...writes(s),
      });
      kept(s);
      return { state, followUp };
    },

    async manual(name, triggerId, view) {
      if (!name) return null;
      const s = session(view);
      const base = computeVariables(view.messages, view.defaults, view.names);
      const { greeting, chat } = branchOf(s, view.messages);
      const result = await run(s, 'manual', base, chat, greeting, {
        manualName: name,
        triggerId,
      });
      return commitRun(s, view, view.messages, chat, chatEdits(chat, result.messages), result.variables, result.variablesChanged);
    },

    async command(text, view) {
      const s = session(view);
      const base = computeVariables(view.messages, view.defaults, view.names);
      const { greeting, chat } = branchOf(s, view.messages);
      const result = await runCommands({ ...runInput(s, 'manual', base, chat, greeting), command: text }, driver);
      took(s, result);
      // What the line did stands even when a command threw after it, as in RisuAI.
      const state = await commitRun(s, view, view.messages, chat, chatEdits(chat, result.messages), result.variables, result.variablesChanged);
      const failure = result.log.filter((entry) => entry.kind === 'error' || entry.kind === 'limit').at(-1);
      return {
        send: !result.aborted && result.answer === false,
        ...(result.aborted ? { error: failure?.message ?? '' } : {}),
        ...(state ? { state } : {}),
        turns: multisendTurns(result.multisend),
      };
    },

    async append(items, view) {
      const s = session(view);
      const base = computeVariables(view.messages, view.defaults, view.names);
      const { chat } = triggerMessages(view.messages);
      let after = chat.map((message) => ({ ...message }));
      for (const { content, clear } of items) {
        if (clear) after = [];
        after.push({ role: 'user', data: content });
      }
      return commitRun(s, view, view.messages, chat, chatEdits(chat, after), base, false);
    },

    async button(data, view) {
      const engine = engines.find((candidate) => candidate.button && candidate.handles('button'));
      if (!engine?.button) {
        log({ kind: 'unsupported', effect: 'risu-btn', message: 'nothing on this card answers a risu-btn' });
        return null;
      }
      const s = session(view);
      const base = computeVariables(view.messages, view.defaults, view.names);
      const { greeting, chat } = branchOf(s, view.messages);
      const working = chat.map((message) => ({ ...message }));
      const over = sessionScope(s, base, working, greeting);
      await engine.button(data, over.scope);
      return commitRun(s, view, view.messages, chat, chatEdits(chat, working), over.variables(), over.changed());
    },

    display(text, view, variables) {
      if (!hasTriggersFor(triggers, 'display')) return text;
      // Every message of a branch is drawn against the same branch: built once.
      let branch = displayBranches.get(view.messages);
      if (!branch) {
        branch = branchOf(session(view), view.messages);
        displayBranches.set(view.messages, branch);
      }
      const { greeting, chat } = branch;
      const base = character();
      const result = runTriggersSync({
        mode: 'display',
        character: base,
        messages: chat,
        greeting,
        note: view.note,
        persona: overlay.persona ?? view.persona,
        variables,
        displayData: text,
        ...(view.globalVariables ? { globalVariables: view.globalVariables } : {}),
        data: { ...view.data, user: view.names.user ?? view.data?.user },
        ...(options.random ? { random: options.random } : {}),
      });
      return result.displayData ?? text;
    },

    editsDisplay: engineHandles('editdisplay'),

    async displayEdits(items, view, variables) {
      const shown = new Map<string, string>();
      const engine = engines.find((candidate) => candidate.display && candidate.handles('editdisplay'));
      if (!engine?.display || items.length === 0) return shown;
      const s = session(view);
      const { greeting, chat } = branchOf(s, view.messages);
      // RisuAI's index for a message, the greeting being -1.
      const index = new Map(chat.map((message, at) => [message.id, at]));
      const over = sessionScope(s, variables, chat, greeting);
      const texts = await engine.display(
        items.map((item) => ({ text: item.text, chatIndex: index.get(item.id) ?? -1 })),
        over.scope,
      );
      items.forEach((item, at) => {
        const text = texts[at];
        if (typeof text === 'string' && text !== item.text) shown.set(item.id, text);
      });
      return shown;
    },

    dispose() {
      for (const engine of engines) engine.dispose?.();
    },
  };

  /** A line's `/multisend`s as the turns RisuAI ends up taking for them (`ScriptTurn`). */
  function multisendTurns(multisend: readonly CommandMultisend[]): ScriptTurn[] {
    const turns: ScriptTurn[] = [];
    const appended: { content: string; clear: boolean }[] = [];
    for (const { items, clear } of multisend) {
      const answered = turns.length === 0 && items.length > 0;
      for (const [index, content] of items.entries()) {
        if (answered && index === 0) turns.push({ kind: 'send', content, clear });
        else if (!(answered && triggers.length > 0)) appended.push({ content, clear });
      }
    }
    if (appended.length > 0) turns.push({ kind: 'append', items: appended });
    return turns;
  }

  /**
   * What a run did, committed on the head — a manual run's, a button's, a
   * stopped start run's: the variables it left, as the delta of the message the
   * chat now ends on; what it did to the chat — the head's text in place when
   * that is all, else the chat itself; the overlay and the note. `branch` is the
   * stretch of the chat the run read and `before` the trigger chat it was given.
   * Null when it changed none of them.
   */
  async function commitRun(
    s: Session,
    view: ScriptView,
    branch: readonly ChatMessage[],
    before: readonly TriggerMessage[],
    edits: ScriptChat | null,
    variables: Variables,
    variablesChanged: boolean,
  ): Promise<ChatState | null> {
    const head = view.messages[view.messages.length - 1];
    const content = headText(edits, before, head?.id);
    const chat = content === undefined ? edits : null;
    await flushGlobals(s);
    const fields = writes(s);
    if (!variablesChanged && !edits && !fields.overlay && fields.note === undefined) return null;
    if (!head) {
      log({ kind: 'dropped', message: 'a chat with no message has nowhere to keep what a button did' });
      return null;
    }
    const result = resultFold(branch, content === undefined ? before : withHeadText(before, content), chat);
    const delta = storable(diffVariables(variables, computeVariables(withoutLastDelta(result), view.defaults, view.names)), log);
    const state = await commit({
      messageId: head.id,
      scriptRev: head.scriptRev ?? 0,
      variableDelta: delta,
      ...(content !== undefined ? { content } : {}),
      ...(chat ? { chat } : {}),
      ...fields,
    });
    kept(s);
    return state;
  }

  /**
   * A start run that said not to send: nothing is generated. What it did to the
   * chat is kept all the same — RisuAI saves the chat its start triggers left
   * before it looks at the stop — committed on the head with the values the runs
   * wrote and what they rewrote of the work. A regenerate's run read the branch
   * without the head it was to replace, so its chat leaves that head off the
   * branch, as RisuAI's reroll has already taken it off the chat. A run that left
   * the chat as it was keeps nothing, as before.
   */
  async function stopped(
    s: Session,
    view: ScriptView,
    branch: readonly ChatMessage[],
    before: readonly TriggerMessage[],
    after: readonly TriggerMessage[],
    variables: Variables,
  ): Promise<PreparedGeneration> {
    const nothing: PreparedGeneration = { body: {}, stop: true, accept: () => undefined };
    const edits = chatEdits(before, after);
    if (!edits) return nothing;
    const state = await commitRun(s, view, branch, before, edits, variables, true);
    return state ? { ...nothing, state } : nothing;
  }
}

function injectionFields(injections: { start: string; historyend: string; promptend: string }): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(injections).filter(([, text]) => text.trim() !== ''));
  return Object.keys(kept).length > 0 ? { injections: kept } : {};
}
