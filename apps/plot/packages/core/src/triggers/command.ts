/**
 * RisuAI's slash commands (`processMultiCommand` in its `process/command.ts`):
 * the line a trigger's `command`/`v2Command` effect hands over, and what a
 * reader types into the composer starting with `/` — `/input 이름은?|/setvar
 * key=name`.
 *
 * Ported to the letter, quirks included, because cards were written against
 * them: the line splits on `|` outside double quotes (the quotes stay in the
 * text); each command's words split on single spaces, and a word with `=` is a
 * named argument cut at its first two `=`-parts; `{{pipe}}` and `{{slot}}` are
 * replaced once each, with `String.prototype.replace`'s `$` patterns; an empty
 * argument is the pipe; `/echo` passes the pipe on, not its text; `/cut N` keeps
 * only the message it cuts; `/del N` keeps the last N; `/getvar` of an unset
 * variable throws; a command it does not know, and `/setinput`, answer `false`
 * and end the line. The answer of the last command is the line's.
 *
 * RisuAI's commands act on the chat *as stored* — `getCurrentChat()` — and not
 * on the copy a trigger run works on, so what they do is often written over
 * when the run hands its copy back. That is the caller's to model; here the
 * chat they act on is the host's (`CommandHost`).
 */

import type { TriggerMessage, TriggerRequest } from './interpreter.js';

/**
 * The buttons RisuAI's select dialog (`alertSelect`) draws for `options`, and
 * the text above them. It joins them with `||` into one message — after the
 * text, where there is one — and splits that again, so an option holding `||`
 * is several buttons and a `||` in the text makes the rest of it buttons too.
 * The dialog answers with the index of the button chosen, as text, and every
 * caller hands that to the script as it is (`TriggerRequest` `select`).
 */
export function risuSelect(options: readonly string[], display?: string): { options: string[]; display?: string } {
  if (display === undefined) return { options: options.join('||').split('||') };
  const [text, ...rest] = [display, ...options].join('||').split('||');
  return { options: rest, display: text! };
}

/** What a line of commands answers: the last pipe, or `false` when a command stopped it. `/trigger` leaves `undefined`. */
export type CommandAnswer = string | false | undefined;

/** One active entry as RisuAI's `loadLoreBookV3Prompt` lists it. */
export interface LoreTestActive {
  depth: number;
  pos: string;
  prompt: string;
  role: 'system' | 'user' | 'assistant';
  order: number;
  tokens: number;
  priority: number;
  source: string;
  inject: null;
}

/** What `/test_lorebook` reads and answers with, as JSON. */
export interface LoreTest {
  actives: LoreTestActive[];
  matchLog: unknown[];
}

/** What the commands act on and reach through — the chat as stored, and the rest of the app. */
export interface CommandHost {
  /** RisuAI's `risuChatParser(text, {chara})`: the CBS, read against the chat as stored. */
  cbs(text: string): string;
  /** The stored chat, whose `messages` a command may replace (`/cut`, `/del`) or edit in place. */
  chat: { messages: TriggerMessage[] };
  /** A chat variable as stored — RisuAI's `chat.scriptstate['$' + name]` — or undefined when unset. */
  getVar(name: string): string | undefined;
  setVar(name: string, value: string): void;
  /** `/trigger`: the manual triggers named `name`, run on the stored chat, which becomes the chat they leave. */
  trigger(name: string): Generator<TriggerRequest, void, unknown>;
  /** `/multisend`: each item a user message, sent in turn (`clear` empties the chat before each). */
  multisend(items: string[], clear: boolean): void;
  /** `/test_lorebook`: the lore RisuAI would activate on the stored chat. */
  lore(): Generator<TriggerRequest, LoreTest, unknown>;
}

/** `processMultiCommand`'s split: on `|`, except between double quotes, which stay in the text. */
export function splitCommands(line: string): string[] {
  const parts: string[] = [];
  let last = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === '|' && !quoted) {
      parts.push(line.slice(last, index));
      last = index + 1;
    }
  }
  parts.push(line.slice(last));
  return parts;
}

/** RisuAI's `commandParser`: the name, the argument with the pipe put in, and the named arguments. */
export function parseCommand(
  command: string,
  pipe: string | undefined,
): { name: string | undefined; arg: string; named: Record<string, string> } {
  const text = command.startsWith('/') ? command.slice(1) : command;
  const words = text.split(' ').filter((word) => word !== '');
  const args: string[] = [];
  const named = Object.create(null) as Record<string, string>;
  for (const word of words.slice(1)) {
    if (word.includes('=')) {
      const [key, value] = word.split('=');
      named[key!] = value!;
    } else {
      args.push(word);
    }
  }
  // `replace` with a string: once each, `$&` and the like read as patterns — as there.
  // The pipe `/trigger` leaves is `undefined`, which goes in as the word.
  const arg = args.join(' ').replace('{{pipe}}', String(pipe)).replace('{{slot}}', String(pipe));
  return { name: words[0], arg, named };
}

/**
 * Runs a line of commands. A generator, like a trigger run: it yields where
 * RisuAI waits on a dialog or the lore, and returns the line's answer. What
 * RisuAI throws on — `/getvar` of an unset variable, `/comment` on an empty
 * chat, an empty argument after `/trigger` — throws here.
 */
export function* processMultiCommand(line: string, host: CommandHost): Generator<TriggerRequest, CommandAnswer, unknown> {
  let pipe: string | undefined = '';
  for (const part of splitCommands(line)) {
    const answer: CommandAnswer = yield* processCommand(part.trim(), pipe, host);
    if (answer === false) return false;
    pipe = answer;
  }
  return pipe;
}

function* processCommand(
  command: string,
  pipe: string | undefined,
  host: CommandHost,
): Generator<TriggerRequest, CommandAnswer, unknown> {
  const parsed = parseCommand(command, pipe);
  const named = parsed.named;
  let raw: string | undefined = parsed.arg;
  if (!raw) raw = pipe;
  // RisuAI's parser reads what it is given as text, and `undefined` is not.
  if (raw === undefined) throw new TypeError(`/${parsed.name ?? ''}: there is no argument to read`);
  const arg = host.cbs(raw);
  for (const key of Object.keys(named)) named[key] = host.cbs(named[key]!);

  switch (parsed.name) {
    // STScript's commands
    case 'input':
      return asText((yield { kind: 'input', text: arg }) ?? '');
    case 'echo':
    case 'popup':
      yield { kind: 'alert', text: arg };
      return pipe;
    case 'pass':
      return arg;
    case 'buttons': {
      if (named['labels']) {
        let labels: unknown;
        try {
          labels = JSON.parse(named['labels']);
        } catch {
          return pipe;
        }
        if (Array.isArray(labels)) {
          // The index of the label chosen, as the dialog answers it. Closing it here chooses none.
          const options = labels.map((label) => (label === null || label === undefined ? '' : String(label)));
          return asText((yield { kind: 'select', ...risuSelect(options) }) ?? '');
        }
      }
      return pipe;
    }
    case 'setinput':
      // Not implemented in RisuAI, which answers false.
      return false;
    case 'speak':
      // The character's TTS, which a card imported into RisuAI never brings: its
      // import sets the mode to `normal` (or `vits` for a card with a voice model,
      // which nothing here can run), and `normal` says nothing.
      return pipe;
    case 'send':
      host.chat.messages.push({ role: 'user', data: arg });
      return pipe;
    case 'sendas':
      host.chat.messages.push({ role: 'char', data: arg });
      return pipe;
    case 'comment': {
      const last = host.chat.messages[host.chat.messages.length - 1];
      if (!last) throw new TypeError('/comment: the chat has no message');
      last.data += `<Comment>\n${arg}\n</Comment>`;
      return pipe;
    }
    case 'cut': {
      const messages = host.chat.messages;
      if (arg.includes('-')) {
        const [start, end] = arg.split('-');
        host.chat.messages = messages.slice(parseInt(start!), parseInt(end!));
      } else if (!Number.isNaN(parseInt(arg))) {
        // RisuAI keeps what `splice` returns: the one message cut.
        host.chat.messages = messages.splice(parseInt(arg), 1);
      } else {
        // RisuAI's `chatId`, which is our message id.
        host.chat.messages = messages.filter((message) => message.id !== arg);
      }
      return pipe;
    }
    case 'del': {
      const size = parseInt(arg);
      if (!Number.isNaN(size)) host.chat.messages = host.chat.messages.slice(host.chat.messages.length - size);
      return pipe;
    }
    case 'len': {
      try {
        const parsedArg: unknown = JSON.parse(arg);
        if (Array.isArray(parsedArg)) return String(parsedArg.length);
      } catch {
        // Not a list: the pipe goes on as it was.
      }
      return pipe;
    }
    case 'multisend': {
      const items = arg.split('|||');
      let clear = false;
      if (items[0] && items[0].trim() === 'clear') {
        clear = true;
        items.shift();
      }
      host.multisend(items, clear);
      return '';
    }
    case 'setvar':
      host.setVar(String(named['key']), arg);
      return '';
    case 'addvar': {
      const key = String(named['key']);
      host.setVar(key, String(Number(host.getVar(key)) + Number(arg)));
      return '';
    }
    case 'getvar': {
      const value = host.getVar(String(named['key']));
      if (value === undefined) throw new TypeError(`/getvar: "${String(named['key'])}" is not set`);
      return value;
    }
    case 'test_lorebook': {
      const test = yield* host.lore();
      yield { kind: 'alert', text: test.actives.map((active) => active.prompt).join('§') };
      return JSON.stringify(test);
    }
    case 'trigger':
      yield* host.trigger(arg);
      return undefined;
    case '?':
      yield { kind: 'help' };
      return 'help';
  }
  return false;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : String(value));

/** The JSON `/test_lorebook` answers with, from whatever answered the lore request. */
export function loreTestOf(raw: unknown): LoreTest {
  if (!raw || typeof raw !== 'object') return { actives: [], matchLog: [] };
  const test = raw as Partial<LoreTest>;
  return {
    actives: Array.isArray(test.actives) ? test.actives : [],
    matchLog: Array.isArray(test.matchLog) ? test.matchLog : [],
  };
}
