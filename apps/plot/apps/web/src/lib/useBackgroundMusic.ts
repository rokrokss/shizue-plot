'use client';

import { useEffect } from 'react';
import { setBgmTrack } from './bgmMute';

/** RisuAI's volume for `{{bgm::…}}` (`bgm___auto___`, its observer's `auto`). */
const BGM_VOLUME = 0.5;
/** What `{{bgm::…}}` leaves in the page (`musicMarkup`), the sanitizer having held its address to our origin. */
const MARKER = '[data-shizue-bgm]';

/**
 * A card's background music, played as RisuAI's DOM observer plays it
 * (`observer.svelte.ts`): one track at a time, at half volume, not looped. While
 * a track plays no other starts; once it ends, the first marker on the page
 * starts the next — the same one again, as long as it is still drawn. Nothing
 * about it is shown: `{{bgm::…}}` has no player, in RisuAI or here. The one
 * control is the header's mute (`bgmMute`), which the track is handed to.
 *
 * The browser's autoplay rule stands: a start it refuses (no gesture on the page
 * yet) is not forced, and is tried once more on the reader's next press or key.
 * Leaving the chat stops the track.
 */
export function useBackgroundMusic(): void {
  useEffect(() => {
    let current: HTMLAudioElement | null = null;
    let waiting = false;
    let disposed = false;

    const resume = (): void => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      waiting = false;
      scan();
    };

    function start(src: string): void {
      const audio = new Audio(src);
      audio.volume = BGM_VOLUME;
      current = audio;
      setBgmTrack(audio);
      audio.addEventListener('ended', () => {
        if (current !== audio) return;
        current = null;
        setBgmTrack(null);
        scan();
      });
      audio.play().catch(() => {
        if (disposed || current !== audio) return;
        current = null;
        setBgmTrack(null);
        waiting = true;
        window.addEventListener('pointerdown', resume);
        window.addEventListener('keydown', resume);
      });
    }

    function scan(): void {
      if (disposed || current || waiting) return;
      const src = document.querySelector(MARKER)?.getAttribute('data-shizue-bgm');
      if (src) start(src);
    }

    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      current?.pause();
      current = null;
      setBgmTrack(null);
    };
  }, []);
}
