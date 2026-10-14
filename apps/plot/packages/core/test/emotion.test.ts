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
    const last = (input: Parameters<typeof assemblePrompt>[0]) => assemblePrompt(input).messages.at(-1)!;

    expect(last({ plot, characters: [inlay], history }).content).toContain('List of commands: neutral, happy, Angry');
    // A group turn: the speaker's card decides, and the speaker line stays last.
    const asSpeaker = assemblePrompt({ plot, characters: [plain, inlay], history, speaker: 1 }).messages;
    expect(asSpeaker.at(-2)!.content).toContain('List of commands');
    expect(assemblePrompt({ plot, characters: [inlay, plain], history, speaker: 1 }).messages.some((message) =>
      String(message.content).includes('List of commands'),
    )).toBe(false);
    // A scene reply in a work of several is no one member's, and a narration is the narrator's.
    expect(String(last({ plot, characters: [inlay, plain], history }).content)).not.toContain('List of commands');
    expect(String(last({ plot, characters: [inlay], history, narration: true }).content)).not.toContain('List of commands');
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
