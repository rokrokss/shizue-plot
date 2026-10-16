import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const apiOrigin = process.env['API_ORIGIN'] ?? 'http://localhost:8787';
// The API's `REMOTE_ORIGINS` — a tunnel to a shizue running on this machine, for a
// phone. `next dev` refuses `/_next/*` (the HMR socket among them) from any other
// host, and phone pairing is shown only where they are set, never in the hosted app.
const remoteHosts = (process.env['REMOTE_ORIGINS'] ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  .map((value) => new URL(value).hostname);

const nextConfig: NextConfig = {
  devIndicators: false,
  agentRules: false,
  allowedDevOrigins: remoteHosts,
  env: { NEXT_PUBLIC_DEVICE_PAIRING: remoteHosts.length > 0 ? '1' : '' },
  turbopack: {
    root: fileURLToPath(new URL('../../../../', import.meta.url)),
    rules: {
      // `import url from 'pkg/file?url'`: the file emitted unchanged, its address
      // imported — how the Lua sandbox gets wasmoon (`lib/scripts/lua/assets.ts`).
      '*': { condition: { query: '?url' }, type: 'asset' },
    },
  },
  experimental: {
    // The `/api` rewrite proxies a copy of the request body, and that copy stops
    // at this size — 10MB by default, with only a warning in the server log: a
    // larger card import never reaches the API whole. Sized to the API's own
    // body limit for card imports (`MAX_CARD_IMPORT_BYTES` + 1MB of framing,
    // apps/api/src/app.ts), so the API stays the one that answers 413.
    proxyClientMaxBodySize: '1025mb',
    // How long the rewrite waits on the API — 30s by default. A card import
    // fetches what the card loads from other hosts before it answers
    // (apps/api/src/localizeAssets.ts, 90s at most), so an import with a Korean
    // web font's hundreds of slices may take longer than that.
    proxyTimeout: 180_000,
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default withNextIntl(nextConfig);
