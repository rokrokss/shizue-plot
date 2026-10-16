import { notFound } from 'next/navigation';
import { PairDevice } from '@/components/DevicePairing';
import { DEVICE_PAIRING } from '@/lib/devicePairing';

/**
 * Where a phone lands from the QR code a signed-in browser showed it (settings →
 * 휴대폰 연결). Only a shizue running on the reader's own machine has it.
 */
export default function PairPage() {
  if (!DEVICE_PAIRING) notFound();
  return <PairDevice />;
}
