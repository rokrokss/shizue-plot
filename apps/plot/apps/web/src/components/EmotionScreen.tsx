'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { readEmotionCollapsed, writeEmotionCollapsed, type EmotionSlot } from '@/lib/emotion';
import { Icon } from './Icon';
import { cx } from './ui';

/** How long one picture takes to give way to the next. */
const CROSSFADE_MS = 200;

interface Layer {
  src: string;
  loaded: boolean;
}

/**
 * One member's picture, crossfading into the next: the new one fades in over
 * the old once it has loaded, and the old one goes when the fade is done. With
 * reduced motion the global rule makes the fade a cut.
 */
function EmotionPicture({ src, alt }: { src: string | null; alt: string }) {
  const [layers, setLayers] = useState<Layer[]>(src ? [{ src, loaded: false }] : []);
  const [shown, setShown] = useState(src);
  if (src !== shown) {
    setShown(src);
    // What has already loaded stays under the new picture until it is in.
    setLayers((current) => [
      ...current.filter((layer) => layer.loaded && layer.src !== src).slice(-1),
      ...(src ? [{ src, loaded: false }] : []),
    ]);
  }
  const top = layers.at(-1);
  const settled = top?.loaded === true && layers.length > 1;
  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => setLayers((current) => current.slice(-1)), CROSSFADE_MS);
    return () => clearTimeout(timer);
  }, [settled]);

  return (
    <>
      {layers.map((layer, index) => {
        const isTop = index === layers.length - 1;
        return (
          <img
            key={layer.src}
            src={layer.src}
            alt={isTop ? alt : ''}
            aria-hidden={isTop ? undefined : true}
            draggable={false}
            onLoad={() =>
              setLayers((current) => current.map((item) => (item.src === layer.src ? { ...item, loaded: true } : item)))
            }
            className={cx(
              'absolute inset-0 size-full object-contain transition-opacity duration-200',
              isTop ? (layer.loaded ? 'opacity-100' : 'opacity-0') : top?.loaded ? 'opacity-0' : 'opacity-100',
            )}
          />
        );
      })}
    </>
  );
}

/**
 * RisuAI's emotion box: each panel member's picture, side by side, the width
 * split between them as RisuAI's `EmotionBox` splits it. On a narrow screen it
 * is a portrait band at the top of the chat that folds to a slim bar — the fold
 * remembered per chat — and on a wide one a column beside the chat, full height.
 */
export function EmotionScreen({ chatId, slots }: { chatId: string; slots: readonly EmotionSlot[] }) {
  const t = useTranslations('chat');
  // Read on the first render — the chat only draws this once its state has come
  // in the browser, so there is no server markup to disagree with — and again
  // for another chat on the same page.
  const [collapsed, setCollapsed] = useState(() => readEmotionCollapsed(chatId));
  useEffect(() => setCollapsed(readEmotionCollapsed(chatId)), [chatId]);

  const toggle = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    writeEmotionCollapsed(chatId, next);
  };

  return (
    <section
      data-testid="emotion-screen"
      aria-label={t('emotionScreen')}
      className={cx(
        'relative shrink-0 overflow-hidden border-b border-line bg-bubble',
        'lg:h-auto lg:w-2/5 lg:border-r lg:border-b-0',
        collapsed ? 'h-9' : 'h-[33dvh]',
      )}
    >
      <div className={cx('size-full', collapsed ? 'hidden lg:flex' : 'flex')}>
        {slots.map((slot) => (
          <div key={slot.memberId} data-testid="emotion-slot" data-emotion={slot.emotion ?? ''} className="relative h-full min-w-0 flex-1">
            <EmotionPicture
              src={slot.src}
              alt={slot.emotion ? t('emotionAlt', { name: slot.name, emotion: slot.emotion }) : slot.name}
            />
          </div>
        ))}
      </div>
      {collapsed ? (
        <span className="absolute top-1/2 left-5 -translate-y-1/2 text-xs text-muted lg:hidden">{t('emotionScreen')}</span>
      ) : null}
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('emotionExpand') : t('emotionCollapse')}
        title={collapsed ? t('emotionExpand') : t('emotionCollapse')}
        onClick={toggle}
        className="absolute top-1 right-3 flex size-7 items-center justify-center rounded-full border border-line bg-surface/80 text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden"
      >
        <Icon name="chevron" className={cx('size-4', collapsed ? '' : 'rotate-180')} />
      </button>
    </section>
  );
}
