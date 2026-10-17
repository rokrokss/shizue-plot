/**
 * The boot guard on the better-auth variables. No database and no repo-root .env:
 * `readConfig` takes the environment as an argument, so every case here is the
 * whole input.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/env.js';

const DATABASE_URL = 'postgres://plot:plot@localhost:5433/plot';
/** A secret a deployment takes: 32 characters. */
const SECRET = 'a'.repeat(32);
/** The same root `readConfig` resolves against: three levels up from `src/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('readConfig', () => {
  it('falls back to the dev defaults on a development run', () => {
    const config = readConfig({ NODE_ENV: 'development', DATABASE_URL });
    expect(config.authSecret).toBe('dev-secret-change-me');
    expect(config.authUrl).toBe('http://localhost:13000');
  });

  it('refuses to seal tokens with the dev secret in production', () => {
    expect(() => readConfig({ NODE_ENV: 'production', DATABASE_URL })).toThrow(/BETTER_AUTH_SECRET/);
    expect(readConfig({ NODE_ENV: 'production', DATABASE_URL, BETTER_AUTH_SECRET: SECRET }).authSecret).toBe(SECRET);
  });

  it('refuses the dev secret, or a short one, wherever the web origin is not this machine, whatever NODE_ENV says', () => {
    const hosted = { DATABASE_URL, BETTER_AUTH_URL: 'https://plot.shizue.net' };
    // `node dist/index.js` sets no NODE_ENV.
    expect(() => readConfig(hosted)).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => readConfig({ ...hosted, NODE_ENV: 'development' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => readConfig({ ...hosted, BETTER_AUTH_SECRET: 'a'.repeat(31) })).toThrow(/at least 32/);
    expect(() => readConfig({ NODE_ENV: 'production', DATABASE_URL, BETTER_AUTH_SECRET: 'short' })).toThrow(/at least 32/);
    expect(readConfig({ ...hosted, BETTER_AUTH_SECRET: SECRET }).authSecret).toBe(SECRET);
    // This machine's own shizue, a maintenance script run here among them, keeps the dev default.
    expect(readConfig({ DATABASE_URL, BETTER_AUTH_URL: 'http://127.0.0.1:13100' }).authSecret).toBe('dev-secret-change-me');
  });
  it('takes a hosted web origin, but only an origin', () => {
    expect(readConfig({
      NODE_ENV: 'production', DATABASE_URL, BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: 'https://plot.example.com', CHATGPT_CALLBACK_PORT: '47821',
    }).authUrl).toBe('https://plot.example.com');
    for (const url of ['https://plot.example.com/', 'https://plot.example.com/app', 'ftp://plot.example.com', 'http://user@localhost']) {
      expect(() => readConfig({ NODE_ENV: 'development', DATABASE_URL, BETTER_AUTH_URL: url })).toThrow(/web origin/);
    }
  });
  it('reads the remote origins a phone reaches the app at, each only an origin', () => {
    expect(readConfig({ DATABASE_URL }).remoteOrigins).toEqual([]);
    expect(readConfig({
      DATABASE_URL, REMOTE_ORIGINS: ' https://mac.example.ts.net:8444 ,http://localhost:13000,, https://mac.example.ts.net:8444',
    }).remoteOrigins).toEqual(['https://mac.example.ts.net:8444']);
    for (const value of ['mac.example.ts.net', 'https://mac.example.ts.net/', 'ftp://mac.example.ts.net', 'https://a.example,nope']) {
      expect(() => readConfig({ DATABASE_URL, REMOTE_ORIGINS: value })).toThrow(/REMOTE_ORIGINS/);
    }
  });
  it('refuses remote origins anywhere but a shizue signing in on this machine', () => {
    expect(readConfig({ DATABASE_URL, BETTER_AUTH_URL: 'http://127.0.0.1:13100', REMOTE_ORIGINS: 'https://mac.example.ts.net:8444' })
      .remoteOrigins).toEqual(['https://mac.example.ts.net:8444']);
    expect(() => readConfig({
      NODE_ENV: 'production', DATABASE_URL, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'https://plot.shizue.net', REMOTE_ORIGINS: 'https://mac.example.ts.net:8444',
    })).toThrow(/only for a shizue running on this machine/);
    // Empty is no list at all, wherever the app runs.
    expect(readConfig({ NODE_ENV: 'production', DATABASE_URL, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'https://plot.shizue.net', REMOTE_ORIGINS: '' })
      .remoteOrigins).toEqual([]);
  });
  it('reads the loopback port the companion extension catches', () => {
    expect(readConfig({ DATABASE_URL }).chatgptCallbackPort).toBe(47801);
    expect(readConfig({ DATABASE_URL, CHATGPT_CALLBACK_PORT: '47811' }).chatgptCallbackPort).toBe(47811);
    expect(() => readConfig({ DATABASE_URL, CHATGPT_CALLBACK_PORT: '80' })).toThrow(/CHATGPT_CALLBACK_PORT/);
  });

  describe('against the ports Shizue sends to each origin', () => {
    const production = { NODE_ENV: 'production', DATABASE_URL, BETTER_AUTH_SECRET: SECRET };

    it('needs no setting for plot.shizue.net, and takes 47811 from Shizue', () => {
      // The deployment that forgets the variable: before this, it asked OpenAI for
      // 47801, which Shizue sends to localhost:13000 on the reader's own machine.
      expect(readConfig({ ...production, BETTER_AUTH_URL: 'https://plot.shizue.net' }).chatgptCallbackPort).toBe(47811);
      expect(readConfig({ ...production, BETTER_AUTH_URL: 'https://plot.shizue.net', CHATGPT_CALLBACK_PORT: '47811' })
        .chatgptCallbackPort).toBe(47811);
    });

    it('refuses a production port that disagrees with Shizue', () => {
      expect(() => readConfig({ ...production, BETTER_AUTH_URL: 'https://plot.shizue.net', CHATGPT_CALLBACK_PORT: '47801' }))
        .toThrow(/Shizue brings it back on 47811/);
      expect(() => readConfig({ ...production, BETTER_AUTH_URL: 'https://plot.example.com', CHATGPT_CALLBACK_PORT: '47811' }))
        .toThrow(/Shizue's port for https:\/\/plot\.shizue\.net/);
      expect(() => readConfig({ ...production, BETTER_AUTH_URL: 'https://plot.example.com', CHATGPT_CALLBACK_PORT: '47801' }))
        .toThrow(/Shizue's port for http:\/\/localhost:13000/);
    });

    it('refuses another production origin that names no port', () => {
      expect(() => readConfig({ ...production, BETTER_AUTH_URL: 'https://plot.example.com' })).toThrow(/must be set for https:\/\/plot\.example\.com/);
      expect(readConfig({ ...production, BETTER_AUTH_URL: 'https://plot.example.com', CHATGPT_CALLBACK_PORT: '47821' })
        .chatgptCallbackPort).toBe(47821);
    });

    it('leaves development to take any port, for offset dev servers and the browser tests', () => {
      expect(readConfig({ NODE_ENV: 'development', DATABASE_URL, BETTER_AUTH_URL: 'http://localhost:13100' }).chatgptCallbackPort)
        .toBe(47801);
      expect(readConfig({ NODE_ENV: 'test', DATABASE_URL, BETTER_AUTH_URL: 'http://localhost:13100', CHATGPT_CALLBACK_PORT: '47811' })
        .chatgptCallbackPort).toBe(47811);
      expect(readConfig({ NODE_ENV: 'development', DATABASE_URL, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: 'https://plot.shizue.net' }).chatgptCallbackPort)
        .toBe(47811);
    });
  });

});

/**
 * The storage driver is decided here and nowhere else, so this is where the
 * decision is pinned. The routes below it only ever hold an `ObjectStorage`.
 */
describe('readConfig storage', () => {
  const dev = { NODE_ENV: 'development', DATABASE_URL };

  it('defaults to the local directory this repo has always used', () => {
    expect(readConfig(dev).storage).toEqual({
      driver: 'local',
      dir: resolve(REPO_ROOT, './data/uploads'),
    });
  });

  it('resolves UPLOAD_DIR from the repo root, not the cwd', () => {
    expect(readConfig({ ...dev, UPLOAD_DIR: './var/media' }).storage).toEqual({
      driver: 'local',
      dir: resolve(REPO_ROOT, './var/media'),
    });
  });

  it('reads the s3 driver, path style included, and defaults the rest', () => {
    expect(
      readConfig({
        ...dev,
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'shizue-media',
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'shizue',
        S3_SECRET_ACCESS_KEY: 'shizue-secret',
        S3_FORCE_PATH_STYLE: 'true',
      }).storage,
    ).toEqual({
      driver: 's3',
      bucket: 'shizue-media',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'shizue',
      secretAccessKey: 'shizue-secret',
      forcePathStyle: true,
    });
  });

  it('leaves the credentials out for the sdk provider chain, and path style off, on real s3', () => {
    expect(readConfig({ ...dev, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_REGION: 'ap-northeast-2' }).storage).toEqual(
      {
        driver: 's3',
        bucket: 'b',
        region: 'ap-northeast-2',
        forcePathStyle: false,
        },
    );
  });

  it('refuses a driver it does not have and an s3 with nowhere to write', () => {
    expect(() => readConfig({ ...dev, STORAGE_DRIVER: 'gcs' })).toThrow(/STORAGE_DRIVER must be/);
    expect(() => readConfig({ ...dev, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET is not set/);
  });
});
