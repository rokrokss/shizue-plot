/**
 * The creator regex that rewrites a chat's history on its way into the prompt:
 * RisuAI's `editprocess` scripts and SillyTavern's prompt-only regex scripts.
 *
 * Both rewrite only what the model is sent. The stored turns never change, and
 * neither do the lore scan and the chat functions, which read the turns as
 * stored — RisuAI's and SillyTavern's alike.
 *
 * Both are kept where their app keeps them, in the card's `extensions` —
 * RisuAI's in `risuai.customScripts` (a charx's `module.risum` merged in at
 * import), SillyTavern's in `regex_scripts` — and read from there each time a
 * prompt is built. No normalized copy: the studio has no editor for them, so a
 * copy could only drift from the extensions an export writes back, and reading
 * the source means a fix to the reading reaches every stored card.
 *
 * **Running them is not safe on a server's main thread.** A creator's pattern
 * is full JavaScript regex — lookbehind, backreferences — and one that
 * backtracks catastrophically never returns. `runPromptScripts` is the pure
 * transform and does no bounding of its own: the API runs it inside a worker it
 * can terminate (`apps/api/src/regexWorker.ts`), and nothing else may call it.
 *
 * The flag field's directives are read by the same rules the display import
 * uses (`card/risu.ts`), which take them from here.
 *
 * Dependency-free, so the API's worker loads it (`@shizue/core/prompt-scripts`)
 * without the tokenizer and the card parser.
 */

/* ------------------------------------------------- RisuAI's flag field */

/**
 * `<move_top>`, `<order 3>`, `<move_top, order 3>`, `<cbs>`, … — a bracketed group
 * of directives inside the flag field, RisuAI's own pattern for it.
 */
const FLAG_DIRECTIVE = /<(.+?)>/g;

/**
 * Takes the directives out of the flag field the way RisuAI does, and answers with
 * what they said and what is left of the field.
 *
 * Every `<…>` is cut out and split on commas, so `<move_top, order 3>` is two
 * directives — read as one, its letters leaked into the flags (`m`, `v`, `d`). An
 * `order N` sets the order, the last one written winning; anything else is an
 * action, matched exactly, case and all, because RisuAI looks for `move_top` and
 * nothing else. One a reader has no use for (`<cbs>` on the screen) is simply
 * gone, rather than mistaken for flag letters — the reason the directives come
 * out first. RisuAI looks for them only when the field has a `<` in it.
 */
export function parseScriptFlag(flag: string): { rest: string; actions: string[]; order?: number } {
  const actions: string[] = [];
  if (!flag.includes('<')) return { rest: flag, actions };
  let order: number | undefined;

  const rest = flag.replace(FLAG_DIRECTIVE, (_group, inner: string) => {
    for (const directive of inner.split(',').map((part) => part.trim())) {
      // RisuAI's `parseInt`: `order x` is NaN there too, and sorts as a tie.
      if (directive.startsWith('order ')) order = Number.parseInt(directive.slice(6));
      else actions.push(directive);
    }
    return '';
  });

  return { rest, actions, ...(order !== undefined ? { order } : {}) };
}

/**
 * The flags RisuAI compiles the pattern with, which is also what decides how many
 * matches the script rewrites — with a `g` every one, without it the first. So it
 * is worked out the way RisuAI works it out, from what is left of the field once
 * the directives are out (`rest`, empty when `ableFlag` is off and nothing is read):
 *
 *   - a field that says nothing is `g`;
 *   - a move takes the first `g` out again — RisuAI's own "temporary fix" — so a
 *     moved script lifts its first match only, and the rest stay where they were;
 *   - anything that is not a flag letter goes, and so do repeats;
 *   - and a field with nothing left is `u`.
 *
 * Undefined for the first case alone: a plain `g` the field never asked for is
 * RisuAI's default and ours alike, so a display script stores nothing. Everything
 * else is what RisuAI compiles.
 */
export function compiledScriptFlags(rest: string, move: boolean): string | undefined {
  let flag = rest || 'g';
  if (move) flag = flag.replace('g', '');
  flag = [...new Set(flag.trim().replace(/[^dgimsuvy]/g, ''))].join('');
  if (!flag) flag = 'u';
  return !rest && flag === 'g' ? undefined : flag;
}

/* ------------------------------------------------------------- the scripts */

/** A RisuAI `editprocess` script, as its flag field and directives read. */
export interface RisuProcessScript {
  kind: 'risuai';
  /** Pattern source. A `<cbs>` script's is expanded by the caller first (`expandPromptScript`). */
  in: string;
  /** The template as stored. RisuAI's `$n` and `{{data}}` are read when it runs. */
  out: string;
  /** What is left of the flag field once its directives are out; '' when `ableFlag` is off. */
  flag: string;
  /** The directives the flag field named — `move_top`, `repeat_back`, `inject`, `cbs`, `no_end_nl`, … */
  actions: string[];
}

/** A SillyTavern regex script that alters the outgoing prompt (`promptOnly`). */
export interface TavernPromptScript {
  kind: 'sillytavern';
  /**
   * `findRegex` as ST reads it: `/pattern/flags`, or the whole string as a bare
   * pattern. Macros in it are expanded by the caller first where `substitute`
   * asks for it.
   */
  find: string;
  /** `replaceString`: `{{match}}` and `$0` the whole match, `$1`… and `$<name>` the groups. */
  replace: string;
  /** Text taken out of every group a replacement quotes. Macros expanded by the caller. */
  trimStrings: string[];
  /** ST's `regex_placement`s the script runs on: 1 the user's turns, 2 the model's. */
  placement: number[];
  /** Runs only on turns at least this deep — 0 the newest. */
  minDepth?: number;
  /** Runs only on turns at most this deep. */
  maxDepth?: number;
  /** `substituteRegex`: 0 the pattern as written, 1 its macros expanded, 2 expanded and escaped. */
  substitute: 0 | 1 | 2;
}

export type PromptScript = RisuProcessScript | TavernPromptScript;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** ST's `regex_placement.USER_INPUT` and `AI_OUTPUT` — the two a chat turn is. */
const USER_INPUT = 1;
const AI_OUTPUT = 2;

/**
 * A card's `editprocess` scripts in the sequence RisuAI runs them. Until one
 * script on the list carries `<order N>` the list runs as it stands; from then on
 * it is sorted by that number, highest first, a script without one counting as 0
 * and a tie keeping its place. RisuAI sorts every type together, but the sort is
 * stable, so the others cannot change where these fall relative to each other.
 * A script with no pattern does nothing there, and is not kept.
 */
function risuProcessScripts(extensions: Json): RisuProcessScript[] {
  const risu = extensions['risuai'];
  const scripts = isObject(risu) ? risu['customScripts'] : undefined;
  if (!Array.isArray(scripts)) return [];
  const read = scripts
    .filter((raw): raw is Json => isObject(raw) && raw['type'] === 'editprocess')
    .map((raw) => {
      const flag = typeof raw['flag'] === 'string' ? raw['flag'] : '';
      const { rest, actions, order } = parseScriptFlag(raw['ableFlag'] === true ? flag : '');
      const script: RisuProcessScript = {
        kind: 'risuai',
        in: typeof raw['in'] === 'string' ? raw['in'] : '',
        out: typeof raw['out'] === 'string' ? raw['out'] : '',
        flag: rest,
        actions,
      };
      return { script, order };
    })
    .filter(({ script }) => script.in !== '');
  if (read.some(({ order }) => order !== undefined)) {
    read.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
  }
  return read.map(({ script }) => script);
}

/** A depth bound as ST reads one: a number (or a numeric string) from `floor` up, else none. */
const depthBound = (value: unknown, floor: number): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= floor ? number : undefined;
};

/**
 * A card's prompt-only SillyTavern scripts, in list order: `promptOnly`, not
 * disabled, with a pattern, and placed on the user's or the model's turns — the
 * two placements a turn of history is. One that is also `markdownOnly` runs here
 * too, as in ST, which reads the two flags apart. The display-only ones are the
 * display import's (`card/sillyTavern.ts`); the ones with neither flag edit the
 * turn as it is stored, which a prompt never does.
 */
function tavernPromptScripts(extensions: Json): TavernPromptScript[] {
  const scripts = extensions['regex_scripts'];
  if (!Array.isArray(scripts)) return [];
  const read: TavernPromptScript[] = [];
  for (const raw of scripts) {
    if (!isObject(raw) || raw['promptOnly'] !== true || raw['disabled'] === true) continue;
    const find = raw['findRegex'];
    if (typeof find !== 'string' || !find) continue;
    const placement = (Array.isArray(raw['placement']) ? raw['placement'] : [])
      .map(Number)
      .filter((value) => value === USER_INPUT || value === AI_OUTPUT);
    if (placement.length === 0) continue;
    const substitute = Number(raw['substituteRegex']);
    const minDepth = depthBound(raw['minDepth'], -1);
    const maxDepth = depthBound(raw['maxDepth'], 0);
    read.push({
      kind: 'sillytavern',
      find,
      replace: typeof raw['replaceString'] === 'string' ? raw['replaceString'] : '',
      trimStrings: Array.isArray(raw['trimStrings'])
        ? raw['trimStrings'].filter((trim): trim is string => typeof trim === 'string' && trim !== '')
        : [],
      placement,
      ...(minDepth !== undefined ? { minDepth } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      substitute: substitute === 1 || substitute === 2 ? substitute : 0,
    });
  }
  return read;
}

/**
 * The prompt scripts a card carries: RisuAI's `editprocess`, then SillyTavern's
 * prompt-only regex. A card is one app's or the other's, so the order between
 * the two lists only matters to a card that carries both.
 */
export function promptScriptsOfCard(extensions: Record<string, unknown>): PromptScript[] {
  return [...risuProcessScripts(extensions), ...tavernPromptScripts(extensions)];
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The script with the macros its app expands before matching expanded by
 * `expand` — the caller's macro engine, read for the card the script is on.
 * RisuAI expands a `<cbs>` script's pattern; SillyTavern a pattern whose
 * `substituteRegex` asks for it — escaping what each macro wrote, in the
 * escaped mode — and every trim string. Macros in the replacements are not
 * touched: the prompt expands the whole turn after the scripts have run.
 */
export function expandPromptScript(script: PromptScript, expand: (text: string) => string): PromptScript {
  if (script.kind === 'risuai') {
    return script.actions.includes('cbs') ? { ...script, in: expand(script.in) } : script;
  }
  const find =
    script.substitute === 1
      ? expand(script.find)
      : script.substitute === 2
        ? script.find.replace(/\{\{[\s\S]*?\}\}/g, (macro) => escapeRegex(expand(macro)))
        : script.find;
  return { ...script, find, trimStrings: script.trimStrings.map(expand) };
}

/**
 * Every card's scripts, the roster's order deciding which run first, each
 * expanded for its own card. A script two members carry runs once — two cards
 * imported from the same file, or one module merged into both, would otherwise
 * apply it twice over.
 */
export function promptScriptsOf(
  cards: readonly { extensions: Record<string, unknown> }[],
  expand?: (text: string, card: number) => string,
): PromptScript[] {
  const seen = new Set<string>();
  const scripts: PromptScript[] = [];
  cards.forEach((card, index) => {
    for (const read of promptScriptsOfCard(card.extensions ?? {})) {
      const script = expand ? expandPromptScript(read, (text) => expand(text, index)) : read;
      const identity = JSON.stringify(script);
      if (seen.has(identity)) continue;
      seen.add(identity);
      scripts.push(script);
    }
  });
  return scripts;
}

/* --------------------------------------------------------------- the job */

/** One turn the scripts rewrite. */
export interface PromptScriptMessage {
  /** The text as stored. */
  text: string;
  role: 'user' | 'assistant';
  /** RisuAI's `chatID`: -1 the greeting, then 0, 1, … for the messages after it. */
  chatIndex: number;
  /** SillyTavern's depth: 0 the newest turn of the history, counting up into the past. */
  depth: number;
}

/** What a worker is handed: the scripts, in the order they run, and the turns. */
export interface PromptScriptJob {
  scripts: PromptScript[];
  messages: PromptScriptMessage[];
  /**
   * The greeting the branch opened on, as stored — where RisuAI's `repeat_back`
   * looks when no earlier message has the turn's role, the history in hand
   * included.
   */
  greeting?: string;
}

/**
 * The turns of a history as the scripts see them. `branch` says where the
 * history sits (`PromptBranch`): the memory may have trimmed its front, and
 * RisuAI counts its messages from the greeting, which it keeps apart. The
 * newest turn of `history` is depth 0, as ST counts a prompt — a turn the caller
 * appends after the prompt (a continue's partial) is ST's depth -1, so it does
 * not move the others. A turn hidden from the AI (`HistoryMessage.hidden`) is not
 * counted, as ST counts depth over the `coreChat` that leaves it out; it is never
 * sent, so what the scripts make of it is not read.
 */
export function promptScriptJob(
  history: readonly { role: 'user' | 'assistant'; content: string; hidden?: boolean }[],
  scripts: PromptScript[],
  branch?: { length: number; greeting?: { text: string } },
): PromptScriptJob {
  const total = Math.max(branch?.length ?? history.length, history.length);
  const start = total - history.length;
  const after = branch?.greeting ? 1 : 0;
  let depth = history.filter((turn) => !turn.hidden).length;
  return {
    scripts,
    messages: history.map((turn, index) => {
      if (!turn.hidden) depth -= 1;
      return {
        text: turn.content,
        role: turn.role,
        chatIndex: start + index - after,
        depth,
      };
    }),
    ...(branch?.greeting ? { greeting: branch.greeting.text } : {}),
  };
}

/**
 * How far a script may grow a turn past what was stored. Past it the step is
 * dropped for that turn: a template that repeats its match over every character
 * of a long turn — and the scripts after it, doing it again — would otherwise
 * build a string the size of the worker's heap.
 */
export const MAX_SCRIPT_GROWTH = 100_000;

/**
 * Runs the scripts over the turns and answers with what each turn says after
 * them, in the job's order. Script by script across every turn rather than turn
 * by turn: each turn's chain comes out the same either way, and `onScript` is
 * then a progress mark the caller can read off — which script a terminated run
 * was stuck in. A script that throws on a turn leaves that turn as it was, as
 * RisuAI's per-script `try` does.
 *
 * Unbounded: only ever call this inside a worker that can be terminated (see
 * the module comment).
 */
export function runPromptScripts(job: PromptScriptJob, onScript?: (index: number) => void): string[] {
  const texts = job.messages.map((message) => message.text);
  job.scripts.forEach((script, index) => {
    onScript?.(index);
    const run = script.kind === 'risuai' ? risuRunner(script, job) : tavernRunner(script);
    if (!run) return;
    job.messages.forEach((message, at) => {
      const before = texts[at]!;
      let after: string;
      try {
        after = run(before, message, at);
      } catch {
        return;
      }
      if (after.length <= message.text.length + MAX_SCRIPT_GROWTH) texts[at] = after;
    });
  });
  return texts;
}

type Runner = (text: string, message: PromptScriptMessage, at: number) => string;

/**
 * One RisuAI `editprocess` script, as `processScriptFull` runs it in its
 * `editprocess` mode. RisuAI also runs its CBS over the turn before the scripts
 * and again after every rewrite; here the prompt expands the turn once, after
 * the last script — with the turn's own chat index, so `{{chat_index}}` in a
 * template reads what it does there. A pattern that matches what a macro in the
 * turn would have written is the one place the two differ.
 *
 * The rest is RisuAI's own branching, read for the prompt: `@@emo` changes an
 * expression on a screen and nothing here; `inject`, which there writes the
 * turn back into the stored chat, only takes the match out (stored turns never
 * change) — and, as there, does not run on the greeting. RisuAI also rewrites
 * `{{data}}` in the template to `$&`, but as a replacement string, which writes
 * the macro back over itself; it stays as written there, and so it does here.
 */
function risuRunner(script: RisuProcessScript, job: PromptScriptJob): Runner | null {
  const { actions } = script;
  let out = script.out.replaceAll('$n', '\n');
  const moveTop = out.startsWith('@@move_top') || actions.includes('move_top');
  const move = moveTop || out.startsWith('@@move_bottom') || actions.includes('move_bottom');
  if (out.endsWith('>') && !actions.includes('no_end_nl')) out += '\n';
  const flags = compiledScriptFlags(script.flag, move) ?? 'g';
  let pattern: RegExp;
  try {
    pattern = new RegExp(script.in, flags);
  } catch {
    return null;
  }
  const directed = out.startsWith('@@') || actions.length > 0;

  return (text, message, at) => {
    pattern.lastIndex = 0;
    if (!directed) return text.replace(pattern, out);
    if (pattern.test(text)) {
      if (out.startsWith('@@emo ')) return text;
      if ((out.startsWith('@@inject') || actions.includes('inject')) && message.chatIndex !== -1) {
        return text.replace(pattern, '');
      }
      if (move) return moved(text, pattern, out, moveTop);
      return text.replace(pattern, out);
    }
    if ((out.startsWith('@@repeat_back') || actions.includes('repeat_back')) && message.chatIndex !== -1) {
      return repeatedBack(text, pattern, out, previousOfRole(job, at));
    }
    return text;
  };
}

/**
 * RisuAI's `move_top`/`move_bottom`: the matches leave the turn and go to its
 * top or its bottom, the template filled in by hand — `$N` and `$&`. RisuAI
 * reads a named reference's name as a number, so a `$<name>` never resolves
 * there and stays as written; so it does here.
 */
function moved(text: string, pattern: RegExp, out: string, top: boolean): string {
  const matches = pattern.flags.includes('g') ? [...text.matchAll(pattern)] : [text.match(pattern)];
  let data = text.replace(pattern, '');
  for (const matched of matches) {
    if (!matched) continue;
    const rendered = out
      .replace('@@move_top ', '')
      .replace('@@move_bottom ', '')
      .replace(/(?<!\$)\$[0-9]+/g, (reference) => {
        const index = Number.parseInt(reference.substring(1));
        return index < matched.length ? (matched[index] ?? '') : reference;
      })
      .replace(/\$&/g, matched[0]);
    data = top ? `${rendered}\n${data}` : `${data}\n${rendered}`;
  }
  return data;
}

/**
 * RisuAI's `repeat_back`, for a turn with no match: the match of the latest
 * earlier turn of the same role — or of the greeting, when none has it — goes on
 * again, where the template's second word says (`end` when it says nothing).
 * With no match there either RisuAI throws, and the turn is left as it was.
 */
function repeatedBack(text: string, pattern: RegExp, out: string, earlier: string): string {
  const where = out.split(' ', 2)[1];
  pattern.lastIndex = 0;
  const found = earlier.match(pattern);
  const match = found![0];
  if (!where) return text + match;
  if (!match) return text;
  switch (where) {
    case 'end':
      return text + match;
    case 'start':
      return match + text;
    case 'end_nl':
      return `${text}\n${match}`;
    case 'start_nl':
      return `${match}\n${text}`;
    default:
      return text;
  }
}

/** The stored text RisuAI's `repeat_back` reads for the turn at `at`. */
function previousOfRole(job: PromptScriptJob, at: number): string {
  const message = job.messages[at]!;
  for (let index = at - 1; index >= 0; index -= 1) {
    const earlier = job.messages[index]!;
    if (earlier.chatIndex < 0) break;
    if (earlier.role === message.role) return earlier.text;
  }
  return job.greeting ?? '';
}

/**
 * ST's `regexFromString`: `/pattern/flags` when the string reads as one, and the
 * flags are ones it knows; a bare pattern otherwise. A pattern the engine refuses
 * is no script at all.
 */
function regexFromString(input: string): RegExp | null {
  try {
    const match = /(\/?)(.+)\1([a-z]*)/i.exec(input);
    if (!match) return null;
    if (match[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(match[3])) return new RegExp(input);
    return new RegExp(match[2]!, match[3]);
  } catch {
    return null;
  }
}

/**
 * One SillyTavern prompt-only script, as `getRegexedString` runs it on a turn
 * of the prompt: on the turns its placement names, within its depth bounds, and
 * with the replacement ST builds itself — `{{match}}`/`$0` the match, `$N` and
 * `$<name>` a group with the trim strings taken out of it, a group that took no
 * part (or is not in the pattern) nothing. `$&` is no reference there and stays
 * as written. ST expands the replacement's macros as it goes; the prompt expands
 * the whole turn afterwards, which writes the same.
 */
function tavernRunner(script: TavernPromptScript): Runner | null {
  const pattern = regexFromString(script.find);
  if (!pattern) return null;
  const template = script.replace.replace(/{{match}}/gi, '$0');
  const trimmed = (group: string): string =>
    script.trimStrings.reduce((text, trim) => text.replaceAll(trim, ''), group);

  return (text, message) => {
    if (!text) return text;
    if (!script.placement.includes(message.role === 'user' ? USER_INPUT : AI_OUTPUT)) return text;
    if (script.minDepth !== undefined && message.depth < script.minDepth) return text;
    if (script.maxDepth !== undefined && message.depth > script.maxDepth) return text;
    pattern.lastIndex = 0;
    return text.replace(pattern, (...args: unknown[]) => {
      const named = typeof args.at(-1) === 'object' && args.at(-1) !== null;
      const groups = named ? (args.at(-1) as Record<string, string | undefined>) : undefined;
      // match, the groups, the offset, the whole string, and the named groups when there are any.
      const count = args.length - 3 - (named ? 1 : 0);
      return template.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_reference, number?: string, name?: string) => {
        const value =
          number !== undefined
            ? Number(number) <= count
              ? args[Number(number)]
              : undefined
            : groups?.[name!];
        return typeof value === 'string' && value ? trimmed(value) : '';
      });
    });
  };
}
