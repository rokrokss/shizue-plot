import { zipSync } from 'fflate';

export interface CharxAssetSpec {
  type: string;
  name: string;
  ext: string;
  /** Path of the zip entry the asset points at. */
  entry: string;
  bytes: Uint8Array;
}

/**
 * Builds a .charx archive: `card.json` with the asset list wired to real zip
 * entries, plus one entry per asset. Shared with the api suite, which has no
 * fflate of its own.
 */
export function buildCharx(card: { data: Record<string, unknown> }, assets: CharxAssetSpec[]): Uint8Array {
  const json = {
    ...card,
    data: {
      ...card.data,
      assets: assets.map((asset) => ({
        type: asset.type,
        name: asset.name,
        uri: `embeded://${asset.entry}`,
        ext: asset.ext,
      })),
    },
  };
  const files: Record<string, Uint8Array> = {
    'card.json': new TextEncoder().encode(JSON.stringify(json)),
  };
  for (const asset of assets) files[asset.entry] = asset.bytes;
  return zipSync(files);
}
