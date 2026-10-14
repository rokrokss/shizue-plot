'use client';

import { useTranslations } from 'next-intl';
import { useBgmMute } from '@/lib/bgmMute';
import { Icon } from './Icon';
import { Button, cx } from './ui';

/**
 * The chat's music mute, there only while the page has music to mute
 * (`useBgmMute`). In the wide header it is icon-only and round, as the
 * composer's attach button; on a phone, whose header row gives the title its
 * room, it is a `row` of the settings sheet, its words beside the icon. Either
 * way its name says what a press does, as the emotion screen's fold does.
 */
export function BgmMute({ row = false, className }: { row?: boolean; className?: string }) {
  const t = useTranslations('chat');
  const { present, muted, toggle } = useBgmMute();
  if (!present) return null;
  const label = muted ? t('bgmUnmute') : t('bgmMute');
  const icon = <Icon name={muted ? 'volumeOff' : 'volume'} className="size-4" />;

  if (row) {
    return (
      <Button variant="ghost" data-testid="bgm-mute" className={cx('w-full gap-2', className)} onClick={toggle}>
        {icon}
        {label}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      data-testid="bgm-mute"
      aria-label={label}
      title={label}
      // Tucked against the badge beside it.
      className={cx('-mx-1.5 shrink-0 rounded-full! px-2!', className)}
      onClick={toggle}
    >
      {icon}
    </Button>
  );
}
