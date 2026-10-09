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
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={name} className={cx(shape, 'object-cover')} />;
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
