'use client';

import { useTranslations } from 'next-intl';
import { useBgmMute } from '@/lib/bgmMute';
import { Icon } from './Icon';
import { Button } from './ui';

/**
 * The chat header's music mute, there only while the page has music to mute
 * (`useBgmMute`). Icon-only and round, as the composer's attach button; its name
 * says what a press does, as the emotion screen's fold does.
 */
export function BgmMute() {
  const t = useTranslations('chat');
  const { present, muted, toggle } = useBgmMute();
  if (!present) return null;
  const label = muted ? t('bgmUnmute') : t('bgmMute');

  return (
    <Button
      size="sm"
      variant="ghost"
      data-testid="bgm-mute"
      aria-label={label}
      title={label}
      // Tucked against the badge beside it: on a phone the title is what gives way.
      className="-mx-1.5 shrink-0 rounded-full! px-2!"
      onClick={toggle}
    >
      <Icon name={muted ? 'volumeOff' : 'volume'} className="size-4" />
    </Button>
  );
}
