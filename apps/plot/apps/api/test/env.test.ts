/**
 * The boot guard on the configuration. No database and no repo-root .env:
 * `readConfig` takes the environment as an argument, so every case here is the
 * whole input.
 */
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dataDirOf, dbDirOf, filesDirOf, readConfig, readOrCreateSecret } from '../src/env.js';

/** The same root `readConfig` resolves against: three levels up from `src/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('readConfig', () => {
  it('falls back to the dev defaults on a development run, the secret left to the install', () => {
    const config = readConfig({ NODE_ENV: 'development' });
    expect(config.authSecret).toBeUndefined();
    expect(config.authUrl).toBe('http://localhost:13000');
  });

  it('takes a secret set by hand, else leaves it to the install', () => {
    expect(readConfig({ NODE_ENV: 'production' }).authSecret).toBeUndefined();
    expect(readConfig({ NODE_ENV: 'production', BETTER_AUTH_SECRET: 'set-by-hand' }).authSecret).toBe('set-by-hand');
  });
  it('takes a web origin, but only an origin', () => {
    expect(readConfig({ BETTER_AUTH_URL: 'http://127.0.0.1:13100' }).authUrl).toBe('http://127.0.0.1:13100');
    for (const url of ['http://localhost:13000/', 'http://localhost:13000/app', 'ftp://localhost', 'http://user@localhost']) {
      expect(() => readConfig({ NODE_ENV: 'development', BETTER_AUTH_URL: url })).toThrow(/web origin/);
    }
  });
  it('reads the remote origins a phone reaches the app at, each only an origin', () => {
    expect(readConfig({}).remoteOrigins).toEqual([]);
    expect(readConfig({
      REMOTE_ORIGINS: ' https://mac.example.ts.net:8444 ,http://localhost:13000,, https://mac.example.ts.net:8444',
    }).remoteOrigins).toEqual(['https://mac.example.ts.net:8444']);
    for (const value of ['mac.example.ts.net', 'https://mac.example.ts.net/', 'ftp://mac.example.ts.net', 'https://a.example,nope']) {
      expect(() => readConfig({ REMOTE_ORIGINS: value })).toThrow(/REMOTE_ORIGINS/);
    }
  });
  it('refuses remote origins anywhere but a shizue signing in on this machine', () => {
    expect(readConfig({ BETTER_AUTH_URL: 'http://127.0.0.1:13100', REMOTE_ORIGINS: 'https://mac.example.ts.net:8444' })
      .remoteOrigins).toEqual(['https://mac.example.ts.net:8444']);
    expect(() => readConfig({
      BETTER_AUTH_URL: 'https://plot.example.com', REMOTE_ORIGINS: 'https://mac.example.ts.net:8444',
    })).toThrow(/only for a shizue running on this machine/);
    // Empty is no list at all, wherever the app runs.
    expect(readConfig({ BETTER_AUTH_URL: 'https://plot.example.com', REMOTE_ORIGINS: '' }).remoteOrigins).toEqual([]);
  });
  it('reads the loopback port the companion extension catches', () => {
    expect(readConfig({}).chatgptCallbackPort).toBe(47801);
    expect(readConfig({ CHATGPT_CALLBACK_PORT: '47811' }).chatgptCallbackPort).toBe(47811);
    expect(() => readConfig({ CHATGPT_CALLBACK_PORT: '80' })).toThrow(/CHATGPT_CALLBACK_PORT/);
  });
});

/**
 * Where everything that is the reader's lives — the database, the files, the
 * secret — is decided here and nowhere else.
 */
describe("the app's folder", () => {
  it('keeps the database and the files in it, under apps/plot/data/app unless SHIZUE_DATA_DIR says', () => {
    const config = readConfig({ NODE_ENV: 'development' });
    expect(config.dataDir).toBe(resolve(REPO_ROOT, './data/app'));
    expect(config.storage).toEqual({ driver: 'local', dir: join(config.dataDir, 'files') });
    expect(dbDirOf(config.dataDir)).toBe(join(config.dataDir, 'db'));
    expect(filesDirOf(config.dataDir)).toBe(join(config.dataDir, 'files'));
  });

  it('reads SHIZUE_DATA_DIR from the repo root when relative, as it is when absolute', () => {
    expect(dataDirOf({ SHIZUE_DATA_DIR: './var/shizue' })).toBe(resolve(REPO_ROOT, './var/shizue'));
    expect(dataDirOf({ SHIZUE_DATA_DIR: '/srv/shizue' })).toBe('/srv/shizue');
  });

  it('makes the install its own secret once, readable by its owner only, and keeps it', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'shizue-secret-')), 'app');
    const made = readOrCreateSecret(dir);
    expect(made.length).toBeGreaterThanOrEqual(32);
    expect((await stat(join(dir, 'secret'))).mode & 0o777).toBe(0o600);
    expect(readOrCreateSecret(dir)).toBe(made);
    // One carried over from an older install is read as it is, never replaced.
    await writeFile(join(dir, 'secret'), 'carried-over\n');
    expect(readOrCreateSecret(dir)).toBe('carried-over');
    expect(await readFile(join(dir, 'secret'), 'utf8')).toBe('carried-over\n');
  });
});
