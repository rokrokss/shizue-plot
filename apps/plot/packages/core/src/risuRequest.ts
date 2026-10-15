/**
 * The request as a card's request editors read it — the Lua `editRequest`
 * listeners and the request triggers, which the API runs (§7.2 of
 * ARCHITECTURE.md): RisuAI's `OpenAIChat` items, in the shape RisuAI's
 * `sendChat` puts its request together in, with the fields it sets beside
 * `role` and `content`, which cards filter on.
 *
 * What RisuAI's `sendChat` sends, with no prompt template (its default):
 *
 * - its system turns — main prompt, description, lore, persona — run together
 *   into one, with no field;
 * - `chats`: the memory's summary when the memory ran, `{role: 'system', memo:
 *   'supaMemory'}` (HypaV3's and SupaMemory's alike; `hypaMemory` is only the
 *   old hypa mode's extra turn); then for each `<START>` block of the examples
 *   (`exampleMessage`) a `{role: 'system', content: '[Start a new chat]', memo:
 *   'NewChatExample'}` turn and the block's lines as turns of their own —
 *   `{{user}}:` a user turn named `example_user`, `{{char}}:` an assistant turn
 *   named `example_assistant`; then `{role: 'system', content: '[Start a new
 *   chat]', memo: 'NewChat'}` (a fixed text, sent but for NovelAI and a
 *   template's `trimStartNewChat`); then the greeting, `{role: 'assistant'}`;
 *   then each chat message, `memo` its `chatId`, `attr: []`, `thoughts` what its
 *   `<Thoughts>` held and `multimodals` its pictures (absent without any).
 *   RisuAI trims `chats` from the front to fit, so the examples go first, then
 *   the separator, then the greeting and the oldest messages — and the memory,
 *   when it runs, summarizes them away instead. Every turn of `chats` is then
 *   `removable: true` but the memory's, and but the newest, which went to
 *   `lastChat` before that;
 * - the rest — depth lore, author's note, what goes after everything — with no
 *   field (RisuAI marks no lore).
 *
 * A RisuAI utility bot's request (`isUtilityBot`) is built from RisuAI's utility
 * prompt template instead, which keeps the newest turn among `chats` — removable
 * like the rest — and an empty turn is never sent, its system string included.
 *
 * `cachePoint` (Claude's prompt caching) is only set by a prompt template, and
 * `attr: ['nameAdded']` only with a template's `sendName`; `thoughts` is what
 * RisuAI's chain-of-thought option lifts out of a message, which we do not have.
 */
import {
  promptText,
  type AssembledPrompt,
  type ExampleSpeakers,
  type MessageSource,
  type PromptBlockKind,
} from './prompt.js';
import type { RequestTurn } from './triggers/interpreter.js';

/**
 * A picture of a turn, in RisuAI's shape: `base64` is its data URL, as
 * RisuAI's is — or, past what the API hands a request's editors
 * (`requestTriggers.ts`), a stand-in that names it.
 */
export interface RisuMultimodal {
  type: 'image';
  base64: string;
}

/** The fields RisuAI's request items carry beside `role` and `content`. */
export interface RisuRequestExtras {
  memo?: string;
  name?: string;
  removable?: boolean;
  attr?: string[];
  thoughts?: string[];
  cachePoint?: boolean;
  multimodals?: RisuMultimodal[];
}

/** One turn of the request as the editors read it: RisuAI's `OpenAIChat`. */
export type RisuRequestItem = RequestTurn & RisuRequestExtras;

/** The text of RisuAI's separators, `NewChatExample` and `NewChat`: fixed, not a setting. */
export const RISU_NEW_CHAT = '[Start a new chat]';

/**
 * How RisuAI marks the turn a block of ours stands for. `memo: 'chatId'` is the
 * stored message's own id, as RisuAI's chat messages carry their `chatId`;
 * `chat` is `attr: []` and `thoughts: []`, which RisuAI sets on every chat
 * message (we lift no `<Thoughts>`: that is its chain-of-thought option, which
 * we do not have).
 */
export interface RisuItemRule {
  memo?: 'chatId' | 'NewChatExample' | 'supaMemory';
  removable?: true;
  chat?: true;
}

/**
 * Our blocks, as the RisuAI turns they stand for (`risuRequestView`). The
 * system string is one turn, as RisuAI's main prompt, description, lore and
 * persona run together into one — but for the memory, which is its own system
 * turn, `supaMemory`, as RisuAI sends its memory's summary. An example block is
 * RisuAI's `<START>` block: the `NewChatExample` turn this marks, then its
 * lines as turns named `example_user` and `example_assistant`. A greeting is a
 * `history` turn without the memo (`risuRequestExtras`), and the newest turn of
 * the chat is not removable (`risuRequestView`).
 */
export const RISU_REQUEST_ITEMS: Record<PromptBlockKind, RisuItemRule> = {
  // Parts of the one system string; never turns of their own.
  main: {},
  format: {},
  narration_note: {},
  lore_before: {},
  plot: {},
  character: {},
  absent_cast: {},
  narrator: {},
  style: {},
  lore_after: {},
  persona: {},
  // Its own turn, after the system string, and never removable.
  memory: { memo: 'supaMemory' },
  // Ours alone, beside the system string: as RisuAI's system turns, nothing.
  directions: {},
  // The separator that opens each block; its lines are removable too, and named.
  examples: { memo: 'NewChatExample', removable: true },
  history: { memo: 'chatId', removable: true, chat: true },
  // RisuAI splices its depth lore in after it marked the chat removable.
  depth_lore: {},
  author_note: {},
  // The facts, SillyTavern's retrieved messages and the relationship, which
  // RisuAI has no turn for: spliced in among the chat like depth lore.
  recall: {},
  post_history: {},
  // The start triggers' `additonalSysPrompt` turns.
  injection: {},
  // RisuAI's `postEverything` (a group's "[Write the next reply only as …]").
  trailing: {},
  // A report's block for an edited turn; never a turn that is sent.
  request: {},
};

/** The fields RisuAI sets on the turn `source` is: by its kind, and for the greeting as RisuAI's own. */
export function risuRequestExtras(source: MessageSource | undefined): RisuRequestExtras {
  if (!source) return {};
  const rule = RISU_REQUEST_ITEMS[source.kind];
  // RisuAI's greeting is the character's first message, not a chat message: removable, and nothing else.
  if (source.greeting) return rule.removable ? { removable: true } : {};
  const memo = rule.memo === 'chatId' ? source.id : rule.memo;
  return {
    ...(memo !== undefined ? { memo } : {}),
    ...(rule.removable ? { removable: true } : {}),
    ...(rule.chat ? { attr: [], thoughts: [] } : {}),
  };
}

/** One turn of an example block, as RisuAI's `exampleMessage` reads it. */
export interface ExampleSide {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** `line` past `prefix`, matched as RisuAI matches its speakers — case aside — or null. */
const after = (line: string, prefix: string): string | null =>
  line.slice(0, prefix.length).toLocaleLowerCase() === prefix.toLocaleLowerCase() ? line.slice(prefix.length) : null;

/**
 * An example block's text — after its header line, as sent — as the turns
 * RisuAI's `exampleMessage` makes of a `<START>` block: a line that opens with
 * `{{char}}:`, `<bot>:` or a name of the character's is an assistant turn, one
 * that opens with `{{user}}:`, `<user>:` or the reader's name a user turn — the
 * macros are already expanded here, so the names are what they read as — and
 * every other line joins the turn before it, trimmed. Turns left empty are not
 * sent, as RisuAI skips them.
 *
 * Two things RisuAI does not: a speaker's line keeps everything after the
 * speaker (RisuAI's `split(':', 2)` cuts it at its next colon), and lines
 * before the first speaker — or a block with none — are a system turn of their
 * own rather than dropped, so an edited request does not lose the creator's text.
 */
export function risuExampleSides(text: string, { user, char }: ExampleSpeakers): ExampleSide[] {
  const assistant = ['{{char}}:', '<bot>:', ...char.map((name) => `${name}:`)];
  const reader = ['{{user}}:', '<user>:', `${user}:`];
  const loose: string[] = [];
  const sides: ExampleSide[] = [];
  let current: ExampleSide | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    let said: string | null = null;
    let role: ExampleSide['role'] = 'assistant';
    for (const prefix of assistant) if (said === null) said = after(trimmed, prefix);
    if (said === null) {
      role = 'user';
      for (const prefix of reader) if (said === null) said = after(trimmed, prefix);
    }
    if (said !== null) {
      current = { role, content: said.trimStart() };
      sides.push(current);
    } else if (current) current.content += `\n${trimmed}`;
    else loose.push(trimmed);
  }
  return [{ role: 'system' as const, content: loose.join('\n') }, ...sides]
    .map((side) => ({ role: side.role, content: side.content.trim() }))
    .filter((side) => side.content.length > 0);
}

/** What an item of `risuRequestView` stands for, so the API can map the request back and report it. */
export type RisuItemOrigin =
  /** The system string — without its memory, where it had one. */
  | { kind: 'system' }
  /** The memory section of the system string. */
  | { kind: 'memory' }
  /** `messages[at]`, whole. */
  | { kind: 'message'; at: number }
  /** A separator or a line of the example block `messages[at]`. */
  | { kind: 'example'; at: number }
  /** RisuAI's `NewChat` separator, which stands for nothing of ours. */
  | { kind: 'newChat' };

/** `risuRequestView`'s answer: the items, and what each one is of ours. */
export interface RisuRequestView {
  items: RisuRequestItem[];
  origins: RisuItemOrigin[];
}

/**
 * The prompt as the request editors read it: RisuAI's items, in the order
 * RisuAI's request has them as far as ours has them at all — the system string
 * (the memory apart), our directions, then RisuAI's `chats` (the memory, each
 * example block split, the `NewChat` separator while the history is sent from
 * the branch's start, the greeting and the messages, with the depth lore, the
 * author's note and the start triggers' turns where the assembler put them),
 * then what follows the history. A turn's pictures are its `multimodals`, each
 * `base64` the picture's data URL. A prompt without `risu` or `sources` (one
 * not from the assembler) is its turns as they are.
 */
export function risuRequestView(prompt: Pick<AssembledPrompt, 'system' | 'messages' | 'sources' | 'risu'>): RisuRequestView {
  const { messages, sources, risu } = prompt;
  const items: RisuRequestItem[] = [];
  const origins: RisuItemOrigin[] = [];
  /** RisuAI's `chats`, by index into `items`: the newest goes as `lastChat`, not removable. */
  const chats: number[] = [];
  const push = (item: RisuRequestItem, origin: RisuItemOrigin, chat = false): void => {
    if (chat) chats.push(items.length);
    items.push(item);
    origins.push(origin);
  };
  const whole = (at: number): void => {
    const message = messages[at]!;
    const source = sources?.[at];
    const multimodals =
      typeof message.content === 'string'
        ? []
        : message.content.flatMap((part) => (part.type === 'image' ? [{ type: 'image' as const, base64: part.url }] : []));
    push(
      {
        role: message.role,
        content: promptText(message.content),
        ...risuRequestExtras(source),
        ...(multimodals.length > 0 ? { multimodals } : {}),
      },
      { kind: 'message', at },
      source?.kind === 'history',
    );
  };

  // RisuAI sends no turn with nothing in it (`pushPrompts`) — a utility bot's
  // system string can be empty.
  const system = risu?.memory?.system ?? prompt.system;
  if (system) push({ role: 'system', content: system }, { kind: 'system' });
  let at = 0;
  if (risu && sources) {
    for (; at < messages.length && sources[at]?.kind === 'directions'; at += 1) whole(at);
    if (risu.memory) push({ role: 'system', content: risu.memory.text, ...risuRequestExtras({ kind: 'memory' }) }, { kind: 'memory' });
    for (; at < messages.length && sources[at]?.kind === 'examples'; at += 1) {
      const source = sources[at]!;
      const text = promptText(messages[at]!.content);
      // The first line is the block's header (`exampleHeader`), which RisuAI's block does not have.
      const sides = source.speakers
        ? risuExampleSides(text.slice(text.indexOf('\n') + 1), source.speakers)
        : [{ role: 'system' as const, content: text }];
      push({ role: 'system', content: RISU_NEW_CHAT, ...risuRequestExtras(source) }, { kind: 'example', at }, true);
      for (const side of sides) {
        push(
          {
            role: side.role,
            content: side.content,
            ...(side.role === 'system' ? {} : { name: `example_${side.role}` }),
            removable: true,
          },
          { kind: 'example', at },
          true,
        );
      }
    }
    if (risu.fromStart) push({ role: 'system', content: RISU_NEW_CHAT, memo: 'NewChat', removable: true }, { kind: 'newChat' }, true);
  }
  for (; at < messages.length; at += 1) whole(at);

  // RisuAI moves the newest turn of `chats` to `lastChat` before it marks the rest
  // removable — but for a utility bot, whose prompt template keeps it among them.
  const last = risu?.utilityBot ? undefined : chats.at(-1);
  if (last !== undefined) {
    const { removable: _marked, ...item } = items[last]!;
    items[last] = item;
  }
  return { items, origins };
}
