'use client';

import { memo, useEffect, useMemo, useState } from 'react';
import { RenderBudgetExhausted, renderTemplate, type CbsContext } from '@/lib/cbs';
import { displayPlanner, type PlanRequest } from '@/lib/displayPlanner';
import { type DisplayPlan } from '@/lib/displayScripts';
import { MESSAGE_SCOPE_CLASS, sanitizeCustomHtml } from '@/lib/sanitizeHtml';
import { stripTaint } from '@/lib/taint';
import { MAX_BACKGROUND_RENDER_CHARS, type DisplayScript } from '@/lib/types';
import { useHydrated } from './HtmlBlock';

/**
 * The background as its display pass made it, one piece of markup again: what
 * `move_top` lifted, the rest, what `move_bottom` lifted, a line apart, as
 * RisuAI joins a moved match to the text.
 */
function scriptedMarkup(plan: DisplayPlan): string {
  const body = plan.body.map((segment) => (segment.kind === 'html' ? segment.html : segment.text)).join('');
  return [...plan.top, body, ...plan.bottom].join('\n');
}

export { MAX_BACKGROUND_RENDER_CHARS };

/**
 * A RisuAI card's `backgroundHTML` as markup for the page, or '' when there is
 * nothing to draw. RisuAI draws it as `ParseMarkdown(…, 'back')`: CBS against the
 * chat, the character's `editdisplay` scripts — each one's output read as CBS
 * again — then DOMPurify, no markdown. With scripts, all of that but the last is
 * the display pass's (`plan`, `transformDisplay`), in the planner's worker; with
 * none, it is one read of the creator's template here, through the same engine
 * (`renderTemplate`, `{{bg::…}}` drawing its picture). Either way it ends at the
 * same trust boundary (`sanitizeCustomHtml`): its `<style>` scoped to the message
 * wrapper, no script, no handler, no foreign resource. A template that runs out
 * its allowance, or one the parser refuses, draws nothing rather than its source.
 */
export function renderBackground(html: string, ctx: CbsContext, plan: DisplayPlan | null = null): string {
  let taken = 0;
  const charge = (chars: number): void => {
    taken += chars;
    if (taken > MAX_BACKGROUND_RENDER_CHARS) throw new RenderBudgetExhausted('input');
  };
  try {
    let rendered: string;
    if (plan) {
      rendered = scriptedMarkup(plan);
    } else {
      // The creator's text, so the only markers the sanitizer sees are the engine's.
      const source = stripTaint(html);
      charge(source.length);
      rendered = renderTemplate(source, { ...ctx, background: true }, charge, () => '');
    }
    charge(rendered.length);
    const markup = sanitizeCustomHtml(rendered);
    return markup.length > MAX_BACKGROUND_RENDER_CHARS ? '' : markup;
  } catch (error) {
    if (!(error instanceof RenderBudgetExhausted)) console.error('[background] render failed', error);
    return '';
  }
}

/**
 * The background and the plan to draw it with, asked of the planner the messages
 * use — its worker, its kept answers. RisuAI runs the `editdisplay` scripts over
 * the background as it runs them over a message, with no message index (-1): so
 * `repeat_back` has nothing to repeat (no previous message), and the moves move.
 *
 * The plan reads the bindings, as a message's does, so a variable that moves asks
 * again. The background is scenery behind the conversation and has no prose to
 * fall back to: until an answer is in hand it draws the last one it had — with
 * the bindings as they were, or the background before the scripts changed it —
 * or, the first time, nothing. The planner answers every request, hung or not,
 * within its deadline. Null while there is nothing to draw yet.
 */
function useBackgroundPlan(
  html: string,
  scripts: readonly DisplayScript[] | undefined,
  context: CbsContext,
): { html: string; plan: DisplayPlan | null } | null {
  const request = useMemo<PlanRequest | null>(
    () =>
      html && scripts && scripts.length > 0
        ? { content: html, scripts, previousSameRole: '', context, background: true }
        : null,
    [html, scripts, context],
  );
  const kept = useMemo(() => (request ? displayPlanner.cached(request) : undefined), [request]);
  const [answered, setAnswered] = useState<{ asked: PlanRequest; plan: DisplayPlan | null } | null>(null);

  useEffect(() => {
    if (!request || kept !== undefined) return;
    const gone = new AbortController();
    void displayPlanner.plan(request, gone.signal).then((plan) => {
      if (!gone.signal.aborted) setAnswered({ asked: request, plan });
    });
    return () => gone.abort();
  }, [request, kept]);

  if (!request) return { html, plan: null };
  if (kept !== undefined) return { html, plan: kept };
  return answered ? { html: answered.asked.content, plan: answered.plan } : null;
}

/**
 * What RisuAI's `BackgroundDom` puts behind the chat screen: the card's
 * background HTML — or what its scripts set in this chat — filling the
 * conversation's area under the messages. It is scenery: it scrolls with nothing,
 * takes no pointer and is hidden from assistive technology. Inside the message
 * wrapper, whose paint containment is its cage, so nothing in it reaches past
 * the conversation; colours are the creator's, as in a display script.
 */
export const ChatBackground = memo(function ChatBackground({
  html,
  context,
  scripts,
}: {
  html: string;
  context: CbsContext;
  /** The plot's display scripts; keep its identity, as `MessageBody`'s. */
  scripts?: readonly DisplayScript[];
}) {
  const hydrated = useHydrated();
  const drawn = useBackgroundPlan(html, scripts, context);
  const source = drawn?.html ?? '';
  const plan = drawn?.plan ?? null;
  const markup = useMemo(
    () => (hydrated && source ? renderBackground(source, context, plan) : ''),
    [hydrated, source, plan, context],
  );
  if (!markup) return null;
  return (
    <div aria-hidden="true" data-testid="chat-background" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className={`${MESSAGE_SCOPE_CLASS} h-full w-full`}
        // Sanitized by lib/sanitizeHtml — the only place markup is trusted.
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    </div>
  );
});
