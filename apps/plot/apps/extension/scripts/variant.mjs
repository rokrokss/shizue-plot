// Builds the sign-in helper for a set of web origins.
//
//   node scripts/variant.mjs --out <dir> --target <origin>=<loopbackPort> [--target ...]
//
// Without arguments it rewrites this folder for local development, which is what
// the committed manifest.json and rules.json are. Each target pairs a web origin
// with the loopback port its API registers as the OpenAI redirect
// (CHATGPT_CALLBACK_PORT); the port is the only part of the redirect URI that
// may differ between environments.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CALLBACK_PATH = '/api/chatgpt/callback';
export const DEFAULT_TARGETS = [{ origin: 'http://localhost:13000', loopbackPort: 47801 }];
// Public half of the key that pins the unpacked extension's ID to
// naclpiefafceoehanglehokfnibaicle, so the web app knows whom to ask.
export const KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxKkRdhhHeJ7Kbb6/IlIvDD3+KvLFV4vOgMcCnVrfhlN5aFvBOCCOw4W3K9MgaZ7euwz7xOczgNQ3CEHMuRevFAtpjxrfW50AIM01K2fLFVsBBLMTRPVdzwucfiiTUS6QpaUiJwTaB9HJ2jmzvmI/8TfAAliHj5iiwhJopCn0Snso4vWW4sxGmDqaa/5c62uxiWf2+/2kA7VtpNVIASTO+qTGQdrFuSdaHIWsr7odq2mxFGBRK2JMLcVEbrW/0jK1GVj3tjUKO3i6x8f7aW2nF0G2L53wOSm7QRXssi8fpteNaZbcEW2nAgAh/HDtEf9hWD5JL5DE4OkrxaR+mWZnkQIDAQAB';

export function buildFiles(targets) {
  if (!targets.length) throw new Error('At least one target is required.');
  const origins = targets.map(({ origin, loopbackPort }) => {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error(`Not a web origin: ${origin}`);
    if (!Number.isInteger(loopbackPort) || loopbackPort < 1024 || loopbackPort > 65535) throw new Error(`Bad loopback port: ${loopbackPort}`);
    return { url, loopbackPort };
  });
  if (new Set(origins.map((o) => o.loopbackPort)).size !== origins.length) throw new Error('Each target needs its own loopback port.');
  const manifest = {
    manifest_version: 3,
    name: 'shizue sign-in helper',
    description: 'Completes Sign in with ChatGPT for the shizue web app.',
    version: '0.1.0',
    key: KEY,
    permissions: ['declarativeNetRequestWithHostAccess'],
    // Only the loopback callback is read or changed.
    host_permissions: ['http://127.0.0.1/*'],
    background: { service_worker: 'sw.js' },
    // Match patterns ignore ports, so one entry covers every port on a host.
    externally_connectable: { matches: [...new Set(origins.map(({ url }) => `${url.protocol}//${url.hostname}/*`))] },
    declarative_net_request: { rule_resources: [{ id: 'callback', enabled: true, path: 'rules.json' }] },
  };
  const rules = origins.map(({ url, loopbackPort }, index) => ({
    id: index + 1,
    priority: 1,
    condition: { urlFilter: `|http://127.0.0.1:${loopbackPort}/auth/callback?`, resourceTypes: ['main_frame'] },
    // A transform keeps the query (code, state, client_id); only these parts change.
    action: { type: 'redirect', redirect: { transform: { scheme: url.protocol.slice(0, -1), host: url.hostname, port: url.port, path: CALLBACK_PATH } } },
  }));
  return { manifest, rules };
}

export async function writeVariant(out, targets) {
  const { manifest, rules } = buildFiles(targets);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(out, 'rules.json'), `${JSON.stringify(rules, null, 2)}\n`);
  if (resolve(out) !== ROOT) await copyFile(join(ROOT, 'sw.js'), join(out, 'sw.js'));
}

function parseArgs(argv) {
  let out = ROOT;
  const targets = [];
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--out' && value) out = resolve(value);
    else if (flag === '--target' && value?.includes('=')) {
      const at = value.lastIndexOf('=');
      targets.push({ origin: value.slice(0, at), loopbackPort: Number(value.slice(at + 1)) });
    } else throw new Error(`Usage: variant.mjs --out <dir> --target <origin>=<port> [...]`);
  }
  return { out, targets: targets.length ? targets : DEFAULT_TARGETS };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { out, targets } = parseArgs(process.argv.slice(2));
  await writeVariant(out, targets);
  console.log(`wrote ${out}`);
}
