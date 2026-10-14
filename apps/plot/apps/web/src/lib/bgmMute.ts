'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * The reader's mute for a chat's music: the `{{bgm::…}}` track
 * (`useBackgroundMusic`), the `{{audio::…}}` players, and any `<audio>` a card
 * writes into a message or its background. Muting silences, nothing more — no
 * track is paused, stopped or swapped, and what autoplays still autoplays (RisuAI's
 * behaviour), only without sound.
 *
 * Per browser, not per chat: a reader who wants quiet wants it in the next chat
 * too. The switch lives here, in memory; storage only keeps it for the next page,
 * so a browser that refuses storage still mutes for this visit.
 */

const BGM_MUTED_KEY = 'shizue.bgmMuted';
/** What on the page is music: a `{{bgm::…}}` marker, or a player of any origin. */
const MUSIC = 'audio, [data-shizue-bgm]';

/** Unread until first asked, so nothing touches storage before the page runs. */
let muted: boolean | null = null;
/** The background track playing now, which is in no document. */
let track: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isBgmMuted(): boolean {
  if (typeof window === 'undefined') return false;
  if (muted === null) {
    try {
      muted = window.localStorage.getItem(BGM_MUTED_KEY) === '1';
    } catch {
      muted = false;
    }
  }
  return muted;
}

/**
 * Mutes or unmutes everything playing now. Unmuting gives each player back what
 * its markup asked for (`defaultMuted`, the `muted` attribute), so a card's own
 * silent player stays silent.
 */
export function setBgmMuted(next: boolean): void {
  muted = next;
  try {
    if (next) window.localStorage.setItem(BGM_MUTED_KEY, '1');
    else window.localStorage.removeItem(BGM_MUTED_KEY);
  } catch {
    // Blocked site data: quiet for this visit only.
  }
  if (track) track.muted = next;
  for (const player of document.querySelectorAll('audio')) player.muted = next || player.defaultMuted;
  emit();
}

/** `useBackgroundMusic`'s track as it starts (muted if the reader has muted), or null once none plays. */
export function setBgmTrack(audio: HTMLAudioElement | null): void {
  if (audio) audio.muted = isBgmMuted();
  track = audio;
  emit();
}

const playing = (): boolean => track !== null;
const never = (): boolean => false;

/**
 * The chat page's side of the mute: whether there is music to mute — a marker or
 * a player on the page, or a track still playing after its marker went (a swiped
 * reply) — and the switch. While muted, a player that appears later (a new reply,
 * a redrawn background) is silent from the start; one the reader unmutes with its
 * own controls stays as they left it until the switch is pressed again.
 */
export function useBgmMute(): { present: boolean; muted: boolean; toggle: () => void } {
  const mutedNow = useSyncExternalStore(subscribe, isBgmMuted, never);
  const trackPlaying = useSyncExternalStore(subscribe, playing, never);
  const [inPage, setInPage] = useState(false);

  useEffect(() => {
    const look = (): void => setInPage(document.querySelector(MUSIC) !== null);
    const observer = new MutationObserver((records) => {
      if (isBgmMuted()) {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof HTMLAudioElement) node.muted = true;
            else if (node instanceof Element) for (const player of node.querySelectorAll('audio')) player.muted = true;
          }
        }
      }
      look();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // What was drawn before this mounted.
    if (isBgmMuted()) for (const player of document.querySelectorAll('audio')) player.muted = true;
    look();
    return () => observer.disconnect();
  }, []);

  return { present: inPage || trackPlaying, muted: mutedNow, toggle: () => setBgmMuted(!isBgmMuted()) };
}
