/**
 * What a card's embedded file is, from its first bytes: the pictures a message
 * draws and the music RisuAI's `{{audio::…}}` / `{{bgm::…}}` play.
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

  it('takes nothing else for either', () => {
    // ADTS AAC shares the sync bits with MP3 but has layer 0; an MP4 that is not
    // the iTunes audio brand may be video; a JPEG is not a frame header.
    expect(sniffMedia(bytes([0xff, 0xf1, 0x50, 0x80]))).toBeNull();
    expect(sniffMedia(bytes([0, 0, 0, 0x20], 'ftypisom'))).toBeNull();
    expect(sniffMedia(bytes('RIFF', [1, 2, 3, 4], 'AVI '))).toBeNull();
    expect(sniffMedia(bytes('PK', [3, 4]))).toBeNull();
    expect(sniffMedia(new Uint8Array())).toBeNull();
  });
});
