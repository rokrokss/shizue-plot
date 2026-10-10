import { assetResolver } from '@shizue/core/cbs';
import { describe, expect, it } from 'vitest';
import {
  assetHref,
  assetSrc,
  foldSlug,
  illustrations,
  lockedSrc,
  normalizeSlug,
  openAssetLocks,
  readAssetMeta,
  readLockKind,
  renderImageTokens,
  slugFromFileName,
  stripImageTokens,
  type PlotAsset,
} from '../src/lib/assets';
import type { AssetLock } from '../src/lib/types';

describe('slug helpers', () => {
  it('folds without eating the dash being typed', () => {
    expect(foldSlug('Smile Face')).toBe('smile-face');
    // Trimming edge dashes here would make "a-b" impossible to type.
    expect(foldSlug('a-')).toBe('a-');
    expect(foldSlug('웃음')).toBe('-');
    expect(foldSlug('a'.repeat(60))).toHaveLength(40);
  });

  it('normalizes to what the API stores', () => {
    expect(normalizeSlug('  Smile Face!! ')).toBe('smile-face');
    expect(normalizeSlug('under_score-2')).toBe('under_score-2');
    expect(normalizeSlug('웃음')).toBe('');
  });

  it('proposes a slug from the file name', () => {
    expect(slugFromFileName('Smile Face.PNG')).toBe('smile-face');
    expect(slugFromFileName('웃음.png')).toBe('');
  });
});

describe('renderImageTokens', () => {
  const assets = new Map([['smile', '/api/plots/c1/assets/smile']]);

  it('turns a known reference into a markdown image', () => {
    expect(renderImageTokens('웃는다 {{img::smile}} 끝', assets)).toBe(
      '웃는다 ![smile](/api/plots/c1/assets/smile) 끝',
    );
    // Whitespace and case are as loose as the stripper in @shizue/core.
    expect(renderImageTokens('{{ IMG :: smile }}', assets)).toBe('![smile](/api/plots/c1/assets/smile)');
  });

  it('renders nothing for a slug the character has no asset for', () => {
    expect(renderImageTokens('앞 {{img::없음}} 뒤', assets)).toBe('앞  뒤');
    expect(renderImageTokens('앞 {{img::smile}} 뒤', new Map())).toBe('앞  뒤');
  });

  it('leaves other macros and other markdown alone', () => {
    expect(renderImageTokens('{{char}}가 ![기존](/x.png)', assets)).toBe('{{char}}가 ![기존](/x.png)');
  });

  it('draws RisuAI’s other spellings of an image, and drops the asset macros a message cannot use', () => {
    expect(renderImageTokens('{{image::smile}}|{{asset::smile}}|{{emotion::smile}}', assets)).toBe(
      '![smile](/api/plots/c1/assets/smile)|![smile](/api/plots/c1/assets/smile)|![smile](/api/plots/c1/assets/smile)',
    );
    expect(renderImageTokens('앞{{raw::smile}}{{path::smile}}{{bgm::song}}{{video-img::v}}뒤', assets)).toBe('앞뒤');
    // Composed from a variable, it names nothing until something renders it with one.
    expect(renderImageTokens('앞 {{img::{{getvar::face}}}} 뒤', assets)).toBe('앞  뒤');
  });

  it('resolves an imported card’s own name for the image, and writes the slug as the alt', () => {
    const resolve = assetResolver([{ slug: 'profile-png', name: 'Profile [main].png' }]);
    const named = new Map([['profile-png', '/api/plots/c1/assets/profile-png']]);
    expect(renderImageTokens('{{img::profile [main].png}}', named, resolve)).toBe(
      '![profile-png](/api/plots/c1/assets/profile-png)',
    );
    expect(renderImageTokens('{{img::profile [main].png}}', named)).toBe('');
  });
});

describe('the measurement carried in the src', () => {
  const asset = (overrides: Partial<PlotAsset> = {}): PlotAsset => ({
    slug: 'smile',
    name: null,
    url: '/api/plots/c1/assets/smile',
    mime: 'image/png',
    width: 800,
    height: 400,
    thumbhash: 'HBkSHYSIeHiPiHh8eJd4h4eAeIhw==',
    createdAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  });

  it('appends the measurement as a fragment, which the server never sees', () => {
    expect(assetSrc(asset())).toBe(
      '/api/plots/c1/assets/smile#shizue=800x400:HBkSHYSIeHiPiHh8eJd4h4eAeIhw==',
    );
    expect(readAssetMeta(assetSrc(asset()))).toEqual({
      width: 800,
      height: 400,
      thumbhash: 'HBkSHYSIeHiPiHh8eJd4h4eAeIhw==',
    });
    expect(assetHref(assetSrc(asset()))).toBe('/api/plots/c1/assets/smile');
  });

  it('leaves an unmeasured asset as the plain URL it always was', () => {
    const old = asset({ width: null, height: null, thumbhash: null });
    expect(assetSrc(old)).toBe('/api/plots/c1/assets/smile');
    expect(readAssetMeta(assetSrc(old))).toBeNull();
    // Half a measurement is no measurement.
    expect(assetSrc(asset({ thumbhash: null }))).toBe('/api/plots/c1/assets/smile');
  });

  it('survives the markdown pass the message goes through', () => {
    const rendered = renderImageTokens('{{img::smile}}', new Map([['smile', assetSrc(asset())]]));
    expect(rendered).toBe(
      '![smile](/api/plots/c1/assets/smile#shizue=800x400:HBkSHYSIeHiPiHh8eJd4h4eAeIhw==)',
    );
  });

  it('reads nothing out of a src that carries something else', () => {
    expect(readAssetMeta('/api/plots/c1/assets/smile')).toBeNull();
    expect(readAssetMeta('/x.png#shizue=800x400')).toBeNull();
    expect(readAssetMeta('/x.png#top')).toBeNull();
    expect(assetHref('/x.png#top')).toBe('/x.png#top');
  });
});

describe('stripImageTokens', () => {
  it('drops every reference, known or not', () => {
    expect(stripImageTokens('앞 {{img::smile}} 뒤 {{img::없음}}')).toBe('앞  뒤 ');
    expect(stripImageTokens('{{char}}는 그대로')).toBe('{{char}}는 그대로');
    expect(stripImageTokens('앞{{image::a}}{{raw::b}}{{img::{{getvar::c}}}}뒤')).toBe('앞뒤');
  });
});

describe('the lock a chat reads an image through', () => {
  const asset = (slug: string): PlotAsset => ({
    slug,
    name: null,
    url: `/api/plots/c1/assets/${slug}`,
    mime: 'image/png',
    width: null,
    height: null,
    thumbhash: null,
    createdAt: '2026-08-16T00:00:00.000Z',
  });
  const locks: AssetLock[] = [
    { assetId: 'ast_1', slug: 'smile', locked: false, kind: null },
    { assetId: 'ast_2', slug: 'kiss', locked: true, kind: 'keyword' },
  ];

  it('marks a locked reference rather than resolving it', () => {
    expect(readLockKind(lockedSrc('relationship'))).toBe('relationship');
    // The marker survives the markdown pass, which is the whole point of it
    // being a fragment: a colon after a `#` is left alone.
    expect(renderImageTokens('{{img::kiss}}', new Map([['kiss', lockedSrc('turns')]]))).toBe(
      '![kiss](#shizue-lock:turns)',
    );
    expect(readLockKind('/api/plots/c1/assets/smile')).toBeNull();
  });

  it('gives the gallery every image, and the bytes of only the open ones', () => {
    expect(illustrations([asset('smile'), asset('kiss')], locks)).toEqual([
      { slug: 'smile', src: '/api/plots/c1/assets/smile', kind: null, locked: false },
      { slug: 'kiss', src: null, kind: 'keyword', locked: true },
    ]);
  });

  it('shows an asset no lock row speaks for', () => {
    expect(illustrations([asset('new')], locks)).toEqual([
      { slug: 'new', src: '/api/plots/c1/assets/new', kind: null, locked: false },
    ]);
  });

  it('opens the ones a turn earned, and leaves the rest as they were', () => {
    expect(openAssetLocks(locks, ['ast_2'])).toEqual([
      { assetId: 'ast_1', slug: 'smile', locked: false, kind: null },
      { assetId: 'ast_2', slug: 'kiss', locked: false, kind: 'keyword' },
    ]);
    expect(openAssetLocks(undefined, ['ast_2'])).toEqual([]);
  });
});
