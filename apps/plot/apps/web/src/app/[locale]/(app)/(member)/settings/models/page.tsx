import { ModelsSettings } from '@/components/SettingsPage';

/** 설정 › 모델과 연결. `error` is the code a ChatGPT connection that failed came back with. */
export default async function ModelsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return <ModelsSettings {...(typeof error === 'string' ? { chatgptError: error } : {})} />;
}
