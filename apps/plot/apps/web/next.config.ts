import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const apiOrigin = process.env['API_ORIGIN'] ?? 'http://localhost:8787';

const nextConfig: NextConfig = {
  devIndicators: false,
  agentRules: false,
  turbopack: {
    root: fileURLToPath(new URL('../../../../', import.meta.url)),
  },
  experimental: {
    // The `/api` rewrite proxies a copy of the request body, and that copy stops
    // at this size — 10MB by default, with only a warning in the server log: a
    // larger card import never reaches the API whole. Sized to the API's own
    // body limit for card imports (`MAX_CARD_IMPORT_BYTES` + 1MB of framing,
    // apps/api/src/app.ts), so the API stays the one that answers 413.
    proxyClientMaxBodySize: '51mb',
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default withNextIntl(nextConfig);
