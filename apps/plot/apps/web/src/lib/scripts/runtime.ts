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
 * - **A message drawn** (`display`): the display triggers rewrite its text, for
 *   the screen only.
 *
 * Every delta is measured the same way: the state the scripts ended in, against
 * the fold of the message's own macros over its parent (`diffVariables`), which is
 * exactly what the server folds back to that state.
 *
 * What the scripts rewrote of the work — the description, the lore, the global
 * note, the persona — is the chat's overlay (`ScriptOverlay`): it rides on the
 * generation or the commit, and the runtime keeps its own copy so the next run
 * reads it. The chat note goes to the chat's own `note`.
 *
 * The runtime holds no React state and talks to the API through what it is
 * given, so it is tested with a fake fetch.
 */

import {
  hasEditScripts,
  hasTriggersFor,
  isCodeTrigger,
  manualTriggerNames,
  mergeScriptOverlay,
  runEditScripts,
  runTriggers,
  runTriggersSync,
  type CharacterRewrite,
  type EditScript,
  type MemberOverlay,
  type PromptInjectionText,
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
import type { CbsHostData } from '@shizue/core/cbs';
import {
  applyVariableDelta,
  checkVariableDelta,
  computeVariables,
  diffVariables,
  readVariable,
  type FoldOptions,
  type VariableDelta,
  type Variables,
} from '@shizue/core/variables';
import type { ChatMessage, ChatState, LoreEntry, StreamMode } from '../types';
import type { EditPhase, ScriptEngine, ScriptPhase } from './engine';

/** GET /api/chats/:id/scripts — what the browser runs for a chat, when the plot carries any. */
export interface ScriptBundle {
  /** The member whose scripts these are, and whose card they rewrite. */
  memberId: string;
  /** `{{char}}` in the scripts' text: the member's nickname, else its name. */
  name: string;
  triggers: TriggerScript[];
  editScripts: EditScript[];
  lowLevelAccess: boolean;
  character: {
    description: string;
    personality: string;
    scenario: string;
    exampleDialogue: string;
    lorebook: LoreEntry[];
    postHistoryInstructions: string;
  };
  /** What this chat's scripts already rewrote of it. */
  overlay: { member: MemberOverlay | null; persona: string | null };
}

/** How the runtime asks the reader something — the page draws it. */
export interface ScriptUi {
  alert(text: string, error: boolean): Promise<void>;
  input(text: string): Promise<string>;
  select(options: string[], display?: string): Promise<string>;
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
   * The reader's global variables after the scripts wrote some. Nothing in the
   * trigger language does — only code (Lua's `setGlobalVar`) — so this is the
   * seat the Lua engine's writes reach the page through.
   */
  onGlobalVariables?: (variables: Variables) => void;
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
  /** A start trigger said not to send (`stop`). Nothing was sent, and nothing was kept. */
  stop: boolean;
  /** The chat as a commit the scripts needed first answered it — a rewrite of the head. */
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

export interface ScriptRuntime {
  readonly bundle: ScriptBundle;
  /** Names a `{{button}}` or a `risu-trigger` can run. */
  readonly triggerNames: ReadonlySet<string>;
  /** Whether replies are finished in the browser — and so whether a generation asks for `postProcess`. */
  readonly finishesReplies: boolean;
  /** Whether messages are drawn through display triggers. */
  readonly rewritesDisplay: boolean;
  prepare(mode: StreamMode, view: ScriptView, content?: string): Promise<PreparedGeneration>;
  /** Finishes the head reply the server holds `pending`; null when the head is not one. */
  finish(view: ScriptView): Promise<FinishedReply | null>;
  /** Runs the manual triggers named `name`; null when there was nothing to commit. */
  manual(name: string, triggerId: string | null, view: ScriptView): Promise<ChatState | null>;
  /** A `risu-btn` click: the engines' (Lua's) to answer. */
  button(data: string): Promise<void>;
  /**
   * A message's text as the display triggers draw it, with the chat's variables
   * as they stand — the page's own fold, so drawing a message folds nothing.
   */
  display(text: string, view: ScriptView, variables: Variables): string;
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

  const character = (): TriggerCharacter => ({
    name: bundle.name,
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
  };

  /** Runs `mode` and folds what it rewrote into the session. */
  async function run(
    s: Session,
    mode: TriggerMode,
    variables: Variables,
    chat: readonly TriggerMessage[],
    greeting: string | null,
    extra: Partial<TriggerRunInput> = {},
  ): Promise<TriggerRunResult> {
    const base = character();
    const result = await runTriggers(
      {
        mode,
        character: {
          ...base,
          description: s.patch.description ?? base.description,
          lorebook: s.patch.lorebook ?? base.lorebook,
          postHistoryInstructions: s.patch.postHistoryInstructions ?? base.postHistoryInstructions,
        },
        messages: chat,
        greeting,
        note: s.note,
        persona: s.persona,
        variables,
        globalVariables: s.globals,
        data: { ...s.view.data, user: s.view.names.user ?? s.view.data?.user },
        ...(options.random ? { random: options.random } : {}),
        ...extra,
      },
      driver,
    );
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
    return result;
  }

  function absorb(s: Session, rewrite: CharacterRewrite): void {
    if (rewrite.description !== undefined) s.patch.description = rewrite.description;
    if (rewrite.lorebook !== undefined) s.patch.lorebook = rewrite.lorebook;
    if (rewrite.postHistoryInstructions !== undefined) s.patch.postHistoryInstructions = rewrite.postHistoryInstructions;
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

  /** Once the server has them, the runtime's copy of the overlay moves too. */
  function kept(s: Session): void {
    overlay = {
      member: { ...overlay.member, ...s.patch },
      persona: s.personaPatch ?? overlay.persona,
    };
  }

  /** `text` through the engines' edit listeners and then the regex scripts of `phase`. */
  async function edit(
    phase: Extract<EditPhase, 'editinput' | 'editoutput'>,
    text: string,
    variables: Variables,
    s: Session,
    meta: { chatIndex: number; previousSameRole?: string },
  ): Promise<string> {
    let data = text;
    for (const engine of engines) {
      if (engine.edit && engine.handles(phase)) data = await engine.edit(phase, data, { chatIndex: meta.chatIndex });
    }
    if (!hasEditScripts(bundle.editScripts, phase)) return data;
    return runEditScripts(data, bundle.editScripts, phase, {
      chatIndex: meta.chatIndex,
      ...(meta.previousSameRole !== undefined ? { previousSameRole: meta.previousSameRole } : {}),
      env: {
        variable: (name) => readVariable(variables, name),
        globalVariable: (name) => readVariable(s.globals, name),
        ...(options.random ? { random: options.random } : {}),
        data: {
          ...s.view.data,
          user: s.view.names.user ?? s.view.data?.user,
          char: bundle.name,
          persona: s.persona,
          character: { description: s.patch.description ?? character().description },
        },
      },
      onSkip: (_script, reason) => log({ kind: 'error', effect: phase, message: reason }),
    });
  }

  /**
   * What the runs did to stored messages: the head's new text, when they
   * rewrote it, and a note for anything else — a cut, an appended message, a
   * rewrite further back — that the append-only tree does not take.
   */
  function headEdit(
    before: readonly TriggerMessage[],
    after: readonly TriggerMessage[],
    headId: string | null,
  ): string | undefined {
    const original = new Map(before.map((message) => [message.id, message.data]));
    let head: string | undefined;
    let dropped = after.length !== before.length || after.some((message, index) => message.id !== before[index]?.id);
    for (const message of after) {
      if (!message.id || original.get(message.id) === message.data) continue;
      if (message.id === headId) head = message.data;
      else dropped = true;
    }
    if (dropped) {
      log({
        kind: 'dropped',
        message: 'the scripts cut, added or rewrote messages other than the latest; only the latest is kept',
      });
    }
    return head;
  }

  /** The trigger chat of each branch the display triggers drew, by the branch's array. */
  const displayBranches = new WeakMap<readonly ChatMessage[], ReturnType<typeof triggerMessages>>();

  const commit = (body: Record<string, unknown>): Promise<ChatState> =>
    api.send<ChatState>('POST', `/api/chats/${chatId}/script-commit`, body);

  const finishesReplies = runsAt('output') || hasEditScripts(bundle.editScripts, 'editoutput') || engineHandles('editoutput');

  return {
    bundle,
    triggerNames: manualTriggerNames(triggers),
    finishesReplies,
    rewritesDisplay: hasTriggersFor(triggers, 'display'),

    async prepare(mode, view, content) {
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
        const { greeting, chat } = triggerMessages(view.messages);
        let variables = base;
        let messages: TriggerMessage[] = chat;
        if (runsAt('input')) {
          const input = await run(s, 'input', variables, chat, greeting);
          variables = input.variables;
          messages = input.messages;
        }
        let sent = await edit('editinput', text, variables, s, { chatIndex: -1 });
        variables = computeVariables([sent], variables, view.names);
        let injections: PromptInjectionText | null = null;
        if (runsAt('start')) {
          const withTurn: TriggerMessage[] = [...messages, { role: 'user', data: sent, id: NEW_TURN }];
          const start = await run(s, 'start', variables, withTurn, greeting);
          if (start.stopSending) return { body: {}, stop: true, accept: () => undefined };
          variables = start.variables;
          injections = start.injections;
          // A start trigger may rewrite the turn being sent; that is the text it goes as.
          sent = start.messages.find((message) => message.id === NEW_TURN)?.data ?? sent;
          messages = start.messages.filter((message) => message.id !== NEW_TURN);
        }
        // Against what the server folds the stored turn to without its delta.
        const plain = computeVariables([sent], base, view.names);
        const delta = storable(diffVariables(variables, plain), log);
        await flushGlobals(s);
        const rewritten = await rewriteHead(chat, messages, head);
        return {
          body: {
            ...body,
            ...(delta ? { variableDelta: delta } : {}),
            ...(injections ? injectionFields(injections) : {}),
            ...writes(s),
          },
          content: sent,
          stop: false,
          accept: () => kept(s),
          ...(rewritten ? { state: rewritten } : {}),
        };
      }

      // Every other mode starts no turn of its own: the start triggers run on the
      // branch the generation reads — without the head a regenerate replaces.
      const replaces = mode === 'regenerate' && head?.role === 'assistant';
      const branch = replaces ? view.messages.slice(0, -1) : view.messages;
      if (!runsAt('start')) return { body, stop: false, accept: () => undefined };
      const base = computeVariables(branch, view.defaults, view.names);
      const { greeting, chat } = triggerMessages(branch);
      const start = await run(s, 'start', base, chat, greeting);
      if (start.stopSending) return { body: {}, stop: true, accept: () => undefined };
      const delta = storable(diffVariables(start.variables, base), log);
      await flushGlobals(s);
      // A regenerate's branch ends before the head it replaces, so no rewrite there is the head's.
      const rewritten = await rewriteHead(chat, start.messages, replaces ? undefined : head);
      return {
        body: {
          ...body,
          ...(delta ? { startDelta: delta } : {}),
          ...injectionFields(start.injections),
          ...writes(s),
        },
        stop: false,
        accept: () => kept(s),
        ...(rewritten ? { state: rewritten } : {}),
      };
    },

    async finish(view) {
      const head = view.messages[view.messages.length - 1];
      if (!head || head.role !== 'assistant' || head.scriptState !== 'pending') return null;
      const s = session(view);
      const before = view.messages.slice(0, -1);
      const parent = computeVariables(before, view.defaults, view.names);
      const { greeting, chat } = triggerMessages(view.messages);
      // RisuAI's index for the message, the greeting being -1.
      const chatIndex = chat.length - 1;
      const previous =
        [...chat.slice(0, -1)].reverse().find((message) => message.role === 'char')?.data ?? greeting ?? '';
      const stored = { content: head.content, variableDelta: head.variableDelta ?? null };
      let text = await edit('editoutput', head.content, computeVariables([stored], parent, view.names), s, {
        chatIndex,
        previousSameRole: previous,
      });

      let variables = computeVariables([{ content: text, variableDelta: stored.variableDelta }], parent, view.names);
      let followUp = false;
      if (runsAt('output')) {
        const withReply = chat.map((message, index) => (index === chat.length - 1 ? { ...message, data: text } : message));
        const output = await run(s, 'output', variables, withReply, greeting);
        variables = output.variables;
        followUp = output.sendAIprompt;
        text = headEdit(withReply, output.messages, head.id) ?? text;
      }
      const delta = storable(diffVariables(variables, computeVariables([text], parent, view.names)), log);
      await flushGlobals(s);
      const state = await commit({
        messageId: head.id,
        scriptRev: head.scriptRev ?? 0,
        clearPending: true,
        // Always sent: it replaces the delta the server computed for the reply.
        variableDelta: delta,
        ...(text !== head.content ? { content: text } : {}),
        ...writes(s),
      });
      kept(s);
      return { state, followUp };
    },

    async manual(name, triggerId, view) {
      if (!name) return null;
      const s = session(view);
      const head = view.messages[view.messages.length - 1];
      const base = computeVariables(view.messages, view.defaults, view.names);
      const { greeting, chat } = triggerMessages(view.messages);
      const result = await run(s, 'manual', base, chat, greeting, {
        manualName: name,
        triggerId,
      });
      const content = headEdit(chat, result.messages, head?.id ?? null);
      await flushGlobals(s);
      const fields = writes(s);
      if (!result.variablesChanged && content === undefined && !fields.overlay && fields.note === undefined) return null;
      if (!head) {
        log({ kind: 'dropped', message: 'a chat with no message has nowhere to keep what a button did' });
        return null;
      }
      const parent = computeVariables(view.messages.slice(0, -1), view.defaults, view.names);
      const delta = storable(diffVariables(result.variables, computeVariables([content ?? head.content], parent, view.names)), log);
      const state = await commit({
        messageId: head.id,
        scriptRev: head.scriptRev ?? 0,
        variableDelta: delta,
        ...(content !== undefined ? { content } : {}),
        ...fields,
      });
      kept(s);
      return state;
    },

    async button(data) {
      const engine = engines.find((candidate) => candidate.button && candidate.handles('button'));
      if (!engine?.button) {
        log({ kind: 'unsupported', effect: 'risu-btn', message: 'risu-btn needs the Lua engine, which is not installed' });
        return;
      }
      await engine.button(data);
    },

    display(text, view, variables) {
      if (!hasTriggersFor(triggers, 'display')) return text;
      // Every message of a branch is drawn against the same branch: built once.
      let branch = displayBranches.get(view.messages);
      if (!branch) {
        branch = triggerMessages(view.messages);
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
  };

  /**
   * A rewrite of the head the runs asked for before a generation, committed in
   * place first so the generation builds on it. The head keeps its id, so the
   * generation's `baseHeadId` still holds.
   */
  async function rewriteHead(
    before: readonly TriggerMessage[],
    after: readonly TriggerMessage[],
    head: ChatMessage | undefined,
  ): Promise<ChatState | undefined> {
    const content = headEdit(before, after, head?.id ?? null);
    if (content === undefined || !head) return undefined;
    return commit({ messageId: head.id, scriptRev: head.scriptRev ?? 0, content });
  }
}

function injectionFields(injections: { start: string; historyend: string; promptend: string }): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(injections).filter(([, text]) => text.trim() !== ''));
  return Object.keys(kept).length > 0 ? { injections: kept } : {};
}
