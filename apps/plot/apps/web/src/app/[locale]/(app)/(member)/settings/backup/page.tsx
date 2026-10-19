'use client';

import { useTranslations } from 'next-intl';
import { BackupSettings } from '@/components/BackupSettings';
import { DevicePairing } from '@/components/DevicePairing';
import { SettingsPage } from '@/components/SettingsPage';
import { DEVICE_PAIRING } from '@/lib/devicePairing';

/** 설정 › 휴대폰 연결과 백업, or the backup alone where this app cannot pair a phone. */
export default function BackupSettingsPage() {
  const t = useTranslations('settings');
  return (
    <SettingsPage title={DEVICE_PAIRING ? t('items.phoneAndBackup') : t('items.backup')}>
      <DevicePairing />
      <BackupSettings />
    </SettingsPage>
  );
}
