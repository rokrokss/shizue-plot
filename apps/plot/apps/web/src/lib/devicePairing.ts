/**
 * Whether this build pairs phones: only a shizue running on the reader's own
 * machine with a tunnel to it (`REMOTE_ORIGINS`, next.config.ts), never the
 * hosted app, where the API has no `/api/devices` either.
 */
export const DEVICE_PAIRING = process.env.NEXT_PUBLIC_DEVICE_PAIRING === '1';
