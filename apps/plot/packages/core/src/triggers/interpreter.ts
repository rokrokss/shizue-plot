/**
 * RisuAI's trigger interpreter (`runTrigger` in its `process/triggers.ts`),
 * ported to run in the reader's browser against our chat.
 *
 * A card's triggers are a list. A run takes the ones for its mode — `start`
 * before every generation, `input` before the reader's turn is sent, `output`
 * after a reply arrives, `display` while a message is drawn, `manual` by name
 * when a button or another trigger asks for one — checks each one's conditions,
 * and steps through its effects: the v1 effects (`setvar`, `systemprompt`, …)
 * and the v2 block language (`v2If`/`v2Else`/`v2EndIndent`, loops, local
 * variables, string, array and dict operations, lore and chat access).
 *
 * The control flow is RisuAI's, quirks included, because a card's logic was
 * tested against them: a false `v2If` skips to the first `v2EndIndent` one
 * level in and takes a `v2Else` right after it; a `v2LoopNTimes` counts its
 * passes per trigger by the loop's position and never resets the count;
 * `v2BreakLoop` leaves through the next end of any loop; `=` compares as numbers
 * whenever both sides read as one (`'' = 0`). Every value is a string, and an
 * unset variable reads as the string `null`.
 *
 * What is ours:
 * - The effects that reach outside the run are requests, not calls. The run is
 *   a generator that yields one (`TriggerRequest`) wherever RisuAI would await
 *   the screen or the clock — an alert, a question, a wait, a Lua block — and the
 *   driver answers it. `runTriggersSync` drives a run that may not wait (the
 *   display mode, whose allowed effects never ask), `runTriggers` one that may.
 * - Nothing is stored here. A run returns what it changed — the variables, the
 *   prompt text a start trigger asked for, the chat as it left it, the
 *   character's fields it rewrote — and the caller decides where each goes
 *   (`messages.variable_delta`, the generation request, `chats.script_overlay`).
 * - Effects this product cannot carry out — image generation, a model call,
 *   rewriting the request — are logged and leave what RisuAI leaves on failure
 *   (`TRIGGER_CLASSIFICATION`).
 * - RisuAI's slash commands (`command`, `v2Command`, `command.ts`) act on the
 *   chat as stored, not on the run's copy, and so does the CBS RisuAI reads
 *   variables through. The run keeps that chat beside its own (`Stored`), and
 *   its result is what RisuAI's caller leaves once it writes the run's copy back:
 *   the copy, over everything the commands did — except the variables of an
 *   input run that wrote none itself, which RisuAI writes back only as messages,
 *   and the whole stored chat when the run ended early and wrote nothing back.
 * - Hard limits RisuAI does not have: steps per run, nesting, how long a value
 *   may grow, how long a wait may last. Past one the run stops as though a step
 *   had returned (`aborted`), keeping the variables it already wrote — as
 *   RisuAI keeps them, since its writes go through to the chat as they happen.
 *
 * Deterministic where RisuAI is: the only randomness is `v2Random` and the
 * evaluator's own dice, both drawn from the run's `random`.
 */

import type { CbsChat, CbsHostData, CbsMessage } from '../cbs.js';
import type { LoreEntry } from '../types.js';
import { applyVariableDelta, emptyVariables, readVariable, type VariableDelta, type Variables } from '../variables.js';
import { risuCalculate } from './calc.js';
import { parseChatML, type ScriptChatTurn } from './chatML.js';
import { evaluateScriptCbs, type ScriptCbsEnv } from './cbsHost.js';
import { loreTestOf, processMultiCommand, type CommandAnswer, type CommandHost, type LoreTest } from './command.js';
import { isCodeTrigger, type TriggerMode, type TriggerScript, type TriggerStep } from './scripts.js';

/* ------------------------------------------------------------------ inputs */

/** One message after the greeting, as RisuAI's `chat.message` holds it. */
export interface TriggerMessage {
  role: 'user' | 'char';
  data: string;
  /** The stored message it came from; absent for one a trigger appended. */
  id?: string;
  time?: number;
}

/** The character a run belongs to — the card whose triggers these are. */
export interface TriggerCharacter {
  /** `{{char}}` in the scripts' text. */
  name: string;
  description: string;
  personality?: string;
  scenario?: string;
  exampleDialogue?: string;
  lorebook: readonly LoreEntry[];
  /** RisuAI's `replaceGlobalNote`. */
  postHistoryInstructions: string;
  lowLevelAccess: boolean;
  triggers: readonly TriggerScript[];
}

export interface TriggerRunInput {
  mode: TriggerMode;
  character: TriggerCharacter;
  /** The branch after its greeting, oldest first — the whole of it. */
  messages: readonly TriggerMessage[];
  /** The greeting the branch opened on, for `v2GetFirstMessage`; null when there is none. */
  greeting?: string | null;
  /** The chat's author's note. */
  note: string;
  /** The reader's persona description. */
  persona: string;
  /** The chat variables the run starts from — the branch's fold. Not modified. */
  variables: Variables;
  /** Runs the triggers named this, whatever their mode — RisuAI's `manualName`. */
  manualName?: string;
  /** The `risu-id` of the element that asked for a manual run, for `{{trigger_id}}`. */
  triggerId?: string | null;
  /** The message text a display run rewrites (`v2GetDisplayState`/`v2SetDisplayState`). */
  displayData?: string;
  /**
   * The reader's global variables on the plot, for `{{getglobalvar}}` and `@name`.
   * Nothing in RisuAI's trigger language writes one; code may (`CodeScope`), and
   * what it wrote comes back as `globalWrites`.
   */
  globalVariables?: Variables;
  /** What the evaluator may tell the scripts besides the run's own state. */
  data?: Omit<CbsHostData, 'chat' | 'character' | 'persona' | 'triggerId' | 'lorebook' | 'char'>;
  random?(): number;
}

/* ---------------------------------------------------------------- requests */

/**
 * What a run asks its driver for. Each is answered with the value noted, or a
 * run that cannot wait (`runTriggersSync`) gives up there.
 */
export type TriggerRequest =
  /** An alert. Answered with nothing. */
  | { kind: 'alert'; text: string; error?: boolean }
  /** A line of text from the reader. Answered with a string. */
  | { kind: 'input'; text: string }
  /** One of `options`. Answered with the chosen string. */
  | { kind: 'select'; options: string[]; display?: string }
  /** A pause. Answered with nothing. */
  | { kind: 'wait'; ms: number }
  /**
   * A block of code for another engine (`triggerlua`), at its place in the list.
   * Answered with `{ stopSending?: boolean }`, or nothing when no engine took it.
   * `scope` is the run as the code sees it — RisuAI hands its Lua the same.
   */
  | { kind: 'code'; language: 'lua'; code: string; mode: string; lowLevelAccess: boolean; scope: CodeScope }
  /**
   * A model call (`runLLM`, `v2RunLLM`) — on the chat's model, or on its
   * auxiliary model for `submodel`, and the reader's own account, through the
   * API. Answered with a `ScriptLlmAnswer`; a run with no one to answer it reads
   * that as a failure.
   */
  | { kind: 'llm'; messages: ScriptChatTurn[]; model: 'model' | 'submodel' }
  /**
   * An embedding search (`checkSimilarity`, `v2CheckSimilarity`): `texts`
   * ordered by how close each is to `source`, by RisuAI's default embedder in
   * the reader's browser. Answered with a `ScriptSimilarityAnswer`; a run with
   * no one to answer it reads that as a failure.
   */
  | { kind: 'similarity'; source: string; texts: string[] }
  /**
   * `/test_lorebook`: what RisuAI's `loadLoreBookV3Prompt` would activate of
   * `lorebook` on `history`, the chat as stored, oldest first. Answered with a
   * `LoreTest`; nothing answering it finds nothing.
   */
  | { kind: 'lore'; history: string[]; lorebook: readonly LoreEntry[] }
  /** `/?`: RisuAI's list of the slash commands. Answered with nothing. */
  | { kind: 'help' };

/** What a model call came back with. */
export type ScriptLlmAnswer = { ok: true; text: string } | { ok: false; error: string };

/** A model call nobody could make. */
const NO_MODEL_ERROR = 'model calls are not available here';
const NO_MODEL: ScriptLlmAnswer = { ok: false, error: NO_MODEL_ERROR };

/** Whatever answered an `llm` request, read as an answer — anything else is a failure. */
function llmAnswer(raw: unknown): ScriptLlmAnswer {
  if (!raw || typeof raw !== 'object') return NO_MODEL;
  const answer = raw as Record<string, unknown>;
  if (answer['ok'] === true && typeof answer['text'] === 'string') return { ok: true, text: answer['text'] };
  return { ok: false, error: typeof answer['error'] === 'string' ? answer['error'] : NO_MODEL_ERROR };
}

/** What an embedding search came back with: the texts, best first. */
export type ScriptSimilarityAnswer = { ok: true; texts: string[] } | { ok: false; error: string };

/** A search nobody could make. */
const NO_EMBEDDER_ERROR = 'embeddings are not available here';
const NO_EMBEDDER: ScriptSimilarityAnswer = { ok: false, error: NO_EMBEDDER_ERROR };

/** Whatever answered a `similarity` request, read as an answer — anything else is a failure. */
function similarityAnswer(raw: unknown): ScriptSimilarityAnswer {
  if (!raw || typeof raw !== 'object') return NO_EMBEDDER;
  const answer = raw as Record<string, unknown>;
  const texts = answer['texts'];
  if (answer['ok'] === true && Array.isArray(texts) && texts.every((text) => typeof text === 'string')) {
    return { ok: true, texts };
  }
  return { ok: false, error: typeof answer['error'] === 'string' ? answer['error'] : NO_EMBEDDER_ERROR };
}

/** What a script sends: its text as ChatML turns where it is ChatML, else one user turn (RisuAI). */
const llmTurns = (text: string): ScriptChatTurn[] => parseChatML(text) ?? [{ role: 'user', content: text }];

/**
 * What code running inside a trigger may touch: the chat variables and the chat
 * of this run, the reader's global variables, and the parts of the character,
 * the persona and the chat note RisuAI's Lua reads — `getChatVar`/`setChatVar`,
 * `getGlobalVar`, `getChat`/`setChat`, `getDescription`/`setDescription`,
 * `getLoreBooks`/`upsertLocalLoreBook`, `getPersonaDescription`,
 * `getAuthorsNote`.
 *
 * The same shape is what the browser's runtime hands an engine outside a
 * trigger run (an edit listener, a `risu-btn` click), so an engine has one way
 * to read the chat and one way to write it back wherever it was called from.
 *
 * Code in another engine cannot call back into this one synchronously, so it is
 * given what it reads up front — `variables()` and `globalVariables()` are every
 * value `getVar` and `getGlobalVar` would answer — and hands what it wrote back
 * through the setters once it is done.
 */
export interface CodeScope {
  getVar(name: string): string;
  /** `null` unsets — what RisuAI's Lua leaves for a `nil`, which reads back as `null`. */
  setVar(name: string, value: string | null): void;
  /** Every chat variable `getVar` answers for, by name — the run's locals over the chat's. */
  variables(): Variables;
  getGlobalVar(name: string): string;
  /** `null` unsets. */
  setGlobalVar(name: string, value: string | null): void;
  /** The reader's global variables as the run has them. */
  globalVariables(): Variables;
  /** The run's chat, which the code may edit in place. */
  messages: TriggerMessage[];
  /** The character as the run has it, with what the run already rewrote of it. */
  readonly character: { readonly name: string; readonly description: string; readonly lorebook: readonly LoreEntry[] };
  setDescription(text: string): void;
  setLorebook(entries: LoreEntry[]): void;
  /** The reader's persona name (`{{user}}`) and description. */
  readonly user: string;
  readonly persona: string;
  /** The chat note. */
  readonly note: string;
  /** The greeting the branch opened on, or null. */
  readonly greeting: string | null;
}

/* ----------------------------------------------------------------- results */

export interface PromptInjectionText {
  start: string;
  historyend: string;
  promptend: string;
}

/** The character fields a run rewrote; absent ones it never touched. */
export interface CharacterRewrite {
  description?: string;
  lorebook?: LoreEntry[];
  postHistoryInstructions?: string;
}

export interface TriggerLogEntry {
  /** What happened: an effect this product does not carry out, or a limit reached. */
  kind: 'unsupported' | 'limit' | 'error' | 'dropped';
  effect?: string;
  message: string;
}

export interface TriggerRunResult {
  /**
   * The chat variables as the run left them: its own, or — for an input run
   * that wrote none itself, or one that ended early — the chat's as stored, with
   * what slash commands wrote there.
   */
  variables: Variables;
  /** Whether any chat variable was written. A display run's writes are its own and never count. */
  variablesChanged: boolean;
  /** What start triggers asked to put in the prompt, RisuAI's `additonalSysPrompt`. */
  injections: PromptInjectionText;
  /** `stop` / `v2StopPromptSending`: the generation this run started for does not happen. */
  stopSending: boolean;
  /** `sendAIprompt`: another reply is asked for once this one is done. */
  sendAIprompt: boolean;
  /**
   * The chat as the run left it — its own working copy; or, when it ended
   * early, the chat as stored, with what slash commands did to it.
   */
  messages: TriggerMessage[];
  character: CharacterRewrite;
  persona?: string;
  note?: string;
  /** A display run's rewritten text. */
  displayData?: string;
  /** The global variables code wrote, as their final values (`null` unset); null when none. */
  globalWrites: VariableDelta | null;
  /**
   * A step ended the run early — RisuAI's `return` — or a limit did. The prompt
   * text, the chat and the stop it gathered are dropped, as RisuAI drops the
   * whole result then; the variables it wrote stay.
   */
  aborted: boolean;
  log: TriggerLogEntry[];
}

/** A line of slash commands typed into the composer, run on the chat as it stands. */
export interface CommandRunInput extends Omit<TriggerRunInput, 'mode' | 'manualName' | 'triggerId' | 'displayData'> {
  command: string;
}

/** `/multisend`'s items, as the line gave them. */
export interface CommandMultisend {
  items: string[];
  clear: boolean;
}

/**
 * What the line did: `messages` and `variables` are the chat as the commands
 * left it — there is no run's copy to write back over it — and `aborted` says a
 * command threw (RisuAI's line rejects, and the composer keeps the text).
 */
export interface CommandRunResult extends TriggerRunResult {
  /** The line's answer. `false`: RisuAI sends the text as an ordinary message. */
  answer: CommandAnswer;
  /** The `/multisend`s the line ran, in order — the composer's to send. */
  multisend: CommandMultisend[];
}

/* ------------------------------------------------------------------ limits */

/** Effects one run may step through, nested runs included. RisuAI has none and sleeps every hundred loops. */
export const MAX_TRIGGER_STEPS = 100_000;
/** How deep `runtrigger` may nest, whatever `lowLevelAccess` says. */
export const MAX_TRIGGER_DEPTH = 50;
/** A wait longer than this is cut to it. */
export const MAX_TRIGGER_WAIT_MS = 30_000;
/** The longest value a variable may be given; past it the run stops. The fold's own ceiling. */
export const MAX_TRIGGER_VALUE_LENGTH = 100_000;

class Abort extends Error {}

/** The effects a display run may take — RisuAI's `displayAllowList`. */
const SAFE_SUBSET = new Set([
  'v2SetVar', 'v2If', 'v2IfAdvanced', 'v2Else', 'v2EndIndent', 'v2LoopNTimes', 'v2BreakLoop',
  'v2ConsoleLog', 'v2StopTrigger', 'v2Random', 'v2ExtractRegex', 'v2RegexTest', 'v2GetCharAt',
  'v2GetCharCount', 'v2ToLowerCase', 'v2ToUpperCase', 'v2SetCharAt', 'v2SplitString',
  'v2JoinArrayVar', 'v2ConcatString', 'v2MakeArrayVar', 'v2GetArrayVarLength', 'v2GetArrayVar',
  'v2SetArrayVar', 'v2PushArrayVar', 'v2PopArrayVar', 'v2ShiftArrayVar', 'v2UnshiftArrayVar',
  'v2SpliceArrayVar', 'v2SliceArrayVar', 'v2GetIndexOfValueInArrayVar', 'v2RemoveIndexFromArrayVar',
  'v2Calculate', 'v2Comment', 'v2DeclareLocalVar',
]);
const DISPLAY_ALLOWED = new Set(['v2GetDisplayState', 'v2SetDisplayState', ...SAFE_SUBSET]);
const REQUEST_ALLOWED = new Set([
  'v2GetRequestState', 'v2SetRequestState', 'v2GetRequestStateRole', 'v2SetRequestStateRole',
  'v2GetRequestStateLength', ...SAFE_SUBSET,
]);

/* ------------------------------------------------------------ the run state */

/** What every run of one call shares, nested runs included. */
interface Shared {
  input: TriggerRunInput;
  variables: Variables;
  variablesChanged: boolean;
  /** A display run's writes, which never reach the chat (RisuAI's `tempVars`). */
  tempVariables: Variables;
  /** The reader's global variables as the run has them, and what it wrote of them. */
  globals: Variables;
  globalWrites: VariableDelta;
  character: { description: string; lorebook: LoreEntry[]; postHistoryInstructions: string };
  rewrote: Set<keyof CharacterRewrite>;
  persona: string;
  personaChanged: boolean;
  note: string;
  noteChanged: boolean;
  steps: number;
  random: () => number;
  log: TriggerLogEntry[];
  display: boolean;
  /** The chat as stored, which the slash commands act on. */
  stored: Stored;
  /** The composer's `/multisend`s, in order. */
  multisend: CommandMultisend[];
}

/**
 * The chat as stored, beside the run's copy (`Run.messages`, `Shared.variables`).
 * RisuAI's commands edit it, and its CBS reads its variables. Those start as the
 * run's own — `base` null — and stay so: RisuAI's `setVar` hands the stored chat
 * the run's `scriptstate` whenever it changes a value, which drops whatever
 * commands had written there (`overlay`). A `/trigger` leaves a chat of its own,
 * its variables a value (`base`) until the run writes again.
 */
interface Stored {
  messages: TriggerMessage[];
  base: Variables | null;
  overlay: Variables;
  /** Whether a command wrote a variable here or a `/trigger` replaced it. */
  written: boolean;
}

/** The stored chat's variables, whole. */
function storedVariables(shared: Shared): Variables {
  return applyVariableDelta(shared.stored.base ?? shared.variables, shared.stored.overlay);
}

/** What one `runTrigger` call holds — a nested `runtrigger` gets its own. */
interface Run {
  mode: TriggerMode;
  manualName: string | undefined;
  messages: TriggerMessage[];
  injections: PromptInjectionText;
  stopSending: boolean;
  sendAIprompt: boolean;
  displayData: string | undefined;
  recursiveCount: number;
  depth: number;
  /** RisuAI's `varChanged`: this call, not a nested one, changed a chat variable. */
  wroteVariables: boolean;
  /** The composer's line, run in place of the triggers; its answer goes to `answer`. */
  command?: string;
  answer?: CommandAnswer;
}

const str = (step: TriggerStep, field: string): unknown => step[field];

const num = (text: string): number => Number(text);

/** RisuAI's `String(value)` of what a JSON array or dict held, for a variable. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : String(value));

function emptyInjections(): PromptInjectionText {
  return { start: '', historyend: '', promptend: '' };
}

/* ----------------------------------------------------------------- the run */

/**
 * Runs `input.mode`'s triggers. A generator: it yields a `TriggerRequest`
 * wherever the run has to wait for the reader or another engine, and returns
 * the result. Drive it with `runTriggers` or `runTriggersSync`.
 */
export function* triggerRun(input: TriggerRunInput): Generator<TriggerRequest, TriggerRunResult, unknown> {
  return (yield* execute(input)).result;
}

/**
 * Runs a line of slash commands the reader typed — RisuAI's composer, which
 * hands a message starting with `/` to `processMultiCommand` — on the chat as it
 * stands. A generator like `triggerRun`; drive it with `runCommands`. A
 * `/trigger` in it runs the manual triggers as a button would.
 */
export function* commandRun(input: CommandRunInput): Generator<TriggerRequest, CommandRunResult, unknown> {
  const { command, ...rest } = input;
  const { result, top, shared } = yield* execute({ ...rest, mode: 'manual' }, command);
  return { ...result, answer: result.aborted ? undefined : top.answer, multisend: shared.multisend };
}

function* execute(
  input: TriggerRunInput,
  command?: string,
): Generator<TriggerRequest, { result: TriggerRunResult; top: Run; shared: Shared }, unknown> {
  const display = input.mode === 'display';
  const shared: Shared = {
    input,
    // A copy: the caller's fold is not the run's to change.
    variables: applyVariableDelta(input.variables, null),
    variablesChanged: false,
    tempVariables: emptyVariables(),
    globals: applyVariableDelta(input.globalVariables ?? {}, null),
    globalWrites: Object.create(null) as VariableDelta,
    character: {
      description: input.character.description,
      lorebook: input.character.lorebook.map((entry) => ({ ...entry })),
      postHistoryInstructions: input.character.postHistoryInstructions,
    },
    rewrote: new Set(),
    persona: input.persona,
    personaChanged: false,
    note: input.note,
    noteChanged: false,
    steps: 0,
    random: input.random ?? Math.random,
    log: [],
    display,
    stored: {
      messages: input.messages.map((message) => ({ ...message })),
      base: null,
      overlay: emptyVariables(),
      written: false,
    },
    multisend: [],
  };
  const top: Run = {
    mode: input.mode,
    manualName: input.manualName,
    messages: input.messages.map((message) => ({ ...message })),
    injections: emptyInjections(),
    stopSending: false,
    sendAIprompt: false,
    displayData: input.displayData,
    recursiveCount: 0,
    depth: 0,
    wroteVariables: false,
    ...(command !== undefined ? { command } : {}),
  };

  let completed = false;
  try {
    completed = yield* runOnce(shared, top);
  } catch (error) {
    if (!(error instanceof Abort)) {
      shared.log.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    completed = false;
  }

  const character: CharacterRewrite = {};
  for (const field of shared.rewrote) {
    (character as Record<string, unknown>)[field] = shared.character[field];
  }
  // What RisuAI's caller leaves: the run's copy written over the stored chat
  // (`setCurrentChat(triggerResult.chat)`), except that an input run's copy goes
  // back as messages alone, and its variables only when it changed one
  // (`varChanged`); a run that ended early returns nothing to write. A line from
  // the composer has no copy: the stored chat is the chat.
  const storedChat = !completed || command !== undefined;
  const storedVars = storedChat || (input.mode === 'input' && !top.wroteVariables);
  const result: TriggerRunResult = {
    variables: storedVars ? storedVariables(shared) : shared.variables,
    variablesChanged: shared.variablesChanged || (storedVars && shared.stored.written),
    injections: completed ? top.injections : emptyInjections(),
    stopSending: completed && top.stopSending,
    sendAIprompt: completed && top.sendAIprompt,
    messages: storedChat ? shared.stored.messages : top.messages,
    character,
    ...(shared.personaChanged ? { persona: shared.persona } : {}),
    ...(shared.noteChanged ? { note: shared.note } : {}),
    ...(completed && top.displayData !== undefined ? { displayData: top.displayData } : {}),
    globalWrites: Object.keys(shared.globalWrites).length > 0 ? { ...shared.globalWrites } : null,
    aborted: !completed,
    log: shared.log,
  };
  return { result, top, shared };
}

/**
 * One `runTrigger` call. True when it ran to the end; false when a step
 * returned from it the way RisuAI's `return` does — which ends this call and,
 * for a nested one, hands control back to the run that asked for it.
 */
function* runOnce(shared: Shared, run: Run): Generator<TriggerRequest, boolean, unknown> {
  const { input } = shared;
  const lowLevelAccess = input.character.lowLevelAccess;

  /* ---------------------------------------------------------- variables */

  /** Local variable scopes by indent (`v2DeclareLocalVar`); one set per call. */
  const scopes: Record<number, Record<string, string>> = {};
  let currentIndent = 0;

  const getLocal = (key: string): string | null => {
    for (let indent = currentIndent; indent >= 0; indent -= 1) {
      const scope = scopes[indent];
      if (scope && Object.hasOwn(scope, key)) return scope[key]!;
    }
    return null;
  };

  const setLocal = (key: string, value: string, indent: number): void => {
    let found = -1;
    for (let i = indent; i >= 0; i -= 1) {
      if (scopes[i] && Object.hasOwn(scopes[i]!, key)) {
        found = i;
        break;
      }
    }
    const target = found !== -1 ? found : indent;
    scopes[target] ??= Object.create(null) as Record<string, string>;
    scopes[target]![key] = value;
  };

  const clearLocalsFrom = (indent: number): void => {
    for (const key of Object.keys(scopes)) if (Number(key) >= indent) delete scopes[Number(key)];
  };

  /** RisuAI's `getVar`: a local, else the chat's, else (displaying) the run's own, else `null`. */
  const getVar = (key: string): string => {
    const local = getLocal(key);
    if (local !== null) return local;
    const value = readVariable(shared.variables, key);
    if (value !== undefined) return value;
    if (shared.display) return readVariable(shared.tempVariables, key) ?? 'null';
    return 'null';
  };

  /**
   * A chat variable changed. RisuAI's `setVar` then hands the stored chat the
   * run's `scriptstate`, and what commands had written there is gone with it.
   */
  const changed = (): void => {
    shared.variablesChanged = true;
    run.wroteVariables = true;
    shared.stored.base = null;
    shared.stored.overlay = emptyVariables();
  };

  const setVar = (key: string, raw: unknown): void => {
    if (raw === undefined || raw === null) {
      // What RisuAI stores for a missing value reads back as unset; a local
      // takes RisuAI's `null` instead.
      if (shared.display) {
        delete shared.tempVariables[key];
        return;
      }
      if (getLocal(key) !== null) {
        setLocal(key, 'null', currentIndent);
        return;
      }
      if (readVariable(shared.variables, key) !== undefined) {
        delete shared.variables[key];
        changed();
      }
      return;
    }
    const value = asText(raw);
    if (value.length > MAX_TRIGGER_VALUE_LENGTH) {
      shared.log.push({ kind: 'limit', message: `a value for "${key}" grew past ${MAX_TRIGGER_VALUE_LENGTH} characters` });
      throw new Abort();
    }
    if (shared.display) {
      shared.tempVariables[key] = value;
      return;
    }
    if (getLocal(key) !== null) {
      setLocal(key, value, currentIndent);
      return;
    }
    if (readVariable(shared.variables, key) === value) return;
    shared.variables[key] = value;
    changed();
  };

  /* ------------------------------------------------------------- the CBS */

  const chatOf = (source: readonly TriggerMessage[]): CbsChat => {
    const messages: CbsMessage[] = source.map((message) => ({
      role: message.role,
      data: message.data,
      ...(message.time !== undefined ? { time: message.time } : {}),
    }));
    return {
      messages,
      offset: 0,
      length: messages.length,
      index: -1,
      ...(input.greeting ? { greeting: { text: input.greeting, index: -1 } } : {}),
    };
  };
  const cbsChat = (): CbsChat => chatOf(run.messages);
  const storedChat = (): CbsChat => chatOf(shared.stored.messages);

  const env: ScriptCbsEnv = {
    // `risuChatParser` reads the chat's variables as stored, not a trigger's
    // locals — the run's own, unless a slash command wrote there since.
    variable: (name) => readVariable(shared.stored.overlay, name) ?? readVariable(shared.stored.base ?? shared.variables, name),
    globalVariable: (name) => readVariable(shared.globals, name),
    random: shared.random,
    data: {
      ...input.data,
      char: input.character.name,
      character: {
        description: shared.character.description,
        ...(input.character.personality !== undefined ? { personality: input.character.personality } : {}),
        ...(input.character.scenario !== undefined ? { scenario: input.character.scenario } : {}),
        ...(input.character.exampleDialogue !== undefined
          ? { exampleDialogue: input.character.exampleDialogue }
          : {}),
      },
      persona: shared.persona,
      chat: cbsChat,
      lorebook: () => shared.character.lorebook.map(risuLoreEntry),
      triggerId: input.triggerId ?? null,
    },
  };

  /**
   * `risuChatParser(text, {chara})`. Its chat functions read the run's chat,
   * and a slash command's the chat as stored, which RisuAI's always read.
   */
  const p = (text: unknown, chat = cbsChat): string => {
    // The evaluator reads the description through `data`, which has to be the current one.
    (env.data!.character as { description: string }).description = shared.character.description;
    env.data!.persona = shared.persona;
    env.data!.chat = chat;
    return evaluateScriptCbs(text, env);
  };

  /** A field read as RisuAI reads a `…Type: 'var' | 'value'` pair. */
  const value = (step: TriggerStep, field: string, typeField = `${field}Type`): string =>
    str(step, typeField) === 'value' ? p(str(step, field)) : getVar(p(str(step, field)));

  const output = (step: TriggerStep): string => p(str(step, 'outputVar'));

  const lore = shared.character.lorebook;
  const rewrite = (field: keyof CharacterRewrite): void => {
    shared.rewrote.add(field);
  };

  const unsupported = (effect: string, message: string): void => {
    shared.log.push({ kind: 'unsupported', effect, message });
  };

  /* -------------------------------------------------- slash commands */

  /** What RisuAI's `processCommand` reaches: the chat as stored (`Stored`). */
  const commands: CommandHost = {
    cbs: (text) => p(text, storedChat),
    chat: shared.stored,
    getVar: (name) => readVariable(shared.stored.overlay, name) ?? readVariable(shared.stored.base ?? shared.variables, name),
    setVar: (name, text) => {
      if (text.length > MAX_TRIGGER_VALUE_LENGTH) {
        shared.log.push({ kind: 'limit', message: `a value for "${name}" grew past ${MAX_TRIGGER_VALUE_LENGTH} characters` });
        throw new Abort();
      }
      shared.stored.overlay[name] = text;
      shared.stored.written = true;
    },
    // RisuAI runs `runTrigger(char, 'manual', {chat: getCurrentChat(), manualName})`
    // — a copy of the chat as stored, with its own variables — and then
    // `setCurrentChat` with what it left. One that ended early leaves the stored
    // chat as it was written meanwhile.
    *trigger(name) {
      if (run.depth + 1 > MAX_TRIGGER_DEPTH) {
        shared.log.push({ kind: 'limit', message: `/trigger nested deeper than ${MAX_TRIGGER_DEPTH}` });
        throw new Abort();
      }
      const stored = shared.stored;
      const outer = { variables: shared.variables, changed: shared.variablesChanged };
      shared.variables = storedVariables(shared);
      shared.variablesChanged = false;
      stored.base = null;
      stored.overlay = emptyVariables();
      const nested: Run = {
        mode: 'manual',
        manualName: name,
        messages: stored.messages.map((message) => ({ ...message })),
        injections: emptyInjections(),
        stopSending: false,
        sendAIprompt: false,
        displayData: undefined,
        recursiveCount: 0,
        depth: run.depth + 1,
        wroteVariables: false,
      };
      let done = false;
      try {
        done = yield* runOnce(shared, nested);
      } finally {
        stored.base = done ? shared.variables : storedVariables(shared);
        stored.overlay = emptyVariables();
        stored.written = true;
        if (done) stored.messages = nested.messages;
        shared.variables = outer.variables;
        shared.variablesChanged = outer.changed;
      }
    },
    multisend: (items, clear) => {
      // The composer's are sent once the line is done (`CommandRunResult.multisend`).
      if (run.command !== undefined) {
        shared.multisend.push({ items, clear });
        return;
      }
      // In a run, RisuAI's `sendChat` declines — a start or output run is inside
      // one — or answers on the stored chat, which the run's copy then replaces.
      for (const item of items) {
        if (clear) shared.stored.messages = [];
        shared.stored.messages.push({ role: 'user', data: item });
      }
      if (run.mode === 'input' || run.mode === 'manual') {
        shared.log.push({ kind: 'dropped', effect: 'command', message: '/multisend does not generate inside a trigger run' });
      }
    },
    *lore() {
      return loreTestOf(
        yield { kind: 'lore', history: shared.stored.messages.map((message) => message.data), lorebook: shared.character.lorebook },
      );
    },
  };

  // The composer's line runs in place of any trigger.
  if (run.command !== undefined) {
    run.answer = yield* processMultiCommand(run.command, commands);
    return true;
  }

  /* ----------------------------------------------------------- the loop */

  for (const trigger of input.character.triggers) {
    /** The loop counters, RisuAI's inner `tempVars`: per trigger, keyed by the loop's position. */
    const counters: Record<string, number> = {};

    if (isCodeTrigger(trigger)) {
      // Code triggers run in every mode; the code decides.
    } else if (run.manualName) {
      if (trigger.comment !== run.manualName) continue;
    } else if (run.mode !== trigger.type) {
      continue;
    }

    if (!checkConditions(trigger.conditions, run, getVar, p)) continue;

    const effects = trigger.effect;
    for (let index = 0; index < effects.length; index += 1) {
      const effect = effects[index]!;
      if (run.mode === 'display' && !DISPLAY_ALLOWED.has(effect.type)) continue;
      if (run.mode === 'request' && !REQUEST_ALLOWED.has(effect.type)) continue;

      shared.steps += 1;
      if (shared.steps > MAX_TRIGGER_STEPS) {
        shared.log.push({ kind: 'limit', message: `the run took more than ${MAX_TRIGGER_STEPS} steps` });
        throw new Abort();
      }

      const indent = effect['indent'];
      if (typeof indent === 'number' && indent >= 0) currentIndent = indent;
      else if (!('indent' in effect)) currentIndent = 0;

      switch (effect.type) {
        /* ------------------------------------------------- v1 effects */
        case 'setvar': {
          const effectValue = p(str(effect, 'value'));
          const key = p(str(effect, 'var'));
          setVar(key, arithmetic(str(effect, 'operator'), getVar(key), effectValue));
          break;
        }
        case 'systemprompt': {
          addInjection(run, str(effect, 'location'), p(str(effect, 'value')));
          break;
        }
        case 'impersonate': {
          impersonate(run, str(effect, 'role'), p(str(effect, 'value')));
          break;
        }
        case 'command': {
          // The answer goes nowhere, as in RisuAI.
          yield* processMultiCommand(p(str(effect, 'value')), commands);
          break;
        }
        case 'stop':
        case 'v2StopPromptSending': {
          run.stopSending = true;
          break;
        }
        case 'runtrigger':
        case 'v2RunTrigger': {
          const name = effect.type === 'runtrigger' ? str(effect, 'value') : str(effect, 'target');
          if (run.recursiveCount < 10 || lowLevelAccess) {
            run.recursiveCount += 1;
            if (run.depth + 1 > MAX_TRIGGER_DEPTH) {
              shared.log.push({ kind: 'limit', message: `runtrigger nested deeper than ${MAX_TRIGGER_DEPTH}` });
              throw new Abort();
            }
            const nested: Run = {
              mode: 'manual',
              manualName: typeof name === 'string' ? name : undefined,
              messages: run.messages.map((message) => ({ ...message })),
              injections: run.injections,
              stopSending: run.stopSending,
              sendAIprompt: false,
              displayData: undefined,
              recursiveCount: run.recursiveCount,
              depth: run.depth + 1,
              wroteVariables: false,
            };
            const done = yield* runOnce(shared, nested);
            if (done) {
              // RisuAI takes back the prompt text, the chat and the stop — not `sendAIprompt`.
              run.injections = nested.injections;
              run.messages = nested.messages;
              run.stopSending = nested.stopSending;
            }
          }
          break;
        }
        case 'cutchat': {
          const start = num(p(str(effect, 'start')));
          const end = num(p(str(effect, 'end')));
          run.messages = sliceLike(run.messages, start, end);
          break;
        }
        case 'modifychat': {
          const at = num(p(str(effect, 'index')));
          const text = p(str(effect, 'value'));
          const target = run.messages[at];
          if (target) target.data = text;
          break;
        }

        // Low-level access only.
        case 'showAlert': {
          if (!lowLevelAccess) break;
          if (shared.display) return false;
          const text = p(str(effect, 'value'));
          const inputVar = p(str(effect, 'inputVar'));
          const alertType = str(effect, 'alertType');
          if (alertType === 'normal' || alertType === 'error') {
            yield { kind: 'alert', text, ...(alertType === 'error' ? { error: true } : {}) };
          } else if (alertType === 'input') {
            setVar(inputVar, asText((yield { kind: 'input', text }) ?? ''));
          } else if (alertType === 'select') {
            setVar(inputVar, asText((yield { kind: 'select', options: text.split('§') }) ?? ''));
          }
          break;
        }
        case 'sendAIprompt':
        case 'v2SendAIprompt': {
          if (!lowLevelAccess) break;
          run.sendAIprompt = true;
          break;
        }
        case 'runLLM': {
          if (!lowLevelAccess) break;
          const text = p(str(effect, 'value'));
          const answer = llmAnswer(yield { kind: 'llm', messages: llmTurns(text), model: 'model' });
          // A failure goes into the variable, prefixed, as RisuAI writes it.
          setVar(asText(str(effect, 'inputVar')), answer.ok ? answer.text : `Error: ${answer.error}`);
          break;
        }
        case 'runAxLLM':
          // Declared in RisuAI's trigger types but never handled there, so it does nothing.
          break;
        case 'checkSimilarity': {
          if (!lowLevelAccess) break;
          const text = p(str(effect, 'value'));
          const source = p(str(effect, 'source'));
          const found = similarityAnswer(yield { kind: 'similarity', source, texts: text.split('§') });
          // RisuAI's embedder throws out of the run, which stops there.
          if (!found.ok) throw new Error(`checkSimilarity: ${found.error}`);
          setVar(asText(str(effect, 'inputVar')), found.texts.join('§'));
          break;
        }
        case 'extractRegex': {
          if (!lowLevelAccess) break;
          const text = p(str(effect, 'value'));
          const regex = new RegExp(asText(str(effect, 'regex') ?? ''), asText(str(effect, 'flags') ?? ''));
          const found = regex.exec(text);
          // RisuAI reads the match without checking it, and a miss throws there.
          if (!found) throw new Error('extractRegex: no match');
          const result = asText(str(effect, 'result') ?? '')
            .replace(/\$[0-9]+/g, (ref) => found[Number(ref.slice(1))] as string)
            .replace(/\$&/g, found[0])
            .replace(/\$\$/g, '$');
          setVar(asText(str(effect, 'inputVar')), result);
          break;
        }
        case 'runImgGen': {
          if (!lowLevelAccess) break;
          unsupported('runImgGen', 'scripts cannot generate images here');
          setVar(asText(str(effect, 'inputVar')), 'Error: Image generation failed');
          break;
        }
        case 'triggerlua': {
          const answer = yield {
            kind: 'code',
            language: 'lua',
            code: asText(str(effect, 'code') ?? ''),
            mode: run.mode === 'manual' ? (run.manualName ?? 'manual') : run.mode,
            lowLevelAccess,
            scope: {
              getVar,
              setVar: (name, text) => setVar(name, text),
              variables: () => {
                const all = applyVariableDelta(shared.display ? shared.tempVariables : emptyVariables(), null);
                for (const [name, text] of Object.entries(shared.variables)) all[name] = text;
                // The locals in reach shadow the chat's, as `getVar` reads them.
                for (const name of Object.values(scopes).flatMap((locals) => Object.keys(locals))) {
                  const local = getLocal(name);
                  if (local !== null) all[name] = local;
                }
                return all;
              },
              getGlobalVar: (name) => readVariable(shared.globals, name) ?? 'null',
              setGlobalVar: (name, text) => {
                if (text === null) delete shared.globals[name];
                else shared.globals[name] = text;
                shared.globalWrites[name] = text;
              },
              globalVariables: () => applyVariableDelta(shared.globals, null),
              messages: run.messages,
              character: {
                name: input.character.name,
                get description() {
                  return shared.character.description;
                },
                get lorebook() {
                  return shared.character.lorebook;
                },
              },
              setDescription: (text) => {
                shared.character.description = text;
                rewrite('description');
              },
              setLorebook: (entries) => {
                // The run's own list is edited in place: the v2 effects hold it as `lore`.
                lore.splice(0, lore.length, ...entries);
                rewrite('lorebook');
              },
              user: input.data?.user ?? '',
              persona: shared.persona,
              note: shared.note,
              greeting: input.greeting ?? null,
            },
          };
          if (answer && typeof answer === 'object' && (answer as { stopSending?: unknown }).stopSending === true) {
            run.stopSending = true;
          }
          break;
        }

        /* ------------------------------------------------- v2 effects */
        case 'v2Header':
        case 'v2Comment':
        case 'v2Loop':
        case 'v2LoopNTimes':
          // Markers: a header names nothing, and a loop is closed by its end.
          break;
        case 'v2SetVar': {
          const effectValue = value(effect, 'value', 'valueType');
          const key = p(str(effect, 'var'));
          setVar(key, arithmetic(str(effect, 'operator'), getVar(key), effectValue));
          break;
        }
        case 'v2DeclareLocalVar': {
          const effectValue = value(effect, 'value', 'valueType');
          const key = p(str(effect, 'var'));
          setLocal(key, effectValue ?? 'null', typeof indent === 'number' ? indent : 0);
          break;
        }
        case 'v2If':
        case 'v2IfAdvanced': {
          const source =
            effect.type === 'v2If' || str(effect, 'sourceType') === 'var'
              ? getVar(p(str(effect, 'source')))
              : p(str(effect, 'source'));
          const target =
            str(effect, 'targetType') === 'value' ? p(str(effect, 'target')) : getVar(p(str(effect, 'target')));
          if (!compare(asText(str(effect, 'condition')), source, target)) {
            // NaN for a step without an indent, which then matches no end — as there.
            const inner = Number(indent) + 1;
            for (; index < effects.length; index += 1) {
              const candidate = effects[index]!;
              if (candidate.type === 'v2EndIndent' && candidate['indent'] === inner) {
                const next = effects[index + 1];
                if (next?.type === 'v2Else' && next['indent'] === inner - 1) index += 1;
                break;
              }
            }
          }
          break;
        }
        case 'v2Else': {
          // Reached only from a true branch, which skips what the else holds.
          const inner = Number(indent) + 1;
          for (; index < effects.length; index += 1) {
            const candidate = effects[index]!;
            if (candidate.type === 'v2EndIndent' && candidate['indent'] === inner) break;
          }
          break;
        }
        case 'v2EndIndent': {
          if (effect['endOfLoop']) {
            const loopIndent = (typeof indent === 'number' ? indent : 0) - 1;
            const end = index;
            for (; index >= 0; index -= 1) {
              const candidate = effects[index]!;
              if ((candidate.type === 'v2Loop' || candidate.type === 'v2LoopNTimes') && candidate['indent'] === loopIndent) {
                if (candidate.type === 'v2LoopNTimes') {
                  let times = num(value(candidate, 'value', 'valueType'));
                  if (Number.isNaN(times)) times = 0;
                  const key = `${index}LoopNTimes`;
                  counters[key] = (counters[key] ?? 0) + 1;
                  if (counters[key]! >= times) index = end;
                }
                break;
              }
            }
            // No loop header found: RisuAI's search runs off the front and the
            // trigger starts over from its first effect, as it does here.
          }
          clearLocalsFrom(typeof indent === 'number' ? indent : 0);
          break;
        }
        case 'v2BreakLoop': {
          for (; index < effects.length; index += 1) {
            const candidate = effects[index]!;
            if (candidate.type === 'v2EndIndent' && candidate['endOfLoop']) break;
          }
          break;
        }
        case 'v2ConsoleLog': {
          const text = value(effect, 'source', 'sourceType');
          console.log(text);
          break;
        }
        case 'v2StopTrigger': {
          index = effects.length;
          break;
        }
        case 'v2CutChat': {
          let start = num(value(effect, 'start', 'startType'));
          let end = num(value(effect, 'end', 'endType'));
          if (Number.isNaN(start)) start = 0;
          if (Number.isNaN(end)) end = run.messages.length;
          run.messages = sliceLike(run.messages, start, end);
          break;
        }
        case 'v2ModifyChat': {
          const at = num(value(effect, 'index', 'indexType'));
          const text = value(effect, 'value', 'valueType');
          const target = run.messages[at];
          if (target) target.data = text;
          break;
        }
        case 'v2SystemPrompt': {
          addInjection(run, str(effect, 'location'), value(effect, 'value', 'valueType'));
          break;
        }
        case 'v2Impersonate': {
          impersonate(run, str(effect, 'role'), value(effect, 'value', 'valueType'));
          break;
        }
        case 'v2Command': {
          yield* processMultiCommand(value(effect, 'value', 'valueType'), commands);
          break;
        }
        case 'v2ImgGen': {
          if (!lowLevelAccess) break;
          unsupported('v2ImgGen', 'scripts cannot generate images here');
          setVar(output(effect), 'null');
          break;
        }
        case 'v2CheckSimilarity': {
          if (!lowLevelAccess) break;
          const source = value(effect, 'source', 'sourceType');
          const text = value(effect, 'value', 'valueType');
          const found = similarityAnswer(yield { kind: 'similarity', source, texts: text.split('§') });
          if (!found.ok) throw new Error(`v2CheckSimilarity: ${found.error}`);
          setVar(output(effect), found.texts.join('§'));
          break;
        }
        case 'v2RunLLM': {
          if (!lowLevelAccess) break;
          const text = value(effect, 'value', 'valueType');
          // RisuAI's sub model is the chat's auxiliary model here; anything else is its own.
          const model = str(effect, 'model') === 'submodel' ? 'submodel' : 'model';
          const answer = llmAnswer(yield { kind: 'llm', messages: llmTurns(text), model });
          // RisuAI writes `null` for a failed call (and reads a streamed one to its end).
          setVar(output(effect), answer.ok ? answer.text : 'null');
          break;
        }
        case 'v2ShowAlert': {
          if (shared.display) return false;
          yield { kind: 'alert', text: value(effect, 'value', 'valueType') };
          break;
        }
        case 'v2ExtractRegex': {
          const text = value(effect, 'value', 'valueType');
          const pattern = value(effect, 'regex', 'regexType');
          const flags = value(effect, 'flags', 'flagsType');
          const found = new RegExp(pattern, flags).exec(text);
          const template = value(effect, 'result', 'resultType');
          const result = found
            ? template
                .replace(/\$[0-9]+/g, (ref) => found[Number(ref.slice(1))] || '')
                .replace(/\$&/g, found[0] || '')
                .replace(/\$\$/g, '$')
            : template.replace(/\$[0-9]+/g, '').replace(/\$&/g, '').replace(/\$\$/g, '$');
          setVar(output(effect), result);
          break;
        }
        case 'v2GetLastMessage': {
          setVar(output(effect), run.messages[run.messages.length - 1]?.data ?? 'null');
          break;
        }
        case 'v2GetMessageAtIndex': {
          const at = num(value(effect, 'index', 'indexType'));
          setVar(output(effect), run.messages[at]?.data ?? 'null');
          break;
        }
        case 'v2GetMessageCount': {
          setVar(output(effect), String(run.messages.length));
          break;
        }

        // RisuAI's first lore effects index each entry as a tuple, and its lore
        // has long been objects, so there they find nothing. What they leave
        // behind is what they leave there.
        case 'v2GetLorebook':
        case 'v2GetLorebookEntry': {
          setVar(output(effect), 'null');
          break;
        }
        case 'v2GetLorebookIndexViaName': {
          setVar(output(effect), '-1');
          break;
        }
        case 'v2ModifyLorebook':
        case 'v2SetLorebookActivation': {
          shared.log.push({
            kind: 'unsupported',
            effect: effect.type,
            message: 'this effect changes nothing in RisuAI either: it reads lore entries as tuples',
          });
          break;
        }
        case 'v2GetLorebookCount':
        case 'v2GetLorebookCountNew': {
          setVar(output(effect), String(lore.length));
          break;
        }
        case 'v2Random': {
          const min = num(value(effect, 'min', 'minType'));
          const max = num(value(effect, 'max', 'maxType'));
          setVar(output(effect), String(Math.floor(shared.random() * (max - min + 1) + min)));
          break;
        }
        case 'v2GetCharAt': {
          const source = value(effect, 'source', 'sourceType');
          const at = num(value(effect, 'index', 'indexType'));
          setVar(output(effect), source[at] ?? 'null');
          break;
        }
        case 'v2GetCharCount': {
          setVar(output(effect), String(value(effect, 'source', 'sourceType').length));
          break;
        }
        case 'v2ToLowerCase': {
          setVar(output(effect), value(effect, 'source', 'sourceType').toLowerCase());
          break;
        }
        case 'v2ToUpperCase': {
          setVar(output(effect), value(effect, 'source', 'sourceType').toUpperCase());
          break;
        }
        case 'v2SetCharAt': {
          const source = value(effect, 'source', 'sourceType');
          const at = num(value(effect, 'index', 'indexType'));
          const text = value(effect, 'value', 'valueType');
          const chars: (string | undefined)[] = [...source];
          if (Number.isInteger(at) && at >= 0 && at <= MAX_TRIGGER_VALUE_LENGTH) chars[at] = text;
          setVar(output(effect), chars.map((char) => char ?? '').join(''));
          break;
        }
        case 'v2SplitString': {
          const source = value(effect, 'source', 'sourceType');
          const delimiterType = str(effect, 'delimiterType');
          const delimiter =
            delimiterType === 'var' ? getVar(p(str(effect, 'delimiter'))) : p(str(effect, 'delimiter'));
          let parts: string[];
          if (delimiterType === 'regex') {
            try {
              const literal = delimiter.match(/^\/(.+)\/([gimuy]*)$/);
              parts = source.split(literal ? new RegExp(literal[1]!, literal[2]) : new RegExp(delimiter));
            } catch {
              parts = [source];
            }
          } else {
            parts = source.split(delimiter);
          }
          setVar(output(effect), JSON.stringify(parts));
          break;
        }
        case 'v2JoinArrayVar': {
          try {
            const list = JSON.parse(value(effect, 'var', 'varType')) as unknown[];
            const delimiter = value(effect, 'delimiter', 'delimiterType');
            setVar(output(effect), list.join(delimiter));
          } catch {
            setVar(output(effect), '');
          }
          break;
        }
        case 'v2ConcatString': {
          setVar(output(effect), value(effect, 'source1', 'source1Type') + value(effect, 'source2', 'source2Type'));
          break;
        }
        case 'v2GetLastUserMessage': {
          setVar(output(effect), [...run.messages].reverse().find((message) => message.role === 'user')?.data ?? 'null');
          break;
        }
        case 'v2GetLastCharMessage': {
          setVar(output(effect), [...run.messages].reverse().find((message) => message.role === 'char')?.data ?? 'null');
          break;
        }
        case 'v2GetFirstMessage': {
          setVar(output(effect), input.greeting ?? undefined);
          break;
        }
        case 'v2GetAlertInput': {
          if (shared.display) return false;
          const text = value(effect, 'display', 'displayType');
          setVar(output(effect), asText((yield { kind: 'input', text }) ?? ''));
          break;
        }
        case 'v2GetAlertSelect': {
          if (shared.display) return false;
          const display = value(effect, 'display', 'displayType');
          const options = value(effect, 'value', 'valueType').split('|');
          setVar(output(effect), asText((yield { kind: 'select', options, display }) ?? ''));
          break;
        }
        case 'v2GetDisplayState': {
          if (!shared.display) return false;
          setVar(output(effect), run.displayData ?? 'null');
          break;
        }
        case 'v2SetDisplayState': {
          if (!shared.display) return false;
          run.displayData = value(effect, 'value', 'valueType');
          break;
        }
        case 'v2UpdateGUI':
        case 'v2UpdateChatAt':
          // The chat redraws from its own state; there is nothing to poke.
          break;
        case 'v2Wait': {
          const seconds = num(value(effect, 'value', 'valueType'));
          const ms = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_TRIGGER_WAIT_MS) : 0;
          yield { kind: 'wait', ms };
          break;
        }
        case 'v2GetRequestState':
        case 'v2SetRequestState':
        case 'v2GetRequestStateRole':
        case 'v2SetRequestStateRole':
        case 'v2GetRequestStateLength': {
          // The request is assembled on the server, and a request-mode run never
          // happens here; anywhere else RisuAI returns from the run.
          if (!shared.display) return false;
          unsupported(effect.type, 'the request is assembled on the server');
          break;
        }
        case 'v2QuickSearchChat': {
          const needle = value(effect, 'value', 'valueType');
          const depth = num(value(effect, 'depth', 'depthType'));
          if (Number.isNaN(depth)) {
            setVar(output(effect), '0');
            break;
          }
          const found = searchChat(run.messages, depth, asText(str(effect, 'condition')), needle);
          setVar(output(effect), found ? '1' : '0');
          break;
        }
        case 'v2Tokenize': {
          // RisuAI counts with the model's tokenizer; one is not loaded in the
          // reader's browser, so this is the usual four-characters estimate.
          const text = value(effect, 'value', 'valueType');
          setVar(output(effect), String(Math.ceil(text.length / 4)));
          shared.log.push({ kind: 'unsupported', effect: 'v2Tokenize', message: 'token counts are estimated' });
          break;
        }
        case 'v2GetAllLorebooks': {
          setVar(output(effect), JSON.stringify(lore.map((entry) => entry.content)));
          break;
        }
        case 'v2GetLorebookByName': {
          const name = value(effect, 'name', 'nameType');
          const regex = new RegExp(name, 'i');
          const indices = lore.flatMap((entry, at) => (regex.test(entry.name ?? '') ? [at] : []));
          setVar(output(effect), JSON.stringify(indices));
          break;
        }
        case 'v2GetLorebookByIndex': {
          const at = num(value(effect, 'index', 'indexType'));
          const entry = Number.isInteger(at) && at >= 0 ? lore[at] : undefined;
          setVar(output(effect), entry ? entry.content : 'null');
          break;
        }
        case 'v2CreateLorebook': {
          const name = value(effect, 'name', 'nameType');
          const key = value(effect, 'key', 'keyType');
          const content = value(effect, 'content', 'contentType');
          const order = num(value(effect, 'insertOrder', 'insertOrderType'));
          lore.push(newLoreEntry(name, key, content, Number.isNaN(order) ? 100 : order));
          rewrite('lorebook');
          break;
        }
        case 'v2ModifyLorebookByIndex': {
          const at = num(value(effect, 'index', 'indexType'));
          const entry = Number.isInteger(at) && at >= 0 ? lore[at] : undefined;
          if (!entry) break;
          const slot = (text: string, current: string): string => text.replace(/{{slot}}/g, current);
          entry.name = slot(value(effect, 'name', 'nameType'), entry.name ?? '');
          entry.keys = splitKeys(slot(value(effect, 'key', 'keyType'), entry.keys.join(',')));
          entry.content = slot(value(effect, 'content', 'contentType'), entry.content);
          const order = Number(slot(value(effect, 'insertOrder', 'insertOrderType'), String(entry.insertionOrder || 100)));
          if (!Number.isNaN(order)) entry.insertionOrder = order;
          rewrite('lorebook');
          break;
        }
        case 'v2DeleteLorebookByIndex': {
          const at = num(value(effect, 'index', 'indexType'));
          if (!Number.isInteger(at) || at < 0 || at >= lore.length) break;
          lore.splice(at, 1);
          rewrite('lorebook');
          break;
        }
        case 'v2SetLorebookAlwaysActive': {
          const at = num(value(effect, 'index', 'indexType'));
          const entry = Number.isInteger(at) && at >= 0 ? lore[at] : undefined;
          if (!entry) break;
          entry.constant = str(effect, 'value') === true;
          rewrite('lorebook');
          break;
        }
        case 'v2GetCharacterDesc': {
          setVar(output(effect), shared.character.description);
          break;
        }
        case 'v2SetCharacterDesc': {
          shared.character.description = value(effect, 'value', 'valueType');
          rewrite('description');
          break;
        }
        case 'v2GetPersonaDesc': {
          setVar(output(effect), shared.persona);
          break;
        }
        case 'v2SetPersonaDesc': {
          shared.persona = value(effect, 'value', 'valueType');
          shared.personaChanged = true;
          break;
        }
        case 'v2GetReplaceGlobalNote': {
          setVar(output(effect), shared.character.postHistoryInstructions);
          break;
        }
        case 'v2SetReplaceGlobalNote': {
          shared.character.postHistoryInstructions = value(effect, 'value', 'valueType');
          rewrite('postHistoryInstructions');
          break;
        }
        case 'v2GetAuthorNote': {
          setVar(output(effect), shared.note);
          break;
        }
        case 'v2SetAuthorNote': {
          shared.note = value(effect, 'value', 'valueType');
          shared.noteChanged = true;
          break;
        }
        case 'v2RegexTest': {
          try {
            const text = value(effect, 'value', 'valueType');
            const pattern = value(effect, 'regex', 'regexType');
            const flags = value(effect, 'flags', 'flagsType');
            setVar(output(effect), new RegExp(pattern, flags).test(text) ? '1' : '0');
          } catch {
            setVar(output(effect), '0');
          }
          break;
        }

        /* ----------------------------------------------------- arrays */
        case 'v2MakeArrayVar': {
          const name = p(str(effect, 'var'));
          if (name.startsWith('[') && name.endsWith(']')) return false;
          setVar(name, '[]');
          break;
        }
        case 'v2GetArrayVarLength': {
          try {
            const list = JSON.parse(getVar(p(str(effect, 'var')))) as unknown[];
            setVar(output(effect), String(list.length));
          } catch {
            setVar(output(effect), '0');
          }
          break;
        }
        case 'v2GetArrayVar': {
          try {
            const list = JSON.parse(getVar(p(str(effect, 'var')))) as unknown[];
            const at = num(value(effect, 'index', 'indexType'));
            setVar(output(effect), list[at] ?? 'null');
          } catch {
            setVar(output(effect), 'null');
          }
          break;
        }
        case 'v2SetArrayVar': {
          const text = value(effect, 'value', 'valueType');
          const at = num(value(effect, 'index', 'indexType'));
          if (Number.isNaN(at)) break;
          try {
            const name = p(str(effect, 'var'));
            const list = JSON.parse(getVar(name)) as unknown[];
            if (at > MAX_TRIGGER_VALUE_LENGTH) throw new Error('index out of reach');
            list[at] = text;
            setVar(name, JSON.stringify(list));
          } catch (error) {
            if (error instanceof Abort) throw error;
          }
          break;
        }
        case 'v2PushArrayVar':
        case 'v2UnshiftArrayVar': {
          const name = p(str(effect, 'var'));
          try {
            const list = JSON.parse(getVar(name)) as unknown[];
            const text = value(effect, 'value', 'valueType');
            if (effect.type === 'v2PushArrayVar') list.push(text);
            else list.unshift(text);
            setVar(name, JSON.stringify(list));
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(name, '[]');
          }
          break;
        }
        case 'v2PopArrayVar':
        case 'v2ShiftArrayVar': {
          const name = p(str(effect, 'var'));
          try {
            const list = JSON.parse(getVar(name)) as unknown[];
            const taken = effect.type === 'v2PopArrayVar' ? list.pop() : list.shift();
            setVar(output(effect), taken ?? 'null');
            setVar(name, JSON.stringify(list));
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(name, '[]');
            setVar(output(effect), 'null');
          }
          break;
        }
        case 'v2SpliceArrayVar': {
          const name = p(str(effect, 'var'));
          try {
            const list = JSON.parse(getVar(name)) as unknown[];
            const start = num(value(effect, 'start', 'startType'));
            const item = value(effect, 'item', 'itemType');
            list.splice(start, 0, item);
            setVar(name, JSON.stringify(list));
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(name, '[]');
          }
          break;
        }
        case 'v2SliceArrayVar': {
          try {
            const list = JSON.parse(getVar(p(str(effect, 'var')))) as unknown[];
            const start = num(value(effect, 'start', 'startType'));
            const end = num(value(effect, 'end', 'endType'));
            setVar(output(effect), JSON.stringify(list.slice(start, end)));
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(output(effect), '[]');
          }
          break;
        }
        case 'v2GetIndexOfValueInArrayVar': {
          try {
            const list = JSON.parse(getVar(p(str(effect, 'var')))) as unknown[];
            const text = value(effect, 'value', 'valueType');
            setVar(output(effect), String(list.indexOf(text)));
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(output(effect), '-1');
          }
          break;
        }
        case 'v2RemoveIndexFromArrayVar': {
          const name = p(str(effect, 'var'));
          try {
            const list = JSON.parse(getVar(name)) as unknown[];
            const at = num(value(effect, 'index', 'indexType'));
            list.splice(at, 1);
            setVar(name, JSON.stringify(list));
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(name, '[]');
          }
          break;
        }

        /* ------------------------------------------------------ dicts */
        case 'v2MakeDictVar':
        case 'v2ClearDict': {
          const raw = asText(str(effect, 'var') ?? '');
          if (raw.startsWith('{') && raw.endsWith('}')) return false;
          setVar(p(raw), '{}');
          break;
        }
        case 'v2GetDictVar': {
          try {
            const dict = JSON.parse(value(effect, 'var', 'varType')) as Record<string, unknown>;
            const key = value(effect, 'key', 'keyType');
            setVar(output(effect), ownValue(dict, key) ?? 'null');
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(output(effect), 'null');
          }
          break;
        }
        case 'v2SetDictVar': {
          const text = value(effect, 'value', 'valueType');
          const key = value(effect, 'key', 'keyType');
          if (str(effect, 'varType') === 'value') break;
          const name = p(str(effect, 'var'));
          try {
            const dict = JSON.parse(getVar(name)) as Record<string, unknown>;
            if (typeof dict !== 'object' || dict === null) throw new Error('not a dict');
            Object.defineProperty(dict, key, { value: text, enumerable: true, writable: true, configurable: true });
            setVar(name, JSON.stringify(dict));
          } catch (error) {
            if (error instanceof Abort) throw error;
            if (str(effect, 'varType') === 'var') {
              const fresh: Record<string, unknown> = {};
              Object.defineProperty(fresh, key, { value: text, enumerable: true, writable: true, configurable: true });
              setVar(name, JSON.stringify(fresh));
            }
          }
          break;
        }
        case 'v2DeleteDictKey': {
          if (str(effect, 'varType') === 'value') break;
          const name = p(str(effect, 'var'));
          try {
            const dict = JSON.parse(getVar(name)) as Record<string, unknown>;
            if (typeof dict !== 'object' || dict === null) throw new Error('not a dict');
            const key = value(effect, 'key', 'keyType');
            delete dict[key];
            setVar(name, JSON.stringify(dict));
          } catch (error) {
            if (error instanceof Abort) throw error;
            if (str(effect, 'varType') === 'var') setVar(name, '{}');
          }
          break;
        }
        case 'v2HasDictKey': {
          try {
            const dict = JSON.parse(value(effect, 'var', 'varType')) as Record<string, unknown>;
            const key = value(effect, 'key', 'keyType');
            setVar(output(effect), Object.hasOwn(dict, key) ? '1' : '0');
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(output(effect), '0');
          }
          break;
        }
        case 'v2GetDictSize':
        case 'v2GetDictKeys':
        case 'v2GetDictValues': {
          try {
            const dict = JSON.parse(value(effect, 'var', 'varType')) as Record<string, unknown>;
            const result =
              effect.type === 'v2GetDictSize'
                ? String(Object.keys(dict).length)
                : JSON.stringify(effect.type === 'v2GetDictKeys' ? Object.keys(dict) : Object.values(dict));
            setVar(output(effect), result);
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(output(effect), effect.type === 'v2GetDictSize' ? '0' : '[]');
          }
          break;
        }

        /* --------------------------------------------------- strings */
        case 'v2Calculate': {
          try {
            const expression = value(effect, 'expression', 'expressionType').replace(
              /\$([a-zA-Z0-9_]+)/g,
              (_ref, name: string) => {
                const parsed = parseFloat(getVar(name));
                return Number.isNaN(parsed) ? '0' : String(parsed);
              },
            );
            const result = risuCalculate(
              expression,
              (name) => readVariable(shared.variables, name),
              (name) => readVariable(shared.globals, name),
            );
            // RisuAI calls `toString` on it, which an empty stack does not survive.
            if (result === undefined) throw new Error('nothing to calculate');
            setVar(output(effect), String(result));
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(output(effect), '0');
          }
          break;
        }
        case 'v2ReplaceString': {
          try {
            const source = value(effect, 'source', 'sourceType');
            const pattern = value(effect, 'regex', 'regexType');
            const format = value(effect, 'result', 'resultType');
            const replacement = value(effect, 'replacement', 'replacementType');
            const flags = value(effect, 'flags', 'flagsType');
            const result = source.replace(new RegExp(pattern, flags), (...args: unknown[]) => {
              const match = args[0] as string;
              const tail = typeof args[args.length - 1] === 'object' ? 3 : 2;
              const groups = args.slice(1, -tail) as (string | undefined)[];
              const target = format.match(/^\$(\d+)$/);
              if (target) {
                const at = Number(target[1]);
                if (at === 0) return replacement;
                const group = groups[at - 1];
                if (group) return match.replace(group, replacement);
              }
              return format
                .replace(/\$[0-9]+/g, (ref) => {
                  const at = Number(ref.slice(1));
                  return at === 0 ? match : groups[at - 1] || '';
                })
                .replace(/\$&/g, match)
                .replace(/\$\$/g, '$');
            });
            setVar(output(effect), result);
          } catch (error) {
            if (error instanceof Abort) throw error;
            setVar(output(effect), value(effect, 'source', 'sourceType'));
          }
          break;
        }

        default:
          // `triggercode` has no case in RisuAI either: an old format, never run.
          if (effect.type !== 'triggercode') {
            shared.log.push({ kind: 'unsupported', effect: effect.type, message: 'unknown effect' });
          }
      }
    }
  }
  return true;
}

/* ---------------------------------------------------------------- helpers */

/** `setvar`/`v2SetVar`'s operators. `=` stores the text; the rest do arithmetic on `Number(old)`, NaN as 0. */
function arithmetic(operator: unknown, current: string, operand: string): string {
  let original = Number(current);
  if (Number.isNaN(original)) original = 0;
  switch (operator) {
    case '=':
      return operand;
    case '+=':
      return String(original + Number(operand));
    case '-=':
      return String(original - Number(operand));
    case '*=':
      return String(original * Number(operand));
    case '/=':
      return String(original / Number(operand));
    case '%=':
      return String(original % Number(operand));
    default:
      // RisuAI starts from an empty result and keeps it for an operator it does not know.
      return '';
  }
}

/** `v2If`/`v2IfAdvanced`'s comparison. */
function compare(condition: string, source: string, target: string): boolean {
  const numeric = !Number.isNaN(Number(source)) && !Number.isNaN(Number(target));
  switch (condition) {
    case '=':
      return numeric ? Number(source) === Number(target) : source === target;
    case '!=':
      return numeric ? Number(source) !== Number(target) : source !== target;
    case '>':
      return Number(source) > Number(target);
    case '<':
      return Number(source) < Number(target);
    case '>=':
      return Number(source) >= Number(target);
    case '<=':
      return Number(source) <= Number(target);
    case '∈':
      return includesJson(target, source);
    case '∋':
      return includesJson(source, target);
    // A list that does not parse fails the positive forms and, through RisuAI's
    // catch, passes the negated ones.
    case '∉':
      return !includesJson(target, source);
    case '∌':
      return !includesJson(source, target);
    case '≒': {
      const a = Number(source);
      const b = Number(target);
      if (Number.isNaN(a) || Number.isNaN(b)) {
        return source.toLocaleLowerCase().replace(/ /g, '') === target.toLocaleLowerCase().replace(/ /g, '');
      }
      return Math.abs(a - b) < 0.0001;
    }
    case '≡':
      if (target === 'true') return source === 'true' || source === '1';
      if (target === 'false') return !(source === 'true' || source === '1');
      return source === target;
    default:
      return false;
  }
}

/** `JSON.parse(list).includes(item)`; false where that would throw. */
function includesJson(list: string, item: string): boolean {
  try {
    const parsed: unknown = JSON.parse(list);
    if (Array.isArray(parsed) || typeof parsed === 'string') return parsed.includes(item);
    return false;
  } catch {
    return false;
  }
}

/** The v1 conditions. False as soon as one fails. */
function checkConditions(
  conditions: readonly TriggerStep[],
  run: Run,
  getVar: (key: string) => string,
  p: (text: unknown) => string,
): boolean {
  for (const condition of conditions) {
    if (condition.type === 'var' || condition.type === 'chatindex' || condition.type === 'value') {
      const raw =
        condition.type === 'var'
          ? getVar(asText(condition['var'] ?? ''))
          : condition.type === 'chatindex'
            ? String(run.messages.length)
            : condition['var'];
      if (raw === undefined || raw === null) return false;
      const expected = p(condition['value']);
      const actual = p(raw);
      switch (condition['operator']) {
        case 'true':
          if (actual !== 'true' && actual !== '1') return false;
          break;
        case '=':
          if (actual !== expected) return false;
          break;
        case '!=':
          if (actual === expected) return false;
          break;
        case '>':
          if (Number(actual) <= Number(expected)) return false;
          break;
        case '<':
          if (Number(actual) >= Number(expected)) return false;
          break;
        case '>=':
          if (Number(actual) < Number(expected)) return false;
          break;
        case '<=':
          if (Number(actual) > Number(expected)) return false;
          break;
        case 'null':
          if (actual !== 'null') return false;
          break;
      }
    } else if (condition.type === 'exists') {
      const needle = p(p(condition['value']));
      const depth = Number(condition['depth']);
      if (!searchChat(run.messages, depth, asText(condition['type2']), needle)) return false;
    }
  }
  return true;
}

/** `exists` and `v2QuickSearchChat`: the last `depth` messages — all of them for 0 — searched for `needle`. */
function searchChat(messages: readonly TriggerMessage[], depth: number, how: string, needle: string): boolean {
  const text = messages
    .slice(0 - depth)
    .map((message) => message.data)
    .join(' ');
  if (how === 'strict') return text.split(' ').includes(needle);
  if (how === 'loose') return text.toLowerCase().includes(needle.toLowerCase());
  if (how === 'regex') return new RegExp(needle).test(text);
  return true;
}

function addInjection(run: Run, location: unknown, text: string): void {
  if (location !== 'start' && location !== 'historyend' && location !== 'promptend') return;
  run.injections = { ...run.injections, [location]: `${run.injections[location]}${text}\n\n` };
}

function impersonate(run: Run, role: unknown, text: string): void {
  if (role === 'user') run.messages.push({ role: 'user', data: text });
  else if (role === 'char') run.messages.push({ role: 'char', data: text });
}

/** `Array.prototype.slice` with RisuAI's `Number` arguments, NaN read as 0 the way slice reads it. */
const sliceLike = (messages: TriggerMessage[], start: number, end: number): TriggerMessage[] =>
  messages.slice(start, end);

function ownValue(dict: Record<string, unknown>, key: string): unknown {
  return typeof dict === 'object' && dict !== null && Object.hasOwn(dict, key) ? dict[key] : undefined;
}

const splitKeys = (text: string): string[] =>
  text
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

/** What `v2CreateLorebook` writes, in our shape: an ordinary keyed entry. */
function newLoreEntry(name: string, key: string, content: string, insertionOrder: number): LoreEntry {
  return {
    name,
    keys: splitKeys(key),
    secondaryKeys: [],
    selective: false,
    content,
    enabled: true,
    constant: false,
    insertionOrder,
    caseSensitive: false,
    useRegex: false,
    position: 'before_char',
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

/* ----------------------------------------------------------------- drivers */

/** What answers a run's requests. A missing handler answers nothing. */
export interface TriggerDriver {
  alert?(text: string, error: boolean): Promise<void> | void;
  input?(text: string): Promise<string> | string;
  select?(options: string[], display?: string): Promise<string> | string;
  wait?(ms: number): Promise<void>;
  code?(request: Extract<TriggerRequest, { kind: 'code' }>): Promise<{ stopSending?: boolean } | void> | { stopSending?: boolean } | void;
  llm?(request: Extract<TriggerRequest, { kind: 'llm' }>): Promise<ScriptLlmAnswer> | ScriptLlmAnswer;
  similarity?(request: Extract<TriggerRequest, { kind: 'similarity' }>): Promise<ScriptSimilarityAnswer> | ScriptSimilarityAnswer;
  lore?(request: Extract<TriggerRequest, { kind: 'lore' }>): Promise<LoreTest> | LoreTest;
  help?(): Promise<void> | void;
}

/** Runs to the end, answering every request through `driver`. */
export function runTriggers(input: TriggerRunInput, driver: TriggerDriver = {}): Promise<TriggerRunResult> {
  return drive(triggerRun(input), driver);
}

/** Runs a line of slash commands from the composer to the end, answering every request through `driver`. */
export function runCommands(input: CommandRunInput, driver: TriggerDriver = {}): Promise<CommandRunResult> {
  return drive(commandRun(input), driver);
}

async function drive<T>(run: Generator<TriggerRequest, T, unknown>, driver: TriggerDriver): Promise<T> {
  let answer: unknown;
  for (;;) {
    const step = run.next(answer);
    if (step.done) return step.value;
    const request = step.value;
    answer = undefined;
    switch (request.kind) {
      case 'alert':
        await driver.alert?.(request.text, request.error === true);
        break;
      case 'input':
        answer = (await driver.input?.(request.text)) ?? '';
        break;
      case 'select':
        answer = (await driver.select?.(request.options, request.display)) ?? '';
        break;
      case 'wait':
        await (driver.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(request.ms);
        break;
      case 'code':
        answer = (await driver.code?.(request)) ?? undefined;
        break;
      case 'llm':
        answer = (await driver.llm?.(request)) ?? NO_MODEL;
        break;
      case 'similarity':
        answer = (await driver.similarity?.(request)) ?? NO_EMBEDDER;
        break;
      case 'lore':
        answer = await driver.lore?.(request);
        break;
      case 'help':
        await driver.help?.();
        break;
    }
  }
}

/**
 * Runs without waiting for anything — the display mode's way, whose allowed
 * effects never ask. A request that does arrive (a code block, a model call, an
 * embedding search) is answered with nothing, as though no engine were there to
 * take it — so a model call made while a message is drawn fails rather than
 * calling the model.
 */
export function runTriggersSync(input: TriggerRunInput): TriggerRunResult {
  const run = triggerRun(input);
  let step = run.next();
  while (!step.done) step = run.next(undefined);
  return step.value;
}

/** Whether a card has any trigger a run in `mode` would look at (manual runs: by that name). */
export function hasTriggersFor(triggers: readonly TriggerScript[], mode: TriggerMode, manualName?: string): boolean {
  return triggers.some((trigger) =>
    isCodeTrigger(trigger) ? false : manualName ? trigger.comment === manualName : trigger.type === mode,
  );
}

/** The names a manual run, and so a button, can call. */
export const manualTriggerNames = (triggers: readonly TriggerScript[]): Set<string> =>
  new Set(triggers.filter((trigger) => !isCodeTrigger(trigger) && trigger.comment).map((trigger) => trigger.comment));
