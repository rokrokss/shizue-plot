/**
 * The request as a card's request editors read it — the Lua `editRequest`
 * listeners and the request triggers, which the API runs (§7.2 of
 * ARCHITECTURE.md): RisuAI's `OpenAIChat` items, `role` and `content` and the
 * fields RisuAI's `sendChat` sets beside them, which cards filter on.
 *
 * What RisuAI sets, and where (`sendChat`, `exampleMessage`):
 *
 * - `memo`: a chat message's `chatId` (its own id); `NewChatExample` on the
 *   `[Start a new chat]` turn that opens each `<START>` block of the examples;
 *   `NewChat` on the one between the examples and the chat; `supaMemory` /
 *   `hypaMemory` on the memory's summary. Nothing else carries one — not the
 *   main prompt, the description, the lore, the persona, the author's note, the
 *   depth lore or what goes after everything.
 * - `name`: `example_user` / `example_assistant` on the examples' turns.
 * - `removable`: every turn of `chats` — the examples, the separator, the
 *   greeting and the messages — but the memory's.
 * - `attr`: `[]` on a chat message (`nameAdded` only on the greeting, with a
 *   prompt template's `sendName`).
 * - `thoughts`: what a chat message's `<Thoughts>` held — `[]` without them.
 * - `multimodals`: a chat message's pictures; absent without any.
 * - `cachePoint`: only with a prompt template's cache card or its automatic
 *   cache point, both Claude's prompt caching.
 */
import type { MessageSource, PromptBlockKind } from './prompt.js';
import type { RequestTurn } from './triggers/interpreter.js';

/** A picture of a turn, in RisuAI's shape. `base64` is a stand-in that names it, not its bytes (the API's `requestTriggers.ts`). */
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

/**
 * How RisuAI marks the turn a block of ours stands for. `memo: 'chatId'` is the
 * stored message's own id, as RisuAI's chat messages carry their `chatId`;
 * `chat` is `attr: []` and `thoughts: []`, which RisuAI sets on every chat
 * message (we lift no `<Thoughts>`: that is its chain-of-thought option, which
 * we do not have).
 */
export interface RisuItemRule {
  memo?: 'chatId' | 'NewChatExample';
  removable?: true;
  chat?: true;
}

/**
 * Our blocks, as the RisuAI turns they stand for. The system string is one
 * turn, as RisuAI's `pushPrompts` merges its main prompt, description, lore and
 * persona into one system turn with no memo — and our memory lives there, so no
 * turn is RisuAI's `supaMemory`. Our examples are one system turn per `<START>`
 * block, both sides in it, so they carry the memo of the turn RisuAI opens each
 * block with and none of the per-side names. A greeting is a `history` turn
 * without the memo (`risuRequestExtras`). There is no `NewChat` separator.
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
  memory: {},
  relationship: {},
  // Ours alone, beside the system string: as RisuAI's system turns, nothing.
  directions: {},
  examples: { memo: 'NewChatExample', removable: true },
  history: { memo: 'chatId', removable: true, chat: true },
  // RisuAI splices its depth lore in after it marked the chat removable.
  depth_lore: {},
  author_note: {},
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
