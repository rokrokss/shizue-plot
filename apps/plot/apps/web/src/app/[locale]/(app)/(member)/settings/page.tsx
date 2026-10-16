import { ChatGPTConnection } from '@/components/ChatGPTConnection';
import { DevicePairing } from '@/components/DevicePairing';

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-xl space-y-6 px-4 py-8">
      <ChatGPTConnection />
      <DevicePairing />
    </div>
  );
}
