/**
 * The shizue sign-in helper: a companion Chrome extension that sends OpenAI's
 * loopback callback (`http://127.0.0.1:<port>/auth/callback`) on to this site,
 * which a hosted page cannot otherwise receive.
 */

/** Pinned by the `key` in the extension's manifest. */
export const EXTENSION_ID = process.env.NEXT_PUBLIC_CHATGPT_EXTENSION_ID || 'naclpiefafceoehanglehokfnibaicle';

/** An install page, once there is one; until then the login page explains loading it unpacked. */
export const EXTENSION_URL = process.env.NEXT_PUBLIC_CHATGPT_EXTENSION_URL || null;

interface Runtime {
  lastError?: unknown;
  sendMessage(extensionId: string, message: unknown, reply: (response: unknown) => void): void;
}

/**
 * Whether the helper answers a ping. A page only gets `chrome.runtime` when some
 * installed extension accepts messages from it, and a missing helper reports
 * through `lastError` — both are "not installed", and so is a helper that never
 * answers.
 */
export function detectExtension(timeoutMs = 1500): Promise<boolean> {
  const runtime = (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;
  if (typeof runtime?.sendMessage !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const settle = (found: boolean): void => { clearTimeout(timer); resolve(found); };
    try {
      runtime.sendMessage(EXTENSION_ID, { type: 'ping' }, (response) => {
        // Reading lastError here is also what keeps Chrome from logging it as unchecked.
        settle(!runtime.lastError && (response as { ok?: unknown } | undefined)?.ok === true);
      });
    } catch {
      settle(false);
    }
  });
}
