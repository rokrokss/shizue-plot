'use client';

import { memo, useMemo, useSyncExternalStore } from 'react';
import { balancePartial } from '@/lib/markdown/balance';
import { renderMarkup } from '@/lib/markdown/html';
import { MESSAGE_SCOPE_CLASS } from '@/lib/sanitizeHtml';

const subscribeNothing = () => () => undefined;

/**
 * False on the server and through hydration, true from then on — and true from
 * the first render for anything mounted after that.
 *
 * Sanitizing needs a DOM, and the server has none: what it renders and what
 * hydration first renders have to agree, so both leave the markup out, and the
 * render after hydration puts it in. A message that arrives later, which is
 * every message in a chat, is drawn whole in its first render.
 */
export const useHydrated = (): boolean =>
  useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );

/**
 * A stretch of a message or intro that holds HTML of its own, drawn as RisuAI
 * draws it: markdown with HTML enabled, then the trust boundary — the same one
 * a display script's output passes — inside the message scope, so a `<style>`
 * in it is scoped like a display script's.
 *
 * `live` is the block still being written. It is balanced like a prose block,
 * and an element the model has opened and not yet closed is closed by the
 * sanitizer's parse, so the box is on screen while its contents arrive. There is
 * no word reveal here; the markup is drawn as written.
 */
export const HtmlBlock = memo(function HtmlBlock({
  content,
  live = false,
}: {
  content: string;
  live?: boolean;
}) {
  const hydrated = useHydrated();
  const html = useMemo(
    () => (hydrated ? renderMarkup(live ? balancePartial(content) : content) : ''),
    [hydrated, content, live],
  );
  return (
    <div
      // `message-html` gives the paragraphs markdown leaves between the tags the
      // body's spacing; a display-script island lays itself out.
      className={`${MESSAGE_SCOPE_CLASS} message-html`}
      // Sanitized by lib/sanitizeHtml — the only place markup is trusted.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
