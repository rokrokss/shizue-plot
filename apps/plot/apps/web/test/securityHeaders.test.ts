import { describe, expect, it } from 'vitest';
import { REALM_ORIGIN } from '@/lib/realm';
import { contentSecurityPolicy, securityHeaders, storeOrigin } from '../securityHeaders';

const directive = (policy: string, name: string): string[] =>
  policy.split('; ').find((part) => part.startsWith(`${name} `))?.split(' ').slice(1) ?? [];

describe('page security headers', () => {
  it('hold pictures, music, fonts and connections to our origin, with Realm and the store beside it', () => {
    const policy = contentSecurityPolicy({
      STORAGE_DRIVER: 's3', S3_BUCKET: 'shizue-media', S3_ENDPOINT: 'http://localhost:19000', S3_FORCE_PATH_STYLE: 'true',
    });
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

  it('open no script to eval outside next dev', () => {
    expect(directive(contentSecurityPolicy({ NODE_ENV: 'production' }), 'script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(contentSecurityPolicy({ NODE_ENV: 'development' }), 'script-src')).toContain("'unsafe-eval'");
  });

  it('send HSTS only over https, keep the page policy off the sandbox documents, and leave /api to the API', () => {
    /** The headers a path gets: Next reads each `source` as `/` and the pattern after `:path`. */
    const on = (path: string, env: Record<string, string> = {}): string[] =>
      securityHeaders(env)
        .filter((rule) => new RegExp(`^${rule.source.replace('/:path', '/')}$`).test(path))
        .flatMap((rule) => rule.headers.map((header) => header.key));
    expect(on('/ko/chats/1')).toEqual(['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Content-Security-Policy']);
    // Framed by our pages, and carrying only their own policy.
    expect(on('/sandbox/component.html')).toEqual(['X-Content-Type-Options', 'Referrer-Policy']);
    // A worker script takes its own response's policy.
    expect(on('/_next/static/chunks/a.js')).not.toContain('Content-Security-Policy');
    expect(on('/api/chats')).toEqual([]);
    expect(on('/ko', { BETTER_AUTH_URL: 'https://plot.example' })).toContain('Strict-Transport-Security');
    expect(on('/ko', { BETTER_AUTH_URL: 'http://localhost:13000' })).not.toContain('Strict-Transport-Security');
  });
});
