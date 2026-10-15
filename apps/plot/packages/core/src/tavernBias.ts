/**
 * SillyTavern's `{{bias "…"}}`: what the reader writes in their turn to start
 * the reply with (`script.js`). ST takes it out of the turn, keeps it on the
 * turn (`extra.bias`, shown under it), strips every macro left in the turn, and
 * sends it as the last message of the next prompt, in the assistant's role
 * (`openai.js`, the `bias` prompt) — the start of the reply the model goes on
 * from. The reply ST stores is what the model wrote after it.
 */

/** A Handlebars string literal, double- or single-quoted, as `{{bias}}` takes its text. */
const BIAS_RE = /\{\{\s*bias\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\}\}/g;

/**
 * ST's `extractMessageBias`: every `{{bias "…"}}` in the text, joined by a space,
 * after one leading space — '' where there is none. ST reads them with
 * Handlebars, a helper named `bias` collecting its argument; a text Handlebars
 * cannot read at all (an unclosed `{{#if}}`) has none either.
 */
export function extractTavernBias(text: string): string {
  if (!text.includes('{{')) return '';
  const found: string[] = [];
  for (const match of text.matchAll(BIAS_RE)) {
    found.push((match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1'));
  }
  return found.length > 0 ? ` ${found.join(' ')}` : '';
}

/** ST's `removeMacros`: every `{{…}}` taken out, and the rest trimmed — what a turn that had a bias keeps. */
export const removeTavernMacros = (text: string): string => text.replace(/\{\{[\s\S]*?\}\}/g, '').trim();

/**
 * The reply as ST would have stored it: the model's words after the bias. ST's
 * model goes on from the bias it was handed; asked to start with it instead, a
 * model may write it out first, and that copy comes off. Anything else is kept
 * as written.
 */
export function withoutTavernBias(reply: string, bias: string): string {
  const start = bias.trim();
  if (!start) return reply;
  const at = reply.length - reply.trimStart().length;
  return reply.startsWith(start, at) ? reply.slice(at + start.length) : reply;
}
