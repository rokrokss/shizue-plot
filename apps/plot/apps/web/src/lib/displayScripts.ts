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
 * ## Why this is in two halves
 *
 * The patterns are written by a stranger whose card the reader opened, and a
 * regular expression is the one thing here that cannot be stopped once it starts:
 * a wall clock checked between matches never gets a turn if a single `exec`
 * backtracks for a minute, and no authoring-time screen can rule that out —
 * `hp=\d+ a+a+a+a+a+a+a+a+a+a+b` has no parentheses for a screen to look at and
 * doubles its running time for every two characters the model adds.
 *
 * So the matching is separated from the rendering:
 *
 *   - `planDisplayScripts` runs every pattern and answers with *where* the matches
 *     are — plain data, no DOM, nothing evaluated. That is the half that can hang,
 *     so `lib/displayPlanner.ts` runs it in a worker it can terminate.
 *   - `renderDisplayPlan` turns a plan into markup: it binds the captures, renders
 *     the CBS template and sanitizes the result. That half needs a DOM (DOMPurify
 *     is the trust boundary and there is no DOM in a worker), and everything in it
 *     is bounded by construction.
 *
 * The split falls where the data does. A plan depends only on the message text,
 * the scripts and the previous message — all fixed once a message has finished
 * streaming — so it is computed once and kept. The rendering depends on the live
 * bindings (`{{getvar}}`, `{{rel::}}`, `{{turn}}`), so it stays synchronous and a
 * changed variable still redraws the status window on the next render, with no
 * round trip at all.
 */

import { stripVariableMacros, type Variables } from '@shizue/core/variables';
import { escapeHtml, renderTemplate, RenderBudgetExhausted, type CbsContext } from './cbs';
import { sanitizeCustomHtml } from './sanitizeHtml';
import { stripTaint, taint } from './taint';
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

/* --------------------------------------------------------------- the budget */

/** A message longer than this is not worth scanning and is left as prose. */
export const MAX_SCANNED_CHARS = 20_000;
/** Matches one script may rewrite in one message. */
export const MAX_MATCHES_PER_SCRIPT = 200;
/** Pieces one message may be cut into, text runs and islands together. */
export const MAX_SEGMENTS = 100;
/**
 * Runs of provenance the planner may hold at once. A segment is made of many of
 * them — every capture inside an island is its own run — so this is the cap the
 * planner can hit first, and the one that bounds a template made of `$1`s.
 */
export const MAX_PLAN_PIECES = 2_000;
/**
 * How long the rewritten message may grow while the scripts run. Scripts chain,
 * so each one scans what the ones before it wrote, and a template is expanded
 * into the text before anything is rendered. Charged as each expansion is built.
 */
export const MAX_WORKING_CHARS = 100_000;
/** Total sanitized HTML one message may produce. */
export const MAX_HTML_CHARS = 100_000;
/**
 * Raw input the rendering half may take on across one message — charged *before*
 * the work, not measured after it.
 *
 * This is not a duplicate of `MAX_HTML_CHARS`, and the difference is the whole
 * point. Sanitizing is what *discards* the expensive input: a `<style>` block of
 * declarations the property allowlist refuses costs a CSS parse per match and
 * comes back as the empty string, so an output-shaped budget watches a counter
 * sit near zero while the thread is gone. Measured: 100 matches of an 89 KB
 * droppable stylesheet produced 8 characters each and blocked the main thread for
 * 8.5 seconds with `produced` at 800 of 100,000.
 *
 * So each match is charged for the template it is about to parse and again for the
 * string it is about to hand the sanitizer, before either happens. The second
 * charge is what catches the reverse shape too — a one-line template whose
 * `{{#each}}` fans out to a hundred kilobytes.
 *
 * The number is the same 100,000 as its neighbours (this, the intermediate cap in
 * `cbs.ts`, and the output cap above), which keeps all three holdable in one
 * thought. It is also roughly the 50ms matching deadline below expressed in
 * characters: the costliest content measured here runs at about half a microsecond
 * per charged character.
 */
export const MAX_RENDER_INPUT_CHARS = 100_000;
/**
 * Wall clock the matching half may spend, checked between matches.
 *
 * This is the cooperative half of the bound, and it holds for everything except a
 * single `exec` that never returns. The hard half is `lib/displayPlanner.ts`,
 * which runs the matching in a worker and terminates it — so this deadline is what
 * keeps an *honest* transform from being slow, and termination is what keeps a
 * dishonest one from being fatal.
 */
const TRANSFORM_DEADLINE_MS = 50;

/**
 * The caps the matching half carries, passed in rather than closed over: that
 * function is stringified into a worker, so it can reach nothing but its arguments.
 */
export interface PlanLimits {
  scanned: number;
  matches: number;
  segments: number;
  pieces: number;
  working: number;
  deadlineMs: number;
}

export const PLAN_LIMITS: PlanLimits = {
  scanned: MAX_SCANNED_CHARS,
  matches: MAX_MATCHES_PER_SCRIPT,
  segments: MAX_SEGMENTS,
  pieces: MAX_PLAN_PIECES,
  working: MAX_WORKING_CHARS,
  deadlineMs: TRANSFORM_DEADLINE_MS,
};

/* ----------------------------------------------------------------- the plan */

/**
 * One run of the message as the scripts have rewritten it so far, and whose
 * words they are.
 *
 *   - `text`: the model's, never taken into a template — drawn as prose.
 *   - `capture`: the model's, taken into a template through `$1`, `$&` or
 *     `$<name>` — drawn inside that template's markup, escaped.
 *   - `out`: the creator's own template text — the only thing ever read as markup
 *     or as CBS.
 *
 * Where a word came from follows it through every later script. A pattern may
 * match across all three kinds and a template may move any of them, but a
 * capture is never promoted to `out`: nothing the model wrote becomes markup by
 * being matched twice.
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

/** Where every island goes, before any of them has been rendered. */
export interface DisplayPlan {
  /** `move_top` matches, and the carry-over `repeat_back` reuses — one island each. */
  top: PlanPiece[][];
  body: PlanPiece[];
  /** `move_bottom` matches, one island each. */
  bottom: PlanPiece[][];
}

/**
 * Runs every enabled script over the message and answers with what it became —
 * plain data, nothing evaluated. Returns null when the message should be left as
 * prose: no scripts, too long to scan, or a blown cap.
 *
 * The scripts **chain**, as RisuAI's and SillyTavern's do: each runs over what
 * the ones before it wrote, so a card can turn `<img src="x">` into markup in one
 * script and wrap the whole panel around it in the next. What keeps that safe is
 * that the text is never one string to a renderer — it is pieces that remember
 * who wrote them (`PlanPiece`), and the renderer reads only the creator's pieces
 * as template.
 *
 * **Self-contained by contract.** `lib/displayPlanner.ts` stringifies this function
 * into a worker, so it may not reference a single thing outside itself: no imports,
 * no module constants, no helpers from this file. The limits and the clock arrive
 * as arguments for that reason.
 */
export function planDisplayScripts(
  content: string,
  scripts: readonly DisplayScript[],
  previousSameRole: string,
  limits: PlanLimits,
  now: () => number,
): DisplayPlan | null {
  const ordered: { index: number; script: DisplayScript }[] = [];
  for (let i = 0; i < scripts.length; i += 1) {
    const script = scripts[i]!;
    if (script.enabled && script.in) ordered.push({ index: i, script });
  }
  // A tie runs in list order, which is also how a card's export writes it out.
  ordered.sort((a, b) => a.script.order - b.script.order || a.index - b.index);
  if (ordered.length === 0) return null;
  // Scanning a wall of text with a creator's regex is the expensive case, and a
  // message this long is prose rather than a status block.
  if (content.length > limits.scanned) return null;

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
   */
  function compile(script: DisplayScript): RegExp | null {
    let flags = script.flags ?? '';
    if (!flags.includes('g')) flags += 'g';
    if (!flags.includes('d')) flags += 'd';
    try {
      return new RegExp(script.in, flags);
    } catch {
      return null;
    }
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
  let size = content.length;
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

  /* -- islands: which drawn block each piece belongs to */

  const parent: number[] = [0];
  const fresh = (): number => {
    parent.push(parent.length);
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
        : { kind: 'text', text: piece.text, island: 0 },
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

  const total = (pieces: Piece[]): number => pieces.reduce((sum, piece) => sum + piece.text.length, 0);

  const deadline = now() + limits.deadlineMs;
  const top: Piece[][] = [];
  const bottom: Piece[][] = [];
  let body: Piece[] = content ? [{ kind: 'text', text: content, island: 0 }] : [];

  try {
    for (const entry of ordered) {
      const pattern = compile(entry.script);
      if (!pattern) continue;
      const unicode = pattern.flags.includes('u') || pattern.flags.includes('v');
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
        const expansion = expand(entry.script.out, match, view, joins);
        if (entry.script.action === 'move_top') top.push(expansion);
        else if (entry.script.action === 'move_bottom') bottom.push(expansion);
        else next.push(...expansion);
        cursor = end;
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
        const again = compile(entry.script);
        const previous = again ? (again.exec(previousSameRole) as Match | null) : null;
        if (previous) {
          const carried = layout([{ kind: 'text', text: previousSameRole, island: 0 }]);
          top.push(expand(entry.script.out, previous, carried, [0, 0]));
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
  } catch (error) {
    if (error === OVER) return null;
    throw error;
  }

  return {
    top: top.map(merge),
    body: merge(body),
    bottom: bottom.map(merge),
  };
}

/* ------------------------------------------------------------- the rewriting */

/**
 * Captured text comes from the model, so it is neutralized twice over: HTML-escaped
 * so it cannot introduce markup, and brace-escaped so it cannot introduce a macro
 * the creator did not write. It is then marked, for the same reason `{{getvar}}` is
 * — a capture is model output, and a link built out of one is the model's link.
 * Its `{{setvar}}`s are protocol, hidden here as they are in prose.
 */
const escapeCapture = (text: string): string =>
  taint(escapeHtml(stripVariableMacros(text)).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;'));

/**
 * Turns a plan into the segments to draw, with the bindings as they are *now* —
 * which is why this is not part of the plan and does not go near a worker. Returns
 * null when the message should be left as prose.
 *
 * An island's template is its pieces put back together: the creator's own text as
 * it was written, and the model's words escaped (`escapeCapture`). Only then is it
 * read as CBS — so a block one script opened and another closed parses as one, and
 * nothing the model wrote can be part of the syntax.
 *
 * Two budgets, and they bound different things. `MAX_RENDER_INPUT_CHARS` is what an
 * island is allowed to *cost*, charged before the work; `MAX_HTML_CHARS` is what all
 * of them together are allowed to put on the page. Only the first of them can see
 * work that produces nothing.
 *
 * One allowance runs through all of it — reassembly, the template engine, and the
 * sanitizer — because every one of those stages can be made to do a great deal and
 * hand back very little, and a stage that keeps its own books can always be asked
 * to open them again for the next island.
 */
export function renderDisplayPlan(plan: DisplayPlan, ctx: DisplayContext): Segment[] | null {
  let taken = 0;
  let produced = 0;

  /** Pay first. A stage that has not been paid for does not run. */
  const charge = (chars: number): void => {
    taken += chars;
    if (taken > MAX_RENDER_INPUT_CHARS) throw new RenderBudgetExhausted('input');
  };

  const island = (pieces: readonly PlanPiece[]): Segment => {
    let template = '';
    for (const piece of pieces) {
      // Charged raw, before escaping or stripping allocates anything.
      charge(piece.text.length);
      // Stripped so that the only markers in the string handed to the sanitizer are
      // the ones this render put there — a creator who typed a U+0001 does not get
      // to say a link is trustworthy.
      template += piece.kind === 'out' ? stripTaint(piece.text) : escapeCapture(piece.text);
    }
    // The engine charges the same allowance for every variable it reads, before it
    // expands one, and throws rather than returning a small answer when it runs out.
    const rendered = renderTemplate(template, ctx, charge);
    // …and again before the sanitizer, which is both the expensive stage and the
    // one that throws the input away.
    charge(rendered.length);
    const html = sanitizeCustomHtml(rendered);
    produced += html.length;
    if (produced > MAX_HTML_CHARS) throw new RenderBudgetExhausted('html');
    return { kind: 'html', html };
  };

  try {
    const segments: Segment[] = plan.top.map(island);
    let block: PlanPiece[] = [];
    const close = (): void => {
      if (block.length > 0) segments.push(island(block));
      block = [];
    };
    for (const piece of plan.body) {
      if (piece.island === 0) {
        close();
        segments.push({ kind: 'text', text: piece.text });
      } else {
        if (block.length > 0 && block[0]!.island !== piece.island) close();
        block.push(piece);
      }
    }
    close();
    segments.push(...plan.bottom.map(island));
    return segments;
  } catch (error) {
    // Anything at all — a blown cap, a template that threw — leaves the message
    // exactly as the model wrote it. Half a status window is worse than none.
    if (!(error instanceof RenderBudgetExhausted)) console.error('[display] transform failed', error);
    return null;
  }
}

/**
 * Both halves in one call, on this thread.
 *
 * This is what the transform *means*, and what the tests exercise; it is not how
 * the chat runs it. `MessageBody` plans in a worker and renders here, because the
 * planning half is the half a creator's pattern can hang. Anything that calls this
 * accepts that a pathological pattern stops the caller.
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
    plan = planDisplayScripts(content, ctx.scripts, previousSameRole, PLAN_LIMITS, now);
  } catch (error) {
    console.error('[display] transform failed', error);
    return plain;
  }
  if (!plan) return plain;
  return renderDisplayPlan(plan, ctx) ?? plain;
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
