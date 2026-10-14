/**
 * RisuAI's `editinput` and `editoutput` regex scripts (`processScriptFull` in
 * its `process/scripts.ts`): what the reader sends is rewritten before it is
 * stored, and what the model wrote is rewritten before it is stored.
 *
 * Read the way RisuAI reads them. The flag field holds `<…>` directives when
 * `ableFlag` is on — `<order N>` sorts the whole list highest first once any
 * script carries one, anything else is an action (`move_top`, `move_bottom`,
 * `repeat_back`, `inject`, `cbs`, `no_end_nl`). `$n` in a replacement is a line
 * break, and one that ends in `>` gets a line break after it. (RisuAI also
 * rewrites `{{data}}` to `$&` — with `$&` as the replacement string, which puts
 * `{{data}}` straight back; it stays as written here too.) The flags are cut to
 * what a RegExp takes, `g` by default, `u` when nothing is left. A script that
 * throws — a pattern that does not compile, a `repeat_back` with nothing to
 * repeat — is skipped, as there.
 *
 * One rule is ours: only the creator's replacement is read as CBS, with the
 * match bound into it as values (`renderOutTemplate`). RisuAI also reads the
 * whole message as CBS before the scripts and after every replacement, so
 * whatever macro the model or the reader wrote ran there; here a message's own
 * braces stay text, as they do everywhere a message is shown or folded.
 */

import { renderOutTemplate, evaluateScriptCbs, type ScriptCbsEnv, type TemplateMatch } from './cbsHost.js';
import type { EditScript, EditScriptType } from './scripts.js';

export interface EditRunOptions {
  /** RisuAI's `chatID`: the index of the message being rewritten, -1 for what the reader is sending. */
  chatIndex: number;
  /** The last message of the same role before this one — or the greeting — for `repeat_back`. */
  previousSameRole?: string;
  env: ScriptCbsEnv;
  /** Told about every script that was skipped, and why. */
  onSkip?: (script: EditScript, reason: string) => void;
  /**
   * Told the name a matching `@@emo name` script gives — RisuAI's way for a card
   * to set its character's emotion picture itself, which then stands in place
   * of the one its auxiliary model would choose (`emoChanged`). The last one
   * told is the one shown.
   */
  onEmotion?: (name: string) => void;
  /**
   * Told which script is about to run, by its index in the list given — before
   * its pattern is compiled. A caller that can stop the run from outside (the
   * browser's worker, `lib/scripts/editScriptRunner.ts`) learns from the last
   * one it heard which script would not come back.
   */
  onScript?: (index: number) => void;
}

/**
 * Patterns compiled once and handed out again, RisuAI's `processScriptCache`
 * moved down a level: RisuAI keeps the *result* of a whole pass by text, which
 * an edit script never meets twice (the reader's text, the model's reply), while
 * the same card's patterns are compiled for every one of them. Keyed by the
 * pattern as evaluated and its flags; bounded, oldest out first. A pattern that
 * does not compile is not kept, and throws again the next time, as there.
 */
const compiled = new Map<string, RegExp>();
const MAX_COMPILED = 256;

function compile(pattern: string, flags: string): RegExp {
  const key = `${flags}/${pattern}`;
  let regex = compiled.get(key);
  if (!regex) {
    regex = new RegExp(pattern, flags);
    if (compiled.size >= MAX_COMPILED) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, regex);
  }
  // A global or sticky pattern carries where its last search ended; a fresh one
  // starts at the beginning, and so must one handed out again.
  regex.lastIndex = 0;
  return regex;
}

interface Parsed {
  script: EditScript;
  /** Where it stands in the list given, which `onScript` names it by. */
  index: number;
  /** The flag field with its directives taken out. */
  flag: string | undefined;
  order: number;
  actions: string[];
}

function parse(script: EditScript, index: number): { parsed: Parsed; ordered: boolean } {
  if (!script.ableFlag || !script.flag?.includes('<')) {
    return { parsed: { script, index, flag: script.flag, order: 0, actions: [] }, ordered: false };
  }
  let order = 0;
  let ordered = false;
  const actions: string[] = [];
  const flag = script.flag.replace(/<(.+?)>/g, (_group, inner: string) => {
    for (const directive of inner.split(',').map((part) => part.trim())) {
      if (directive.startsWith('order ')) {
        order = parseInt(directive.slice(6), 10);
        ordered = true;
      } else {
        actions.push(directive);
      }
    }
    return '';
  });
  return { parsed: { script, index, flag, order, actions }, ordered };
}

/** What `String.prototype.replace` hands a replacement function, as a template reads it. */
function matchOf(args: unknown[]): TemplateMatch {
  const hasGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
  const named = hasGroups ? (args[args.length - 1] as Record<string, string | undefined>) : undefined;
  const tail = hasGroups ? 3 : 2;
  const match = args[0] as string;
  const offset = args[args.length - tail] as number;
  const whole = args[args.length - tail + 1] as string;
  return {
    match,
    groups: args.slice(1, args.length - tail) as (string | undefined)[],
    ...(named ? { named } : {}),
    before: whole.slice(0, offset),
    after: whole.slice(offset + match.length),
  };
}

/** A `RegExpMatchArray` as a template reads it. */
function matchOfArray(found: RegExpMatchArray, whole: string): TemplateMatch {
  const offset = found.index ?? 0;
  return {
    match: found[0],
    groups: found.slice(1),
    ...(found.groups ? { named: found.groups } : {}),
    before: whole.slice(0, offset),
    after: whole.slice(offset + found[0].length),
  };
}

function execute(data: string, entry: Parsed, mode: EditScriptType, options: EditRunOptions): string {
  const { script, actions } = entry;
  if (script.in === '' || script.type !== mode) return data;

  let template = script.out.replaceAll('$n', '\n');
  let flag = 'g';
  if (script.ableFlag) flag = entry.flag || 'g';
  const moves =
    template.startsWith('@@move_top') ||
    template.startsWith('@@move_bottom') ||
    actions.includes('move_top') ||
    actions.includes('move_bottom');
  if (moves) flag = flag.replace('g', '');
  if (template.endsWith('>') && !actions.includes('no_end_nl')) template += '\n';
  flag = flag
    .trim()
    .replace(/[^dgimsuvy]/g, '')
    .split('')
    .filter((char, index, all) => all.indexOf(char) === index)
    .join('');
  if (flag.length === 0) flag = 'u';

  const pattern = actions.includes('cbs') ? evaluateScriptCbs(script.in, options.env) : script.in;
  const regex = compile(pattern, flag);
  const render = (out: string) => (...args: unknown[]): string => renderOutTemplate(out, matchOf(args), options.env);

  if (!template.startsWith('@@') && actions.length === 0) return data.replace(regex, render(template));

  if (regex.test(data)) {
    if (template.startsWith('@@emo ')) {
      // The text is left as it is; the name is the caller's to keep (`onEmotion`).
      options.onEmotion?.(script.out.substring(6).trim());
      return data;
    }
    if ((template.startsWith('@@inject') || actions.includes('inject')) && options.chatIndex !== -1) {
      // RisuAI stores the message first and then cuts the match from what it
      // returns, which the caller stores over it: the match simply goes.
      return data.replace(regex, '');
    }
    if (moves) {
      const global = flag.includes('g');
      const found = global ? [...data.matchAll(regex)] : [data.match(regex)];
      const original = data;
      let result = data.replace(regex, '');
      const out = template.replace('@@move_top ', '').replace('@@move_bottom ', '');
      const top = template.startsWith('@@move_top') || actions.includes('move_top');
      for (const match of found) {
        if (!match) continue;
        const moved = renderOutTemplate(out, matchOfArray(match, original), options.env);
        result = top ? `${moved}\n${result}` : `${result}\n${moved}`;
      }
      return result;
    }
    return data.replace(regex, render(template));
  }

  if ((template.startsWith('@@repeat_back') || actions.includes('repeat_back')) && options.chatIndex !== -1) {
    const position = template.split(' ', 2)[1];
    const previous = (options.previousSameRole ?? '').match(regex);
    if (!position) {
      // RisuAI reads the match without checking it; a miss throws, and the script is skipped.
      if (!previous) throw new Error('repeat_back: nothing to repeat');
      return data + previous[0];
    }
    if (previous?.[0]) {
      switch (position) {
        case 'end':
          return data + previous[0];
        case 'start':
          return previous[0] + data;
        case 'end_nl':
          return `${data}\n${previous[0]}`;
        case 'start_nl':
          return `${previous[0]}\n${data}`;
      }
    }
  }
  return data;
}

/** `text` after every `mode` script on the list, in RisuAI's order. */
export function runEditScripts(
  text: string,
  scripts: readonly EditScript[],
  mode: EditScriptType,
  options: EditRunOptions,
): string {
  const parsed: Parsed[] = [];
  let ordered = false;
  for (const [index, script] of scripts.entries()) {
    const result = parse(script, index);
    parsed.push(result.parsed);
    if (result.ordered) ordered = true;
  }
  // Highest first, and only once some script asked for an order; a stable sort,
  // so equal orders keep the list's sequence.
  if (ordered) parsed.sort((a, b) => b.order - a.order);

  let data = text;
  for (const entry of parsed) {
    if (entry.script.in === '' || entry.script.type !== mode) continue;
    options.onScript?.(entry.index);
    try {
      data = execute(data, entry, mode, options);
    } catch (error) {
      options.onSkip?.(entry.script, error instanceof Error ? error.message : String(error));
    }
  }
  return data;
}

/** Whether any script on the list runs in `mode`. */
export const hasEditScripts = (scripts: readonly EditScript[], mode: EditScriptType): boolean =>
  scripts.some((script) => script.type === mode && script.in !== '');
