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
    expect(readConfig({ NODE_ENV: 'production', DATABASE_URL, BETTER_AUTH_SECRET: 's' }).authSecret).toBe('s');
  });
  it('takes a hosted web origin, but only an origin', () => {
    expect(readConfig({ NODE_ENV: 'production', DATABASE_URL, BETTER_AUTH_SECRET: 's', BETTER_AUTH_URL: 'https://plot.example.com' }).authUrl)
      .toBe('https://plot.example.com');
    for (const url of ['https://plot.example.com/', 'https://plot.example.com/app', 'ftp://plot.example.com', 'http://user@localhost']) {
      expect(() => readConfig({ NODE_ENV: 'development', DATABASE_URL, BETTER_AUTH_URL: url })).toThrow(/web origin/);
    }
  });
  it('reads the loopback port the companion extension catches', () => {
    expect(readConfig({ DATABASE_URL }).chatgptCallbackPort).toBe(47801);
    expect(readConfig({ DATABASE_URL, CHATGPT_CALLBACK_PORT: '47811' }).chatgptCallbackPort).toBe(47811);
    expect(() => readConfig({ DATABASE_URL, CHATGPT_CALLBACK_PORT: '80' })).toThrow(/CHATGPT_CALLBACK_PORT/);
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
