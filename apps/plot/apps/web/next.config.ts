import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { securityHeaders } from './securityHeaders';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const apiOrigin = process.env['API_ORIGIN'] ?? 'http://localhost:8787';
// A shizue whose web origin is this machine's (loopback) lets a phone in, through
// a tunnel the settings page opens (the API's `tunnel.ts`) or one the owner lists
// in `REMOTE_ORIGINS`. Unset is not local: a
// build that forgot the variable shows none of it (`scripts/dev.sh` always sets it).
const authUrl = process.env['BETTER_AUTH_URL'];
const local = authUrl !== undefined && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(authUrl).hostname);
const remoteHosts = (process.env['REMOTE_ORIGINS'] ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  .map((value) => new URL(value).hostname);
// `next dev` refuses `/_next/*` (the HMR socket among them) from any other host:
// Tailscale Serve's `<machine>.<tailnet>.ts.net` and a Quick Tunnel's
// `<words>.trycloudflare.com` are not known until the tunnel opens.
const tunnelHosts = local ? ['**.ts.net', '*.trycloudflare.com', ...remoteHosts] : [];

const nextConfig: NextConfig = {
  devIndicators: false,
  agentRules: false,
  allowedDevOrigins: tunnelHosts,
  env: { NEXT_PUBLIC_DEVICE_PAIRING: local ? '1' : '' },
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
  async headers() {
    return securityHeaders();
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default withNextIntl(nextConfig);
