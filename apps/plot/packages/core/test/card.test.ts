import { unzipSync, unzlibSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  exportCardCharx,
  exportCardPng,
  exportCardV3,
  toRisuAssetRefs,
  type CharxExportAsset,
} from '../src/card/export.js';
import { assetResolver } from '../src/cbs.js';
import { MAX_ASSETS, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES } from '../src/card/charx.js';
import { CardParseError, normalizeCard, parseDecorators } from '../src/card/normalize.js';
import { parseCard } from '../src/card/parse.js';
import { risuLoreBookEntry } from '../src/card/risuModule.js';
import { introFromCreatorNotes, MAX_INTRO_LENGTH } from '../src/card/intro.js';
import {
  insertPngTextChunks,
  isPng,
  placeholderPng,
  readPngTextChunks,
  stripPngTextChunks,
} from '../src/card/png.js';
import { activateLore } from '../src/lorebook.js';
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
      positioned: true,
    });
    expect(parseDecorators('@@position after_desc\n본문').decorators).toEqual({
      position: 'after_char',
      positioned: true,
    });
  });

  it('strips unknown decorators, fallbacks, and malformed arguments without effect', () => {
    expect(
      parseDecorators(
        '@@ignore_on_max_context\n@@@depth 2\n@@depth abc\n@@role narrator\n@@position\n@@scan_depth many\n@@exclude_keys  , \n@@additional_keys ,\n@@probability often\n본문',
      ),
    ).toEqual({ decorators: {}, body: '본문' });
  });

  it('marks any @@position as the author’s placement, a slot it cannot place included', () => {
    // A prompt template's slot, or one RisuAI reads and we do not, leaves the
    // entry where it would be — but its author placed it, so it stays put.
    expect(parseDecorators('@@position pt_PI\n본문').decorators).toEqual({ positioned: true });
    expect(parseDecorators('@@position personality\n본문').decorators).toEqual({ positioned: true });
    const { card } = parseCard({
      ...v3Card,
      data: {
        ...v3Card.data,
        character_book: {
          extensions: {},
          entries: [
            { ...v3Card.data.character_book.entries[0]!, content: '@@position pt_PI\n본문' },
            { ...v3Card.data.character_book.entries[0]!, content: '본문' },
          ],
        },
      },
    });
    expect(card.lorebook.map((entry) => [entry.position, entry.positioned ?? null])).toEqual([
      ['before_char', true],
      ['before_char', null],
    ]);
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

  it('collects every line of the key decorators, and reads the rest RisuAI applies', () => {
    expect(
      parseDecorators(
        '@@probability 30\n@@additional_keys 밤\n@@additional_keys 달, 새벽\n@@exclude_keys 왕비\n@@exclude_keys 시녀, 기사\n@@exclude_keys_all 비,눈\n@@exclude_keys_all 안개\n@@dont_activate\n@@activate\n본문',
      ),
    ).toEqual({
      decorators: {
        probability: 30,
        additionalKeys: [['밤'], ['달', '새벽']],
        excludeKeys: ['왕비', '시녀', '기사'],
        excludeAllKeys: ['비', '눈', '안개'],
        // The last of the two, as RisuAI reads them.
        force: 'activate',
      },
      body: '본문',
    });
    // RisuAI rolls 0–100 against N: below 0 never passes, from 100 always does.
    expect(parseDecorators('@@probability -5\n본문').decorators).toEqual({ probability: 0 });
    expect(parseDecorators('@@probability 150\n본문').decorators).toEqual({ probability: 100 });
    expect(parseDecorators('@@activate\n@@dont_activate\n본문').decorators).toEqual({ force: 'deactivate' });
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
    // An entry with secondary keys of its own keeps them; inert ones (the entry
    // is not selective) give way.
    expect(entry('@@exclude_keys 왕비\n본문', { secondary_keys: ['밤'], selective: true }).secondaryKeys).toEqual(['밤']);
    expect(entry('@@exclude_keys 왕비\n본문', { secondary_keys: ['밤'] }).secondaryKeys).toEqual(['왕비']);
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
    // No book, so no budget of its own: the prompt's automatic one applies.
    expect(card.loreSettings).toEqual({ scanDepth: 4, recursiveScanning: false });
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

    // `/검(술|객)/i` loses its slashes, and its `i` makes the entry ignore case.
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
    const fired = (text: string) =>
      activateLore([card.lorebook[0]!], { history: [text], scanDepth: 1, budgetTokens: 1000, countTokens: (t) => t.length })
        .entries.length;
    expect(fired('떠돌이 검객이 문을 연다.')).toBe(1);
    expect(fired('떠돌이 상인이 문을 연다.')).toBe(0);

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

  /** The bytes decide what an asset is, so each stand-in starts with its format's signature. */
  const pic = (n: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
  const webp = (n: number) => Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), n]);
  const gif = (n: number) => Uint8Array.from([...Buffer.from('GIF89a'), n]);
  const mp3 = (n: number) => Uint8Array.from([...Buffer.from('ID3'), 4, 0, n]);
  const mp4 = (n: number) => Uint8Array.from([0, 0, 0, 0x18, ...Buffer.from('ftypisom'), n]);

  it("returns a V3 card's chara-ext-asset pictures, music and video, in card order", () => {
    const smile = pic(10);
    const background = webp(20);
    const theme = mp3(40);
    const nameless = gif(30);
    const intro = mp4(60);
    // RisuAI writes the asset chunks first and the card last.
    const png = buildPngWithTextChunks({
      'chara-ext-asset_:1': base64(smile),
      'chara-ext-asset_:2': base64(background),
      'chara-ext-asset_:3': base64(theme),
      'chara-ext-asset_:4': base64(nameless),
      'chara-ext-asset_:5': base64(Uint8Array.from([50, 51])),
      'chara-ext-asset_:6': base64(intro),
      ccv3: v3WithAssets([
        { type: 'icon', name: 'main', uri: 'ccdefault:', ext: 'png' },
        { type: 'emotion', name: 'smile', uri: '__asset:1', ext: 'png' },
        { type: 'x-risu-asset', name: 'bg.webp', uri: '__asset:2', ext: 'webp' },
        { type: 'x-risu-asset', name: 'theme', uri: '__asset:3', ext: 'mp3' },
        { type: 'emotion', name: 'gone', uri: '__asset:9', ext: 'png' },
        { type: 'icon', name: 'remote', uri: 'https://example.com/remote.png', ext: 'png' },
        { type: 'emotion', name: '', uri: '__asset:4', ext: 'gif' },
        { type: 'x-risu-asset', name: 'model', uri: '__asset:5', ext: 'onnx' },
        { type: 'x-risu-asset', name: 'intro', uri: '__asset:6', ext: 'mp4' },
      ]),
    });

    const { card, iconBuffer, assets, skipped } = parseCard(png);
    expect(card.name).toBe('세이');
    // The PNG is still the avatar; external uris are left alone, and a nameless
    // asset is named after its index.
    expect(iconBuffer).toBe(png);
    // The emotions say so, for the import to record them as the card's.
    expect(assets).toEqual([
      { name: 'smile', bytes: smile, emotion: true },
      { name: 'bg.webp', bytes: background },
      { name: 'theme', bytes: theme },
      { name: 'asset_4', bytes: nameless, emotion: true },
      { name: 'intro', bytes: intro },
    ]);
    // What was left behind, for the import to say so: the model, and `gone`.
    expect(skipped).toEqual({ unsupported: 1, missing: 1, overBudget: 0 });
  });

  it("goes by the bytes, not a declared ext of 'unknown' (RisuAI's re-encoded emotions)", () => {
    const joy = pic(1);
    const anger = pic(2);
    const png = buildPngWithTextChunks({
      'chara-ext-asset_:0': base64(joy),
      'chara-ext-asset_:1': base64(anger),
      'chara-ext-asset_:2': base64(Uint8Array.from([0, 1, 2, 3])),
      ccv3: v3WithAssets([
        { type: 'icon', name: 'main', uri: 'ccdefault:', ext: 'png' },
        { type: 'emotion', name: 'joy', uri: '__asset:0', ext: 'unknown' },
        { type: 'emotion', name: 'anger', uri: '__asset:1', ext: 'unknown' },
        // Declared a picture, and not one.
        { type: 'x-risu-asset', name: 'liar', uri: '__asset:2', ext: 'png' },
      ]),
    });

    const { assets, skipped } = parseCard(png);
    expect(assets).toEqual([
      { name: 'joy', bytes: joy, emotion: true },
      { name: 'anger', bytes: anger, emotion: true },
    ]);
    expect(skipped).toEqual({ unsupported: 1, missing: 0, overBudget: 0 });
  });

  it("reads a V2 card's emotions and additional assets", () => {
    const happy = pic(1);
    const map = pic(2);
    const old = pic(4);
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
      { name: 'happy', bytes: happy, emotion: true },
      { name: 'map.png', bytes: map },
      { name: 'old', bytes: old },
    ]);
  });

  it(`stops at ${MAX_ASSETS} assets`, () => {
    const chunks: Record<string, string> = {};
    const declared: unknown[] = [];
    for (let i = 0; i < MAX_ASSETS + 10; i += 1) {
      chunks[`chara-ext-asset_:${i}`] = base64(pic(i & 0xff));
      declared.push({ type: 'emotion', name: `e${i}`, uri: `__asset:${i}`, ext: 'png' });
    }
    const { assets, skipped } = parseCard(buildPngWithTextChunks({ ...chunks, ccv3: v3WithAssets(declared) }));

    expect(assets).toHaveLength(MAX_ASSETS);
    expect(assets!.at(-1)!.name).toBe(`e${MAX_ASSETS - 1}`);
    expect(skipped).toEqual({ unsupported: 0, missing: 0, overBudget: 10 });
  });

  it('stops at an asset over the per-entry cap instead of failing the import', () => {
    const early = pic(7);
    const png = buildPngWithTextChunks({
      'chara-ext-asset_:1': base64(early),
      // A PNG's signature, then base64 for a megabyte over the per-entry cap:
      // sniffed from its first characters, refused from its length, never decoded.
      'chara-ext-asset_:2':
        base64(pic(0)).slice(0, 8) + 'A'.repeat(Math.ceil(((MAX_ENTRY_BYTES + 1024 * 1024) * 4) / 3)),
      'chara-ext-asset_:3': base64(pic(8)),
      ccv3: v3WithAssets([
        { type: 'emotion', name: 'early', uri: '__asset:1', ext: 'png' },
        { type: 'emotion', name: 'huge', uri: '__asset:2', ext: 'png' },
        { type: 'emotion', name: 'late', uri: '__asset:3', ext: 'png' },
      ]),
    });

    const { card, assets, skipped } = parseCard(png);
    expect(card.name).toBe('세이');
    expect(assets).toEqual([{ name: 'early', bytes: early, emotion: true }]);
    // The rest after the offender is not read, only counted.
    expect(skipped).toEqual({ unsupported: 0, missing: 0, overBudget: 2 });
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
            // Music is the plot's too (RisuAI's `{{audio::bgm}}`).
            { type: 'x-risu-asset', name: 'bgm', uri: 'embeded://assets/other/audio/bgm.mp3', ext: 'mp3' },
            // And video (`{{video::intro}}`).
            { type: 'x-risu-asset', name: 'intro', uri: 'embeded://assets/other/video/intro.mp4', ext: 'mp4' },
            { type: 'x-risu-asset', name: 'gone', uri: 'embeded://assets/other/gone.png', ext: 'png' },
          ],
        },
      }),
      'assets/icon/main.png': iconBytes,
      'assets/emotion/smile.png': smile,
      'assets/other/bg.webp': background,
      'assets/emotion/wave.gif': nameless,
      'assets/other/notes.txt': Uint8Array.from([40, 41]),
      'assets/other/audio/bgm.mp3': Uint8Array.from([50, 51]),
      'assets/other/video/intro.mp4': Uint8Array.from([60, 61]),
    });

    const { iconBuffer, assets, skipped } = parseCard(zip);
    expect(iconBuffer).toEqual(iconBytes);
    // Files that are neither pictures nor music and external uris are left alone;
    // a nameless asset falls back to its file name.
    expect(assets).toEqual([
      { name: 'smile', bytes: smile, emotion: true },
      { name: 'bg', bytes: background },
      { name: 'wave', bytes: nameless, emotion: true },
      { name: 'bgm', bytes: Uint8Array.from([50, 51]), additional: true },
      { name: 'intro', bytes: Uint8Array.from([60, 61]), additional: true },
    ]);
    // What was left behind, for the import to say so: the notes, and a picture
    // the archive does not hold.
    expect(skipped).toEqual({ unsupported: 1, missing: 1, overBudget: 0 });
  });

  it(`stops at ${MAX_ASSETS} assets`, () => {
    const files: Record<string, Uint8Array> = { 'assets/icon/main.png': iconBytes };
    const declared = [{ type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' }];
    for (let i = 0; i < MAX_ASSETS + 10; i += 1) {
      files[`assets/emotion/e${i}.png`] = Uint8Array.from([i]);
      declared.push({ type: 'emotion', name: `e${i}`, uri: `embeded://assets/emotion/e${i}.png`, ext: 'png' });
    }
    const { assets, skipped } = parseCard(zipSync({ 'card.json': cardWithAssets(declared), ...files }));

    expect(assets).toHaveLength(MAX_ASSETS);
    expect(assets!.at(-1)!.name).toBe(`e${MAX_ASSETS - 1}`);
    expect(skipped).toEqual({ unsupported: 0, missing: 0, overBudget: 10 });
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

    const { card, assets, skipped } = parseCard(zip);
    // The card still imports — only card.json and the icon fail hard on the cap.
    expect(card.name).toBe('세이');
    // Reading stops at the offender rather than paying to inflate past it, so
    // what was declared before it survives and what comes after does not.
    expect(assets).toEqual([{ name: 'early', bytes: early, emotion: true }]);
    expect(skipped).toEqual({ unsupported: 0, missing: 0, overBudget: 2 });
  });

  it('shares one inflate budget between the icon and the assets', () => {
    // 19MB entries: each under the per-entry cap, one more than the archive
    // budget holds. Per-pass budgets would let all of them through.
    const big = new Uint8Array(19 * 1024 * 1024);
    const fit = Math.floor(MAX_TOTAL_BYTES / big.length);
    const declared: unknown[] = [
      { type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' },
    ];
    const files: Zippable = { 'assets/icon/main.png': iconBytes };
    for (let i = 0; i <= fit; i += 1) {
      declared.push({ type: 'emotion', name: `b${i}`, uri: `embeded://assets/b${i}.png`, ext: 'png' });
      // Stored, as a real card's images are: a gigabyte is not deflated twice per run.
      files[`assets/b${i}.png`] = [big, { level: 0 }];
    }

    const { iconBuffer, assets } = parseCard(
      zipSync({ 'card.json': cardWithAssets(declared), ...files }),
    );
    // The icon is read in the same pass and comes first in the archive.
    expect(iconBuffer).toEqual(iconBytes);
    // `fit` of them fit; the next crosses the budget and ends the pass.
    expect(assets!.map((asset) => asset.name)).toEqual(Array.from({ length: fit }, (_, i) => `b${i}`));
  });

  it('fails when card.json is missing', () => {
    expect(() => parseCard(zipSync({ 'other.json': encode({}) }))).toThrow(CardParseError);
  });

  const patterned = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
    return bytes;
  };

  // Above readCharx's per-entry cap. Built once and reused as zip input.
  let oversized: Uint8Array | undefined;
  const oversizedAsset = (): Uint8Array => (oversized ??= patterned(MAX_ENTRY_BYTES + 4 * 1024 * 1024));

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
      // Large enough to fill most of the archive; its size has nothing to do with the cap.
      'assets/huge.bin': patterned(24 * 1024 * 1024),
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
    expect(() => parseCard(zip)).toThrow(`${MAX_ENTRY_BYTES / (1024 * 1024)}MB limit`);
  });

  it('caps on emitted bytes, not on the sizes declared in the zip headers', () => {
    // The declared uncompressed size is attacker-controlled. Understate it and a
    // cap that trusts the headers waves through an entry that really inflates past it.
    const zip = zipSync({ 'card.json': oversizedAsset() });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint32(22, 1024, true); // local file header: uncompressed size
    view.setUint32(centralDirOffset(zip) + 24, 1024, true); // central directory: uncompressed size

    expect(() => parseCard(zip)).toThrow(CardParseError);
    expect(() => parseCard(zip)).toThrow(`${MAX_ENTRY_BYTES / (1024 * 1024)}MB limit`);
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

    it("takes the module's lorebook over the card's book, keeping the book's settings", () => {
      const lorebook = [
        { key: '비, 우산', secondkey: '', insertorder: 5, comment: '비', content: '비가 내린다.', mode: 'normal', alwaysActive: false, selective: false },
      ];
      const withLore = buildRisum({
        module: { name: 'm', description: '', id: 'id', regex: [], trigger: [], lorebook },
        type: 'risuModule',
      });
      // An unreadable module: the card as card.json alone has it.
      const alone = parseCard(risuCharx(Uint8Array.from([1, 2, 3]))).card;
      expect(alone.lorebook).toHaveLength(2);

      const { card } = parseCard(risuCharx(withLore));
      // Read as a module import reads the same entries.
      expect(card.lorebook).toEqual(lorebook.map(risuLoreBookEntry));
      expect(card.lorebook[0]).toMatchObject({ keys: ['비', '우산'], content: '비가 내린다.', insertionOrder: 5 });
      expect(card.loreSettings).toEqual(alone.loreSettings);
      // RisuAI's `if(md.lorebook)` takes an empty one too: the card's entries go.
      expect(parseCard(risuCharx(moduleFile)).card.lorebook).toEqual([]);
      // A module without one leaves the card's.
      const noLore = buildRisum({ module: { name: 'm', description: '', id: 'id', regex: scripts }, type: 'risuModule' });
      expect(parseCard(risuCharx(noLore)).card.lorebook).toEqual(alone.lorebook);
    });

    it("takes the module's lists over the ones card.json carries, as RisuAI's charx import does", () => {
      const own = [{ comment: '', in: 'own', out: 'mine', type: 'editdisplay', ableFlag: false, flag: '' }];
      const ownTriggers = [{ comment: 'own', type: 'manual', conditions: [], effect: [] }];
      const { card } = parseCard(risuCharx(moduleFile, { customScripts: own, triggerscript: ownTriggers }));

      expect(card.extensions['risuai']).toEqual({ customScripts: scripts, triggerscript: triggers });
      expect(card.displayScripts!.map((script) => script.in)).toEqual(['\\*\\*(.+?)\\*\\*']);
      // A list the module does not have is an empty one, whatever card.json says.
      const regexOnly = buildRisum({ module: { name: 'm', description: '', id: 'id', regex: [] }, type: 'risuModule' });
      const bare = parseCard(risuCharx(regexOnly, { customScripts: own, triggerscript: ownTriggers })).card;
      expect(bare.extensions['risuai']).toEqual({ customScripts: [], triggerscript: [] });
      expect(bare.displayScripts).toBeUndefined();
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
    // `@@position` goes out as V3's own position, which reads back without the author's mark.
    expect(reparsed.lorebook).toEqual(card.lorebook.map(({ positioned: _placed, ...entry }) => entry));
    expect(reparsed.loreSettings).toEqual(card.loreSettings);
  });

  it("keeps an entry's label through the round trip, out of the prompt", () => {
    const entry = (fields: Record<string, unknown>) => ({
      keys: [''],
      content: '호그와트의 규칙.',
      extensions: {},
      enabled: true,
      insertion_order: 0,
      use_regex: false,
      constant: true,
      ...fields,
    });
    const card = normalizeCard({
      ...v3Card,
      data: {
        ...v3Card.data,
        character_book: {
          extensions: {},
          // RisuAI writes both; SillyTavern only `comment`; most cards neither.
          entries: [entry({ name: '글노덮', comment: '글노덮' }), entry({ comment: '  학교  ' }), entry({})],
        },
      },
    });
    expect(card.lorebook.map((lore) => lore.name)).toEqual(['글노덮', '학교', undefined]);

    const written = exportCardV3(card).data.character_book!.entries;
    expect(written.map((lore) => [lore.name, lore.comment])).toEqual([
      ['글노덮', '글노덮'],
      ['학교', '학교'],
      [undefined, undefined],
    ]);
    expect(parseCard(exportCardV3(card)).card.lorebook).toEqual(card.lorebook);

    const { system } = assemblePrompt({
      plot: { name: '이야기', description: '', lorebook: [] },
      characters: [{ name: card.name, card }],
      history: [{ role: 'user', content: '안녕' }],
    });
    expect(system).toContain('호그와트의 규칙.');
    expect(system).not.toContain('글노덮');
  });

  it('writes a token budget only where the card has one of its own', () => {
    // The V3 fixture's book names none, so it reads (and stays) automatic.
    const automatic = parseCard(v3Card).card;
    expect(automatic.loreSettings.tokenBudget).toBeUndefined();
    expect(exportCardV3(automatic).data.character_book).not.toHaveProperty('token_budget');

    const own = parseCard(v2Card).card;
    expect(exportCardV3(own).data.character_book!.token_budget).toBe(512);
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

describe('introFromCreatorNotes', () => {
  it('reads the section Realm would show the reader', () => {
    // As Realm cards write it: an English section, which Realm requires.
    const parma = '\n# `en`\nAn adult fantasy knight order roleplay set in the city of Parma.';
    expect(introFromCreatorNotes(parma, 'ko')).toBe('An adult fantasy knight order roleplay set in the city of Parma.');

    const both = '# `en`\nKnights of Parma.\n# `ko`\n파르마의 기사단.\n\n둘째 문단.';
    expect(introFromCreatorNotes(both, 'ko')).toBe('파르마의 기사단.\n\n둘째 문단.');
    expect(introFromCreatorNotes(both, 'ja')).toBe('Knights of Parma.');
    expect(introFromCreatorNotes(both)).toBe('Knights of Parma.');
  });

  it('takes untagged notes whole, and nothing from blank ones', () => {
    expect(introFromCreatorNotes('  **기사단**을 이끄는 이야기.\n')).toBe('**기사단**을 이끄는 이야기.');
    expect(introFromCreatorNotes('', 'ko')).toBeUndefined();
    expect(introFromCreatorNotes('# `ko`\n   ', 'ko')).toBeUndefined();
  });

  it('cuts notes past the cap rather than dropping them', () => {
    expect(introFromCreatorNotes('가'.repeat(MAX_INTRO_LENGTH + 10))).toBe('가'.repeat(MAX_INTRO_LENGTH));
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
    // The limited view is one this build has a label for.
    expect(stranger({ pov: 'third-limited' })).toEqual({ pov: 'third-limited' });
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

  it('keeps the group-only greetings and writes each back once, where it came from', () => {
    const grouped = normalizeCard({
      ...v3Card,
      data: { ...v3Card.data, group_only_greetings: ['모두 모였군.', '셋이서 왔소?'] },
    });
    expect(grouped.groupOnlyGreetings).toEqual(['모두 모였군.', '셋이서 왔소?']);
    expect(exportCardV3(grouped).data.group_only_greetings).toEqual(['모두 모였군.', '셋이서 왔소?']);
    // An import into a cast made one of them an opening of the plot: it goes out
    // as a group greeting still, not as a one-on-one alternate as well.
    const exported = exportCardV3(grouped, { intros: ['첫 인사.', '모두 모였군.', '둘째.'] });
    expect(exported.data.first_mes).toBe('첫 인사.');
    expect(exported.data.alternate_greetings).toEqual(['둘째.']);
    expect(exported.data.group_only_greetings).toEqual(['모두 모였군.', '셋이서 왔소?']);
    expect(normalizeCard(exported).groupOnlyGreetings).toEqual(grouped.groupOnlyGreetings);
    // A card that has none carries no empty list.
    expect(normalizeCard(v3Card)).not.toHaveProperty('groupOnlyGreetings');
  });
});

describe('exportCardCharx', () => {
  const card = exportCardV3(normalizeCard(v3Card));
  const gif = (n: number): Uint8Array => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, n]);
  // As the plot holds them: an imported image keeps the card's own name, an
  // upload without one has only its slug.
  const plotAssets: CharxExportAsset[] = [
    { slug: 'smile', name: 'Smile', ext: 'gif', bytes: gif(1) },
    { slug: 'asset-2', name: '웃음.png', ext: 'png', bytes: placeholderPng() },
    { slug: 'castle', name: null, ext: 'webp', bytes: gif(3) },
  ];
  const declaredIn = (charx: Uint8Array): unknown =>
    JSON.parse(new TextDecoder().decode(unzipSync(charx)['card.json'])).data.assets;

  it('declares the icon and every asset the way RisuAI reads them', () => {
    const icon = { ext: 'jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]) };
    const charx = exportCardCharx(card, plotAssets, icon);
    expect(declaredIn(charx)).toEqual([
      { type: 'icon', uri: 'embeded://assets/icon/image/main.jpg', name: 'main', ext: 'jpg' },
      { type: 'x-risu-asset', uri: 'embeded://assets/other/image/smile.gif', name: 'Smile', ext: 'gif' },
      { type: 'x-risu-asset', uri: 'embeded://assets/other/image/asset-2.png', name: '웃음.png', ext: 'png' },
      // The studio's `{{img::asset-2}}` has to find it in RisuAI too; `Smile` needs no alias.
      { type: 'x-risu-asset', uri: 'embeded://assets/other/image/asset-2.png', name: 'asset-2', ext: 'png' },
      { type: 'x-risu-asset', uri: 'embeded://assets/other/image/castle.webp', name: 'castle', ext: 'webp' },
    ]);
    // Stored, with the sizes in the local header rather than in a trailing
    // descriptor: a streaming reader then never hunts for a signature in a picture.
    expect(charx[6]! & 0x08).toBe(0);
    expect(charx[8]).toBe(0);

    const parsed = parseCard(charx);
    expect(parsed.card.name).toBe('세이');
    expect(parsed.iconBuffer).toEqual(icon.bytes);
    expect(parsed.assets).toEqual([
      { name: 'Smile', bytes: gif(1), additional: true },
      { name: '웃음.png', bytes: placeholderPng(), additional: true },
      { name: 'castle', bytes: gif(3), additional: true },
    ]);
  });

  it('brings every {{img::…}} reference back to the same picture', () => {
    const parsed = parseCard(exportCardCharx(card, plotAssets)).assets!;
    // A re-import mints slugs of its own; the names are what carry the references.
    const reimported = parsed.map((asset, i) => ({ slug: `re-${i}`, name: asset.name }));
    const before = assetResolver(plotAssets);
    const after = assetResolver(reimported);
    const bytesBefore = new Map(plotAssets.map((asset) => [asset.slug, asset.bytes]));
    const bytesAfter = new Map(reimported.map((asset, i) => [asset.slug, parsed[i]!.bytes]));
    for (const ref of ['Smile', 'smile', '웃음.png', '웃음', 'castle']) {
      expect(bytesBefore.get(before(ref)!), ref).toBeDefined();
      expect(bytesAfter.get(after(ref)!), ref).toEqual(bytesBefore.get(before(ref)!));
    }
  });

  it("declares the member's emotion pictures as RisuAI's emotions, which an import reads back as such", () => {
    const charx = exportCardCharx(card, [{ slug: 'happy-2', name: 'happy', ext: 'gif', bytes: gif(4), emotion: 'happy' }]);
    expect(declaredIn(charx)).toEqual([
      { type: 'emotion', uri: 'embeded://assets/other/image/happy-2.gif', name: 'happy', ext: 'gif' },
      { type: 'x-risu-asset', uri: 'embeded://assets/other/image/happy-2.gif', name: 'happy', ext: 'gif' },
      { type: 'x-risu-asset', uri: 'embeded://assets/other/image/happy-2.gif', name: 'happy-2', ext: 'gif' },
    ]);
    expect(parseCard(charx).assets).toEqual([{ name: 'happy', bytes: gif(4), emotion: true }]);
  });

  it('files each asset under the folder RisuAI picks by its extension', () => {
    const mp3 = Uint8Array.from([...Buffer.from('ID3'), 4, 0, 1]);
    const charx = exportCardCharx(card, [
      { slug: 'bgm', name: 'bgm', ext: 'mp3', bytes: mp3 },
      { slug: 'photo', name: 'photo', ext: 'JPEG', bytes: new Uint8Array([0xff, 0xd8, 0xff, 2]) },
      { slug: 'blob', name: 'blob', ext: 'bin', bytes: new Uint8Array([1]) },
    ]);
    expect(Object.keys(unzipSync(charx)).sort()).toEqual([
      'assets/other/audio/bgm.mp3',
      'assets/other/image/photo.JPEG',
      'assets/other/other/blob.bin',
      'card.json',
    ]);
    // Our own import finds the music where the export put it.
    expect(parseCard(charx).assets).toContainEqual({ name: 'bgm', bytes: mp3, additional: true });
  });

  it('declares no icon when the member has no picture', () => {
    const charx = exportCardCharx(card, [], undefined);
    expect(declaredIn(charx)).toEqual([]);
    const parsed = parseCard(charx);
    expect(parsed.iconBuffer).toBeUndefined();
    expect(parsed.assets).toEqual([]);
    expect(parsed.card.firstMes).toBe('자리 있소?');
  });

  it('carries a web font the import fetched, which its own import takes back by the address it came from', () => {
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]);
    const charx = exportCardCharx(card, [{ slug: 'nanum', name: 'https://fonts.test/nanum.woff2', ext: 'woff2', bytes: woff2 }]);
    expect(declaredIn(charx)).toEqual([
      { type: 'x-risu-asset', uri: 'embeded://assets/other/fonts/nanum.woff2', name: 'https://fonts.test/nanum.woff2', ext: 'woff2' },
      { type: 'x-risu-asset', uri: 'embeded://assets/other/fonts/nanum.woff2', name: 'nanum', ext: 'woff2' },
    ]);
    expect(parseCard(charx).assets).toEqual([{ name: 'https://fonts.test/nanum.woff2', bytes: woff2, additional: true }]);
  });
});

describe('toRisuAssetRefs', () => {
  const plot = '0b6c5f6e-1d2a-4b3c-8d4e-5f6a7b8c9d0e';
  const assets = [
    { slug: 'smile', name: 'Smile' },
    { slug: 'castle', name: null },
    { slug: 'nanum', name: 'https://fonts.test/nanum.woff2' },
    { slug: 'odd', name: 'a "quoted" name' },
  ];

  it('names each of the plot’s assets as RisuAI reaches a card’s own', () => {
    const text = [
      `<img src="/api/plots/${plot}/assets/smile">`,
      `<div style="background:url('/api/plots/${plot}/assets/castle')"></div>`,
      `@font-face{src:url(/api/plots/${plot}/assets/nanum) format('woff2')}`,
      `<img src="/api/plots/${plot}/assets/odd">`,
      `<img src="/api/plots/${plot}/assets/by-name/cdn.test/face/$1.png">`,
      `<img src="/api/plots/${plot}/assets/gone">`,
      `<img src="/api/plots/other-plot/assets/smile">`,
    ].join('\n');
    expect(toRisuAssetRefs(text, plot, assets).split('\n')).toEqual([
      '<img src="{{raw::Smile}}">',
      "<div style=\"background:url('{{raw::castle}}')\"></div>",
      "@font-face{src:url({{raw::https://fonts.test/nanum.woff2}}) format('woff2')}",
      // A name that would not read as one goes by its slug, which the charx declares too.
      '<img src="{{raw::odd}}">',
      // A template's slot is filled before the name is looked up.
      '<img src="{{raw::https://cdn.test/face/$1.png}}">',
      // Not one of the plot's assets, or not this plot's: left as written.
      `<img src="/api/plots/${plot}/assets/gone">`,
      '<img src="/api/plots/other-plot/assets/smile">',
    ]);
    // What our own import resolves them back to, by the names the charx declares.
    const resolve = assetResolver(assets.map((asset) => ({ slug: `re-${asset.slug}`, name: asset.name ?? asset.slug })));
    expect(resolve('https://fonts.test/nanum.woff2')).toBe('re-nanum');
    expect(resolve('Smile')).toBe('re-smile');
  });

  it("writes the work's own background in place of the card's, or none", () => {
    const stored = normalizeCard({
      ...v3Card,
      data: { ...v3Card.data, extensions: { risuai: { backgroundHTML: '<style>@import url(https://fonts.test/a.css);</style>' } } },
    });
    const exported = exportCardV3(stored, { backgroundHtml: '<style>\n.a{}\n</style>\n<div></div>' });
    expect((exported.data.extensions['risuai'] as Record<string, unknown>)['backgroundHTML']).toBe(
      '<style>\n.a{}\n</style>\n<div></div>',
    );
    expect(exportCardV3(stored, { backgroundHtml: '' }).data.extensions).not.toHaveProperty('risuai');
    expect((exportCardV3(stored).data.extensions['risuai'] as Record<string, unknown>)['backgroundHTML']).toBe(
      '<style>@import url(https://fonts.test/a.css);</style>',
    );
  });
});

// RisuAI's terms come from its lorebook.svelte.ts (matching and decorators) and
// characterCards.ts (the import that rewrites ST settings into decorators).
describe('RisuAI lorebook entries', () => {
  /** One entry as RisuAI's export writes it: no ST position, so not read as ST's. */
  const risuEntry = (fields: Record<string, unknown>): LoreEntry =>
    normalizeCard({
      ...v3Card,
      data: {
        ...v3Card.data,
        character_book: {
          extensions: {},
          entries: [
            {
              keys: [],
              content: '본문',
              extensions: {},
              enabled: true,
              insertion_order: 100,
              constant: false,
              selective: false,
              case_sensitive: false,
              use_regex: false,
              ...fields,
            },
          ],
        },
      },
    }).lorebook[0]!;
  const fires = (entry: LoreEntry, text: string, random?: () => number): boolean =>
    activateLore([entry], { history: [text], scanDepth: 1, budgetTokens: 1000, countTokens: (t) => t.length, random })
      .entries.length === 1;

  it('reads /pattern/flags keys as regexes, with `i` deciding the case', () => {
    const sword = risuEntry({ keys: ['/검(술|객)/i'], use_regex: true });
    expect(sword).toMatchObject({ keys: ['검(술|객)'], useRegex: true, caseSensitive: false });
    expect(fires(sword, '떠돌이 검객이 들어온다')).toBe(true);
    expect(fires(sword, '떠돌이 상인이 들어온다')).toBe(false);

    // RisuAI's regexes never read case_sensitive: without `i` they keep case.
    const exact = risuEntry({ keys: ['/Sword \\d+/'], use_regex: true, case_sensitive: false });
    expect(exact.caseSensitive).toBe(true);
    expect(fires(exact, 'Sword 7')).toBe(true);
    expect(fires(exact, 'sword 7')).toBe(false);
    const loose = risuEntry({ keys: ['/Sword \\d+/i'], use_regex: true, case_sensitive: true });
    expect(loose.caseSensitive).toBe(false);
    expect(fires(loose, 'SWORD 7')).toBe(true);

    // Secondary keys are regexes on the same terms.
    const night = risuEntry({
      keys: ['/검객/'],
      secondary_keys: ['/밤|새벽/'],
      selective: true,
      use_regex: true,
    });
    expect(night.secondaryKeys).toEqual(['밤|새벽']);
    expect(fires(night, '새벽의 검객')).toBe(true);
    expect(fires(night, '한낮의 검객')).toBe(false);
  });

  it('keeps use_regex only where RisuAI keeps it', () => {
    // A first key without a slash: RisuAI's import clears the flag, and every key is text.
    const plain = risuEntry({ keys: ['검(술|객)', '/칼/'], use_regex: true });
    expect(plain).toMatchObject({ keys: ['검(술|객)', '/칼/'], useRegex: false });
    expect(fires(plain, '떠돌이 검객')).toBe(false);
    // Slashes without the flag are text too.
    expect(risuEntry({ keys: ['/검객/'] })).toMatchObject({ keys: ['/검객/'], useRegex: false });

    // A bare key in a regex entry would fail RisuAI's whole key list; here it is a literal.
    const mixed = risuEntry({ keys: ['/검(술|객)/i', '칼.'], use_regex: true });
    expect(mixed.keys).toEqual(['검(술|객)', '칼\\.']);
    expect(fires(mixed, '칼.')).toBe(true);
    expect(fires(mixed, '칼날')).toBe(false);
  });

  it('maps @@probability, @@activate and @@dont_activate', () => {
    const rare = risuEntry({ keys: ['궁'], content: '@@probability 30\n본문' });
    expect(rare.probability).toBe(30);
    expect(fires(rare, '궁', () => 0.2)).toBe(true);
    expect(fires(rare, '궁', () => 0.5)).toBe(false);
    expect(risuEntry({ keys: ['궁'], content: '@@probability 100\n본문' })).not.toHaveProperty('probability');

    // RisuAI lore has no `enabled`; this is its off switch.
    const off = risuEntry({ keys: ['궁'], content: '@@dont_activate\n본문' });
    expect(off).toMatchObject({ enabled: false, content: '본문' });
    expect(fires(off, '궁')).toBe(false);
    const on = risuEntry({ keys: ['궁'], content: '@@activate\n본문' });
    expect(on.constant).toBe(true);
    expect(fires(on, '아무 말')).toBe(true);
    expect(risuEntry({ keys: ['궁'], content: '@@activate\n@@dont_activate\n본문' })).toMatchObject({
      enabled: false,
      constant: false,
    });
  });

  it('turns the key decorators into secondary keys', () => {
    const any = risuEntry({ keys: ['궁'], content: '@@additional_keys 밤, 새벽\n본문' });
    expect(any).toMatchObject({ secondaryKeys: ['밤', '새벽'], selective: true });
    expect(any.selectiveLogic).toBeUndefined();
    expect(fires(any, '궁의 새벽')).toBe(true);
    expect(fires(any, '궁의 한낮')).toBe(false);

    // One line per key is how RisuAI writes ST's AND_ALL.
    const all = risuEntry({ keys: ['궁'], content: '@@additional_keys 밤\n@@additional_keys 달\n본문' });
    expect(all).toMatchObject({ secondaryKeys: ['밤', '달'], selective: true, selectiveLogic: 'and_all' });
    expect(fires(all, '궁의 밤')).toBe(false);
    expect(fires(all, '궁의 밤, 달')).toBe(true);

    // ...and NOT_ANY: every line counts.
    const none = risuEntry({ keys: ['궁'], content: '@@exclude_keys 왕비\n@@exclude_keys 시녀\n본문' });
    expect(none).toMatchObject({ secondaryKeys: ['왕비', '시녀'], selectiveLogic: 'not_any' });
    expect(fires(none, '궁의 시녀')).toBe(false);
    expect(fires(none, '궁의 기사')).toBe(true);

    const notAll = risuEntry({ keys: ['궁'], content: '@@exclude_keys_all 왕비,시녀\n본문' });
    expect(notAll).toMatchObject({ secondaryKeys: ['왕비', '시녀'], selectiveLogic: 'not_all' });
    expect(fires(notAll, '궁의 시녀')).toBe(true);
    expect(fires(notAll, '궁의 왕비와 시녀')).toBe(false);

    // On a regex entry RisuAI reads the decorator's keys as regexes too.
    const regex = risuEntry({ keys: ['/궁/'], use_regex: true, content: '@@exclude_keys /왕비|시녀/\n본문' });
    expect(regex.secondaryKeys).toEqual(['왕비|시녀']);
    expect(fires(regex, '궁의 시녀')).toBe(false);
    expect(fires(regex, '궁의 기사')).toBe(true);
  });

  it('reads an ST entry RisuAI re-exported once, from its decorators', () => {
    // RisuAI's import moved the probability and the AND_ALL keys into decorators,
    // left position 1 and selectiveLogic in the extensions, and stopped exporting
    // the secondary keys once the entry was no longer selective.
    const raw = stCard();
    const [, second] = raw.data.character_book.entries;
    const { probability: _probability, useProbability: _useProbability, ...kept } = second!.extensions;
    const entry = normalizeCard({
      ...raw,
      data: {
        ...raw.data,
        character_book: {
          ...raw.data.character_book,
          // What RisuAI's exporter writes on every book it exports.
          extensions: { risu_fullWordMatching: false },
          entries: [
            {
              ...second!,
              secondary_keys: undefined,
              selective: false,
              use_regex: false,
              content: '@@additional_keys 달\n@@additional_keys 밤\n@@probability 30\n엘라라의 활은 할머니의 유품이다.',
              extensions: { ...kept, selectiveLogic: 3 },
            },
          ],
        },
      },
    }).lorebook[0]!;
    expect(entry).toMatchObject({
      keys: ['활'],
      secondaryKeys: ['달', '밤'],
      selective: true,
      selectiveLogic: 'and_all',
      probability: 30,
      position: 'after_char',
      content: '엘라라의 활은 할머니의 유품이다.',
    });
    expect(fires(entry, '활과 밤', () => 0)).toBe(false);
    expect(fires(entry, '활과 밤과 달', () => 0)).toBe(true);
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
      // ST reads a key as a regex only in its slash form, one key at a time,
      // whatever use_regex says — so the keys stay as ST wrote them.
      keys: ['엘프', '/숲(지기|의 왕)/i'],
      secondaryKeys: [],
      selective: true,
      content: '엘프는 숲의 왕을 섬긴다.',
      enabled: true,
      constant: false,
      insertionOrder: 10,
      caseSensitive: false,
      // ST's `case_sensitive: null`: the book's setting decides.
      caseSensitiveFromBook: true,
      useRegex: false,
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
      // ST's card writer turns an unset scoring into false (`useGroupScoring ?? false`).
      useGroupScoring: false,
      sillyTavern: true,
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
      useGroupScoring: false,
      sillyTavern: true,
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
      depthPrompt: true,
    });
    expect(card.extensions['depth_prompt']).toBeUndefined();
    expect(card.extensions['world']).toBe('엘라라의 숲');

    // The export writes it back where ST keeps it, out of the book, so a
    // re-import finds it once, as the same entry.
    const exported = exportCardV3(card);
    expect(exported.data.extensions['depth_prompt']).toEqual({ prompt: '{{char}}는 숲을 떠나지 않는다.', depth: 2, role: 'system' });
    expect(exported.data.character_book!.entries).toHaveLength(2);
    expect(normalizeCard(exported).lorebook).toEqual(card.lorebook);

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

  it("reads only ST's own decorators off an entry ST wrote, as ST does (parseDecorators)", () => {
    const entryWith = (content: string, book: Record<string, unknown> = {}) => {
      const raw = stCard();
      const [first] = raw.data.character_book.entries;
      return normalizeCard({
        ...raw,
        data: { ...raw.data, character_book: { ...raw.data.character_book, ...book, entries: [{ ...first!, content }] } },
      }).lorebook[0]!;
    };
    // ST takes the V3 decorators off and ignores them: its extensions decide.
    expect(entryWith('@@depth 1\n@@role user\n본문')).toMatchObject({ depth: 2, role: 'assistant', content: '본문' });
    expect(entryWith('@@activate_only_after 9\n@@scan_depth 1\n본문')).toMatchObject({ delay: 5, scanDepth: 6 });
    expect(entryWith('@@activate\n본문')).toMatchObject({ constant: true, content: '본문' });
    expect(entryWith('@@dont_activate\n본문')).toMatchObject({ enabled: false, content: '본문' });
    // A RisuAI book keeps ST's extensions on the way through, and RisuAI's
    // decorators win there, as RisuAI reads them.
    const risu = { extensions: { risu_fullWordMatching: false } };
    expect(entryWith('@@depth 1\n@@role user\n본문', risu)).toMatchObject({ depth: 1, role: 'user' });
    const positioned = entryWith('@@position after_desc\n본문', risu);
    expect(positioned.position).toBe('after_char');
    expect(positioned.depth).toBeUndefined();
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
    // Each on the side ST's placement names (`messageFormatting`'s USER_INPUT or AI_OUTPUT).
    expect(card.displayScripts).toEqual([
      {
        in: '\\[status\\] hp=(\\d+)',
        out: '<div class="hp">$& → $1</div>',
        flags: 'gi',
        order: 0,
        enabled: true,
        role: 'assistant',
      },
      { in: 'user', out: '<div class="hp">$& → $1</div>', order: 1, enabled: true, role: 'user' },
      { in: 'bare $', out: '[$&]', order: 2, enabled: true, role: 'assistant' },
    ]);
    // The same rewrite on two sides is one script on both — not on the narrator's
    // messages (`SLASH_COMMAND`), which ST asks apart from the reader's and the replies.
    expect(
      withScripts([
        { ...script, placement: [1] },
        { ...script, placement: [2] },
        { ...script, findRegex: 'both', placement: [1, 2] },
      ]).displayScripts?.map((one) => one.role),
    ).toEqual([
      ['user', 'assistant'],
      ['user', 'assistant'],
    ]);
    // On the narrator's messages: the narrations; on all three, every message.
    expect(
      withScripts([
        { ...script, findRegex: 'narrator', placement: [3] },
        { ...script, findRegex: 'replies and narrator', placement: [2, 3] },
        { ...script, findRegex: 'all', placement: [3, 2, 1] },
        { ...script, findRegex: 'world info', placement: [5] },
      ]).displayScripts?.map((one) => [one.in, one.role]),
    ).toEqual([
      ['narrator', 'narration'],
      ['replies and narrator', ['assistant', 'narration']],
      ['all', undefined],
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

  it("carries a display-only regex script's depth range, as ST reads it", () => {
    const script = stCard().data.extensions.regex_scripts[0]!;
    const ranged = (minDepth: unknown, maxDepth: unknown) => {
      const raw = stCard();
      const extensions = { ...raw.data.extensions, regex_scripts: [{ ...script, minDepth, maxDepth }] };
      const [first] = normalizeCard({ ...raw, data: { ...raw.data, extensions } }).displayScripts!;
      return { minDepth: first!.minDepth, maxDepth: first!.maxDepth };
    };
    expect(ranged(1, 3)).toEqual({ minDepth: 1, maxDepth: 3 });
    // An old export's strings, and the nulls ST writes for "no limit".
    expect(ranged('2', '5')).toEqual({ minDepth: 2, maxDepth: 5 });
    expect(ranged(null, null)).toEqual({ minDepth: undefined, maxDepth: undefined });
    // ST's -1 minimum and a negative maximum limit nothing on screen.
    expect(ranged(-1, -1)).toEqual({ minDepth: undefined, maxDepth: undefined });
  });

  it('exports the settings where ST reads them, and reads its own export back', () => {
    const { card } = parseCard(stPng());
    const exported = exportCardV3(card);
    const [first, second, note] = exported.data.character_book!.entries;
    // Each key as ST wrote it, a regex in its slash form beside a plain one.
    expect(first!.keys).toEqual(['엘프', '/숲(지기|의 왕)/i']);
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
      use_group_scoring: false,
      // Left to the book, as ST wrote it.
      case_sensitive: null,
      shizue_sillytavern: true,
    });
    expect(second!.keys).toEqual(['활']);
    expect(second!.extensions).toMatchObject({ position: 1, selectiveLogic: 2, probability: 100, case_sensitive: true });
    // The character's note is ST's `depth_prompt` again.
    expect(note).toBeUndefined();
    expect(exported.data.extensions['depth_prompt']).toEqual({ prompt: '{{char}}는 숲을 떠나지 않는다.', depth: 2, role: 'system' });
    expect(exported.data.character_book!.extensions).toMatchObject({ shizue: true });

    expect(normalizeCard(exported).lorebook).toEqual(card.lorebook);
  });

  it("keeps ST's positions around the note and the examples, and an outlet's name, through the trip", () => {
    const raw = stCard();
    const [base] = raw.data.character_book.entries;
    const at = (position: number, extra: Record<string, unknown> = {}) => ({
      ...base!,
      extensions: { ...base!.extensions, position, ...extra },
    });
    const card = normalizeCard({
      ...raw,
      data: {
        ...raw.data,
        character_book: {
          ...raw.data.character_book,
          entries: [at(2), at(3), at(5), at(6), at(7, { outlet_name: ' 금고 ' }), at(7, { outlet_name: '' })],
        },
      },
    });
    const own = card.lorebook.slice(0, 6);
    expect(own.map((entry) => [entry.position, entry.outletName, entry.depth])).toEqual([
      ['before_author_note', undefined, undefined],
      ['after_author_note', undefined, undefined],
      ['before_examples', undefined, undefined],
      ['after_examples', undefined, undefined],
      ['outlet', '금고', undefined],
      ['outlet', undefined, undefined],
    ]);

    const entries = exportCardV3({ ...card, lorebook: own }).data.character_book!.entries;
    expect(entries.map((entry) => [entry.position, entry.extensions?.['position'], entry.extensions?.['outlet_name']])).toEqual([
      ['before_char', 2, undefined],
      ['after_char', 3, undefined],
      ['before_char', 5, undefined],
      ['after_char', 6, undefined],
      ['before_char', 7, '금고'],
      ['before_char', 7, ''],
    ]);
    expect(normalizeCard(exportCardV3({ ...card, lorebook: own })).lorebook).toEqual(own);
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

  it('writes a switched-off entry back out as @@dont_activate, the off switch RisuAI reads', () => {
    const { card } = parseCard(v3Card);
    const { positioned: _placed, ...off }: LoreEntry = { ...card.lorebook[1]!, enabled: false };
    const exported = exportCardV3({ ...card, lorebook: [off] });
    expect(exported.data.character_book!.entries[0]!.content).toBe('@@dont_activate\n주막은 국경 검문소 옆이다.');
    expect(normalizeCard(exported).lorebook).toEqual([off]);
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
    // The side a script keeps to does not go out — RisuAI's list, which carries
    // the export's display scripts, has no placement — and the copy that comes
    // back from it runs on every message.
    expect(parsed.card.displayScripts).toEqual(card.displayScripts?.map(({ role: _side, ...script }) => script));
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

describe('normalizeCard - a RisuAI book', () => {
  /** A V3 card as RisuAI's exporter writes one: the book carries `risu_fullWordMatching`. */
  const risuCard = (book: Record<string, unknown> = {}) => {
    const { recursive_scanning: _, ...rest } = v3Card.data.character_book;
    return {
      ...v3Card,
      data: {
        ...v3Card.data,
        extensions: { risuai: { bias: [] } },
        character_book: { ...rest, extensions: { risu_fullWordMatching: false }, ...book },
      },
    };
  };

  it("takes an entry RisuAI wrote with `insertion_order: null`, at RisuAI's default order", () => {
    // Jurassic girl Park: 8 of 34 entries, which ccardlib's schema refuses whole.
    const [entry] = v3Card.data.character_book.entries;
    const raw = risuCard({
      entries: [
        { ...entry, insertion_order: null, mode: 'normal', folder: '' },
        { ...entry, insertion_order: 5, name: '둘째' },
      ],
    });
    const card = normalizeCard(raw);
    expect(card.spec).toBe('v3');
    expect(card.lorebook.map((lore) => lore.insertionOrder)).toEqual([100, 5]);
    // The card is kept as it arrived.
    expect((card.raw as typeof raw).data.character_book.entries[0]!.insertion_order).toBeNull();
  });

  it('scans recursively and matches the RisuAI way when the card names no settings', () => {
    expect(normalizeCard(risuCard()).loreSettings).toEqual({
      scanDepth: 4,
      recursiveScanning: true,
      risuMatching: true,
    });
  });

  it("keeps the card's settings when it names all three, as RisuAI does", () => {
    const card = normalizeCard(risuCard({ scan_depth: 7, token_budget: 600, recursive_scanning: false }));
    expect(card.loreSettings).toEqual({
      scanDepth: 7,
      tokenBudget: 600,
      recursiveScanning: false,
      risuMatching: true,
    });
  });

  it('knows a V2 card from RisuAI through the lift to V3', () => {
    // RisuAI's PNG export is V2. This book names a depth and a budget but no
    // recursion, which RisuAI reads as no settings at all: recursion on.
    const v2 = {
      ...v2Card,
      data: {
        ...v2Card.data,
        extensions: { risuai: { bias: [] } },
        character_book: { ...v2Card.data.character_book, extensions: { risu_fullWordMatching: false } },
      },
    };
    expect(normalizeCard(v2).spec).toBe('v2');
    expect(normalizeCard(v2).loreSettings).toEqual({
      scanDepth: 2,
      tokenBudget: 512,
      recursiveScanning: true,
      risuMatching: true,
    });
    // The older kind, known by its block alone.
    const older = { ...v2, data: { ...v2.data, character_book: { ...v2.data.character_book, extensions: {} } } };
    expect(normalizeCard(older).loreSettings.risuMatching).toBe(true);
  });

  it('reads recursion as on when the card names it without the other two, as RisuAI does', () => {
    expect(normalizeCard(risuCard({ recursive_scanning: false })).loreSettings.recursiveScanning).toBe(true);
  });

  it('knows an older RisuAI card by its extension block when its entries are RisuAI-made', () => {
    const older = risuCard({ extensions: {} });
    expect(normalizeCard(older).loreSettings.risuMatching).toBe(true);
    // Without the block, it is anyone's card.
    const anyone = { ...older, data: { ...older.data, extensions: {} } };
    expect(normalizeCard(anyone).loreSettings).toEqual({ scanDepth: 4, recursiveScanning: false });
  });

  it('does not take a book SillyTavern or our export rewrote for a RisuAI one', () => {
    // ST keeps the risuai block of a card it got from RisuAI, but writes every entry its own way.
    const viaSillyTavern = stCard();
    (viaSillyTavern.data.extensions as Record<string, unknown>)['risuai'] = { bias: [] };
    expect(normalizeCard(viaSillyTavern).loreSettings.risuMatching).toBeUndefined();
    expect(normalizeCard(stCard()).loreSettings.risuMatching).toBeUndefined();

    // Our export writes a risuai block for display scripts, and ST's entry fields.
    const exported = exportCardV3({
      ...normalizeCard(v3Card),
      displayScripts: [{ in: 'a', out: 'b', order: 0, enabled: true }],
    });
    expect((exported.data.extensions as Record<string, unknown>)['risuai']).toBeDefined();
    expect(normalizeCard(exported).loreSettings.risuMatching).toBeUndefined();
  });

  it("leaves a book that asked for RisuAI's whole-word matching to exact matching", () => {
    const whole = normalizeCard(risuCard({ extensions: { risu_fullWordMatching: true } }));
    expect(whole.loreSettings.risuMatching).toBeUndefined();
    expect(whole.loreSettings.recursiveScanning).toBe(true);
  });

  it('matches its keys without regard to spaces or case once in a prompt', () => {
    const card = normalizeCard(
      risuCard({
        entries: [
          {
            keys: ['마왕 성'],
            content: '마왕성은 북쪽 끝에 있다.',
            extensions: {},
            enabled: true,
            insertion_order: 100,
            use_regex: false,
            constant: false,
            case_sensitive: true,
          },
        ],
      }),
    );
    const { messages } = assemblePrompt({
      plot: { name: '이야기', description: '', lorebook: [] },
      characters: [{ name: card.name, card }],
      history: [{ role: 'user', content: '마왕성으로 간다' }],
    });
    // A keyword entry goes right after the newest turn (the moved lore).
    expect(messages[1]).toEqual({ role: 'system', content: '마왕성은 북쪽 끝에 있다.' });
  });
});
