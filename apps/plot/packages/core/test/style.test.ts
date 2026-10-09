import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_RESPONSE_TOKENS,
  replyLengthTokens,
  PLOT_MOOD_LABELS,
  STYLE_DIRECTIVES_HEADER,
  styleDirectives,
} from '../src/prompt.js';
import { coercePlotStyle } from '../src/style.js';
import {
  CHOICES_MODES,
  MAX_PLOT_MOODS,
  NARRATIVE_DELIVERIES,
  REPLY_LENGTHS,
  PLOT_DIFFICULTIES,
  PLOT_MOODS,
  PLOT_PACINGS,
  PLOT_TENSES,
  STORYTELLING_STYLES,
  type PlotStyle,
} from '../src/types.js';

/** The bullets of a compiled block, without the header. */
const bullets = (style: PlotStyle): string[] => {
  const block = styleDirectives(style);
  if (!block) return [];
  const [header, ...lines] = block.split('\n');
  expect(header).toBe(STYLE_DIRECTIVES_HEADER);
  return lines.map((line) => line.replace(/^- /, ''));
};

describe('coercePlotStyle', () => {
  it('keeps every option this build knows', () => {
    const style: PlotStyle = {
      tense: 'past',
      replyLength: 'short',
      delivery: 'dialogue',
      pacing: 'slow',
      difficulty: 'nightmare',
      moods: ['horror', 'angst'],
      storytelling: 'noir',
      statusWindow: true,
      choices: 'sentences',
    };
    expect(coercePlotStyle(style)).toEqual(style);
    // A value that happens to be a default is still what the creator picked.
    const quiet: PlotStyle = {
      replyLength: 'auto',
      delivery: 'balanced',
      pacing: 'natural',
      difficulty: 'normal',
      statusWindow: false,
      choices: 'off',
    };
    expect(coercePlotStyle(quiet)).toEqual(quiet);
  });

  it('drops an enum value it has no directive for', () => {
    expect(
      coercePlotStyle({
        tense: 'future',
        replyLength: 'epic',
        delivery: 'monologue',
        pacing: 'glacial',
        difficulty: 'impossible',
        storytelling: 'shakespeare',
        choices: 'buttons',
        statusWindow: 'yes',
        moods: ['romance', 'grimdark'],
      }),
    ).toEqual({ moods: ['romance'] });
  });

  it('clamps the moods to two, in the order they were picked, without duplicates', () => {
    expect(coercePlotStyle({ moods: ['horror', 'romance', 'action'] })).toEqual({
      moods: ['horror', 'romance'],
    });
    expect(coercePlotStyle({ moods: ['action', 'action', 'healing'] })).toEqual({
      moods: ['action', 'healing'],
    });
    expect(MAX_PLOT_MOODS).toBe(2);
  });

  it('returns an empty style for anything that describes none, so the column may stay null', () => {
    for (const value of [{}, null, undefined, 'past', 42, [], { moods: [] }, { moods: 'romance' }]) {
      expect(coercePlotStyle(value), JSON.stringify(value) ?? 'undefined').toEqual({});
    }
  });
});

describe('styleDirectives', () => {
  it('says nothing about a style that sets nothing', () => {
    expect(styleDirectives({})).toBe('');
  });

  it('says nothing about an option left at its default', () => {
    expect(
      styleDirectives({
        replyLength: 'auto',
        delivery: 'balanced',
        pacing: 'natural',
        difficulty: 'normal',
        statusWindow: false,
        choices: 'off',
        moods: [],
      }),
    ).toBe('');
  });

  it('writes one bullet for every option that says something, each its own line', () => {
    const speaking: [keyof PlotStyle, readonly unknown[]][] = [
      ['tense', PLOT_TENSES],
      ['replyLength', REPLY_LENGTHS.filter((length) => length !== 'auto')],
      ['delivery', NARRATIVE_DELIVERIES.filter((delivery) => delivery !== 'balanced')],
      ['pacing', PLOT_PACINGS.filter((pacing) => pacing !== 'natural')],
      ['difficulty', PLOT_DIFFICULTIES.filter((difficulty) => difficulty !== 'normal')],
      ['storytelling', STORYTELLING_STYLES],
      ['choices', CHOICES_MODES.filter((mode) => mode !== 'off')],
    ];
    const seen = new Set<string>();
    for (const [key, values] of speaking) {
      for (const value of values) {
        const lines = bullets({ [key]: value } as PlotStyle);
        expect(lines, `${key}=${String(value)}`).toHaveLength(1);
        // Every option has to read as its own instruction: two options compiling to
        // the same sentence would be one setting wearing two labels.
        expect(seen.has(lines[0]!), `${key}=${String(value)} repeats another directive`).toBe(false);
        seen.add(lines[0]!);
      }
    }
  });

  it('names the moods it was given, one bullet for both', () => {
    expect(bullets({ moods: ['romance'] })).toEqual([
      `장면의 분위기는 ${PLOT_MOOD_LABELS.romance} 쪽을 지향합니다.`,
    ]);
    expect(bullets({ moods: ['horror', 'angst'] })).toEqual([
      `장면의 분위기는 ${PLOT_MOOD_LABELS.horror}, ${PLOT_MOOD_LABELS.angst} 쪽을 지향합니다.`,
    ]);
    // Every mood is nameable: a label the compiler had no Korean for would print
    // `undefined` into the prompt.
    for (const mood of PLOT_MOODS) {
      expect(bullets({ moods: [mood] })[0], mood).toContain(PLOT_MOOD_LABELS[mood]);
    }
  });

  it('teaches the two conventions their features depend on', () => {
    expect(bullets({ statusWindow: true })[0]).toContain('```status');
    const keywords = bullets({ choices: 'keywords' })[0]!;
    const sentences = bullets({ choices: 'sentences' })[0]!;
    for (const line of [keywords, sentences]) expect(line).toContain('`>> `');
    expect(keywords).toContain('키워드형');
    expect(sentences).toContain('완결된 한 문장');
  });

  it('keeps the options in a fixed order, whatever order the object has', () => {
    const style: PlotStyle = {
      choices: 'keywords',
      statusWindow: true,
      moods: ['romance'],
      tense: 'present',
      replyLength: 'long',
    };
    const lines = bullets(style);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(bullets({ tense: 'present' })[0]);
    expect(lines[1]).toBe(bullets({ replyLength: 'long' })[0]);
    expect(lines.at(-1)).toBe(bullets({ choices: 'keywords' })[0]);
  });
});

describe('replyLengthTokens', () => {
  it('caps each length, and leaves a plot that chose none where it has always been', () => {
    expect(replyLengthTokens('short')).toBe(600);
    expect(replyLengthTokens('medium')).toBe(1200);
    expect(replyLengthTokens('long')).toBe(2400);
    expect(replyLengthTokens('auto')).toBe(DEFAULT_MAX_RESPONSE_TOKENS);
    expect(replyLengthTokens(undefined)).toBe(DEFAULT_MAX_RESPONSE_TOKENS);
    expect(DEFAULT_MAX_RESPONSE_TOKENS).toBe(1200);
  });
});
