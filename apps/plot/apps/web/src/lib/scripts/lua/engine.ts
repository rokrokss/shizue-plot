/**
 * The Lua engine: RisuAI's `triggerlua` scripts, run in the sandbox
 * (`sandbox.ts`) at each seat the chat's script runtime leaves (`../engine.ts`).
 *
 * A card's Lua lives in its trigger list — every trigger whose first effect is
 * `triggerlua` carries a script, and RisuAI runs that effect in every mode for
 * the script to decide (`onStart`, `onInput`, `onOutput`, a manual run calling
 * the global of its name). Outside a trigger run RisuAI goes through the same
 * scripts in trigger order: each edit hook's answer is the next one's input, and
 * a button click reaches each `onButtonClick`. This does the same.
 *
 * Each call carries a snapshot of the `CodeScope` it was made with — what the
 * script may read, all of it, since it cannot call back synchronously — and
 * what the script wrote comes back through the same scope: variables through
 * `setVar` (a value longer than a trigger may write is dropped and noted),
 * the chat through `messages` (a message keeps its id, with the role and the
 * text the script gave it, while the script did not move it), the description
 * and the lore through the character setters.
 * From there the runtime carries them where a trigger's writes go.
 *
 * What RisuAI keeps behind the card's `lowLevelAccess` stays behind it: the
 * worker gates the functions as RisuAI does, the sandbox refuses a model call
 * from a call that was not given the access, and the API refuses one for a plot
 * whose card does not grant it. Model calls have no count limit — they run on
 * the reader's own account, through the chat's model, or its auxiliary model
 * for `axLLM`. An embedding search (`similarity`) runs on the page, in the
 * worker the trigger runs share, behind the same access. A `request` is made by
 * our server, as RisuAI's proxy makes it, under RisuAI's own limits.
 *
 * A call the watchdog had to stop, or one the sandbox could not run, changes
 * nothing and is logged; the run goes on as if the script had returned.
 */

import { MAX_TRIGGER_VALUE_LENGTH, type CodeScope, type TriggerLogEntry, type TriggerScript } from '@shizue/core/triggers';
import type { LoreEntry } from '../../types';
import type { ScriptEngine, ScriptPhase } from '../engine';
import type { LuaHost, LuaLlmMessage, LuaLlmModel, LuaOutcome, LuaRequestAnswer, LuaSandbox } from './sandbox';
import type { LuaCallResult, LuaEntry, LuaLoreBook, LuaSnapshot } from './sandboxRuntime';

/** The reader's side of a script's dialogs. */
export interface LuaUi {
  alert(text: string, error: boolean): Promise<void>;
  input(text: string): Promise<string>;
  select(options: string[]): Promise<string>;
  confirm(text: string): Promise<boolean>;
}

export interface LuaEngineOptions {
  triggers: readonly TriggerScript[];
  lowLevelAccess: boolean;
  sandbox: LuaSandbox;
  ui: LuaUi;
  /** A model call on the chat's model or its auxiliary one; the answer's text, or a throw. */
  llm(messages: LuaLlmMessage[], model: LuaLlmModel): Promise<string>;
  /** `similarity`: the texts closest to `source` first, or a throw. */
  similarity(source: string, texts: string[]): Promise<string[]>;
  /** `request`: RisuAI's `{status, data}` for `url`, as our server answers it, or a throw. */
  request(url: string | null): Promise<LuaRequestAnswer>;
  log(entry: TriggerLogEntry): void;
}

/** The scripts on a card, in trigger order: each trigger whose first effect is `triggerlua`. */
export function luaScriptsOf(triggers: readonly TriggerScript[]): string[] {
  return triggers.flatMap((trigger) => {
    const first = trigger.effect[0];
    if (first?.type !== 'triggerlua') return [];
    const code = first['code'];
    return [typeof code === 'string' ? code : ''];
  });
}

/**
 * The global functions the scripts declare, for a `{{button}}` that names one —
 * a manual run calls the global of its name. Read off the text, so a function
 * built at run time is missed; the reader can still reach it by `risu-trigger`.
 */
export function luaFunctionNames(scripts: readonly string[]): string[] {
  const names = new Set<string>();
  for (const code of scripts) {
    for (const match of code.matchAll(/^[ \t]*function[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/gm)) names.add(match[1]!);
    for (const match of code.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:async[ \t]*\([ \t]*)?function\b/gm)) {
      names.add(match[1]!);
    }
  }
  return [...names];
}

/** What would make a script act at a moment: the hook it defines. Over-reading is harmless — an absent hook is a no-op. */
const PHASES: Partial<Record<ScriptPhase, RegExp>> = {
  start: /\bonStart\b/,
  input: /\bonInput\b/,
  output: /\bonOutput\b/,
  button: /\bonButtonClick\b/,
  editinput: /\beditInput\b/,
  editoutput: /\beditOutput\b/,
  editdisplay: /\beditDisplay\b/,
};

const splitKeys = (text: string): string[] =>
  text
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

/** A lore entry in RisuAI's shape, as `getLoreBooks` answers. */
const risuLore = (entry: LoreEntry): LuaLoreBook => ({
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

/** An entry `upsertLocalLoreBook` made, in ours: keyed, or always on. */
const ourLore = (book: LuaLoreBook): LoreEntry => ({
  name: book.comment,
  keys: splitKeys(book.key),
  secondaryKeys: splitKeys(book.secondkey),
  selective: book.selective,
  content: book.content,
  enabled: true,
  constant: book.alwaysActive,
  insertionOrder: book.insertorder,
  caseSensitive: false,
  useRegex: book.useRegex,
  position: 'before_char',
});

export function snapshotOf(scope: CodeScope, lowLevel: boolean): LuaSnapshot {
  return {
    vars: Object.entries(scope.variables()),
    globals: Object.entries(scope.globalVariables()),
    messages: scope.messages.map((message) => ({
      role: message.role,
      data: message.data,
      ...(message.time !== undefined ? { time: message.time } : {}),
    })),
    char: {
      name: scope.character.name,
      description: scope.character.description,
      greeting: scope.greeting ?? '',
      lore: scope.character.lorebook.map(risuLore),
    },
    user: scope.user,
    persona: scope.persona,
    note: scope.note,
    lowLevel,
  };
}

export function createLuaEngine(options: LuaEngineOptions): ScriptEngine {
  const { sandbox, ui, log } = options;
  const scripts = luaScriptsOf(options.triggers);
  const source = scripts.join('\n');
  /** Display passes run on every redraw: each distinct complaint is said once. */
  const said = new Set<string>();

  // One dialog at a time, in the order the scripts asked: the page has one sheet.
  let dialogs: Promise<unknown> = Promise.resolve();
  const queued = <T>(ask: () => Promise<T>): Promise<T> => {
    const next = dialogs.then(ask, ask);
    dialogs = next.catch(() => undefined);
    return next;
  };
  const host: LuaHost = {
    alert: (text, error) => queued(() => ui.alert(text, error)),
    input: (text) => queued(() => ui.input(text)),
    select: (choices) => queued(() => ui.select(choices)),
    confirm: (text) => queued(() => ui.confirm(text)),
    llm: (messages, model) => options.llm(messages, model),
    similarity: (source, texts) => options.similarity(source, texts),
    request: (url) => options.request(url),
  };

  function report(outcome: Exclude<LuaOutcome, { kind: 'done' }>, quiet = false): void {
    const message =
      outcome.kind === 'killed'
        ? `the Lua script was stopped (${outcome.reason}); what it wrote is dropped`
        : `the Lua script could not run: ${outcome.message}`;
    if (quiet && said.has(message)) return;
    said.add(message);
    log({ kind: outcome.kind === 'killed' ? 'limit' : 'error', effect: 'triggerlua', message });
  }

  function notes(result: LuaCallResult, quiet = false): void {
    for (const [name, why] of result.notes) {
      const message = `${name}: ${why}`;
      if (quiet && said.has(message)) continue;
      said.add(message);
      log({ kind: 'unsupported', effect: name, message: why });
    }
    if (result.error !== null) {
      const message = `the Lua script failed: ${result.error}`;
      if (!(quiet && said.has(message))) {
        said.add(message);
        log({ kind: 'error', effect: 'triggerlua', message });
      }
    }
  }

  /** What a call wrote, through the scope it was made with. */
  function apply(result: LuaCallResult, scope: CodeScope): void {
    for (const [name, value] of result.vars) {
      if (value !== null && value.length > MAX_TRIGGER_VALUE_LENGTH) {
        log({ kind: 'limit', effect: 'setChatVar', message: `a value for "${name}" grew past ${MAX_TRIGGER_VALUE_LENGTH} characters` });
        continue;
      }
      scope.setVar(name, value);
    }
    if (result.messages) {
      const before = scope.messages.slice();
      const after = result.messages.map((message) => {
        const kept = message.key !== null ? before[message.key] : undefined;
        return kept ? { ...kept, role: message.role, data: message.data } : { role: message.role, data: message.data };
      });
      scope.messages.splice(0, scope.messages.length, ...after);
    }
    if (result.description !== null) scope.setDescription(result.description);
    if (result.lore.length > 0) {
      let lore = [...scope.character.lorebook];
      for (const book of result.lore) {
        lore = lore.filter((entry) => (entry.name ?? '') !== book.comment);
        lore.push(ourLore(book));
      }
      scope.setLorebook(lore);
    }
    notes(result);
  }

  async function call(code: string, entry: LuaEntry, scope: CodeScope, lowLevel: boolean): Promise<LuaCallResult | null> {
    const outcome = await sandbox.call(code, entry, snapshotOf(scope, lowLevel), host);
    if (outcome.kind !== 'done') {
      report(outcome, entry.kind === 'display');
      return null;
    }
    return outcome.result;
  }

  return {
    name: 'lua',

    handles(phase) {
      if (scripts.length === 0) return false;
      if (phase === 'manual') return true;
      return PHASES[phase]?.test(source) ?? false;
    },

    async runCode(request) {
      const result = await call(request.code, { kind: 'trigger', mode: request.mode }, request.scope, request.lowLevelAccess);
      if (!result) return;
      apply(result, request.scope);
      return result.stopSending ? { stopSending: true } : undefined;
    },

    async edit(phase, text, meta, scope) {
      let data = text;
      for (const code of scripts) {
        const entry: LuaEntry = {
          kind: 'edit',
          phase: phase === 'editinput' ? 'editInput' : 'editOutput',
          text: data,
          index: meta.chatIndex,
        };
        // The edit hooks never have low-level access in RisuAI.
        const result = await call(code, entry, scope, false);
        if (!result) continue;
        apply(result, scope);
        if (typeof result.res === 'string') data = result.res;
      }
      return data;
    },

    async display(items, scope) {
      let texts = items.map((item) => item.text);
      for (const code of scripts) {
        const entry: LuaEntry = {
          kind: 'display',
          items: texts.map((text, at) => ({ text, index: items[at]!.chatIndex })),
        };
        const result = await call(code, entry, scope, false);
        if (!result) continue;
        // A display pass writes nothing anywhere: only its notes are said, once.
        notes(result, true);
        if (Array.isArray(result.res)) texts = result.res;
      }
      return texts;
    },

    async button(data, scope) {
      for (const code of scripts) {
        const result = await call(code, { kind: 'button', data }, scope, options.lowLevelAccess);
        if (result) apply(result, scope);
      }
    },

    manualNames: () => luaFunctionNames(scripts),

    dispose: () => sandbox.dispose(),
  };
}
