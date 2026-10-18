/**
 * cloudflared, downloaded by the app for the phone's Cloudflare Quick Tunnel
 * when this computer has neither Tailscale nor a cloudflared of its own
 * (`tunnel.ts`), as PocketRisu's remote access downloads it (`server.cjs`
 * `downloadCloudflared`: the official GitHub release for this OS and
 * architecture, into a `bin/` folder, made executable).
 *
 * Unlike PocketRisu's, which takes `releases/latest` as it comes, this is one
 * pinned release, and nothing runs that is not it:
 *
 * - Each platform's asset has its SHA-256 here, the release's own digest. The
 *   download goes through the embedder's downloader (`downloadPinned`: a
 *   `.part` renamed into place once whole and matching, resumed by a range,
 *   redirects followed, a minute's silence given up), which deletes a part that
 *   does not match and refuses it (`DownloadMismatch`).
 * - macOS's asset is a `.tgz`: once it matches, `tar` takes `cloudflared` out
 *   of it into a folder of its own, and that binary is held to the hash the
 *   release notes list for it before it is moved into place. The archive goes
 *   either way; a binary that does not match goes with it.
 * - It lives at `<app folder>/bin/cloudflared` (`.exe` on Windows), and is
 *   hashed again before every start (`checked`): a file there that is not the
 *   pinned binary — another version, a damaged copy — is deleted and never
 *   run, and the card downloads it again.
 *
 * The pin goes stale as Cloudflare releases; moving it is changing the version
 * and the hashes below together (a newer pin replaces the binary in place, since
 * the old one no longer matches).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DownloadMismatch, downloadPinned, sha256Of, type DownloadOptions } from './hubDownload.js';

export const CLOUDFLARED_VERSION = '2026.10.1';
/** Where a release's files are, by tag. */
export const CLOUDFLARED_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/download';

export interface CloudflaredAsset {
  /** The release's file. */
  file: string;
  /** Its size, for the card to say before it is downloaded. */
  bytes: number;
  /** The file's SHA-256: the release's digest on GitHub. */
  sha256: string;
  /** For a `.tgz`: the SHA-256 of the `cloudflared` inside it, as the release notes list it. */
  binarySha256?: string;
}

/**
 * Cloudflare's 2026.10.1 (2026-10-15), by `process.platform`-`process.arch` as
 * PocketRisu's `CLOUDFLARED_ASSETS` names them. The digests are GitHub's for
 * each asset; the release notes list the same for Linux and Windows and, for
 * macOS, the binary inside the archive. The darwin-arm64 pair was checked by
 * downloading it (2026-10-19).
 */
export const CLOUDFLARED_ASSETS: Readonly<Record<string, CloudflaredAsset>> = {
  'darwin-arm64': {
    file: 'cloudflared-darwin-arm64.tgz',
    bytes: 19_807_806,
    sha256: '647615df99d49cd179ea5e13ef760b9bbfb33630f6ae62f87e33dfadda60adcc',
    binarySha256: '35b7e34c9a3f214d80d859c4223450c69e583c7668d228c45771026fe376cab9',
  },
  'darwin-x64': {
    file: 'cloudflared-darwin-amd64.tgz',
    bytes: 21_768_449,
    sha256: '3b0dbaf378337e9d7fb6cd235a76d1d6a7dee434c2d8edf9281164fb6a3837ab',
    binarySha256: '8ccc6383aef109c8d88965937649a796febbb166dab4b73345e820623aee1ede',
  },
  'linux-x64': {
    file: 'cloudflared-linux-amd64',
    bytes: 40_227_032,
    sha256: '3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586',
  },
  'linux-arm64': {
    file: 'cloudflared-linux-arm64',
    bytes: 37_651_992,
    sha256: '2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46',
  },
  'win32-x64': {
    file: 'cloudflared-windows-amd64.exe',
    bytes: 55_325_120,
    sha256: '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6',
  },
};

/** The cloudflared the app keeps for itself, as `tunnel.ts` uses it. Tests hand in their own. */
export interface CloudflaredInstall {
  version: string;
  /** What this platform downloads, or null when the release has nothing for it. */
  asset: CloudflaredAsset | null;
  /** Where the binary goes. */
  path: string;
  /** Whether a binary is there, unchecked: for the settings card, which asks often. */
  present(): boolean;
  /** Its path once it is the pinned binary; a file there that is not is deleted, and null answered. */
  checked(): Promise<string | null>;
  /** Downloads it into place, checked (`DownloadMismatch` for bytes that are not the pinned ones, deleted). */
  download(options?: Pick<DownloadOptions, 'signal' | 'onProgress' | 'idleMs'>): Promise<void>;
}

export interface CloudflaredOptions {
  /** The folder it goes in: `<app folder>/bin`. */
  dir: string;
  platform?: string;
  arch?: string;
  /** Tests' stand-in for the release; the pinned one's otherwise. */
  version?: string;
  assets?: Readonly<Record<string, CloudflaredAsset>>;
  releases?: string;
}

const run = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message));
      else resolve();
    });
  });

export function cloudflaredInstall(options: CloudflaredOptions): CloudflaredInstall {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const version = options.version ?? CLOUDFLARED_VERSION;
  const asset = (options.assets ?? CLOUDFLARED_ASSETS)[`${platform}-${arch}`] ?? null;
  const path = join(options.dir, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const binarySha256 = asset ? (asset.binarySha256 ?? asset.sha256) : null;

  async function checked(): Promise<string | null> {
    if (!binarySha256 || !existsSync(path)) return null;
    if ((await sha256Of(path)) === binarySha256) return path;
    await rm(path, { force: true });
    return null;
  }

  async function download(downloadOptions: Pick<DownloadOptions, 'signal' | 'onProgress' | 'idleMs'> = {}): Promise<void> {
    if (!asset || !binarySha256) throw new Error(`cloudflared ${version} has no release for ${platform}-${arch}`);
    await mkdir(options.dir, { recursive: true });
    const url = `${options.releases ?? CLOUDFLARED_RELEASES}/${version}/${asset.file}`;
    if (!asset.binarySha256) {
      // The asset is the binary: in place once it matches.
      await downloadPinned(url, path, asset.sha256, downloadOptions);
    } else {
      const archive = join(options.dir, asset.file);
      await downloadPinned(url, archive, asset.sha256, downloadOptions);
      const unpacked = await mkdtemp(join(options.dir, '.cloudflared-'));
      try {
        await run('tar', ['-xzf', archive, '-C', unpacked, 'cloudflared']);
        const binary = join(unpacked, 'cloudflared');
        if ((await sha256Of(binary)) !== binarySha256) {
          throw new DownloadMismatch(`the cloudflared in ${asset.file} is not the binary pinned for it; deleted`);
        }
        await chmod(binary, 0o755);
        await rename(binary, path);
      } finally {
        await rm(unpacked, { recursive: true, force: true });
        await rm(archive, { force: true });
      }
    }
    if (platform !== 'win32') await chmod(path, 0o755);
  }

  return { version, asset, path, present: () => existsSync(path), checked, download };
}
