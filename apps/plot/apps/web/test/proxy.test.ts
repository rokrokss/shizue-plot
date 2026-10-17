import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

// next-intl's own build cannot load outside Next. Stood in for by what it does
// with a page request: forward a copy of the request's headers, its locale added.
vi.mock('next-intl/middleware', () => ({
  default: () => (request: NextRequest) => NextResponse.next({ request: { headers: new Headers(request.headers) } }),
}));

const { default: proxy } = await import('@/proxy');

const scriptSrc = (policy: string | null): string[] =>
  (policy ?? '').split('; ').find((part) => part.startsWith('script-src '))?.split(' ').slice(1) ?? [];

describe('the page policy', () => {
  it('carries a nonce of its own on every page, and hands it to Next with the request', () => {
    const first = proxy(new NextRequest('https://plot.example/ko/chats/1'));
    const policy = first.headers.get('content-security-policy');
    const nonce = /'nonce-([A-Za-z0-9+/=]{22,})'/.exec(policy ?? '')?.[1];
    expect(nonce).toBeTruthy();
    // No inline script without it: a handler or `javascript:` the sanitizer missed runs nothing.
    expect(scriptSrc(policy)).not.toContain("'unsafe-inline'");
    // What Next renders the page from sees the same policy, so its scripts carry this nonce.
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(policy);

    const second = proxy(new NextRequest('https://plot.example/ko/chats/1'));
    expect(second.headers.get('content-security-policy')).not.toContain(`'nonce-${nonce}'`);
  });
});
