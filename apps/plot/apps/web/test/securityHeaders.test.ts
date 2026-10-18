import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REALM_ORIGIN } from '@/lib/realm';
import { THEME_SCRIPT } from '@/lib/theme';
import { contentSecurityPolicy, securityHeaders } from '../securityHeaders';

const directive = (policy: string, name: string): string[] =>
  policy.split('; ').find((part) => part.startsWith(`${name} `))?.split(' ').slice(1) ?? [];

describe('page security headers', () => {
  it('hold pictures, music, fonts and connections to our origin, with Realm beside it', () => {
    const policy = contentSecurityPolicy({}, 'n0nce');
    expect(directive(policy, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(directive(policy, 'media-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(directive(policy, 'font-src')).toEqual(["'self'", 'data:']);
    expect(directive(policy, 'connect-src')).toEqual(["'self'", REALM_ORIGIN]);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
    expect(directive(policy, 'base-uri')).toEqual(["'self'"]);
    expect(directive(policy, 'form-action')).toEqual(["'self'"]);
    expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"]);
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
