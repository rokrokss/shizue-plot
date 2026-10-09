import { describe, expect, it } from 'vitest';
import { groupNotes } from '../src/lib/notes';
import type { UserNote } from '../src/lib/types';

const note = (id: string, groupName: string): UserNote => ({
  id,
  title: `노트 ${id}`,
  content: '본문',
  groupName,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('groupNotes', () => {
  it('buckets by group, ungrouped first, and keeps the server order inside', () => {
    const groups = groupNotes([
      note('a', '세계관'),
      note('b', ''),
      note('c', '규칙'),
      note('d', '세계관'),
      note('e', ''),
    ]);

    expect(groups.map((group) => group.name)).toEqual(['', '규칙', '세계관']);
    expect(groups[0]!.notes.map((item) => item.id)).toEqual(['b', 'e']);
    expect(groups[2]!.notes.map((item) => item.id)).toEqual(['a', 'd']);
  });

  it('has no buckets without notes', () => {
    expect(groupNotes([])).toEqual([]);
  });
});
