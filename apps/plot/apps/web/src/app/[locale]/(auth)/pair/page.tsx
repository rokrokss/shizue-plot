import { notFound } from 'next/navigation';
import { PairDevice } from '@/components/DevicePairing';
import { DEVICE_PAIRING } from '@/lib/devicePairing';

/**
 * Where a phone lands from the QR code this computer's settings showed it
 * (설정 → 휴대폰 연결), and where a phone that left, or was never paired, is told
 * how to come in.
 */
export default function PairPage() {
  if (!DEVICE_PAIRING) notFound();
  return <PairDevice />;
}
