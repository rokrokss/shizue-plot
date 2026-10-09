import {
  narrationBody,
  stripImageMacros,
  stripVariableMacros,
  type PromptCharacter,
  type PromptPlot,
} from '@shizue/core';
import type { Message } from '@shizue/db';
import type { AppDeps } from './deps.js';
import { ApiError } from './errors.js';

/** ChatGPT plan sharing does not support image generation. Only tests inject this seam. */
export const drawSceneEnabled = (deps: AppDeps): boolean =>
  (deps.env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test' && Boolean(deps.generateSceneImage);

/** How many turns of the branch the picture is drawn from. */
const PROMPT_TURNS = 3;
/** Characters of scene text the prompt carries, counted from the newest end. */
const MAX_SCENE_CHARS = 700;
/** Characters of each description — the plot's and each member's — the prompt carries. */
const MAX_DESCRIPTION_CHARS = 400;
/** Faces one illustration can hold; past that the picture is a crowd, not a scene. */
const MAX_CAST_IN_PROMPT = 4;

/** What the provider gave back, ready to be stored like any other attachment. */
export interface GeneratedImage {
  bytes: Uint8Array;
  /** Provider-reported size, so the box is reserved before the bytes load. */
  width: number | null;
  height: number | null;
}

/** The seam the route calls through, so tests never reach the network. */
export type SceneImageGenerator = (deps: AppDeps, prompt: string) => Promise<GeneratedImage>;


/** One line of scene text: no macros, no narration prefix, no stray whitespace. */
const sceneLine = (message: Message): string =>
  stripVariableMacros(stripImageMacros(narrationBody(message.content))).replace(/\s+/g, ' ').trim();

/**
 * The prompt, built from what the picture is meant to show: who is in it, and
 * what has just happened.
 *
 * Deliberately small. The plot's description says where the scene is set and
 * each member's says what they look like, the last few turns say what is
 * happening, and a fixed instruction keeps the result an illustration rather than
 * a page of rendered dialogue. Nothing else of the prompt pipeline — presets,
 * lorebook, memory, the author's note — is involved: those shape how a character
 * writes, and none of them describe a picture.
 */
export function sceneImagePrompt(
  plot: PromptPlot,
  characters: PromptCharacter[],
  path: Message[],
): string {
  const trim = (text: string): string =>
    text.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);
  const setting = trim(plot.description);
  const cast = characters
    .slice(0, MAX_CAST_IN_PROMPT)
    .map(({ name, card }) => `${name}${card.description.trim() ? ` — ${trim(card.description)}` : ''}`);
  // From the newest end: what the picture should show is what just happened, so
  // an over-long stretch loses its beginning rather than its point.
  const scene = path
    .slice(-PROMPT_TURNS)
    .map(sceneLine)
    .filter((line) => line.length > 0)
    .join('\n')
    .slice(-MAX_SCENE_CHARS);
  return [
    'A single cinematic illustration of the scene described below.',
    'No text, no speech bubbles, no captions, no watermark, no frame borders.',
    `Setting: ${plot.name}${setting ? ` — ${setting}` : ''}`,
    ...(cast.length > 0 ? [`Characters: ${cast.join('; ')}`] : []),
    `Scene: ${scene}`,
  ].join('\n');
}

/** There is deliberately no separately billed image provider. */
export const generateSceneImage: SceneImageGenerator = async () => {
  throw new ApiError(400, 'image_unavailable', 'ChatGPT plan sharing does not support image generation.');
};
