/**
 * What a card's embedded file is, from its first bytes: the pictures a message
 * draws, the music RisuAI's `{{audio::…}}` / `{{bgm::…}}` play, and the videos
 * its `{{video::…}}` / `{{video-img::…}}` play.
 */
import { describe, expect, it } from 'vitest';
import { sniffMedia } from '../src/card/media.js';

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? [...Buffer.from(part, 'latin1')] : part)));

describe('sniffMedia', () => {
  it('knows the pictures', () => {
    expect(sniffMedia(bytes('\x89PNG\r\n\x1a\n'))).toEqual({ kind: 'image', ext: 'png', mime: 'image/png' });
    expect(sniffMedia(bytes([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe('jpg');
    expect(sniffMedia(bytes('GIF89a'))?.ext).toBe('gif');
    expect(sniffMedia(bytes('RIFF', [1, 2, 3, 4], 'WEBP'))?.ext).toBe('webp');
    expect(sniffMedia(bytes([0, 0, 0, 0x1c], 'ftypavif'))).toEqual({ kind: 'image', ext: 'avif', mime: 'image/avif' });
  });

  it('knows the music', () => {
    expect(sniffMedia(bytes('ID3', [4, 0]))).toEqual({ kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' });
    // A bare MPEG-1 Layer III frame header, no tag in front.
    expect(sniffMedia(bytes([0xff, 0xfb, 0x90, 0x64]))?.ext).toBe('mp3');
    expect(sniffMedia(bytes('OggS', [0, 2]))).toMatchObject({ ext: 'ogg', mime: 'audio/ogg' });
    expect(sniffMedia(bytes('RIFF', [1, 2, 3, 4], 'WAVE'))).toMatchObject({ ext: 'wav', mime: 'audio/wav' });
    expect(sniffMedia(bytes('fLaC'))).toMatchObject({ ext: 'flac', mime: 'audio/flac' });
    expect(sniffMedia(bytes([0, 0, 0, 0x20], 'ftypM4A '))).toMatchObject({ ext: 'm4a', mime: 'audio/mp4' });
  });

  it('knows the videos a browser plays, all MP4s as one', () => {
    const mp4 = { kind: 'video', ext: 'mp4', mime: 'video/mp4' };
    for (const brand of ['isom', 'iso5', 'mp42', 'avc1', 'M4V ', 'M4VP', 'dash']) {
      expect(sniffMedia(bytes([0, 0, 0, 0x20], `ftyp${brand}`, [0, 0, 2, 0], 'isomiso2'))).toEqual(mp4);
    }
    // ffmpeg's WebM header: EBML, its versions, then DocType `webm`.
    const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81, 1, 0x42, 0xf2, 0x81, 4, 0x42, 0xf3, 0x81, 8];
    expect(sniffMedia(bytes(ebml, [0x42, 0x82, 0x84], 'webm', [0x42, 0x87, 0x81, 4]))).toEqual({
      kind: 'video',
      ext: 'webm',
      mime: 'video/webm',
    });
    // A DocType size written long (`01 00 … 04`) is the same four bytes.
    expect(sniffMedia(bytes(ebml, [0x42, 0x82, 0x01, 0, 0, 0, 0, 0, 0, 4], 'webm'))?.ext).toBe('webm');
    // Still the picture and the music where the same box says so.
    expect(sniffMedia(bytes([0, 0, 0, 0x20], 'ftypM4A ', [0, 0, 0, 0], 'isom'))?.kind).toBe('audio');
    expect(sniffMedia(bytes([0, 0, 0, 0x20], 'ftypmif1', [0, 0, 0, 0], 'avifmif1'))?.kind).toBe('image');
  });

  it('takes nothing else for any of them', () => {
    // ADTS AAC shares the sync bits with MP3 but has layer 0; HEIC, QuickTime,
    // Matroska and AVI are what not every browser (or none) plays; a JPEG is
    // not a frame header.
    expect(sniffMedia(bytes([0xff, 0xf1, 0x50, 0x80]))).toBeNull();
    expect(sniffMedia(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0], 'mif1heic'))).toBeNull();
    expect(sniffMedia(bytes([0, 0, 0, 0x14], 'ftypqt  '))).toBeNull();
    expect(sniffMedia(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88], 'matroska'))).toBeNull();
    expect(sniffMedia(bytes('RIFF', [1, 2, 3, 4], 'AVI '))).toBeNull();
    expect(sniffMedia(bytes('PK', [3, 4]))).toBeNull();
    expect(sniffMedia(new Uint8Array())).toBeNull();
  });
});
