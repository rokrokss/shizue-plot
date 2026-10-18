/**
 * The request as a card's request editors read it — the Lua `editRequest`
 * listeners and the request triggers, which the API runs (§7.2 of
 * ARCHITECTURE.md): RisuAI's `OpenAIChat` items, in the shape RisuAI's
 * `sendChat` puts its request together in, with the fields it sets beside
 * `role` and `content`, which cards filter on.
 *
 * RisuAI's `sendChat` sends its blocks in the order of the preset's template —
 * or, without one, of its `formatingOrder` — and its `pushPrompts` runs system
 * turns together where their `memo` and `name` agree. The assembler builds the
 * request the same way (`templateOf`), so the view follows its messages:
 *
 * - the leading system turns, which are our system string, as RisuAI's turns
 *   (`AssembledPrompt.risu.system`) — the memory, `{role: 'system', memo:
 *   'supaMemory'}`, apart where a template's `memory` item puts it among them;
 * - `chats`: the memory's summary where no item holds it, at their head; then
 *   for each `<START>` block of the examples (`exampleMessage`) a `{role:
 *   'system', content: '[Start a new chat]', memo: 'NewChatExample'}` turn and
 *   the block's lines as turns of their own — `{{user}}:` a user turn named
 *   `example_user`, `{{char}}:` an assistant turn named `example_assistant`;
 *   then `{role: 'system', content: '[Start a new chat]', memo: 'NewChat'}`
 *   (a fixed text, sent but for NovelAI and a template's `trimStartNewChat`);
 *   then the greeting, `{role: 'assistant'}`; then each chat message, `memo`
 *   its `chatId`, `attr: []`, `thoughts` what its `<Thoughts>` held and
 *   `multimodals` its pictures (absent without any). RisuAI trims `chats` from
 *   the front to fit, so the examples go first, then the separator, then the
 *   greeting and the oldest messages — and the memory, when it runs,
 *   summarizes them away instead. Every turn of `chats` is then `removable:
 *   true` but the memory's, and but the newest where there is no template,
 *   which went to `lastChat` before that;
 * - the rest — the lore, the global note, the depth lore, the author's note,
 *   what goes after everything — with no field (RisuAI marks no lore).
 *
 * An empty turn is never sent, a utility bot's empty system string included.
 *
 * `cachePoint` (Claude's prompt caching) is only set by a prompt template, and
 * `attr: ['nameAdded']` only with a template's `sendName`; `thoughts` is what
 * RisuAI's chain-of-thought option lifts out of a message, which we do not have.
 */
import {
  NEW_CHAT_SEPARATOR,
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
export const RISU_NEW_CHAT = NEW_CHAT_SEPARATOR;

/**
 * How RisuAI marks the turn a block of ours stands for. `memo: 'chatId'` is the
 * stored message's own id, as RisuAI's chat messages carry their `chatId`;
 * `chat` is `attr: []` and `thoughts: []`, which RisuAI sets on every chat
 * message (we lift no `<Thoughts>`: that is its chain-of-thought option, which
 * we do not have).
 */
export interface RisuItemRule {
  memo?: 'chatId' | 'NewChatExample' | 'NewChat' | 'supaMemory';
  removable?: true;
  chat?: true;
}

/**
 * Our blocks, as the RisuAI turns they stand for (`risuRequestView`). The
 * leading system blocks are the system string's turns, `risu.system`. The
 * memory is its own system turn, `supaMemory`, as RisuAI sends its memory's
 * summary. An example block is RisuAI's `<START>` block: the `NewChatExample`
 * turn this marks, then its lines as turns named `example_user` and
 * `example_assistant`. A greeting is a `history` turn without the memo
 * (`risuRequestExtras`), and the newest turn of the chat is not removable
 * without a template (`risuRequestView`).
 */
export const RISU_REQUEST_ITEMS: Record<PromptBlockKind, RisuItemRule> = {
  // The preset's and the card's texts, and ours: as RisuAI's system turns, nothing.
  main: {},
  preset: {},
  speech_protocol: {},
  narration_note: {},
  lore_before: {},
  description: {},
  narrator: {},
  style: {},
  lore_after: {},
  lorebook: {},
  persona: {},
  // Its own turn, and never removable: the summaries HypaV3's important and
  // recent shares picked.
  memory: { memo: 'supaMemory' },
  // Ours alone, after the newest turn: as RisuAI's system turns, nothing.
  directions: {},
  // The separator that opens each block; its lines are removable too, and named.
  examples: { memo: 'NewChatExample', removable: true },
  new_chat: { memo: 'NewChat', removable: true },
  history: { memo: 'chatId', removable: true, chat: true },
  // RisuAI splices its depth lore in after it marked the chat removable.
  depth_lore: {},
  author_note: {},
  // The lore keywords brought in, which RisuAI sends in its lorebook slot and we
  // after the newest turn where that slot comes before it: a system turn with
  // no memo, never removable.
  moved_lore: {},
  // The summaries HypaV3's similar and random shares picked (RisuAI sends them
  // with the rest, in `supaMemory`), the facts and SillyTavern's retrieved
  // messages, which RisuAI has no turn for: after the newest turn, like depth-0
  // lore.
  recall: {},
  global_note: {},
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
  /** One of the system string's turns (`risu.system[at]`), or the whole of it where it has no turns apart. */
  | { kind: 'system'; at: number }
  /** `messages[at]`, whole. */
  | { kind: 'message'; at: number }
  /** A separator or a line of the example block `messages[at]`. */
  | { kind: 'example'; at: number };

/** `risuRequestView`'s answer: the items, and what each one is of ours. */
export interface RisuRequestView {
  items: RisuRequestItem[];
  origins: RisuItemOrigin[];
}

/**
 * The prompt as the request editors read it: RisuAI's items, in the order the
 * assembler built them by the preset — the system string as RisuAI's turns
 * (`risu.system`), then every message, each its own item, an example block
 * split into RisuAI's `<START>` turns. A turn's pictures are its
 * `multimodals`, each `base64` the picture's data URL. A prompt without `risu`
 * or `sources` (one not from the assembler) is its turns as they are.
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
  const turns = risu?.system ?? [{ text: prompt.system }];
  turns.forEach((turn, at) => {
    if (turn.text) push({ role: 'system', content: turn.text, ...(turn.memo ? { memo: turn.memo } : {}) }, { kind: 'system', at });
  });
  for (let at = 0; at < messages.length; at += 1) {
    const source = sources?.[at];
    if (!risu || source?.kind !== 'examples') {
      whole(at);
      continue;
    }
    const text = promptText(messages[at]!.content);
    // The first line is the block's own `NewChatExample` separator, which goes as a turn of its own.
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

  // RisuAI moves the newest turn of `chats` to `lastChat` before it marks the rest
  // removable — but not under a template, which keeps it among them.
  const last = risu?.template ? undefined : chats.at(-1);
  if (last !== undefined) {
    const { removable: _marked, ...item } = items[last]!;
    items[last] = item;
  }
  return { items, origins };
}
