import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { securityHeaders } from './securityHeaders';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
// A shizue whose web origin is this machine's (loopback) lets a phone in, through
// a tunnel the settings page opens (the API's `tunnel.ts`) or one the owner lists
// in `REMOTE_ORIGINS`. Unset is not local: a build that forgot the variable shows
// none of it (the app's process sets it before Next reads this file, and the
// package's build sets it for `next build`).
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
  // `/api/*` never reaches Next: the app's process hands it to the API before
  // (apps/api/src/server.ts), so no rewrite proxies it — and no body limit or
  // timeout of a proxy's stands in its way.
  async headers() {
    return securityHeaders();
  },
};

export default withNextIntl(nextConfig);
