import { describe, expect, it } from 'vitest';
import {
  bracketLists,
  fetchUrlOf,
  findExternal,
  inlinableCss,
  isFontStylesheet,
  isLocalizedAssetName,
  linearCaptures,
  localizedName,
  localizedTemplateName,
  parseUrlTemplate,
  rewriteExternal,
  templateCandidates,
  templateUrl,
  underMedia,
  withoutLocalSources,
} from '../src/card/externalAssets.js';
import { sniffFont, sniffMedia } from '../src/card/media.js';

describe('findExternal', () => {
  it('finds the three spellings of a resource on another host, and nothing of ours', () => {
    const text = [
      `<style>@import url('https://fonts.test/a.css') screen and (min-width: 768px);`,
      `@import "//fonts.test/b.css";`,
      `.a{background:url(https://cdn.test/a.png)} .b{background:url( "/api/plots/x/assets/b" )}</style>`,
      `<img src="http://cdn.test/c.png" data-src="https://cdn.test/lazy.png"><img src=https://cdn.test/d.png>`,
      `<svg xmlns="http://www.w3.org/2000/svg"></svg><div style="background:url(data:image/png;base64,AAAA)"></div>`,
    ].join('\n');
    expect(findExternal(text).map((ref) => [ref.kind, ref.url, ref.media])).toEqual([
      ['import', 'https://fonts.test/a.css', 'screen and (min-width: 768px)'],
      ['import', 'https://fonts.test/b.css', ''],
      ['url', 'https://cdn.test/a.png', ''],
      ['src', 'https://cdn.test/c.png', ''],
      ['src', 'https://cdn.test/d.png', ''],
    ]);
  });

  it('reads an entity in an attribute as the browser does, and leaves a template unfetchable', () => {
    expect(findExternal('<img src="https://cdn.test/a.png?w=1&amp;h=2">')[0]!.url).toBe('https://cdn.test/a.png?w=1&h=2');
    const [ref] = findExternal("<div style=\"background:url('https://cdn.test/face/$2.png')\">");
    expect(ref).toMatchObject({ kind: 'url', address: 'https://cdn.test/face/$2.png', url: null });
  });

  it('stays linear on a long run with no close', () => {
    const text = `url(${' '.repeat(200_000)}`;
    const started = performance.now();
    expect(findExternal(text)).toEqual([]);
    expect(findExternal(`@import url('${'a'.repeat(200_000)}`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('rewriteExternal', () => {
  it('swaps an address in place, keeping its quotes, and a whole @import statement', () => {
    const text = `<style>@import url("https://fonts.test/a.css") print;\n.a{background:url('https://cdn.test/a.png')}</style><img src="https://cdn.test/b.png">`;
    const out = rewriteExternal(text, (ref) =>
      ref.kind === 'import' ? underMedia('@font-face{}', ref.media) : ref.url === 'https://cdn.test/a.png' ? '/mine/a' : undefined,
    );
    expect(out).toBe(
      `<style>@media print {\n@font-face{}\n}\n.a{background:url('/mine/a')}</style><img src="https://cdn.test/b.png">`,
    );
  });
});

describe('templates', () => {
  it('reads the one slot of an address: a capture or a draw among words and captures', () => {
    expect(parseUrlTemplate('https://cdn.test/face/$2.png?tr=w-300')).toEqual({
      prefix: 'https://cdn.test/face/',
      slot: '$2',
      suffix: '.png?tr=w-300',
      literals: [],
      captures: [2],
    });
    expect(parseUrlTemplate('//cdn.test/{{random::$2::$3}}.png')).toMatchObject({ captures: [2, 3], literals: [] });
    expect(parseUrlTemplate('https://cdn.test/{{random::Calm::Sad}}.png')).toMatchObject({ literals: ['Calm', 'Sad'] });
    // Two slots, another macro, a slot in the host: nothing it can fetch.
    expect(parseUrlTemplate('https://cdn.test/$1/$2.png')).toBeNull();
    expect(parseUrlTemplate('https://cdn.test/{{getvar::mood}}.png')).toBeNull();
    expect(parseUrlTemplate('https://$1.test/a.png')).toBeNull();
  });

  it('names the values a slot takes: its words, its captures in the card, and the lists that hold them', () => {
    const template = parseUrlTemplate('https://cdn.test/{{random::$1::Calm}}.png')!;
    const texts = ['[face:Happy] 안녕', 'Faces: [Happy, Angry, Very Sad]', 'Colors: [Red, Blue]', '[face:../x]'];
    const captured = linearCaptures('\\[face:([^\\]]+)\\]', 'g', texts, [1]);
    expect(captured.get(1)).toEqual(['Happy', '../x']);
    expect(templateCandidates(template, captured, bracketLists(texts))).toEqual(['Calm', 'Happy', 'Angry', 'Very Sad']);
    expect(templateUrl(template, 'Very Sad')).toBe('https://cdn.test/Very%20Sad.png');
    expect(localizedName(templateUrl(template, 'Very Sad'))).toBe('https://cdn.test/Very Sad.png');
    expect(localizedTemplateName(template)).toBe('https://cdn.test/{{random::$1::Calm}}.png');
  });

  it('captures nothing with a pattern the linear engine cannot compile', () => {
    expect(linearCaptures('(?<=a)b', '', ['ab'], [0]).get(0)).toEqual([]);
  });
});

describe('stylesheets', () => {
  it('tells a web font sheet apart, and refuses one that would end its <style> or carries CBS', () => {
    expect(isFontStylesheet("/* latin */\n@font-face { font-family: 'A'; src: url(https://f.test/a.woff2); }\n")).toBe(true);
    expect(isFontStylesheet('@font-face{} .a{color:red}')).toBe(false);
    expect(inlinableCss('@charset "utf-8";\n.a{color:red}')).toBe('.a{color:red}');
    expect(inlinableCss('.a{}</style><script>')).toBeNull();
    expect(inlinableCss('.a{content:"{{setvar::x::1}}"}')).toBeNull();
  });

  it("drops a face's local() sources, which would cost it its place at render", () => {
    expect(
      withoutLocalSources("@font-face { src: local('Muttiara'), url('https://f.test/m.woff') format('woff'); }"),
    ).toBe("@font-face { src: url('https://f.test/m.woff') format('woff'); }");
    expect(withoutLocalSources("src: url(a.woff2) format('woff2'), local(\"A B\");")).toBe("src: url(a.woff2) format('woff2');");
  });

  it('keeps addresses fetchable only as https, without credentials', () => {
    expect(fetchUrlOf('http://cdn.test/a.png')).toBe('https://cdn.test/a.png');
    expect(fetchUrlOf('https://user:pw@cdn.test/a.png')).toBeNull();
    expect(isLocalizedAssetName('https://cdn.test/a.png')).toBe(true);
    expect(isLocalizedAssetName('face.png')).toBe(false);
  });
});

describe('media sniffing', () => {
  it('reads an AVIF written as a generic HEIF by its compatible brands', () => {
    const ftyp = (major: string, ...compatible: string[]): Uint8Array => {
      const brands = [major, '\0\0\0\0', ...compatible].join('');
      const size = 8 + brands.length;
      return new Uint8Array([0, 0, 0, size, ...[...`ftyp${brands}`].map((char) => char.charCodeAt(0))]);
    };
    expect(sniffMedia(ftyp('mif1', 'mif1', 'avif', 'miaf'))).toMatchObject({ kind: 'image', ext: 'avif' });
    expect(sniffMedia(ftyp('mif1', 'mif1', 'heic'))).toBeNull();
  });

  it('reads a web font only where asked', () => {
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1]);
    expect(sniffMedia(woff2)).toBeNull();
    expect(sniffFont(woff2)).toEqual({ ext: 'woff2', mime: 'font/woff2' });
    expect(sniffFont(new Uint8Array([0, 1, 0, 0, 0, 9]))).toEqual({ ext: 'ttf', mime: 'font/ttf' });
  });
});
