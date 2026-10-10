import { strToU8, Zip, ZipDeflate, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  convertSillyTavernChat,
  FileTooLargeError,
  listZip,
  MAX_CHAT_MESSAGES,
  parseSillyTavernDate,
  readZipEntry,
  regexScriptsToDisplayScripts,
  scanSillyTavern,
  stFilesFromFolder,
  stFilesFromZip,
  ZipError,
  type StCast,
  type StFile,
  type ZipSource,
} from '../src/sillytavern/index.js';
import { buildPngWithTextChunks } from './helpers/png.js';

/* ------------------------------------------------------------- builders */

/** Ranged reads over bytes in memory. */
const sourceOf = (bytes: Uint8Array): ZipSource => ({
  size: bytes.length,
  read: async (offset, length) => bytes.subarray(offset, offset + length),
});

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const json = (value: unknown): Uint8Array => strToU8(JSON.stringify(value));
const jsonl = (lines: unknown[]): string => lines.map((line) => JSON.stringify(line)).join('\n');

/** A character PNG the way ST writes one: the card as base64 JSON in `chara` (and `ccv3`). */
function cardPng(data: Record<string, unknown>, keyword: 'chara' | 'ccv3' = 'chara'): Uint8Array {
  const card = { spec: 'chara_card_v2', spec_version: '2.0', name: data['name'], data };
  return buildPngWithTextChunks({ [keyword]: Buffer.from(JSON.stringify(card)).toString('base64') });
}

/** fflate's streaming writer, which — like ST's archiver — writes data descriptors. */
function streamedZip(files: Record<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    parts.push(chunk);
  });
  for (const [name, bytes] of Object.entries(files)) {
    const file = new ZipDeflate(name, { level: 6 });
    zip.add(file);
    file.push(bytes, true);
  }
  zip.end();
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * A stored archive with every size and offset moved into ZIP64 records, as a
 * >4 GiB backup has them (fflate does not write ZIP64). CRCs are left 0 — the
 * reader does not check them.
 */
function zip64Archive(files: Record<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u64 = (view: DataView, at: number, value: number): void => {
    view.setUint32(at, value % 0x1_0000_0000, true);
    view.setUint32(at + 4, Math.floor(value / 0x1_0000_0000), true);
  };
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = strToU8(name);
    const local = new Uint8Array(30 + nameBytes.length + 20);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 45, true);
    lv.setUint32(18, 0xffffffff, true);
    lv.setUint32(22, 0xffffffff, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 20, true);
    local.set(nameBytes, 30);
    lv.setUint16(30 + nameBytes.length, 0x0001, true);
    lv.setUint16(32 + nameBytes.length, 16, true);
    u64(lv, 34 + nameBytes.length, data.length);
    u64(lv, 42 + nameBytes.length, data.length);

    const entry = new Uint8Array(46 + nameBytes.length + 28);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 45, true);
    cv.setUint16(6, 45, true);
    cv.setUint32(20, 0xffffffff, true);
    cv.setUint32(24, 0xffffffff, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 28, true);
    cv.setUint32(42, 0xffffffff, true);
    entry.set(nameBytes, 46);
    cv.setUint16(46 + nameBytes.length, 0x0001, true);
    cv.setUint16(48 + nameBytes.length, 24, true);
    u64(cv, 50 + nameBytes.length, data.length);
    u64(cv, 58 + nameBytes.length, data.length);
    u64(cv, 66 + nameBytes.length, offset);
    central.push(entry);

    parts.push(local, data);
    offset += local.length + data.length;
  }
  const directory = concat(central);
  const directoryOffset = offset;

  const record = new Uint8Array(56);
  const rv = new DataView(record.buffer);
  rv.setUint32(0, 0x06064b50, true);
  u64(rv, 4, 44);
  rv.setUint16(12, 45, true);
  rv.setUint16(14, 45, true);
  u64(rv, 24, central.length);
  u64(rv, 32, central.length);
  u64(rv, 40, directory.length);
  u64(rv, 48, directoryOffset);

  const locator = new Uint8Array(20);
  const lv = new DataView(locator.buffer);
  lv.setUint32(0, 0x07064b50, true);
  u64(lv, 8, directoryOffset + directory.length);
  lv.setUint32(16, 1, true);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 0xffff, true);
  ev.setUint16(10, 0xffff, true);
  ev.setUint32(12, 0xffffffff, true);
  ev.setUint32(16, 0xffffffff, true);

  return concat([...parts, directory, record, locator, end]);
}

/* ----------------------------------------------------------------- zip */

describe('listZip / readZipEntry', () => {
  it('reads stored and deflated entries by their central directory', async () => {
    const archive = zipSync({
      'stored.txt': [strToU8('그대로'), { level: 0 }],
      'chats/하루/첫 대화.jsonl': strToU8('{"a":1}\n'.repeat(500)),
    } satisfies Zippable);
    const source = sourceOf(archive);
    const entries = await listZip(source);
    expect(entries.map((entry) => [entry.name, entry.method])).toEqual([
      ['stored.txt', 0],
      ['chats/하루/첫 대화.jsonl', 8],
    ]);
    expect(text(await readZipEntry(source, entries[0]!, { maxBytes: 1024 }))).toBe('그대로');
    expect(text(await readZipEntry(source, entries[1]!, { maxBytes: 1 << 20 }))).toBe('{"a":1}\n'.repeat(500));
  });

  it('finds the end record behind an archive comment', async () => {
    const plain = zipSync({ 'a.txt': strToU8('a') });
    // fflate writes no archive comment, so one goes on by hand — signature and all.
    const comment = strToU8('PK\u0005\u0006 is not a record here');
    const archive = concat([plain, comment]);
    new DataView(archive.buffer).setUint16(plain.length - 2, comment.length, true);
    const entries = await listZip(sourceOf(archive));
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt']);
  });

  it('trusts the central directory for entries written with data descriptors', async () => {
    const png = cardPng({ name: '하루' });
    const archive = streamedZip({ 'characters/하루.png': png, 'settings.json': json({ a: 1 }) });
    // General-purpose flag bit 3: sizes follow the data, the local header says 0.
    expect(new DataView(archive.buffer).getUint16(6, true) & 8).toBe(8);
    expect(new DataView(archive.buffer).getUint32(22, true)).toBe(0);

    const source = sourceOf(archive);
    const entries = await listZip(source);
    expect(entries[0]).toMatchObject({ name: 'characters/하루.png', size: png.length });
    expect(await readZipEntry(source, entries[0]!, { maxBytes: 1 << 20 })).toEqual(png);
  });

  it('reads ZIP64 sizes and offsets', async () => {
    const archive = zip64Archive({ 'settings.json': json({ big: true }), 'worlds/세계.json': json({ entries: {} }) });
    const source = sourceOf(archive);
    const entries = await listZip(source);
    expect(entries.map(({ name, size, method }) => ({ name, size, method }))).toEqual([
      { name: 'settings.json', size: 12, method: 0 },
      { name: 'worlds/세계.json', size: 14, method: 0 },
    ]);
    expect(text(await readZipEntry(source, entries[1]!, { maxBytes: 100 }))).toBe('{"entries":{}}');
  });

  it('caps what the inflater emits, not what the header declares', async () => {
    const archive = zipSync({ 'chats/a/bomb.jsonl': new Uint8Array(4 << 20) });
    const source = sourceOf(archive);
    const [entry] = await listZip(source);
    // The header's own claim is not what stops it.
    const understated = { ...entry!, size: 10 };
    await expect(readZipEntry(source, understated, { maxBytes: 64 * 1024 })).rejects.toBeInstanceOf(FileTooLargeError);

    const stored = zipSync({ 'a.txt': [new Uint8Array(2048), { level: 0 }] } satisfies Zippable);
    const storedSource = sourceOf(stored);
    const [storedEntry] = await listZip(storedSource);
    await expect(readZipEntry(storedSource, storedEntry!, { maxBytes: 1024 })).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('refuses what is not a ZIP archive, and entries pointing outside it', async () => {
    await expect(listZip(sourceOf(strToU8('not a zip at all, just some text')))).rejects.toBeInstanceOf(ZipError);
    const source = sourceOf(zipSync({ 'a.txt': strToU8('a') }));
    const [entry] = await listZip(source);
    await expect(readZipEntry(source, { ...entry!, localHeaderOffset: 1 << 20 }, { maxBytes: 10 })).rejects.toBeInstanceOf(
      ZipError,
    );
  });
});

/* --------------------------------------------------------------- files */

describe('stFilesFromZip / stFilesFromFolder', () => {
  const backup = {
    'settings.json': json({}),
    'secrets.json': json({ api_key_openai: 'sk-test' }),
    'characters/하루.png': cardPng({ name: '하루' }),
    'characters/readme.txt': strToU8('x'),
    'chats/하루/a.jsonl': strToU8('{}'),
    'chats/하루/deeper/b.jsonl': strToU8('{}'),
    'group chats/1700000000000.jsonl': strToU8('{}'),
    'groups/1700000000000.json': json({}),
    'worlds/세계.json': json({ entries: {} }),
    'thumbnails/avatar/하루.png': strToU8('x'),
    'backups/chat_하루_20240101.jsonl': strToU8('{}'),
    'User Avatars/user-default.png': strToU8('x'),
  };
  const allowlisted = [
    'characters/하루.png',
    'chats/하루/a.jsonl',
    'group chats/1700000000000.jsonl',
    'groups/1700000000000.json',
    'settings.json',
    'worlds/세계.json',
  ];

  it('keeps only the allowlisted paths of a backup with the user directory at its root', async () => {
    const source = sourceOf(zipSync(backup));
    const files = stFilesFromZip(source, await listZip(source));
    expect(files.map((file) => file.path).sort()).toEqual(allowlisted);
  });

  it('tolerates a wrapping folder, and rebases paths onto the user directory', async () => {
    const wrapped = Object.fromEntries(Object.entries(backup).map(([path, bytes]) => [`default-user/${path}`, bytes]));
    const source = sourceOf(zipSync({ ...wrapped, 'default-user/': new Uint8Array(0) }));
    const files = stFilesFromZip(source, await listZip(source));
    expect(files.map((file) => file.path).sort()).toEqual(allowlisted);
    const world = files.find((file) => file.path === 'worlds/세계.json')!;
    expect(text(await world.read())).toBe('{"entries":{}}');
  });

  it('applies the per-kind cap to reads', async () => {
    const source = sourceOf(zipSync({ 'worlds/큰.json': new Uint8Array(4096), 'characters/a.png': new Uint8Array(1) }));
    const [world] = stFilesFromZip(source, await listZip(source), { world: 1024 }).filter((file) =>
      file.path.startsWith('worlds/'),
    );
    await expect(world!.read()).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('finds the root of a picked folder, at any of the depths a picker starts from', async () => {
    const pick = (prefix: string) =>
      Object.entries(backup).map(([path, bytes]) => ({
        relativePath: `${prefix}${path}`,
        size: bytes.length,
        read: async () => bytes,
      }));
    for (const prefix of ['default-user/', 'data/default-user/', 'SillyTavern/data/default-user/', 'SillyTavern/public/']) {
      expect(stFilesFromFolder(pick(prefix)).map((file) => file.path).sort()).toEqual(allowlisted);
    }
    // The user directory with the most characters wins over a stray one.
    const stray = { relativePath: 'data/other/characters/x.png', size: 1, read: async () => new Uint8Array(1) };
    expect(stFilesFromFolder([...pick('data/default-user/'), stray]).map((file) => file.path)).toContain('chats/하루/a.jsonl');
    expect(stFilesFromFolder([{ relativePath: 'photos/cat.png', size: 1, read: async () => new Uint8Array(1) }])).toEqual([]);
  });

  it('refuses a picked file over its cap before reading it', async () => {
    let reads = 0;
    const [file] = stFilesFromFolder(
      [{ relativePath: 'u/characters/a.png', size: 10, read: async () => (reads++, new Uint8Array(10)) }],
      { character: 5 },
    );
    await expect(file!.read()).rejects.toBeInstanceOf(FileTooLargeError);
    expect(reads).toBe(0);
  });
});

/* ---------------------------------------------------------------- scan */

const FAKE_PROXY_PASSWORD = 'proxy-pw-must-never-surface';

function syntheticBackup(): Record<string, Uint8Array> {
  return {
    'settings.json': json({
      username: 'unused-in-import',
      oai_settings: { proxy_password: FAKE_PROXY_PASSWORD, reverse_proxy: 'https://proxy.invalid' },
      power_user: {
        personas: { 'user-default.png': '여행자', '1700000000-Mina.png': ' 미나 ', 'nameless.png': '' },
        persona_descriptions: {
          'user-default.png': { description: '길을 잃은 여행자.', position: 0, depth: 2, role: 0 },
          'orphan.png': { description: '이름 없는 설명' },
        },
      },
      world_info_settings: {
        world_info: {
          globalSelect: ['공용 설정', '없는 세계'],
          // Keyed by the avatar without its extension (getCharaFilename).
          charLore: [{ name: '하루', extraBooks: ['하루의 비밀', '하루의 세계'] }],
        },
        world_info_depth: 2,
      },
      extension_settings: {
        regex: [
          { scriptName: 'bold', findRegex: '/\\*\\*(.+?)\\*\\*/g', replaceString: '<b>$1</b>', placement: [2], markdownOnly: true },
          { scriptName: 'prompt', findRegex: 'x', replaceString: 'y', placement: [1], promptOnly: true },
        ],
        caption: { api_key: FAKE_PROXY_PASSWORD },
      },
    }),
    'secrets.json': json({ api_key_openai: FAKE_PROXY_PASSWORD }),
    'characters/하루.png': cardPng({ name: '하루', extensions: { world: '하루의 세계' } }),
    'characters/Ren.png': cardPng({ name: 'Ren', extensions: {} }, 'ccv3'),
    'characters/broken.png': buildPngWithTextChunks({ Comment: 'just a picture' }),
    'chats/하루/하루 - 2024-06-05@14h56m50s682ms.jsonl': strToU8(jsonl([{ chat_metadata: {} }])),
    'chats/하루/하루 - 2024-01-01@00h00m00s000ms.jsonl': strToU8(jsonl([{ chat_metadata: {} }])),
    'chats/Ren/Ren - 1.jsonl': strToU8(jsonl([{ chat_metadata: {} }])),
    'chats/지워진 캐릭터/old.jsonl': strToU8('{}'),
    'groups/1700000000000.json': json({
      id: '1700000000000',
      name: '모험대',
      members: ['하루.png', 'Ren.png'],
      chats: ['1700000000000', '2024-6-5 @14h 56m 50s 682ms'],
      chat_id: '1700000000000',
    }),
    'groups/bad.json': strToU8('{not json'),
    'group chats/1700000000000.jsonl': strToU8('{}'),
    'group chats/2024-6-5 @14h 56m 50s 682ms.jsonl': strToU8('{}'),
    'group chats/stray.jsonl': strToU8('{}'),
    'worlds/하루의 세계.json': json({ entries: {} }),
    'worlds/하루의 비밀.json': json({ entries: {} }),
    'worlds/공용 설정.json': json({ entries: {} }),
  };
}

describe('scanSillyTavern', () => {
  it('lists characters with their chats and worlds, groups, personas and the global settings', async () => {
    const source = sourceOf(zipSync(syntheticBackup()));
    const manifest = await scanSillyTavern(stFilesFromZip(source, await listZip(source)));

    expect(
      manifest.characters.map(({ avatar, name, worldName, extraWorlds, chats }) => ({
        avatar,
        name,
        worldName,
        extraWorlds,
        chats: chats.map((chat) => chat.name),
      })),
    ).toEqual([
      { avatar: 'Ren.png', name: 'Ren', worldName: undefined, extraWorlds: [], chats: ['Ren - 1'] },
      {
        avatar: '하루.png',
        name: '하루',
        worldName: '하루의 세계',
        // The linked world is not repeated among the extra books.
        extraWorlds: ['하루의 비밀'],
        chats: ['하루 - 2024-01-01@00h00m00s000ms', '하루 - 2024-06-05@14h56m50s682ms'],
      },
    ]);
    expect(manifest.characters[1]!.file.path).toBe('characters/하루.png');

    expect(manifest.groups).toHaveLength(1);
    expect(manifest.groups[0]).toMatchObject({ id: '1700000000000', name: '모험대', members: ['하루.png', 'Ren.png'] });
    expect(manifest.groups[0]!.chats.map((chat) => chat.file.path)).toEqual([
      'group chats/1700000000000.jsonl',
      'group chats/2024-6-5 @14h 56m 50s 682ms.jsonl',
    ]);

    expect(manifest.personas).toEqual([
      { avatar: 'user-default.png', name: '여행자', description: '길을 잃은 여행자.' },
      { avatar: '1700000000-Mina.png', name: '미나', description: '' },
    ]);
    expect(Object.keys(manifest.worlds).sort()).toEqual(['공용 설정', '하루의 비밀', '하루의 세계']);
    expect(manifest.globalWorlds).toEqual(['공용 설정', '없는 세계']);
    expect(manifest.globalRegex).toHaveLength(2);
    expect(regexScriptsToDisplayScripts(manifest.globalRegex)).toEqual([
      { in: '\\*\\*(.+?)\\*\\*', out: '<b>$1</b>', flags: 'g', order: 0, enabled: true },
    ]);

    expect(manifest.skipped).toEqual(
      expect.arrayContaining([
        { path: 'characters/broken.png', reason: 'not_a_card' },
        { path: 'chats/지워진 캐릭터/old.jsonl', reason: 'no_character' },
        { path: 'groups/bad.json', reason: 'invalid_json' },
        { path: 'group chats/stray.jsonl', reason: 'no_group' },
        { path: 'worlds/없는 세계.json', reason: 'missing' },
      ]),
    );
    expect(manifest.skipped).toHaveLength(5);
  });

  it('never surfaces settings.json or secrets.json content', async () => {
    const source = sourceOf(zipSync(syntheticBackup()));
    const files = stFilesFromZip(source, await listZip(source));
    expect(files.map((file) => file.path)).not.toContain('secrets.json');
    const manifest = await scanSillyTavern(files);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(FAKE_PROXY_PASSWORD);
    expect(serialized).not.toContain('proxy.invalid');
    expect(serialized).not.toContain('unused-in-import');
    // No file the manifest offers for upload is settings.json.
    const offered: StFile[] = [
      ...manifest.characters.flatMap((character) => [character.file, ...character.chats.map((chat) => chat.file)]),
      ...manifest.groups.flatMap((group) => group.chats.map((chat) => chat.file)),
      ...Object.values(manifest.worlds),
    ];
    expect(offered.map((file) => file.path)).not.toContain('settings.json');
  });

  it('reads legacy top-level world_info and charLore keyed by the full avatar name', async () => {
    const files: StFile[] = [
      { path: 'settings.json', size: 1, read: async () => json({ world_info: { globalSelect: ['g'], charLore: [{ name: 'a.png', extraBooks: ['x'] }] } }) },
      { path: 'characters/a.png', size: 1, read: async () => cardPng({ name: 'A' }) },
    ];
    const manifest = await scanSillyTavern(files);
    expect(manifest.globalWorlds).toEqual(['g']);
    expect(manifest.characters[0]!.extraWorlds).toEqual(['x']);
  });

  it('skips oversized and unreadable files without failing', async () => {
    const files: StFile[] = [
      { path: 'characters/huge.png', size: 10, read: async () => cardPng({ name: 'H' }) },
      { path: 'characters/lying.png', size: 1, read: async () => Promise.reject(new FileTooLargeError('lying.png', 5)) },
      { path: 'characters/io.png', size: 1, read: async () => Promise.reject(new Error('disk')) },
      { path: 'chats/huge/a.jsonl', size: 10, read: async () => new Uint8Array(0) },
      { path: 'settings.json', size: 1, read: async () => strToU8('not json') },
    ];
    const manifest = await scanSillyTavern(files, { character: 5, chat: 5 });
    expect(manifest.characters).toEqual([]);
    expect(manifest.skipped).toEqual([
      { path: 'settings.json', reason: 'invalid_json' },
      { path: 'chats/huge/a.jsonl', reason: 'too_large' },
      { path: 'characters/huge.png', reason: 'too_large' },
      { path: 'characters/lying.png', reason: 'too_large' },
      { path: 'characters/io.png', reason: 'unreadable' },
    ]);
  });
});

/* ---------------------------------------------------------------- chat */

const solo: StCast = { members: [{ name: '하루', avatar: '하루.png' }] };
const party: StCast = {
  members: [
    { name: '하루', avatar: '하루.png' },
    { name: 'Ren', avatar: 'Ren.png' },
  ],
};

describe('convertSillyTavernChat', () => {
  it('converts turns into the speech protocol, with swipes as versions', () => {
    const chat = convertSillyTavernChat(
      jsonl([
        { user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: 'x' } },
        {
          name: '하루',
          is_user: false,
          is_system: false,
          send_date: '2024-06-05T14:56:50.682Z',
          mes: '*손을 흔든다*\n\n안녕!',
          swipes: ['*손을 흔든다*\n\n안녕!', '하루: 어서 와.'],
          swipe_id: 0,
        },
        { name: '여행자', is_user: true, is_system: false, send_date: 1717599410682, mes: '하루: 이건 내 말이야' },
        { name: '하루', is_user: false, mes: '좋아.', swipes: ['첫째', '', '좋아.'], swipe_id: 2, send_date: 'garbage' },
      ]),
      solo,
    );
    expect(chat).toEqual({
      userName: '여행자',
      characterName: '하루',
      messages: [
        {
          role: 'assistant',
          versions: ['하루: *손을 흔든다*\n\n하루: 안녕!', '하루: 어서 와.'],
          selected: 0,
          createdAt: '2024-06-05T14:56:50.682Z',
        },
        // A user turn is the user's, whatever it looks like.
        { role: 'user', versions: ['하루: 이건 내 말이야'], selected: 0, createdAt: '2024-06-05T14:56:50.682Z' },
        // The blank swipe is dropped and the selection follows the one it pointed at.
        { role: 'assistant', versions: ['하루: 첫째', '하루: 좋아.'], selected: 1 },
      ],
      skipped: { hidden: 0, empty: 0, unknownSpeaker: 0, malformed: 0, overLimit: 0 },
    });
  });

  it('keeps the narrator unprefixed, skips hidden messages and counts what it could not use', () => {
    const bom = String.fromCharCode(0xfeff);
    const chat = convertSillyTavernChat(
      bom +
      [
        JSON.stringify({ user_name: '여행자', character_name: '하루', create_date: '2024-6-5 @14h 56m 50s 682ms', chat_metadata: {} }),
        JSON.stringify({ name: 'System', is_user: false, is_system: true, mes: '해가 진다.', extra: { type: 'narrator' } }),
        JSON.stringify({ name: '하루', is_user: false, is_system: true, mes: '숨긴 말' }),
        JSON.stringify({ name: 'Note', is_user: false, is_system: true, mes: '메모', extra: { type: 'comment' } }),
        '{"name": "하루", "mes": "잘린 줄',
        '[1, 2]',
        JSON.stringify({ name: '하루', is_user: false, mes: '   ', swipes: ['', ' '] }),
        '',
        JSON.stringify({ name: '하루', is_user: false, mes: '하루: 이미 붙어 있다\n하루:붙어 있다\n둘째 줄' }),
      ].join('\r\n'),
      solo,
    );
    expect(chat.userName).toBe('여행자');
    expect(chat.characterName).toBe('하루');
    expect(chat.createdAt).toBe('2024-06-05T14:56:50.682Z');
    expect(chat.messages).toEqual([
      { role: 'assistant', versions: ['해가 진다.'], selected: 0 },
      { role: 'assistant', versions: ['하루: 이미 붙어 있다\n하루:붙어 있다\n하루: 둘째 줄'], selected: 0 },
    ]);
    expect(chat.skipped).toEqual({ hidden: 2, empty: 1, unknownSpeaker: 0, malformed: 2, overLimit: 0 });
  });

  it('attributes group turns by avatar, then by name, and counts a speaker it cannot place', () => {
    const chat = convertSillyTavernChat(
      jsonl([
        // An old group chat: no header line.
        { name: '하루 (old name)', is_user: false, mes: '안녕', original_avatar: '하루.png' },
        { name: 'Ren', is_user: false, mes: '반가워' },
        { name: 'Stranger', is_user: false, mes: '누구?' },
      ]),
      party,
    );
    expect(chat.messages.map((message) => message.versions[0])).toEqual(['하루: 안녕', 'Ren: 반가워', '누구?']);
    expect(chat.characterName).toBe('하루 (old name)');
    expect(chat.skipped.unknownSpeaker).toBe(1);
  });

  it('caps the messages it converts', () => {
    const lines = Array.from({ length: MAX_CHAT_MESSAGES + 3 }, (_, i) => ({ name: '여행자', is_user: true, mes: `${i}` }));
    const chat = convertSillyTavernChat(jsonl([{ chat_metadata: {} }, ...lines]), solo);
    expect(chat.messages).toHaveLength(MAX_CHAT_MESSAGES);
    expect(chat.skipped.overLimit).toBe(3);
  });
});

describe('parseSillyTavernDate', () => {
  it('reads every shape ST has written a time in', () => {
    expect(parseSillyTavernDate('2024-06-05T14:56:50.682Z')).toBe('2024-06-05T14:56:50.682Z');
    expect(parseSillyTavernDate(1717599410682)).toBe('2024-06-05T14:56:50.682Z');
    expect(parseSillyTavernDate('1717599410682')).toBe('2024-06-05T14:56:50.682Z');
    expect(parseSillyTavernDate('June 19, 2023 2:20pm')).toBe('2023-06-19T14:20:00.000Z');
    expect(parseSillyTavernDate('December 1, 2023 12:05am')).toBe('2023-12-01T00:05:00.000Z');
    expect(parseSillyTavernDate('2024-07-12@01h31m37s123ms')).toBe('2024-07-12T01:31:37.123Z');
    expect(parseSillyTavernDate('2024-7-12@01h31m37s')).toBe('2024-07-12T01:31:37.000Z');
    expect(parseSillyTavernDate('2024-6-5 @14h 56m 50s 682ms')).toBe('2024-06-05T14:56:50.682Z');
  });

  it('gives up on anything else', () => {
    for (const value of ['', 'yesterday', '2024-13-01@00h00m00s', 'Smarch 1, 2023 1:00pm', -1, null, {}, NaN]) {
      expect(parseSillyTavernDate(value)).toBeUndefined();
    }
  });
});
