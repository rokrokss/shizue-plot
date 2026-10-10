/**
 * RisuRealm character pages, which is what an import's `sourceUrl` may name.
 *
 * The server never fetches from Realm — its API is documented for client-side
 * use only — so the URL is the importer's word, recorded beside the hash of the
 * bytes that actually arrived. All that is checked here is that it names a
 * Realm card, and it is stored in one spelling whatever shape it was pasted in.
 * The web's `lib/realm.ts` reads the same shapes, so the two must agree.
 */

/** Realm card ids are UUIDs. Anything looser would let any string through as one. */
const REALM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one spelling a card page is stored in. */
export const realmCharacterUrl = (id: string): string => `https://realm.risuai.net/character/${id}`;

/**
 * The card id in `https://realm.risuai.net/character/<id>`,
 * `https://risuai.xyz/?realm=<id>` or a bare id; null for anything else.
 */
export function realmCardId(input: string): string | null {
  const value = input.trim();
  if (REALM_ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname === 'realm.risuai.net') {
    const id = /^\/character\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    return id && REALM_ID.test(id) ? id : null;
  }
  if (url.hostname === 'risuai.xyz' || url.hostname === 'www.risuai.xyz') {
    const id = url.searchParams.get('realm');
    return id && REALM_ID.test(id) ? id : null;
  }
  return null;
}
