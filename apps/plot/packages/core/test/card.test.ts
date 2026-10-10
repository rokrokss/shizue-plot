import { unzipSync, unzlibSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { exportCardPng, exportCardV3 } from '../src/card/export.js';
import { CardParseError, normalizeCard, parseDecorators } from '../src/card/normalize.js';
import { parseCard } from '../src/card/parse.js';
import { MAX_INTRO_LENGTH } from '../src/card/intro.js';
import {
  insertPngTextChunks,
  isPng,
  placeholderPng,
  readPngTextChunks,
  stripPngTextChunks,
} from '../src/card/png.js';
import { assemblePrompt } from '../src/prompt.js';
import type { LoreEntry } from '../src/types.js';
import { stCard, v1Card, v2Card, v3Card } from './fixtures/cards.js';
import { buildPngWithTextChunks } from './helpers/png.js';
import { buildRisum } from './helpers/risum.js';

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const toBase64 = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');

describe('parseDecorators', () => {
  it('reads the supported subset off the leading decorator block', () => {
    expect(parseDecorators('@@depth 2\n@@role user\n@@constant\n본문')).toEqual({
      decorators: { depth: 2, role: 'user', constant: true },
      body: '본문',
    });
    expect(parseDecorators('@@position before_desc\n본문').decorators).toEqual({
      position: 'before_char',
    });
    expect(parseDecorators('@@position after_desc\n본문').decorators).toEqual({
      position: 'after_char',
    });
  });

  it('strips unknown decorators, fallbacks, and malformed arguments without effect', () => {
    expect(
      parseDecorators(
        '@@ignore_on_max_context\n@@@depth 2\n@@depth abc\n@@role narrator\n@@position personality\n@@scan_depth many\n@@exclude_keys  , \n본문',
      ),
    ).toEqual({ decorators: {}, body: '본문' });
  });

  it('reads the activation decorators onto their SillyTavern-shaped fields', () => {
    expect(
      parseDecorators(
        '@@activate_only_after 3\n@@scan_depth 0\n@@keep_activate_after_match\n@@dont_activate_after_match\n@@exclude_keys 왕비, Queen \n본문',
      ).decorators,
    ).toEqual({
      delay: 3,
      scanDepth: 0,
      sticky: 10000,
      cooldown: 10000,
      // Keys are matched as written, so this argument keeps its case.
      excludeKeys: ['왕비', 'Queen'],
    });
  });

  it('turns @@exclude_keys into NOT_ANY secondary keys, only where there is room for them', () => {
    const entry = (content: string, overrides: Record<string, unknown> = {}) =>
      parseCard({
        ...v3Card,
        data: {
          ...v3Card.data,
          character_book: {
            extensions: {},
            entries: [{ ...v3Card.data.character_book.entries[1]!, keys: ['궁'], content, ...overrides }],
          },
        },
      }).card.lorebook[0]!;

    const excluded = entry('@@exclude_keys 왕비,시녀\n본문');
    expect(excluded.secondaryKeys).toEqual(['왕비', '시녀']);
    expect(excluded.selective).toBe(true);
    expect(excluded.selectiveLogic).toBe('not_any');
    // An entry with secondary keys of its own keeps them; a regex entry ignores
    // the decorator, as the V3 spec says.
    expect(entry('@@exclude_keys 왕비\n본문', { secondary_keys: ['밤'], selective: true }).secondaryKeys).toEqual(['밤']);
    expect(entry('@@exclude_keys 왕비\n본문', { use_regex: true }).secondaryKeys).toEqual([]);
  });

  it('ignores @@depth when a position decorator is present, per spec', () => {
    const { card } = parseCard({
      ...v3Card,
      data: {
        ...v3Card.data,
        character_book: {
          extensions: {},
          entries: [
            { ...v3Card.data.character_book.entries[0]!, content: '@@depth 2\n@@position after_desc\n본문' },
          ],
        },
      },
    });
    expect(card.lorebook[0]!.depth).toBeUndefined();
    expect(card.lorebook[0]!.position).toBe('after_char');
  });

  it('only treats the leading lines as decorators', () => {
    expect(parseDecorators('본문\n@@depth 2')).toEqual({ decorators: {}, body: '본문\n@@depth 2' });
    expect(parseDecorators('').body).toBe('');
  });
});

describe('parseCard - JSON', () => {
  it('maps a V1 card', () => {
    const { card } = parseCard(v1Card);
    expect(card.spec).toBe('v1');
    expect(card.name).toBe('아리아');
    expect(card.description).toBe(v1Card.description);
    expect(card.personality).toBe(v1Card.personality);
    expect(card.scenario).toBe(v1Card.scenario);
    expect(card.firstMes).toBe(v1Card.first_mes);
    expect(card.mesExample).toBe(v1Card.mes_example);
    expect(card.alternateGreetings).toEqual([]);
    expect(card.systemPrompt).toBe('');
    expect(card.lorebook).toEqual([]);
    expect(card.loreSettings).toEqual({ scanDepth: 4, tokenBudget: 2048, recursiveScanning: false });
    expect(card.raw).toBe(v1Card);
  });

  it('maps a V2 card including the character book', () => {
    const { card } = parseCard(v2Card);
    expect(card.spec).toBe('v2');
    expect(card.name).toBe('리안');
    expect(card.alternateGreetings).toEqual(['불이 꺼진 열람실에서 마주쳤다.']);
    expect(card.tags).toEqual(['판타지', '사서']);
    expect(card.creator).toBe('리드');
    expect(card.characterVersion).toBe('1.2');
    expect(card.creatorNotes).toBe('테스트용 카드');
    expect(card.extensions).toEqual({ risu: { emotions: [] } });
    expect(card.loreSettings).toEqual({ scanDepth: 2, tokenBudget: 512, recursiveScanning: false });
    expect(card.lorebook).toEqual([
      {
        keys: ['금서'],
        secondaryKeys: ['지하'],
        selective: true,
        content: '지하 서고의 금서는 사서장만 열람할 수 있다.',
        enabled: true,
        constant: false,
        insertionOrder: 5,
        caseSensitive: false,
        useRegex: false,
        position: 'after_char',
      },
    ]);
  });

  it('maps a V3 card, keeps use_regex, and parses the lorebook decorator subset', () => {
    const { card } = parseCard(v3Card);
    expect(card.spec).toBe('v3');
    expect(card.nickname).toBe('세이 님');
    expect(card.systemPrompt).toContain('{{original}}');
    expect(card.loreSettings.recursiveScanning).toBe(true);

    // @@depth/@@role: injected into the history rather than the system block.
    expect(card.lorebook[0]).toEqual({
      keys: ['검(술|객)'],
      secondaryKeys: [],
      selective: false,
      content: '세이의 검은 이가 빠져 있다.',
      enabled: true,
      constant: false,
      insertionOrder: 1,
      caseSensitive: false,
      useRegex: true,
      position: 'before_char',
      depth: 4,
      role: 'assistant',
    });

    // @@constant + @@position override the card fields; @@activate_only_after
    // becomes the entry's delay.
    expect(card.lorebook[1]!.content).toBe('주막은 국경 검문소 옆이다.');
    expect(card.lorebook[1]!.constant).toBe(true);
    expect(card.lorebook[1]!.position).toBe('after_char');
    expect(card.lorebook[1]!.depth).toBeUndefined();
    expect(card.lorebook[1]!.delay).toBe(2);
  });

  it('keeps the decorators of the source card in raw', () => {
    const { card } = parseCard(v3Card);
    expect(card.raw).toBe(v3Card);
    const rawEntry = (card.raw as typeof v3Card).data.character_book.entries[0]!;
    expect(rawEntry.content).toBe('@@depth 4\n@@role assistant\n세이의 검은 이가 빠져 있다.');
    expect(card.lorebook[0]!.content).not.toContain('@@');
  });

  it('accepts a JSON string and raw JSON bytes', () => {
    expect(parseCard(JSON.stringify(v2Card)).card.name).toBe('리안');
    expect(parseCard(encode(v2Card)).card.name).toBe('리안');
  });

  it('rejects unrecognized payloads', () => {
    expect(() => parseCard({ hello: 'world' })).toThrow(CardParseError);
    expect(() => parseCard(new Uint8Array([1, 2, 3, 4]))).toThrow(CardParseError);
  });
});

describe('parseCard - PNG', () => {
  it('round-trips a card embedded in a chara tEXt chunk', () => {
    const png = buildPngWithTextChunks({ chara: toBase64(v2Card) });
    const { card, iconBuffer } = parseCard(png);
    expect(card.name).toBe('리안');
    expect(card.lorebook).toHaveLength(1);
    expect(iconBuffer).toBe(png);
  });

  it('prefers the ccv3 chunk over chara', () => {
    const png = buildPngWithTextChunks({ chara: toBase64(v2Card), ccv3: toBase64(v3Card) });
    const { card } = parseCard(png);
    expect(card.spec).toBe('v3');
    expect(card.name).toBe('세이');
  });

  it('fails when no card chunk is present', () => {
    const png = buildPngWithTextChunks({ Comment: 'no card here' });
    expect(() => parseCard(png)).toThrow(CardParseError);
  });
});

describe('parseCard - PNG assets', () => {
  const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
  const v3WithAssets = (assets: unknown): string =>
    toBase64({ ...v3Card, data: { ...v3Card.data, assets } });

  it("returns a V3 card's chara-ext-asset images, in card order", () => {
    const smile = Uint8Array.from([10, 11]);
    const background = Uint8Array.from([20, 21]);
    const nameless = Uint8Array.from([30, 31]);
    // RisuAI writes the asset chunks first and the card last.
    const png = buildPngWithTextChunks({
      'chara-ext-asset_:1': base64(smile),
      'chara-ext-asset_:2': base64(background),
      'chara-ext-asset_:3': base64(Uint8Array.from([40, 41])),
      'chara-ext-asset_:4': base64(nameless),
      ccv3: v3WithAssets([
        { type: 'icon', name: 'main', uri: 'ccdefault:', ext: 'png' },
        { type: 'emotion', name: 'smile', uri: '__asset:1', ext: 'png' },
        { type: 'x-risu-asset', name: 'bg.webp', uri: '__asset:2', ext: 'webp' },
        { type: 'x-risu-asset', name: 'theme', uri: '__asset:3', ext: 'mp3' },
        { type: 'emotion', name: 'gone', uri: '__asset:9', ext: 'png' },
        { type: 'icon', name: 'remote', uri: 'https://example.com/remote.png', ext: 'png' },
        { type: 'emotion', name: '', uri: '__asset:4', ext: 'gif' },
      ]),
    });

    const { card, iconBuffer, assets } = parseCard(png);
    expect(card.name).toBe('세이');
    // The PNG is still the avatar; non-images, missing chunks and external uris are
    // left alone, and a nameless asset is named after its index.
    expect(iconBuffer).toBe(png);
    expect(assets).toEqual([
      { name: 'smile', bytes: smile },
      { name: 'bg.webp', bytes: background },
      { name: 'asset_4', bytes: nameless },
    ]);
  });

  it("reads a V2 card's emotions and additional assets", () => {
    const happy = Uint8Array.from([1]);
    const map = Uint8Array.from([2]);
    const old = Uint8Array.from([4]);
    const png = buildPngWithTextChunks({
      'chara-ext-asset_:1': base64(happy),
      'chara-ext-asset_:2': base64(map),
      'chara-ext-asset_:3': base64(Uint8Array.from([3])),
      // The keyword without the colon, which RisuAI's own reader still takes.
      'chara-ext-asset_4': base64(old),
      chara: toBase64({
        ...v2Card,
        data: {
          ...v2Card.data,
          extensions: {
            risuai: {
              emotions: [['happy', '__asset:1']],
              additionalAssets: [
                ['map.png', '__asset:2', 'png'],
                ['theme', '__asset:3', 'mp3'],
                ['old', '__asset:4'],
              ],
            },
          },
        },
      }),
    });

    expect(parseCard(png).assets).toEqual([
      { name: 'happy', bytes: happy },
      { name: 'map.png', bytes: map },
      { name: 'old', bytes: old },
    ]);
  });

  it('stops at 50 assets', () => {
    const chunks: Record<string, string> = {};
    const declared: unknown[] = [];
    for (let i = 0; i < 60; i += 1) {
      chunks[`chara-ext-asset_:${i}`] = base64(Uint8Array.from([i]));
      declared.push({ type: 'emotion', name: `e${i}`, uri: `__asset:${i}`, ext: 'png' });
    }
    const { assets } = parseCard(buildPngWithTextChunks({ ...chunks, ccv3: v3WithAssets(declared) }));

    expect(assets).toHaveLength(50);
    expect(assets!.at(-1)!.name).toBe('e49');
  });

  it('stops at an asset over the per-entry cap instead of failing the import', () => {
    const early = Uint8Array.from([7, 7]);
    const png = buildPngWithTextChunks({
      'chara-ext-asset_:1': base64(early),
      // Base64 for 21MB, over the 20MB cap: refused from its length, never decoded.
      'chara-ext-asset_:2': 'A'.repeat(28 * 1024 * 1024),
      'chara-ext-asset_:3': base64(Uint8Array.from([8, 8])),
      ccv3: v3WithAssets([
        { type: 'emotion', name: 'early', uri: '__asset:1', ext: 'png' },
        { type: 'emotion', name: 'huge', uri: '__asset:2', ext: 'png' },
        { type: 'emotion', name: 'late', uri: '__asset:3', ext: 'png' },
      ]),
    });

    const { card, assets } = parseCard(png);
    expect(card.name).toBe('세이');
    expect(assets).toEqual([{ name: 'early', bytes: early }]);
  });
});

describe('stripPngTextChunks', () => {
  it('drops every text chunk and leaves the image bytes untouched', () => {
    const bare = buildPngWithTextChunks({});
    const carded = buildPngWithTextChunks({ chara: toBase64(v2Card), Comment: '설명' });

    const stripped = stripPngTextChunks(carded)!;
    expect(stripped).not.toBeNull();
    // Only IHDR/IEND are left, so the result is byte-identical to a card-free PNG.
    expect(stripped).toEqual(bare);
    expect(readPngTextChunks(stripped).size).toBe(0);
    // The card is gone for good: the stripped bytes no longer parse as a card.
    expect(() => parseCard(stripped)).toThrow(CardParseError);
    // Idempotent.
    expect(stripPngTextChunks(stripped)).toEqual(stripped);
  });

  it('refuses bytes it cannot walk', () => {
    const png = buildPngWithTextChunks({ chara: toBase64(v2Card) });
    expect(stripPngTextChunks(png.subarray(0, png.length - 6))).toBeNull();
    expect(stripPngTextChunks(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('parseCard - charx', () => {
  const iconBytes = Uint8Array.from([1, 2, 3, 4, 5]);

  const buildCharx = (assets: unknown): Uint8Array =>
    zipSync({
      'card.json': encode({ ...v3Card, data: { ...v3Card.data, assets } }),
      'assets/icon/main.png': iconBytes,
    });

  it('reads card.json and the main icon asset', () => {
    const charx = buildCharx([
      { type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' },
      { type: 'background', name: 'bg', uri: 'embeded://assets/other/bg.png', ext: 'png' },
    ]);
    const { card, iconBuffer } = parseCard(charx);
    expect(card.name).toBe('세이');
    expect(card.lorebook[0]!.content).toBe('세이의 검은 이가 빠져 있다.');
    expect(iconBuffer).toEqual(iconBytes);
  });

  it('returns no icon when the card has no main icon asset', () => {
    const { iconBuffer } = parseCard(buildCharx([]));
    expect(iconBuffer).toBeUndefined();
  });

  it('extracts the embedded images beside the icon, in card order', () => {
    const smile = Uint8Array.from([10, 11]);
    const background = Uint8Array.from([20, 21]);
    const nameless = Uint8Array.from([30, 31]);
    const zip = zipSync({
      'card.json': encode({
        ...v3Card,
        data: {
          ...v3Card.data,
          assets: [
            { type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' },
            { type: 'emotion', name: 'smile', uri: 'embeded://assets/emotion/smile.png', ext: 'png' },
            // ext is unreliable in the wild, so the uri gets a say too.
            { type: 'background', name: 'bg', uri: 'embeded://assets/other/bg.webp', ext: 'unknown' },
            { type: 'emotion', name: '', uri: 'embeded://assets/emotion/wave.gif', ext: 'gif' },
            { type: 'other', name: 'notes', uri: 'embeded://assets/other/notes.txt', ext: 'txt' },
            { type: 'icon', name: 'remote', uri: 'https://example.com/remote.png', ext: 'png' },
          ],
        },
      }),
      'assets/icon/main.png': iconBytes,
      'assets/emotion/smile.png': smile,
      'assets/other/bg.webp': background,
      'assets/emotion/wave.gif': nameless,
      'assets/other/notes.txt': Uint8Array.from([40, 41]),
    });

    const { iconBuffer, assets } = parseCard(zip);
    expect(iconBuffer).toEqual(iconBytes);
    // Non-images and external uris are left alone; a nameless asset falls back to
    // its file name.
    expect(assets).toEqual([
      { name: 'smile', bytes: smile },
      { name: 'bg', bytes: background },
      { name: 'wave', bytes: nameless },
    ]);
  });

  it('stops at 50 assets', () => {
    const files: Record<string, Uint8Array> = { 'assets/icon/main.png': iconBytes };
    const declared = [{ type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' }];
    for (let i = 0; i < 60; i += 1) {
      files[`assets/emotion/e${i}.png`] = Uint8Array.from([i]);
      declared.push({ type: 'emotion', name: `e${i}`, uri: `embeded://assets/emotion/e${i}.png`, ext: 'png' });
    }
    const { assets } = parseCard(zipSync({ 'card.json': cardWithAssets(declared), ...files }));

    expect(assets).toHaveLength(50);
    expect(assets!.at(-1)!.name).toBe('e49');
  });

  it('stops the asset pass at an oversized extra asset instead of failing the import', () => {
    const early = Uint8Array.from([7, 7]);
    const late = Uint8Array.from([8, 8]);
    const zip = zipSync({
      'card.json': cardWithAssets([
        { type: 'emotion', name: 'early', uri: 'embeded://assets/emotion/early.png', ext: 'png' },
        { type: 'emotion', name: 'huge', uri: 'embeded://assets/emotion/huge.png', ext: 'png' },
        { type: 'emotion', name: 'late', uri: 'embeded://assets/emotion/late.png', ext: 'png' },
      ]),
      'assets/emotion/early.png': early,
      'assets/emotion/huge.png': oversizedAsset(),
      'assets/emotion/late.png': late,
    });

    const { card, assets } = parseCard(zip);
    // The card still imports — only card.json and the icon fail hard on the cap.
    expect(card.name).toBe('세이');
    // Reading stops at the offender rather than paying to inflate past it, so
    // what was declared before it survives and what comes after does not.
    expect(assets).toEqual([{ name: 'early', bytes: early }]);
  });

  it('shares one inflate budget between the icon and the assets', () => {
    // Four 17MB entries: each under the per-entry cap, together over the 64MB
    // archive budget. Per-pass budgets would let all four through.
    const big = new Uint8Array(17 * 1024 * 1024);
    const declared: unknown[] = [
      { type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' },
    ];
    const files: Record<string, Uint8Array> = { 'assets/icon/main.png': iconBytes };
    for (let i = 0; i < 4; i += 1) {
      declared.push({ type: 'emotion', name: `b${i}`, uri: `embeded://assets/b${i}.png`, ext: 'png' });
      files[`assets/b${i}.png`] = big;
    }

    const { iconBuffer, assets } = parseCard(
      zipSync({ 'card.json': cardWithAssets(declared), ...files }),
    );
    // The icon is read in the same pass and comes first in the archive.
    expect(iconBuffer).toEqual(iconBytes);
    // 3 x 17MB fit; the fourth crosses the budget and ends the pass.
    expect(assets!.map((asset) => asset.name)).toEqual(['b0', 'b1', 'b2']);
  });

  it('fails when card.json is missing', () => {
    expect(() => parseCard(zipSync({ 'other.json': encode({}) }))).toThrow(CardParseError);
  });

  // Above readCharx's 20MB per-entry cap. Built once and reused as zip input.
  let oversized: Uint8Array | undefined;
  const oversizedAsset = (): Uint8Array => {
    if (!oversized) {
      oversized = new Uint8Array(24 * 1024 * 1024);
      for (let i = 0; i < oversized.length; i += 1) oversized[i] = i & 0xff;
    }
    return oversized;
  };

  const cardWithAssets = (assets: unknown): Uint8Array =>
    encode({ ...v3Card, data: { ...v3Card.data, assets } });

  /** Offset of the central directory, read from the end-of-central-directory record. */
  const centralDirOffset = (zip: Uint8Array): number => {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = zip.length - 22; i >= 0; i -= 1) {
      if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) {
        return view.getUint32(i + 16, true);
      }
    }
    throw new Error('no end-of-central-directory record');
  };

  const concat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };

  /**
   * Splices several single-entry zips into one well-formed archive, rebuilding the
   * central directory so duplicate names survive (a plain object cannot hold them).
   */
  const spliceArchive = (sources: Uint8Array[]): Uint8Array => {
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;
    for (const zip of sources) {
      const start = centralDirOffset(zip);
      const local = zip.subarray(0, start);
      const central = zip.slice(start, zip.length - 22); // sources carry no archive comment
      new DataView(central.buffer, central.byteOffset, central.byteLength).setUint32(42, offset, true);
      locals.push(local);
      centrals.push(central);
      offset += local.length;
    }
    const directory = concat(...centrals);
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, sources.length, true);
    view.setUint16(10, sources.length, true);
    view.setUint32(12, directory.length, true);
    view.setUint32(16, offset, true);
    return concat(...locals, directory, end);
  };

  it('never inflates assets other than card.json and the main icon', () => {
    const zip = zipSync({
      'card.json': cardWithAssets([
        { type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' },
      ]),
      'assets/icon/main.png': iconBytes,
      'assets/huge.bin': oversizedAsset(),
    });
    // Corrupt the dummy asset's compressed stream. Inflating it now throws, so a
    // successful parse proves the entry was filtered out rather than decompressed.
    const at = Math.floor(zip.length * 0.6);
    zip[at] ^= 0xff;
    expect(() => unzipSync(zip)).toThrow();

    const { card, iconBuffer } = parseCard(zip);
    expect(card.name).toBe('세이');
    expect(iconBuffer).toEqual(iconBytes);
  });

  it('rejects a main icon larger than the per-entry size cap', () => {
    const zip = zipSync({
      'card.json': cardWithAssets([
        { type: 'icon', name: 'main', uri: 'embeded://assets/huge.bin', ext: 'png' },
      ]),
      'assets/huge.bin': oversizedAsset(),
    });
    expect(() => parseCard(zip)).toThrow(CardParseError);
    expect(() => parseCard(zip)).toThrow(/20MB limit/);
  });

  it('caps on emitted bytes, not on the sizes declared in the zip headers', () => {
    // The declared uncompressed size is attacker-controlled. Understate it and a
    // cap that trusts the headers waves through an entry that really inflates to 24MB.
    const zip = zipSync({ 'card.json': oversizedAsset() });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint32(22, 1024, true); // local file header: uncompressed size
    view.setUint32(centralDirOffset(zip) + 24, 1024, true); // central directory: uncompressed size

    expect(() => parseCard(zip)).toThrow(CardParseError);
    expect(() => parseCard(zip)).toThrow(/20MB limit/);
  });

  it('inflates only the first entry when a name is duplicated', () => {
    // Five records share the name card.json: a small valid card, then four 10MB
    // decoys. Each decoy is individually under the cap, so a reader that inflates
    // every match decompresses 40MB and ends up with a decoy instead of the card.
    const decoySize = 10 * 1024 * 1024;
    const valid = zipSync({ 'card.json': cardWithAssets([]) });
    const decoy = zipSync({ 'card.json': new Uint8Array(decoySize) });
    const duplicated = spliceArchive([valid, decoy, decoy, decoy, decoy]);

    // The archive is well-formed: a reader that walks every entry sees all five.
    expect(unzipSync(duplicated)['card.json']).toHaveLength(decoySize);

    const { card } = parseCard(duplicated);
    expect(card.name).toBe('세이');
  });

  describe('RisuAI module.risum', () => {
    const scripts = [
      { comment: '', in: '\\*\\*(.+?)\\*\\*', out: '<b>$1</b>', type: 'editdisplay', ableFlag: true, flag: 'g' },
      { comment: '', in: 'foo', out: 'bar', type: 'editoutput', ableFlag: false, flag: '' },
    ];
    const triggers = [{ comment: '', type: 'start', conditions: [], effect: [] }];
    const moduleFile = buildRisum({
      module: { name: 'm', description: '', id: 'id', regex: scripts, trigger: triggers, lorebook: [] },
      type: 'risuModule',
    });
    const cardWithRisu = (risuai: Record<string, unknown>): Uint8Array =>
      encode({
        ...v3Card,
        data: {
          ...v3Card.data,
          extensions: { risuai },
          assets: [{ type: 'icon', name: 'main', uri: 'embeded://assets/icon/image/main.png', ext: 'png' }],
        },
      });
    /** RisuAI's entry order: the assets, then the module, then card.json. */
    const risuCharx = (module: Uint8Array, risuai: Record<string, unknown> = { bias: [] }): Uint8Array =>
      zipSync({
        'assets/icon/image/main.png': iconBytes,
        'module.risum': module,
        'card.json': cardWithRisu(risuai),
      });

    it('puts the scripts the export moved into the module back on the card', () => {
      const { card, iconBuffer } = parseCard(risuCharx(moduleFile));

      expect(iconBuffer).toEqual(iconBytes);
      expect(card.displayScripts).toEqual([
        expect.objectContaining({ in: '\\*\\*(.+?)\\*\\*', out: '<b>$1</b>', flags: 'g' }),
      ]);
      // Everything else rides along in the extensions for the round trip.
      expect(card.extensions['risuai']).toEqual({ bias: [], customScripts: scripts, triggerscript: triggers });
      expect((card.raw as typeof v3Card).data.extensions).toEqual({
        risuai: { bias: [], customScripts: scripts, triggerscript: triggers },
      });
    });

    it('keeps a list card.json carries itself', () => {
      const own = [{ comment: '', in: 'own', out: 'mine', type: 'editdisplay', ableFlag: false, flag: '' }];
      const { card } = parseCard(risuCharx(moduleFile, { customScripts: own }));

      expect(card.extensions['risuai']).toEqual({ customScripts: own, triggerscript: triggers });
      expect(card.displayScripts!.map((script) => script.in)).toEqual(['own']);
    });

    /** Opens an entry's deflate stream with a reserved block type, which no inflater accepts. */
    const corruptEntry = (zip: Uint8Array, name: string): Uint8Array => {
      const out = zip.slice();
      const view = new DataView(out.buffer);
      const header = Buffer.from(out).indexOf(name) - 30; // the first hit is the local header
      const data = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
      out[data] = 0b111; // BFINAL 1, BTYPE 11
      return out;
    };

    it('imports without a module that cannot be read', () => {
      const corrupt = corruptEntry(risuCharx(moduleFile), 'module.risum');
      expect(() => unzipSync(corrupt)).toThrow();

      const unreadable = [
        risuCharx(Uint8Array.from([1, 2, 3])),
        corrupt,
        // Over the per-entry cap, and ahead of card.json as RisuAI writes it.
        risuCharx(oversizedAsset()),
      ];
      for (const zip of unreadable) {
        const { card, iconBuffer } = parseCard(zip);
        expect(card.name).toBe('세이');
        expect(iconBuffer).toEqual(iconBytes);
        expect(card.displayScripts).toBeUndefined();
        expect(card.extensions['risuai']).toEqual({ bias: [] });
      }
    });
  });

  describe('a charx appended to a JPEG', () => {
    // A stand-in picture whose bytes include a local-header signature, which a
    // reader scanning for the first `PK\x03\x04` would take for the archive.
    const picture = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00, 0xff, 0xd9,
    ]);

    it('reads the archive behind the picture, icon from the archive', () => {
      const charx = zipSync({
        'assets/icon/image/main.png': iconBytes,
        'card.json': cardWithAssets([
          { type: 'icon', name: 'main', uri: 'embeded://assets/icon/image/main.png', ext: 'png' },
        ]),
      });
      const { card, iconBuffer } = parseCard(concat(picture, charx));
      expect(card.name).toBe('세이');
      expect(iconBuffer).toEqual(iconBytes);
    });

    it('rejects a JPEG that carries no archive', () => {
      expect(() => parseCard(picture)).toThrow(CardParseError);
    });
  });
});

describe('exportCardV3', () => {
  it('exports V3 JSON that re-normalizes to the same card', () => {
    const { card } = parseCard(v2Card);
    const exported = exportCardV3(card);
    expect(exported.spec).toBe('chara_card_v3');
    expect(exported.spec_version).toBe('3.0');
    expect(exported.data.name).toBe('리안');
    expect(exported.data.extensions).toEqual({ risu: { emotions: [] } });

    const reparsed = parseCard(exported).card;
    expect(reparsed.spec).toBe('v3');
    expect(reparsed.lorebook).toEqual(card.lorebook);
    expect(reparsed.loreSettings).toEqual(card.loreSettings);
    expect(reparsed.alternateGreetings).toEqual(card.alternateGreetings);
  });

  it('re-emits depth/role as decorators so they survive the round-trip', () => {
    const { card } = parseCard(v3Card);
    const exported = exportCardV3(card);
    expect(exported.data.character_book!.entries[0]!.content).toBe(
      '@@depth 4\n@@role assistant\n세이의 검은 이가 빠져 있다.',
    );

    const reparsed = parseCard(exported).card;
    expect(reparsed.lorebook).toEqual(card.lorebook);
    expect(reparsed.loreSettings).toEqual(card.loreSettings);
  });
});

describe('the intro round trip', () => {
  const card = normalizeCard(v2Card);
  const exportedExtensions = (input: typeof card): Record<string, Record<string, unknown>> =>
    exportCardV3(input).data.extensions as Record<string, Record<string, unknown>>;

  it('exports the intro under our own namespace and imports it back', () => {
    const introduced = { ...card, intro: '5년 만에 돌아온 소꿉친구.' };
    const extensions = exportedExtensions(introduced);
    expect(extensions['shizue']?.['intro']).toBe('5년 만에 돌아온 소꿉친구.');
    // Everything that was already in extensions is still where it was.
    expect(extensions['risu']).toEqual({ emotions: [] });

    expect(normalizeCard(exportCardV3(introduced)).intro).toBe(introduced.intro);
  });

  it('leaves a card that has no intro without the field, or the namespace', () => {
    expect(card.intro).toBeUndefined();
    expect(exportedExtensions(card)['shizue']).toBeUndefined();
    expect(normalizeCard(exportCardV3(card)).intro).toBeUndefined();
  });

  it('takes the key back out once the creator clears the intro', () => {
    const cleared = normalizeCard(exportCardV3({ ...card, intro: '한 줄.' }));
    expect(cleared.intro).toBe('한 줄.');
    delete cleared.intro;
    expect(exportedExtensions(cleared)['shizue']).toBeUndefined();
    expect(normalizeCard(exportCardV3(cleared)).intro).toBeUndefined();
  });

  it('shares the namespace with the narrator rather than replacing it', () => {
    const both = { ...card, intro: '한 줄.', narrator: { pov: 'third' as const } };
    expect(exportedExtensions(both)['shizue']).toEqual({
      intro: '한 줄.',
      narrator: { pov: 'third' },
    });
    const reparsed = normalizeCard(exportCardV3(both));
    expect(reparsed.intro).toBe('한 줄.');
    expect(reparsed.narrator).toEqual({ pov: 'third' });
  });

  it("holds a stranger's card to the same rules as our own", () => {
    const stranger = (intro: unknown) =>
      normalizeCard({
        ...v2Card,
        data: { ...v2Card.data, extensions: { shizue: { intro } } },
      }).intro;

    expect(stranger('한 줄.')).toBe('한 줄.');
    expect(stranger('   ')).toBeUndefined();
    expect(stranger(42)).toBeUndefined();
    // Import is the path that never passes through the editor, so the cap is
    // enforced here too — the oversized field is dropped, the card is kept.
    expect(stranger('가'.repeat(MAX_INTRO_LENGTH))).toHaveLength(MAX_INTRO_LENGTH);
    expect(stranger('가'.repeat(MAX_INTRO_LENGTH + 1))).toBeUndefined();
  });

  // The whole point of the field: it is written for readers, so the prompt must
  // never see it.
  it('never reaches the assembled prompt', () => {
    const { system, messages } = assemblePrompt({
      plot: { name: '이야기', description: '', lorebook: [] },
      characters: [{ name: card.name, card: { ...card, intro: '유저에게만 보이는 소개문.' } }],
      history: [{ role: 'user', content: '안녕' }],
    });
    expect(system).not.toContain('유저에게만 보이는 소개문.');
    expect(JSON.stringify(messages)).not.toContain('유저에게만 보이는 소개문.');
  });
});

describe('the narrator round trip', () => {
  const card = normalizeCard(v2Card);
  /** Extensions of an exported card, at the depth the namespace sits. */
  const exportedExtensions = (input: typeof card): Record<string, Record<string, unknown>> =>
    exportCardV3(input).data.extensions as Record<string, Record<string, unknown>>;

  it('exports the narrator under our own namespace and imports it back', () => {
    const narrating = { ...card, narrator: { voice: '건조하고 짧게 끊어 쓴다.', pov: 'third' as const } };
    const extensions = exportedExtensions(narrating);
    expect(extensions['shizue']?.['narrator']).toEqual({
      voice: '건조하고 짧게 끊어 쓴다.',
      pov: 'third',
    });
    // Everything that was already in extensions is still where it was.
    expect(extensions['risu']).toEqual({ emotions: [] });

    // The point of the field being ours: a creator who exports and re-imports a
    // card gets the same character back.
    expect(normalizeCard(exportCardV3(narrating)).narrator).toEqual(narrating.narrator);
  });

  it('round-trips either field on its own', () => {
    for (const narrator of [{ voice: '짧게 끊어 쓴다.' }, { pov: 'first' as const }]) {
      expect(normalizeCard(exportCardV3({ ...card, narrator })).narrator).toEqual(narrator);
    }
  });

  it('leaves a card that has no narrator without the field, or the namespace', () => {
    expect(card.narrator).toBeUndefined();
    expect(exportedExtensions(card)['shizue']).toBeUndefined();
    expect(normalizeCard(exportCardV3(card)).narrator).toBeUndefined();
  });

  it('takes the key back out once the creator clears the narrator', () => {
    const cleared = normalizeCard(exportCardV3({ ...card, narrator: { pov: 'third' } }));
    expect(cleared.narrator).toEqual({ pov: 'third' });
    // The extensions it carries still hold the old value; exporting without the
    // field has to remove it, or a cleared narrator would come back on re-import.
    delete cleared.narrator;
    expect(exportedExtensions(cleared)['shizue']).toBeUndefined();
    expect(normalizeCard(exportCardV3(cleared)).narrator).toBeUndefined();
  });

  it('holds a stranger\'s card to the same whitelist as our own', () => {
    const stranger = (narrator: unknown) =>
      normalizeCard({
        ...v2Card,
        data: { ...v2Card.data, extensions: { shizue: { narrator } } },
      }).narrator;

    // An unknown point of view is not a point of view the prompt has a label for.
    expect(stranger({ voice: '문체.', pov: 'sideways' })).toEqual({ voice: '문체.' });
    expect(stranger({ voice: '   ', pov: 'nope' })).toBeUndefined();
    expect(stranger({ voice: 42 })).toBeUndefined();
    expect(stranger('나레이터')).toBeUndefined();
    // …and nothing it says extra travels with it.
    expect(stranger({ pov: 'omniscient', tone: 'x' })).toEqual({ pov: 'omniscient' });
  });
});

// The narrator and the custom UI belong to the plot, not to one of its members:
// the import lifts them off the card, so the export has to write them back or a
// card exported out of a plot would come back missing what it arrived with.
describe('the plot overlay on export', () => {
  const card = normalizeCard(v2Card);

  it('writes the plot narrator and custom UI into the exported card', () => {
    const reimported = normalizeCard(
      exportCardV3(card, {
        narrator: { voice: '건조하게 끊어 쓴다.', pov: 'third' },
        customUi: {
          defaultVariables: { hp: '100' },
          componentCode: 'export default function Status() { return null; }',
          componentCapabilities: ['sendTurn'],
        },
      }),
    );
    expect(reimported.narrator).toEqual({ voice: '건조하게 끊어 쓴다.', pov: 'third' });
    expect(reimported.defaultVariables).toEqual({ hp: '100' });
    expect(reimported.componentCode).toBe('export default function Status() { return null; }');
    expect(reimported.componentCapabilities).toEqual(['sendTurn']);
  });

  it('stands in for whatever the stored card still carries', () => {
    const stored = {
      ...card,
      narrator: { pov: 'first' as const },
      componentCode: 'export default function Old() { return null; }',
    };
    // A custom UI given at all is the whole answer, so an empty one clears the
    // card's leftovers rather than letting them out again.
    const cleared = normalizeCard(
      exportCardV3(stored, { narrator: { pov: 'omniscient' }, customUi: {} }),
    );
    expect(cleared.narrator).toEqual({ pov: 'omniscient' });
    expect(cleared.componentCode).toBeUndefined();
  });

  it('falls back to the card when there is no plot to overlay', () => {
    const stored = { ...card, narrator: { pov: 'first' as const } };
    expect(normalizeCard(exportCardV3(stored)).narrator).toEqual({ pov: 'first' });
  });

  it('writes the plot openings and appends the plot lorebook after the card entries', () => {
    const plotEntry: LoreEntry = {
      ...card.lorebook[0]!,
      keys: ['왕궁'],
      secondaryKeys: [],
      selective: false,
      content: '왕궁은 북쪽 언덕에 있다.',
    };
    const exported = exportCardV3(card, { intros: ['첫 인사.', '둘째.', '셋째.'], lorebook: [plotEntry] });
    expect(exported.data.first_mes).toBe('첫 인사.');
    expect(exported.data.alternate_greetings).toEqual(['둘째.', '셋째.']);
    expect(normalizeCard(exported).lorebook).toEqual([...card.lorebook, plotEntry]);

    // A plot with no openings leaves the card's own.
    const bare = exportCardV3(card, { intros: [] });
    expect(bare.data.first_mes).toBe(card.firstMes);
    expect(bare.data.alternate_greetings).toEqual(card.alternateGreetings);
  });
});

// Shapes and enums below are SillyTavern's own (world-info.js, characters.js,
// regex/engine.js); `stCard` is what its writer produces.
describe('SillyTavern cards', () => {
  /** ST's PNG writer: `chara` is the V2 JSON, `ccv3` the same JSON relabelled V3. */
  const stPng = () =>
    buildPngWithTextChunks({
      chara: toBase64(stCard()),
      ccv3: toBase64({ ...stCard(), spec: 'chara_card_v3', spec_version: '3.0' }),
    });

  it('imports the PNG SillyTavern writes, and its JSON', () => {
    // ccardlib's checker refuses both as written: the relabelled ccv3 has no
    // group_only_greetings, and an ST-built lorebook has no book-level extensions.
    const { card } = parseCard(stPng());
    expect(card.spec).toBe('v3');
    expect(card.name).toBe('엘라라');
    expect(card.lorebook).toHaveLength(3);

    const fromJson = parseCard(stCard()).card;
    expect(fromJson.spec).toBe('v2');
    expect(fromJson.lorebook).toEqual(card.lorebook);
  });

  it('reads the entry settings ST keeps in each entry\'s extensions', () => {
    const [first, second] = parseCard(stPng()).card.lorebook;
    expect(first).toEqual({
      // ST reads a key as a regex only in its slash form, whatever use_regex says;
      // the plain key beside it becomes an escaped literal.
      keys: ['엘프', '숲(지기|의 왕)'],
      secondaryKeys: [],
      selective: true,
      content: '엘프는 숲의 왕을 섬긴다.',
      enabled: true,
      constant: false,
      insertionOrder: 10,
      caseSensitive: false,
      useRegex: true,
      position: 'before_char',
      depth: 2,
      role: 'assistant',
      selectiveLogic: 'and_all',
      probability: 40,
      group: '숲, 왕국',
      groupWeight: 30,
      scanDepth: 6,
      sticky: 3,
      cooldown: 2,
      delay: 5,
    });
    expect(second).toEqual({
      keys: ['활'],
      secondaryKeys: ['부러진'],
      selective: true,
      content: '엘라라의 활은 할머니의 유품이다.',
      enabled: true,
      constant: false,
      insertionOrder: 20,
      // ST keeps case in its extensions only.
      caseSensitive: true,
      // Plain keys: ST's use_regex: true means nothing.
      useRegex: false,
      position: 'after_char',
      // NOT_ANY is 2; probability is off, so the 25 is not one.
      selectiveLogic: 'not_any',
    });
  });

  it('makes the character note a constant depth entry, and takes it out of the extensions', () => {
    const { card } = parseCard(stPng());
    expect(card.lorebook[2]).toEqual({
      keys: [],
      secondaryKeys: [],
      selective: false,
      content: '{{char}}는 숲을 떠나지 않는다.',
      enabled: true,
      constant: true,
      // After the card's own entries.
      insertionOrder: 21,
      caseSensitive: false,
      useRegex: false,
      position: 'before_char',
      depth: 2,
    });
    expect(card.extensions['depth_prompt']).toBeUndefined();
    expect(card.extensions['world']).toBe('엘라라의 숲');

    // The export writes it back as the entry it now is, so a re-import does not
    // find it twice.
    expect(normalizeCard(exportCardV3(card)).lorebook).toEqual(card.lorebook);

    const withNote = (depth_prompt: unknown) => {
      const raw = stCard();
      return normalizeCard({ ...raw, data: { ...raw.data, extensions: { ...raw.data.extensions, depth_prompt } } });
    };
    expect(withNote({ prompt: '속삭인다.', depth: 0, role: 'user' }).lorebook[2]).toMatchObject({
      depth: 0,
      role: 'user',
    });
    // An empty note is not an entry, and stays where ST put it.
    const empty = withNote({ prompt: '  ', depth: 4, role: 'system' });
    expect(empty.lorebook).toHaveLength(2);
    expect(empty.extensions['depth_prompt']).toEqual({ prompt: '  ', depth: 4, role: 'system' });
  });

  it('lets V3 decorators win over the ST extensions', () => {
    const entryWith = (content: string) => {
      const raw = stCard();
      const [first] = raw.data.character_book.entries;
      return normalizeCard({
        ...raw,
        data: { ...raw.data, character_book: { ...raw.data.character_book, entries: [{ ...first!, content }] } },
      }).lorebook[0]!;
    };
    expect(entryWith('@@depth 1\n@@role user\n본문')).toMatchObject({ depth: 1, role: 'user' });
    const positioned = entryWith('@@position after_desc\n본문');
    expect(positioned.position).toBe('after_char');
    expect(positioned.depth).toBeUndefined();
    expect(entryWith('@@activate_only_after 9\n@@scan_depth 1\n본문')).toMatchObject({ delay: 9, scanDepth: 1 });
  });

  it('maps display-only regex scripts onto display scripts, after RisuAI ones and without duplicates', () => {
    const script = stCard().data.extensions.regex_scripts[0]!;
    const withScripts = (regexScripts: unknown[], risuai?: unknown) => {
      const raw = stCard();
      return normalizeCard({
        ...raw,
        data: {
          ...raw.data,
          extensions: { ...raw.data.extensions, regex_scripts: regexScripts, ...(risuai ? { risuai } : {}) },
        },
      });
    };

    const card = withScripts([
      script,
      { ...script, findRegex: 'plain', promptOnly: true },
      { ...script, findRegex: 'off', disabled: true },
      { ...script, findRegex: 'everywhere', markdownOnly: false },
      { ...script, findRegex: 'user', placement: [1] },
      // The pattern screen's refusal skips the script rather than the card.
      { ...script, findRegex: '/(a+)+$/' },
      { ...script, findRegex: 'bare $', replaceString: '[$0]' },
    ]);
    expect(card.displayScripts).toEqual([
      { in: '\\[status\\] hp=(\\d+)', out: '<div class="hp">$& → $1</div>', flags: 'gi', order: 0, enabled: true },
      { in: 'bare $', out: '[$&]', order: 1, enabled: true },
    ]);
    // Left in place for SillyTavern on the way back out.
    expect(card.extensions['regex_scripts']).toHaveLength(7);

    const alongsideRisu = withScripts([script], {
      customScripts: [
        { in: 'x', out: 'y', type: 'editdisplay', ableFlag: false, flag: '<order 4>' },
        { in: '\\[status\\] hp=(\\d+)', out: '<div class="hp">$& → $1</div>', type: 'editdisplay', ableFlag: true, flag: 'gi' },
      ],
    });
    expect(alongsideRisu.displayScripts?.map((one) => one.in)).toEqual(['x', '\\[status\\] hp=(\\d+)']);

    // Our export writes the script into RisuAI's block and keeps regex_scripts,
    // so a re-import meets it twice and keeps one.
    const reimported = normalizeCard(exportCardV3(parseCard(stPng()).card));
    expect(reimported.displayScripts).toHaveLength(1);
  });

  it('exports the settings where ST reads them, and reads its own export back', () => {
    const { card } = parseCard(stPng());
    const exported = exportCardV3(card);
    const [first, second, note] = exported.data.character_book!.entries;
    expect(first!.keys).toEqual(['/엘프/i', '/숲(지기|의 왕)/i']);
    expect(first!.content).toBe('@@depth 2\n@@role assistant\n엘프는 숲의 왕을 섬긴다.');
    expect(first!.extensions).toEqual({
      position: 4,
      depth: 2,
      role: 2,
      selectiveLogic: 3,
      probability: 40,
      useProbability: true,
      group: '숲, 왕국',
      group_weight: 30,
      scan_depth: 6,
      sticky: 3,
      cooldown: 2,
      delay: 5,
      case_sensitive: false,
    });
    expect(second!.keys).toEqual(['활']);
    expect(second!.extensions).toMatchObject({ position: 1, selectiveLogic: 2, probability: 100, case_sensitive: true });
    expect(note!.extensions).toMatchObject({ position: 4, depth: 2, role: 0 });

    expect(normalizeCard(exported).lorebook).toEqual(card.lorebook);
  });

  it('keeps an imported regex entry a regex through the round trip', () => {
    // A key with a slash in it has to be escaped, or ST would not read it as one.
    const { card } = parseCard(v3Card);
    const regex: LoreEntry = { ...card.lorebook[0]!, keys: ['a/b', '검(술|객)'], caseSensitive: true };
    const exported = exportCardV3({ ...card, lorebook: [regex] });
    expect(exported.data.character_book!.entries[0]!.keys).toEqual(['/a\\/b/', '/검(술|객)/']);
    expect(normalizeCard(exported).lorebook).toEqual([regex]);
  });

  it('writes a sticky or cooldown at the cap back out as the after-match decorators', () => {
    const { card } = parseCard(v3Card);
    const entry: LoreEntry = { ...card.lorebook[1]!, sticky: 10000, cooldown: 12000 };
    const exported = exportCardV3({ ...card, lorebook: [entry, { ...entry, sticky: 9999, cooldown: undefined }] });
    const [forever, counted] = exported.data.character_book!.entries;
    expect(forever!.content).toBe(
      '@@keep_activate_after_match\n@@dont_activate_after_match\n주막은 국경 검문소 옆이다.',
    );
    expect(counted!.content).toBe('주막은 국경 검문소 옆이다.');
    // Anything past the cap is the same "forever", and comes back as the cap.
    expect(normalizeCard(exported).lorebook[0]).toMatchObject({ sticky: 10000, cooldown: 10000 });
  });
});

describe('the PNG card export', () => {
  const { card } = parseCard(stCard());

  it('writes ccv3 and chara before IEND, and the card parses back out', () => {
    const avatar = buildPngWithTextChunks({ chara: 'an old card', Comment: 'kept? no' });
    const overlay = { intros: ['첫 인사.'], narrator: { pov: 'third' as const } };
    const png = exportCardPng(exportCardV3(card, overlay), avatar);

    const chunks = readPngTextChunks(png);
    expect([...chunks.keys()]).toEqual(['chara', 'ccv3']);
    const parsed = parseCard(png);
    expect(parsed.card.name).toBe(card.name);
    expect(parsed.card.firstMes).toBe('첫 인사.');
    expect(parsed.card.narrator).toEqual({ pov: 'third' });
    expect(parsed.card.lorebook).toEqual(card.lorebook);
    expect(parsed.card.displayScripts).toEqual(card.displayScripts);
    // The image underneath is the avatar's, without its old chunks.
    expect(stripPngTextChunks(png)).toEqual(stripPngTextChunks(avatar));
  });

  it('carries the V2 backfill without decorators, and depth survives in the ST extensions', () => {
    const png = exportCardPng(exportCardV3(card));
    const v2 = JSON.parse(Buffer.from(readPngTextChunks(png).get('chara')!, 'base64').toString('utf-8'));
    expect(v2.spec).toBe('chara_card_v2');
    expect(v2.data.character_book.entries[0].content).toBe('엘프는 숲의 왕을 섬긴다.');
    expect(normalizeCard(v2).lorebook).toEqual(card.lorebook);
  });

  it('falls back to a drawable placeholder for anything that is not a PNG', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const png = exportCardPng(exportCardV3(card), jpeg);
    expect(stripPngTextChunks(png)).toEqual(placeholderPng());

    const placeholder = placeholderPng();
    expect(isPng(placeholder)).toBe(true);
    // A real IDAT: 64 rows of a filter byte and 64 RGB pixels.
    const idatLength = new DataView(placeholder.buffer).getUint32(33);
    expect(unzlibSync(placeholder.subarray(41, 41 + idatLength))).toHaveLength(64 * (1 + 64 * 3));
  });

  it('writes chunks byte for byte the way a PNG encoder would', () => {
    expect(insertPngTextChunks(buildPngWithTextChunks({}), [['chara', 'abc'], ['ccv3', 'def']])).toEqual(
      buildPngWithTextChunks({ chara: 'abc', ccv3: 'def' }),
    );
    expect(() => insertPngTextChunks(new Uint8Array([1, 2, 3]), [])).toThrow();
  });
});
