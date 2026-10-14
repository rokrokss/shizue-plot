/**
 * The page an import says it came from (`@shizue/core/source-url`): RisuRealm
 * cards, and the public pages of the platforms paste migration reads.
 *
 * The server never fetches any of them — Realm's API is documented for
 * client-side use only, and the paste platforms have no export at all — so a
 * URL is the importer's word, recorded beside what actually arrived. All that is
 * checked is that it names a page of that platform, and it is stored in one
 * spelling whatever shape it was pasted in. The API and the web both answer
 * through this file, so the two cannot disagree on a shape.
 */

import type { MigrationPlatform } from './migrate/types.js';

export type SourcePlatform = MigrationPlatform | 'realm';

/** Realm card ids, and the plot and character ids the paste platforms use, are UUIDs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Realm's older cards are named by 64 hex digits instead (a hash of the card),
 * and are served as PNG only (`isLegacyRealmId`).
 */
const LEGACY_REALM_ID = /^[0-9a-f]{64}$/i;
/** A Realm card id of either shape. */
const isRealmId = (id: string): boolean => UUID.test(id) || LEGACY_REALM_ID.test(id);

/**
 * Whether a Realm card id is the older 64-hex shape. Realm keeps those as the
 * PNG they were uploaded as: `charx-v3` refuses them, `png-v3` serves them.
 */
export const isLegacyRealmId = (id: string): boolean => LEGACY_REALM_ID.test(id);
/** A path segment naming a locale (`ko`, `en`, `zh-TW`). */
const LOCALE = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;
/** Crack's detail ids are not UUIDs; anything segment-shaped and bounded passes. */
const CRACK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The one spelling a Realm card page is stored in. */
export const realmCharacterUrl = (id: string): string => `https://realm.risuai.net/character/${id}`;

/**
 * The card id in `https://realm.risuai.net/character/<id>`,
 * `https://risuai.xyz/?realm=<id>` or a bare id; null for anything else. The
 * id is a UUID, or a legacy card's 64 hex digits.
 */
export function realmCardId(input: string): string | null {
  const value = input.trim();
  if (isRealmId(value)) return value;
  const url = webUrl(value);
  if (!url) return null;
  if (url.hostname === 'realm.risuai.net') {
    const id = /^\/character\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    return id && isRealmId(id) ? id : null;
  }
  if (url.hostname === 'risuai.xyz' || url.hostname === 'www.risuai.xyz') {
    const id = url.searchParams.get('realm');
    return id && isRealmId(id) ? id : null;
  }
  return null;
}

/** An http(s) URL, or null for anything else (including `javascript:`). */
function webUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
}

/** The path's segments, ignoring one trailing slash. */
const segments = (url: URL): string[] => url.pathname.replace(/\/$/, '').split('/').slice(1);

/**
 * The canonical page for what the creator pasted, or null when it is not a page
 * of that platform. Query strings and fragments never matter; a locale segment
 * is stored as `ko`, ids in lower case, and `www.` is dropped.
 *
 * - zeta `https://zeta-ai.io/{locale}/plots/<uuid>/profile`
 * - caveduck `https://caveduck.io/{locale}/characters/<uuid>`
 * - babechat `https://babechat.ai/character/u/<uuid>/profile`
 * - crack `https://crack.wrtn.ai/detail/<id>`
 * - elyn any page on `elyn.ai` but its front page — the shape of a character
 *   page there is not known yet, so only the host is checked
 * - realm as `realmCardId` reads it
 */
export function sourceUrlFor(platform: SourcePlatform, input: string): string | null {
  if (platform === 'realm') {
    const id = realmCardId(input);
    return id ? realmCharacterUrl(id) : null;
  }
  const url = webUrl(input.trim());
  if (!url) return null;
  const host = url.hostname.replace(/^www\./, '');
  const path = segments(url);

  switch (platform) {
    case 'zeta': {
      const [locale, plots, id, profile] = path;
      return host === 'zeta-ai.io' &&
        path.length === 4 &&
        LOCALE.test(locale!) &&
        plots === 'plots' &&
        UUID.test(id!) &&
        profile === 'profile'
        ? `https://zeta-ai.io/ko/plots/${id!.toLowerCase()}/profile`
        : null;
    }
    case 'caveduck': {
      const [locale, characters, id] = path;
      return host === 'caveduck.io' &&
        path.length === 3 &&
        LOCALE.test(locale!) &&
        characters === 'characters' &&
        UUID.test(id!)
        ? `https://caveduck.io/ko/characters/${id!.toLowerCase()}`
        : null;
    }
    case 'babechat': {
      const [character, u, id, profile] = path;
      return host === 'babechat.ai' &&
        path.length === 4 &&
        character === 'character' &&
        u === 'u' &&
        UUID.test(id!) &&
        profile === 'profile'
        ? `https://babechat.ai/character/u/${id!.toLowerCase()}/profile`
        : null;
    }
    case 'crack': {
      const [detail, id] = path;
      return host === 'crack.wrtn.ai' && path.length === 2 && detail === 'detail' && CRACK_ID.test(id!)
        ? `https://crack.wrtn.ai/detail/${id}`
        : null;
    }
    case 'elyn':
      return host === 'elyn.ai' && path.some((segment) => segment.length > 0)
        ? `https://elyn.ai${url.pathname.replace(/\/$/, '')}`
        : null;
    default:
      return null;
  }
}
