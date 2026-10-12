'use client';

import { useTranslations } from 'next-intl';
import { useLayoutEffect, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { cx } from './ui';

const remarkPlugins = [remarkGfm, remarkBreaks];

/**
 * A link leaves the page rather than the reader's place on it. A picture is not
 * drawn: an imported card's notes point wherever its author hosted them, and the
 * page would otherwise fetch from there for every reader who opens it.
 */
const components: Components = {
  a: ({ node: _node, href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: () => null,
};

/**
 * The creator's line to readers, as markdown — RisuAI renders the creator notes
 * an imported intro comes from the same way. Raw HTML is left out rather than
 * shown as tags. A long intro is folded, so the cast and the openings below it
 * stay within reach, and opens on request.
 */
export function PlotIntro({ text }: { text: string }) {
  const t = useTranslations('public');
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Measured only while folded: open, the box is as tall as its text, and the
  // button that folds it again has to stay.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || expanded) return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);

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
        <Markdown remarkPlugins={remarkPlugins} components={components} skipHtml>
          {text}
        </Markdown>
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
