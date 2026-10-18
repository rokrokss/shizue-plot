import { execFile, spawn } from 'node:child_process';
import type { CloudflaredInstall } from './cloudflared.js';
import { isLoopback } from './env.js';

/**
 * The tunnel that lets a phone open a shizue running on the reader's own machine,
 * opened from the settings page as PocketRisu opens its remote access (owner
 * decision, 2026-10-17). Only for a web origin on loopback: the API builds this
 * only then (`index.ts`), and refuses again here.
 *
 * Tailscale Serve first, when the machine is on a tailnet: a fixed address only
 * the reader's own devices reach, the phone with the Tailscale app. Otherwise a
 * Cloudflare Quick Tunnel, as PocketRisu's button opens: no app on the phone, but
 * a public address that changes every time. Tailscale is never installed for
 * the reader; cloudflared is, when neither is here, as PocketRisu's remote access
 * downloads it: the settings card offers it, and the app keeps the pinned
 * release in its own folder (`cloudflared.ts`) and starts that one, checked.
 */
export type TunnelKind = 'tailscale' | 'cloudflare';

export interface Tunnel {
  kind: TunnelKind;
  /** The web app's origin through the tunnel, as a phone opens it. */
  origin: string;
}

export interface TunnelStatus {
  tunnel: Tunnel | null;
  /** Which tunnel the button would open: Tailscale when it is running, else cloudflared when installed or downloaded. */
  available: Record<TunnelKind, boolean>;
  /**
   * The cloudflared the app would download for itself (`cloudflared.ts`), when
   * the button has nothing else to open with — or is downloading it. Absent once
   * one is here, or when the release has none for this platform.
   */
  download?: CloudflaredDownload;
}

export interface CloudflaredDownload {
  version: string;
  /** The release file's size. */
  bytes: number;
  state: 'idle' | 'downloading' | 'failed';
  /** How much of it has come, while it downloads. */
  received: number;
  /** Why the last try failed, for the log; the card says it in its own words. */
  error?: string;
}

/** The commands this runs, faked in the tests. */
export interface TunnelTools {
  /** Runs a command to its end: its stdout, or a rejection. */
  run(command: string, args: string[]): Promise<string>;
  /** Starts a command that keeps running; each line it prints goes to `onLine`. */
  start(command: string, args: string[], onLine: (line: string) => void): RunningCommand;
}

export interface RunningCommand {
  stop(): void;
  /** Settles when the command ends, by itself or stopped. */
  exited: Promise<void>;
}

export interface PhoneAccess {
  status(): Promise<TunnelStatus>;
  /** Starts downloading cloudflared, when `status` offers it and it is not already coming; the status says how it goes. */
  download(): void;
  open(): Promise<Tunnel>;
  close(): Promise<void>;
  /** The open tunnel's origin, read on every request by the guards; null when there is none. */
  origin(): string | null;
  /** Ends a Cloudflare tunnel, and a download of cloudflared, with the process. A Tailscale one stays, as Tailscale keeps it, at the same address. */
  shutdown(): void;
}

/** The HTTPS ports tried for Tailscale Serve, past the 443 and 8443 other services on a tailnet usually take. */
export const TAILSCALE_PORTS = [8444, 8445, 8446, 8447, 8448, 8449, 10443] as const;
/** How long cloudflared has to say its address, as PocketRisu waits. */
const CLOUDFLARE_WAIT_MS = 30_000;
const CLOUDFLARE_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

export class TunnelError extends Error {
  constructor(
    readonly code: 'tunnel_unavailable' | 'tunnel_failed' | 'cloudflared_unavailable',
    message: string,
  ) {
    super(message);
  }
}

export const systemTunnelTools: TunnelTools = {
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 20_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr).trim() || error.message));
        else resolve(String(stdout));
      });
    }),
  start: (command, args, onLine) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    let rest = '';
    const read = (chunk: Buffer): void => {
      const lines = (rest + chunk.toString()).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    return { stop: () => void child.kill('SIGTERM'), exited };
  },
};

interface ServeStatus {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

export function createPhoneAccess(options: {
  webUrl: string;
  tools?: TunnelTools;
  cloudflareWaitMs?: number;
  /** The cloudflared the app downloads for itself; none offered without one. */
  cloudflared?: CloudflaredInstall;
}): PhoneAccess {
  if (!isLoopback(options.webUrl)) throw new Error('Phone access is only for a shizue running on this machine');
  const tools = options.tools ?? systemTunnelTools;
  const web = new URL(options.webUrl);
  // Where the tunnel delivers: the web app, which passes `/api` on to the API.
  const target = `http://127.0.0.1:${web.port || (web.protocol === 'https:' ? '443' : '80')}`;

  const install = options.cloudflared;
  let current: (Tunnel & { port?: number; command?: RunningCommand }) | null = null;
  let opening: Promise<Tunnel> | null = null;
  /** The download under way, and how far it has come. */
  let downloading: { controller: AbortController; received: number } | null = null;
  let downloadError: string | undefined;

  /** This machine's tailnet name, when Tailscale is running and signed in. */
  const tailnetHost = async (): Promise<string | null> => {
    try {
      const status = JSON.parse(await tools.run('tailscale', ['status', '--json'])) as {
        BackendState?: string;
        Self?: { DNSName?: string };
      };
      const name = status.Self?.DNSName?.replace(/\.$/, '');
      return status.BackendState === 'Running' && name ? name : null;
    } catch {
      return null;
    }
  };

  const serveStatus = async (): Promise<ServeStatus> => {
    const out = (await tools.run('tailscale', ['serve', 'status', '--json'])).trim();
    return out ? (JSON.parse(out) as ServeStatus) : {};
  };

  /** The port Tailscale Serve already hands to this app, kept from an earlier run. */
  const servedPort = (serve: ServeStatus, host: string): number | null => {
    for (const [key, entry] of Object.entries(serve.Web ?? {})) {
      const [name, port] = key.split(':');
      if (name === host && entry.Handlers?.['/']?.Proxy === target) return Number(port);
    }
    return null;
  };

  /** A cloudflared this machine has installed itself, on the PATH. */
  const cloudflaredOnPath = async (): Promise<boolean> => {
    try {
      await tools.run('cloudflared', ['--version']);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * What starts the Quick Tunnel: the machine's own cloudflared, else the one the
   * app downloaded once its hash is the pinned one's — one that is not is deleted
   * here and never run, and the card downloads it again.
   */
  const cloudflaredCommand = async (): Promise<string | null> => {
    if (await cloudflaredOnPath()) return 'cloudflared';
    if (!install?.present()) return null;
    const path = await install.checked();
    if (!path) downloadError = 'the downloaded cloudflared did not match its pin and was deleted';
    return path;
  };

  const downloadOffer = (): CloudflaredDownload | undefined => {
    if (!install?.asset) return undefined;
    return {
      version: install.version,
      bytes: install.asset.bytes,
      state: downloading ? 'downloading' : downloadError ? 'failed' : 'idle',
      received: downloading?.received ?? 0,
      ...(downloadError && !downloading ? { error: downloadError } : {}),
    };
  };

  const tailscaleOrigin = (host: string, port: number): string => `https://${host}:${port}`;

  async function status(): Promise<TunnelStatus> {
    const host = await tailnetHost();
    if (!current && host) {
      // Serve outlives this process: the address a phone kept still works, so it is open.
      const port = servedPort(await serveStatus().catch(() => ({})), host);
      if (port !== null) current = { kind: 'tailscale', origin: tailscaleOrigin(host, port), port };
    }
    const cloudflare = (await cloudflaredOnPath()) || (!downloading && install?.present() === true);
    const offer = downloading || (host === null && !cloudflare) ? downloadOffer() : undefined;
    return {
      tunnel: current ? { kind: current.kind, origin: current.origin } : null,
      available: { tailscale: host !== null, cloudflare },
      ...(offer ? { download: offer } : {}),
    };
  }

  function download(): void {
    if (!install?.asset || downloading || install.present()) return;
    const state = { controller: new AbortController(), received: 0 };
    downloading = state;
    downloadError = undefined;
    void install
      .download({ signal: state.controller.signal, onProgress: (received) => (state.received = received) })
      .catch((error: unknown) => {
        if (state.controller.signal.aborted) return;
        downloadError = error instanceof Error ? error.message : 'the download failed';
        console.warn(`[tunnel] cloudflared ${install.version} did not download: ${downloadError}`);
      })
      .finally(() => {
        if (downloading === state) downloading = null;
      });
  }

  async function openTailscale(host: string): Promise<Tunnel> {
    const serve = await serveStatus();
    const kept = servedPort(serve, host);
    if (kept !== null) {
      current = { kind: 'tailscale', origin: tailscaleOrigin(host, kept), port: kept };
      return { kind: 'tailscale', origin: current.origin };
    }
    // Only a port nothing else serves: the reader's other services keep theirs.
    const taken = new Set(Object.keys(serve.TCP ?? {}).map(Number));
    const port = TAILSCALE_PORTS.find((candidate) => !taken.has(candidate));
    if (port === undefined) throw new TunnelError('tunnel_failed', 'Every Tailscale Serve port shizue tries is taken');
    try {
      await tools.run('tailscale', ['serve', '--bg', `--https=${port}`, target]);
    } catch (error) {
      throw new TunnelError('tunnel_failed', `Tailscale Serve did not start: ${(error as Error).message}`);
    }
    // Its word is what is served now, not the command's exit.
    if (servedPort(await serveStatus(), host) !== port) {
      throw new TunnelError('tunnel_failed', 'Tailscale Serve did not take the address');
    }
    current = { kind: 'tailscale', origin: tailscaleOrigin(host, port), port };
    return { kind: 'tailscale', origin: current.origin };
  }

  function openCloudflare(cloudflared: string): Promise<Tunnel> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail('cloudflared said no address in time'), options.cloudflareWaitMs ?? CLOUDFLARE_WAIT_MS);
      const command = tools.start(cloudflared, ['tunnel', '--no-autoupdate', '--url', target], (line) => {
        const found = CLOUDFLARE_URL.exec(line);
        if (!found || settled) return;
        settled = true;
        clearTimeout(timer);
        current = { kind: 'cloudflare', origin: found[0], command };
        resolve({ kind: 'cloudflare', origin: found[0] });
      });
      function fail(reason: string): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        command.stop();
        reject(new TunnelError('tunnel_failed', `Cloudflare Quick Tunnel did not open: ${reason}`));
      }
      void command.exited.then(() => {
        fail('cloudflared exited');
        // A tunnel that ends on its own is no longer open.
        if (current?.command === command) current = null;
      });
    });
  }

  async function open(): Promise<Tunnel> {
    if (!isLoopback(options.webUrl)) throw new TunnelError('tunnel_unavailable', 'Phone access is only for a shizue running on this machine');
    if (current) return { kind: current.kind, origin: current.origin };
    // One at a time: two clicks open one tunnel.
    opening ??= (async () => {
      const host = await tailnetHost();
      if (host) return openTailscale(host);
      const cloudflared = downloading ? null : await cloudflaredCommand();
      if (cloudflared) return openCloudflare(cloudflared);
      if (install?.asset) throw new TunnelError('cloudflared_unavailable', 'cloudflared is not downloaded yet');
      throw new TunnelError('tunnel_unavailable', 'Neither Tailscale nor cloudflared is available on this machine');
    })().finally(() => {
      opening = null;
    });
    return opening;
  }

  async function close(): Promise<void> {
    const open = current;
    if (!open) return;
    if (open.kind === 'tailscale') {
      // Its own port only, never `reset`: the reader's other services stay served.
      await tools.run('tailscale', ['serve', `--https=${open.port}`, 'off']);
    } else {
      open.command?.stop();
    }
    current = null;
  }

  return {
    status,
    download,
    open,
    close,
    origin: () => current?.origin ?? null,
    shutdown: () => {
      if (current?.kind === 'cloudflare') current.command?.stop();
      downloading?.controller.abort();
    },
  };
}
