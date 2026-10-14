/**
 * The display worker's side of `lib/displayPlanner.ts`: the bindings it is sent
 * once per context, and a transform (`transformDisplay`) per message asked for.
 * What the display worker (`displayPlannerWorker.ts`) serves, and what a test
 * hosts on a thread of its own.
 *
 * A context crosses as data, since a function cannot: the asset resolver is
 * built again here from the names it was built from (`namedAssets`), and the
 * variable maps are read back as the maps they were.
 */

import { assetResolver } from '@shizue/core/cbs';
import { applyVariableDelta } from '@shizue/core/variables';
import type { CbsContext } from './cbs';
import { PLAN_LIMITS, transformDisplay, type DisplayPlan } from './displayScripts';
import type { DisplayScript } from './types';

/**
 * How many contexts each side keeps. The page sends one before the first plan
 * that reads it and counts what it sent the same way the worker counts what it
 * keeps (`createDisplayPlanner`), so the two agree on which are held without a
 * word about it.
 */
export const KEPT_CONTEXTS = 16;

/** The bindings a context carries across: a `CbsContext` with no function in it. */
export type PlanBindings = Omit<CbsContext, 'resolveAsset' | 'chatIndex'>;

/** What the page sends. */
export type PlanMessage =
  | { type: 'context'; id: number; bindings: PlanBindings; scripts: readonly DisplayScript[] }
  | {
      type: 'plan';
      id: number;
      context: number;
      content: string;
      previousSameRole: string;
      chatIndex?: number;
      background?: boolean;
    };

/** What the worker answers: a plan, or null for prose — `missing` when it no longer held the context. */
export type PlanAnswer = { type: 'ready' } | { type: 'plan'; id: number; plan: DisplayPlan | null; missing?: boolean };

/** The little of a worker's global this uses. */
export interface PlanWorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (message: PlanAnswer) => void;
}

/** A context as it arrived, made whole again. */
function revive(bindings: PlanBindings): CbsContext {
  return {
    ...bindings,
    // A map that crossed a thread has lost its null prototype; read it as the map it was.
    variables: applyVariableDelta(bindings.variables, null),
    ...(bindings.globalVariables ? { globalVariables: applyVariableDelta(bindings.globalVariables, null) } : {}),
    ...(bindings.namedAssets ? { resolveAsset: assetResolver(bindings.namedAssets) } : {}),
  };
}

export function serveDisplayPlans(scope: PlanWorkerScope): void {
  const contexts = new Map<number, { ctx: CbsContext; scripts: readonly DisplayScript[] }>();
  scope.onmessage = (event) => {
    const data = event.data as PlanMessage | null;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'context') {
      contexts.delete(data.id);
      contexts.set(data.id, { ctx: revive(data.bindings), scripts: data.scripts ?? [] });
      if (contexts.size > KEPT_CONTEXTS) contexts.delete(contexts.keys().next().value!);
      return;
    }
    if (data.type !== 'plan') return;
    const context = contexts.get(data.context);
    if (!context) {
      scope.postMessage({ type: 'plan', id: data.id, plan: null, missing: true });
      return;
    }
    let plan: DisplayPlan | null = null;
    try {
      plan = transformDisplay(
        {
          content: String(data.content),
          scripts: context.scripts,
          previousSameRole: String(data.previousSameRole || ''),
          ...(data.background ? { background: true } : {}),
        },
        data.chatIndex === undefined ? context.ctx : { ...context.ctx, chatIndex: data.chatIndex },
        PLAN_LIMITS,
        Date.now,
      );
    } catch {
      // A pattern or a template that threw leaves the message as prose, like a blown cap.
      plan = null;
    }
    scope.postMessage({ type: 'plan', id: data.id, plan });
  };
  scope.postMessage({ type: 'ready' });
}
