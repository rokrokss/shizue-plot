/**
 * Whether this build lets a phone in: only a shizue running on the reader's own
 * machine, which signs in on loopback (next.config.ts), never the hosted app,
 * where the API has no `/api/devices` either.
 */
export const DEVICE_PAIRING = process.env.NEXT_PUBLIC_DEVICE_PAIRING === '1';
