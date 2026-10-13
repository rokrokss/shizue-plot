import type { ReactNode } from 'react';
import type { Persona } from '@/lib/types';
import { cx } from './ui';

/**
 * Character avatar. The source is served by the API through the same-origin
 * proxy, so a plain <img> (no next/image loader) is what we want.
 */
export function Avatar({
  src,
  name,
  className,
}: {
  src: string | null;
  name: string;
  className?: string;
}) {
  const shape = cx('shrink-0 overflow-hidden rounded-full bg-raised', className);
  if (src) {
    // Character art is mostly portrait with the face near the top, which a
    // centred square crop cuts through; square and landscape images are unchanged.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={name} className={cx(shape, 'object-cover object-top')} />;
  }
  return (
    <span
      aria-hidden
      className={cx(shape, 'flex items-center justify-center font-semibold text-link/80')}
    >
      {[...name.trim()][0] ?? '?'}
    </span>
  );
}

/**
 * The chosen persona's picture beside the select that chose it — an `<option>`
 * cannot carry one. Only a persona with a picture gets it: an initial would only
 * repeat the name the select already shows, and with none chosen nothing moves.
 * Hidden from assistive tech for the same reason; the select is the name.
 */
export function PersonaFace({
  persona,
  compact = false,
  children,
}: {
  persona: Pick<Persona, 'name' | 'avatarUrl'> | undefined;
  /** Beside the header's short controls rather than a full-height field. */
  compact?: boolean;
  children: ReactNode;
}) {
  if (!persona?.avatarUrl) return children;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden className="shrink-0">
        <Avatar
          src={persona.avatarUrl}
          name={persona.name}
          className={compact ? 'size-8 text-xs' : 'size-10 text-sm'}
        />
      </span>
      {/* So a long name shrinks the select rather than pushing past the edge. */}
      <span className="min-w-0 flex-1">{children}</span>
    </span>
  );
}
