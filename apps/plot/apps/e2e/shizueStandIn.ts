import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A stand-in for Shizue, the Chrome Web Store extension readers sign in through:
 * its loopback callback rule and its presence answer (rokrokss/shizue,
 * `src/public/plot-signin-rules.json` and `src/lib/plotSignIn.ts`), for the one
 * origin and port a browser test runs on. The store build cannot be loaded here,
 * and its rules point at the production and development origins, not at a test's.
 *
 * The key pins the unpacked extension's ID, and the test web server is told that
 * ID (`NEXT_PUBLIC_CHATGPT_EXTENSION_ID`, playwright.config.ts) so the login page
 * asks it alongside Shizue's own.
 */
export const STAND_IN_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxKkRdhhHeJ7Kbb6/IlIvDD3+KvLFV4vOgMcCnVrfhlN5aFvBOCCOw4W3K9MgaZ7euwz7xOczgNQ3CEHMuRevFAtpjxrfW50AIM01K2fLFVsBBLMTRPVdzwucfiiTUS6QpaUiJwTaB9HJ2jmzvmI/8TfAAliHj5iiwhJopCn0Snso4vWW4sxGmDqaa/5c62uxiWf2+/2kA7VtpNVIASTO+qTGQdrFuSdaHIWsr7odq2mxFGBRK2JMLcVEbrW/0jK1GVj3tjUKO3i6x8f7aW2nF0G2L53wOSm7QRXssi8fpteNaZbcEW2nAgAh/HDtEf9hWD5JL5DE4OkrxaR+mWZnkQIDAQAB';
/** The ID `STAND_IN_KEY` pins. */
export const STAND_IN_ID = 'naclpiefafceoehanglehokfnibaicle';

/** What Shizue answers a page's ping with (`plotSignInPing`). */
const PING_ANSWER = { ok: true, version: '0.3.6', features: ['plotSignIn'] };

export async function writeShizueStandIn(dir: string, origin: string, loopbackPort: number): Promise<void> {
  const url = new URL(origin);
  const manifest = {
    manifest_version: 3,
    name: 'Shizue (e2e stand-in)',
    version: '0.3.6',
    key: STAND_IN_KEY,
    permissions: ['declarativeNetRequestWithHostAccess'],
    host_permissions: ['http://127.0.0.1/*'],
    background: { service_worker: 'sw.js' },
    // Match patterns ignore ports, so one entry covers every port on the host.
    externally_connectable: { matches: [`${url.protocol}//${url.hostname}/*`] },
    declarative_net_request: { rule_resources: [{ id: 'plot_signin', enabled: true, path: 'rules.json' }] },
  };
  const rules = [
    {
      id: 1,
      priority: 1,
      condition: { urlFilter: `|http://127.0.0.1:${loopbackPort}/auth/callback?`, resourceTypes: ['main_frame'] },
      // A transform keeps the query (code, state, client_id); only these parts change.
      action: {
        type: 'redirect',
        redirect: {
          transform: { scheme: url.protocol.slice(0, -1), host: url.hostname, port: url.port, path: '/api/chatgpt/callback' },
        },
      },
    },
  ];
  const worker = `chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.type === 'ping') reply(${JSON.stringify(PING_ANSWER)});
});
`;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, 'rules.json'), `${JSON.stringify(rules, null, 2)}\n`);
  await writeFile(join(dir, 'sw.js'), worker);
}
