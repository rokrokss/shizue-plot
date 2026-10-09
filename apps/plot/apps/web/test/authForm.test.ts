// @vitest-environment jsdom
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;
const replace = vi.fn<(href: string) => void>();
let session: { user: { id: string } } | null = null;
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/lib/authClient', () => ({ useSession: () => ({ data: session }) }));
let entrance: Record<string, unknown> = {};
vi.mock('../src/components/ChatGPTConnection', () => ({
  ChatGPTConnection: (props: Record<string, unknown>) => { entrance = props; return createElement('button', null, 'ChatGPT로 로그인'); },
}));
const { AuthForm } = await import('../src/components/AuthForm');
let host: HTMLElement;
let root: Root;
const render = async (next?: string, error?: string | string[]) => act(async () => {
  root.render(createElement(NextIntlClientProvider, { locale: 'ko', messages, children: createElement(AuthForm, { next, error }) }));
});
beforeEach(() => { session = null; replace.mockClear(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('ChatGPT-only entrance', () => {
  it('has one sign-in button and no email, password or signup form', async () => {
    await render();
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(host.textContent).toContain('ChatGPT로 로그인');
    expect(host.querySelector('input, form, a[href*="signup"]')).toBeNull();
    expect(document.title).toContain('ChatGPT로 로그인');
    expect(replace).not.toHaveBeenCalled();
  });
  it('returns to the intended page immediately after ChatGPT connects', async () => {
    await render('/settings');
    session = { user: { id: 'local-owner' } };
    await render('/settings');
    expect(replace).toHaveBeenCalledWith('/settings');
  });
  it('does not follow an external return URL', async () => {
    session = { user: { id: 'local-owner' } };
    await render('//evil.example');
    expect(replace).toHaveBeenCalledWith('/');
  });
  it('signs in toward the same internal path and shows the callback error', async () => {
    await render('//evil.example', 'chatgpt_login_declined');
    expect(entrance).toMatchObject({ entrance: true, next: '/', error: 'chatgpt_login_declined' });
    await render('/settings', ['a', 'b']);
    expect(entrance).toMatchObject({ next: '/settings', error: undefined });
  });
});
