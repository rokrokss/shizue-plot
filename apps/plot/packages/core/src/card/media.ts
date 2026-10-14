/**
 * What a file a card carries really is, read off its first bytes. A card's own
 * word for it is not to be trusted: RisuAI writes `ext: 'unknown'` for pictures
 * it re-encoded (Nanachi's 28 emotions), and a PNG card's assets are named by an
 * index with no extension at all. So the bytes decide, here as in the store.
 *
 * Only what a chat can draw or play is anything: the images a message shows and
 * the music RisuAI's `{{audio::…}}` and `{{bgm::…}}` play (characterCards.ts files
 * mp3, wav, ogg and flac as audio; m4a is the iTunes spelling of the same).
 */

export interface MediaType {
  kind: 'image' | 'audio';
  /** The extension it is stored under, without the dot. */
  ext: string;
  mime: string;
}

/** Bytes `sniffMedia` reads at most: an MP4 container's brand ends at the twelfth. */
export const MEDIA_SNIFF_BYTES = 12;

/**
 * Extensions a card may declare a picture under — a hint for what to read, never
 * the verdict. AVIF is one RisuAI files as an image (Jurassic girl Park's 31).
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);
/** The same for music. */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a']);

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
 * The picture or music `bytes` are, or null for anything else. An ISO media
 * file (`ftyp`) is told by its brand: AVIF's for a picture, iTunes audio's
 * (`M4A `, `M4B `) for music — the same box holds video, which nothing here plays.
 */
export function sniffMedia(bytes: Uint8Array): MediaType | null {
  if (at(bytes, '\x89PNG')) return { kind: 'image', ext: 'png', mime: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: 'image', ext: 'jpg', mime: 'image/jpeg' };
  if (at(bytes, 'GIF8')) return { kind: 'image', ext: 'gif', mime: 'image/gif' };
  if (at(bytes, 'RIFF') && at(bytes, 'WEBP', 8)) return { kind: 'image', ext: 'webp', mime: 'image/webp' };
  if (at(bytes, 'ftyp', 4) && (at(bytes, 'avif', 8) || at(bytes, 'avis', 8))) {
    return { kind: 'image', ext: 'avif', mime: 'image/avif' };
  }

  if (at(bytes, 'ID3') || isMpegFrame(bytes)) return { kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' };
  if (at(bytes, 'OggS')) return { kind: 'audio', ext: 'ogg', mime: 'audio/ogg' };
  if (at(bytes, 'RIFF') && at(bytes, 'WAVE', 8)) return { kind: 'audio', ext: 'wav', mime: 'audio/wav' };
  if (at(bytes, 'fLaC')) return { kind: 'audio', ext: 'flac', mime: 'audio/flac' };
  if (at(bytes, 'ftyp', 4) && (at(bytes, 'M4A ', 8) || at(bytes, 'M4B ', 8))) {
    return { kind: 'audio', ext: 'm4a', mime: 'audio/mp4' };
  }
  return null;
}
