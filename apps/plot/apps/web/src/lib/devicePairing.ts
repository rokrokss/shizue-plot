/**
 * Whether this build lets a phone in: only a web origin on loopback
 * (`BETTER_AUTH_URL`, next.config.ts), as the API has `/api/devices` only then.
 */
export const DEVICE_PAIRING = process.env.NEXT_PUBLIC_DEVICE_PAIRING === '1';

/** `GET /api/devices/phones`: a phone this computer let in. */
export interface PairedPhone {
  id: string;
  pairedAt: string;
  /** Its latest request, to the minute. */
  lastSeenAt: string;
  /** The browser it paired from, as it said; null when it said nothing. */
  userAgent: string | null;
}

/** A phone as its browser names it — `iPhone · Safari` — or null when the browser said nothing to go by. */
export function phoneName(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const device = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Macintosh/.test(userAgent)
          ? 'Mac'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : null;
  const browser = /SamsungBrowser/.test(userAgent)
    ? 'Samsung Internet'
    : /CriOS|Chrome\//.test(userAgent)
      ? 'Chrome'
      : /FxiOS|Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : null;
  const name = [device, browser].filter(Boolean).join(' · ');
  return name || null;
}
