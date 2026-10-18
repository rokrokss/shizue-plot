/**
 * cloudflared, downloaded for the phone's Quick Tunnel (`cloudflared.ts`),
 * against a stand-in for its GitHub release on loopback that sends each asset on
 * to another address, as github.com does: the right asset for each platform, the
 * pins (the archive's and, for macOS, the binary's inside it), the part resumed,
 * and the check before every start.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  cloudflaredInstall,
  type CloudflaredAsset,
} from '../src/cloudflared.js';
import { DownloadMismatch } from '../src/hubDownload.js';

const VERSION = '2099.1.0';
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
/** A cloudflared that answers `--version`, as the real one does. */
const BINARY = Buffer.from('#!/bin/sh\necho "cloudflared version 2099.1.0 (stand-in)"\n');

const files = new Map<string, Buffer>();
const requests: { path: string; range: string | undefined }[] = [];
let server: Server;
let releases: string;
let dir: string;
let work: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://release').pathname;
    // github.com sends a release asset on to its asset host.
    const asset = /^\/([^/]+)\/([^/]+)$/.exec(path);
    if (asset && !path.startsWith('/assets/')) {
      res.writeHead(302, { location: `/assets/${asset[1]}/${asset[2]}` }).end();
      return;
    }
    const key = path.replace(/^\/assets\//, '');
    requests.push({ path: key, range: req.headers.range });
    const body = files.get(key);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const asked = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = asked ? Number(asked[1]) : 0;
    res.writeHead(start > 0 ? 206 : 200, {
      'content-length': body.length - start,
      ...(start > 0 ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });
    res.end(body.subarray(start));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  releases = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'cloudflared-test-'));
  dir = join(work, 'bin');
  files.clear();
  requests.length = 0;
});
afterEach(() => {
  server.closeAllConnections();
  rmSync(work, { recursive: true, force: true });
});

/** macOS's asset: a `.tgz` holding `cloudflared`, made by `tar` as Cloudflare's is. */
function archiveOf(binary: Buffer): Buffer {
  const source = join(work, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'cloudflared'), binary, { mode: 0o755 });
  execFileSync('tar', ['-czf', join(work, 'archive.tgz'), '-C', source, 'cloudflared']);
  const archive = readFileSync(join(work, 'archive.tgz'));
  rmSync(source, { recursive: true });
  rmSync(join(work, 'archive.tgz'));
  return archive;
}

const linux = (asset: Partial<CloudflaredAsset> = {}) =>
  cloudflaredInstall({
    dir,
    platform: 'linux',
    arch: 'x64',
    version: VERSION,
    releases,
    assets: { 'linux-x64': { file: 'cloudflared-linux-amd64', bytes: BINARY.length, sha256: sha256(BINARY), ...asset } },
  });

const mac = (archive: Buffer, binarySha256 = sha256(BINARY)) =>
  cloudflaredInstall({
    dir,
    platform: 'darwin',
    arch: 'arm64',
    version: VERSION,
    releases,
    assets: { 'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', bytes: archive.length, sha256: sha256(archive), binarySha256 } },
  });

describe('the cloudflared release', () => {
  it('is pinned for each platform PocketRisu downloads one for, and none other', () => {
    const named = (platform: string, arch: string) => cloudflaredInstall({ dir: '/data/bin', platform, arch });
    expect(named('darwin', 'arm64').asset?.file).toBe('cloudflared-darwin-arm64.tgz');
    expect(named('darwin', 'x64').asset?.file).toBe('cloudflared-darwin-amd64.tgz');
    expect(named('linux', 'x64').asset?.file).toBe('cloudflared-linux-amd64');
    expect(named('linux', 'arm64').asset?.file).toBe('cloudflared-linux-arm64');
    expect(named('win32', 'x64').asset?.file).toBe('cloudflared-windows-amd64.exe');
    expect(named('win32', 'x64').path).toBe(join('/data/bin', 'cloudflared.exe'));
    expect(named('darwin', 'arm64').path).toBe(join('/data/bin', 'cloudflared'));
    for (const [platform, arch] of [['linux', 'ia32'], ['freebsd', 'x64'], ['win32', 'arm64']] as const) {
      expect(named(platform, arch).asset, `${platform}-${arch}`).toBeNull();
    }
    expect(named('linux', 'x64').version).toBe(CLOUDFLARED_VERSION);
    for (const [key, asset] of Object.entries(CLOUDFLARED_ASSETS)) {
      expect(asset.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      // An archive is checked again once opened: its binary has a pin of its own.
      expect(asset.file.endsWith('.tgz'), key).toBe(asset.binarySha256 !== undefined);
      if (asset.binarySha256) expect(asset.binarySha256, key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("downloads Linux's binary through the release's address, checked, and makes it executable", async () => {
    files.set(`${VERSION}/cloudflared-linux-amd64`, BINARY);
    const install = linux();
    expect(install.present()).toBe(false);
    await install.download();
    expect(requests).toEqual([{ path: `${VERSION}/cloudflared-linux-amd64`, range: undefined }]);
    expect(readFileSync(install.path)).toEqual(BINARY);
    expect(statSync(install.path).mode & 0o111).not.toBe(0);
    expect(readdirSync(dir)).toEqual(['cloudflared']);
    expect(await install.checked()).toBe(install.path);
    expect(execFileSync(install.path, ['--version']).toString()).toContain('cloudflared version 2099.1.0');
  });

  it("takes macOS's binary out of its archive and holds it to the binary's own pin", async () => {
    const archive = archiveOf(BINARY);
    files.set(`${VERSION}/cloudflared-darwin-arm64.tgz`, archive);
    const install = mac(archive);
    await install.download();
    expect(readFileSync(install.path)).toEqual(BINARY);
    expect(statSync(install.path).mode & 0o111).not.toBe(0);
    // The archive and the folder it was opened in are gone.
    expect(readdirSync(dir)).toEqual(['cloudflared']);
    expect(await install.checked()).toBe(install.path);
  });

  it('refuses and deletes an asset unlike its pin, and an archive whose binary is unlike its own', async () => {
    files.set(`${VERSION}/cloudflared-linux-amd64`, Buffer.from('#!/bin/sh\necho something else\n'));
    const install = linux();
    await expect(install.download()).rejects.toBeInstanceOf(DownloadMismatch);
    expect(existsSync(install.path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);

    const archive = archiveOf(Buffer.from('#!/bin/sh\necho a binary nobody pinned\n'));
    files.set(`${VERSION}/cloudflared-darwin-arm64.tgz`, archive);
    const unpinned = mac(archive);
    await expect(unpinned.download()).rejects.toBeInstanceOf(DownloadMismatch);
    expect(existsSync(unpinned.path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("resumes an earlier try's part by a range", async () => {
    const binary = Buffer.concat([BINARY, Buffer.alloc(50_000, 0x23)]);
    files.set(`${VERSION}/cloudflared-linux-amd64`, binary);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cloudflared.part'), binary.subarray(0, 20_000));
    const progress: number[] = [];
    const install = linux({ bytes: binary.length, sha256: sha256(binary) });
    await install.download({ onProgress: (received) => progress.push(received) });
    expect(requests).toEqual([{ path: `${VERSION}/cloudflared-linux-amd64`, range: 'bytes=20000-' }]);
    expect(readFileSync(install.path)).toEqual(binary);
    expect(progress.at(-1)).toBe(binary.length);
    expect(progress[0]).toBeGreaterThan(20_000);
  });

  it('checks the binary in place before it is started, and deletes one that is not the pinned one', async () => {
    const install = linux();
    expect(await install.checked()).toBeNull();
    mkdirSync(dir, { recursive: true });
    // Another version, or a damaged copy: never run.
    writeFileSync(install.path, '#!/bin/sh\necho an older cloudflared\n', { mode: 0o755 });
    expect(install.present()).toBe(true);
    expect(await install.checked()).toBeNull();
    expect(existsSync(install.path)).toBe(false);

    files.set(`${VERSION}/cloudflared-linux-amd64`, BINARY);
    await install.download();
    expect(await install.checked()).toBe(install.path);
  });

  it('fails for good where the release has nothing, and has nothing for an unknown platform', async () => {
    await expect(linux().download()).rejects.toThrow(/answered 404/);
    expect(existsSync(join(dir, 'cloudflared'))).toBe(false);
    await expect(cloudflaredInstall({ dir, platform: 'freebsd', arch: 'x64' }).download()).rejects.toThrow(/no release for freebsd-x64/);
  });
});
