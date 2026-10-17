import { describe, expect, it } from 'vitest';
import { GET as componentDocument } from '@/app/sandbox/component.html/route';
import { GET as luaDocument } from '@/app/sandbox/lua.html/route';
import { componentFrameCsp } from '@/lib/componentRuntime';
import { luaFrameCsp } from '@/lib/scripts/lua/sandboxRuntime';

const get = (route: (request: Request) => Response, path: string, headers: Record<string, string> = {}): Response =>
  route(new Request(`https://plot.example${path}`, { headers }));

describe('the sandbox documents', () => {
  it('carry their own policy, as a header, and nothing of the page’s', async () => {
    const component = get(componentDocument, '/sandbox/component.html?scheme=light');
    expect(component.headers.get('content-security-policy')).toBe(componentFrameCsp());
    expect(component.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await component.text()).toContain('<html data-theme="light">');
    expect(await get(componentDocument, '/sandbox/component.html').text()).toContain('<html data-theme="dark">');

    const lua = get(luaDocument, '/sandbox/lua.html');
    expect(lua.headers.get('content-security-policy')).toBe(luaFrameCsp());
    expect(await lua.text()).toContain('<script>');
  });

  it('revalidate against their ETag rather than fetch the runtime again', async () => {
    const first = get(luaDocument, '/sandbox/lua.html');
    const etag = first.headers.get('etag')!;
    expect(first.headers.get('cache-control')).toBe('no-cache');
    const again = get(luaDocument, '/sandbox/lua.html', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    // Each scheme is its own document, so its own tag.
    const dark = get(componentDocument, '/sandbox/component.html').headers.get('etag');
    expect(get(componentDocument, '/sandbox/component.html?scheme=light', { 'if-none-match': dark! }).status).toBe(200);
  });
});
