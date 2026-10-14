/**
 * RisuAI's emotion images (`viewScreen: 'emotion'`): a card's expression
 * pictures, one of which is shown for the character at a time.
 *
 * Two ways of choosing it, as RisuAI has them. Without `inlayViewScreen` the
 * picture stands in a panel beside the chat, and after each reply an auxiliary
 * model picks one by name (`emotionRequest`, `pickEmotion` — RisuAI's default
 * `emotionProcesser`, `submodel`). With it the model names one itself at the end
 * of its reply (`<Emotion="name">`, taught by `emotionInstructionsOf`), and the
 * picture is drawn in the message (`inlayEmotionTags`).
 *
 * What the card says lives where RisuAI keeps it — `extensions.risuai`'s
 * `viewScreen`, `inlayViewScreen` and `newGenData.emotionInstructions` — so an
 * exported card carries it back. The pictures are the plot's assets: the import
 * records which of them were the card's emotions (`NormalizedCard.emotionImages`).
 */

import type { EmotionImage, NormalizedCard } from './types.js';

/** How a member's emotion pictures are shown: in the panel, or in its replies. */
export type EmotionMode = 'panel' | 'inlay';

/** A member's emotion screen, as the chat and the prompt read it (`emotionScreenOf`). */
export interface EmotionScreen {
  mode: EmotionMode;
  /** The card's pictures, in its order. Never empty. */
  images: EmotionImage[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const risuOf = (card: Pick<NormalizedCard, 'extensions'>): Record<string, unknown> => {
  const risu = card.extensions['risuai'];
  return isObject(risu) ? risu : {};
};

/**
 * The member's emotion screen, or null when it shows none: its card does not
 * say `viewScreen: 'emotion'`, or it brought no pictures to show.
 */
export function emotionScreenOf(card: Pick<NormalizedCard, 'extensions' | 'emotionImages'>): EmotionScreen | null {
  const risu = risuOf(card);
  if (risu['viewScreen'] !== 'emotion') return null;
  const images = card.emotionImages ?? [];
  if (images.length === 0) return null;
  return { mode: risu['inlayViewScreen'] === true ? 'inlay' : 'panel', images };
}

/** The mode a card's extensions say, whatever pictures it has; null for RisuAI's `none` (or `imggen`). */
export function emotionModeOf(card: Pick<NormalizedCard, 'extensions'>): EmotionMode | null {
  const risu = risuOf(card);
  if (risu['viewScreen'] !== 'emotion') return null;
  return risu['inlayViewScreen'] === true ? 'inlay' : 'panel';
}

/**
 * The card's extensions with the mode set, as RisuAI's character settings set
 * it: `viewScreen` and `inlayViewScreen`, and `newGenData` taken away — RisuAI
 * rewrites it to the new mode's defaults (`updateInlayScreen`) on every switch,
 * and without one the default for the mode is what is read here.
 */
export function extensionsWithEmotionMode(
  extensions: Record<string, unknown>,
  mode: EmotionMode | null,
): Record<string, unknown> {
  const risu: Record<string, unknown> = { ...(isObject(extensions['risuai']) ? extensions['risuai'] : {}) };
  delete risu['newGenData'];
  if (mode === null) {
    // `none` is RisuAI's default; a card that never had the field keeps not having it.
    if (risu['viewScreen'] === 'emotion') risu['viewScreen'] = 'none';
    delete risu['inlayViewScreen'];
  } else {
    risu['viewScreen'] = 'emotion';
    risu['inlayViewScreen'] = mode === 'inlay';
  }
  const next = { ...extensions };
  if (Object.keys(risu).length > 0) next['risuai'] = risu;
  else delete next['risuai'];
  return next;
}

/**
 * RisuAI's `newGenData.emotionInstructions` for an inlay emotion screen when the
 * card brings none (`updateInlayScreen` in its `process/inlayScreen.ts`).
 */
export const DEFAULT_INLAY_EMOTION_INSTRUCTIONS =
  "You must always output the character's emotional image as a command at the end of a conversation. The command must be selected from a given list, and it's better to have variety than to repeat images used in previous chats. Use one image, depending on the character's emotion. See the list below. Form: <Emotion=\"<image command>\"> Example: <Emotion=\"Agree\"> List of commands: {{slot}}";

/**
 * What an inlay emotion screen adds to the prompt — RisuAI's system turn at the
 * very end (`postEverything`): the card's own instructions, or the default, with
 * `{{slot}}` the pictures' names joined by `, `. Empty for any other screen.
 */
export function emotionInstructionsOf(card: Pick<NormalizedCard, 'extensions' | 'emotionImages'>): string {
  const screen = emotionScreenOf(card);
  if (screen?.mode !== 'inlay') return '';
  const genData = risuOf(card)['newGenData'];
  const own = isObject(genData) ? genData['emotionInstructions'] : undefined;
  const instructions = typeof own === 'string' && own.trim() ? own : DEFAULT_INLAY_EMOTION_INSTRUCTIONS;
  return instructions.replaceAll('{{slot}}', screen.images.map((image) => image.name).join(', '));
}

/**
 * RisuAI's inlay tag, as `runInlayScreen` finds it (`/<Emotion="(.+?)">/gi`),
 * with the spaces beside it on its line, which the line break replaces.
 */
const INLAY_EMOTION_TAG = /[ \t]*<Emotion="(.+?)">[ \t]*/gi;

/**
 * A reply with the model's `<Emotion="name">` tags turned into the picture
 * macro, as RisuAI's `runInlayScreen` rewrites the reply before storing it —
 * each on a line of its own here, so the picture is drawn as a figure in the
 * flow rather than inside the sentence it ended.
 */
export function inlayEmotionTags(text: string): string {
  return text.replace(INLAY_EMOTION_TAG, (match, name: string, offset: number, whole: string) => {
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + match.length);
    const lead = before === '' || before.endsWith('\n') ? '' : '\n';
    const tail = after === '' || after.startsWith('\n') ? '' : '\n';
    return `${lead}{{emotion::${name}}}${tail}`;
  });
}

/**
 * RisuAI's default choice before any has been made (`defaultEmotion` in its
 * `util.ts`): the picture named exactly `neutral`, or none.
 */
export const defaultEmotion = (images: readonly EmotionImage[]): EmotionImage | undefined =>
  images.find((image) => image.name === 'neutral');

/**
 * RisuAI's built-in `emotionPrompt2`, the sub-model instruction its settings
 * leave empty by default.
 */
export const EMOTION_PROMPT =
  "From the list below, choose a word that best represents a character's outfit description, action, or emotion in their dialogue. Prioritize selecting words related to outfit first, then action, and lastly emotion. Print out the chosen word.";

/** RisuAI's cap on the answer (`maxTokens: 30`). */
export const EMOTION_MAX_TOKENS = 30;

/** RisuAI's `shuffleArray`: Fisher–Yates on a copy. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface EmotionRequest {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

/**
 * The auxiliary model's question, as RisuAI's `sendChat` asks it after a reply:
 * the instruction with the names in a fresh random order, one worked example,
 * then the reply. RisuAI also biases the names' tokens up and the last few
 * choices' down (`emobias`); the provider here takes no logit bias, so that
 * part has no counterpart.
 */
export function emotionRequest(
  images: readonly EmotionImage[],
  reply: string,
  random: () => number = Math.random,
): EmotionRequest {
  const names = shuffled(
    images.map((image) => image.name),
    random,
  );
  return {
    system: `${EMOTION_PROMPT}\n\n list: ${names.join(', ')} \noutput only one word.`,
    messages: [
      { role: 'user', content: '"Good morning, Master! Is there anything I can do for you today?"' },
      { role: 'assistant', content: 'happy' },
      { role: 'user', content: reply },
    ],
  };
}

/**
 * The picture an answer names, by RisuAI's reading of it: spaces and line
 * breaks taken out and lowercased, then a name it is, then the first name it
 * contains, then `neutral` if the card has one, then none. Names are compared
 * lowercased as well — RisuAI compares the lowercased answer with the name as
 * written, so a capitalized name never matched there.
 */
export function pickEmotion(answer: string, images: readonly EmotionImage[]): EmotionImage | undefined {
  const said = answer.replace(/ |\n/g, '').trim().toLocaleLowerCase();
  const name = (image: EmotionImage): string => image.name.toLocaleLowerCase();
  return (
    images.find((image) => name(image) === said) ??
    images.find((image) => name(image) !== '' && said.includes(name(image))) ??
    defaultEmotion(images)
  );
}
