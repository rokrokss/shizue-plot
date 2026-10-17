import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REALM_ORIGIN } from '@/lib/realm';
import { THEME_SCRIPT } from '@/lib/theme';
import { contentSecurityPolicy, securityHeaders, storeOrigin } from '../securityHeaders';

const directive = (policy: string, name: string): string[] =>
  policy.split('; ').find((part) => part.startsWith(`${name} `))?.split(' ').slice(1) ?? [];

describe('page security headers', () => {
  it('hold pictures, music, fonts and connections to our origin, with Realm and the store beside it', () => {
    const policy = contentSecurityPolicy({
      STORAGE_DRIVER: 's3', S3_BUCKET: 'shizue-media', S3_ENDPOINT: 'http://localhost:19000', S3_FORCE_PATH_STYLE: 'true',
    }, 'n0nce');
    expect(directive(policy, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(directive(policy, 'media-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(directive(policy, 'font-src')).toEqual(["'self'", 'data:']);
    expect(directive(policy, 'connect-src')).toEqual(["'self'", REALM_ORIGIN, 'http://localhost:19000']);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
    expect(directive(policy, 'base-uri')).toEqual(["'self'"]);
    expect(directive(policy, 'form-action')).toEqual(["'self'"]);
    expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"]);
  });

  it('name the store the API presigns parts for', () => {
    expect(storeOrigin({})).toBeNull();
    expect(storeOrigin({ STORAGE_DRIVER: 'local', S3_ENDPOINT: 'http://localhost:19000' })).toBeNull();
    const s3 = { STORAGE_DRIVER: 's3', S3_BUCKET: 'media', S3_ENDPOINT: 'http://minio.internal:9000' };
    expect(storeOrigin({ ...s3, S3_FORCE_PATH_STYLE: '1' })).toBe('http://minio.internal:9000');
    expect(storeOrigin({ ...s3, S3_PUBLIC_ENDPOINT: 'https://media.example.com/', S3_FORCE_PATH_STYLE: 'true' }))
      .toBe('https://media.example.com');
    expect(storeOrigin({ ...s3, S3_PUBLIC_ENDPOINT: 'https://r2.example.com' })).toBe('https://media.r2.example.com');
    expect(storeOrigin({ STORAGE_DRIVER: 's3', S3_BUCKET: 'media', S3_REGION: 'ap-northeast-2' }))
      .toBe('https://media.s3.ap-northeast-2.amazonaws.com');
  });

  it('run only our files, the scripts carrying the nonce and the theme script, and eval nothing outside next dev', () => {
    const theme = `'sha256-${createHash('sha256').update(THEME_SCRIPT).digest('base64')}'`;
    expect(directive(contentSecurityPolicy({ NODE_ENV: 'production' }, 'n0nce'), 'script-src'))
      .toEqual(["'self'", "'nonce-n0nce'", theme]);
    expect(directive(contentSecurityPolicy({ NODE_ENV: 'development' }, 'n0nce'), 'script-src')).toContain("'unsafe-eval'");
  });

  it('send HSTS only over https, let our pages frame the sandbox documents, and leave /api to the API', () => {
    /** The headers a path gets: Next reads each `source` as `/` and the pattern after `:path`. */
    const on = (path: string, env: Record<string, string> = {}): string[] =>
      securityHeaders(env)
        .filter((rule) => new RegExp(`^${rule.source.replace('/:path', '/')}$`).test(path))
        .flatMap((rule) => rule.headers.map((header) => header.key));
    expect(on('/ko/chats/1')).toEqual(['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']);
    // Framed by our pages, which their own policy allows.
    expect(on('/sandbox/component.html')).toEqual(['X-Content-Type-Options', 'Referrer-Policy']);
    expect(on('/api/chats')).toEqual([]);
    expect(on('/ko', { BETTER_AUTH_URL: 'https://plot.example' })).toContain('Strict-Transport-Security');
    expect(on('/ko', { BETTER_AUTH_URL: 'http://localhost:13000' })).not.toContain('Strict-Transport-Security');
  });
});
