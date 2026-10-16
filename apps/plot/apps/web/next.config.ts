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
    // larger body never reaches the API whole. Card and module files no longer
    // come through here in one body (they go up in parts, `lib/fileImport.ts`):
    // the largest body now is the request that starts an import with a
    // SillyTavern World Info file in it (`MAX_WORLD_INFO_BYTES`, 32MB, as a JSON
    // string, whose escapes can double it — the API's own limit for the route,
    // apps/api/src/app.ts). The local storage driver's 8MB parts come through
    // here too, under the default already.
    proxyClientMaxBodySize: '65mb',
    // How long the rewrite waits on a quiet API socket — 30s by default. Some
    // answers come only once their work is done: a plot draft waits on the
    // reader's model (`POST /api/plots/draft`), which can be quiet longer than
    // that. (Card imports were one of them until they became a job.)
    proxyTimeout: 180_000,
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default withNextIntl(nextConfig);
