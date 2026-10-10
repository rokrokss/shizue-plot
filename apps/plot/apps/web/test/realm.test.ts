/**
 * RisuRealm import in the browser: which addresses name a card, which formats
 * are asked for in which order, and what each refusal turns into. The download
 * is the only network the page does on its own, so `fetch` is stubbed and every
 * URL it was asked for is the record.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import {
  checkCardSize,
  downloadRealmCard,
  isRestrictiveLicense,
  licenseTerms,
  realmCardId,
} from '../src/lib/realm';
import { MAX_CARD_IMPORT_BYTES } from '../src/lib/types';

const id = '0f8e6c1a-3b2d-4c5e-9f7a-1b2c3d4e5f60';
const page = `https://realm.risuai.net/character/${id}`;

describe('realmCardId', () => {
  it('reads the page, the risuai.xyz link and a bare id', () => {
    for (const input of [
      page,
      `${page}/`,
      `  ${page}?ref=home#top `,
      `https://risuai.xyz/?realm=${id}`,
      `https://www.risuai.xyz/?realm=${id}&lang=ko`,
      id,
    ]) {
      expect(realmCardId(input), input).toBe(id);
    }
  });

  it('refuses anything that is not a Realm card page', () => {
    for (const input of [
      '',
      'not a url',
      `https://example.com/character/${id}`,
      `https://realm.risuai.net/character/${id}/edit`,
      'https://realm.risuai.net/character/abc',
      `https://realm.risuai.net/?realm=${id}`,
      'https://risuai.xyz/?realm=abc',
      `javascript:alert('${id}')`,
    ]) {
      expect(realmCardId(input), input).toBeNull();
    }
  });
});

describe('downloadRealmCard', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Answers each download URL from the table, in the order they are asked. */
  function serve(answers: Record<string, () => Response>): string[] {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url);
        const format = /download\/([^/]+)\//.exec(url)![1]!;
        const answer = answers[format];
        if (!answer) throw new Error(`unexpected format ${format}`);
        return answer();
      }),
    );
    return asked;
  }
  const bytes = (size: number, type = 'application/zip') =>
    new Response(new Uint8Array(size), { headers: { 'content-type': type } });
  const code = async (promise: Promise<unknown>): Promise<string> =>
    promise.then(
      () => 'resolved',
      (error: unknown) => (error instanceof ApiError ? error.code : String(error)),
    );

  it('takes the charx when there is one, through the documented endpoint only', async () => {
    const asked = serve({ 'charx-v3': () => bytes(16) });
    const { file, sourceUrl } = await downloadRealmCard(`https://risuai.xyz/?realm=${id}`);
    expect(asked).toEqual([`https://realm.risuai.net/api/v1/download/charx-v3/${id}?cors=true`]);
    expect(file.name).toBe(`${id}.charx`);
    expect(file.size).toBe(16);
    expect(sourceUrl).toBe(page);
  });

  it('falls back to the PNG for a card that was uploaded as one', async () => {
    const asked = serve({
      'charx-v3': () => new Response(null, { status: 403 }),
      'png-v3': () => bytes(8, 'image/png'),
    });
    const { file } = await downloadRealmCard(page);
    expect(asked.map((url) => /download\/([^/]+)\//.exec(url)![1])).toEqual(['charx-v3', 'png-v3']);
    expect(asked.every((url) => !url.includes('non_commercial'))).toBe(true);
    expect(file.name).toBe(`${id}.png`);
  });

  it('turns each refusal into something the form can say', async () => {
    const status = (value: number) => () => new Response(null, { status: value });
    serve({ 'charx-v3': status(403), 'png-v3': status(403) });
    expect(await code(downloadRealmCard(page))).toBe('realm_forbidden');
    serve({ 'charx-v3': status(404) });
    expect(await code(downloadRealmCard(page))).toBe('realm_not_found');
    serve({ 'charx-v3': status(403), 'png-v3': status(429) });
    expect(await code(downloadRealmCard(page))).toBe('realm_rate_limited');
    serve({ 'charx-v3': status(502) });
    expect(await code(downloadRealmCard(page))).toBe('realm_unavailable');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await code(downloadRealmCard(page))).toBe('realm_unreachable');
    // Nothing is asked for an address that names no card.
    const asked = serve({});
    expect(await code(downloadRealmCard('https://example.com/x'))).toBe('realm_invalid_url');
    expect(asked).toEqual([]);
  });

  it('refuses a card over the import cap before reading it when Realm says its size', async () => {
    const body = vi.fn(() => new Uint8Array(1));
    serve({
      'charx-v3': () => {
        const res = new Response(new Uint8Array(1), {
          headers: { 'content-length': String(MAX_CARD_IMPORT_BYTES + 1) },
        });
        res.blob = body as unknown as Response['blob'];
        return res;
      },
    });
    expect(await code(downloadRealmCard(page))).toBe('card_too_large');
    expect(body).not.toHaveBeenCalled();
  });
});

describe('checkCardSize', () => {
  it('passes a card up to the cap and refuses one over it', () => {
    const sized = (size: number) => ({ size }) as File;
    expect(checkCardSize(sized(MAX_CARD_IMPORT_BYTES))).toEqual(sized(MAX_CARD_IMPORT_BYTES));
    expect(() => checkCardSize(sized(MAX_CARD_IMPORT_BYTES + 1))).toThrow(ApiError);
  });
});

describe('license terms', () => {
  it('reads the Creative Commons conditions, and nothing out of anything else', () => {
    expect(licenseTerms('CC BY-NC-SA 4.0')).toEqual(['by', 'nc', 'sa']);
    expect(licenseTerms('CC BY 4.0')).toEqual(['by']);
    for (const license of [null, '', 'CC0', 'private', 'MIT']) expect(licenseTerms(license)).toEqual([]);
  });

  it('warns harder for no-derivatives and private licenses only', () => {
    expect(isRestrictiveLicense('CC BY-ND 4.0')).toBe(true);
    expect(isRestrictiveLicense('CC BY-NC-ND 4.0')).toBe(true);
    expect(isRestrictiveLicense('private')).toBe(true);
    for (const license of [null, 'CC BY-NC 4.0', 'CC BY-SA 4.0', 'CC0']) {
      expect(isRestrictiveLicense(license), String(license)).toBe(false);
    }
  });
});
