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

import type { Variables } from '@shizue/core/variables';
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
  deadlineMs: number;
}

export const PLAN_LIMITS: PlanLimits = {
  scanned: MAX_SCANNED_CHARS,
  matches: MAX_MATCHES_PER_SCRIPT,
  segments: MAX_SEGMENTS,
  deadlineMs: TRANSFORM_DEADLINE_MS,
};

/* ----------------------------------------------------------------- the plan */

/**
 * One match, as data. Everything a template binding needs and nothing that only
 * exists in the realm the match was made in — so a plan survives `postMessage`.
 */
export interface PlanMatch {
  /** Index into the script array the plan was made from. */
  script: number;
  /** `match[0]` first, then each group; a group that did not participate is null. */
  captures: (string | null)[];
  /** Named groups, if the pattern had any. */
  groups: Record<string, string>;
}

export type PlanSegment = { kind: 'text'; text: string } | { kind: 'match'; match: PlanMatch };

/** Where every island goes, before any of them has been rendered. */
export interface DisplayPlan {
  /** `move_top`, and the carry-over `repeat_back` reuses from the previous turn. */
  top: PlanMatch[];
  body: PlanSegment[];
  bottom: PlanMatch[];
}

/**
 * Runs every enabled script over the message and answers with where the matches
 * are. Returns null when the message should be left as prose — no scripts, too
 * long to scan, or a blown cap.
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
  ordered.sort((a, b) => a.script.order - b.script.order);
  if (ordered.length === 0) return null;
  // Scanning a wall of text with a creator's regex is the expensive case, and a
  // message this long is prose rather than a status block.
  if (content.length > limits.scanned) return null;

  /** An invalid regex disables its script, silently. */
  function compile(script: DisplayScript): RegExp | null {
    const flags = script.flags ?? '';
    try {
      return new RegExp(script.in, flags.includes('g') ? flags : `${flags}g`);
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

  function planned(index: number, match: RegExpExecArray): PlanMatch {
    const captures: (string | null)[] = [];
    for (let i = 0; i < match.length; i += 1) {
      captures.push(match[i] === undefined ? null : match[i]!);
    }
    const groups: Record<string, string> = {};
    if (match.groups) {
      for (const key of Object.keys(match.groups)) groups[key] = match.groups[key] ?? '';
    }
    return { script: index, captures, groups };
  }

  const deadline = now() + limits.deadlineMs;
  const top: PlanMatch[] = [];
  const bottom: PlanMatch[] = [];
  let segments: PlanSegment[] = [{ kind: 'text', text: content }];

  for (const entry of ordered) {
    const pattern = compile(entry.script);
    if (!pattern) continue;
    const unicode = pattern.flags.includes('u') || pattern.flags.includes('v');
    // A script's own match count starts over; the clock and the pieces do not.
    let matches = 0;
    let matched = false;
    const next: PlanSegment[] = [];

    for (const segment of segments) {
      // An earlier script's output is finished markup; a later script must not
      // re-match inside it.
      if (segment.kind !== 'text') {
        next.push(segment);
        continue;
      }
      let cursor = 0;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(segment.text); match; match = pattern.exec(segment.text)) {
        matched = true;
        matches += 1;
        if (matches > limits.matches) return null;
        if (now() > deadline) return null;
        if (match.index > cursor) {
          next.push({ kind: 'text', text: segment.text.slice(cursor, match.index) });
        }
        const one = planned(entry.index, match);
        if (entry.script.action === 'move_top') top.push(one);
        else if (entry.script.action === 'move_bottom') bottom.push(one);
        else next.push({ kind: 'match', match: one });
        if (top.length + next.length + bottom.length > limits.segments) return null;
        cursor = match.index + match[0].length;
        if (match[0].length === 0) {
          pattern.lastIndex = advance(segment.text, pattern.lastIndex, unicode);
        }
      }
      if (cursor < segment.text.length) {
        next.push({ kind: 'text', text: segment.text.slice(cursor) });
      }
    }
    segments = next;
    if (top.length + segments.length + bottom.length > limits.segments) return null;

    // The status-window idiom: a turn that says nothing about the state keeps
    // showing the last state that was reported, pinned above the prose.
    if (!matched && entry.script.action === 'repeat_back' && previousSameRole) {
      const again = compile(entry.script);
      const previous = again ? again.exec(previousSameRole) : null;
      if (previous) top.push(planned(entry.index, previous));
    }
  }

  return { top, body: segments, bottom };
}

/* ------------------------------------------------------------- the rewriting */

/** `$1`..`$9`, `$&` and `$<name>` — what an OUT template binds a match with. */
const CAPTURE_RE = /\$(?:(&)|(\d)|<([A-Za-z_][A-Za-z0-9_]*)>)/g;

/**
 * Captured text comes from the model, so it is neutralized twice over: HTML-escaped
 * so it cannot introduce markup, and brace-escaped so it cannot introduce a macro
 * the creator did not write. It is then marked, for the same reason `{{getvar}}` is
 * — a capture is model output, and a link built out of one is the model's link.
 */
const escapeCapture = (text: string): string =>
  taint(escapeHtml(text).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;'));

/**
 * Substitutes the captures a template asks for, charging each one *as it goes*.
 *
 * The length of the finished string is no use here, because building it is the
 * expensive part: a template within the budget can hold fifty thousand `$1`s, and
 * a match can be twenty thousand characters, so measuring afterwards means
 * measuring a billion characters that have already been built. `replace` stops
 * where the exception is thrown, so what gets built is what was paid for.
 */
function bindCaptures(template: string, match: PlanMatch, charge: (chars: number) => void): string {
  const substitute = (value: string): string => {
    // Charged raw, before escaping allocates anything.
    charge(value.length);
    return escapeCapture(value);
  };
  return template.replace(CAPTURE_RE, (whole, all?: string, index?: string, name?: string) => {
    if (all) return substitute(match.captures[0] ?? '');
    // Own-property only: a named group called `toString` must not resolve to one.
    if (name) {
      return substitute(
        Object.prototype.hasOwnProperty.call(match.groups, name) ? (match.groups[name] ?? '') : '',
      );
    }
    const value = match.captures[Number(index)];
    // An unused group number stays literal, so a `$` in the template survives.
    return value === undefined || value === null ? whole : substitute(value);
  });
}

/**
 * Turns a plan into the segments to draw, with the bindings as they are *now* —
 * which is why this is not part of the plan and does not go near a worker. Returns
 * null when the message should be left as prose.
 *
 * Two budgets, and they bound different things. `MAX_RENDER_INPUT_CHARS` is what a
 * match is allowed to *cost*, charged before the work; `MAX_HTML_CHARS` is what all
 * the matches together are allowed to put on the page. Only the first of them can
 * see work that produces nothing.
 *
 * One allowance runs through all of it — capture binding, the template engine, and
 * the sanitizer — because every one of those stages can be made to do a great deal
 * and hand back very little, and a stage that keeps its own books can always be
 * asked to open them again for the next match.
 */
export function renderDisplayPlan(plan: DisplayPlan, ctx: DisplayContext): Segment[] | null {
  let taken = 0;
  let produced = 0;

  /** Pay first. A stage that has not been paid for does not run. */
  const charge = (chars: number): void => {
    taken += chars;
    if (taken > MAX_RENDER_INPUT_CHARS) throw new RenderBudgetExhausted('input');
  };

  const render = (match: PlanMatch): Segment => {
    const script = ctx.scripts[match.script];
    if (!script) throw new Error('plan refers to a script that is not there');
    // Charged before anything reads the template — including the strip below,
    // which is itself a pass over it — so a hundred matches of a large template
    // cannot get a hundred passes for free. Nothing on the way in bounds how long
    // an `out` is.
    charge(script.out.length);
    // Stripped so that the only markers in the string handed to the sanitizer are
    // the ones this render put there — a creator who typed a U+0001 does not get
    // to say a link is trustworthy.
    const template = stripTaint(script.out);
    // The engine charges the same allowance for every variable it reads, before it
    // expands one, and throws rather than returning a small answer when it runs out.
    const rendered = renderTemplate(bindCaptures(template, match, charge), ctx, charge);
    // …and again before the sanitizer, which is both the expensive stage and the
    // one that throws the input away.
    charge(rendered.length);
    const html = sanitizeCustomHtml(rendered);
    produced += html.length;
    if (produced > MAX_HTML_CHARS) throw new RenderBudgetExhausted('html');
    return { kind: 'html', html };
  };

  try {
    return [
      ...plan.top.map(render),
      ...plan.body.map((segment) => (segment.kind === 'text' ? segment : render(segment.match))),
      ...plan.bottom.map(render),
    ];
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
