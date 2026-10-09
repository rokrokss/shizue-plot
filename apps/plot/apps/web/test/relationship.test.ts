import { describe, expect, it } from 'vitest';
import { gaugeValue, relationshipRows } from '../src/lib/relationship';
import type { ChatRelationship } from '../src/lib/types';

const relationship = (axes: ChatRelationship['axes']): ChatRelationship => ({
  axes,
  note: '조심스러운 사이.',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastExtractedAssistantDepth: 5,
});

describe('gaugeValue', () => {
  it('clamps to the 0-100 track and rounds', () => {
    expect(gaugeValue(0)).toBe(0);
    expect(gaugeValue(61.6)).toBe(62);
    expect(gaugeValue(140)).toBe(100);
    expect(gaugeValue(-20)).toBe(0);
    expect(gaugeValue(Number.NaN)).toBe(0);
  });
});

describe('relationshipRows', () => {
  it('lists the six axes in display order', () => {
    const rows = relationshipRows(
      relationship({ affection: 72, obsession: 10, trust: 65, liking: 80, disgust: 0, fear: 5 }),
    );
    expect(rows).toEqual([
      { axis: 'affection', value: 72 },
      { axis: 'obsession', value: 10 },
      { axis: 'trust', value: 65 },
      { axis: 'liking', value: 80 },
      { axis: 'disgust', value: 0 },
      { axis: 'fear', value: 5 },
    ]);
  });

  it('has nothing to show before the first extraction', () => {
    expect(relationshipRows(null)).toEqual([]);
    expect(relationshipRows(relationship(null))).toEqual([]);
  });
});
