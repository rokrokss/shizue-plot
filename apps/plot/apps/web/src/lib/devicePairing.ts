/**
 * Whether this build lets a phone in: only a web origin on loopback
 * (`BETTER_AUTH_URL`, next.config.ts), as the API has `/api/devices` only then.
 */
export const DEVICE_PAIRING = process.env.NEXT_PUBLIC_DEVICE_PAIRING === '1';
