/**
 * The extension that sends OpenAI's loopback callback
 * (`http://127.0.0.1:<port>/auth/callback`) on to this site, which a hosted page
 * cannot otherwise receive. Shizue (the Chrome Web Store extension, 0.3.6 and
 * later) carries the rules for plot.shizue.net and localhost:13000; the sign-in
 * helper in apps/extension is the same rules on their own, loaded unpacked for
 * development or for another origin.
 */

/** Shizue on the Chrome Web Store. */
export const SHIZUE_EXTENSION_ID = 'mpcbgfkoholfgapcgcmfjobnfcbnfanm';
/** The unpacked sign-in helper, pinned by the `key` in its manifest. */
export const HELPER_EXTENSION_ID = 'naclpiefafceoehanglehokfnibaicle';

/** Asked in this order; a build may name one more (an unpacked Shizue has an ID of its own). */
export const EXTENSION_IDS: readonly string[] = [
  ...new Set([
    ...(process.env.NEXT_PUBLIC_CHATGPT_EXTENSION_ID ? [process.env.NEXT_PUBLIC_CHATGPT_EXTENSION_ID] : []),
    SHIZUE_EXTENSION_ID,
    HELPER_EXTENSION_ID,
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
 * An answer that means "I carry the sign-in": `ok`, and — when the extension
 * lists features at all, as Shizue does — this one among them. The helper lists
 * none; a Shizue too old to carry the rules never answers.
 */
function carriesSignIn(response: unknown): boolean {
  const reply = response as { ok?: unknown; features?: unknown } | undefined;
  if (reply?.ok !== true) return false;
  return !Array.isArray(reply.features) || reply.features.includes(PLOT_SIGNIN_FEATURE);
}

/**
 * Whether any of the extensions answers a ping. A page only gets
 * `chrome.runtime` when some installed extension accepts messages from it, and a
 * missing one reports through `lastError` — both are "not installed", and so is
 * one that never answers. They are asked together, and the first that carries the
 * sign-in settles it.
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
