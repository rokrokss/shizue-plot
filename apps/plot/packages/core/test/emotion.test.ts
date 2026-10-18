import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INLAY_EMOTION_INSTRUCTIONS,
  defaultEmotion,
  emotionInstructionsOf,
  emotionRequest,
  emotionScreenOf,
  extensionsWithEmotionMode,
  inlayEmotionTags,
  pickEmotion,
  pickEmotionByEmbedding,
} from '../src/emotion.js';
import { assemblePrompt } from '../src/prompt.js';
import { emptyCard } from '../src/card/normalize.js';
import type { EmotionImage, NormalizedCard } from '../src/types.js';

const images: EmotionImage[] = [
  { name: 'neutral', slug: 'neutral' },
  { name: 'happy', slug: 'happy' },
  { name: 'Angry', slug: 'angry' },
];

const card = (risuai: Record<string, unknown>, emotionImages: EmotionImage[] = images): NormalizedCard => ({
  ...emptyCard('세이'),
  emotionImages,
  extensions: { risuai },
});

describe('emotionScreenOf', () => {
  it("reads RisuAI's viewScreen and inlayViewScreen, and needs pictures to show", () => {
    expect(emotionScreenOf(card({ viewScreen: 'emotion' }))).toEqual({ mode: 'panel', images });
    expect(emotionScreenOf(card({ viewScreen: 'emotion', inlayViewScreen: true }))).toEqual({ mode: 'inlay', images });
    expect(emotionScreenOf(card({ viewScreen: 'none' }))).toBeNull();
    expect(emotionScreenOf(card({ viewScreen: 'imggen' }))).toBeNull();
    expect(emotionScreenOf(card({ viewScreen: 'emotion' }, []))).toBeNull();
    expect(emotionScreenOf(emptyCard('리안'))).toBeNull();
  });

  it('switches the mode in the extension as RisuAI does, dropping its generation data', () => {
    const before = { risuai: { viewScreen: 'emotion', inlayViewScreen: false, newGenData: { emotionInstructions: 'x' }, utilityBot: false }, other: 1 };
    expect(extensionsWithEmotionMode(before, 'inlay')).toEqual({
      risuai: { viewScreen: 'emotion', inlayViewScreen: true, utilityBot: false },
      other: 1,
    });
    expect(extensionsWithEmotionMode(before, null)).toEqual({ risuai: { viewScreen: 'none', utilityBot: false }, other: 1 });
    expect(extensionsWithEmotionMode({}, 'panel')).toEqual({ risuai: { viewScreen: 'emotion', inlayViewScreen: false } });
    // A card that never had the screen gains nothing by turning it off.
    expect(extensionsWithEmotionMode({ a: 1 }, null)).toEqual({ a: 1 });
  });
});

describe('inlay emotion screen', () => {
  it("tells the model RisuAI's instructions with the card's names", () => {
    expect(emotionInstructionsOf(card({ viewScreen: 'emotion', inlayViewScreen: true }))).toBe(
      DEFAULT_INLAY_EMOTION_INSTRUCTIONS.replace('{{slot}}', 'neutral, happy, Angry'),
    );
    const own = card({ viewScreen: 'emotion', inlayViewScreen: true, newGenData: { emotionInstructions: '고르기: {{slot}}.' } });
    expect(emotionInstructionsOf(own)).toBe('고르기: neutral, happy, Angry.');
    // Only for the inlay screen.
    expect(emotionInstructionsOf(card({ viewScreen: 'emotion' }))).toBe('');
  });

  it('puts the instructions after everything for the member replying, and only for them', () => {
    const inlay = { name: '세이', id: 'a', card: card({ viewScreen: 'emotion', inlayViewScreen: true }) };
    const plain = { name: '카이', id: 'b', card: emptyCard('카이') };
    const plot = { name: '작품', description: '', lorebook: [] };
    const history = [{ role: 'user' as const, content: '안녕' }];
    const texts = (input: Parameters<typeof assemblePrompt>[0]) =>
      assemblePrompt(input).messages.map((message) => String(message.content));
    const emotion = (sent: string[]) => sent.findIndex((text) => text.includes('List of commands'));

    // After the newest turn, with what follows the chat (RisuAI's `postEverything`).
    const alone = texts({ plot, characters: [inlay], history });
    expect(alone[emotion(alone)]).toContain('List of commands: neutral, happy, Angry');
    expect(emotion(alone)).toBeGreaterThan(alone.indexOf('안녕'));
    // A group turn: the speaker's card decides, and the speaker line follows it.
    const asSpeaker = texts({ plot, characters: [plain, inlay], history, speaker: 1 });
    expect(asSpeaker[emotion(asSpeaker) + 1]).toBe('[Write the next reply only as 세이]');
    expect(emotion(texts({ plot, characters: [inlay, plain], history, speaker: 1 }))).toBe(-1);
    // A scene reply in a work of several is no one member's.
    expect(emotion(texts({ plot, characters: [inlay, plain], history }))).toBe(-1);
  });

  it("turns the model's tags into the picture, each on a line of its own", () => {
    expect(inlayEmotionTags('그래. <Emotion="happy">')).toBe('그래.\n{{emotion::happy}}');
    expect(inlayEmotionTags('그래.\n<emotion="Angry">\n')).toBe('그래.\n{{emotion::Angry}}\n');
    expect(inlayEmotionTags('<Emotion="a"> 그리고 <Emotion="b">')).toBe('{{emotion::a}}\n그리고\n{{emotion::b}}');
    expect(inlayEmotionTags('표정 없음')).toBe('표정 없음');
  });
});

describe('emotion detection', () => {
  it("asks RisuAI's question, the names in a fresh order", () => {
    const request = emotionRequest(images, '좋아!', () => 0);
    // Fisher–Yates with a random of 0 moves each item to the front in turn.
    expect(request.system).toBe(
      "From the list below, choose a word that best represents a character's outfit description, action, or emotion in their dialogue. Prioritize selecting words related to outfit first, then action, and lastly emotion. Print out the chosen word.\n\n list: happy, Angry, neutral \noutput only one word.",
    );
    expect(request.messages).toEqual([
      { role: 'user', content: '"Good morning, Master! Is there anything I can do for you today?"' },
      { role: 'assistant', content: 'happy' },
      { role: 'user', content: '좋아!' },
    ]);
  });

  it('reads the answer as RisuAI does, names compared without case', () => {
    expect(pickEmotion('happy', images)?.name).toBe('happy');
    expect(pickEmotion(' Hap py\n', images)?.name).toBe('happy');
    expect(pickEmotion('angry', images)?.name).toBe('Angry');
    expect(pickEmotion('the word is angry.', images)?.name).toBe('Angry');
    // Nothing named: neutral where the card has it, nothing where it does not.
    expect(pickEmotion('sleepy', images)?.name).toBe('neutral');
    expect(pickEmotion('sleepy', images.slice(1))).toBeUndefined();
  });

  it("shows RisuAI's default before any choice: the one named neutral", () => {
    expect(defaultEmotion(images)?.slug).toBe('neutral');
    expect(defaultEmotion([{ name: 'Neutral', slug: 'n' }])).toBeUndefined();
  });
});

describe('embedding emotion processor', () => {
  const scores = (entries: [string, number][]) => new Map(entries);

  it('picks the nearest name, with no threshold and no neutral fallback', () => {
    expect(pickEmotionByEmbedding(images, scores([['neutral', 0.2], ['happy', 0.5], ['Angry', 0.1]]), [])?.name).toBe('happy');
    // Far from every name is still a choice.
    expect(pickEmotionByEmbedding(images, scores([['neutral', -0.3], ['happy', -0.2], ['Angry', -0.4]]), [])?.name).toBe('happy');
    // A tie keeps the card's order; no score, no picture.
    expect(pickEmotionByEmbedding(images, scores([['happy', 0.5], ['Angry', 0.5]]), [])?.name).toBe('happy');
    expect(pickEmotionByEmbedding(images, new Map(), [])).toBeUndefined();
    // Two pictures of one name: the first.
    const twice = [...images, { name: 'happy', slug: 'happy-2' }];
    expect(pickEmotionByEmbedding(twice, scores([['happy', 0.9]]), [])?.slug).toBe('happy');
  });

  it("holds the member's last four pictures against them as RisuAI does: 0.025 for the latest down to 0.01", () => {
    const close = (gap: number) => scores([['happy', 0.5 + gap], ['neutral', 0.5]]);
    // The latest picture loses 0.025.
    expect(pickEmotionByEmbedding(images, close(0.024), ['happy'])?.name).toBe('neutral');
    expect(pickEmotionByEmbedding(images, close(0.026), ['happy'])?.name).toBe('happy');
    // Four back, 0.01; five back, nothing.
    expect(pickEmotionByEmbedding(images, close(0.009), ['happy', 'Angry', 'Angry', 'Angry'])?.name).toBe('neutral');
    expect(pickEmotionByEmbedding(images, close(0.011), ['happy', 'Angry', 'Angry', 'Angry'])?.name).toBe('happy');
    expect(pickEmotionByEmbedding(images, close(0.001), ['happy', 'Angry', 'Angry', 'Angry', 'Angry'])?.name).toBe('happy');
    // Each time it is among them: 0.025 + 0.02.
    expect(pickEmotionByEmbedding(images, close(0.044), ['happy', 'happy'])?.name).toBe('neutral');
    expect(pickEmotionByEmbedding(images, close(0.046), ['happy', 'happy'])?.name).toBe('happy');
  });
});
