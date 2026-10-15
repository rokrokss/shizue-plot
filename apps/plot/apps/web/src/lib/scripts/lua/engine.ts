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
 * text the script gave it, while the script did not move it), the description,
 * the name (one the server would not keep is dropped and noted), the first
 * message and the background through the character setters, and the lore
 * `upsertLocalLoreBook` wrote through the chat's own (`setLocalLore`), as
 * RisuAI writes it to the chat's `localLore` rather than the character.
 * From there the runtime carries them where a trigger's writes go.
 *
 * What RisuAI keeps behind the card's `lowLevelAccess` stays behind it: the
 * worker gates the functions as RisuAI does, each call with its own trigger's
 * access (`luaEntriesOf`), the sandbox refuses a model call from a call that was
 * not given the access, and the API refuses one whose trigger does not hold it
 * (the call names it, `trigger`). Model calls have no count limit — they run on
 * the reader's own account, through the chat's model, or its auxiliary model
 * for `axLLM`. An embedding search (`similarity`) runs on the page, in the
 * worker the trigger runs share, behind the same access. A `request` is made by
 * our server, as RisuAI's proxy makes it, under RisuAI's own limits. The lore
 * `loadLoreBooks` lists is activated on the page (`lore`), as `/test_lorebook`'s.
 *
 * A call the watchdog had to stop, or one the sandbox could not run, changes
 * nothing and is logged; the run goes on as if the script had returned.
 */

import {
  luaScriptsOf,
  MAX_OVERLAY_NAME_LENGTH,
  MAX_TRIGGER_VALUE_LENGTH,
  overlayName,
  risuLore,
  upsertLocalLore,
  type CodeScope,
  type TriggerLogEntry,
  type TriggerScript,
} from '@shizue/core/triggers';
import { escapeHtml } from '../../cbs';
import type { LoreEntry } from '../../types';
import type { ScriptEngine, ScriptPhase } from '../engine';
import type {
  LuaHost,
  LuaLlmMessage,
  LuaLlmModel,
  LuaLoreAnswer,
  LuaOutcome,
  LuaRequestAnswer,
  LuaSandbox,
} from './sandbox';
import type { LuaCallResult, LuaEntry, LuaSnapshot } from './sandboxRuntime';

/** The reader's side of a script's dialogs. */
export interface LuaUi {
  alert(text: string, error: boolean): Promise<void>;
  input(text: string): Promise<string>;
  /** The index of the option chosen, as text; '' for none. */
  select(options: string[]): Promise<string>;
  confirm(text: string): Promise<boolean>;
}

export interface LuaEngineOptions {
  triggers: readonly TriggerScript[];
  lowLevelAccess: boolean;
  sandbox: LuaSandbox;
  ui: LuaUi;
  /**
   * A model call on the chat's model or its auxiliary one; the answer's text, or
   * a throw. `trigger` is the trigger whose code asked, by its place in
   * `triggers` — what the server holds the call to.
   */
  llm(messages: LuaLlmMessage[], model: LuaLlmModel, trigger: number): Promise<string>;
  /** `similarity`: the texts closest to `source` first, or a throw. */
  similarity(source: string, texts: string[]): Promise<string[]>;
  /** `request`: RisuAI's `{status, data}` for `url`, as our server answers it, or a throw; `trigger` as for `llm`. */
  request(url: string | null, trigger: number): Promise<LuaRequestAnswer>;
  /**
   * `loadLoreBooks`: what `lorebook` activates on `history`, and the chat's context
   * budget, or a throw. Without it the call fails in the script.
   */
  lore?(history: string[], lorebook: readonly LoreEntry[]): Promise<LuaLoreAnswer>;
  /** The scripted member's avatar, a same-origin address — RisuAI's `char.image` — or null. */
  avatarUrl?: string | null;
  /**
   * The chat's persona's picture as it stands when a call starts, a same-origin
   * address — RisuAI's user icon — or null. Asked per call: the reader can switch
   * the persona mid-chat, while the member is the plot's for good.
   */
  personaAvatarUrl?: () => string | null;
  log(entry: TriggerLogEntry): void;
}

export { luaScriptsOf };

/**
 * Whose Lua states a card's calls use in the reader's sandbox
 * (`LuaSandbox.call`), which every work the reader opens shares
 * (`readerLuaSandbox`): its scripts, all of them, hashed. RisuAI keeps one
 * state a mode for the whole app while the code stays the same, so the same
 * card in two works shares its globals, as here; a group's members, whose code
 * differs, keep theirs apart rather than wiping one another's on every speaker
 * change, as RisuAI's one state would. Two codes that hash alike share a state,
 * which then starts afresh whenever the other code runs — RisuAI's own rule.
 */
export function luaCodeKey(scripts: readonly string[]): string {
  const text = JSON.stringify(scripts);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `lua:${text.length.toString(36)}:${(hash >>> 0).toString(36)}`;
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

/**
 * What `getCharacterImage` and `getPersonaImage` answer: RisuAI hands back an
 * inlay token, which its renderer turns into `<div class="risu-inlay-image"><img …></div>`;
 * that markup itself is what a message or the display draws here, through the
 * sanitizer, the picture being on our own origin. '' without one, as RisuAI's.
 */
export const characterImage = (url: string | null | undefined): string =>
  url ? `<div class="risu-inlay-image"><img src="${escapeHtml(url)}"></div>` : '';

export function snapshotOf(
  scope: CodeScope,
  lowLevel: boolean,
  avatarUrl?: string | null,
  personaAvatarUrl?: string | null,
): LuaSnapshot {
  const character = scope.character;
  return {
    vars: Object.entries(scope.variables()),
    globals: Object.entries(scope.globalVariables()),
    messages: scope.messages.map((message) => ({
      role: message.role,
      data: message.data,
      ...(message.time !== undefined ? { time: message.time } : {}),
    })),
    char: {
      // RisuAI's `char.name`; `{{char}}` is the nickname where there is one.
      name: character.memberName ?? character.name,
      nickname: character.nickname ?? '',
      description: character.description,
      // RisuAI's `char.firstMessage` where the scripts set one; else the greeting the branch opened on.
      firstMessage: character.firstMessage ?? scope.greeting ?? '',
      background: character.backgroundHtml ?? '',
      image: characterImage(avatarUrl),
      lore: character.lorebook.map(risuLore),
      localLore: scope.localLore.map(risuLore),
      moduleLore: (scope.moduleLore ?? []).map(risuLore),
    },
    user: scope.user,
    persona: scope.persona,
    personaImage: characterImage(personaAvatarUrl),
    note: scope.note,
    lowLevel,
    cbs: cbsDataOf(scope.data),
  };
}

/** What the scope's CBS reads besides its state, made plain for the sandbox: the clock as ms. */
function cbsDataOf(data: CodeScope['data']): LuaSnapshot['cbs'] {
  const { clock, ...rest }: NonNullable<CodeScope['data']> = data ?? {};
  return {
    ...rest,
    triggerId: rest.triggerId ?? null,
    ...(clock ? { clock: { now: clock.now.getTime(), timeZone: clock.timeZone, locale: clock.locale } } : {}),
  };
}

/**
 * The Lua scripts among `triggers`, each with its trigger's place in the list
 * and its own `lowLevelAccess` — the card's flag on the card's, a module's on
 * the module's (`TriggerScript.lowLevelAccess`), or `fallback`, the card's,
 * where nothing marked them — as RisuAI's `runLuaButtonTrigger` hands each run
 * its own trigger's.
 */
export function luaEntriesOf(
  triggers: readonly TriggerScript[],
  fallback: boolean,
): { code: string; trigger: number; lowLevelAccess: boolean }[] {
  return triggers.flatMap((trigger, index) => {
    const first = trigger.effect[0];
    if (first?.type !== 'triggerlua') return [];
    const code = first['code'];
    return [{ code: typeof code === 'string' ? code : '', trigger: index, lowLevelAccess: trigger.lowLevelAccess ?? fallback }];
  });
}

export function createLuaEngine(options: LuaEngineOptions): ScriptEngine {
  const { sandbox, ui, log } = options;
  const entries = luaEntriesOf(options.triggers, options.lowLevelAccess);
  const scripts = entries.map((entry) => entry.code);
  const source = scripts.join('\n');
  const stateKey = luaCodeKey(scripts);
  /** Display passes run on every redraw: each distinct complaint is said once. */
  const said = new Set<string>();

  // One dialog at a time, in the order the scripts asked: the page has one sheet.
  let dialogs: Promise<unknown> = Promise.resolve();
  const queued = <T>(ask: () => Promise<T>): Promise<T> => {
    const next = dialogs.then(ask, ask);
    dialogs = next.catch(() => undefined);
    return next;
  };
  const host: Omit<LuaHost, 'lore' | 'llm' | 'request'> = {
    alert: (text, error) => queued(() => ui.alert(text, error)),
    input: (text) => queued(() => ui.input(text)),
    select: (choices) => queued(() => ui.select(choices)),
    confirm: (text) => queued(() => ui.confirm(text)),
    similarity: (source, texts) => options.similarity(source, texts),
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
    if (result.name !== null) {
      const name = overlayName(result.name);
      if (name === null) {
        log({ kind: 'limit', effect: 'setName', message: `a name must be one line of 1 to ${MAX_OVERLAY_NAME_LENGTH} characters` });
      } else scope.setName(name);
    }
    if (result.firstMessage !== null) scope.setFirstMessage(result.firstMessage);
    if (result.background !== null) scope.setBackgroundHtml(result.background);
    // RisuAI's `upsertLocalLoreBook` writes the chat's lore, not the character's.
    if (result.lore.length > 0) scope.setLocalLore(upsertLocalLore(scope.localLore, result.lore));
    notes(result);
  }

  async function call(
    code: string,
    entry: LuaEntry,
    scope: CodeScope,
    lowLevel: boolean,
    trigger = -1,
  ): Promise<LuaCallResult | null> {
    // The lore is activated as RisuAI's `loadLoreBookV3Prompt` activates it: the character's book,
    // then the chat's, with what the script upserted into the chat's on the way, then the modules'.
    const lore: LuaHost['lore'] = (history, upserts) => {
      if (!options.lore) return Promise.reject(new Error('lore cannot be activated here'));
      return options.lore(history, [
        ...scope.character.lorebook,
        ...upsertLocalLore(scope.localLore, upserts),
        ...(scope.moduleLore ?? []),
      ]);
    };
    // A model call or a request names the trigger that made it, for the server's gate.
    const llm: LuaHost['llm'] = (messages, model) => options.llm(messages, model, trigger);
    const request: LuaHost['request'] = (url) => options.request(url, trigger);
    const snapshot = snapshotOf(scope, lowLevel, options.avatarUrl, options.personaAvatarUrl?.());
    const outcome = await sandbox.call(code, entry, snapshot, { ...host, lore, llm, request }, stateKey);
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
      const result = await call(
        request.code,
        { kind: 'trigger', mode: request.mode },
        request.scope,
        request.lowLevelAccess,
        request.trigger,
      );
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
      // Each script with its own trigger's access, as RisuAI's `runLuaButtonTrigger` runs them.
      for (const { code, trigger, lowLevelAccess } of entries) {
        const result = await call(code, { kind: 'button', data }, scope, lowLevelAccess, trigger);
        if (result) apply(result, scope);
      }
    },

    manualNames: () => luaFunctionNames(scripts),

    dispose: () => sandbox.dispose(),
  };
}
