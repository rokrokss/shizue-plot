#!/usr/bin/env node
// `npx shizue-plot`: the app on this computer, on http://localhost:13000. Written
// for any Node npm runs on, so an older one hears what it needs rather than fails
// on syntax: the version is checked before the app itself is loaded.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_MAJOR = 26;
const APP_PORT = 13000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const major = Number(process.versions.node.split('.')[0]);
if (major < NODE_MAJOR) {
  console.error(
    `shizue-plot needs Node.js ${NODE_MAJOR} or newer, and this is Node.js ${process.version}.\n` +
      `It runs the Lua scripts some cards carry in a sandbox that needs Node's permission model.\n` +
      `Install Node.js ${NODE_MAJOR} (https://nodejs.org, or \`nvm install ${NODE_MAJOR}\`) and run \`npx shizue-plot\` again.`,
  );
  process.exit(1);
}

const USAGE = `shizue-plot ${version} — a character-chat app on this computer

Usage: npx shizue-plot [--port <n>] [--no-open]

  --port <n>   answer on another port than ${APP_PORT}. ChatGPT sign-in comes back
               to ${APP_PORT} only (the Shizue extension sends it there); API keys work anywhere.
  --no-open    do not open the browser.
  --version    print the version.

Your works and chats are kept in ${defaultDataDir()}
(SHIZUE_DATA_DIR names another folder). Ctrl-C stops the app.`;

/** Where the app keeps everything, as each system keeps an app's data. */
function defaultDataDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'shizue-plot');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'shizue-plot');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'shizue-plot');
}

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

let port = process.env.SHIZUE_PORT || String(APP_PORT);
let open = true;
const args = process.argv.slice(2);
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at];
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else if (arg === '--version' || arg === '-v') {
    console.log(version);
    process.exit(0);
  } else if (arg === '--no-open') {
    open = false;
  } else if (arg === '--port' || arg.startsWith('--port=')) {
    port = arg === '--port' ? args[(at += 1)] : arg.slice('--port='.length);
    if (port === undefined) fail('--port needs a port number.');
  } else {
    fail(`Unknown option: ${arg}`);
  }
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) fail(`Not a port number: ${port}`);

const dataDir = resolve(process.env.SHIZUE_DATA_DIR || defaultDataDir());
// What the app reads, all of it set here: the published app reads no .env file.
process.env.SHIZUE_PACKAGED = '1';
process.env.NODE_ENV = 'production';
process.env.SHIZUE_DATA_DIR = dataDir;
process.env.SHIZUE_PORT = port;
process.env.SHIZUE_WEB_DIR = join(root, 'web');
process.env.EMBEDDER_CACHE_DIR = resolve(process.env.EMBEDDER_CACHE_DIR || join(dataDir, 'models'));
console.log(`shizue-plot ${version} · your works and chats are in ${dataDir}`);

// Resolves once the app answers; a port in use or a folder another shizue holds ends the process there.
await import('../dist/server.js');

const url = `http://localhost:${port}`;
if (open) openBrowser(url);

function openBrowser(address) {
  const [command, commandArgs, options] =
    process.platform === 'darwin'
      ? ['open', [address], {}]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', address], { windowsVerbatimArguments: true }]
        : ['xdg-open', [address], {}];
  const say = () => console.log(`Open ${address} in your browser.`);
  try {
    const child = spawn(command, commandArgs, { stdio: 'ignore', detached: true, ...options });
    child.on('error', say);
    child.unref();
  } catch {
    say();
  }
}
