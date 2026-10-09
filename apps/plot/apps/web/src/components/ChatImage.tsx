'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { thumbHashToDataURL } from 'thumbhash';
import { readAssetMeta } from '@/lib/assets';
import { Lightbox, type LightboxImage } from './Lightbox';
import { cx } from './ui';

/** How long the image takes to arrive on screen; the class below says it too. */
const FADE_MS = 200;

/** The blurred stand-in, decoded from the base64 thumbhash the asset carries. */
function placeholderUrl(thumbhash: string): string | null {
  try {
    return thumbHashToDataURL(Uint8Array.from(atob(thumbhash), (ch) => ch.charCodeAt(0)));
  } catch {
    // A hash we cannot read is a hash we do not draw; the image still loads.
    return null;
  }
}

/**
 * Every image the message's markdown holds, in the order it drew them.
 *
 * Read off the DOM rather than kept in a registry: the message body is split
 * into blocks that mount as they are written, so mount order is not document
 * order, and document order is the only order the arrow keys should walk in.
 *
 * The images a turn was sent with are their own group: they are drawn above the
 * body rather than inside it, and `[data-image-group]` is how that grid says so.
 */
function group(clicked: HTMLImageElement): { images: LightboxImage[]; index: number } {
  const scope = clicked.closest('.message-body, [data-image-group]');
  const found = scope ? [...scope.querySelectorAll<HTMLImageElement>('img[data-chat-image]')] : [clicked];
  // The attribute rather than `.src`: what the message asked for, still relative,
  // fragment and all — the download link hangs off it.
  const images = found.map((node) => ({ src: node.getAttribute('src') ?? '', alt: node.alt }));
  return { images, index: Math.max(0, found.indexOf(clicked)) };
}

/**
 * A character image inside a message.
 *
 * The three things it adds to a plain `<img>` all come from the same place: the
 * measurement the uploader took, carried in the src's fragment
 * (`lib/assets.ts`). Its size reserves the box before a byte of the image has
 * arrived, its thumbhash fills that box in the meantime, and the image fades in
 * over the top once it is there. An asset from before the measurement existed
 * has none of it and renders exactly as it did: clamped, and nothing else.
 */
export function ChatImage({ src, alt }: { src?: string | undefined; alt: string }) {
  const t = useTranslations('chat');
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  /** The placeholder outlives the load by one fade: the image comes in over it. */
  const [covered, setCovered] = useState(true);

  const meta = useMemo(() => (src ? readAssetMeta(src) : null), [src]);
  const placeholder = useMemo(
    () => (meta && covered ? placeholderUrl(meta.thumbhash) : null),
    [meta, covered],
  );

  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => setCovered(false), FADE_MS);
    return () => clearTimeout(timer);
  }, [loaded]);

  if (!src) return null;

  // The box is the image's own: `aspect-ratio` and the intrinsic size agree, and
  // with both dimensions auto the clamp still scales rather than letterboxes.
  const box: CSSProperties | undefined = meta
    ? { aspectRatio: `${meta.width} / ${meta.height}` }
    : undefined;

  if (failed) {
    return (
      <span
        data-testid="chat-image-error"
        // Where the image was, so it stands in the tree the way it stands on the
        // page: one thing, with a name. Not a live region — a message can hold a
        // dozen images and a reader does not need to be interrupted twelve times.
        role="img"
        aria-label={t('imageError')}
        style={box}
        className="my-2 flex max-h-96 max-w-full items-center justify-center rounded-xl border border-line bg-raised/40 px-4 py-6 text-xs text-muted"
      >
        {t('imageError')}
      </span>
    );
  }

  return (
    <span
      className="my-2 inline-block max-w-full overflow-hidden rounded-xl bg-cover bg-center align-middle"
      style={placeholder ? { backgroundImage: `url(${placeholder})` } : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        data-chat-image=""
        {...(meta ? { width: meta.width, height: meta.height } : {})}
        style={box}
        // Focusable, because opening the image is a thing to do and a mouse is
        // not the only way to do it. The name is the action, not an invented
        // description — the image's own alt names it when it has one.
        tabIndex={0}
        role="button"
        aria-label={alt || t('viewImage')}
        className={cx(
          'block max-h-96 max-w-full cursor-zoom-in rounded-xl object-contain transition-opacity duration-200 motion-reduce:transition-none',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          // Without a placeholder there is nothing behind the image, so fading
          // it in would only mean showing a hole for a moment.
          loaded || !placeholder ? 'opacity-100' : 'opacity-0',
        )}
        // A cached image can be complete before React attaches onLoad.
        ref={(node) => {
          if (node?.complete && node.naturalWidth > 0) setLoaded(true);
        }}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        onClick={(event) => setOpened(group(event.currentTarget))}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setOpened(group(event.currentTarget));
        }}
      />
      {opened ? (
        <Lightbox images={opened.images} index={opened.index} onClose={() => setOpened(null)} />
      ) : null}
    </span>
  );
}
