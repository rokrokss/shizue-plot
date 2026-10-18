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

import { applyMacros } from '@shizue/core/macro';
import type { Variables } from '@shizue/core/variables';
import { seededRandom } from './cbs';

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
  /** The redraw the greeting is drawn in (`CbsContext.drawKey`), for its `{{random}}`. */
  drawKey?: string;
}

/** The root of a branch, written before anyone spoke: the chat's opening, or one of its swipes. */
export const isGreeting = (message: { parentId: string | null; role: string }): boolean =>
  message.parentId === null && message.role === 'assistant';

/**
 * Whether a branch opens on the plot's first opening — RisuAI's `fmIndex` -1,
 * where its greeting is drawn from the character's first message, which a card's
 * scripts may rewrite (`setCharacterFirstMessage`). The openings are the chat's
 * roots, oldest first, as the server numbers them (`promptBranch`); a windowed
 * path that starts past its root opens on none.
 */
export function opensOnFirstGreeting(
  path: readonly { id: string; parentId: string | null; role: string }[],
  siblings: Readonly<Record<string, { index: number }>>,
): boolean {
  const root = path[0];
  // Every read says where each message of its path stands among its siblings; a
  // root nobody said that of is not taken for the first.
  return root !== undefined && isGreeting(root) && siblings[root.id]?.index === 0;
}

/**
 * The greeting `content` of message `id`, with its conditions decided.
 *
 * Its `{{random}}` draws as a message's does (`CbsContext.drawKey`): the same on
 * every render of the greeting until RisuAI would draw it again — the variables
 * moved, or the text did — and not each time another message arrives.
 */
export function greetingText(content: string, id: string, ctx: GreetingContext): string {
  if (!content.includes('{{')) return content;
  const shown = applyMacros(content, {
    char: ctx.char,
    user: ctx.user,
    variables: ctx.variables,
    seed: ctx.seed,
    ...(ctx.seedLength !== undefined ? { seedLength: ctx.seedLength } : {}),
    random: seededRandom(`${ctx.drawKey ?? ''}\u0000${id}\u0000${content}`),
  });
  return shown.length > MAX_GREETING_CHARS ? content : shown;
}

const CHAR_OR_USER = /\{\{\s*(char|user)\s*\}\}/gi;

/**
 * Openings are stored raw — macros are only expanded when the server assembles a
 * prompt — so a page that shows one outside a chat (the work page) has to fill
 * them in for display. Only {{char}} and {{user}} have a sensible answer
 * outside a chat, and outside one {{char}} is the work rather than any of its
 * members.
 */
export function fillPreview(text: string, char: string, user: string): string {
  return text.replace(CHAR_OR_USER, (_match, name: string) =>
    name.toLowerCase() === 'char' ? char : user,
  );
}
