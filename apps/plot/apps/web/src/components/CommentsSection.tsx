'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, ErrorText, Section, Spinner, TextArea } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { apiDelete, apiGet, apiSend } from '@/lib/api';
import { useSession } from '@/lib/authClient';
import { addComment, removeComment } from '@/lib/comments';
import { signInHref } from '@/lib/nav';
import { MAX_COMMENT_LENGTH, type Comment, type CommentPage } from '@/lib/types';
import { useErrorMessage } from '@/lib/useErrorMessage';

/**
 * The comment section under a public plot page. The count comes from the plot
 * read and then follows what happens here — every write moves it by one,
 * deleted comments included, exactly as the server counts them.
 *
 * The thread itself is a public read, so a reader with no account sees all of
 * it; only the writing is behind the gate, and there the way in stands instead.
 */
export function CommentsSection({
  plotId,
  count: initialCount,
}: {
  plotId: string;
  count: number;
}) {
  const t = useTranslations('comments');
  const common = useTranslations('common');
  const toMessage = useErrorMessage();
  const { data: session, isPending } = useSession();
  const signedIn = Boolean(session);

  const [items, setItems] = useState<Comment[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [count, setCount] = useState(initialCount);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet<CommentPage>(`/api/plots/${plotId}/comments`).then(
      (page) => {
        setItems(page.items);
        setCursor(page.nextCursor);
      },
      (caught: unknown) => {
        setItems([]);
        setError(toMessage(caught));
      },
    );
  }, [plotId, toMessage]);

  async function loadMore(): Promise<void> {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await apiGet<CommentPage>(
        `/api/plots/${plotId}/comments?cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setLoadingMore(false);
    }
  }

  const created = useCallback((comment: Comment) => {
    setItems((current) => addComment(current ?? [], comment));
    setCount((current) => current + 1);
  }, []);

  const remove = useCallback(
    async (id: string) => {
      // A comment is gone for good once it is deleted — the thread keeps only a
      // placeholder — so it is asked about first, like every other delete here.
      if (!window.confirm(common('confirmDelete'))) return;
      try {
        await apiDelete(`/api/comments/${id}`);
        setItems((current) => removeComment(current ?? [], id));
        setCount((current) => Math.max(0, current - 1));
      } catch (caught) {
        setError(toMessage(caught));
      }
    },
    [common, toMessage],
  );

  return (
    <Section title={t('title', { count })}>
      {/* Empty while the session read is in flight, for the same reason the
          header's controls are: a box that turns into an invitation moves the
          thread under the reader. */}
      {isPending ? null : signedIn ? (
        <CommentForm plotId={plotId} onCreated={created} />
      ) : (
        <SignInNote plotId={plotId} />
      )}
      <ErrorText>{error}</ErrorText>
      {items === null ? (
        <div className="flex justify-center py-6">
          <Spinner label={common('loading')} />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t('empty')}</p>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id} className="py-3">
                <CommentRow
                  comment={item}
                  plotId={plotId}
                  canReply={signedIn}
                  onCreated={created}
                  onDelete={remove}
                />
                {item.replies.length > 0 ? (
                  <ul className="mt-3 space-y-3 border-l border-line pl-4">
                    {item.replies.map((reply) => (
                      <li key={reply.id}>
                        <CommentRow
                          comment={reply}
                          plotId={plotId}
                          canReply={signedIn}
                          onCreated={created}
                          onDelete={remove}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
          {cursor ? (
            <div className="flex justify-center pt-2">
              <Button busy={loadingMore} onClick={() => void loadMore()}>
                {t('more')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Section>
  );
}

/**
 * One comment. A deleted one is only ever here because it still anchors replies,
 * and it carries nothing but the placeholder: the server sent no author and no
 * content to show.
 */
function CommentRow({
  comment,
  plotId,
  canReply,
  onCreated,
  onDelete,
}: {
  comment: Comment;
  plotId: string;
  /** False for a reader with no account: there is no form behind the button. */
  canReply: boolean;
  onCreated: (comment: Comment) => void;
  onDelete: (id: string) => Promise<void>;
}) {
  const t = useTranslations('comments');
  const common = useTranslations('common');
  const format = useFormatter();

  const [replying, setReplying] = useState(false);
  const [replyBusy, setReplyBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [revealed, setRevealed] = useState(false);

  return (
    <div data-testid={comment.parentId === null ? 'comment' : 'comment-reply'}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-fg">{comment.authorName ?? '—'}</span>
        <span className="text-xs text-muted">
          {format.dateTime(new Date(comment.createdAt), { dateStyle: 'short', timeStyle: 'short' })}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {canReply && comment.parentId === null && !comment.deleted ? (
            <Button variant="ghost" size="sm" disabled={replyBusy || deleting} onClick={() => setReplying((current) => !current)}>
              {replying ? common('cancel') : t('reply')}
            </Button>
          ) : null}
          {comment.canDelete ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="comment-delete"
              aria-label={common('delete')}
              busy={deleting}
              disabled={replyBusy}
              onClick={async () => {
                if (deleting || replyBusy) return;
                setDeleting(true);
                try { await onDelete(comment.id); }
                finally { setDeleting(false); }
              }}
            >
              ✕
            </Button>
          ) : null}
        </span>
      </div>

      {comment.deleted ? (
        <p className="mt-1 text-sm text-muted italic" data-testid="comment-deleted">
          {t('deleted')}
        </p>
      ) : comment.spoiler && !revealed ? (
        // Collapsed rather than merely blurred: a spoiler nobody asked to see is
        // not in the page at all.
        <button
          type="button"
          data-testid="spoiler-toggle"
          onClick={() => setRevealed(true)}
          className="mt-1 flex w-full items-center gap-2 rounded-lg bg-raised px-3 py-2 text-left text-xs text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <span className="h-3 flex-1 rounded bg-line" aria-hidden />
          {t('showSpoiler')}
        </button>
      ) : (
        <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-fg">{comment.content}</p>
      )}

      {replying ? (
        <div className="mt-3">
          <CommentForm
            plotId={plotId}
            parentId={comment.id}
            onBusyChange={setReplyBusy}
            onCreated={(created) => {
              setReplying(false);
              onCreated(created);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** What stands where the write box would be, for a reader with no account. */
function SignInNote({ plotId }: { plotId: string }) {
  const t = useTranslations('comments');
  const auth = useTranslations('auth');

  return (
    <p className="text-sm text-muted" data-testid="comment-sign-in">
      {t('signInHint')}{' '}
      <Link
        href={signInHref(`/p/${plotId}`)}
        className="text-fg underline-offset-4 hover:underline"
      >
        {auth('signIn')}
      </Link>
    </p>
  );
}

/** Write box for a comment or, with a `parentId`, for a reply. */
function CommentForm({
  plotId,
  parentId,
  onCreated,
  onBusyChange,
}: {
  plotId: string;
  parentId?: string;
  onBusyChange?: (busy: boolean) => void;
  onCreated: (comment: Comment) => void;
}) {
  const t = useTranslations('comments');
  const toMessage = useErrorMessage();

  const [content, setContent] = useState('');
  const [spoiler, setSpoiler] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(): Promise<void> {
    if (busy || !content.trim()) return;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      onCreated(
        await apiSend<Comment>('POST', `/api/plots/${plotId}/comments`, {
          content,
          spoiler,
          ...(parentId ? { parentId } : {}),
        }),
      );
      setContent('');
      setSpoiler(false);
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <fieldset disabled={busy} aria-busy={busy || undefined} className="min-w-0 space-y-2" data-testid={parentId ? 'reply-form' : 'comment-form'}>
      <TextArea
        rows={parentId ? 2 : 3}
        value={content}
        maxLength={MAX_COMMENT_LENGTH}
        placeholder={parentId ? t('replyPlaceholder') : t('placeholder')}
        aria-label={parentId ? t('replyPlaceholder') : t('placeholder')}
        onChange={(event) => setContent(event.target.value)}
      />
      <ErrorText>{error}</ErrorText>
      <div className="flex items-center gap-3">
        <Checkbox label={t('spoiler')} checked={spoiler} onChange={setSpoiler} />
        <span className="text-xs text-muted/80">
          {content.length}/{MAX_COMMENT_LENGTH}
        </span>
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          busy={busy}
          disabled={!content.trim()}
          onClick={() => void submit()}
        >
          {t('submit')}
        </Button>
      </div>
    </fieldset>
  );
}
