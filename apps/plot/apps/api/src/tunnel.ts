import { execFile, spawn } from 'node:child_process';
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
 * a public address that changes every time. Neither is installed for the reader;
 * the settings card says which to install.
 */
export type TunnelKind = 'tailscale' | 'cloudflare';

export interface Tunnel {
  kind: TunnelKind;
  /** The web app's origin through the tunnel, as a phone opens it. */
  origin: string;
}

export interface TunnelStatus {
  tunnel: Tunnel | null;
  /** Which tunnel the button would open: Tailscale when it is running, else cloudflared when installed. */
  available: Record<TunnelKind, boolean>;
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
  open(): Promise<Tunnel>;
  close(): Promise<void>;
  /** The open tunnel's origin, read on every request by the guards; null when there is none. */
  origin(): string | null;
  /** Ends a Cloudflare tunnel with the process. A Tailscale one stays, as Tailscale keeps it, at the same address. */
  shutdown(): void;
}

/** The HTTPS ports tried for Tailscale Serve, past the 443 and 8443 other services on a tailnet usually take. */
export const TAILSCALE_PORTS = [8444, 8445, 8446, 8447, 8448, 8449, 10443] as const;
/** How long cloudflared has to say its address, as PocketRisu waits. */
const CLOUDFLARE_WAIT_MS = 30_000;
const CLOUDFLARE_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

export class TunnelError extends Error {
  constructor(
    readonly code: 'tunnel_unavailable' | 'tunnel_failed',
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

export function createPhoneAccess(options: { webUrl: string; tools?: TunnelTools; cloudflareWaitMs?: number }): PhoneAccess {
  if (!isLoopback(options.webUrl)) throw new Error('Phone access is only for a shizue running on this machine');
  const tools = options.tools ?? systemTunnelTools;
  const web = new URL(options.webUrl);
  // Where the tunnel delivers: the web app, which passes `/api` on to the API.
  const target = `http://127.0.0.1:${web.port || (web.protocol === 'https:' ? '443' : '80')}`;

  let current: (Tunnel & { port?: number; command?: RunningCommand }) | null = null;
  let opening: Promise<Tunnel> | null = null;

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

  const cloudflared = async (): Promise<boolean> => {
    try {
      await tools.run('cloudflared', ['--version']);
      return true;
    } catch {
      return false;
    }
  };

  const tailscaleOrigin = (host: string, port: number): string => `https://${host}:${port}`;

  async function status(): Promise<TunnelStatus> {
    const host = await tailnetHost();
    if (!current && host) {
      // Serve outlives this process: the address a phone kept still works, so it is open.
      const port = servedPort(await serveStatus().catch(() => ({})), host);
      if (port !== null) current = { kind: 'tailscale', origin: tailscaleOrigin(host, port), port };
    }
    return {
      tunnel: current ? { kind: current.kind, origin: current.origin } : null,
      available: { tailscale: host !== null, cloudflare: await cloudflared() },
    };
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

  function openCloudflare(): Promise<Tunnel> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail('cloudflared said no address in time'), options.cloudflareWaitMs ?? CLOUDFLARE_WAIT_MS);
      const command = tools.start('cloudflared', ['tunnel', '--no-autoupdate', '--url', target], (line) => {
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
      if (await cloudflared()) return openCloudflare();
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
    open,
    close,
    origin: () => current?.origin ?? null,
    shutdown: () => {
      if (current?.kind === 'cloudflare') current.command?.stop();
    },
  };
}
