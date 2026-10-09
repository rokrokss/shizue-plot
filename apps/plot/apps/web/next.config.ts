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
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default withNextIntl(nextConfig);
