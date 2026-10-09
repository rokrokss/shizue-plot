import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { exportCardV3 } from '../src/card/export.js';
import { CardParseError, normalizeCard, parseDecorators } from '../src/card/normalize.js';
import { parseCard } from '../src/card/parse.js';
import { MAX_INTRO_LENGTH } from '../src/card/intro.js';
import { readPngTextChunks, stripPngTextChunks } from '../src/card/png.js';
import { assemblePrompt } from '../src/prompt.js';
import { v1Card, v2Card, v3Card } from './fixtures/cards.js';
import { buildPngWithTextChunks } from './helpers/png.js';

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
        '@@activate_only_after 3\n@@@depth 2\n@@depth abc\n@@role narrator\n@@position personality\n본문',
      ),
    ).toEqual({ decorators: {}, body: '본문' });
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

    // @@constant + @@position override the card fields; @@activate_only_after is
    // unsupported, so it is stripped without effect.
    expect(card.lorebook[1]!.content).toBe('주막은 국경 검문소 옆이다.');
    expect(card.lorebook[1]!.constant).toBe(true);
    expect(card.lorebook[1]!.position).toBe('after_char');
    expect(card.lorebook[1]!.depth).toBeUndefined();
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
});
