'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { apiGet, apiSend } from './api';

interface Session { user: { id: string; name: string; email: string; image: string | null } }
interface State { data: Session | null; isPending: boolean }
const initial: State = { data: null, isPending: true };
let state = initial;
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = (): State => state;
const serverSnapshot = (): State => initial;

function loadSession(): Promise<void> {
  if (pending) return pending;
  pending = apiGet<Session | null>('/api/auth/get-session', AbortSignal.timeout(10_000))
    .then((data) => { state = { data, isPending: false }; })
    .catch(() => { state = { data: null, isPending: false }; })
    .finally(() => { pending = undefined; for (const listener of listeners) listener(); });
  return pending;
}

/** OAuth finishes in another window; refresh after any older session read lands. */
export async function refreshSession(): Promise<void> {
  await pending;
  await loadSession();
}

export function useSession(): State {
  const value = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => {
    void loadSession();
    const focus = (): void => { void loadSession(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  return value;
}

export async function signOut(): Promise<void> {
  await apiSend('POST', '/api/auth/sign-out', {}, AbortSignal.timeout(45_000));
  await refreshSession();
}
