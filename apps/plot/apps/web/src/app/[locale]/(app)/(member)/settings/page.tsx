import { getTranslations } from 'next-intl/server';
import { SettingsHub } from '@/components/SettingsNav';
import { ModelsSettings } from '@/components/SettingsPage';

/**
 * `/settings`: on a narrow screen the list of 설정's sections, and beside the
 * sidebar on a wide one its first, 모델과 연결. ChatGPT's callback comes back
 * here with `error`, the code a connection that failed came back with, and that
 * shows the section at every width.
 */
export default async function SettingsIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const chatgptError = typeof error === 'string' ? error : undefined;
  const t = await getTranslations('settings');
  return (
    <>
      {chatgptError ? null : (
        <div className="lg:hidden">
          <SettingsHub />
        </div>
      )}
      <div className={chatgptError ? undefined : 'hidden lg:block'}>
        <ModelsSettings documentTitle={t('title')} {...(chatgptError ? { chatgptError } : {})} />
      </div>
    </>
  );
}
