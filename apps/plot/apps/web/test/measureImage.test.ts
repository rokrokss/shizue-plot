// @vitest-environment jsdom
/**
 * The measurement the uploader takes before it sends an image.
 *
 * jsdom has neither a decoder nor a canvas, so both are stood in for: what is
 * actually under test is the arithmetic around them — the bitmap is scaled into
 * the 100px box thumbhash requires, its size is read while it is still open, and
 * a file the browser cannot decode is measured as nothing rather than as a guess.
 */
import { thumbHashToRGBA } from 'thumbhash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureImage } from '../src/lib/assets';

const file = (): File => new File([new Uint8Array([1, 2, 3])], 'picture.png', { type: 'image/png' });

/** The size the bitmap was drawn at, which is what the hash is taken from. */
let drawnAt: [number, number] | null = null;

function stub(bitmap: { width: number; height: number } | null): { closed: () => boolean } {
  let closed = false;
  globalThis.createImageBitmap = (async () => {
    if (!bitmap) throw new Error('no decoder for this file');
    return {
      get width() {
        return closed ? 0 : bitmap.width;
      },
      get height() {
        return closed ? 0 : bitmap.height;
      },
      close: () => {
        closed = true;
      },
    };
  }) as unknown as typeof createImageBitmap;

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: (_image: unknown, _x: number, _y: number, w: number, h: number) => {
      drawnAt = [w, h];
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(180),
    }),
  } as never);

  return { closed: () => closed };
}

afterEach(() => {
  vi.restoreAllMocks();
  drawnAt = null;
});

describe('measureImage', () => {
  it('reports the intrinsic size and a hash taken from a 100px copy', async () => {
    const bitmap = stub({ width: 1600, height: 900 });
    const measured = (await measureImage(file()))!;

    expect(measured.width).toBe(1600);
    expect(measured.height).toBe(900);
    // Scaled to fit the format's 100px limit, ratio kept.
    expect(drawnAt).toEqual([100, 56]);
    // The bitmap is released, and its size was read before that happened.
    expect(bitmap.closed()).toBe(true);

    // What comes back is a thumbhash, in the base64 the API stores.
    const bytes = Uint8Array.from(atob(measured.thumbhash), (ch) => ch.charCodeAt(0));
    expect(measured.thumbhash).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(thumbHashToRGBA(bytes).rgba.length).toBeGreaterThan(0);
  });

  it('does not scale an image already smaller than the box', async () => {
    stub({ width: 40, height: 30 });
    const measured = (await measureImage(file()))!;
    expect([measured.width, measured.height]).toEqual([40, 30]);
    expect(drawnAt).toEqual([40, 30]);
  });

  it('measures nothing when the file will not decode', async () => {
    stub(null);
    expect(await measureImage(file())).toBeNull();
  });
});
