// @vitest-environment jsdom
/**
 * A card's video, as RisuAI's asset macros draw it: `{{video::…}}` a player,
 * `{{video-img::…}}` and `{{asset::…}}` naming a video a muted moving picture —
 * from our own origin only, the sanitizer holding every address to it.
 */
import { describe, expect, it } from 'vitest';
import { assetResolver } from '@shizue/core/cbs';
import { assetSrc, isVideoSrc, type PlotAsset } from '../src/lib/assets';
import { mediaMarkup } from '../src/lib/cbs';
import { renderImageTokensAsHtml } from '../src/lib/markdown/html';
import { sanitizeCustomHtml } from '../src/lib/sanitizeHtml';

const asset = (slug: string, mime: string): PlotAsset => ({
  slug,
  name: slug,
  url: `/api/plots/p/assets/${slug}`,
  mime,
  width: null,
  height: null,
  thumbhash: null,
  createdAt: '',
});

describe('video assets', () => {
  const assets = [asset('clip', 'video/mp4'), asset('face', 'image/png')];
  const map = new Map(assets.map((one) => [one.slug, assetSrc(one)]));
  const resolve = assetResolver(assets);

  it('marks a video’s address so the renderers can tell it from a picture’s', () => {
    expect(isVideoSrc(map.get('clip')!)).toBe(true);
    expect(isVideoSrc(map.get('face')!)).toBe(false);
  });

  it('draws RisuAI’s players: a looping one, a muted moving picture, and `{{asset}}` of a video as the latter', () => {
    const html = (text: string) => renderImageTokensAsHtml(text, map, resolve);
    expect(html('<div>{{video::clip}}</div>')).toBe(`<div>${mediaMarkup('video', map.get('clip')!)}</div>`);
    expect(html('<div>{{video-img::clip}}</div>')).toContain('<video autoplay muted loop playsinline');
    expect(html('<div>{{asset::clip}}</div>')).toContain('<video autoplay muted loop playsinline');
    expect(html('<div>{{asset::face}}</div>')).toContain('<img');
    expect(mediaMarkup('video', '/a')).toBe('<video controls autoplay loop playsinline src="/a"></video>');
  });

  it('keeps a video from our own origin and drops one from anywhere else', () => {
    const clean = sanitizeCustomHtml(
      '<video controls autoplay loop src="/api/plots/p/assets/clip#shizue-video"></video>' +
        '<video src="https://elsewhere.test/x.mp4"></video>' +
        '<video controls><source src="https://elsewhere.test/y.mp4"></video>',
    );
    const box = document.createElement('div');
    box.innerHTML = clean;
    const videos = [...box.querySelectorAll('video')];
    expect(videos.map((video) => video.getAttribute('src'))).toEqual(['/api/plots/p/assets/clip#shizue-video', null]);
    expect(box.querySelector('source')).toBeNull();
    expect(clean).not.toContain('elsewhere.test');
  });
});
