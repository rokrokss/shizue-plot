import { ChatGPTConnection } from '@/components/ChatGPTConnection';
import { DevicePairing } from '@/components/DevicePairing';

/** `error` is the code a ChatGPT connection that failed came back with (the API's callback). */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return (
    <div className="mx-auto w-full max-w-xl space-y-6 px-4 py-8">
      <ChatGPTConnection error={typeof error === 'string' ? error : undefined} />
      <DevicePairing />
    </div>
  );
}
