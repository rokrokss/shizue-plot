/**
 * RisuRealm character pages, which is what an import's `sourceUrl` may name.
 *
 * The server never fetches from Realm — its API is documented for client-side
 * use only — so the URL is the importer's word, recorded beside the hash of the
 * bytes that actually arrived. The shapes live in `@shizue/core/source-url`,
 * which the web's `lib/realm.ts` reads too, so the two cannot disagree.
 */
export { realmCardId, realmCharacterUrl } from '@shizue/core/source-url';
