/**
 * Cards from RisuRealm (realm.risuai.net), and what their licenses say.
 *
 * Realm documents its API for client-side use only (realm.risuai.net/help/api),
 * so the download runs here, in the reader's browser, through the one documented
 * endpoint with `?cors=true` — never through our server, and `non_commercial` is
 * never sent. The bytes then go to the import routes like a picked file, with
 * the page they came from beside them as `sourceUrl`.
 *
 * Failures are `ApiError`s with status 0 and a code of their own, so the forms
 * translate them from the `errors` catalogue the way they do the API's.
 */
import { realmCardId, realmCharacterUrl } from '@shizue/core/source-url';
import { ApiError } from './api';
import { MAX_CARD_IMPORT_BYTES } from './types';

export const REALM_ORIGIN = 'https://realm.risuai.net';

// The page shapes are shared with the API through `@shizue/core/source-url`.
export { realmCardId, realmCharacterUrl };

const failure = (code: string, message: string): ApiError => new ApiError(0, code, message);

/**
 * Refuses a card the import routes would refuse anyway, before it is sent: the
 * creator learns the limit now rather than after uploading hundreds of megabytes to hear it.
 */
export function checkCardSize(file: File): File {
  if (file.size > MAX_CARD_IMPORT_BYTES) {
    throw failure('card_too_large', `A card file is at most ${MAX_CARD_IMPORT_BYTES} bytes`);
  }
  return file;
}

/**
 * Downloads the card a Realm page names. `charx-v3` first, since that is the
 * card with its images; a card uploaded to Realm as a PNG is not served in that
 * format and says so with a 403, so `png-v3` is asked next. A 403 on both is a
 * card its author has not made downloadable.
 */
export async function downloadRealmCard(input: string): Promise<{ file: File; sourceUrl: string }> {
  const id = realmCardId(input);
  if (!id) throw failure('realm_invalid_url', 'Not a RisuRealm character page');

  const get = async (format: string): Promise<Response> => {
    try {
      return await fetch(`${REALM_ORIGIN}/api/v1/download/${format}/${id}?cors=true`);
    } catch {
      // A refused CORS request and a dropped connection look the same from here.
      throw failure('realm_unreachable', 'Could not reach RisuRealm');
    }
  };
  let extension = 'charx';
  let res = await get('charx-v3');
  if (res.status === 403) {
    extension = 'png';
    res = await get('png-v3');
  }
  if (res.status === 403) throw failure('realm_forbidden', 'This card cannot be downloaded');
  if (res.status === 404) throw failure('realm_not_found', 'No such card on RisuRealm');
  if (res.status === 429) throw failure('realm_rate_limited', 'RisuRealm is rate limiting');
  if (!res.ok) throw failure('realm_unavailable', `RisuRealm answered ${res.status}`);
  // Before the body, when Realm says how large it is: no point fetching 80MB to refuse it.
  if (Number(res.headers.get('content-length')) > MAX_CARD_IMPORT_BYTES) {
    throw failure('card_too_large', `A card file is at most ${MAX_CARD_IMPORT_BYTES} bytes`);
  }

  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    throw failure('realm_unreachable', 'The download from RisuRealm was cut off');
  }
  const file = checkCardSize(new File([blob], `${id}.${extension}`, { type: blob.type }));
  return { file, sourceUrl: realmCharacterUrl(id) };
}

/** The Creative Commons conditions a license code carries. */
export type LicenseTerm = 'by' | 'nc' | 'nd' | 'sa';

/**
 * The conditions in a Creative Commons code as Realm writes it (`CC BY-NC-SA
 * 4.0`), in the order it names them; empty for anything that is not one.
 */
export function licenseTerms(license: string | null): LicenseTerm[] {
  const code = /^CC[ -]?(BY(?:-(?:NC|ND|SA))*)\b/i.exec(license?.trim() ?? '')?.[1];
  return code ? (code.toLowerCase().split('-') as LicenseTerm[]) : [];
}

/**
 * A license under which the author has kept the character from being reworked
 * into someone else's piece (no derivatives) or from going public at all. The
 * studio warns harder for these rather than refusing: the owner may hold the
 * author's permission, which nothing here can see.
 */
export function isRestrictiveLicense(license: string | null): boolean {
  return license?.trim().toLowerCase() === 'private' || licenseTerms(license).includes('nd');
}
