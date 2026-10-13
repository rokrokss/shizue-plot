'use client';

import { memo, useMemo } from 'react';
import { RenderBudgetExhausted, renderTemplate, type CbsContext } from '@/lib/cbs';
import { MAX_HTML_CHARS, MAX_RENDER_INPUT_CHARS } from '@/lib/displayScripts';
import { MESSAGE_SCOPE_CLASS, sanitizeCustomHtml } from '@/lib/sanitizeHtml';
import { useHydrated } from './HtmlBlock';

/**
 * A RisuAI card's `backgroundHTML` as markup for the page, or '' when there is
 * nothing to draw. RisuAI reads it as CBS against the chat (`risuChatParser`) and
 * puts the result through DOMPurify without rendering markdown; here it is the
 * creator's template a display script's output is, through the same engine
 * (`renderTemplate`, `{{bg::…}}` drawing its picture) and the same trust boundary
 * (`sanitizeCustomHtml`): its `<style>` scoped to the message wrapper, no script,
 * no handler, no foreign resource. One allowance pays for both, as an island's
 * does; a template that runs it out, or one the parser refuses, draws nothing
 * rather than its source.
 */
export function renderBackground(html: string, ctx: CbsContext): string {
  let taken = 0;
  const charge = (chars: number): void => {
    taken += chars;
    if (taken > MAX_RENDER_INPUT_CHARS) throw new RenderBudgetExhausted('input');
  };
  try {
    charge(html.length);
    const rendered = renderTemplate(html, { ...ctx, background: true }, charge, () => '');
    charge(rendered.length);
    const markup = sanitizeCustomHtml(rendered);
    return markup.length > MAX_HTML_CHARS ? '' : markup;
  } catch (error) {
    if (!(error instanceof RenderBudgetExhausted)) console.error('[background] render failed', error);
    return '';
  }
}

/**
 * What RisuAI's `BackgroundDom` puts behind the chat screen: the card's
 * background HTML — or what its scripts set in this chat — filling the
 * conversation's area under the messages. It is scenery: it scrolls with nothing,
 * takes no pointer and is hidden from assistive technology. Inside the message
 * wrapper, whose paint containment is its cage, so nothing in it reaches past
 * the conversation; colours are the creator's, as in a display script.
 */
export const ChatBackground = memo(function ChatBackground({ html, context }: { html: string; context: CbsContext }) {
  const hydrated = useHydrated();
  const markup = useMemo(() => (hydrated && html ? renderBackground(html, context) : ''), [hydrated, html, context]);
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
