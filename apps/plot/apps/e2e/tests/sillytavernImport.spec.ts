import { crc32, deflateSync } from 'node:zlib';
import { seedSession } from '../seedSession.js';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The SillyTavern move along the owner's path: a backup zip built here — two
 * characters (one with a linked World Info file, an extra lorebook and a chat
 * with swipes, a narrator line and a hidden line), a group of both with a group
 * chat, a persona, and a settings.json holding a proxy password beside a
 * secrets.json — goes through the wizard; the plots, members, lorebooks, chats
 * and persona it makes are read back; no request the page made carries anything
 * of settings.json or secrets.json; and a second pass over the same zip finds
 * everything already imported.
 *
 * The steps build on each other, so the file runs serially, and what it made is
 * deleted at the end, because this hits the dev database.
 */
test.describe.configure({ mode: 'serial' });

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const owner = {
  email: `st-import-${run}@example.test`,
  password: 'e2e-password-1234',
  name: `이사하는 사람 ${run}`,
};
const origin = process.env['E2E_WEB_URL'] ?? 'http://localhost:13000';

/** What must never leave the browser. */
const PROXY_PASSWORD = `proxy-pass-${run}`;
const API_KEY = `sk-secret-${run}`;
const BACKGROUND = `BACKGROUND-BYTES-${run}`;

const persona = `여행자${run}`;
const alice = '앨리스';
const bob = '밥';
const group = '다과회';

// ── a SillyTavern backup, by hand ───────────────────────────────────────────

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A one-pixel PNG carrying the card the way ST writes it: base64 JSON in `chara`. */
function cardPng(data: Record<string, unknown>): Buffer {
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(card)).toString('base64'), 'latin1')])),
    chunk('IDAT', deflateSync(Buffer.from([0, 0x32, 0xcc, 0xbc, 0xff]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A stored (uncompressed) zip with UTF-8 names — what the reader needs, and nothing more. */
function storedZip(files: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const card = (name: string, extensions: Record<string, unknown>, book?: unknown) => ({
  name,
  description: `${name}의 설정 ${run}`,
  personality: '',
  scenario: '',
  first_mes: `${name}: 어서 와요.`,
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  tags: [],
  creator: '',
  character_version: '1.0',
  extensions,
  ...(book ? { character_book: book } : {}),
});

const jsonl = (lines: unknown[]): string => lines.map((line) => JSON.stringify(line)).join('\n');
const at = (minute: number): string => `2024-05-01T12:${String(minute).padStart(2, '0')}:00.000Z`;

const backup = storedZip({
  'settings.json': JSON.stringify({
    power_user: {
      personas: { 'traveler.png': persona },
      persona_descriptions: { 'traveler.png': { description: '길을 잃은 여행자', position: 0 } },
      default_persona: 'traveler.png',
    },
    world_info_settings: { world_info: { globalSelect: [], charLore: [{ name: 'Alice', extraBooks: ['Tea'] }] } },
    oai_settings: { reverse_proxy: 'https://proxy.example.test/v1', proxy_password: PROXY_PASSWORD },
    extension_settings: { regex: [] },
  }),
  'secrets.json': JSON.stringify({ api_key_openai: API_KEY }),
  'characters/Alice.png': cardPng(
    card(alice, { world: 'Wonderland' }, {
      entries: [{ keys: ['stale'], content: 'stale embedded entry', enabled: true, insertion_order: 0, extensions: {} }],
    }),
  ),
  'characters/Bob.png': cardPng(card(bob, {})),
  'worlds/Wonderland.json': JSON.stringify({
    entries: { 0: { uid: 0, key: ['rabbit'], keysecondary: [], content: 'The white rabbit is late.', order: 100, position: 0, disable: false } },
  }),
  'worlds/Tea.json': JSON.stringify({
    entries: { 0: { uid: 0, key: ['tea'], keysecondary: [], content: 'Tea is always at six.', order: 100, position: 0, disable: false } },
  }),
  'chats/Alice/Alice - 2024-05-01@12h00m00s.jsonl': jsonl([
    { user_name: persona, character_name: alice, create_date: '2024-05-01@12h00m00s', chat_metadata: {} },
    { name: persona, is_user: true, is_system: false, send_date: at(1), mes: '안녕하세요' },
    { name: alice, is_user: false, is_system: false, send_date: at(2), mes: '첫 번째 대답', swipes: ['첫 번째 대답', '두 번째 대답'], swipe_id: 0 },
    { name: 'System', is_user: false, is_system: true, send_date: at(3), mes: '시계가 여섯 시를 친다.', extra: { type: 'narrator' } },
    { name: alice, is_user: false, is_system: true, send_date: at(4), mes: '숨겨진 줄' },
    { name: persona, is_user: true, is_system: false, send_date: at(5), mes: '차 마실래요?' },
    { name: alice, is_user: false, is_system: false, send_date: at(6), mes: '좋아요.' },
  ]),
  'groups/1714564800000.json': JSON.stringify({
    id: '1714564800000',
    name: group,
    members: ['Alice.png', 'Bob.png'],
    chats: ['party'],
    chat_id: 'party',
  }),
  'group chats/party.jsonl': jsonl([
    { user_name: 'unused', character_name: 'unused', chat_metadata: {} },
    { name: persona, is_user: true, is_system: false, send_date: at(10), mes: '모두 모였네요.' },
    { name: alice, is_user: false, is_system: false, send_date: at(11), mes: '차가 식기 전에 마셔요.', original_avatar: 'Alice.png' },
    { name: bob, is_user: false, is_system: false, send_date: at(12), mes: '저는 커피가 좋은데요.', original_avatar: 'Bob.png' },
  ]),
  'backgrounds/beach.jpg': BACKGROUND,
  'thumbnails/avatar/Alice.png': BACKGROUND,
});

// ── the run ─────────────────────────────────────────────────────────────────

interface PlotRow {
  id: string;
  name: string;
  visibility: string;
}
interface Member {
  name: string;
  card: { lorebook: { content: string }[] };
  importedFrom: { fileName: string } | null;
}
interface ChatRow {
  id: string;
  plotId: string;
  personaId: string | null;
  importing?: boolean;
}
interface ChatState {
  chat: ChatRow;
  path: { id: string; content: string }[];
  siblings: Record<string, { total: number }>;
}

let context: BrowserContext;
let page: Page;
/** Every request body the page sent, for the privacy check. */
const bodies: { url: string; body: Buffer }[] = [];
let plots: PlotRow[] = [];

const api = async <T>(path: string): Promise<T> => {
  const response = await page.request.get(`${origin}${path}`);
  expect(response.ok(), path).toBe(true);
  return (await response.json()) as T;
};

const plotNamed = (name: string): PlotRow => {
  const plot = plots.find((each) => each.name === name);
  expect(plot, name).toBeDefined();
  return plot!;
};

async function pickBackup(): Promise<void> {
  await page.goto('/ko/plots');
  await page.getByTestId('plot-st-import').click();
  await expect(page).toHaveURL(/\/ko\/plots\/import\/sillytavern$/);
  await page.getByTestId('st-zip-input').setInputFiles({
    name: 'default-user.zip',
    mimeType: 'application/zip',
    buffer: backup,
  });
  await expect(page.getByTestId('st-review')).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('request', (request) => {
    const body = request.postDataBuffer();
    if (body) bodies.push({ url: request.url(), body });
  });
});

test.afterAll(async () => {
  await context.close();
});

test('the wizard reads the backup and lists what it holds', async () => {
  await seedSession(page, owner);
  await pickBackup();

  await expect(page.getByTestId('st-character')).toHaveCount(2);
  await expect(page.getByTestId('st-group')).toHaveCount(1);
  await expect(page.getByTestId('st-persona')).toHaveCount(1);
  await expect(page.getByTestId('st-group')).toContainText(`${alice}, ${bob}`);
  await expect(page.getByTestId('st-character').filter({ hasText: alice })).toContainText('로어북 Wonderland');
  // The things that do not come over are named, not just left out.
  await page.getByTestId('st-not-imported').locator('summary').click();
  await expect(page.getByTestId('st-not-imported')).toContainText('퀵 리플라이');
  await expect(page.getByTestId('st-start')).toHaveText('6개 항목 가져오기');
});

test('the run brings over every chosen item', async () => {
  await page.getByTestId('st-start').click();
  const runPanel = page.getByTestId('st-run');
  // The way out stands only once the run has finished.
  await expect(runPanel.getByRole('link', { name: '내 플롯으로' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('st-step')).toHaveCount(6);
  await expect(page.locator('[data-testid="st-step"][data-status="done"]')).toHaveCount(6);
  await expect(runPanel.getByRole('link', { name: '플롯 열기' })).toHaveCount(3);
  await expect(runPanel.getByRole('link', { name: '대화 열기' })).toHaveCount(2);

  plots = await api<PlotRow[]>('/api/plots');
  expect(plots.map((plot) => plot.name).sort()).toEqual([alice, bob, group].sort());
  expect(plots.every((plot) => plot.visibility === 'private')).toBe(true);
});

test('the plots carry their cards, the linked world and the extra lorebook', async () => {
  const solo = await api<{ lorebook: { content: string }[]; characters: Member[] }>(`/api/plots/${plotNamed(alice).id}`);
  expect(solo.characters.map((member) => member.name)).toEqual([alice]);
  expect(solo.characters[0]!.importedFrom?.fileName).toBe('Alice.png');
  // The world file replaced the card's own, older book.
  const own = solo.characters[0]!.card.lorebook.map((entry) => entry.content);
  expect(own).toContain('The white rabbit is late.');
  expect(own).not.toContain('stale embedded entry');
  // The extra book ST linked in settings.json is the plot's.
  expect(solo.lorebook.map((entry) => entry.content)).toContain('Tea is always at six.');

  const party = await api<{ characters: Member[] }>(`/api/plots/${plotNamed(group).id}`);
  expect(party.characters.map((member) => member.name)).toEqual([alice, bob]);
});

test('the chats come over with their swipes, speakers and persona', async () => {
  const [made] = (await api<{ id: string; name: string; description: string }[]>('/api/personas')).filter(
    (each) => each.name === persona,
  );
  expect(made?.description).toBe('길을 잃은 여행자');

  const chats = await api<ChatRow[]>('/api/chats');
  const solo = chats.find((chat) => chat.plotId === plotNamed(alice).id)!;
  const party = chats.find((chat) => chat.plotId === plotNamed(group).id)!;
  expect(solo.importing).toBe(false);
  expect(solo.personaId).toBe(made!.id);
  expect(party.personaId).toBe(made!.id);

  const state = await api<ChatState>(`/api/chats/${solo.id}`);
  expect(state.path.map((message) => message.content)).toEqual([
    '안녕하세요',
    `${alice}: 첫 번째 대답`,
    '시계가 여섯 시를 친다.',
    '차 마실래요?',
    `${alice}: 좋아요.`,
  ]);
  // The other swipe is the reply's sibling.
  expect(state.siblings[state.path[1]!.id]?.total).toBe(2);

  const together = await api<ChatState>(`/api/chats/${party.id}`);
  expect(together.path.map((message) => message.content)).toEqual([
    '모두 모였네요.',
    `${alice}: 차가 식기 전에 마셔요.`,
    `${bob}: 저는 커피가 좋은데요.`,
  ]);

  await page.goto(`/ko/chats/${solo.id}`);
  await expect(page.locator(`[data-testid="speech-character"][data-speaker="${alice}"]`).first()).toBeVisible();
  await expect(page.getByTestId('speech-narration').filter({ hasText: '시계가 여섯 시를 친다.' })).toBeVisible();
  await expect(page.getByText('숨겨진 줄')).toHaveCount(0);
  await expect(page.getByTestId('chat-importing')).toHaveCount(0);
});

test('nothing of settings.json, secrets.json or the rest of the backup was sent', async () => {
  expect(bodies.length).toBeGreaterThan(0);
  for (const { url, body } of bodies) {
    const text = body.toString('latin1') + body.toString('utf8');
    for (const secret of [PROXY_PASSWORD, API_KEY, BACKGROUND, 'settings.json', 'secrets.json', 'proxy_password']) {
      expect(text.includes(secret), `${secret} in a request to ${url}`).toBe(false);
    }
  }
});

test('a second pass over the same backup finds everything already imported', async () => {
  await pickBackup();
  for (const testId of ['st-character', 'st-group', 'st-persona']) {
    const rows = page.getByTestId(testId);
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      await expect(rows.nth(index)).toHaveAttribute('data-imported', 'true');
    }
  }
  await expect(page.getByTestId('st-start')).toBeDisabled();
});

test('deleting what the run made cleans up after it', async () => {
  const headers = { origin };
  for (const plot of plots) {
    expect((await page.request.delete(`${origin}/api/plots/${plot.id}`, { headers })).ok()).toBe(true);
  }
  for (const each of await api<{ id: string; name: string }[]>('/api/personas')) {
    if (each.name === persona) {
      expect((await page.request.delete(`${origin}/api/personas/${each.id}`, { headers })).ok()).toBe(true);
    }
  }
});
