/**
 * Display transforms: the creator-authored rewriting of a message on its way to
 * the screen.
 *
 * Presentation only. The stored message and the prompt keep the model's literal
 * output — a transform is re-derived on every render, so it is idempotent by
 * construction and a swipe or an edit can never leave a stale status window
 * behind.
 *
 * It runs on a budget: bounded input, bounded matches, bounded output, and a wall
 * clock. Blowing any of them abandons the whole message and renders it plain —
 * never half-transformed, because a partial status window is a lie about the state
 * rather than a missing decoration.
 *
 * ## RisuAI's order
 *
 * RisuAI's `processScriptFull` reads the whole message as CBS first, then runs
 * each `editdisplay` script in order and reads what it produced as CBS again
 * before the next script sees it. A card leans on that: one script writes
 * `{#if {{equal::…}} #}` and a later one strips the `{#if 0 #}` it became, and a
 * `{{getvar}}` in a script's output decides what the next one matches. So it is
 * done that way here (`transformDisplay`): the message's own macros answered
 * (`renderProse`), then each script, then its output read again (`reparse`).
 *
 * ## Why this is in two halves
 *
 * The patterns are written by a stranger whose card the reader opened, and a
 * regular expression is the one thing here that cannot be stopped once it starts:
 * a wall clock checked between matches never gets a turn if a single `exec`
 * backtracks for a minute, and no authoring-time screen can rule that out —
 * `hp=\d+ a+a+a+a+a+a+a+a+a+a+b` has no parentheses for a screen to look at and
 * doubles its running time for every two characters the model adds.
 *
 * So the transform is separated from the sanitizing:
 *
 *   - `transformDisplay` runs every pattern and every read of CBS between them,
 *     and answers with the message cut into prose and markup that is not yet
 *     trusted. That is the half that can hang, so `lib/displayPlanner.ts` runs it
 *     in a worker it can terminate. It reads the bindings (`{{getvar}}`,
 *     `{{chat_index}}`, …) — a script's next match can depend on them — so a
 *     changed variable asks the worker again.
 *   - `renderDisplayPlan` puts the markup through the sanitizer. That half needs a
 *     DOM (DOMPurify is the trust boundary and there is no DOM in a worker), and
 *     it is bounded by the budget it charges.
 */

import { unescapeCbs } from '@shizue/core/cbs';
import { inDisplayDepth, inDisplayRole } from '@shizue/core/display-script';
import type { DisplaySide } from '@shizue/core';
import { stripVariableMacros, type Variables } from '@shizue/core/variables';
import { drawFrom, holdsCbs, renderProse, renderTemplate, RenderBudgetExhausted, type CbsContext } from './cbs';
import { sanitizeCustomHtml } from './sanitizeHtml';
import { CAPTURE_CLOSE, CAPTURE_OPEN, markCapture, stripTaint, taint, TAINT } from './taint';
import type { DisplayScript } from './types';

/** Where the per-browser custom-UI opt-out lives, like the hidden-tag set. */
const CUSTOM_UI_KEY = 'shizue.customUi';

/** Custom UI is on unless this browser turned it off. */
export function readCustomUiEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(CUSTOM_UI_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeCustomUiEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CUSTOM_UI_KEY, enabled ? '1' : '0');
}

/**
 * A message is a sequence of plain-text runs and rendered HTML islands. Text runs
 * go through the normal markdown pipeline; islands are already sanitized.
 */
export type Segment = { kind: 'text'; text: string } | { kind: 'html'; html: string };

export interface DisplayContext extends CbsContext {
  /** The card's display scripts, in any order — `order` decides. */
  scripts: DisplayScript[];
}

/* -------------------------------------------------------------- the range */

/** A list's in-range subsets, by which of its scripts they keep. */
const subsetsOf = new WeakMap<readonly DisplayScript[], Map<string, DisplayScript[]>>();
/** A context's narrowed copies, by the subset they carry. */
const contextsOf = new WeakMap<DisplayContext, Map<DisplayScript[], DisplayContext>>();

/**
 * The scripts that run on a message `depth` deep of `role` — SillyTavern's
 * regex min/max depth (`inDisplayDepth`) and its placement (`inDisplayRole`,
 * the reader's turn, a reply or a narration): a script out of range, or placed
 * on another side's messages, is never
 * matched, so its pattern costs that message nothing. The list itself wherever
 * all of it runs — every list with no range and no role in it, and every
 * message with no depth (one hidden from the AI) in a list with no role — and
 * otherwise the same array for the same subset, since the planner tells a fresh
 * plan by the list: a row whose subset did not change as the chat grew keeps
 * its plan.
 */
export function displayScriptsAt(
  scripts: DisplayScript[],
  depth: number | undefined,
  role?: DisplaySide,
): DisplayScript[] {
  const ranged =
    depth !== undefined && scripts.some((script) => script.minDepth !== undefined || script.maxDepth !== undefined);
  const placed = role !== undefined && scripts.some((script) => script.role !== undefined);
  if (!ranged && !placed) return scripts;
  const keep = scripts.map(
    (script) => (!ranged || inDisplayDepth(script, depth)) && (!placed || inDisplayRole(script, role!)),
  );
  if (keep.every(Boolean)) return scripts;
  const key = keep.map((kept) => (kept ? '1' : '0')).join('');
  let subsets = subsetsOf.get(scripts);
  if (!subsets) {
    subsets = new Map();
    subsetsOf.set(scripts, subsets);
  }
  let subset = subsets.get(key);
  if (!subset) {
    subset = scripts.filter((_, index) => keep[index]);
    subsets.set(key, subset);
  }
  return subset;
}

/**
 * The display context a message `depth` deep is drawn with: `context` narrowed
 * to the scripts in range (`displayScriptsAt`), the same object for the same
 * subset so a memoized row is not drawn again for nothing. Where no script is in
 * range the list is empty and the message's own CBS is still read, as RisuAI
 * reads every message it shows.
 */
export function displayContextAt(
  context: DisplayContext | undefined,
  depth: number | undefined,
  role?: DisplaySide,
): DisplayContext | undefined {
  if (!context) return undefined;
  const scripts = displayScriptsAt(context.scripts, depth, role);
  if (scripts === context.scripts) return context;
  let narrowed = contextsOf.get(context);
  if (!narrowed) {
    narrowed = new Map();
    contextsOf.set(context, narrowed);
  }
  let at = narrowed.get(scripts);
  if (!at) {
    at = { ...context, scripts };
    narrowed.set(scripts, at);
  }
  return at;
}

/* --------------------------------------------------------------- the budget */

/**
 * A message longer than this is not scanned and is left as prose. RisuAI scans
 * every message whatever its length, and a reply a preset asks for at thousands
 * of words, its reasoning ahead of it, runs past 20,000 characters, where the
 * cap stood until 2026-10-19 — the whole of a module's rendering then fell away
 * from exactly the replies it was written for. What stops a pattern that hangs
 * is the worker the planner terminates, not this.
 */
export const MAX_SCANNED_CHARS = 100_000;
/**
 * Matches one script may rewrite in one message. A module that boxes every line
 * of dialogue matches once a line, and a long reply has hundreds.
 */
export const MAX_MATCHES_PER_SCRIPT = 1_000;
/** Pieces one message may be cut into, text runs and islands together — a boxed line and the prose after it are two. */
export const MAX_SEGMENTS = 1_000;
/**
 * Runs of provenance the planner may hold at once. A segment is made of many of
 * them — every capture inside an island is its own run — so this is the cap the
 * planner can hit first, and the one that bounds a template made of `$1`s.
 */
export const MAX_PLAN_PIECES = 10_000;
/**
 * How long the rewritten message may grow while the scripts run. Scripts chain,
 * so each one scans what the ones before it wrote, and a template is expanded
 * into the text before anything is rendered. Charged as each expansion is built.
 *
 * A template is charged as it is written, before its `{{#when}}`s are read, and a
 * card may carry its whole stylesheet in one: 스쿨잼 appends 449,000 characters
 * of CSS and markup to the last message, 113,000 once read, and at 400,000, the
 * cap until 2026-10-19, that message — the greeting, in a chat just begun — was
 * drawn as prose. So the cap holds a card's stylesheet (`MAX_CREATOR_CSS_LENGTH`
 * in `@shizue/core`, 1,500,000) with the longest message scanned beside it,
 * dressed line by line.
 */
export const MAX_WORKING_CHARS = 2_000_000;
/** Total sanitized HTML one message may produce. */
export const MAX_HTML_CHARS = 400_000;
/**
 * Raw input the sanitizer may take on across one message — charged *before* the
 * work, not measured after it.
 *
 * This is not a duplicate of `MAX_HTML_CHARS`, and the difference is the whole
 * point. Sanitizing is what *discards* the expensive input: a `<style>` block of
 * declarations the property allowlist refuses costs a CSS parse per match and
 * comes back as the empty string, so an output-shaped budget watches a counter
 * sit near zero while the thread is gone. Measured: 100 matches of an 89 KB
 * droppable stylesheet produced 8 characters each and blocked the main thread for
 * 8.5 seconds with `produced` at 800 of 100,000.
 *
 * So each island is charged for the string it is about to hand the sanitizer,
 * before it does.
 *
 * The number is the same as the output cap above, which keeps the two holdable in
 * one thought. At the costliest content measured here, about half a microsecond
 * per charged character, the whole of it is a fifth of a second; it was 100,000
 * until 2026-10-19, when the scan cap above went from 20,000 to 100,000
 * characters and a reply that size, dressed line by line, needed the room.
 */
export const MAX_RENDER_INPUT_CHARS = 400_000;
/**
 * What the CBS reads of one message may take on, every read together: the
 * message's own, each script's output read again before the next script, and
 * the islands' last read. Charged before each read — the template — and again for
 * what it produced, and for every variable the engine expands on the way. The
 * working text once, for a template read as it was written, and four times the
 * sanitizer's allowance, since an island is read more than once; it is paid in
 * the worker, under the planner's deadline, not on the reader's thread.
 */
export const MAX_EVALUATED_CHARS = MAX_WORKING_CHARS + 4 * MAX_RENDER_INPUT_CHARS;
/**
 * Wall clock the matching may spend, checked between matches. The CBS reads in
 * between are not counted against it: they have their own budget, and both are
 * under the planner's own deadline.
 *
 * This is the cooperative half of the bound, and it holds for everything except a
 * single `exec` that never returns. The hard half is `lib/displayPlanner.ts`,
 * which runs the transform in a worker and terminates it — so this deadline is what
 * keeps an *honest* transform from being slow, and termination is what keeps a
 * dishonest one from being fatal.
 *
 * 250ms since 2026-10-19 (50 before): a module of 150 scripts runs them all over
 * a long reply — 38ms for one of 15,700 characters and 240 boxed lines on a
 * desktop, which a phone takes several times as long over — and a plan past the
 * deadline draws the reply as prose, its module's rendering gone. It runs in the
 * worker, so the reader's thread never waits on it.
 */
const TRANSFORM_DEADLINE_MS = 250;

/** The caps the transform carries, passed in so a test can tighten them. */
export interface PlanLimits {
  scanned: number;
  matches: number;
  segments: number;
  pieces: number;
  working: number;
  evaluated: number;
  deadlineMs: number;
}

export const PLAN_LIMITS: PlanLimits = {
  scanned: MAX_SCANNED_CHARS,
  matches: MAX_MATCHES_PER_SCRIPT,
  segments: MAX_SEGMENTS,
  pieces: MAX_PLAN_PIECES,
  working: MAX_WORKING_CHARS,
  evaluated: MAX_EVALUATED_CHARS,
  deadlineMs: TRANSFORM_DEADLINE_MS,
};

/* ----------------------------------------------------------------- the plan */

/**
 * One run of the message as the scripts have rewritten it so far, and whose
 * words they are.
 *
 *   - `text`: prose, outside any script's markup — drawn as the message's prose.
 *   - `capture`: the model's words, or a value it controls, inside a script's
 *     markup — taken in through `$1`, `$&` or `$<name>`, or a `{{getvar}}` the
 *     markup read. Read as CBS like the rest (`bindCapture`), and marked, so a
 *     link built out of one is the model's link.
 *   - `out`: the creator's own markup, as the scripts and their reads made it.
 *
 * Where a word came from follows it through every later script: a pattern may
 * match across all three kinds and a template may move any of them, but a
 * capture is never promoted to `out`.
 *
 * `island` says which drawn block a piece belongs to — 0 for prose. Every match
 * starts a block of its own, and a match that begins or ends inside an earlier
 * block joins it, so a `{{#if}}` one script opened is still in the same block as
 * the `{{/if}}` that closes it after a later script rewrote the middle.
 */
export interface PlanPiece {
  kind: 'text' | 'capture' | 'out';
  text: string;
  island: number;
}

/**
 * What a display pass makes of a message: prose, and markup that is not yet
 * trusted (`renderDisplayPlan` sanitizes it). `top` and `bottom` are what
 * `move_top`/`move_bottom` lifted, one block each.
 */
export interface DisplayPlan {
  top: string[];
  body: Segment[];
  bottom: string[];
}

/** What a display pass is asked to rewrite. */
export interface DisplayRequest {
  content: string;
  scripts: readonly DisplayScript[];
  /** Raw text of the previous message with the same role, for `repeat_back`. */
  previousSameRole: string;
  /**
   * The chat's background (`ChatBackground`) rather than a message: the creator's
   * template from end to end, read as markup from the start, so its `{{getvar}}`s
   * come out marked and its malformed source draws nothing.
   */
  background?: boolean;
}

/**
 * How a capture — the model's words a script took with `$1`, `$&` or `$<name>` —
 * enters the template it is bound into.
 *
 * The owner's call (2026-10-14), following RisuAI, whose `processScriptFull`
 * reads each script's output as CBS whole: a capture is read as CBS like any
 * other text there, the model's own macros included, and its markup is markup.
 * Until then it was escaped twice over — HTML-escaped and brace-escaped — so
 * nothing the model wrote became markup or syntax; this is the one place to put
 * that back.
 *
 * What stays: it is marked (`markCapture`), so the sanitizer still finds a link
 * built out of one to be the model's link, and its `{{setvar}}`s are protocol,
 * hidden here as they are in prose. Whatever it becomes is still sanitized.
 */
export const bindCapture = (text: string): string => markCapture(stripVariableMacros(stripTaint(text)));

/**
 * Runs every enabled script over the message the way RisuAI does, and answers
 * with what it became — prose, and markup not yet sanitized. Returns null when
 * the message should be left as prose: no scripts and no CBS to read, too long
 * to scan, or a blown cap. With no scripts it is the read of the message's own
 * CBS alone, which RisuAI gives every message it shows.
 *
 * The order is RisuAI's: the message's own CBS first (`renderProse`, or for the
 * background the template engine itself), then the scripts in order, each over
 * what the ones before it wrote, the blocks a script touched read as CBS again
 * before the next one runs. What keeps that safe is that the text is never one
 * string to a renderer — it is pieces that remember who wrote them (`PlanPiece`),
 * so prose stays prose and only what a script made is drawn as markup.
 *
 * It runs in the display worker (`lib/displayPlanner.ts`), which is why it needs
 * no DOM: `ctx` is the bindings as they crossed to it.
 */
export function transformDisplay(
  request: DisplayRequest,
  ctx: CbsContext,
  limits: PlanLimits,
  now: () => number,
): DisplayPlan | null {
  const { scripts, previousSameRole } = request;
  const ordered: { index: number; script: DisplayScript }[] = [];
  for (let i = 0; i < scripts.length; i += 1) {
    const script = scripts[i]!;
    if (script.enabled && script.in) ordered.push({ index: i, script });
  }
  // A tie runs in list order, which is also how a card's export writes it out.
  ordered.sort((a, b) => a.script.order - b.script.order || a.index - b.index);
  // With no script to run, what is left of the pass is RisuAI's read of the
  // message's own CBS (`risuChatParser`, which it runs over every message it
  // shows) — and nothing to do where there is nothing to read.
  if (ordered.length === 0 && (request.background || !holdsCbs(request.content))) return null;
  // Scanning a wall of text with a creator's regex is the expensive case, and a
  // message this long is prose rather than a status block.
  if (request.content.length > limits.scanned) return null;

  type Piece = PlanPiece;
  type Match = RegExpExecArray & {
    indices?: Array<[number, number] | undefined> & { groups?: Record<string, [number, number] | undefined> };
  };

  /** Thrown from anywhere below when a cap is blown; the answer is then null. */
  const OVER = { over: true };

  /**
   * `$1`..`$99`, `$&` and `$<name>` — what an OUT template binds a match with. Two
   * digits are taken here and narrowed in `expand`, as `String.prototype.replace`
   * reads them.
   */
  const CAPTURE = /\$(?:(&)|(\d\d?)|<([A-Za-z_][A-Za-z0-9_]*)>)/g;

  /**
   * An invalid regex disables its script, silently. `d` is always added: a capture
   * is moved as the pieces it spans, so where it matched matters, not only what.
   * `g` is always added too, but only so the run can walk the matches by
   * `lastIndex` — how many of them it rewrites is `rewritesEvery`'s to say.
   */
  function compile(script: DisplayScript, source: string = script.in): RegExp | null {
    let flags = script.flags ?? '';
    if (!flags.includes('g')) flags += 'g';
    if (!flags.includes('d')) flags += 'd';
    try {
      return new RegExp(source, flags);
    } catch {
      return null;
    }
  }

  /**
   * The template a script binds its matches into, as RisuAI's `processScriptFull`
   * makes it before every run (`executeScript`): `$n` is a line break, and a
   * template that ends in `>` gets one after it unless the script says
   * `<no_end_nl>` — so the text after a block a script wrote starts on a line of
   * its own for the next script to match. Read here rather than at import, so a
   * script imported before keeps the rule and an export writes `$n` back as it came.
   */
  function templateFor(script: DisplayScript): string {
    const out = script.out.replaceAll('$n', '\n');
    return out.endsWith('>') && !script.noEndNl ? `${out}\n` : out;
  }

  /**
   * Whether a script rewrites every match or only the first.
   *
   * A script that carries flags is read the way RisuAI and SillyTavern read them:
   * with a `g` every match, without one the first. The importers store the flags
   * their source compiled the pattern with — RisuAI's include taking the `g` off a
   * `move_top`/`move_bottom`, which is why a moved RisuAI script lifts one match.
   * A script with none is every match, whatever its action: the editor writes no
   * flags, and a script written here has always meant every match.
   */
  function rewritesEvery(script: DisplayScript): boolean {
    return !script.flags || script.flags.includes('g');
  }

  /**
   * Where to resume after a zero-length match. Adding one would land between the
   * two halves of a surrogate pair, and a unicode-aware regex refuses to match
   * from there — so the same empty match is found again, forever. This is the
   * spec's AdvanceStringIndex: a whole code point when the pattern is unicode-aware.
   */
  function advance(text: string, index: number, unicode: boolean): number {
    if (!unicode) return index + 1;
    const code = text.codePointAt(index);
    return index + (code === undefined ? 1 : String.fromCodePoint(code).length);
  }

  /* -- the budget, shared by the whole run */

  /** Characters of rewritten text that exist, across body, top and bottom. */
  let size = 0;
  /** Pieces created by expansions in this run — what a `$1` storm is caught by. */
  let created = 0;
  const grow = (chars: number): void => {
    size += chars;
    if (size > limits.working) throw OVER;
  };
  const made = (): void => {
    created += 1;
    if (created > limits.pieces) throw OVER;
  };
  /**
   * Characters the CBS reads have taken on, paid before each read. Running out
   * throws the engine's own `RenderBudgetExhausted`, the one thing the engine lets
   * through: anything else thrown inside a read it would take for a malformed
   * template, and answer with that template's source.
   */
  let evaluated = 0;
  const charge = (chars: number): void => {
    evaluated += chars;
    if (evaluated > limits.evaluated) throw new RenderBudgetExhausted('evaluated');
  };
  let deadline = now() + limits.deadlineMs;
  /**
   * The bindings every read sees, with the draw for this text (`drawFrom`): one
   * for the whole pass, so the scripts' reads go on drawing where the message's
   * own left off. `{{bg::…}}` draws its picture only in the background.
   */
  const drawn = drawFrom(ctx, request.content, request.background ? 'background' : undefined);
  const evalCtx: CbsContext = request.background ? { ...drawn, background: true } : drawn;

  /**
   * A read of CBS, not counted against the matching's clock: the time it took is
   * added back to the deadline.
   */
  const timed = <T>(read: () => T): T => {
    const started = now();
    try {
      return read();
    } finally {
      deadline += now() - started;
    }
  };

  /* -- islands: which drawn block each piece belongs to */

  const parent: number[] = [0];
  /** Blocks made by the script running now, whose output is read again after it. */
  let madeByScript: number[] = [];
  const fresh = (): number => {
    parent.push(parent.length);
    madeByScript.push(parent.length - 1);
    return parent.length - 1;
  };
  const find = (id: number): number => {
    let root = id;
    while (parent[root] !== root) root = parent[root]!;
    // Path compression keeps the next lookup flat.
    while (parent[id] !== root) {
      const up = parent[id]!;
      parent[id] = root;
      id = up;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  /* -- reading CBS */

  /** A block's pieces as one template: the creator's text as it stands, the model's bound (`bindCapture`). */
  const templateOf = (pieces: readonly Piece[]): string =>
    pieces.map((piece) => (piece.kind === 'out' ? stripTaint(piece.text) : bindCapture(piece.text))).join('');

  /**
   * What a read of CBS made, cut back into pieces by its marks: what lies inside a
   * capture's marks (`CAPTURE_OPEN`…`CAPTURE_CLOSE`) or a value's (`TAINT` pairs —
   * the engine marks each value it writes, and never one inside another) is the
   * model's; the rest is the creator's. The marks themselves go, so no later
   * pattern ever sees one.
   */
  function cut(text: string, island: number, plain: Piece['kind'] = 'out'): Piece[] {
    const pieces: Piece[] = [];
    let depth = 0;
    let value = false;
    let run = '';
    const flush = (): void => {
      if (!run) return;
      const kind: Piece['kind'] = depth > 0 || value ? 'capture' : plain;
      const last = pieces[pieces.length - 1];
      if (last && last.kind === kind) last.text += run;
      else pieces.push({ kind, text: run, island });
      run = '';
    };
    for (const char of text) {
      if (char === CAPTURE_OPEN || char === CAPTURE_CLOSE || char === TAINT) {
        flush();
        if (char === CAPTURE_OPEN) depth += 1;
        else if (char === CAPTURE_CLOSE) depth = Math.max(0, depth - 1);
        else value = !value;
      } else run += char;
    }
    flush();
    return pieces;
  }

  /**
   * A block read as CBS again before the next script sees it — RisuAI's re-parse
   * of each script's output. Stand-ins stay stand-ins until the last read
   * (`finish`), and a block a later script has yet to close is left as it is.
   */
  function reparse(pieces: Piece[], island: number): Piece[] {
    const template = templateOf(pieces);
    if (!template.includes('{{')) return pieces;
    charge(template.length);
    const rendered = timed(() => renderTemplate(template, evalCtx, charge, (source) => source, { unescape: false }));
    charge(rendered.length);
    return cut(rendered, island);
  }

  /* -- the working text as pieces, addressed by offset into their concatenation */

  interface Layout {
    pieces: Piece[];
    starts: number[];
    joined: string;
  }

  function layout(pieces: Piece[]): Layout {
    const starts: number[] = [];
    let offset = 0;
    for (const piece of pieces) {
      starts.push(offset);
      offset += piece.text.length;
    }
    return { pieces, starts, joined: pieces.map((piece) => piece.text).join('') };
  }

  /** Index of the piece holding the character at `at`, or -1 past either end. */
  function pieceAt(view: Layout, at: number): number {
    if (at < 0 || at >= view.joined.length) return -1;
    let lo = 0;
    let hi = view.pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (view.starts[mid]! <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The pieces covering `[from, to)`, cut at both ends. */
  function slice(view: Layout, from: number, to: number): Piece[] {
    const out: Piece[] = [];
    if (to <= from) return out;
    for (let i = Math.max(0, pieceAt(view, from)); i < view.pieces.length; i += 1) {
      const start = view.starts[i]!;
      if (start >= to) break;
      const piece = view.pieces[i]!;
      const a = Math.max(from, start) - start;
      const b = Math.min(to, start + piece.text.length) - start;
      if (b > a) out.push({ kind: piece.kind, text: piece.text.slice(a, b), island: piece.island });
    }
    return out;
  }

  /**
   * The island a boundary at `at` lies inside, or 0. A boundary is inside a block
   * when the characters on both sides of it belong to the same one.
   */
  function insideIsland(view: Layout, at: number): number {
    const before = pieceAt(view, at - 1);
    const after = pieceAt(view, at);
    if (before < 0 || after < 0) return 0;
    const left = view.pieces[before]!.island;
    const right = view.pieces[after]!.island;
    return left !== 0 && find(left) === find(right) ? left : 0;
  }

  /** Adjacent pieces of one kind in one island become one. */
  function merge(pieces: Piece[]): Piece[] {
    const out: Piece[] = [];
    for (const piece of pieces) {
      if (!piece.text) continue;
      const island = piece.island === 0 ? 0 : find(piece.island);
      const last = out[out.length - 1];
      if (last && last.kind === piece.kind && last.island === island) last.text += piece.text;
      else out.push({ kind: piece.kind, text: piece.text, island });
    }
    return out;
  }

  /**
   * The template with the match bound into it, as pieces. The template's own text
   * is `out`; a capture is the pieces it spans, moved with their provenance. Every
   * piece is charged as it is made, before the next one: a template within the
   * caps can hold fifty thousand `$1`s.
   *
   * A result with any of the creator's text in it — or one that lands inside an
   * existing block — is a block, and the model's words in it are captures. One
   * without is model text rearranged (`$1` alone, trimming whitespace), and stays
   * prose, so it is still read as markdown.
   */
  function expand(template: string, match: Match, view: Layout, joins: number[]): Piece[] {
    const island = fresh();
    for (const other of joins) if (other) union(island, other);
    const pieces: Piece[] = [];
    const literal = (text: string): void => {
      if (!text) return;
      made();
      grow(text.length);
      pieces.push({ kind: 'out', text, island });
    };
    const span = (range: [number, number] | undefined): void => {
      if (!range) return;
      for (const piece of slice(view, range[0], range[1])) {
        made();
        grow(piece.text.length);
        pieces.push(piece);
      }
    };

    const indices = match.indices;
    let cursor = 0;
    CAPTURE.lastIndex = 0;
    for (let ref = CAPTURE.exec(template); ref; ref = CAPTURE.exec(template)) {
      const [whole, all, index, name] = ref;
      let length = whole.length;
      if (all) {
        literal(template.slice(cursor, ref.index));
        span([match.index, match.index + match[0].length]);
      } else if (name) {
        literal(template.slice(cursor, ref.index));
        // Own-property only: a named group called `toString` must not resolve to one.
        const groups = indices?.groups;
        if (groups && Object.prototype.hasOwnProperty.call(groups, name)) span(groups[name]);
      } else {
        // `$10` is group 10 only when the pattern has ten groups. With fewer it is
        // `$1` and then a literal `0` — `String.prototype.replace`'s reading, which is
        // what RisuAI hands a template that stays in place to.
        const digits = index!.length === 2 && Number(index) >= match.length ? index!.slice(0, 1) : index!;
        const at = Number(digits);
        length = 1 + digits.length;
        // A group the pattern does not have stays literal, so a `$` in the template survives.
        if (at >= match.length) {
          literal(template.slice(cursor, ref.index + length));
          cursor = ref.index + length;
          continue;
        }
        literal(template.slice(cursor, ref.index));
        // One it has that took no part in the match binds nothing, as in `replace`.
        span(indices?.[at]);
      }
      cursor = ref.index + length;
    }
    literal(template.slice(cursor));

    const block = pieces.some((piece) => piece.kind === 'out') || joins.some((other) => other !== 0);
    return pieces.map((piece) =>
      block
        ? { kind: piece.kind === 'text' ? 'capture' : piece.kind, text: piece.text, island }
        : { kind: piece.kind, text: piece.text, island: 0 },
    );
  }

  /** Text runs and blocks, as the renderer will cut them. */
  function segmentsOf(pieces: Piece[]): number {
    let count = 0;
    let previous = -1;
    for (const piece of pieces) {
      const island = piece.island === 0 ? 0 : find(piece.island);
      if (island !== previous || island === 0) count += 1;
      previous = island;
    }
    return count;
  }

  /**
   * Every run of `pieces` that belongs to one of `blocks`, read again
   * (`reparse`); the rest as they were.
   */
  function reparseRuns(pieces: Piece[], blocks: ReadonlySet<number>): Piece[] {
    const out: Piece[] = [];
    let run: Piece[] = [];
    const close = (): void => {
      if (run.length > 0) out.push(...reparse(run, run[0]!.island));
      run = [];
    };
    for (const piece of pieces) {
      const island = piece.island === 0 ? 0 : find(piece.island);
      if (island !== 0 && blocks.has(island)) {
        if (run.length > 0 && run[0]!.island !== island) close();
        run.push({ ...piece, island });
      } else {
        close();
        out.push(piece);
      }
    }
    close();
    return out;
  }

  const total = (pieces: Piece[]): number => pieces.reduce((sum, piece) => sum + piece.text.length, 0);

  const top: Piece[][] = [];
  const bottom: Piece[][] = [];
  let body: Piece[];

  try {
    // The message's own CBS first, as RisuAI reads it before any script runs. A
    // message's is prose and stays text; the background's is the creator's
    // template and is read as markup, its values marked.
    if (request.background) {
      charge(request.content.length);
      const read = timed(() =>
        renderTemplate(request.content, evalCtx, charge, () => '', { unescape: false }),
      );
      charge(read.length);
      body = cut(read, 0, 'text');
    } else {
      charge(request.content.length);
      const read = timed(() => renderProse(request.content, evalCtx, charge));
      charge(read.length);
      body = read ? [{ kind: 'text', text: read, island: 0 }] : [];
    }
    size = total(body);
    if (size > limits.scanned) return null;

    for (let step = 0; step < ordered.length; step += 1) {
      const entry = ordered[step]!;
      madeByScript = [];
      const topBefore = top.length;
      const bottomBefore = bottom.length;
      const template = templateFor(entry.script);
      // RisuAI's `<cbs>`: the pattern is read as CBS first, with the chat's
      // bindings — a toggle's `{{#if}}` around it switches it on. One that reads
      // as nothing matches nowhere and everywhere at once; with nothing to write
      // there it changes nothing, as in RisuAI, and is passed over.
      let source = entry.script.in;
      if (entry.script.cbs) {
        charge(source.length);
        source = stripTaint(timed(() => renderProse(entry.script.in, evalCtx, charge)));
        charge(source.length);
        if (source === '' && template === '') continue;
      }
      const pattern = compile(entry.script, source);
      if (!pattern) continue;
      const unicode = pattern.flags.includes('u') || pattern.flags.includes('v');
      const every = rewritesEvery(entry.script);
      const view = layout(body);
      // A script's own match count starts over; the clock and the budget do not.
      let matches = 0;
      let matched = false;
      const next: Piece[] = [];
      let cursor = 0;

      pattern.lastIndex = 0;
      for (let found = pattern.exec(view.joined); found; found = pattern.exec(view.joined)) {
        const match = found as Match;
        matched = true;
        matches += 1;
        if (matches > limits.matches) return null;
        if (now() > deadline) return null;
        const start = match.index;
        const end = start + match[0].length;
        next.push(...slice(view, cursor, start));
        // What the match replaces stops existing as it is rewritten.
        size -= match[0].length;
        const joins = [insideIsland(view, start), insideIsland(view, end)];
        const expansion = expand(template, match, view, joins);
        if (entry.script.action === 'move_top') top.push(expansion);
        else if (entry.script.action === 'move_bottom') bottom.push(expansion);
        else next.push(...expansion);
        cursor = end;
        // The rest stay as they are, in place — moved or not, as in RisuAI.
        if (!every) break;
        if (match[0].length === 0) {
          pattern.lastIndex = advance(view.joined, pattern.lastIndex, unicode);
        }
      }
      if (matched) {
        next.push(...slice(view, cursor, view.joined.length));
        body = merge(next);
      }

      // The status-window idiom: a turn that says nothing about the state keeps
      // showing the last state that was reported, pinned above the prose.
      if (!matched && entry.script.action === 'repeat_back' && previousSameRole) {
        const again = compile(entry.script, source);
        const previous = again ? (again.exec(previousSameRole) as Match | null) : null;
        if (previous) {
          const carried = layout([{ kind: 'text', text: previousSameRole, island: 0 }]);
          top.push(expand(template, previous, carried, [0, 0]));
        }
      }

      // What this script made is read as CBS again before the next one sees it.
      // After the last one, the last read (`finish`) is the only one left.
      if (step < ordered.length - 1 && madeByScript.length > 0) {
        const blocks = new Set(madeByScript.map(find));
        body = merge(reparseRuns(body, blocks));
        for (let at = topBefore; at < top.length; at += 1) top[at] = merge(reparse(top[at]!, find(top[at]![0]?.island ?? 0)));
        for (let at = bottomBefore; at < bottom.length; at += 1) {
          bottom[at] = merge(reparse(bottom[at]!, find(bottom[at]![0]?.island ?? 0)));
        }
      }

      const pieces = body.length + top.reduce((sum, group) => sum + group.length, 0) +
        bottom.reduce((sum, group) => sum + group.length, 0);
      if (pieces > limits.pieces) return null;
      if (segmentsOf(body) + top.length + bottom.length > limits.segments) return null;
      // Recounted from what exists, so the running estimate never drifts.
      size = total(body) + top.reduce((sum, group) => sum + total(group), 0) +
        bottom.reduce((sum, group) => sum + total(group), 0);
      if (size > limits.working) return null;
      created = 0;
    }

    return finish();
  } catch (error) {
    if (error === OVER || error instanceof RenderBudgetExhausted) return null;
    throw error;
  }

  /**
   * The last read of every block, as a template is read: the display unescape
   * once at the end, and a source the parser refuses shown as its own escaped
   * text — or, in the background, as nothing.
   */
  function finish(): DisplayPlan {
    const island = (pieces: readonly Piece[]): string => {
      const template = templateOf(pieces);
      charge(template.length);
      const rendered = timed(() =>
        renderTemplate(template, evalCtx, charge, request.background ? () => '' : undefined),
      );
      charge(rendered.length);
      return rendered;
    };
    const plan: DisplayPlan = { top: top.map(merge).map(island), body: [], bottom: bottom.map(merge).map(island) };
    let block: Piece[] = [];
    let prose = '';
    const close = (): void => {
      if (block.length > 0) plan.body.push({ kind: 'html', html: island(block) });
      block = [];
      if (prose) plan.body.push({ kind: 'text', text: prose });
      prose = '';
    };
    for (const piece of merge(body)) {
      if (piece.island === 0) {
        if (block.length > 0) close();
        // The background's prose is markup too, and its marked values stay marked
        // for the sanitizer; a message's is the message's own text.
        prose += request.background
          ? unescapeCbs(piece.kind === 'capture' ? taint(piece.text) : piece.text, 'html')
          : piece.text;
      } else {
        if (prose || (block.length > 0 && block[0]!.island !== piece.island)) close();
        block.push(piece);
      }
    }
    close();
    return plan;
  }
}

/* ------------------------------------------------------------- the rewriting */

/**
 * Turns a plan into the segments to draw, its markup through the sanitizer.
 * Returns null when the message should be left as prose.
 *
 * Two budgets, and they bound different things. `MAX_RENDER_INPUT_CHARS` is what
 * the sanitizer is allowed to be handed, charged before the work;
 * `MAX_HTML_CHARS` is what all the islands together are allowed to put on the
 * page. Only the first of them can see work that produces nothing.
 *
 * `render` is what an island goes through: the sanitizer alone by default, and
 * in a message RisuAI's markdown before it (`renderIsland` in
 * `lib/markdown/html`, passed by `MessageBody` — this module also runs in the
 * display worker, which has no use for a markdown parser).
 */
export function renderDisplayPlan(
  plan: DisplayPlan,
  render: (html: string) => string = sanitizeCustomHtml,
): Segment[] | null {
  let taken = 0;
  let produced = 0;

  const island = (html: string): Segment => {
    // Pay first. A stage that has not been paid for does not run.
    taken += html.length;
    if (taken > MAX_RENDER_INPUT_CHARS) throw new RenderBudgetExhausted('input');
    // The line break RisuAI puts after a template that ends in `>` is for what
    // comes after it, which the next script matched against; an island stands
    // on its own, so at its end the break draws nothing and goes.
    const clean = render(html).replace(/\n+$/, '');
    produced += clean.length;
    if (produced > MAX_HTML_CHARS) throw new RenderBudgetExhausted('html');
    return { kind: 'html', html: clean };
  };

  try {
    return [
      ...plan.top.map(island),
      ...plan.body.map((segment) => (segment.kind === 'html' ? island(segment.html) : segment)),
      ...plan.bottom.map(island),
    ];
  } catch (error) {
    // Anything at all — a blown cap, a sanitizer that threw — leaves the message
    // exactly as the model wrote it. Half a status window is worse than none.
    if (!(error instanceof RenderBudgetExhausted)) console.error('[display] transform failed', error);
    return null;
  }
}

/**
 * Both halves in one call, on this thread.
 *
 * This is what the transform *means*, and what the tests exercise; it is not how
 * the chat runs it. `MessageBody` transforms in a worker and sanitizes here,
 * because the transform is the half a creator's pattern can hang. Anything that
 * calls this accepts that a pathological pattern stops the caller.
 *
 * `previousSameRole` is the raw text of the previous message with the same role —
 * the only thing `repeat_back` needs, and the reason it is a parameter rather than
 * something this module looks up. `now` exists so the deadline can be tested
 * without a pathological pattern.
 */
export function applyDisplayScripts(
  content: string,
  ctx: DisplayContext,
  previousSameRole = '',
  now: () => number = Date.now,
): Segment[] {
  const plain: Segment[] = [{ kind: 'text', text: content }];
  let plan: DisplayPlan | null = null;
  try {
    plan = transformDisplay({ content, scripts: ctx.scripts, previousSameRole }, ctx, PLAN_LIMITS, now);
  } catch (error) {
    console.error('[display] transform failed', error);
    return plain;
  }
  if (!plan) return plain;
  return renderDisplayPlan(plan) ?? plain;
}

/**
 * Whether two variable maps say the same thing. The chat re-folds the branch on
 * every streamed token; without this the new map would be a new object every
 * time, and every memoized message would re-run its regexes, its template and two
 * DOMPurify passes for a value that did not change.
 */
export function sameVariables(a: Variables, b: Variables): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}
