/**
 * Shizue, the Chrome Web Store extension (0.3.6 and later), sends OpenAI's
 * loopback callback (`http://127.0.0.1:<port>/auth/callback`) on to this app: its
 * rule sends port 47801 to localhost:13000 (rokrokss/shizue,
 * `src/public/plot-signin-rules.json`). Connecting ChatGPT needs it.
 */

/** Shizue on the Chrome Web Store. */
export const SHIZUE_EXTENSION_ID = 'mpcbgfkoholfgapcgcmfjobnfcbnfanm';

/**
 * Asked in this order. A build may name one more — an unpacked Shizue has an ID
 * of its own, and so does the browser tests' stand-in for it.
 */
export const EXTENSION_IDS: readonly string[] = [
  ...new Set([
    ...(process.env.NEXT_PUBLIC_CHATGPT_EXTENSION_ID ? [process.env.NEXT_PUBLIC_CHATGPT_EXTENSION_ID] : []),
    SHIZUE_EXTENSION_ID,
  ]),
];

/** Where a reader gets it: Shizue's store page. */
export const EXTENSION_URL =
  process.env.NEXT_PUBLIC_CHATGPT_EXTENSION_URL || `https://chromewebstore.google.com/detail/${SHIZUE_EXTENSION_ID}`;

/** The feature Shizue names in its answer when it carries this site's sign-in. */
const PLOT_SIGNIN_FEATURE = 'plotSignIn';

interface Runtime {
  lastError?: unknown;
  sendMessage(extensionId: string, message: unknown, reply: (response: unknown) => void): void;
}

/**
 * An answer that means "I carry the sign-in": `ok`, and this feature among the
 * ones it lists. A Shizue too old to carry the rules never answers at all.
 */
function carriesSignIn(response: unknown): boolean {
  const reply = response as { ok?: unknown; features?: unknown } | undefined;
  return reply?.ok === true && Array.isArray(reply.features) && reply.features.includes(PLOT_SIGNIN_FEATURE);
}

/**
 * Whether Shizue answers a ping. A page only gets `chrome.runtime` when some
 * installed extension accepts messages from it, and a missing one reports
 * through `lastError` — both are "not installed", and so is one that never
 * answers. Every ID is asked at once, and the first that carries the sign-in
 * settles it.
 */
export function detectExtension(timeoutMs = 1500): Promise<boolean> {
  const runtime = (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;
  if (typeof runtime?.sendMessage !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    let pending = EXTENSION_IDS.length;
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const settle = (found: boolean): void => {
      pending -= 1;
      if (found || pending === 0) {
        clearTimeout(timer);
        resolve(found);
      }
    };
    for (const id of EXTENSION_IDS) {
      try {
        runtime.sendMessage(id, { type: 'ping' }, (response) => {
          // Reading lastError here is also what keeps Chrome from logging it as unchecked.
          settle(!runtime.lastError && carriesSignIn(response));
        });
      } catch {
        settle(false);
      }
    }
  });
}
