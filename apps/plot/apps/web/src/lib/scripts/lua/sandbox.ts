/**
 * The page's side of the Lua sandbox (`sandboxRuntime.ts` explains the three
 * realms): it opens the frame, sends it wasmoon and our worker once, and turns
 * each call into a message there and a promise here.
 *
 * Everything that comes back is a stranger's data, however well-behaved the
 * worker usually is — a script that climbs out of Lua into JavaScript can post
 * whatever it likes — so it is checked for shape and size before anything of it
 * reaches the chat. The same goes for what a script asks of the page: a host
 * call is honoured only for a call that is still waiting, only where RisuAI
 * would honour it (no dialogs from a display pass, no model call, embedding
 * search, request or lore activation without low-level access), and only once.
 *
 * The frame is opened on the first call and kept for the life of the chat. A
 * worker the watchdog killed is replaced by the frame on the next call; a frame
 * that is lost (it navigated, or its document went away) is replaced here; a
 * wasmoon that could not load at all is not retried, and every call answers
 * `unavailable`.
 *
 * The frame's and the worker's programs (`sandboxRuntime.ts`, with the Lua
 * prelude) are imported on that first call too, as wasmoon is fetched then: a
 * chat whose scripts never reach Lua carries none of it.
 */

import { risuSelect } from '@shizue/core/triggers';
import type { LuaCallResult, LuaEntry, LuaLoreBook, LuaSnapshot } from './sandboxRuntime';

/** wasmoon's bundle and its WebAssembly, as the frame needs them. */
export interface LuaAssets {
  wasmoon: string;
  wasm: ArrayBuffer;
}

/** The page's end of the frame's port. */
export interface LuaChannel {
  post(message: unknown): void;
  close(): void;
}

export interface LuaChannelEvents {
  message(data: unknown): void;
  /** The frame left our document, or went away. */
  lost(): void;
}

export type OpenLuaChannel = (events: LuaChannelEvents) => Promise<LuaChannel>;

/** One turn of a model call a script asks for, roles already RisuAI's mapping. */
export interface LuaLlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Which of the chat's models a call is for, as RisuAI routes it: `LLM` and
 * `simpleLLM` the main one, `axLLM` the auxiliary one.
 */
export type LuaLlmModel = 'main' | 'sub';

/** RisuAI's answer to a `request`, before its `JSON.stringify`: the target's, or one of its refusals. */
export interface LuaRequestAnswer {
  status: number;
  data: string;
}

/** One entry RisuAI's `loadLoreBookV3Prompt` finds active: its text before the CBS, and its role. */
export interface LuaActiveLore {
  prompt: string;
  role: 'system' | 'user' | 'assistant';
}

/** What `loadLoreBooks` is answered with: the active entries in order, and RisuAI's `maxContext` — the chat's context budget. */
export interface LuaLoreAnswer {
  actives: LuaActiveLore[];
  maxContext: number;
}

/** What a script's host functions reach on the page. */
export interface LuaHost {
  alert(text: string, error: boolean): Promise<void>;
  input(text: string): Promise<string>;
  /** The index of the option chosen, as text — RisuAI's `alertSelect` — or '' for none. */
  select(options: string[]): Promise<string>;
  confirm(text: string): Promise<boolean>;
  /** The model's answer; throws when there is none. */
  llm(messages: LuaLlmMessage[], model: LuaLlmModel): Promise<string>;
  /** `texts`, closest to `source` first, by the reader's embedding model; throws when it fails. */
  similarity(source: string, texts: string[]): Promise<string[]>;
  /** RisuAI's answer to `request(url)`, from our server; throws when there is none. `null` is a URL that is not text. */
  request(url: string | null): Promise<LuaRequestAnswer>;
  /**
   * `loadLoreBooks`: the lore active on `history` — the chat as the script has it —
   * with the entries the script upserted laid over the character's book; throws
   * when it cannot be worked out.
   */
  lore(history: string[], upserts: LuaLoreBook[]): Promise<LuaLoreAnswer>;
}

export type LuaOutcome =
  | { kind: 'done'; result: LuaCallResult }
  /** The watchdog ended the worker mid-call (`stretch`, `cpu`, `time`, …), or the frame was lost. */
  | { kind: 'killed'; reason: string }
  /** No sandbox to run in: wasmoon did not load, or the frame never answered. */
  | { kind: 'unavailable'; message: string };

export interface LuaSandbox {
  /**
   * Runs `code` at `entry`. `member` keeps the Lua state the member's own, in a
   * work of several whose members' engines share one sandbox — each RisuAI
   * character has its own states. Without it the state is the mode's alone.
   */
  call(code: string, entry: LuaEntry, snapshot: LuaSnapshot, host: LuaHost, member?: string): Promise<LuaOutcome>;
  /** Removes the frame, which ends the worker with it. Calls still waiting answer `killed`. */
  dispose(): void;
}

export interface LuaSandboxOptions {
  loadAssets: () => Promise<LuaAssets>;
  /** Defaults to a hidden sandboxed iframe on this document. */
  open?: OpenLuaChannel;
  /** A worker killed while no call was waiting: a script still spinning after it returned. */
  onIdleKill?: (reason: string) => void;
}

/* ----------------------------------------------------------------- caps */

/** Variables one call may hand back. */
const MAX_VARS = 10_000;
/** Messages one call may hand back beyond the ones it was given. */
const MAX_ADDED_MESSAGES = 1_000;
/** Lore entries one call may upsert. */
const MAX_LORE = 2_000;
const MAX_NOTES = 64;
/** A model call's prompt: turns, and characters across them. The server holds the same line. */
export const MAX_LLM_MESSAGES = 200;
export const MAX_LLM_CHARS = 400_000;
/** An embedding search: texts, and characters across them and the query. */
export const MAX_SIMILARITY_TEXTS = 10_000;
export const MAX_SIMILARITY_CHARS = 1_000_000;
/** What one dialog may show. */
const MAX_DIALOG_TEXT = 20_000;
const MAX_DIALOG_OPTIONS = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const short = (value: unknown, length = 500): string => String(value).slice(0, length);

function checkLore(value: unknown): LuaLoreBook | null {
  if (!isRecord(value)) return null;
  const str = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string) : '');
  return {
    key: str('key'),
    secondkey: str('secondkey'),
    insertorder: typeof value['insertorder'] === 'number' && Number.isFinite(value['insertorder']) ? value['insertorder'] : 100,
    comment: str('comment'),
    content: str('content'),
    mode: 'normal',
    alwaysActive: value['alwaysActive'] === true,
    selective: value['selective'] === true,
    useRegex: value['useRegex'] === true,
  };
}

/** The worker's answer, kept to the shape and the sizes the engine reads. */
export function checkResult(raw: unknown, entry: LuaEntry, given: number): LuaCallResult {
  const r = isRecord(raw) ? raw : {};
  const vars: [string, string | null][] = [];
  if (Array.isArray(r['vars'])) {
    for (const pair of r['vars'].slice(0, MAX_VARS)) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && (typeof pair[1] === 'string' || pair[1] === null)) {
        vars.push([pair[0], pair[1]]);
      }
    }
  }
  let messages: LuaCallResult['messages'] = null;
  if (Array.isArray(r['messages']) && r['messages'].length <= given + MAX_ADDED_MESSAGES) {
    const seen = new Set<number>();
    messages = [];
    for (const message of r['messages']) {
      if (!isRecord(message) || typeof message['data'] !== 'string') {
        messages = null;
        break;
      }
      const key = message['key'];
      // A message keeps its identity once at most, and only one it was given.
      const kept = typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < given && !seen.has(key) ? key : null;
      if (kept !== null) seen.add(kept);
      messages.push({ role: message['role'] === 'user' ? 'user' : 'char', data: message['data'], key: kept });
    }
  }
  let res: LuaCallResult['res'];
  if (entry.kind === 'edit' && typeof r['res'] === 'string') res = r['res'];
  if (
    entry.kind === 'display' &&
    Array.isArray(r['res']) &&
    r['res'].length === entry.items.length &&
    r['res'].every((text) => typeof text === 'string')
  ) {
    res = r['res'] as string[];
  }
  const notes: [string, string][] = [];
  if (Array.isArray(r['notes'])) {
    for (const pair of r['notes'].slice(0, MAX_NOTES)) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
        notes.push([short(pair[0], 100), short(pair[1])]);
      }
    }
  }
  const text = (key: string): string | null => (typeof r[key] === 'string' ? (r[key] as string) : null);
  return {
    stopSending: r['stopSending'] === true,
    ...(res !== undefined ? { res } : {}),
    vars,
    messages,
    description: text('description'),
    name: text('name'),
    firstMessage: text('firstMessage'),
    background: text('background'),
    lore: Array.isArray(r['lore'])
      ? r['lore'].slice(0, MAX_LORE).map(checkLore).filter((book): book is LuaLoreBook => book !== null)
      : [],
    notes,
    error: typeof r['error'] === 'string' ? short(r['error']) : null,
  };
}

/** A model call's prompt as a script sent it, or null when it is not one we send. */
export function checkLlmMessages(value: unknown): LuaLlmMessage[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LLM_MESSAGES) return null;
  let total = 0;
  const out: LuaLlmMessage[] = [];
  for (const message of value) {
    if (!isRecord(message) || typeof message['content'] !== 'string') return null;
    const role = message['role'];
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
    total += message['content'].length;
    if (total > MAX_LLM_CHARS) return null;
    out.push({ role, content: message['content'] });
  }
  return out;
}

/** An embedding search as a script asked for it, or null when it is not one we run. */
export function checkSimilaritySearch(source: unknown, texts: unknown): { source: string; texts: string[] } | null {
  if (typeof source !== 'string' || !Array.isArray(texts) || texts.length > MAX_SIMILARITY_TEXTS) return null;
  let total = source.length;
  for (const text of texts) {
    if (typeof text !== 'string') return null;
    total += text.length;
    if (total > MAX_SIMILARITY_CHARS) return null;
  }
  return { source, texts };
}

/** What `loadLoreBooks` sent to activate lore on, or null when it is not that. */
export function checkLoreSearch(
  history: unknown,
  upserts: unknown,
  given: number,
): { history: string[]; upserts: LuaLoreBook[] } | null {
  if (!Array.isArray(history) || history.length > given + MAX_ADDED_MESSAGES) return null;
  if (!history.every((text) => typeof text === 'string')) return null;
  if (!Array.isArray(upserts) || upserts.length > MAX_LORE) return null;
  const books = upserts.map(checkLore);
  if (books.some((book) => book === null)) return null;
  return { history: history as string[], upserts: books as LuaLoreBook[] };
}

/* ---------------------------------------------------------------- the frame */

/** How long a fresh frame gets to say `ready`. It loads nothing, so this is generous. */
const HANDSHAKE_MS = 10_000;

/**
 * A hidden `sandbox="allow-scripts"` frame on this document, and the port from
 * its one-shot handshake — the same handshake and the same second-`load` rule
 * as Layer 2's frames (`componentBridge.ts` says why the window is not a channel).
 */
export const openLuaFrame: OpenLuaChannel = async (events) => {
  const { luaFrameSrcdoc } = await import('./sandboxRuntime');
  return new Promise<LuaChannel>((resolve, reject) => {
    const frame = document.createElement('iframe');
    // The whole security model, as for components. Nothing may be added to it.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.hidden = true;
    frame.title = 'lua';
    frame.srcdoc = luaFrameSrcdoc();
    let port: MessagePort | null = null;
    let loads = 0;
    let open = true;

    const close = (): void => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      window.removeEventListener('message', onWindowMessage);
      port?.close();
      port = null;
      frame.remove();
    };
    const timer = setTimeout(() => {
      close();
      reject(new Error('the Lua sandbox did not start'));
    }, HANDSHAKE_MS);

    function onWindowMessage(event: MessageEvent): void {
      if (port || !open || event.source !== frame.contentWindow || !event.source) return;
      if (!isRecord(event.data) || event.data['type'] !== 'ready') return;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (message) => events.message(message.data);
      // '*' is the only target an opaque origin answers to, and the payload is
      // the port itself, handed to our own document before it has run anything else.
      (event.source as Window).postMessage({ type: 'port' }, '*', [channel.port2]);
      clearTimeout(timer);
      resolve({ post: (message) => port?.postMessage(message), close });
    }

    frame.addEventListener('load', () => {
      loads += 1;
      if (loads < 2 || !open) return;
      // There is no legitimate second load: the frame left our document.
      close();
      events.lost();
    });
    window.addEventListener('message', onWindowMessage);
    document.body.appendChild(frame);
  });
};

/* -------------------------------------------------------------- the client */

interface Waiting {
  resolve: (outcome: LuaOutcome) => void;
  host: LuaHost;
  entry: LuaEntry;
  given: number;
  lowLevel: boolean;
  served: Set<number>;
}

export function createLuaSandbox(options: LuaSandboxOptions): LuaSandbox {
  const open = options.open ?? openLuaFrame;
  let channel: Promise<LuaChannel> | null = null;
  let current: LuaChannel | null = null;
  /** Set once wasmoon failed to load: nothing is retried after that. */
  let broken: string | null = null;
  let seq = 0;
  const waiting = new Map<number, Waiting>();

  const settleAll = (outcome: LuaOutcome): void => {
    const all = [...waiting.values()];
    waiting.clear();
    for (const call of all) call.resolve(outcome);
  };

  const drop = (): void => {
    current?.close();
    current = null;
    channel = null;
  };

  function reply(host: number, answer: { ok: true; value?: unknown } | { ok: false; error: string }): void {
    current?.post({ type: 'reply', host, ...answer });
  }

  async function serve(call: Waiting, host: number, name: unknown, args: unknown): Promise<void> {
    const a = isRecord(args) ? args : {};
    const dialogs = call.entry.kind !== 'display';
    try {
      switch (name) {
        case 'alert':
          if (!dialogs) return reply(host, { ok: false, error: 'not here' });
          await call.host.alert(short(a['text'] ?? '', MAX_DIALOG_TEXT), a['error'] === true);
          return reply(host, { ok: true });
        case 'input':
          if (!dialogs) return reply(host, { ok: false, error: 'not here' });
          return reply(host, { ok: true, value: await call.host.input(short(a['text'] ?? '', MAX_DIALOG_TEXT)) });
        case 'select': {
          if (!dialogs || !Array.isArray(a['options'])) return reply(host, { ok: false, error: 'not here' });
          // The buttons RisuAI's dialog draws for them; the script is answered with the index of the one chosen.
          const choices = risuSelect(a['options'].slice(0, MAX_DIALOG_OPTIONS).map((option) => short(option, 1_000)))
            .options.slice(0, MAX_DIALOG_OPTIONS);
          return reply(host, { ok: true, value: await call.host.select(choices) });
        }
        case 'confirm':
          if (!dialogs) return reply(host, { ok: false, error: 'not here' });
          return reply(host, { ok: true, value: await call.host.confirm(short(a['text'] ?? '', MAX_DIALOG_TEXT)) });
        case 'llm': {
          // RisuAI's gate, held here as well as in the worker: the worker may be lying.
          if (!call.lowLevel) return reply(host, { ok: false, error: 'low-level access is required' });
          const messages = checkLlmMessages(a['messages']);
          if (!messages) return reply(host, { ok: false, error: 'the prompt is not one that can be sent' });
          // Anything but the auxiliary model's name is the main model, as on the server.
          const model = a['model'] === 'sub' ? 'sub' : 'main';
          return reply(host, { ok: true, value: await call.host.llm(messages, model) });
        }
        case 'similarity': {
          if (!call.lowLevel) return reply(host, { ok: false, error: 'low-level access is required' });
          // RisuAI hands the embedder whatever it was given, and anything but text fails there.
          const search = checkSimilaritySearch(a['source'], a['texts']);
          if (!search) return reply(host, { ok: false, error: 'similarity takes a string and a list of strings' });
          return reply(host, { ok: true, value: await call.host.similarity(search.source, search.texts) });
        }
        case 'request': {
          if (!call.lowLevel) return reply(host, { ok: false, error: 'low-level access is required' });
          // No check of the URL here: the server answers every one, and counts it, as RisuAI does.
          const answer = await call.host.request(typeof a['url'] === 'string' ? a['url'] : null);
          if (typeof answer.status !== 'number' || typeof answer.data !== 'string') throw new Error('not an answer');
          return reply(host, { ok: true, value: { status: answer.status, data: answer.data } });
        }
        case 'lore': {
          if (!call.lowLevel) return reply(host, { ok: false, error: 'low-level access is required' });
          const search = checkLoreSearch(a['history'], a['upserts'], call.given);
          if (!search) return reply(host, { ok: false, error: 'loadLoreBooks takes the chat as the script has it' });
          const answer = await call.host.lore(search.history, search.upserts);
          return reply(host, {
            ok: true,
            value: {
              actives: answer.actives.map((active) => ({ prompt: active.prompt, role: active.role })),
              maxContext: answer.maxContext,
            },
          });
        }
        default:
          return reply(host, { ok: false, error: 'unknown' });
      }
    } catch (error) {
      reply(host, { ok: false, error: short(error instanceof Error ? error.message : error) });
    }
  }

  function onMessage(data: unknown): void {
    if (!isRecord(data)) return;
    switch (data['type']) {
      case 'host': {
        const call = typeof data['call'] === 'number' ? waiting.get(data['call']) : undefined;
        const host = data['host'];
        if (!call || typeof host !== 'number' || call.served.has(host)) return;
        call.served.add(host);
        void serve(call, host, data['name'], data['args']);
        return;
      }
      case 'done': {
        const id = data['call'];
        const call = typeof id === 'number' ? waiting.get(id) : undefined;
        if (!call) return;
        waiting.delete(id as number);
        call.resolve({ kind: 'done', result: checkResult(data['result'], call.entry, call.given) });
        return;
      }
      case 'killed': {
        const reason = typeof data['reason'] === 'string' ? short(data['reason'], 40) : 'killed';
        const id = data['call'];
        if (id === null) {
          options.onIdleKill?.(reason);
          return;
        }
        const call = typeof id === 'number' ? waiting.get(id) : undefined;
        if (!call) return;
        waiting.delete(id as number);
        call.resolve({ kind: 'killed', reason });
        return;
      }
      case 'bootFailed': {
        broken = `wasmoon did not load: ${short(data['message'] ?? '')}`;
        drop();
        settleAll({ kind: 'unavailable', message: broken });
        return;
      }
    }
  }

  function connect(): Promise<LuaChannel> {
    if (channel) return channel;
    const opening = (async (): Promise<LuaChannel> => {
      const framed = open({
        message: onMessage,
        lost: () => {
          if (channel !== opening) return;
          drop();
          settleAll({ kind: 'killed', reason: 'lost' });
        },
      });
      // Awaited below; marked handled here so a failed handshake is not reported before then.
      framed.catch(() => undefined);
      let assets: LuaAssets;
      let runtime: typeof import('./sandboxRuntime');
      try {
        [assets, runtime] = await Promise.all([options.loadAssets(), import('./sandboxRuntime')]);
      } catch (error) {
        // A frame that opened for nothing is taken down again, so a retry does not leave one behind.
        framed.then((unused) => unused.close(), () => undefined);
        throw error;
      }
      const opened = await framed;
      current = opened;
      opened.post({ type: 'boot', source: runtime.luaWorkerSource(assets.wasmoon), wasm: assets.wasm });
      return opened;
    })();
    channel = opening;
    opening.catch(() => {
      if (channel === opening) channel = null;
    });
    return opening;
  }

  return {
    async call(code, entry, snapshot, host, member) {
      if (broken) return { kind: 'unavailable', message: broken };
      let opened: LuaChannel;
      try {
        opened = await connect();
      } catch (error) {
        return { kind: 'unavailable', message: short(error instanceof Error ? error.message : error) };
      }
      seq += 1;
      const id = seq;
      return new Promise<LuaOutcome>((resolve) => {
        waiting.set(id, {
          resolve,
          host,
          entry,
          given: snapshot.messages.length,
          lowLevel: snapshot.lowLevel && entry.kind !== 'edit' && entry.kind !== 'display',
          served: new Set(),
        });
        opened.post({ type: 'call', call: id, code, entry, snapshot, ...(member !== undefined ? { member } : {}) });
      });
    },

    dispose() {
      current?.post({ type: 'dispose' });
      drop();
      settleAll({ kind: 'killed', reason: 'disposed' });
    },
  };
}
