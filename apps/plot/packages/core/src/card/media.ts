/**
 * What a file a card carries really is, read off its first bytes. A card's own
 * word for it is not to be trusted: RisuAI writes `ext: 'unknown'` for pictures
 * it re-encoded (Nanachi's 28 emotions), and a PNG card's assets are named by an
 * index with no extension at all. So the bytes decide, here as in the store.
 *
 * Only what a chat can draw or play is anything: the images a message shows, the
 * music RisuAI's `{{audio::…}}` and `{{bgm::…}}` play (characterCards.ts files
 * mp3, wav, ogg and flac as audio; m4a is the iTunes spelling of the same), and
 * the videos its `{{video::…}}`, `{{video-img::…}}` and `{{asset::…}}` play —
 * those a browser can: MP4 and WebM. RisuAI also counts AVI, MOV and MKV as
 * video, which no browser (AVI) or not every one (MOV, MKV) plays, so they are
 * nothing here.
 */

export interface MediaType {
  kind: 'image' | 'audio' | 'video';
  /** The extension it is stored under, without the dot. */
  ext: string;
  mime: string;
}

/**
 * Bytes `sniffMedia` reads at most: an ISO media file's `ftyp` box — its major
 * brand ends at the twelfth, and the compatible brands after it, where an AVIF
 * written as a generic HEIF (`mif1`) says what it is, end well inside this.
 */
export const MEDIA_SNIFF_BYTES = 64;

/**
 * Extensions a card may declare a picture under — a hint for what to read, never
 * the verdict. AVIF is one RisuAI files as an image (Jurassic girl Park's 31).
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);
/** The same for music. */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a']);
/** The same for web fonts (`sniffFont`), which RisuAI's charx export files under `assets/<type>/fonts/`. */
export const FONT_EXTENSIONS: ReadonlySet<string> = new Set(['woff2', 'woff', 'otf', 'ttf']);
/**
 * The same for video: RisuAI's `videoExtensions` (`{{asset::…}}` plays these),
 * and the rest its export files as video. Only a hint — the bytes keep what a
 * browser plays (`sniffMedia`) and pass over the rest.
 */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'webm', 'm4v', 'm4p', 'mov', 'avi', 'mkv']);

const at = (bytes: Uint8Array, signature: string, offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  [...signature].every((char, i) => bytes[offset + i] === char.charCodeAt(0));

/**
 * An MPEG audio frame header without an ID3 tag in front: eleven sync bits, then
 * a version that is not the reserved one and a layer that is not 0 — which is
 * what tells MP3 apart from ADTS AAC, whose layer bits are always 0.
 */
function isMpegFrame(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return false;
  const version = (bytes[1]! >> 3) & 0b11;
  const layer = (bytes[1]! >> 1) & 0b11;
  return version !== 0b01 && layer !== 0b00;
}

/**
 * Whether an ISO media file is an AVIF picture: its major brand says so, or —
 * written as a generic HEIF (`mif1`, `msf1`) — one of the compatible brands
 * after it does, as far as the `ftyp` box and the bytes at hand reach.
 */
function isAvif(bytes: Uint8Array): boolean {
  if (!at(bytes, 'ftyp', 4)) return false;
  if (at(bytes, 'avif', 8) || at(bytes, 'avis', 8)) return true;
  const box = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  const end = Math.min(box, bytes.length);
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (at(bytes, 'avif', offset) || at(bytes, 'avis', offset)) return true;
  }
  return false;
}

/**
 * Major brands of an ISO media file that is an MP4 video — the generic ISO ones,
 * the MP4 versions, H.264's, Apple's M4V and DASH's. Named one by one, so what a
 * browser does not play (QuickTime's `qt  `, HEIF's `heic`) stays nothing, and
 * read after the picture's and the music's brands.
 */
const MP4_VIDEO_BRANDS: ReadonlySet<string> = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VH', 'M4VP', 'dash',
]);

const brandAt = (bytes: Uint8Array, offset: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** EBML's magic, which opens a WebM file — and a Matroska one, which its DocType tells apart. */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/**
 * Whether an EBML file is a WebM: its header's DocType element (`42 82`, a size,
 * then the value) says `webm` rather than `matroska`, as far as the bytes at
 * hand reach — the header is a few dozen bytes, so it is there.
 */
function isWebm(bytes: Uint8Array): boolean {
  if (!EBML_MAGIC.every((byte, i) => bytes[i] === byte)) return false;
  for (let offset = 4; offset + 3 < bytes.length; offset += 1) {
    if (bytes[offset] !== 0x42 || bytes[offset + 1] !== 0x82) continue;
    // The size is an EBML variable-length integer: its leading zeros say how many bytes it takes.
    const first = bytes[offset + 2]!;
    const width = Math.clz32(first) - 23;
    if (width < 1 || width > 8) continue;
    let size = first & (0xff >> width);
    for (let i = 1; i < width; i += 1) size = size * 256 + (bytes[offset + 2 + i] ?? 0);
    if (size === 4 && at(bytes, 'webm', offset + 2 + width)) return true;
  }
  return false;
}

/**
 * The picture, music or video `bytes` are, or null for anything else. An ISO
 * media file (`ftyp`) is told by its brands: AVIF's for a picture (`isAvif`),
 * iTunes audio's (`M4A `, `M4B `) for music, an MP4 video's
 * (`MP4_VIDEO_BRANDS`) for video — every one stored as MP4, the type RisuAI's
 * own `<source>` names. An EBML file is a video when it is a WebM (`isWebm`).
 */
export function sniffMedia(bytes: Uint8Array): MediaType | null {
  if (at(bytes, '\x89PNG')) return { kind: 'image', ext: 'png', mime: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: 'image', ext: 'jpg', mime: 'image/jpeg' };
  if (at(bytes, 'GIF8')) return { kind: 'image', ext: 'gif', mime: 'image/gif' };
  if (at(bytes, 'RIFF') && at(bytes, 'WEBP', 8)) return { kind: 'image', ext: 'webp', mime: 'image/webp' };
  if (isAvif(bytes)) return { kind: 'image', ext: 'avif', mime: 'image/avif' };

  if (at(bytes, 'ID3') || isMpegFrame(bytes)) return { kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' };
  if (at(bytes, 'OggS')) return { kind: 'audio', ext: 'ogg', mime: 'audio/ogg' };
  if (at(bytes, 'RIFF') && at(bytes, 'WAVE', 8)) return { kind: 'audio', ext: 'wav', mime: 'audio/wav' };
  if (at(bytes, 'fLaC')) return { kind: 'audio', ext: 'flac', mime: 'audio/flac' };
  if (at(bytes, 'ftyp', 4) && (at(bytes, 'M4A ', 8) || at(bytes, 'M4B ', 8))) {
    return { kind: 'audio', ext: 'm4a', mime: 'audio/mp4' };
  }

  if (at(bytes, 'ftyp', 4) && MP4_VIDEO_BRANDS.has(brandAt(bytes, 8))) {
    return { kind: 'video', ext: 'mp4', mime: 'video/mp4' };
  }
  if (isWebm(bytes)) return { kind: 'video', ext: 'webm', mime: 'video/webm' };
  return null;
}

/** A web font file's type, as `sniffFont` reads it off its first bytes. */
export interface FontType {
  ext: 'woff2' | 'woff' | 'otf' | 'ttf';
  mime: string;
}

/**
 * The web font `bytes` are, or null. Apart from `sniffMedia` on purpose: a font
 * is no picture or music a message draws, only what a stylesheet names
 * (`@font-face`) — one the import localized, or one a card carries for its own
 * sheet to reach as `{{raw::name}}`, as RisuAI's own charx export writes a
 * card's fonts — so only those paths ask.
 */
export function sniffFont(bytes: Uint8Array): FontType | null {
  if (at(bytes, 'wOF2')) return { ext: 'woff2', mime: 'font/woff2' };
  if (at(bytes, 'wOFF')) return { ext: 'woff', mime: 'font/woff' };
  if (at(bytes, 'OTTO')) return { ext: 'otf', mime: 'font/otf' };
  if (at(bytes, '\x00\x01\x00\x00') || at(bytes, 'true')) return { ext: 'ttf', mime: 'font/ttf' };
  return null;
}
