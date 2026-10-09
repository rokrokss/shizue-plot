import type { NormalizedCard } from '../types.js';
import { isZip, readCharx, type CharxAssetFile } from './charx.js';
import { CardParseError, normalizeCard } from './normalize.js';
import { isPng, readPngTextChunks } from './png.js';

export interface ParsedCard {
  card: NormalizedCard;
  /** Avatar bytes when the source carried one (PNG itself, or the charx main icon). */
  iconBuffer?: Uint8Array;
  /** Embedded images beside the icon. Only a charx archive can carry them. */
  assets?: CharxAssetFile[];
}

/** tEXt keywords holding a card payload, in priority order. */
const CARD_CHUNKS = ['ccv3', 'chara'];

function decodeBase64Json(base64: string): unknown {
  const json = Buffer.from(base64, 'base64').toString('utf-8');
  return JSON.parse(json);
}

function parsePngCard(bytes: Uint8Array): ParsedCard {
  const chunks = readPngTextChunks(bytes);
  for (const keyword of CARD_CHUNKS) {
    const payload = chunks.get(keyword);
    if (!payload) continue;
    return { card: normalizeCard(decodeBase64Json(payload)), iconBuffer: bytes };
  }
  throw new CardParseError('PNG has no ccv3 or chara tEXt chunk');
}

/** Parses a character card from raw bytes (PNG / charx / JSON) or a JSON value. */
export function parseCard(input: Uint8Array | string | object): ParsedCard {
  if (typeof input === 'string') {
    return { card: normalizeCard(JSON.parse(input)) };
  }
  if (!(input instanceof Uint8Array)) {
    return { card: normalizeCard(input) };
  }
  if (isPng(input)) {
    return parsePngCard(input);
  }
  if (isZip(input)) {
    const { raw, iconBuffer, assets } = readCharx(input);
    const card = normalizeCard(raw);
    return iconBuffer ? { card, iconBuffer, assets } : { card, assets };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8').decode(input));
  } catch {
    throw new CardParseError('Unsupported card file: not PNG, charx, or JSON');
  }
  return { card: normalizeCard(raw) };
}
