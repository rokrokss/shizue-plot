/**
 * Source pages an import may name: which addresses each platform accepts, and
 * the one spelling each is stored in. The Realm cases are the ones the API and
 * the web held before the shapes moved here.
 */
import { describe, expect, it } from 'vitest';
import { isLegacyRealmId, realmCardId, realmCharacterUrl, sourceUrlFor } from '../src/sourceUrl.js';

const id = '0f8e6c1a-3b2d-4c5e-9f7a-1b2c3d4e5f60';
const page = `https://realm.risuai.net/character/${id}`;

describe('realmCardId', () => {
  it('reads the page, the risuai.xyz link and a bare id', () => {
    for (const input of [
      page,
      `${page}/`,
      `  ${page}?ref=home#top `,
      `https://risuai.xyz/?realm=${id}`,
      `https://www.risuai.xyz/?realm=${id}&lang=ko`,
      id,
    ]) {
      expect(realmCardId(input), input).toBe(id);
    }
  });

  it('refuses anything that is not a Realm card page', () => {
    for (const input of [
      '',
      'not a url',
      `https://example.com/character/${id}`,
      `https://realm.risuai.net/character/${id}/edit`,
      'https://realm.risuai.net/character/abc',
      `https://realm.risuai.net/?realm=${id}`,
      'https://risuai.xyz/?realm=abc',
      `javascript:alert('${id}')`,
      `ftp://realm.risuai.net/character/${id}`,
    ]) {
      expect(realmCardId(input), input).toBeNull();
    }
  });

  it("reads a legacy card's 64-hex id in every shape, and only that length", () => {
    const hex = 'c460b3f976e84ab07e639f1aed656817e64556b61e8d1ec8f25ae88f96febc09';
    for (const input of [
      hex,
      `https://realm.risuai.net/character/${hex}`,
      `https://realm.risuai.net/character/${hex}/`,
      `https://risuai.xyz/?realm=${hex}`,
    ]) {
      expect(realmCardId(input), input).toBe(hex);
    }
    expect(isLegacyRealmId(hex)).toBe(true);
    expect(isLegacyRealmId(id)).toBe(false);
    for (const input of [hex.slice(1), `${hex}0`, `${hex.slice(1)}g`]) {
      expect(realmCardId(input), input).toBeNull();
      expect(realmCardId(`https://realm.risuai.net/character/${input}`), input).toBeNull();
    }
    expect(sourceUrlFor('realm', hex)).toBe(`https://realm.risuai.net/character/${hex}`);
  });

  it('stores one spelling', () => {
    expect(realmCharacterUrl(id)).toBe(page);
    expect(sourceUrlFor('realm', `https://risuai.xyz/?realm=${id}`)).toBe(page);
    expect(sourceUrlFor('realm', 'nope')).toBeNull();
  });
});

describe('sourceUrlFor', () => {
  const upper = id.toUpperCase();

  it('reads each platform’s public page into its stored spelling', () => {
    const cases: [Parameters<typeof sourceUrlFor>[0], string, string][] = [
      ['zeta', `https://zeta-ai.io/en/plots/${upper}/profile/?tab=1#x`, `https://zeta-ai.io/ko/plots/${id}/profile`],
      ['zeta', `http://www.zeta-ai.io/ko/plots/${id}/profile`, `https://zeta-ai.io/ko/plots/${id}/profile`],
      ['caveduck', `https://caveduck.io/ja/characters/${id}`, `https://caveduck.io/ko/characters/${id}`],
      ['babechat', `https://www.babechat.ai/character/u/${id}/profile`, `https://babechat.ai/character/u/${id}/profile`],
      ['crack', ' https://crack.wrtn.ai/detail/6512ab_cd-9 ', 'https://crack.wrtn.ai/detail/6512ab_cd-9'],
      ['elyn', 'https://www.elyn.ai/character/abc/?ref=x#top', 'https://elyn.ai/character/abc'],
    ];
    for (const [platform, input, stored] of cases) {
      expect(sourceUrlFor(platform, input), input).toBe(stored);
    }
  });

  it('refuses another platform’s page, another shape, and anything not http(s)', () => {
    const cases: [Parameters<typeof sourceUrlFor>[0], string][] = [
      ['zeta', `https://zeta-ai.io/ko/plots/${id}`],
      ['zeta', `https://zeta-ai.io/plots/${id}/profile`],
      ['zeta', `https://zeta-ai.io/ko/plots/not-a-uuid/profile`],
      ['zeta', `https://caveduck.io/ko/characters/${id}`],
      ['caveduck', `https://caveduck.io/ko/characters/${id}/chat`],
      ['caveduck', `https://caveduck.io/characters/${id}`],
      ['babechat', `https://babechat.ai/character/${id}/profile`],
      ['crack', 'https://crack.wrtn.ai/detail/'],
      ['crack', 'https://crack.wrtn.ai/detail/a/b'],
      ['crack', 'https://wrtn.ai/detail/abc'],
      ['elyn', 'https://elyn.ai/'],
      ['elyn', 'https://elyn.ai.example.com/character/abc'],
      ['elyn', 'javascript:alert(1)'],
      ['zeta', id],
      ['elyn', ''],
    ];
    for (const [platform, input] of cases) {
      expect(sourceUrlFor(platform, input), `${platform} ${input}`).toBeNull();
    }
  });
});
