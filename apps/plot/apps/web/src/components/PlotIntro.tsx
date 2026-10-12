'use client';

import { useTranslations } from 'next-intl';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import { markupChunks, markupRemarkPlugins } from '@/lib/markdown/html';
import { isExternalUrl, isSameOriginUrl } from '@/lib/sanitizeHtml';
import { HtmlBlock, useHydrated } from './HtmlBlock';
import { cx } from './ui';

/**
 * A picture only from our own origin, the rule a message's are held to: an
 * imported card's notes point wherever its author hosted them, and the page
 * would otherwise fetch from there for every reader who opens it. Judging the
 * origin takes a `location`, which the server has not got, so the picture waits
 * for hydration rather than disagree with it.
 */
function IntroImage({ src, alt }: { src?: string | Blob | undefined; alt?: string | undefined }) {
  const hydrated = useHydrated();
  if (!hydrated || typeof src !== 'string' || !isSameOriginUrl(src)) return null;
  return <img src={src} alt={alt ?? ''} className="my-2 inline-block max-w-full rounded-xl" />;
}

/**
 * A link leaves the page rather than the reader's place on it, by the rule the
 * HTML in the intro is held to: an http(s) address or nothing but its label.
 */
const components: Components = {
  a: ({ node: _node, href, children }) =>
    href && isExternalUrl(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: ({ node: _node, src, alt }) => <IntroImage src={src} alt={alt} />,
};

/**
 * The creator's line to readers, as markdown — RisuAI renders the creator notes
 * an imported intro comes from the same way, HTML and all. A block holding HTML
 * is drawn as the message body draws one (`lib/markdown/html`): sanitized, in
 * the message scope, once the page has hydrated. A long intro is folded, so the
 * cast and the openings below it stay within reach, and opens on request.
 */
export function PlotIntro({ text }: { text: string }) {
  const t = useTranslations('public');
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const hydrated = useHydrated();
  const chunks = useMemo(() => markupChunks(text), [text]);

  // Measured only while folded: open, the box is as tall as its text, and the
  // button that folds it again has to stay. Hydration is a change of content
  // too — the markup arrives with it — and a box already at its folded height
  // would not report it as a resize.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || expanded) return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded, hydrated]);

  const folded = overflows && !expanded;
  return (
    <div data-testid="plot-intro">
      <div
        ref={ref}
        className={cx(
          'intro-body text-sm leading-relaxed text-fg [overflow-wrap:anywhere]',
          !expanded && 'max-h-36 overflow-hidden',
          folded && '[mask-image:linear-gradient(to_bottom,black_60%,transparent)]',
        )}
      >
        {chunks.map((chunk, index) =>
          chunk.html ? (
            <HtmlBlock key={index} content={chunk.text} />
          ) : (
            <Markdown
              key={index}
              remarkPlugins={markupRemarkPlugins}
              components={components}
              skipHtml
            >
              {chunk.text}
            </Markdown>
          ),
        )}
      </div>
      {overflows ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs font-medium text-link underline underline-offset-2"
        >
          {expanded ? t('introLess') : t('introMore')}
        </button>
      ) : null}
    </div>
  );
}
