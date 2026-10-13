/**
 * A greeting as the reader sees it.
 *
 * A chat's opening is the plot's intro, expanded once when the chat was made. The
 * conditions in it that wait on a variable — RisuAI's
 * `{{#when::fm_route::vis::6}}…{{/when}}`, a `{{#if}}` over `{{getvar}}` — were
 * kept as written then, because there were no variables to decide them with
 * (`applyMacros` without `variables`). The prompt decides them every turn with
 * the branch's variables. Without the same pass on screen, the reader got every
 * branch at once, braces and all, while the model saw one of them.
 *
 * So this is that pass: the prompt's evaluator (`@shizue/core/macro`), the same
 * variables, the same names. It stays *text*: the macros it does not know — the
 * image references, `{{setvar}}` — come out as they went in, for the message
 * body to draw or hide as it does for any message, and nothing here is markup.
 * Only a greeting gets it. It was written by the plot's creator (or rewritten by
 * the reader, in their own chat); a reply was written by the model, and a reply's
 * braces are the model's protocol, not the creator's template.
 */

import { applyMacros, fnv1a } from '@shizue/core/macro';
import type { Variables } from '@shizue/core/variables';

/**
 * A greeting longer than this once evaluated is shown as it was stored. A
 * `{{getvar}}` brings in whatever the model last set, and that is not bounded by
 * anything on the way in.
 */
export const MAX_GREETING_CHARS = 100_000;

export interface GreetingContext {
  variables: Variables;
  /** The plot's name, which `{{char}}` is everywhere outside a member's own card. */
  char: string;
  user: string;
  /** The chat id: what keeps `{{pick}}` the choice the prompt makes. */
  seed: string;
  /**
   * Messages after the greeting on the branch — with the seed, RisuAI's pick
   * key, which the prompt draws with too: the choice moves with the turn and
   * holds on a reroll. Without it `{{pick}}` keeps the old once-per-chat choice.
   */
  seedLength?: number;
}

/** The root of a branch, written before anyone spoke: the chat's opening, or one of its swipes. */
export const isGreeting = (message: { parentId: string | null; role: string }): boolean =>
  message.parentId === null && message.role === 'assistant';

/**
 * A `{{random}}` that is the same on every render of one message. Left on
 * `Math.random`, a roll inside a kept branch would come out different each time
 * a variable moved anywhere in the chat.
 */
function seededRandom(seed: string): () => number {
  let state = fnv1a(seed);
  // mulberry32: small, and good enough to pick among a handful of options.
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The greeting `content` of message `id`, with its conditions decided. */
export function greetingText(content: string, id: string, ctx: GreetingContext): string {
  if (!content.includes('{{')) return content;
  const shown = applyMacros(content, {
    char: ctx.char,
    user: ctx.user,
    variables: ctx.variables,
    seed: ctx.seed,
    ...(ctx.seedLength !== undefined ? { seedLength: ctx.seedLength } : {}),
    random: seededRandom(id),
  });
  return shown.length > MAX_GREETING_CHARS ? content : shown;
}
