/**
 * What a card's scripts hand the server, and the reader's global variables.
 *
 * RisuAI cards carry scripts — triggers, Lua, editinput and editoutput regex —
 * that run in the reader's browser, not here. What they decide reaches the server
 * the way a game component's ruling does (`messages.directions`): as a value the
 * browser computed and the server stores. Nothing in it is a privilege the reader
 * did not already have — they can set any variable with a `{{setvar}}` of their
 * own and put any words in the prompt as a direction — so what is checked here is
 * the shape and the size, not where it came from.
 *
 * Three things arrive:
 * - a message's `variableDelta`: the values the scripts left on it, laid over its
 *   own macros wherever the branch is folded (`VariableDelta` in @shizue/core);
 * - the start triggers' writes for a generation that adds no user turn
 *   (`startDelta`), and the prompt text they asked for (`injections`);
 * - whether the browser will run output scripts over the reply (`postProcess`),
 *   which leaves the reply `pending` until it commits the result.
 */
import { applyVariableDelta, checkVariableDelta, type VariableDelta, type Variables } from '@shizue/core';
import { plotReaderVariables } from '@shizue/db';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { ApiError, badRequest } from './errors.js';
import { isUuid, optionalBoolean } from './util.js';

/** Characters one injected block may hold — a system prompt, not a chapter. */
/**
 * A variable map as drizzle can store it. Core builds its maps without a
 * prototype — the names come from cards and model output, so `__proto__` is a
 * real name — and drizzle's value check reads `.constructor` off whatever it is
 * handed, which a prototype-less object has none of. Spreading copies the names
 * as own properties of a plain object, so a `__proto__` name stays a name.
 */
export const storableVariables = <T extends object>(map: T): T => ({ ...map });

/** The same for a delta that may be absent (null clears the column). */
export const storableDelta = (delta: VariableDelta | null): VariableDelta | null =>
  delta && storableVariables(delta);

export const MAX_INJECTION_LENGTH = 20_000;

/**
 * Where a start trigger asked its text to go, RisuAI's three places: just before
 * the last turn of the history, just after it, and at the very end of the prompt.
 * Never stored — like RisuAI's, they belong to the one request.
 */
export interface PromptInjections {
  start?: string;
  historyend?: string;
  promptend?: string;
}

const INJECTION_PLACES = ['start', 'historyend', 'promptend'] as const;

/**
 * What the browser brings to a generation from the card's scripts. Every field
 * is optional in the body; a request without any of them is a generation as it
 * always was.
 */
export interface GenerationScripts {
  /** What the start triggers changed, over the state of the branch they ran on. */
  startDelta: VariableDelta | null;
  injections: PromptInjections | null;
  /** The browser will run output scripts over the reply, so it is stored pending. */
  postProcess: boolean;
  /**
   * The head the scripts ran on — null for a chat with no message yet — and a
   * request made over another one is refused. Absent is not checked.
   */
  baseHeadId: string | null | undefined;
  /** Generate on over a head still pending, giving up its output scripts. */
  abandonPending: boolean;
}

export const NO_SCRIPTS: GenerationScripts = {
  startDelta: null,
  injections: null,
  postProcess: false,
  baseHeadId: undefined,
  abandonPending: false,
};

/** `body[key]` as a delta, or what is wrong with it. Absent and `null` are no delta. */
export function optionalVariableDelta(body: Record<string, unknown>, key: string): VariableDelta | null {
  const check = checkVariableDelta(body[key]);
  if (!check.ok) throw badRequest('invalid_request', `${key} ${check.error}`);
  return check.delta;
}

function optionalInjections(body: Record<string, unknown>): PromptInjections | null {
  const value = body['injections'];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_request', 'injections must be an object');
  }
  const source = value as Record<string, unknown>;
  const injections: PromptInjections = {};
  for (const place of INJECTION_PLACES) {
    const text = source[place];
    if (text === undefined || text === null) continue;
    if (typeof text !== 'string') throw badRequest('invalid_request', `injections.${place} must be a string`);
    if (text.length > MAX_INJECTION_LENGTH) {
      throw badRequest('invalid_request', `injections.${place} may be at most ${MAX_INJECTION_LENGTH} characters`);
    }
    if (text.trim()) injections[place] = text;
  }
  return Object.keys(injections).length > 0 ? injections : null;
}

/**
 * Reads the script fields of a generation body. `startDelta` is only read where
 * the generation adds no user turn of its own: a send carries the scripts' writes
 * on the user turn instead (`variableDelta`), since that is the message they ran
 * for.
 */
export function readGenerationScripts(
  body: Record<string, unknown>,
  { startDelta }: { startDelta: boolean },
): GenerationScripts {
  const baseHeadId = body['baseHeadId'];
  if (baseHeadId !== undefined && baseHeadId !== null && (typeof baseHeadId !== 'string' || !isUuid(baseHeadId))) {
    throw badRequest('invalid_request', 'baseHeadId must be a message id or null');
  }
  return {
    startDelta: startDelta ? optionalVariableDelta(body, 'startDelta') : null,
    injections: optionalInjections(body),
    postProcess: optionalBoolean(body, 'postProcess') ?? false,
    baseHeadId: baseHeadId as string | null | undefined,
    abandonPending: optionalBoolean(body, 'abandonPending') ?? false,
  };
}

/** What a request made over a head that has since moved is refused with. */
export const headMoved = (): ApiError =>
  new ApiError(409, 'head_moved', 'The chat has moved on from the message the scripts ran on');

/** What a script commit computed on a revision of the turn that is gone is refused with. */
export const scriptRevMoved = (): ApiError =>
  new ApiError(409, 'script_rev_moved', 'The message changed after the scripts read it');

/* ------------------------------------------------------ global variables */

/**
 * One reader's global variables on one plot: how many names, and how many
 * characters in all. Smaller than a message's delta — the whole map rides on
 * every chat state, and none of it is ever evicted.
 */
export const MAX_GLOBAL_VARIABLE_KEYS = 256;
export const MAX_GLOBAL_VARIABLE_CHARS = 256_000;

const GLOBAL_LIMITS = { keys: MAX_GLOBAL_VARIABLE_KEYS, chars: MAX_GLOBAL_VARIABLE_CHARS };

/** The reader's global variables for the plot; empty until something set one. */
export async function loadGlobalVariables(deps: AppDeps, userId: string, plotId: string): Promise<Variables> {
  const [row] = await deps.db
    .select({ variables: plotReaderVariables.variables })
    .from(plotReaderVariables)
    .where(and(eq(plotReaderVariables.userId, userId), eq(plotReaderVariables.plotId, plotId)))
    .limit(1);
  return applyVariableDelta(row?.variables ?? {}, null);
}

/**
 * Merges `patch` into the reader's global variables — a string sets, `null`
 * unsets — and answers with the whole map. The row is created on the first
 * write and locked for the read-merge-write, so two writes at once each land on
 * top of the other rather than one undoing it; the cap is a property of the
 * merged map, checked under that lock.
 */
export async function mergeGlobalVariables(
  deps: AppDeps,
  userId: string,
  plotId: string,
  patch: unknown,
): Promise<Variables> {
  const check = checkVariableDelta(patch, GLOBAL_LIMITS);
  if (!check.ok) throw badRequest('invalid_request', `variables ${check.error}`);
  const delta = check.delta;
  if (!delta) return loadGlobalVariables(deps, userId, plotId);

  return deps.db.transaction(async (tx) => {
    await tx.insert(plotReaderVariables).values({ userId, plotId }).onConflictDoNothing();
    const where = and(eq(plotReaderVariables.userId, userId), eq(plotReaderVariables.plotId, plotId));
    const [row] = await tx
      .select({ variables: plotReaderVariables.variables })
      .from(plotReaderVariables)
      .where(where)
      .for('update');
    const merged = applyVariableDelta(row?.variables ?? {}, delta);
    // The merge, read as a delta from nothing, is held to the same caps.
    if (!checkVariableDelta(merged, GLOBAL_LIMITS).ok) {
      throw badRequest(
        'global_variables_limit',
        `Global variables may hold at most ${MAX_GLOBAL_VARIABLE_KEYS} names and ${MAX_GLOBAL_VARIABLE_CHARS} characters`,
      );
    }
    await tx
      .update(plotReaderVariables)
      .set({ variables: storableVariables(merged), updatedAt: new Date() })
      .where(where);
    return merged;
  });
}
