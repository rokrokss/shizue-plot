/**
 * The CBS a card's scripts are written in, as the scripts read it.
 *
 * RisuAI passes every field of a trigger effect through `risuChatParser` before
 * using it, and a regex script's replacement through it after substituting the
 * match. Both are the creator's text, evaluated here by the shared evaluator
 * (`cbs.ts`) with a host that knows the run: the chat variables as the scripts
 * have left them so far, the reader's global variables, the chat, the character
 * the scripts belong to. The output is plain text — no escaping and no marks —
 * because it is a value or a stored message, never markup on a page.
 *
 * `runVar` is off, as it is in `risuChatParser` there: a `{{setvar}}` in an
 * effect field is not run by being read. The evaluator leaves it as written,
 * which is what RisuAI leaves too.
 *
 * What the model wrote is never read as CBS here. A regex replacement is the
 * creator's template, and the text it matched is bound into it as values — the
 * same rule the display scripts keep (`renderOutTemplate` below). RisuAI parses
 * the whole message after each replacement, so a macro the model writes runs
 * there and stays text here.
 */

import { evaluateCbs, parseCbs, type CbsHost, type CbsHostData } from '../cbs.js';

/** What one evaluation knows besides its text. */
export interface ScriptCbsEnv {
  /** A chat variable as the run currently holds it; undefined when unset. */
  variable(name: string): string | undefined;
  globalVariable?(name: string): string | undefined;
  /** [0, 1); the run's, so a test can fix it. */
  random?(): number;
  data?: CbsHostData;
}

/**
 * The longest string one evaluation may grow. RisuAI's own ceiling for a value
 * (`MAX_CBS_VALUE`), so nothing a card does in RisuAI is refused here — and past
 * it, the evaluation throws and the step that asked for it fails.
 */
const MAX_SCRIPT_CBS_CHARS = 1_000_000;

export class ScriptCbsLimit extends Error {}

function hostOf(env: ScriptCbsEnv): CbsHost {
  return {
    variable: env.variable,
    ...(env.globalVariable ? { globalVariable: env.globalVariable } : {}),
    ...(env.random ? { random: env.random } : {}),
    ...(env.data ? { data: env.data } : {}),
    each: true,
    grow: (length) => {
      if (length > MAX_SCRIPT_CBS_CHARS) throw new ScriptCbsLimit('script text grew past its limit');
    },
  };
}

/** One field of an effect, read the way RisuAI reads it: `risuChatParser(field)`. */
export function evaluateScriptCbs(text: unknown, env: ScriptCbsEnv): string {
  if (typeof text !== 'string') return text === undefined || text === null ? '' : String(text);
  if (!text.includes('{{') && !/<(?:user|char|bot)>/i.test(text)) return text;
  return evaluateCbs(text, parseCbs(text), hostOf(env));
}

/** Where a capture stands in a template while the template is evaluated. */
const OPEN = '';
const CLOSE = '';
const TOKEN = /(\d+)/g;
const STRAY = /[]/g;

/**
 * The parts of a match a replacement may name, `String.prototype.replace`'s
 * way: `$&`, `$1`…`$99` (two digits only where that group exists), `$<name>`,
 * `` $` `` and `$'`; `$$` is a dollar. A reference to a group the pattern does not
 * have stays as written, as it does there.
 */
export interface TemplateMatch {
  match: string;
  groups: readonly (string | undefined)[];
  named?: Record<string, string | undefined>;
  before: string;
  after: string;
}

/**
 * Splits a replacement into its text and the captures it names, each capture a
 * token the evaluator will not read as syntax.
 */
function tokenize(template: string, match: TemplateMatch): { text: string; values: string[] } {
  const values: string[] = [];
  const token = (value: string | undefined): string => {
    values.push((value ?? '').replace(STRAY, ''));
    return `${OPEN}${values.length - 1}${CLOSE}`;
  };
  const count = match.groups.length;
  let text = '';
  for (let i = 0; i < template.length; i += 1) {
    const char = template[i]!;
    if (char !== '$' || i + 1 >= template.length) {
      text += char;
      continue;
    }
    const next = template[i + 1]!;
    if (next === '$') {
      text += '$';
      i += 1;
    } else if (next === '&') {
      text += token(match.match);
      i += 1;
    } else if (next === '`') {
      text += token(match.before);
      i += 1;
    } else if (next === "'") {
      text += token(match.after);
      i += 1;
    } else if (next >= '0' && next <= '9') {
      const two = template.slice(i + 1, i + 3);
      const twoDigit = /^\d\d$/.test(two) ? Number(two) : NaN;
      if (twoDigit >= 1 && twoDigit <= count) {
        text += token(match.groups[twoDigit - 1]);
        i += 2;
      } else if (Number(next) >= 1 && Number(next) <= count) {
        text += token(match.groups[Number(next) - 1]);
        i += 1;
      } else {
        text += char;
      }
    } else if (next === '<' && match.named) {
      const end = template.indexOf('>', i + 2);
      if (end === -1) {
        text += char;
        continue;
      }
      text += token(match.named[template.slice(i + 2, end)]);
      i = end;
    } else {
      text += char;
    }
  }
  return { text, values };
}

/**
 * A regex script's replacement for one match: the captures bound in as values,
 * then the template evaluated as CBS. A capture inside a macro's argument is
 * read as that argument's text (`{{calc::$1+1}}` adds to the number the match
 * held); anywhere else it is put back after the evaluation, untouched. Either
 * way its braces are text — the model cannot write a macro into a message by
 * getting it captured.
 */
export function renderOutTemplate(template: string, match: TemplateMatch, env: ScriptCbsEnv): string {
  const { text, values } = tokenize(template, match);
  const restore = (raw: string): string => raw.replace(TOKEN, (_token, index: string) => values[Number(index)] ?? '');
  if (!text.includes('{{') && !/<(?:user|char|bot)>/i.test(text)) return restore(text);
  const host: CbsHost = { ...hostOf(env), text: (raw) => ({ text: restore(raw) }) };
  return restore(evaluateCbs(text, parseCbs(text), host));
}
