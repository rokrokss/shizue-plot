// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ended = vi.fn();
let session: unknown = null;
vi.mock('../src/lib/scripts/lua/readerSandbox', () => ({ endReaderLuaSandbox: () => ended() }));
vi.mock('../src/lib/api', () => ({
  apiGet: () => Promise.resolve(session),
  apiSend: () => Promise.resolve({}),
}));

const reader = (id: string) => ({ user: { id, name: id, email: `${id}@example.com`, image: null } });

describe('the session and the reader’s Lua sandbox', () => {
  beforeEach(() => {
    ended.mockClear();
  });

  it('ends the sandbox on signing out, and when the session names another reader or none', async () => {
    const { refreshSession, signOut } = await import('../src/lib/authClient');
    session = reader('a');
    await refreshSession();
    await refreshSession();
    expect(ended).not.toHaveBeenCalled();

    session = reader('b');
    await refreshSession();
    expect(ended).toHaveBeenCalledTimes(1);

    ended.mockClear();
    session = null;
    await signOut();
    // Once for the sign-out itself, once for the session that no longer names anyone.
    expect(ended).toHaveBeenCalledTimes(2);
  });
});
