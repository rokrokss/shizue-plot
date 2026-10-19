// Seeds a fresh app with the demo works (demo/cards) and screenshots it into shots/.
// Start the app on an empty data folder in test mode first (docs/promo/README.md), then:
//   node docs/promo/capture.mjs [base]   (default http://localhost:13470)
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(dir, '../../apps/plot/apps/e2e/package.json'));
const { chromium } = require('@playwright/test');

const BASE = process.argv[2] ?? 'http://localhost:13470';
const cards = join(dir, 'demo/cards');
const shots = join(dir, 'shots');
mkdirSync(shots, { recursive: true });
const headers = { origin: BASE, 'content-type': 'application/json' };

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Imports a card file as the web app does: started, sent in parts, polled until done. */
async function importCard(file) {
  const buffer = readFileSync(join(cards, file));
  const { id, partSize, parts } = await api('POST', '/api/file-imports', { target: 'plot', fileName: file, size: buffer.length });
  const numbers = Array.from({ length: parts }, (_, i) => i + 1);
  const { urls } = await api('POST', `/api/file-imports/${id}/parts`, { numbers });
  for (const n of numbers) {
    const res = await fetch(`${BASE}${urls[n]}`, { method: 'PUT', headers: { origin: BASE }, body: buffer.subarray((n - 1) * partSize, n * partSize) });
    if (!res.ok) throw new Error(`part ${n}: ${res.status} ${await res.text()}`);
  }
  await api('POST', `/api/file-imports/${id}/complete`, {});
  for (;;) {
    const status = await api('GET', `/api/file-imports/${id}`);
    if (status.status === 'done') return status.result;
    if (status.status === 'failed') throw new Error(`${file}: ${JSON.stringify(status.error)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const browser = await chromium.launch();

async function seed() {
  // Made-up keys: the screenshots only list them, and nothing is ever sent with them.
  const anthropic = await api('POST', '/api/credentials', { provider: 'anthropic', apiKey: 'sk-ant-demo-0000000000000000', label: 'Anthropic' });
  const google = await api('POST', '/api/credentials', { provider: 'google', apiKey: 'AIza-demo-00000000000000000000', label: 'Google AI Studio' });
  for (const preset of await api('GET', '/api/model-presets')) if (!preset.builtIn) await api('DELETE', `/api/model-presets/${preset.id}`);
  const sonnet = await api('POST', '/api/model-presets', { profileId: 'anthropic:sonnet-55', credentialId: anthropic.id, name: 'Sonnet 5.5' });
  await api('POST', '/api/model-presets', { profileId: 'google:gemini-38-flash', credentialId: google.id, name: 'Gemini 3.8 Flash' });
  await api('POST', '/api/model-presets', { name: 'Gemma 4 (local)', format: 'ollama', model: 'gemma4:12b', endpoint: 'http://localhost:11434' });
  await api('PUT', '/api/model-binding', { main: sonnet.id });
  const persona = await api('POST', '/api/personas', { name: 'Ash', description: 'A traveler with salt in their hair and a stolen chart in their coat.' });

  // Last first, so the library lists them in this order.
  const plots = {};
  for (const key of ['academy', 'orbit', 'shrine', 'neon', 'lighthouse']) plots[key] = (await importCard(`${key}.png`)).id;

  // The lighthouse's conversation comes in through the work's chat list, as a reader's would.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${BASE}/en/plots/${plots.lighthouse}`);
  await page.getByTestId('chat-file-input').setInputFiles(join(cards, 'lighthouse-chat.json'));
  await page.getByText('Imported 1 chat.').waitFor();
  await page.close();
  const chat = (await api('GET', '/api/chats')).find((one) => one.plotId === plots.lighthouse);
  await api('PATCH', `/api/chats/${chat.id}`, { personaId: persona.id });
}

if ((await api('GET', '/api/plots')).length === 0) await seed();
const chatId = (await api('GET', '/api/chats'))[0].id;

// The test build's echo preset is not something a reader ever sees.
const HIDE_ECHO = `[data-testid="model-preset"]:has-text("Echo (test)")`;

async function open(path, { phone = false, height = 800 } = {}) {
  const context = await browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height }, deviceScaleFactor: 2 },
  );
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const done = async (page, name, target = page) => {
  await page.waitForTimeout(400);
  await target.screenshot({ path: join(shots, `${name}.png`) });
  await page.context().close();
  console.log(`shot shots/${name}.png`);
};

let page = await open('/en');
await page.getByRole('heading', { name: 'My works' }).evaluate((heading) => window.scrollBy(0, heading.getBoundingClientRect().top - 330));
await done(page, 'library');

page = await open(`/en/chats/${chatId}`, { height: 1000 });
await page.getByText('stay on the rope').waitFor();
await done(page, 'chat');

page = await open(`/en/chats/${chatId}`);
await page.getByText('stay on the rope').waitFor();
await page.mouse.move(640, 400);
await page.mouse.wheel(0, -5000);
// Off the messages, so no row shows its hover actions.
await page.mouse.move(1270, 790);
await done(page, 'chat-top');

page = await open('/en/plots');
await page.getByRole('button', { name: 'Import from RisuRealm' }).click();
await page.getByPlaceholder('https://realm.risuai.net/character/…').click();
await done(page, 'realm');

page = await open('/en/settings');
await page.locator(HIDE_ECHO).evaluateAll((rows) => rows.forEach((row) => row.remove()));
await page.getByRole('button', { name: 'Add preset' }).click();
await page.getByTestId('model-profile-browser').evaluate((browser) => window.scrollBy(0, browser.getBoundingClientRect().top - 110));
await done(page, 'models');

// Connecting needs a real account and the Shizue extension, so the card is shown
// as it reads once connected, with a placeholder address.
page = await open('/en/settings');
await page.route('**/api/chatgpt', (route) => route.fulfill({ json: { connected: true, email: 'you@example.com', local: true } }));
await page.reload({ waitUntil: 'networkidle' });
const chatgpt = page.locator('section').filter({ has: page.getByRole('heading', { name: 'ChatGPT connection' }) }).last();
await chatgpt.getByText('you@example.com').waitFor();
await done(page, 'chatgpt', chatgpt);

page = await open(`/en/chats/${chatId}`, { phone: true });
await page.getByText('stay on the rope').waitFor();
await done(page, 'chat-phone');

await browser.close();
