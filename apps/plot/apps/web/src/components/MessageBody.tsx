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
import { stripVariableMacros } from '@shizue/core/variables';
import { readLockKind, renderImageTokens } from '@/lib/assets';
import {
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
import { rehypeDialogueQuotes } from '@/lib/markdown/quotes';
import { rehypeWordReveal } from '@/lib/markdown/reveal';
import { MESSAGE_SCOPE_CLASS } from '@/lib/sanitizeHtml';
import { speechRuns } from '@/lib/speechRuns';
import type { DisplayScript, PublicMember } from '@/lib/types';
import { Avatar } from './Avatar';
import { ChatImage } from './ChatImage';
import { ComponentFrame } from './ComponentFrame';
import { LockedImage } from './LockedImage';

const remarkPlugins = [remarkGfm, remarkBreaks];

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
    return locked ? <LockedImage kind={locked} /> : <ChatImage src={url} alt={alt ?? ''} />;
  },
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
 * The plan is asked for once per settled message. What a plan does *not* contain
 * is the bindings, so a `{{setvar}}` moving a gauge redraws from the plan already
 * in hand, with no worker in the loop.
 */
function useDisplayPlan(
  content: string,
  scripts: DisplayScript[] | undefined,
  previousSameRole: string,
  streaming: boolean,
): DisplayPlan | null {
  const [answered, setAnswered] = useState<{ asked: PlanRequest; plan: DisplayPlan | null } | null>(
    null,
  );

  useEffect(() => {
    // A half-streamed status block is not a status block: matching a line the
    // model is still in the middle of writing gets an answer about a state that
    // was never reported. It is worth the wait, and the wait is one turn.
    if (!scripts || streaming) return;
    const asked: PlanRequest = { content, scripts, previousSameRole };
    let live = true;
    void displayPlanner.plan(asked).then((plan) => {
      if (live) setAnswered({ asked, plan });
    });
    return () => {
      live = false;
    };
  }, [content, scripts, previousSameRole, streaming]);

  // A plan carries the message it was made from, so an edit does not get one
  // render of the text it replaced: until the new plan lands, there is no plan.
  if (
    !answered ||
    answered.asked.content !== content ||
    answered.asked.scripts !== scripts ||
    answered.asked.previousSameRole !== previousSameRole
  ) {
    return null;
  }
  return answered.plan;
}

/**
 * Renders a message as markdown. Raw HTML is not enabled, so model output can
 * never inject markup. `*action*` becomes an <em>, styled in globals.css.
 *
 * `{{img::slug}}` is resolved against the character's assets before the markdown
 * pass; an unknown slug renders as nothing, so a reference never leaks as text.
 * `{{setvar}}` / `{{addvar}}` are hidden the same way — they are protocol for the
 * model, which still sees them in the prompt.
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
 * same viewer opt-out: with it off neither prop is passed, so the call code reads
 * as the plain text it is and no frame is ever created.
 *
 * The speaker split comes last and only where there is still plain text to split:
 * an island a display script produced is the creator's own markup and is drawn as
 * it was written, and a component frame is a component. So a message that a script
 * turned into a status window keeps its status window, and the prose around it is
 * still told apart by who wrote it.
 */
export const MessageBody = memo(function MessageBody({
  content,
  assets = NO_ASSETS,
  display,
  components: componentContext,
  roster = NO_ROSTER,
  previousSameRole = '',
  streaming = false,
}: {
  content: string;
  /** Asset url by slug — memoize it, or this component re-renders on every keystroke. */
  assets?: ReadonlyMap<string, string>;
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
   * The plot's members, whose names the `이름:` lines of a reply are matched
   * against. Empty — a user turn, or a plot read that has not landed yet —
   * leaves the message as one unattributed run. Memoize it: a fresh array every
   * render would re-cut the message on every token.
   */
  roster?: readonly PublicMember[];
  /** Raw text of the previous message with the same role, for `repeat_back`. */
  previousSameRole?: string;
  /** A message still being written gets no display scripts until it settles. */
  streaming?: boolean;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const plan = useDisplayPlan(content, display?.scripts, previousSameRole, streaming);
  const settling = useSettleFade(streaming);

  const segments = useMemo<BodySegment[]>(() => {
    const plain: Segment[] = [{ kind: 'text', text: content }];
    // The plan says where the islands are; the bindings, which change on every
    // token, are applied here and now.
    const base = display && plan ? (renderDisplayPlan(plan, display) ?? plain) : plain;
    return componentContext ? splitComponentCalls(base, componentContext.names) : base;
  }, [content, display, componentContext, plan]);

  /**
   * Each text segment, already resolved, attributed and cut into blocks. The image
   * and macro passes stay where they were — ahead of everything, over the whole
   * segment — so a reference is never split across a run or a block boundary.
   */
  const runs = useMemo<(TextRun[] | null)[]>(
    () =>
      segments.map((segment) => {
        if (segment.kind !== 'text') return null;
        const text = stripVariableMacros(renderImageTokens(segment.text, assets));
        if (roster.length === 0) return [{ name: null, narration: false, blocks: splitBlocks(text) }];
        return speechRuns(
          text,
          roster.map((member) => member.name),
        ).map((run) => ({ name: run.name, narration: run.name === null, blocks: splitBlocks(run.text) }));
      }),
    [segments, assets, roster],
  );

  // Only the very last block of the last run of text is still being written.
  const liveSegment = streaming ? runs.findLastIndex((run) => run !== null) : -1;

  return (
    <div className={settling ? 'message-body shizue-settling' : 'message-body'}>
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
