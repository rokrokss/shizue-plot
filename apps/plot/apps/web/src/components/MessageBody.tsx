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
import { readLockKind, renderImageTokens, type AssetResolver } from '@/lib/assets';
import {
  escapeComponentCalls,
  splitComponentCalls,
  type BodySegment,
  type ComponentContext,
} from '@/lib/componentCalls';
import { displayPlanner, type PlanRequest } from '@/lib/displayPlanner';
import {
  renderDisplayPlan,
  type DisplayContext,
  type DisplayPlan,
  type Segment,
} from '@/lib/displayScripts';
import { balancePartial } from '@/lib/markdown/balance';
import { splitBlocks } from '@/lib/markdown/blocks';
import {
  markupChunks,
  remarkNoIndentedCode,
  renderImageTokensAsHtml,
} from '@/lib/markdown/html';
import { rehypeDialogueQuotes } from '@/lib/markdown/quotes';
import { rehypeWordReveal } from '@/lib/markdown/reveal';
import { isExternalUrl, isSameOriginUrl, MESSAGE_SCOPE_CLASS } from '@/lib/sanitizeHtml';
import { speakerAliases, speechRuns } from '@/lib/speechRuns';
import type { DisplayScript, PublicMember } from '@/lib/types';
import { Avatar } from './Avatar';
import { ChatImage } from './ChatImage';
import { ComponentFrame } from './ComponentFrame';
import { HtmlBlock } from './HtmlBlock';
import { LockedImage } from './LockedImage';

const remarkPlugins = [remarkGfm, remarkBreaks, remarkNoIndentedCode];

/**
 * A settled block is worth highlighting; the block still being written is not —
 * its last word changes on every token and the grammar it is half-way through
 * would be re-guessed each time, for a colour that is about to be wrong anyway.
 */
const settledPlugins = [rehypeHighlight, rehypeDialogueQuotes];
const livePlugins = [rehypeDialogueQuotes, rehypeWordReveal];

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

/** Character images stay inside the bubble and never push the layout around. */
const components: Components = {
  // React's `img` src is `string | Blob` (the experimental srcObject overload).
  // Markdown only ever produces the string form, so the Blob half is narrowed
  // away rather than carried into a component that has no use for it.
  img: ({ node: _node, alt, src }) => {
    const url = typeof src === 'string' ? src : undefined;
    // A locked asset resolves to a marker rather than to bytes (`lib/assets`),
    // so the reference still becomes something — the card that says what it is
    // waiting for — and no request is made for a picture nobody may see yet.
    const locked = url ? readLockKind(url) : null;
    if (locked) return <LockedImage kind={locked} />;
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
 * when the twenty-first gains a word. Only `live` — the block being written —
 * pays for a re-render, and it is the one being balanced.
 */
const MarkdownBlock = memo(function MarkdownBlock({
  content,
  live,
}: {
  content: string;
  live: boolean;
}) {
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={live ? livePlugins : settledPlugins}
      components={components}
    >
      {live ? balancePartial(content) : content}
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
  /** The member speaking; null for the narrator, and for a message never split. */
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
 * True for one animation's length after the stream ends.
 *
 * The last frame of a stream is not a quiet one: the reveal spans go, the
 * display scripts finally run and the message can rearrange itself into status
 * windows. A short fade over the whole body is not a decoration — it is what
 * keeps that rearrangement from reading as a glitch.
 */
function useSettleFade(streaming: boolean): boolean {
  const was = useRef(streaming);
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    const ended = was.current && !streaming;
    was.current = streaming;
    if (!ended) return;
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), 200);
    return () => clearTimeout(timer);
  }, [streaming]);

  return settling;
}

/**
 * Asks the planner where this message's matches are, and holds the answer.
 *
 * Null means draw it plain, and that covers three different situations on purpose:
 * the card has no scripts, the message is still streaming, and the plan has not
 * come back yet (or never will, because the pattern hung and the worker was
 * terminated). All three want the same thing on screen — the message as the model
 * wrote it — and none of them wants a blank space while we decide.
 *
 * The plan is asked for once per settled message, and the planner keeps it: a
 * message drawn again — remounted, scrolled back in, its text back to one it had
 * — takes the kept plan on its first render and never shows as prose. What a
 * plan does *not* contain is the bindings, so a `{{setvar}}` moving a gauge
 * redraws from the plan already in hand, with no worker in the loop.
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
  scripts: DisplayScript[] | undefined,
  previousSameRole: string,
  streaming: boolean,
): { plan: DisplayPlan | null; held: boolean } {
  const [answered, setAnswered] = useState<{ asked: PlanRequest; plan: DisplayPlan | null } | null>(
    null,
  );
  // A half-streamed status block is not a status block: matching a line the
  // model is still in the middle of writing gets an answer about a state that
  // was never reported. It is worth the wait, and the wait is one turn.
  const kept = useMemo(
    () => (scripts && !streaming ? displayPlanner.cached({ content, scripts, previousSameRole }) : undefined),
    [content, scripts, previousSameRole, streaming],
  );
  const [holding, setHolding] = useState(
    () => scripts !== undefined && !streaming && kept === undefined && !displayPlanner.warm(),
  );

  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setHolding(false), COLD_HOLD_MS);
    return () => clearTimeout(timer);
  }, [holding]);

  useEffect(() => {
    if (!scripts || streaming || kept !== undefined) return;
    const asked: PlanRequest = { content, scripts, previousSameRole };
    let live = true;
    void displayPlanner.plan(asked).then((plan) => {
      if (!live) return;
      setAnswered({ asked, plan });
      setHolding(false);
    });
    return () => {
      live = false;
    };
  }, [content, scripts, previousSameRole, streaming, kept]);

  if (kept !== undefined) return { plan: kept, held: false };
  // A plan carries the message it was made from, so an edit does not get one
  // render of the text it replaced: until the new plan lands, there is no plan.
  if (
    !answered ||
    answered.asked.content !== content ||
    answered.asked.scripts !== scripts ||
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
 * becomes a mix of text runs and sanitized HTML islands. Without it — the viewer
 * turned custom UI off, or the character has no scripts — the whole message is
 * one text run and nothing else changes.
 *
 * The scripts' patterns are matched in a worker (`lib/displayPlanner`), so a
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
 */
export const MessageBody = memo(function MessageBody({
  content,
  assets = NO_ASSETS,
  resolveAsset,
  display,
  components: componentContext,
  componentNames,
  roster = NO_ROSTER,
  speaker,
  previousSameRole = '',
  chatIndex,
  streaming = false,
  userImage,
}: {
  content: string;
  /** Asset url by slug — memoize it, or this component re-renders on every keystroke. */
  assets?: ReadonlyMap<string, string>;
  /** Resolves imported cards' own image names to slugs; memoize it too. Slugs only without it. */
  resolveAsset?: AssetResolver;
  /**
   * Omitted when the viewer opted out or the character has no display scripts.
   * `scripts` must keep its identity across renders — it is what tells a plan
   * apart from a stale one, and a fresh array every render would ask for a new
   * plan on every token.
   */
  display?: DisplayContext;
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
   * The member who says the lines that name no one, instead of the narrator: on
   * a message a card's script wrote as its character (`speechRuns`).
   */
  speaker?: string;
  /** Raw text of the previous message with the same role, for `repeat_back`. */
  previousSameRole?: string;
  /** This message's place on the branch, RisuAI's way, for `{{chat_index}}`. */
  chatIndex?: number;
  /** A message still being written gets no display scripts until it settles. */
  streaming?: boolean;
  /** The reader's persona picture, for RisuAI's `{{source::user}}` in the message's own markup. */
  userImage?: string | null;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const { plan, held } = useDisplayPlan(content, display?.scripts, previousSameRole, streaming);
  const settling = useSettleFade(streaming);

  const segments = useMemo<BodySegment[]>(() => {
    const plain: Segment[] = [{ kind: 'text', text: content }];
    // The plan says where the islands are; the bindings, which change on every
    // token, are applied here and now.
    const bound = display && chatIndex !== undefined ? { ...display, chatIndex } : display;
    const base = bound && plan ? (renderDisplayPlan(plan, bound) ?? plain) : plain;
    if (componentContext) return splitComponentCalls(base, componentContext.names);
    return componentNames ? escapeComponentCalls(base, componentNames) : base;
  }, [content, display, chatIndex, componentContext, componentNames, plan]);

  /**
   * Each text segment, already resolved, attributed and cut into blocks. The
   * variable macros go first, over the whole segment, since one may hold a blank
   * line. Then the segment is cut into prose and markup by block, and only then
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
        return markupChunks(stripVariableMacros(segment.text)).flatMap((chunk): TextRun[] => {
          if (chunk.html) {
            const markup = unescapeCbs(renderImageTokensAsHtml(chunk.text, assets, resolveAsset, userImage), 'html');
            return [{ name: null, narration: false, html: true, blocks: [markup] }];
          }
          const text = renderImageTokens(chunk.text, assets, resolveAsset);
          if (roster.length === 0) {
            return [{ name: null, narration: false, html: false, blocks: splitBlocks(unescapeCbs(text, 'html')) }];
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
    [segments, assets, resolveAsset, roster, speaker, userImage],
  );

  // Only the very last block of the last run of text is still being written.
  const liveSegment = streaming ? runs.findLastIndex((run) => run !== null) : -1;

  return (
    <div
      className={settling ? 'message-body shizue-settling' : 'message-body'}
      // Laid out, so the chat does not jump when it shows; not yet seen.
      {...(held ? { style: { visibility: 'hidden' }, 'data-held': '' } : {})}
    >
      {segments.map((segment, index) => {
        if (segment.kind === 'component') {
          return (
            <ComponentFrame
              key={index}
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
          );
        }
        if (segment.kind === 'html') {
          return (
            <div
              key={index}
              className={MESSAGE_SCOPE_CLASS}
              // Sanitized by lib/sanitizeHtml — the only place markup is trusted.
              dangerouslySetInnerHTML={{ __html: segment.html }}
            />
          );
        }
        const own = runs[index]!;
        return own.map((run, at) => {
          const liveRun = index === liveSegment && at === own.length - 1;
          if (run.html) {
            return <HtmlBlock key={`${index}:${at}`} content={run.blocks[0]!} live={liveRun} />;
          }
          const body = run.blocks.map((block, nth) => (
            <MarkdownBlock
              key={nth}
              content={block}
              live={liveRun && nth === run.blocks.length - 1}
            />
          ));
          // The narrator moves the scene rather than speaking in it: no face, no
          // name, the whole width — and set apart from the lines that are spoken.
          if (run.name === null) {
            return run.narration ? (
              <div
                key={`${index}:${at}`}
                data-testid="speech-narration"
                className="speech-run text-muted italic"
              >
                {body}
              </div>
            ) : (
              <Fragment key={`${index}:${at}`}>{body}</Fragment>
            );
          }
          return (
            <div
              key={`${index}:${at}`}
              data-testid="speech-character"
              data-speaker={run.name}
              className="flex gap-3"
            >
              <Avatar
                src={roster.find((member) => member.name === run.name)?.avatarUrl ?? null}
                name={run.name}
                className="mt-0.5 size-9 text-sm"
              />
              <div className="min-w-0 flex-1">
                <span className="text-xs font-medium text-muted">{run.name}</span>
                <div className="speech-run mt-1">{body}</div>
              </div>
            </div>
          );
        });
      })}
    </div>
  );
});
