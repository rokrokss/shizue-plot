import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildFiles, DEFAULT_TARGETS } from '../scripts/variant.mjs';

const committed = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'));

describe('sign-in helper variants', () => {
  it('commits exactly the development build', async () => {
    const { manifest, rules } = buildFiles(DEFAULT_TARGETS);
    expect(await committed('manifest.json')).toEqual(manifest);
    expect(await committed('rules.json')).toEqual(rules);
  });
  it('sends each loopback port to its own origin, query intact, and touches nothing else', () => {
    const { manifest, rules } = buildFiles([
      { origin: 'http://localhost:13000', loopbackPort: 47801 },
      { origin: 'https://plot.example.com', loopbackPort: 47811 },
    ]);
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*']);
    expect(manifest.externally_connectable.matches).toEqual(['http://localhost/*', 'https://plot.example.com/*']);
    expect(rules.map((rule: { condition: { urlFilter: string }; action: { redirect: { transform: unknown } } }) => [rule.condition.urlFilter, rule.action.redirect.transform])).toEqual([
      ['|http://127.0.0.1:47801/auth/callback?', { scheme: 'http', host: 'localhost', port: '13000', path: '/api/chatgpt/callback' }],
      ['|http://127.0.0.1:47811/auth/callback?', { scheme: 'https', host: 'plot.example.com', port: '', path: '/api/chatgpt/callback' }],
    ]);
  });
  it('refuses a target that is not an origin, or a port two targets share', () => {
    expect(() => buildFiles([{ origin: 'https://plot.example.com/app', loopbackPort: 47811 }])).toThrow(/web origin/);
    expect(() => buildFiles([
      { origin: 'http://localhost:13000', loopbackPort: 47801 },
      { origin: 'https://plot.example.com', loopbackPort: 47801 },
    ])).toThrow(/own loopback port/);
  });
});
