'use client';

import { useTranslations } from 'next-intl';
import { Button, cx } from './ui';

/**
 * The scene being drawn, standing where the narration turn will.
 *
 * A drawn scene is one round trip with no tokens to stream, so there is nothing
 * to show but the shape of what is coming: a box in the aspect the server asks
 * the provider for, so the row does not jump when the real message replaces it.
 * The shimmer is the only thing that moves, and it stops for a reader who asked
 * for less motion — the label already says what is happening.
 *
 * Failure keeps the row rather than clearing it: nothing was stored, so the
 * retry here is the only way back to the picture that was asked for.
 */
export function SceneDraft({
  status,
  onRetry,
}: {
  status: 'drawing' | 'failed';
  onRetry: () => void;
}) {
  const t = useTranslations('chat');
  const common = useTranslations('common');
  const failed = status === 'failed';

  return (
    <div data-testid="scene-draft" className="flex gap-3">
      <div className="min-w-0 flex-1">
        <div
          // The same aspect the API asks fal for (1024×768), so the skeleton is
          // the size of the picture that lands in its place.
          style={{ aspectRatio: '4 / 3' }}
          className={cx(
            'max-h-96 w-full max-w-lg rounded-xl border',
            failed
              ? 'flex items-center justify-center border-danger/40 bg-danger/5'
              : 'animate-pulse border-line bg-raised/40 motion-reduce:animate-none',
          )}
        >
          {/* The failure interrupts: nothing was stored, and the retry beside it
              is the only way back to the picture that was asked for. */}
          {failed ? (
            <span role="alert" className="px-4 text-sm text-danger">
              {t('drawFailed')}
            </span>
          ) : null}
        </div>
        <div className="mt-2 flex items-center gap-2">
          {failed ? (
            <Button size="sm" variant="danger" onClick={onRetry}>
              {common('retry')}
            </Button>
          ) : (
            /* The shimmer is for the eye; this is the same news for everyone else. */
            <span role="status" className="text-xs text-muted italic">
              {t('drawingScene')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
