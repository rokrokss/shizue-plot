'use client';

import { useTranslations } from 'next-intl';
import {
  Children,
  Fragment,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { unescapeCbs } from '@shizue/core/cbs';
import { stripVariableMacros } from '@shizue/core/variables';
import { renderImageTokens, type AssetResolver } from '@/lib/assets';
import {
  escapeComponentCalls,
  splitComponentCalls,
  type BodySegment,
  type ComponentContext,
} from '@/lib/componentCalls';
import { holdsCbs, renderProseButtons } from '@/lib/cbs';
import { displayPlanner, type PlanRequest } from '@/lib/displayPlanner';
import {
  renderDisplayPlan,
  type DisplayContext,
  type DisplayPlan,
  type Segment,
} from '@/lib/displayScripts';
import { splitBlocks } from '@/lib/markdown/blocks';
import {
  markupChunks,
  remarkNoIndentedCode,
  renderImageTokensAsHtml,
  renderIsland,
  renderMediaTokens,
} from '@/lib/markdown/html';
import { rehypeDialogueQuotes } from '@/lib/markdown/quotes';
import { isExternalUrl, isSameOriginUrl, MESSAGE_SCOPE_CLASS } from '@/lib/sanitizeHtml';
import { speakerAliases, speechRuns } from '@/lib/speechRuns';
import { useBodyTranslation, type BodyTranslation } from '@/lib/translation';
import type { PublicMember } from '@/lib/types';
import { Avatar } from './Avatar';
import { ChatImage } from './ChatImage';
import { ComponentFrame } from './ComponentFrame';
import { HtmlBlock } from './HtmlBlock';
import { Icon } from './Icon';
import { cx } from './ui';

const remarkPlugins = [remarkGfm, remarkBreaks, remarkNoIndentedCode];

const rehypePlugins = [rehypeHighlight, rehypeDialogueQuotes];

/** `language-ts hljs` → `ts`. */
const LANGUAGE_RE = /(?:^|\s)language-([\w+#.-]+)/;

/**
 * A fenced block with its language and a copy button.
 *
 * The text is read back off the DOM rather than reassembled from the tree:
 * `rehype-highlight` has already scattered it across a few dozen spans, and the
 * one thing that must be copied exactly is what the reader can see.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const t = useTranslations('chat');
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const first = Children.toArray(children)[0];
  const className = isValidElement<{ className?: string }>(first)
    ? (first.props.className ?? '')
    : '';
  const language = LANGUAGE_RE.exec(className)?.[1];

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{language ?? ''}</span>
        <button
          type="button"
          className="code-block-copy"
          onClick={() => {
            const code = ref.current?.textContent ?? '';
            // No clipboard (insecure origin, or refused): silence beats a
            // button that claims to have copied something.
            void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined);
          }}
        >
          {copied ? t('copied') : t('copyCode')}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

/**
 * Character images never push the layout around: one inside a sentence stays
 * in its bubble, one on a line of its own is drawn in the flow (`RunItems`).
 */
const components: Components = {
  // React's `img` src is `string | Blob` (the experimental srcObject overload).
  // Markdown only ever produces the string form, so the Blob half is narrowed
  // away rather than carried into a component that has no use for it.
  img: ({ node: _node, alt, src }) => {
    const url = typeof src === 'string' ? src : undefined;
    // Markdown lets a model (or a card's lore) write any address as an image, and
    // a foreign one is a beacon to whoever wrote it — the same rule the display
    // scripts' HTML is held to. The plot's own images are always same-origin.
    if (!url || !isSameOriginUrl(url)) return null;
    return <ChatImage src={url} alt={alt ?? ''} />;
  },
  // The rule an `<a>` in a message's HTML is held to (lib/sanitizeHtml), so a
  // link reads the same however it was written: an http(s) address opens in a
  // new tab and cannot reach back into this one; anything else is its label.
  a: ({ node: _node, href, children }) =>
    href && isExternalUrl(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  pre: ({ node: _node, children }) => <CodeBlock>{children}</CodeBlock>,
};

/**
 * One top-level block of markdown, parsed on its own.
 *
 * This is the whole reason the message is split up: a settled block is compared
 * by its string, so the twenty paragraphs already on screen are not re-parsed
 * when the twenty-first gains a word.
 *
 * `live` is a block of the stretch still being written, drawn as Zeta draws it
 * (2026-10-17 owner decision): the text as written, its `*` and all, until the
 * stretch is done and is drawn as markdown at once. One paragraph per block, so
 * the spacing stays where it is when that happens. The `<` and `>` the CBS
 * unescape leaves as entities for the markdown are read back here.
 */
const MarkdownBlock = memo(function MarkdownBlock({
  content,
  live,
}: {
  content: string;
  live: boolean;
}) {
  if (live) {
    const text = content.replace(/\n+$/, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
    return <p className="whitespace-pre-wrap">{text}</p>;
  }
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {content}
    </Markdown>
  );
});

const NO_ASSETS: ReadonlyMap<string, string> = new Map();
/** No roster, so nothing is attributed and the message is drawn as one run. */
const NO_ROSTER: readonly PublicMember[] = [];

/**
 * One run of a text segment, ready to draw: who is speaking, and their text cut
 * into top-level markdown blocks so a settled one is not re-parsed per token.
 */
interface TextRun {
  /** The member speaking; null for the scene's own lines, and for a message never split. */
  name: string | null;
  /** Drawn as 상황묘사 standing outside the dialogue rather than as prose. */
  narration: boolean;
  /**
   * A stretch holding HTML of its own (`lib/markdown/html`): one block, drawn as
   * sanitized markup, unattributed — its `이름:` lines are the markup's text.
   */
  html: boolean;
  blocks: string[];
}

/**
 * How the prose that names no speaker is drawn: a reply's, in a bubble of its
 * own (the row says whose); a narration's, with its ≡ and in muted italics; or
 * as it is, inside a bubble the row draws around it (the reader's turn).
 */
export type BodyMode = 'reply' | 'narration' | 'plain';

/** A line that is nothing but pictures — drawn in the flow, outside any bubble. */
const FIGURE_LINE_RE = /^\s*(?:!\[[^\]\n]*\]\([^)\s]*\)\s*)+$/;
/** `#` or `##` — a scene's title, where the message is a scene's (`sceneHeadings`). */
const HEADING_LINE_RE = /^ {0,3}#{1,2}[ \t]+\S/;
const FENCE_START_RE = /^ {0,3}(?:`{3,}|~{3,})/;

/**
 * One stretch of a run as it is drawn: prose, a picture on a line of its own, a
 * scene title, or markup that only dresses its words (`inlineMarkup`) — a block
 * of the message's own HTML (`markup`, its source) or a display script's island
 * (`island`, already sanitized).
 */
interface RunItem {
  kind: 'prose' | 'figure' | 'heading' | 'markup' | 'island';
  text: string;
  live: boolean;
}

/** The elements that dress words rather than lay out a box — and a `{{button}}` among them. */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'br', 'button', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins',
  'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time',
  'tt', 'u', 'var', 'wbr',
]);
const TAG_NAME_RE = /<\/?([A-Za-z][\w-]*)/g;

/**
 * Whether markup is words in a colour or a weight — a `<span>` around a line,
 * a `<br>` — and so stays in the speaker's bubble. Anything that lays out a box
 * of its own (a status window's `<div>`, a `<table>`, a `<style>`) is the
 * creator's layout, and stands outside it.
 */
function inlineMarkup(markup: string): boolean {
  for (const match of markup.matchAll(TAG_NAME_RE)) {
    if (!INLINE_TAGS.has(match[1]!.toLowerCase())) return false;
  }
  return true;
}

/**
 * A run's blocks, with the lines that stand outside a bubble taken out of them:
 * a picture alone on its line, and — in a narration or an intro — a `#`/`##`
 * title. A fenced block is left whole, and so is everything else: a picture
 * inside a sentence is part of the sentence. All the prose of a run still being
 * written is live, its titles kept in it: none of it is markdown until the run
 * is done.
 */
function runItems(blocks: readonly string[], live: boolean, headings: boolean): RunItem[] {
  const items: RunItem[] = [];
  const titles = headings && !live;
  for (const block of blocks) {
    if (FENCE_START_RE.test(block)) {
      items.push({ kind: 'prose', text: block, live });
      continue;
    }
    let prose = '';
    for (const line of block.match(/[^\n]*\n|[^\n]+/g) ?? []) {
      const kind = FIGURE_LINE_RE.test(line) ? 'figure' : titles && HEADING_LINE_RE.test(line) ? 'heading' : null;
      if (!kind) {
        prose += line;
        continue;
      }
      if (prose.trim()) items.push({ kind: 'prose', text: prose, live });
      prose = '';
      items.push({ kind, text: line, live: false });
    }
    if (prose.trim()) items.push({ kind: 'prose', text: prose, live });
  }
  return items;
}

/**
 * A stretch of prose and pictures with no title in it, in order: consecutive
 * prose in one box — a bubble or a narration — and each picture between them
 * at the width of the flow. Under a bubble, the label at its corner (`trailer`).
 */
function RunItems({
  items,
  box,
  trailer,
}: {
  items: readonly RunItem[];
  box: 'bubble' | 'narration';
  trailer?: ReactNode;
}) {
  const groups: { kind: 'prose' | 'figure'; items: RunItem[] }[] = [];
  for (const item of items) {
    const kind = item.kind === 'figure' ? 'figure' : 'prose';
    const last = groups.at(-1);
    if (kind === 'prose' && last?.kind === 'prose') last.items.push(item);
    else groups.push({ kind, items: [item] });
  }
  return groups.map((group, index) => {
    const blocks = group.items.map((item, nth) =>
      item.kind === 'markup' ? (
        <HtmlBlock key={nth} content={item.text} live={item.live} />
      ) : item.kind === 'island' ? (
        <div
          key={nth}
          className={MESSAGE_SCOPE_CLASS}
          // Sanitized by lib/sanitizeHtml — the only place markup is trusted.
          dangerouslySetInnerHTML={{ __html: item.text }}
        />
      ) : (
        <MarkdownBlock key={nth} content={item.text} live={item.live} />
      ),
    );
    if (group.kind === 'figure') {
      return (
        <div key={index} data-testid="chat-figure" className="chat-figure w-full">
          {blocks}
        </div>
      );
    }
    const end = index === groups.length - 1;
    if (box === 'narration') {
      // The mark once at the block's start, the paragraphs hung past it.
      return (
        <div key={index} className="chat-narration flex w-full gap-2 px-2 py-1 text-muted">
          <Icon name="menu" className="chat-narration-mark mt-0.5 size-4 shrink-0" />
          <div className="chat-narration-text min-w-0 flex-1">{blocks}</div>
        </div>
      );
    }
    const labelled = end && trailer !== undefined;
    // Zeta's width: at most 612px, and never into the 64px kept free opposite the
    // face. Under a label the box that holds both keeps that room, since a share
    // of a content-sized box would only shrink the bubble with it.
    const bubble = (
      <div
        className={cx(
          'chat-bubble w-fit min-w-0 rounded-r-xl rounded-bl-xl bg-bubble px-3 py-2',
          labelled ? 'max-w-full' : 'max-w-[min(100%_-_4rem,612px)]',
        )}
      >
        {blocks}
      </div>
    );
    if (!labelled) return <Fragment key={index}>{bubble}</Fragment>;
    // Content-sized like the bubble, so the label sits at the bubble's own corner.
    return (
      <div key={index} className="flex w-fit max-w-[min(100%_-_4rem,612px)] min-w-0 flex-col items-start">
        {bubble}
        <div className="mt-1 self-end">{trailer}</div>
      </div>
    );
  });
}

/**
 * A run's items, cut at its titles: each title stands alone in the flow, and
 * what is between them is one stretch (`RunItems`).
 */
function atHeadings(items: readonly RunItem[]): ({ heading: RunItem } | { items: RunItem[] })[] {
  const parts: ({ heading: RunItem } | { items: RunItem[] })[] = [];
  for (const item of items) {
    const last = parts.at(-1);
    if (item.kind === 'heading') parts.push({ heading: item });
    else if (last && 'items' in last) last.items.push(item);
    else parts.push({ items: [item] });
  }
  return parts;
}

/** A scene's title (`#`/`##`) in a narration or an intro: Zeta's ≡ and a large bold line. */
function SceneHeading({ text }: { text: string }) {
  return (
    <div data-testid="scene-heading" className="scene-heading flex w-full items-center gap-2">
      <Icon name="menu" className="size-5 shrink-0 text-muted" />
      <MarkdownBlock content={text} live={false} />
    </div>
  );
}

/**
 * Asks the planner what this message's display scripts make of it, and holds the
 * answer.
 *
 * Null means draw it plain, and that covers three different situations on purpose:
 * there is nothing to run (no script, and no CBS of the message's own to read),
 * the message is still streaming, and the plan has not come back yet (or never
 * will, because the pattern hung and the worker was terminated). All three want
 * the same thing on screen — the message as the model wrote it — and none of them
 * wants a blank space while we decide.
 *
 * The planner keeps what it answered: a message drawn again — remounted,
 * scrolled back in, its text back to one it had — takes the kept plan on its
 * first render and never shows as prose. A plan reads the bindings (RisuAI reads
 * each script's output as CBS before the next one matches), so a `{{setvar}}`
 * that moves a gauge asks again; until the answer lands, the message keeps the
 * plan it was showing, made from the same text with the bindings as they were.
 *
 * One exception to "prose while we wait": a page opening cold — a reload, a
 * chat's first open — has no plan back yet and its worker is still starting, so
 * every message would paint as the model wrote it and then rearrange into its
 * status windows a few frames later. A message mounted then is held (`held`):
 * drawn, but hidden, until its own plan lands — however it ends — or
 * `COLD_HOLD_MS` passes. Decided once, at mount: a reply that finishes streaming
 * later, once the planner is warm, settles as it always has.
 */
function useDisplayPlan(
  content: string,
  display: DisplayContext | undefined,
  chatIndex: number | undefined,
  previousSameRole: string,
  streaming: boolean,
): { plan: DisplayPlan | null; held: boolean } {
  const [answered, setAnswered] = useState<{ asked: PlanRequest; plan: DisplayPlan | null } | null>(
    null,
  );
  // A half-streamed status block is not a status block: matching a line the
  // model is still in the middle of writing gets an answer about a state that
  // was never reported. It is worth the wait, and the wait is one turn.
  // With no script, only a message with CBS of its own has a pass to run.
  const request = useMemo<PlanRequest | null>(
    () =>
      display && !streaming && (display.scripts.length > 0 || holdsCbs(content))
        ? {
            content,
            scripts: display.scripts,
            previousSameRole,
            context: display,
            ...(chatIndex !== undefined ? { chatIndex } : {}),
          }
        : null,
    [content, display, chatIndex, previousSameRole, streaming],
  );
  const kept = useMemo(() => (request ? displayPlanner.cached(request) : undefined), [request]);
  const [holding, setHolding] = useState(() => request !== null && kept === undefined && !displayPlanner.warm());

  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setHolding(false), COLD_HOLD_MS);
    return () => clearTimeout(timer);
  }, [holding]);

  useEffect(() => {
    if (!request || kept !== undefined) return;
    const asked = request;
    // A request whose bindings moved on before its turn is not worth the worker's time.
    const gone = new AbortController();
    void displayPlanner.plan(asked, gone.signal).then((plan) => {
      if (gone.signal.aborted) return;
      setAnswered({ asked, plan });
      setHolding(false);
    });
    return () => gone.abort();
  }, [request, kept]);

  if (kept !== undefined) return { plan: kept, held: false };
  // A plan carries the message it was made from, so an edit does not get one
  // render of the text it replaced: until the new plan lands, there is no plan.
  // Bindings that moved are another matter — the plan in hand is the same
  // message's, and it stands until its successor lands.
  if (
    !request ||
    !answered ||
    answered.asked.content !== content ||
    answered.asked.scripts !== request.scripts ||
    answered.asked.previousSameRole !== previousSameRole
  ) {
    return { plan: null, held: holding };
  }
  return { plan: answered.plan, held: false };
}

/**
 * The longest a message mounted on a cold page waits, hidden, for its plan:
 * long enough for a slow phone to start the worker and plan a long chat, short
 * enough that a pattern the worker hangs on leaves the message as prose without
 * the reader waiting on a blank row.
 */
const COLD_HOLD_MS = 500;

/**
 * Renders a message as markdown. `*action*` becomes an <em>, styled in globals.css.
 *
 * HTML the message writes itself — a greeting's status panel, a `<br>`, a
 * `<details>` fold — is drawn as RisuAI draws it, block by block: a block that
 * holds any is rendered as markdown with HTML enabled and sanitized like a
 * display script's output (`lib/markdown/html`), and a block that holds none
 * keeps everything below. Markup never reaches the DOM any other way.
 *
 * `{{img::slug}}` — and RisuAI's other asset macros, by slug or by an imported
 * card's own name for the image — is resolved against the character's assets
 * before the markdown pass; an unknown one renders as nothing, so a reference
 * never leaks as text.
 * `{{setvar}}` / `{{addvar}}` (and ST's `{{incvar}}` / `{{decvar}}`) are hidden the
 * same way — they are protocol for the model, which still sees them in the prompt.
 *
 * With `display` set, the character's display scripts run first and the message
 * becomes a mix of text runs and HTML islands — read as markdown, as RisuAI reads
 * what its scripts made, and sanitized (`renderIsland`). With no scripts the
 * message's own CBS is still read, as RisuAI reads every message it shows.
 * Without `display` — the viewer turned custom UI off — the whole message is one
 * text run and nothing else changes.
 *
 * The scripts — their patterns, and the CBS RisuAI reads before and between
 * them — run in a worker (`lib/displayPlanner`), so a
 * message reads as prose until its plan arrives and then settles into its status
 * windows. For a settled message that is one round trip, and a message that is
 * still streaming is deliberately left as prose until it is not.
 *
 * With `components` set, what is left of the text is then searched for call codes,
 * and each one becomes a sandboxed frame in its place. Both are governed by the
 * same viewer opt-out: with it off neither prop is passed and no frame is ever
 * created. `componentNames` still is, so the call code reads as the plain text
 * it is rather than as a tag the message's HTML path would drop.
 *
 * The speaker split comes last and only where there is still plain text to split:
 * an island a display script produced is the creator's own markup and is drawn as
 * it was written, so is a block of the message's own HTML — `이름:` lines inside
 * it stay its text, with no face beside them — and a component frame is a
 * component. So a message that a script
 * turned into a status window keeps its status window, and the prose around it is
 * still told apart by who wrote it.
 *
 * Drawn as Zeta draws a reply: each speaker's prose in a content-sized bubble
 * under their face and name, their `*지문*` muted in it. Everything that is not
 * a speaker's prose stands outside the bubbles, in the flow at its full width —
 * markup (the creator's layout is not squeezed into a bubble), a component, a
 * picture on a line of its own, and in a narration or an intro a `#`/`##` scene
 * title. A speaker's next stretch in the same message keeps the column and says
 * neither face nor name again.
 */
export const MessageBody = memo(function MessageBody({
  content,
  assets = NO_ASSETS,
  resolveAsset,
  display,
  buttons,
  components: componentContext,
  componentNames,
  roster = NO_ROSTER,
  speaker,
  face,
  previousSameRole = '',
  chatIndex,
  streaming = false,
  userImage,
  mode = 'plain',
  sceneHeadings = false,
  continued = false,
  header,
  trailer,
  translation,
}: {
  content: string;
  /** Asset url by slug — memoize it, or this component re-renders on every keystroke. */
  assets?: ReadonlyMap<string, string>;
  /** Resolves imported cards' own image names to slugs; memoize it too. Slugs only without it. */
  resolveAsset?: AssetResolver;
  /**
   * Omitted when the viewer opted out of custom UI; with no scripts in it, the
   * message's own CBS is read all the same. `scripts` must keep its identity
   * across renders — it is what tells a plan
   * apart from a stale one, and a fresh array every render would ask for a new
   * plan on every token.
   */
  display?: DisplayContext;
  /**
   * Draws the message's own `{{button::label::trigger}}`s as RisuAI does
   * (`renderProseButtons`), running the manual triggers named here and filling
   * the composer otherwise. Omitted when the viewer opted out of custom UI, which
   * leaves the macro as written. Memoize it.
   */
  buttons?: ReadonlySet<string>;
  /** Omitted when the viewer opted out or the character declares no components. */
  components?: ComponentContext;
  /**
   * The components the character declares, opted out or not: without `components`
   * their call codes are shown as text. Memoize it, as `components`.
   */
  componentNames?: readonly string[];
  /**
   * The plot's members, whose names the `이름:` lines of a reply are matched
   * against. Empty — a user turn, or a plot read that has not landed yet —
   * leaves the message as one unattributed run. Memoize it: a fresh array every
   * render would re-cut the message on every token.
   */
  roster?: readonly PublicMember[];
  /**
   * The member who says the lines that name no one, in a reply that has one
   * owner (`speechRuns`): they are drawn in that member's block, not as the scene.
   */
  speaker?: string;
  /**
   * Who a reply with no roster to name its speakers is drawn under — the work's
   * own face and name, before the roster has arrived or in a work with no
   * members: its prose goes in that block, as a member's does, so a scene title
   * stands outside it.
   */
  face?: { name: string; avatarUrl: string | null };
  /** Raw text of the previous message with the same role, for `repeat_back`. */
  previousSameRole?: string;
  /** This message's place on the branch, RisuAI's way, for `{{chat_index}}`. */
  chatIndex?: number;
  /** A message still being written gets no display scripts until it settles. */
  streaming?: boolean;
  /** The reader's persona picture, for RisuAI's `{{source::user}}` in the message's own markup. */
  userImage?: string | null;
  /** How the prose no speaker owns is drawn (`BodyMode`); a speaker's is always their bubble. */
  mode?: BodyMode;
  /** Draws `#`/`##` lines as Zeta's scene titles: a narration's and an intro's. */
  sceneHeadings?: boolean;
  /** The row above already said `speaker`'s name, so the first of their stretches does not. */
  continued?: boolean;
  /** The row's quiet actions, beside the first name the message says (or above it, if it says none first). */
  header?: ReactNode;
  /** Hung under the last bubble at its corner (the model's name), or at the end where the last thing is no bubble. */
  trailer?: ReactNode;
  /** The row's translation (`lib/translation`): the body says what it shows, and draws what has arrived. */
  translation?: BodyTranslation | undefined;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const { plan, held } = useDisplayPlan(content, display, chatIndex, previousSameRole, streaming);

  const segments = useMemo<BodySegment[]>(() => {
    const plain: Segment[] = [{ kind: 'text', text: content }];
    // The plan is the message as the scripts and their CBS made it; what is left
    // is RisuAI's markdown over the islands and the sanitizing, done here, where
    // there is a DOM.
    const base = plan ? (renderDisplayPlan(plan, renderIsland) ?? plain) : plain;
    if (componentContext) return splitComponentCalls(base, componentContext.names);
    return componentNames ? escapeComponentCalls(base, componentNames) : base;
  }, [content, componentContext, componentNames, plan]);

  /**
   * Each text segment, already resolved, attributed and cut into blocks. The
   * variable macros go first, over the whole segment, since one may hold a blank
   * line; RisuAI's music and video become their players (`renderMediaTokens`), and
   * the message's own `{{button}}`s become buttons (`buttons`), so the line that
   * holds either is markup. Then the segment is cut into prose and markup by block, and only then
   * are the image references resolved — as markdown in prose, as `<img>` in
   * markup, where markdown is not read. A reference holds no blank line, so no
   * cut ever splits one. The speaker split runs over each stretch of prose; a
   * stretch of markup is drawn as the markup it is.
   *
   * Last comes RisuAI's display unescape (`unescapeCbs`), once per stretch: the
   * stand-ins `#escape` and the display-escape functions leave in a greeting — or
   * that a RisuAI history brought along — become the characters they stand for
   * once the variable macros, the image references, the cut into markup and the
   * speaker split have had their turn. So a `\{\{img::x\}\}` stays the text it was
   * written as rather than becoming a picture, a stand-in `<b>` never turns a
   * stretch into markup, and a stand-in colon names no speaker. `<` and `>` come
   * back as entities, which both the markdown and the sanitizer read as text. The
   * markdown itself still reads what follows, so restored parentheses can close a
   * `[label](url)` — held to the same link and image rules as one the model wrote.
   * A display script's island is not touched here: its template had the same pass
   * before its sanitizer (`renderTemplate`).
   */
  const runs = useMemo<(TextRun[] | null)[]>(
    () => {
      const names = roster.map((member) => member.name);
      const aliases = speakerAliases(roster);
      return segments.map((segment) => {
        if (segment.kind !== 'text') return null;
        // RisuAI's music and video become their players first, wherever they stand.
        const own = renderMediaTokens(stripVariableMacros(segment.text), assets, resolveAsset);
        return markupChunks(buttons ? renderProseButtons(own, buttons) : own).flatMap((chunk): TextRun[] => {
          if (chunk.html) {
            const markup = unescapeCbs(renderImageTokensAsHtml(chunk.text, assets, resolveAsset, userImage), 'html');
            return [{ name: null, narration: false, html: true, blocks: [markup] }];
          }
          const text = renderImageTokens(chunk.text, assets, resolveAsset);
          if (roster.length === 0) {
            const name = face?.name ?? null;
            return [{ name, narration: false, html: false, blocks: splitBlocks(unescapeCbs(text, 'html')) }];
          }
          return speechRuns(text, names, aliases, speaker ?? null).map((run) => ({
            name: run.name,
            narration: run.name === null,
            html: false,
            blocks: splitBlocks(unescapeCbs(run.text, 'html')),
          }));
        });
      });
    },
    [segments, assets, resolveAsset, roster, speaker, face?.name, userImage, buttons],
  );
  // RisuAI translates here: after the display scripts and the speaker split, before the markdown.
  const shown = useBodyTranslation(segments, runs, translation, streaming);

  // Only the last run of text — one speaker's stretch — is still being written.
  const liveSegment = streaming ? runs.findLastIndex((run) => run !== null) : -1;

  /**
   * What is drawn, in order, before any of it is: the header goes into the
   * first piece where that piece says a name, and the trailer under the last
   * where that piece is a bubble — so both have to know which pieces those are.
   */
  type Piece =
    | { kind: 'segment'; node: ReactNode }
    | { kind: 'heading'; item: RunItem }
    | { kind: 'speaker'; name: string; items: RunItem[] }
    | { kind: 'prose'; box: 'bubble' | 'narration'; scene: boolean; items: RunItem[] }
    | { kind: 'plain'; blocks: string[]; live: boolean };
  const pieces: Piece[] = [];
  /**
   * Markup that only dresses words goes where the words around it go: into the
   * owner's bubble, the fallback reply's, or the narration. Elsewhere — a
   * reader's turn, a scene with several speakers and no owner — it is drawn as
   * it always was.
   */
  const voice = speaker ?? face?.name;
  /** A speaker's face: their member picture, or the work's own for the work's own name. */
  const avatarOf = (name: string): string | null =>
    roster.find((member) => member.name === name)?.avatarUrl ?? (name === face?.name ? face.avatarUrl : null);
  const dressed = (item: RunItem): boolean => {
    if (mode === 'plain') return false;
    if (voice) pieces.push({ kind: 'speaker', name: voice, items: [item] });
    else if (mode === 'narration' || roster.length === 0) {
      pieces.push({ kind: 'prose', box: mode === 'narration' ? 'narration' : 'bubble', scene: false, items: [item] });
    } else return false;
    return true;
  };
  shown.segments.forEach((segment, index) => {
    if (segment.kind === 'component') {
      pieces.push({
        kind: 'segment',
        node: (
          <ComponentFrame
            code={componentContext!.code}
            name={segment.name}
            props={segment.props}
            platform={componentContext!.platform}
            errorLabel={t('componentError')}
            navigatedLabel={t('componentNavigated')}
            timeoutLabel={t('componentTimeout')}
            retryLabel={common('retry')}
            {...(componentContext!.onSuggestInput
              ? { onSuggestInput: componentContext!.onSuggestInput }
              : {})}
            {...(componentContext!.onSendTurn
              ? { onSendTurn: componentContext!.onSendTurn }
              : {})}
          />
        ),
      });
      return;
    }
    if (segment.kind === 'html') {
      if (inlineMarkup(segment.html) && dressed({ kind: 'island', text: segment.html, live: false })) return;
      pieces.push({
        kind: 'segment',
        node: (
          <div
            className={MESSAGE_SCOPE_CLASS}
            // Sanitized by lib/sanitizeHtml — the only place markup is trusted.
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        ),
      });
      return;
    }
    const own = shown.runs[index]!;
    own.forEach((run, at) => {
      const liveRun = index === liveSegment && at === own.length - 1;
      // A box of markup is the creator's own layout: never squeezed into a
      // bubble, it stands in the flow at its full width.
      if (run.html) {
        const markup = run.blocks[0]!;
        if (inlineMarkup(markup) && dressed({ kind: 'markup', text: markup, live: liveRun })) return;
        pieces.push({ kind: 'segment', node: <HtmlBlock content={markup} live={liveRun} /> });
        return;
      }
      if (run.name === null && !run.narration && mode === 'plain') {
        pieces.push({ kind: 'plain', blocks: run.blocks, live: liveRun });
        return;
      }
      for (const part of atHeadings(runItems(run.blocks, liveRun, sceneHeadings))) {
        if ('heading' in part) pieces.push({ kind: 'heading', item: part.heading });
        else if (run.name !== null) pieces.push({ kind: 'speaker', name: run.name, items: part.items });
        else {
          // The scene's own lines in a message with several speakers and no
          // owner (written before group turns) are narration; so is a narration
          // row's text. A reply with an owner has none: its unprefixed lines are
          // the owner's. What names no one in the fallback row is the reply.
          const box = run.narration || mode === 'narration' ? 'narration' : 'bubble';
          pieces.push({ kind: 'prose', box, scene: run.narration, items: part.items });
        }
      }
    });
  });

  // What one voice says around the markup that only dressed it is one bubble:
  // pieces of one speaker, or of one box, that meet are one piece.
  for (let at = pieces.length - 1; at > 0; at -= 1) {
    const before = pieces[at - 1]!;
    const piece = pieces[at]!;
    const joins =
      (before.kind === 'speaker' && piece.kind === 'speaker' && before.name === piece.name) ||
      (before.kind === 'prose' && piece.kind === 'prose' && before.box === piece.box && before.scene === piece.scene);
    if (!joins) continue;
    pieces[at - 1] = { ...before, items: [...before.items, ...piece.items] } as Piece;
    pieces.splice(at, 1);
  }

  // A continued turn (`continued`) said its speaker's name in the row above.
  let named: string | null = continued && voice ? voice : null;
  /**
   * A reply its display scripts turned wholly into markup — a status window, a
   * scene picker — still says whose it is, as every RisuAI message does: the
   * face and the name on a line of their own, the markup under them at its own
   * width rather than squeezed into the column beside the face.
   */
  const lone =
    mode === 'reply' && voice !== undefined && named === null && pieces.length > 0 &&
    !pieces.some((piece) => piece.kind === 'speaker');
  const first = pieces[0];
  const headerInside = header !== undefined && (lone || (first?.kind === 'speaker' && first.name !== named));
  const last = pieces.at(-1);
  const trailerInside =
    trailer !== undefined && (last?.kind === 'speaker' || (last?.kind === 'prose' && last.box === 'bubble'));

  const headerAbove = header !== undefined && !headerInside;

  return (
    <div
      ref={shown.ref}
      className={cx('message-body', headerAbove && 'relative')}
      // Laid out, so the chat does not jump when it shows; not yet seen.
      {...(held ? { style: { visibility: 'hidden' }, 'data-held': '' } : {})}
    >
      {lone ? (
        <div data-testid="speech-character" data-speaker={voice} className="flex items-center gap-1.5">
          <Avatar src={avatarOf(voice)} name={voice} className="chat-face size-8 text-xs" />
          <div className="flex min-h-5 min-w-0 flex-1 items-center gap-2">
            <span className="chat-name text-xs text-fg/70">{voice}</span>
            {header}
          </div>
        </div>
      ) : null}
      {pieces.map((piece, index) => {
        const end = index === pieces.length - 1;
        if (piece.kind === 'segment') return <Fragment key={index}>{piece.node}</Fragment>;
        if (piece.kind === 'heading') {
          // Zeta's title stands outside every speaker's block, at the column's
          // width; the speaker it cuts into goes on under it without saying
          // their name again.
          return <SceneHeading key={index} text={piece.item.text} />;
        }
        if (piece.kind === 'plain') {
          return (
            <Fragment key={index}>
              {piece.blocks.map((block, nth) => (
                <MarkdownBlock key={nth} content={block} live={piece.live} />
              ))}
            </Fragment>
          );
        }
        if (piece.kind === 'prose') {
          const drawn = (
            <RunItems
              items={piece.items}
              box={piece.box}
              {...(end && trailerInside ? { trailer } : {})}
            />
          );
          return piece.scene ? (
            <div key={index} data-testid="speech-narration" className="flex flex-col gap-3 text-muted">
              {drawn}
            </div>
          ) : (
            <Fragment key={index}>{drawn}</Fragment>
          );
        }
        // A character's: the face and the name once, the bubbles under the name.
        // Their next stretch in the same message — after a status window, say —
        // keeps the column and says neither again.
        const says = piece.name !== named;
        named = piece.name;
        return (
          <div key={index} data-testid="speech-character" data-speaker={piece.name} className="flex gap-1.5">
            {says ? (
              <Avatar src={avatarOf(piece.name)} name={piece.name} className="chat-face size-8 text-xs" />
            ) : (
              <div aria-hidden="true" className="chat-face w-8 shrink-0" />
            )}
            <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
              {says ? (
                <div className="-mb-2 flex min-h-5 items-center gap-2">
                  <span className="chat-name text-xs text-fg/70">{piece.name}</span>
                  {index === 0 && headerInside ? header : null}
                </div>
              ) : null}
              <RunItems
                items={piece.items}
                box="bubble"
                {...(end && trailerInside ? { trailer } : {})}
              />
            </div>
          </div>
        );
      })}
      {trailer !== undefined && !trailerInside ? <div className="flex justify-end">{trailer}</div> : null}
      {/* No name to stand beside (the message opens on a title or markup, or
          continues the row above): over the gap above the message, taking no
          room until it is shown. Last, so it is no sibling the spacing counts. */}
      {headerAbove ? <div className="absolute bottom-full left-0 flex h-5 items-center gap-2">{header}</div> : null}
    </div>
  );
});
